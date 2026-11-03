import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexThreadExecutor } from './codex-thread-executor';

test('CodexThreadExecutor does not override user-selected model, reasoning, or permissions', async () => {
  let messages: Array<{
    timestamp: string;
    role: 'user' | 'assistant';
    text: string;
    sourceType: 'message';
  }> = [
    {
      timestamp: '2026-04-21T10:00:00.000Z',
      role: 'user' as const,
      text: 'original prompt',
      sourceType: 'message' as const
    }
  ];

  const store = {
    readThread: async () => ({
      id: 'codex-thread-1',
      title: 'i love monkeys',
      updatedAt: '2026-04-21T10:00:00.000Z',
      archived: false,
      cwd: '/tmp/project',
      path: '/tmp/project/rollout.jsonl',
      originator: null,
      cliVersion: null,
      messages
    })
  };

  let capturedTurnStart:
    | {
        threadId: string;
        prompt: string;
        options: Record<string, unknown> | undefined;
      }
    | null = null;

  const client = {
    threadResume: async (threadId: string) => ({ thread: { id: threadId } }),
    turnStart: async (
      threadId: string,
      prompt: string,
      options?: Record<string, unknown>
    ) => {
      capturedTurnStart = { threadId, prompt, options };
      return { turn: { id: 'turn-1', status: 'running' } };
    },
    waitForNotification: async () => {
      messages = [
        ...messages,
        {
          timestamp: '2026-04-21T10:00:01.000Z',
          role: 'assistant' as const,
          text: 'assistant reply from Codex',
          sourceType: 'message' as const
        }
      ];
      return { turn: { id: 'turn-1', status: 'completed' } };
    },
    onNotification: () => () => {},
    dispose: async () => {}
  };

  const executor = new CodexThreadExecutor(
    store as never,
    async () => client as never
  );

  const result = await executor.resumeAndRun('codex-thread-1', 'run with current Codex settings');

  assert.equal(result.assistantReply, 'assistant reply from Codex');
  assert.deepEqual(capturedTurnStart, {
    threadId: 'codex-thread-1',
    prompt: 'run with current Codex settings',
    options: {
      cwd: '/tmp/project'
    }
  });
});
