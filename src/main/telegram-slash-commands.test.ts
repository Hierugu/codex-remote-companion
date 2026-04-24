import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { RemoteExecutionSettingsService, RemoteExecutionSettingsStore } from './remote-execution-settings';
import { TelegramSlashCommandService } from './telegram-slash-commands';

function createFakeCodexStore(codexHome = '/tmp/fake-codex-home') {
  return {
    getCodexHome: () => codexHome,
    getEnvironmentSnapshot: async () => ({
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
      personality: 'pragmatic',
      activeUserEmail: 'user@example.com',
      permissionMode: 'Default permissions',
      primaryRateLimitRemainingPercent: 85,
      primaryRateLimitWindowMinutes: 300,
      primaryRateLimitResetsAt: '2026-04-21T12:00:00.000Z',
      weeklyRateLimitRemainingPercent: 75,
      weeklyRateLimitWindowMinutes: 10080,
      weeklyRateLimitResetsAt: '2026-04-24T10:00:00.000Z',
      savedWorkspaceRoots: [],
      activeWorkspaceRoots: [],
      projectOrder: [],
      threadCount: 1,
      archivedThreadCount: 0,
      source: 'local-files' as const
    }),
    readThread: async () => ({
      id: 'codex-thread-1',
      title: 'i love monkeys',
      updatedAt: '2026-04-21T10:00:00.000Z',
      archived: false,
      cwd: '/tmp/project',
      path: '/tmp/project/rollout.jsonl',
      originator: null,
      cliVersion: null,
      messages: [
        {
          timestamp: '2026-04-21T09:55:00.000Z',
          role: 'assistant' as const,
          text: 'local reply from Codex App',
          sourceType: 'message'
        }
      ]
    })
  };
}

function createModelCatalogClient(codexHome: string) {
  return {
    modelList: async () => ({
      data: [
        {
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          description: 'Latest flagship Codex model',
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: 'medium', description: 'Balanced reasoning effort' },
            { reasoningEffort: 'high', description: 'High reasoning effort' }
          ]
        },
        {
          model: 'gpt-5.3',
          displayName: 'GPT-5.3',
          description: 'Previous frontier Codex model',
          hidden: false,
          isDefault: false,
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Lower reasoning effort' },
            { reasoningEffort: 'medium', description: 'Balanced reasoning effort' }
          ]
        }
      ]
    }),
    configBatchWrite: async (
      edits: Array<{ keyPath: string; value: unknown }>
    ) => {
      const config = new Map<string, unknown>();
      for (const edit of edits) {
        config.set(edit.keyPath, edit.value);
      }

      const lines = [...config.entries()].map(([key, value]) => `${key} = "${String(value)}"`);
      await writeFile(join(codexHome, 'config.toml'), `${lines.join('\n')}\n`, 'utf8');
    },
    dispose: async () => {}
  };
}

test('TelegramSlashCommandService reports model status without changing settings', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-slash-'));
  const settingsStore = new RemoteExecutionSettingsStore(join(tempRoot, 'execution-settings.json'));
  const settingsService = new RemoteExecutionSettingsService(
    settingsStore,
    createFakeCodexStore(tempRoot) as never,
    async () => createModelCatalogClient(tempRoot)
  );
  const slashCommands = new TelegramSlashCommandService(
    settingsService,
    createFakeCodexStore(tempRoot) as never
  );

  const listResult = await slashCommands.handle('/model', 'codex-thread-1');
  assert.ok(listResult);
  assert.equal(listResult.messages[0], 'Available models:\nCurrent: gpt-5.4');
  assert.ok(
    listResult.messages.includes(
      '- GPT-5.3 (gpt-5.3): Previous frontier Codex model'
    )
  );

  const updateResult = await slashCommands.handle('/model GPT-5.3', 'codex-thread-1');
  assert.ok(updateResult);
  assert.deepEqual(updateResult.messages, [
    [
      'Model changes are disabled in Codex Remote Companion.',
      'Change it directly in Codex App. Remote messages will use the current Codex settings.'
    ].join('\n')
  ]);

  const statusResult = await slashCommands.handle('/status', 'codex-thread-1');
  assert.ok(statusResult);
  assert.match(statusResult.messages[0] ?? '', /Model: gpt-5\.4/);
  assert.match(statusResult.messages[0] ?? '', /Remote setting changes are disabled/);
});

test('TelegramSlashCommandService returns local limits and threadsync output', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-slash-'));
  const settingsStore = new RemoteExecutionSettingsStore(join(tempRoot, 'execution-settings.json'));
  const settingsService = new RemoteExecutionSettingsService(
    settingsStore,
    createFakeCodexStore(tempRoot) as never,
    async () => createModelCatalogClient(tempRoot)
  );
  const slashCommands = new TelegramSlashCommandService(
    settingsService,
    createFakeCodexStore(tempRoot) as never
  );

  const limitsResult = await slashCommands.handle('/limits', 'codex-thread-1');
  assert.ok(limitsResult);
  assert.match(limitsResult.messages[0] ?? '', /5h remaining: 85%/);
  assert.match(limitsResult.messages[0] ?? '', /Weekly remaining: 75%/);

  const threadsyncResult = await slashCommands.handle('/threadsync', 'codex-thread-1');
  assert.ok(threadsyncResult);
  assert.equal(
    threadsyncResult.messages[0],
    'Latest local assistant message:\n\nlocal reply from Codex App'
  );
});
