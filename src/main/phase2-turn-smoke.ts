import assert from 'node:assert/strict';

import { CodexAppServerClient } from './app-server-client';
import { CodexLocalStore } from './codex-store';

async function waitForPersistedThread(
  store: CodexLocalStore,
  threadId: string,
  timeoutMs = 120000
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const threads = await store.listThreads(200);
    if (threads.some((thread) => thread.id === threadId)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Timed out waiting for persisted thread ${threadId}.`);
}

function readCliInputs() {
  const [, , requestedPrompt, expectedSubstring] = process.argv;

  const prompt = requestedPrompt ?? 'Reply exactly with: codex-remote-companion-phase2-turn-ok';
  const expected = expectedSubstring ?? 'codex-remote-companion-phase2-turn-ok';

  return { prompt, expected };
}

async function main() {
  const { prompt, expected } = readCliInputs();
  const client = await CodexAppServerClient.start();
  const store = new CodexLocalStore();

  try {
    const started = await client.threadStart(process.cwd());
    const threadId = started.thread?.id;
    assert.ok(threadId, 'thread/start did not return a thread id');

    await client.turnStart(threadId, prompt);

    await client.waitForNotification('turn/completed', 180000);
    await waitForPersistedThread(store, threadId, 120000);

    const thread = await store.readThread(threadId);
    assert.equal(thread.id, threadId);
    assert.ok(
      thread.messages.some((message) => message.text.includes(expected)),
      'assistant reply was not persisted into the local Codex thread state'
    );

    console.log(`phase2-turn-smoke-ok threadId=${threadId}`);
  } finally {
    await client.dispose();
  }
}

void main();
