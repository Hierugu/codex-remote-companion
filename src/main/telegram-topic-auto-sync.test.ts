import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PersistentBackendRegistry } from './backend-registry';
import { TelegramApiError } from './telegram-provider';
import { TelegramTopicAutoSync } from './telegram-topic-auto-sync';
import { TelegramTopicCreationGate } from './telegram-topic-gate';

async function fixture(chatIds = ['-1001']) {
  const root = await mkdtemp(join(tmpdir(), 'companion-auto-topics-'));
  const registry = new PersistentBackendRegistry(join(root, 'registry.json'), null);
  await registry.ensureBootstrap({
    installId: 'install-1', machineId: 'machine-1', createdAt: '', updatedAt: '',
    source: 'local-companion-registry'
  });
  const rows = chatIds.map((chatId, index) => ({
    id: `row-${index}`, forumGroupId: chatId, forumGroupTitle: 'Forum',
    projectId: 'project-1', setupCompletedAt: '2026-01-01T00:00:00Z', lastIssue: null
  }));
  const config = { readState: async () => ({ botToken: 'test-token', rows }) };
  const threads = [{
    id: 'thread-1', title: 'Forked chat', updatedAt: '2026-01-01T00:00:00Z',
    archived: false, cwd: '/project'
  }];
  let rolloutPath: string | null = null;
  const store = {
    listProjectThreadOptions: async () => threads,
    listThreads: async () => rolloutPath ? [{ id: 'thread-1', path: rolloutPath }] : []
  };
  const calls: string[] = [];
  const edits: Array<{ chatId: string; topicId: number; title: string; iconId?: string }> = [];
  let nextTopicId = 100;
  const provider = {
    getForumTopicIconStickers: async () => [{ emoji: '⚡', customEmojiId: 'lightning-id' }],
    createForumTopic: async (_token: string, chatId: string, _title: string) => {
      calls.push(chatId);
      return { messageThreadId: nextTopicId++, name: 'Forked chat' };
    },
    editForumTopic: async (_token: string, chatId: string, topicId: number, title: string, iconId?: string) => {
      edits.push({ chatId, topicId, title, ...(iconId === undefined ? {} : { iconId }) });
    }
  };
  const statePath = join(root, 'jobs.json');
  const gate = new TelegramTopicCreationGate();
  const create = (registryValue: any = registry, mode: 'title' | 'icon' = 'title') => new TelegramTopicAutoSync(
    config as any, store as any, registryValue, provider as any, gate, statePath, () => undefined, mode
  );
  return { registry, config, threads, provider, calls, edits, statePath, create,
    setRolloutPath: (path: string) => { rolloutPath = path; }, root };
}

test('auto-sync links a new chat once and supports two groups for one project', async () => {
  const f = await fixture(['-1001', '-1002']);
  const sync = f.create();
  assert.deepEqual((await sync.getStatus()).map((row) => row.pending), [1, 1]);
  await sync.runOnce();
  await sync.runOnce();
  await sync.runOnce();
  assert.deepEqual(f.calls, ['-1001', '-1002']);
  const state = await f.registry.readState();
  const bindings = state.platformBindings.filter((item) => item.projectThreadId === 'project-thread:thread-1');
  assert.equal(bindings.length, 2);
  assert.equal(state.projectThreads.filter((item) => item.id === 'project-thread:thread-1').length, 1);
  assert.deepEqual((await sync.getStatus()).map((row) => row.pending), [0, 0]);
});

test('queued command chat gets a topic before it appears in local Codex listings', async () => {
  const f = await fixture();
  const sync = f.create();
  await sync.runOnce();
  await sync.enqueue('row-0', 'new-from-telegram', 'project-1', 'New from Telegram');
  assert.equal((await sync.getStatus())[0]?.pending, 1);
  await sync.runOnce();
  const state = await f.registry.readState();
  assert.equal(state.codexThreadBindings.some((item) => item.codexThreadId === 'new-from-telegram'), true);
  assert.equal(state.platformBindings.some((item) => item.projectThreadId === 'project-thread:new-from-telegram'), true);
  assert.equal((await sync.getStatus())[0]?.pending, 0);
});

test('queued command survives restart and a linked topic clears stale queue state', async () => {
  const f = await fixture();
  await f.create().enqueue('row-0', 'new-from-telegram', 'project-1', 'New from Telegram');
  const restarted = f.create();
  await restarted.runOnce();
  await restarted.runOnce();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(JSON.parse(await readFile(f.statePath, 'utf8')).requested, {});

  await restarted.enqueue('row-0', 'new-from-telegram', 'project-1', 'New from Telegram');
  await f.create().runOnce();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(JSON.parse(await readFile(f.statePath, 'utf8')).requested, {});
});

