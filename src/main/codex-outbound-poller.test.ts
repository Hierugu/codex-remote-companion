import assert from 'node:assert/strict';
import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import type { CodexThreadMessage, CodexThreadRecord, CodexThreadSummary } from '@shared/contracts';

import { PersistentBackendRegistry } from './backend-registry';
import { CodexOutboundPoller } from './codex-outbound-poller';

test('Codex outbound mirror sends only new desktop messages and remembers its cursor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-outbound-'));
  const rolloutPath = join(root, 'thread.jsonl');
  const cursorPath = join(root, 'cursors.json');
  await writeFile(rolloutPath, '{}\n');

  const registry = new PersistentBackendRegistry(join(root, 'registry.json'));
  await registry.upsertCodexThreadBinding({
    id: 'codex-binding:thread-1',
    projectThreadId: 'project-thread:thread-1',
    machineId: 'machine-1',
    codexThreadId: 'thread-1'
  });
  await registry.upsertPlatformBinding({
    id: 'telegram-thread:thread-1',
    platform: 'telegram',
    bindingType: 'thread-surface',
    projectId: 'project-1',
    projectThreadId: 'project-thread:thread-1',
    surfaceId: 'telegram:topic:-1001:5',
    surfaceLabel: 'Thread 1'
  });

  const messages: CodexThreadMessage[] = [
    { timestamp: null, role: 'assistant', text: 'Old reply', sourceType: 'response_item.message', phase: 'final_answer' }
  ];
  const summary: CodexThreadSummary = {
    id: 'thread-1', title: 'Thread 1', updatedAt: null, archived: false, cwd: root, path: rolloutPath
  };
  const store = {
    async listThreads() { return [summary]; },
    async readThread(): Promise<CodexThreadRecord> {
      return { ...summary, originator: null, cliVersion: null, messages: [...messages] };
    }
  };
  const sent: string[] = [];
  const formats: Array<string | undefined> = [];
  let failNextSend = false;
  const telegram = {
    async sendThreadReply(input: { projectThreadId: string; text: string; format?: 'markdown' }) {
      assert.equal(input.projectThreadId, 'project-thread:thread-1');
      if (failNextSend) {
        failNextSend = false;
        throw new Error('Temporary Telegram failure');
      }
      sent.push(input.text);
      formats.push(input.format);
      return { chatId: '-1001', messageThreadId: 5, messageId: sent.length, text: input.text };
    }
  };
  const mirror = new CodexOutboundPoller(store, registry, telegram, cursorPath);

  await mirror.pollOnce();
  assert.deepEqual(sent, []);

  messages.push(
    { timestamp: null, role: 'user', text: 'New prompt', sourceType: 'response_item.message' },
    { timestamp: null, role: 'assistant', text: 'Working', sourceType: 'response_item.message', phase: 'commentary' },
    { timestamp: null, role: 'assistant', text: 'New answer', sourceType: 'response_item.message', phase: 'final_answer' }
  );
  await writeFile(rolloutPath, '{}\n{}\n');
  const changed = new Date(Date.now() + 1000);
  await utimes(rolloutPath, changed, changed);
  await mirror.pollOnce();
  await mirror.pollOnce();
  assert.deepEqual(sent, ['👤 New prompt', '🤖\nNew answer']);
  assert.deepEqual(formats, [undefined, 'markdown']);

  messages.push({ timestamp: null, role: 'assistant', text: 'Retry me', sourceType: 'response_item.message', phase: 'final_answer' });
  await writeFile(rolloutPath, '{}\n{}\n{}\n');
  const changedAgain = new Date(Date.now() + 2000);
  await utimes(rolloutPath, changedAgain, changedAgain);
  failNextSend = true;
  await assert.rejects(() => mirror.pollOnce(), /Temporary Telegram failure/);
  await mirror.pollOnce();
  assert.deepEqual(sent, ['👤 New prompt', '🤖\nNew answer', '🤖\nRetry me']);

  const restarted = new CodexOutboundPoller(store, registry, telegram, cursorPath);
  await restarted.pollOnce();
  assert.deepEqual(sent, ['👤 New prompt', '🤖\nNew answer', '🤖\nRetry me']);

  restarted.suspendThread('thread-1');
  messages.push(
    { timestamp: null, role: 'user', text: 'From Telegram', sourceType: 'response_item.message' },
    { timestamp: null, role: 'assistant', text: 'Telegram reply', sourceType: 'response_item.message', phase: 'final_answer' }
  );
  await writeFile(rolloutPath, '{}\n{}\n{}\n');
  await restarted.pollOnce();
  await restarted.resumeThread('thread-1');
  await restarted.pollOnce();
  assert.deepEqual(sent, ['👤 New prompt', '🤖\nNew answer', '🤖\nRetry me']);
});
