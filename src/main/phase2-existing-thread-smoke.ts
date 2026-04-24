import assert from 'node:assert/strict';

import { CodexAppServerClient } from './app-server-client';
import { CodexLocalStore } from './codex-store';

async function waitForThreadAppend(
  store: CodexLocalStore,
  threadId: string,
  previousMessageCount: number,
  expected: string,
  timeoutMs = 120000
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const thread = await store.readThread(threadId);
    const hasExpectedMessage = thread.messages.some((message) => message.text.includes(expected));

    if (thread.messages.length > previousMessageCount && hasExpectedMessage) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Timed out waiting for appended message in thread ${threadId}.`);
}

function readCliInputs() {
  const [, , requestedThreadId, requestedPrompt, requestedExpected] = process.argv;

  assert.ok(requestedThreadId, 'Existing thread id is required.');

  const prompt =
    requestedPrompt ?? 'Reply exactly with: codex-remote-companion-existing-thread-ok';
  const expected =
    requestedExpected ?? 'codex-remote-companion-existing-thread-ok';

  return { threadId: requestedThreadId, prompt, expected };
}

async function main() {
  const { threadId, prompt, expected } = readCliInputs();
  const client = await CodexAppServerClient.start();
  const store = new CodexLocalStore();

  try {
    const before = await store.readThread(threadId);
    const previousMessageCount = before.messages.length;

    const resumed = await client.threadResume(threadId);
    assert.equal(resumed.thread?.id, threadId, 'thread/resume returned unexpected thread id');

    await client.turnStart(threadId, prompt);
    await client.waitForNotification('turn/completed', 180000);
    await waitForThreadAppend(store, threadId, previousMessageCount, expected, 120000);

    const after = await store.readThread(threadId);
    assert.ok(
      after.messages.some((message) => message.text.includes(expected)),
      'assistant reply was not appended into the existing local Codex thread state'
    );
    assert.ok(
      after.messages.length > previousMessageCount,
      'existing thread message count did not increase after turn execution'
    );

    console.log(`phase2-existing-thread-smoke-ok threadId=${threadId}`);
  } finally {
    await client.dispose();
  }
}

void main();
