import { randomBytes } from 'node:crypto';

import type { TelegramConfigStore } from './telegram-config';
import type { RemoteApp, RemoteAppQuitResult, RemoteAppStatus } from './mac-app-control';
import type { TelegramBotProvider, TelegramUpdateMessage } from './telegram-provider';

interface AppControl {
  status(): Promise<RemoteAppStatus>;
  quit(targets: RemoteApp[]): Promise<RemoteAppQuitResult>;
}

interface PendingRelease {
  chatId: string;
  messageThreadId: number | null;
  expiresAt: number;
}

const CALLBACK_PREFIX = 'crc:release:';
const CONFIRMATION_LIFETIME_MS = 2 * 60_000;

export class TelegramAppReleaseCommands {
  private readonly pending = new Map<string, PendingRelease>();

  constructor(
    private readonly configStore: Pick<TelegramConfigStore, 'readState'>,
    private readonly provider: Pick<TelegramBotProvider, 'sendMessage' | 'answerCallbackQuery'>,
    private readonly appControl: AppControl,
    private readonly now: () => number = Date.now
  ) {}

  async handleMessage(message: TelegramUpdateMessage): Promise<boolean> {
    if (!/^\/release(?:@\w+)?$/i.test(message.text?.trim() ?? '')) return false;
    const config = await this.configStore.readState();
    if (!config.botToken || message.senderId !== config.ownerUserId ||
      !config.rows.some((row) => row.forumGroupId === message.chatId && row.setupCompletedAt)) return false;

    try {
      const status = await this.appControl.status();
      if (!status.vscode && !status.codex) {
        await this.send(config.botToken, message.chatId, message.messageThreadId,
          'VS Code and Codex app are already closed. This chat may be locked by another process.');
        return true;
      }
      for (const [key, pending] of this.pending) {
        if (pending.expiresAt < this.now()) this.pending.delete(key);
      }
      const nonce = randomBytes(8).toString('hex');
      this.pending.set(nonce, {
        chatId: message.chatId,
        messageThreadId: message.messageThreadId,
        expiresAt: this.now() + CONFIRMATION_LIFETIME_MS
      });
      const buttons: Array<Array<{ text: string; callbackData: string }>> = [];
      if (status.vscode) buttons.push([{ text: 'Close VS Code', callbackData: `${CALLBACK_PREFIX}${nonce}:v` }]);
      if (status.codex) buttons.push([{ text: 'Close Codex app', callbackData: `${CALLBACK_PREFIX}${nonce}:c` }]);
      if (status.vscode && status.codex) {
        buttons.push([{ text: 'Close both', callbackData: `${CALLBACK_PREFIX}${nonce}:b` }]);
      }
      buttons.push([{ text: 'Cancel', callbackData: `${CALLBACK_PREFIX}${nonce}:x` }]);
      await this.provider.sendMessage(config.botToken, {
        chatId: message.chatId,
        messageThreadId: message.messageThreadId === 1 ? null : message.messageThreadId,
        text: 'Choose which app to close. Unsaved work may prevent a normal quit; nothing will be force closed.',
        inlineKeyboard: buttons
      });
    } catch (error) {
      await this.send(config.botToken, message.chatId, message.messageThreadId,
        `Could not check running apps: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  }

  async handleCallback(input: {
    id: string; data: string | null; chatId: string | null; senderId: string;
  }): Promise<boolean> {
    if (!input.data?.startsWith(CALLBACK_PREFIX)) return false;
    const config = await this.configStore.readState();
    if (!config.botToken) return true;
    if (input.senderId !== config.ownerUserId) {
      await this.provider.answerCallbackQuery(config.botToken, input.id, 'Only the configured owner can close apps.');
      return true;
    }
    const match = /^crc:release:([0-9a-f]{16}):([vcbx])$/.exec(input.data);
    const pending = match ? this.pending.get(match[1]!) : null;
    if (!pending || pending.chatId !== input.chatId || pending.expiresAt < this.now()) {
      await this.provider.answerCallbackQuery(config.botToken, input.id, 'This confirmation has expired. Send /release again.');
      return true;
    }
    this.pending.delete(match![1]!);
    const choice = match![2]!;
    if (choice === 'x') {
      await this.provider.answerCallbackQuery(config.botToken, input.id, 'Cancelled.');
      return true;
    }
    await this.provider.answerCallbackQuery(config.botToken, input.id, 'Closing selected apps…');
    const targets: RemoteApp[] = choice === 'b' ? ['vscode', 'codex'] : [choice === 'v' ? 'vscode' : 'codex'];
    try {
      const result = await this.appControl.quit(targets);
      const lines = targets.map((target) => {
        const label = target === 'vscode' ? 'VS Code' : 'Codex app';
        return result.exited[target]
          ? `${label}: closed.`
          : `${label}: still open. Check the laptop for a save dialog.`;
      });
      await this.send(config.botToken, pending.chatId, pending.messageThreadId,
        `${lines.join('\n')}\nYou can send your prompt again after the app closes.`);
    } catch (error) {
      await this.send(config.botToken, pending.chatId, pending.messageThreadId,
        `Could not close the selected apps: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  }

  private async send(token: string, chatId: string, threadId: number | null, text: string): Promise<void> {
    await this.provider.sendMessage(token, {
      chatId, messageThreadId: threadId === 1 ? null : threadId, text
    });
  }
}
