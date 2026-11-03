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

interface OutboundMirror {
  suspendThread(threadId: string): void;
  resumeThread(threadId: string): Promise<void>;
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
const TELEGRAM_REPLY_CHUNK_LENGTH = 3900;
const TELEGRAM_RICH_REPLY_MAX_BYTES = 30000;

function splitReply(text: string): string[] {
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += TELEGRAM_REPLY_CHUNK_LENGTH) {
    chunks.push(characters.slice(index, index + TELEGRAM_REPLY_CHUNK_LENGTH).join(''));
  }
  return chunks;
}

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
    private readonly pollIntervalMs = 500,
    private readonly outboundMirror?: OutboundMirror
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
    if (!config.botToken || !config.ownerUserId) {
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
      if (!message || message.senderIsBot || message.senderId !== config.ownerUserId || !message.text?.trim()) {
        skipped += 1;
        continue;
      }

      let acknowledgement: { messageId: number } | null = null;
      let projectThreadId: string | null = null;
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
        projectThreadId = inboundEvent.projectThreadId;

        const slashCommand = await this.slashCommands.handle(inboundEvent.text, inboundEvent.threadId);
        if (slashCommand) {
          await this.sendSlashCommandReplies(inboundEvent.projectThreadId, slashCommand);
          processed += 1;
          await this.configStore.recordIssue(null);
          continue;
        }

        const ackMessage = await this.telegramService.sendThreadReply({
          projectThreadId: inboundEvent.projectThreadId,
          text: TELEGRAM_ACK_TEXT
        });
        acknowledgement = ackMessage;

        this.outboundMirror?.suspendThread(inboundEvent.threadId);
        try {
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
          const replyChunks = splitReply(execution.assistantReply);
          if (replyChunks.length === 0) {
            throw new Error('Codex completed without a reply.');
          }
          const sendAsRichMessage = Buffer.byteLength(execution.assistantReply, 'utf8') <=
            TELEGRAM_RICH_REPLY_MAX_BYTES;
          await this.telegramService.editThreadReply({
            projectThreadId: inboundEvent.projectThreadId,
            messageId: ackMessage.messageId,
            text: sendAsRichMessage ? execution.assistantReply : replyChunks[0],
            format: sendAsRichMessage ? 'markdown' : undefined
          });
          for (const text of sendAsRichMessage ? [] : replyChunks.slice(1)) {
            await this.telegramService.sendThreadReply({
              projectThreadId: inboundEvent.projectThreadId,
              text
            });
          }
        } finally {
          await this.outboundMirror?.resumeThread(inboundEvent.threadId);
        }

        processed += 1;
        await this.configStore.recordIssue(null);
      } catch (error) {
        skipped += 1;
        if (isIgnorableBindingIssue(error)) {
          continue;
        }
        if (acknowledgement && projectThreadId) {
          const detail = error instanceof Error ? error.message : 'Unknown Codex error';
          const errorText = `Codex could not continue this chat: ${detail.slice(0, 900)}`;
          try {
            await this.telegramService.editThreadReply({
              projectThreadId,
              messageId: acknowledgement.messageId,
              text: errorText
            });
          } catch {
            await this.telegramService.sendThreadReply({
              projectThreadId,
              text: errorText
            }).catch(() => undefined);
          }
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
    result: TelegramSlashCommandResult
  ): Promise<void> {
    for (const text of result.messages) {
      await this.telegramService.sendThreadReply({
        projectThreadId,
        text
      });
    }
  }
}
