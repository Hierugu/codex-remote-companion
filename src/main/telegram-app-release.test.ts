import assert from 'node:assert/strict';
import test from 'node:test';

import { TelegramAppReleaseCommands } from './telegram-app-release';
import type { TelegramSendMessageInput, TelegramUpdateMessage } from './telegram-provider';

function fixture() {
  const sent: TelegramSendMessageInput[] = [];
  const answers: string[] = [];
  const quitCalls: string[][] = [];
  let now = 1000;
  let status = { vscode: true, codex: true };
  let exited = { vscode: true, codex: true };
  const commands = new TelegramAppReleaseCommands(
    { readState: async () => ({
      botToken: 'token', ownerUserId: '123', rows: [
        { forumGroupId: '-1001', setupCompletedAt: 'now' }
      ]
    }) } as any,
    {
      sendMessage: async (_token: string, input: TelegramSendMessageInput) => {
        sent.push(input);
        return { chatId: input.chatId, messageThreadId: input.messageThreadId,
          messageId: sent.length, text: input.text };
      },
      answerCallbackQuery: async (_token: string, _id: string, text?: string) => {
        answers.push(text ?? '');
      }
    },
    {
      status: async () => status,
      quit: async (targets) => {
        quitCalls.push(targets);
        return { requested: { vscode: true, codex: true }, exited };
      }
    },
    () => now
  );
  const message = (text: string, senderId = '123', chatId = '-1001'): TelegramUpdateMessage => ({
    messageId: 1, text, chatId, chatType: 'supergroup', messageThreadId: 55,
    senderId, senderIsBot: false
  });
  return { commands, sent, answers, quitCalls, message,
    setNow: (value: number) => { now = value; },
    setStatus: (value: typeof status) => { status = value; },
    setExited: (value: typeof exited) => { exited = value; } };
}

test('/release requires owner confirmation and closes only selected apps', async () => {
  const f = fixture();
  assert.equal(await f.commands.handleMessage(f.message('/release', '999')), false);
  assert.equal(await f.commands.handleMessage(f.message('/release', '123', '-2000')), false);
  assert.equal(await f.commands.handleMessage(f.message('/release')), true);
  assert.equal(f.sent[0]?.inlineKeyboard?.length, 4);
  const closeBoth = f.sent[0]!.inlineKeyboard![2]![0]!.callbackData;
  await f.commands.handleCallback({ id: 'unauthorized', data: closeBoth, chatId: '-1001', senderId: '999' });
  assert.deepEqual(f.quitCalls, []);
  await f.commands.handleCallback({ id: 'wrong-chat', data: closeBoth, chatId: '-2000', senderId: '123' });
  assert.deepEqual(f.quitCalls, []);
  await f.commands.handleCallback({ id: 'confirmed', data: closeBoth, chatId: '-1001', senderId: '123' });
  assert.deepEqual(f.quitCalls, [['vscode', 'codex']]);
  assert.match(f.sent.at(-1)?.text ?? '', /VS Code: closed/);
  await f.commands.handleCallback({ id: 'duplicate', data: closeBoth, chatId: '-1001', senderId: '123' });
  assert.equal(f.quitCalls.length, 1);
});

test('/release reports a blocked quit and rejects expired confirmations', async () => {
  const f = fixture();
  f.setStatus({ vscode: true, codex: false });
  f.setExited({ vscode: false, codex: true });
  await f.commands.handleMessage(f.message('/release'));
  const closeVSCode = f.sent[0]!.inlineKeyboard![0]![0]!.callbackData;
  await f.commands.handleCallback({ id: 'confirmed', data: closeVSCode, chatId: '-1001', senderId: '123' });
  assert.deepEqual(f.quitCalls, [['vscode']]);
  assert.match(f.sent.at(-1)?.text ?? '', /still open.*save dialog/);

  await f.commands.handleMessage(f.message('/release'));
  const expired = f.sent.at(-1)!.inlineKeyboard![0]![0]!.callbackData;
  f.setNow(1000 + 2 * 60_000 + 1);
  await f.commands.handleCallback({ id: 'expired', data: expired, chatId: '-1001', senderId: '123' });
  assert.equal(f.quitCalls.length, 1);
  assert.match(f.answers.at(-1) ?? '', /expired/);
});