test('active Codex turn changes a linked topic icon and completion restores its default letter', async () => {
  const f = await fixture();
  const rolloutPath = join(f.root, 'rollout.jsonl');
  f.setRolloutPath(rolloutPath);
  await writeFile(rolloutPath, JSON.stringify({
    type: 'event_msg', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'task_started' }
  }) + '\n');
  const sync = f.create(undefined, 'icon');
  await sync.runOnce();
  await sync.runStatusOnce();
  assert.deepEqual(f.edits, [{ chatId: '-1001', topicId: 100, title: '', iconId: 'lightning-id' }]);
  assert.equal(JSON.parse(await readFile(f.statePath, 'utf8')).icons['telegram:topic:-1001:100'].applied, true);

  await appendFile(rolloutPath, JSON.stringify({
    type: 'event_msg', timestamp: '2026-01-01T00:00:10Z', payload: { type: 'task_complete' }
  }) + '\n');
  await sync.runStatusOnce();
  assert.deepEqual(f.edits[1], { chatId: '-1001', topicId: 100, title: '', iconId: '' });
  assert.deepEqual(JSON.parse(await readFile(f.statePath, 'utf8')).icons, {});
  await sync.runStatusOnce();
  assert.equal(f.edits.length, 2);
});

test('status sync restores a busy icon after Companion restarts while Codex has finished', async () => {
  const f = await fixture();
  const rolloutPath = join(f.root, 'rollout.jsonl');
  f.setRolloutPath(rolloutPath);
  await writeFile(rolloutPath, JSON.stringify({
    type: 'event_msg', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'task_started' }
  }) + '\n');
  const sync = f.create(undefined, 'icon');
  await sync.runOnce();
  await sync.runStatusOnce();
  await appendFile(rolloutPath, JSON.stringify({
    type: 'event_msg', timestamp: '2026-01-01T00:00:10Z', payload: { type: 'turn_aborted' }
  }) + '\n');
  await f.create(undefined, 'icon').runStatusOnce();
  assert.equal(f.edits.at(-1)?.iconId, '');
});

test('active Codex turn prefixes the topic name and completion restores its original name', async () => {
  const f = await fixture();
  const rolloutPath = join(f.root, 'rollout.jsonl');
  f.setRolloutPath(rolloutPath);
  await writeFile(rolloutPath, JSON.stringify({
    type: 'event_msg', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'task_started' }
  }) + '\n');
  const sync = f.create();
  await sync.runOnce();
  await sync.runStatusOnce();
  assert.deepEqual(f.edits, [{ chatId: '-1001', topicId: 100, title: '⚡ Forked chat' }]);
  assert.deepEqual(JSON.parse(await readFile(f.statePath, 'utf8')).statusTitles, {
    'telegram:topic:-1001:100': { applied: true }
  });
  assert.equal(JSON.parse(await readFile(f.statePath, 'utf8')).icons, undefined);

  await appendFile(rolloutPath, JSON.stringify({
    type: 'event_msg', timestamp: '2026-01-01T00:00:10Z', payload: { type: 'task_complete' }
  }) + '\n');
  await sync.runStatusOnce();
  assert.deepEqual(f.edits[1], { chatId: '-1001', topicId: 100, title: 'Forked chat' });
  assert.deepEqual(JSON.parse(await readFile(f.statePath, 'utf8')).statusTitles, {});
});

test('title indicator survives restart and a Codex rename while the turn is active', async () => {
  const f = await fixture();
  const rolloutPath = join(f.root, 'rollout.jsonl');
  f.setRolloutPath(rolloutPath);
  await writeFile(rolloutPath, JSON.stringify({
    type: 'event_msg', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'task_started' }
  }) + '\n');
  const sync = f.create();
  await sync.runOnce();
  await sync.runStatusOnce();
  f.threads[0]!.title = 'Renamed chat';
  await sync.runOnce();
  assert.equal(f.edits.at(-1)?.title, '⚡ Renamed chat');
  assert.equal((await f.registry.readState()).platformBindings[0]?.surfaceLabel, 'Renamed chat');
  await appendFile(rolloutPath, JSON.stringify({
    type: 'event_msg', timestamp: '2026-01-01T00:00:10Z', payload: { type: 'turn_aborted' }
  }) + '\n');
  await f.create().runStatusOnce();
  assert.equal(f.edits.at(-1)?.title, 'Renamed chat');
});

test('the first title-status pass removes a working icon left by the previous version', async () => {
  const f = await fixture();
  const rolloutPath = join(f.root, 'rollout.jsonl');
  f.setRolloutPath(rolloutPath);
  await writeFile(rolloutPath, JSON.stringify({
    type: 'event_msg', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'task_started' }
  }) + '\n');
  const sync = f.create(undefined, 'icon');
  await sync.runOnce();
  await sync.runStatusOnce();
  const switched = f.create();
  await switched.runStatusOnce();
  assert.deepEqual(f.edits[1], { chatId: '-1001', topicId: 100, title: '', iconId: '' });
  await switched.runStatusOnce();
  assert.deepEqual(f.edits[2], { chatId: '-1001', topicId: 100, title: '⚡ Forked chat' });
});

test('a short turn does not flash the working icon', async () => {
  const f = await fixture();
  const rolloutPath = join(f.root, 'rollout.jsonl');
  f.setRolloutPath(rolloutPath);
  await writeFile(rolloutPath, JSON.stringify({
    type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started' }
  }) + '\n');
  const sync = f.create();
  await sync.runOnce();
  await sync.runStatusOnce();
  await appendFile(rolloutPath, JSON.stringify({
    type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete' }
  }) + '\n');
  await sync.runStatusOnce();
  assert.deepEqual(f.edits, []);
});

