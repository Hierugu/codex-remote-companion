import type {
  CodexThreadMessage,
  RemoteExecutionOption
} from '@shared/contracts';

import { CodexLocalStore } from './codex-store';
import { RemoteExecutionSettingsService } from './remote-execution-settings';

const TELEGRAM_MESSAGE_LIMIT = 3800;

function formatCountdown(resetsAt: string | null, now = new Date()): string {
  if (!resetsAt) {
    return 'Reset time unavailable';
  }

  const resetDate = new Date(resetsAt);
  if (Number.isNaN(resetDate.getTime())) {
    return 'Reset time unavailable';
  }

  const diffMs = Math.max(0, resetDate.getTime() - now.getTime());
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `Resets in ${days}d ${hours}h` : `Resets in ${days}d`;
  }

  if (hours > 0) {
    return minutes > 0 ? `Resets in ${hours}h ${minutes}m` : `Resets in ${hours}h`;
  }

  if (minutes > 0) {
    return `Resets in ${minutes}m`;
  }

  return 'Resets soon';
}

function formatPercent(value: number | null): string {
  return value === null ? 'Not found' : `${Math.round(value)}%`;
}

function buildSelectionMessages(
  heading: string,
  currentValue: string | null,
  options: RemoteExecutionOption[]
): string[] {
  const messages = [
    `${heading}\nCurrent: ${currentValue ?? 'Not found'}`
  ];

  for (const option of options) {
    messages.push(`- ${option.label} (${option.value}): ${option.description}`);
  }

  return messages;
}

function buildReadOnlyChangeMessage(setting: string): string {
  return [
    `${setting} changes are disabled in Codex Remote Companion.`,
    'Change it directly in Codex App. Remote messages will use the current Codex settings.'
  ].join('\n');
}

function pickLatestUserFacingMessage(messages: CodexThreadMessage[]): CodexThreadMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message?.text?.trim()) {
      continue;
    }

    if (message.role === 'user' || message.role === 'assistant') {
      return message;
    }
  }

  return null;
}

function clampTelegramMessage(text: string): string {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return text;
  }

  return `${text.slice(0, TELEGRAM_MESSAGE_LIMIT - 16)}\n\n[message truncated]`;
}

export interface TelegramSlashCommandResult {
  messages: string[];
}

export class TelegramSlashCommandService {
  constructor(
    private readonly settingsService: RemoteExecutionSettingsService,
    private readonly codexStore: CodexLocalStore
  ) {}

  async handle(text: string, threadId: string): Promise<TelegramSlashCommandResult | null> {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) {
      return null;
    }

    const [rawCommand, ...rawArgs] = trimmed.split(/\s+/);
    const command = rawCommand.toLowerCase();
    const argument = rawArgs.join(' ').trim();

    switch (command) {
      case '/help':
        return {
          messages: [
            [
              'Available thread commands:',
              '/help — show remote commands for this thread',
              '/new <name> — create a new Codex chat in this project',
              '/fork <name> — fork this Codex chat into a new topic',
              '/release — close VS Code or Codex app after confirmation',
              '/status — show current model, reasoning, and permissions',
              '/model — show current model and available models',
              '/reasoning — show current reasoning mode and available modes',
              '/permissions — show current permission mode',
              '/limits — show current 5h and weekly remaining limits',
              '/threadsync — pull the latest local message from this Codex thread'
            ].join('\n')
          ]
        };
      case '/status':
        return { messages: [await this.buildStatusMessage()] };
      case '/limits':
        return { messages: [await this.buildLimitsMessage()] };
      case '/threadsync':
        return { messages: [await this.buildThreadSyncMessage(threadId)] };
      case '/model':
        return this.handleModelCommand(argument);
      case '/reasoning':
        return this.handleReasoningCommand(argument);
      case '/permissions':
        return this.handlePermissionsCommand(argument);
      default:
        return {
          messages: ['Unknown command. Send /help to see available thread commands.']
        };
    }
  }

  private async buildStatusMessage(): Promise<string> {
    const state = await this.settingsService.getState();

    return [
      `Model: ${state.effectiveModel ?? 'Not found'}`,
      '/model — show available models',
      '',
      `Reasoning: ${state.effectiveReasoningEffort ?? 'Not found'}`,
      '/reasoning — show available reasoning modes',
      '',
      `Last used permissions: ${state.effectivePermissionLabel}`,
      '/permissions — show available permission modes',
      '',
      'Remote setting changes are disabled. Change model, reasoning, and permissions in Codex App.'
    ].join('\n');
  }

  private async buildLimitsMessage(): Promise<string> {
    const snapshot = await this.codexStore.getEnvironmentSnapshot();

    return [
      `5h remaining: ${formatPercent(snapshot.primaryRateLimitRemainingPercent)}`,
      formatCountdown(snapshot.primaryRateLimitResetsAt),
      '',
      `Weekly remaining: ${formatPercent(snapshot.weeklyRateLimitRemainingPercent)}`,
      formatCountdown(snapshot.weeklyRateLimitResetsAt)
    ].join('\n');
  }

  private async buildThreadSyncMessage(threadId: string): Promise<string> {
    const thread = await this.codexStore.readThread(threadId);
    const latestMessage = pickLatestUserFacingMessage(thread.messages);

    if (!latestMessage) {
      return 'No local user or assistant message was found for this thread yet.';
    }

    return clampTelegramMessage(
      `Latest local ${latestMessage.role} message:\n\n${latestMessage.text.trim()}`
    );
  }

  private async handleModelCommand(argument: string): Promise<TelegramSlashCommandResult> {
    if (argument) {
      return {
        messages: [buildReadOnlyChangeMessage('Model')]
      };
    }

    const state = await this.settingsService.getState();
    return {
      messages: buildSelectionMessages(
        'Available models:',
        state.effectiveModel,
        state.modelOptions
      )
    };
  }

  private async handleReasoningCommand(argument: string): Promise<TelegramSlashCommandResult> {
    if (argument) {
      return {
        messages: [buildReadOnlyChangeMessage('Reasoning')]
      };
    }

    const state = await this.settingsService.getState();
    return {
      messages: buildSelectionMessages(
        'Available reasoning modes:',
        state.effectiveReasoningEffort,
        state.reasoningOptions
      )
    };
  }

  private async handlePermissionsCommand(argument: string): Promise<TelegramSlashCommandResult> {
    if (argument) {
      return {
        messages: [buildReadOnlyChangeMessage('Permissions')]
      };
    }

    const state = await this.settingsService.getState();
    return {
      messages: buildSelectionMessages(
        'Available permission modes:',
        state.effectivePermissionLabel,
        state.permissionOptions
      )
    };
  }
}
