import type { ControlPlaneDispatchReceipt, NormalizedInboundEvent } from '@shared/contracts';

import type {
  CodexThreadExecutionOptions,
  CodexThreadExecutionResult
} from './codex-thread-executor';
import { TelegramConfigStore } from './telegram-config';
import type { TelegramBotProvider } from './telegram-provider';
import { TelegramService } from './telegram-service';
import type { TelegramSlashCommandResult, TelegramSlashCommandService } from './telegram-slash-commands';

interface InboundControlPlane {
  handleInboundEvent(event: NormalizedInboundEvent): Promise<ControlPlaneDispatchReceipt>;
}

interface ThreadExecutor {
  resumeAndRun(
    threadId: string,
    prompt: string,
    options?: CodexThreadExecutionOptions
  ): Promise<CodexThreadExecutionResult>;
}

export interface TelegramPollingCycleResult {
  processed: number;
  skipped: number;
  lastUpdateId: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isIgnorableBindingIssue(error: unknown): boolean {
  return error instanceof Error && error.message === 'Broken Telegram binding';
}

const TELEGRAM_ACK_TEXT = 'Prompt received. Working on it...';

export class TelegramInboundPoller {
  private running = false;

  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly configStore: TelegramConfigStore,
    private readonly telegramService: TelegramService,
    private readonly controlPlane: InboundControlPlane,
    private readonly executor: ThreadExecutor,
    private readonly slashCommands: TelegramSlashCommandService,
    private readonly provider: TelegramBotProvider,
    private readonly pollIntervalMs = 500
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
    this.loopPromise = null;
  }

  async pollOnce(): Promise<TelegramPollingCycleResult> {
    const config = await this.configStore.getPollingConfig();
    if (!config.botToken) {
      return { processed: 0, skipped: 0, lastUpdateId: config.lastUpdateId };
    }

    const updates = await this.provider.getUpdates(config.botToken, {
      offset: config.lastUpdateId == null ? undefined : config.lastUpdateId + 1,
      timeoutSeconds: 0,
      limit: 20
    });

    if (updates.length === 0) {
      return { processed: 0, skipped: 0, lastUpdateId: config.lastUpdateId };
    }

    let processed = 0;
    let skipped = 0;
    let maxUpdateId = config.lastUpdateId;

    for (const update of updates) {
      maxUpdateId = maxUpdateId == null ? update.updateId : Math.max(maxUpdateId, update.updateId);

      const message = update.message;
      if (!message || message.senderIsBot || !message.text?.trim()) {
        skipped += 1;
        continue;
      }

      try {
        const inboundEvent = await this.telegramService.normalizeInboundMessage({
          chatId: message.chatId,
          messageId: message.messageId,
          text: message.text,
          messageThreadId: message.messageThreadId,
          receivedAt: new Date().toISOString()
        });

        if (!inboundEvent.threadId || !inboundEvent.projectThreadId) {
          skipped += 1;
          continue;
        }

        const slashCommand = await this.slashCommands.handle(inboundEvent.text, inboundEvent.threadId);
        if (slashCommand) {
          await this.sendSlashCommandReplies(inboundEvent.projectThreadId, message.messageId, slashCommand);
          processed += 1;
          await this.configStore.recordIssue(null);
          continue;
        }

        const ackMessage = await this.telegramService.sendThreadReply({
          projectThreadId: inboundEvent.projectThreadId,
          text: TELEGRAM_ACK_TEXT,
          replyToMessageId: message.messageId
        });

        await this.controlPlane.handleInboundEvent(inboundEvent);
        const execution = await this.executor.resumeAndRun(inboundEvent.threadId, inboundEvent.text, {
          onProgress: async (progressText) => {
            await this.telegramService.editThreadReply({
              projectThreadId: inboundEvent.projectThreadId!,
              messageId: ackMessage.messageId,
              text: progressText
            });
          }
        });
        await this.telegramService.sendThreadReply({
          projectThreadId: inboundEvent.projectThreadId,
          text: execution.assistantReply,
          replyToMessageId: message.messageId
        });

        processed += 1;
        await this.configStore.recordIssue(null);
      } catch (error) {
        skipped += 1;
        if (isIgnorableBindingIssue(error)) {
          continue;
        }
        await this.configStore.recordIssue(
          error instanceof Error ? error.message : 'Telegram inbound polling failed.'
        );
      }
    }

    if (maxUpdateId != null) {
      await this.configStore.recordLastUpdateId(maxUpdateId);
    }

    return { processed, skipped, lastUpdateId: maxUpdateId };
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        await this.configStore.recordIssue(
          error instanceof Error ? error.message : 'Telegram inbound polling failed.'
        );
      }

      if (!this.running) {
        return;
      }

      await sleep(this.pollIntervalMs);
    }
  }

  private async sendSlashCommandReplies(
    projectThreadId: string,
    replyToMessageId: number,
    result: TelegramSlashCommandResult
  ): Promise<void> {
    for (const text of result.messages) {
      await this.telegramService.sendThreadReply({
        projectThreadId,
        text,
        replyToMessageId
      });
    }
  }
}
