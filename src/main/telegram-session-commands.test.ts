import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PersistentBackendRegistry } from './backend-registry';
import { TelegramSessionCommands } from './telegram-session-commands';
import type { TelegramSendMessageInput, TelegramUpdateMessage } from './telegram-provider';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'companion-session-commands-'));
  const registry = new PersistentBackendRegistry(join(root, 'registry.json'), null);
  await registry.upsertCodexThreadBinding({
    id: 'codex-binding:source', projectThreadId: 'project-thread:source',
    machineId: 'machine-1', codexThreadId: 'source'
  });
  await registry.upsertPlatformBinding({
    id: 'telegram-thread:source', platform: 'telegram', bindingType: 'thread-surface',
    projectId: 'project-a', projectThreadId: 'project-thread:source',
    surfaceId: 'telegram:topic:-1001:55', surfaceLabel: 'Source'
  });
  const rows = [
    { id: 'row-a', forumGroupId: '-1001', forumGroupTitle: 'Forum', projectId: 'project-a', setupCompletedAt: 'now', lastIssue: null },
    { id: 'row-b', forumGroupId: '-1001', forumGroupTitle: 'Forum', projectId: 'project-b', setupCompletedAt: 'now', lastIssue: null }
  ];
  const config = { readState: async () => ({ botToken: 'token', ownerUserId: '123', rows }) };
  const projects = [
    { id: 'project-a', name: 'A', cwd: '/projects/a' },
    { id: 'project-b', name: 'B', cwd: '/projects/b' }
  ];
  const codex = { listProjectOptions: async () => projects };
  const sent: TelegramSendMessageInput[] = [];
  const callbacks: string[] = [];
  const provider = {
    sendMessage: async (_token: string, input: TelegramSendMessageInput) => {
      sent.push(input);
      return { chatId: input.chatId, messageThreadId: input.messageThreadId, messageId: sent.length, text: input.text };
    },
    answerCallbackQuery: async (_token: string, id: string) => { callbacks.push(id); }
  };
  const starts: string[] = [];
  const forks: string[] = [];
  const names: Array<{ id: string; name: string }> = [];
  let failName = false;
  const appServer = {
    threadStart: async (cwd: string) => { starts.push(cwd); return { thread: { id: `new-${starts.length}` } }; },
    threadFork: async (id: string) => { forks.push(id); return { thread: { id: `fork-${forks.length}` } }; },
    threadSetName: async (id: string, name: string) => {
      if (failName) { failName = false; throw new Error('temporary name failure'); }
      names.push({ id, name });
    },
    dispose: async () => undefined
  };
  const queued: Array<{ rowId: string; id: string; projectId: string; title: string }> = [];
  const sync = { enqueue: async (rowId: string, id: string, projectId: string, title: string) => {
    queued.push({ rowId, id, projectId, title });
  } };
  const commands = new TelegramSessionCommands(
    config as any, registry, codex as any, provider as any, sync as any,
    async () => appServer, join(root, 'commands.json')
  );
  const message = (text: string, messageThreadId: number | null = null): TelegramUpdateMessage => ({
    messageId: 1, text, chatId: '-1001', chatType: 'supergroup', messageThreadId,
    senderId: '123', senderIsBot: false
  });
  return { commands, message, sent, callbacks, starts, forks, names, queued, setFailName: () => { failName = true; } };
}

test('/new in General lets the owner choose among projects in the same group', async () => {
  const f = await fixture();
  assert.equal(await f.commands.handleMessage(501, f.message('/new Review auth')), true);
  assert.equal(f.sent[0]?.inlineKeyboard?.length, 2);
  assert.deepEqual(f.starts, []);
  await f.commands.handleCallback({ id: 'wrong-owner', data: 'crc:new:501:1', chatId: '-1001', senderId: '999' });
  assert.deepEqual(f.starts, []);
  await f.commands.handleCallback({ id: 'selected', data: 'crc:new:501:1', chatId: '-1001', senderId: '123' });
  assert.deepEqual(f.starts, ['/projects/b']);
  assert.deepEqual(f.names, [{ id: 'new-1', name: 'Review auth' }]);
  assert.deepEqual(f.queued, [{ rowId: 'row-b', id: 'new-1', projectId: 'project-b', title: 'Review auth' }]);
  await f.commands.handleCallback({ id: 'duplicate', data: 'crc:new:501:1', chatId: '-1001', senderId: '123' });
  assert.equal(f.starts.length, 1);
});

test('/new and /fork inside a topic use its linked project and source chat', async () => {
  const f = await fixture();
  await f.commands.handleMessage(502, f.message('/new Fresh chat', 55));
  await f.commands.handleMessage(503, f.message('/fork Alternative', 55));
  assert.deepEqual(f.starts, ['/projects/a']);
  assert.deepEqual(f.forks, ['source']);
  assert.deepEqual(f.queued.map((item) => item.rowId), ['row-a', 'row-a']);
  assert.equal(f.sent.some((item) => item.inlineKeyboard), false);
});

test('/fork in General asks for a source topic', async () => {
  const f = await fixture();
  await f.commands.handleMessage(504, f.message('/fork Alternative'));
  assert.match(f.sent[0]?.text ?? '', /inside the topic/);
  assert.deepEqual(f.forks, []);
});

test('a created Codex chat is recovered without creating another session', async () => {
  const f = await fixture();
  f.setFailName();
  await f.commands.handleMessage(505, f.message('/new Retry title', 55));
  assert.equal(f.starts.length, 1);
  assert.equal(f.queued.length, 0);
  await f.commands.recoverPending();
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.queued, [{ rowId: 'row-a', id: 'new-1', projectId: 'project-a', title: 'Retry title' }]);
});

test('recovery and a repeated command cannot create duplicate sessions', async () => {
  const f = await fixture();
  f.setFailName();
  await f.commands.handleMessage(506, f.message('/new Concurrent', 55));
  await Promise.all([
    f.commands.recoverPending(),
    f.commands.handleMessage(506, f.message('/new Concurrent', 55))
  ]);
  assert.equal(f.starts.length, 1);
  assert.equal(f.queued.length, 1);
});