test('Telegram rate limit pauses status edits for all linked topics', async () => {
  const f = await fixture(['-1001', '-1002']);
  const rolloutPath = join(f.root, 'rollout.jsonl');
  f.setRolloutPath(rolloutPath);
  await writeFile(rolloutPath, JSON.stringify({
    type: 'event_msg', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'task_started' }
  }) + '\n');
  const sync = f.create();
  await sync.runOnce();
  await sync.runOnce();
  let attempts = 0;
  f.provider.editForumTopic = async () => {
    attempts += 1;
    throw new TelegramApiError('Too Many Requests', 429, 40);
  };
  await sync.runStatusOnce();
  await sync.runStatusOnce();
  assert.equal(attempts, 1);
});

test('auto-sync renames linked topics in both groups without creating new topics', async () => {
  const f = await fixture(['-1001', '-1002']);
  const sync = f.create();
  await sync.runOnce();
  await sync.runOnce();
  f.threads[0]!.title = 'Renamed Codex chat';
  await sync.runOnce();
  await sync.runOnce();
  assert.deepEqual(f.calls, ['-1001', '-1002']);
  assert.deepEqual(f.edits, [
    { chatId: '-1001', topicId: 100, title: 'Renamed Codex chat' },
    { chatId: '-1002', topicId: 101, title: 'Renamed Codex chat' }
  ]);
  const state = await f.registry.readState();
  assert.deepEqual(state.platformBindings.map((item) => item.surfaceLabel), [
    'Renamed Codex chat', 'Renamed Codex chat'
  ]);
  assert.equal(state.projectThreads[0]?.title, 'Renamed Codex chat');
});

test('a rate limit pauses further topic rename attempts', async () => {
  const f = await fixture();
  const sync = f.create();
  await sync.runOnce();
  f.threads[0]!.title = 'Renamed Codex chat';
  f.provider.editForumTopic = async (_token, chatId, topicId, title) => {
    f.edits.push({ chatId, topicId, title });
    throw new TelegramApiError('Too Many Requests', 429, 40);
  };
  await sync.runOnce();
  await sync.runOnce();
  assert.equal(f.edits.length, 1);
  assert.equal((await f.registry.readState()).platformBindings[0]?.surfaceLabel, 'Forked chat');
});

test('429 leaves the topic queued and does not make an immediate second request', async () => {
  const f = await fixture(['-1001', '-1002']);
  f.provider.createForumTopic = async (_token, chatId) => {
    f.calls.push(chatId);
    throw new TelegramApiError('Too Many Requests: retry after 40', 429, 40);
  };
  const sync = f.create();
  await sync.runOnce();
  await sync.runOnce();
  assert.equal(f.calls.length, 1);
  assert.equal((await sync.getStatus())[0]?.pending, 1);
  assert.equal((await sync.getStatus())[1]?.pending, 1);
});

test('a restart during topic creation requires review before another request', async () => {
  const f = await fixture();
  await writeFile(f.statePath, JSON.stringify({
    version: 1,
    jobs: { 'row-0:thread-1': { rowId: 'row-0', codexThreadId: 'thread-1', status: 'creating' } }
  }));
  const sync = f.create();
  await sync.runOnce();
  assert.equal(f.calls.length, 0);
  assert.equal((await sync.getStatus())[0]?.needsReview.length, 1);
  assert.equal(JSON.parse(await readFile(f.statePath, 'utf8')).jobs['row-0:thread-1'].status, 'needsReview');
});

test('uncertain creation survives restart and can attach an existing topic', async () => {
  const f = await fixture();
  f.provider.createForumTopic = async (_token, chatId) => {
    f.calls.push(chatId);
    throw new Error('fetch failed');
  };
  await f.create().runOnce();
  const restarted = f.create();
  await restarted.runOnce();
  assert.equal(f.calls.length, 1);
  assert.equal((await restarted.getStatus())[0]?.needsReview.length, 1);
  await restarted.attach('row-0', 'thread-1', 138);
  const state = await f.registry.readState();
  assert.equal(state.platformBindings[0]?.surfaceId, 'telegram:topic:-1001:138');
  assert.equal((await restarted.getStatus())[0]?.needsReview.length, 0);
});

test('a known topic ID is linked after a registry write failure without creating a second topic', async () => {
  const f = await fixture();
  let fail = true;
  const registry = {
    readState: () => f.registry.readState(),
    linkCodexThreadToTelegramTopic: async (input: any) => {
      if (fail) { fail = false; throw new Error('disk unavailable'); }
      return f.registry.linkCodexThreadToTelegramTopic(input);
    }
  };
  const sync = f.create(registry);
  await assert.rejects(sync.runOnce(), /disk unavailable/);
  await sync.runOnce();
  assert.equal(f.calls.length, 1);
  assert.equal((await f.registry.readState()).platformBindings.length, 1);
});
