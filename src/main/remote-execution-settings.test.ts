import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RemoteExecutionSettingsService, RemoteExecutionSettingsStore } from './remote-execution-settings';

type ConfigEdit = {
  keyPath: string;
  value: unknown;
  mergeStrategy?: 'replace' | 'upsert';
};

function createFakeCodexStore(codexHome: string) {
  return {
    getCodexHome: () => codexHome,
    getEnvironmentSnapshot: async () => ({
      model: 'gpt-5.4',
      reasoningEffort: 'xhigh',
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
    })
  };
}

async function writeConfigFile(codexHome: string, values: Record<string, string>) {
  const lines = Object.entries(values).map(([key, value]) => `${key} = "${value}"`);
  await writeFile(join(codexHome, 'config.toml'), `${lines.join('\n')}\n`, 'utf8');
}

async function readConfigFile(codexHome: string): Promise<string> {
  return readFile(join(codexHome, 'config.toml'), 'utf8');
}

test('RemoteExecutionSettingsService reports settings but does not mutate Codex config remotely', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-remote-companion-settings-'));
  await mkdir(codexHome, { recursive: true });
  await writeConfigFile(codexHome, {
    model: 'gpt-5.4',
    model_reasoning_effort: 'xhigh',
    approval_policy: 'on-request',
    sandbox_mode: 'workspace-write'
  });

  const configWrites: ConfigEdit[][] = [];
  const settingsStore = new RemoteExecutionSettingsStore(join(codexHome, 'execution-settings.json'));
  const settingsService = new RemoteExecutionSettingsService(
    settingsStore,
    createFakeCodexStore(codexHome) as never,
    async () => ({
      modelList: async () => ({
        data: [
          {
            model: 'gpt-5.4',
            displayName: 'GPT-5.4',
            description: 'Latest flagship Codex model',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'medium', description: 'Balanced reasoning effort' },
              { reasoningEffort: 'high', description: 'High reasoning effort' },
              { reasoningEffort: 'xhigh', description: 'Maximum reasoning effort' }
            ]
          },
          {
            model: 'gpt-5.3',
            displayName: 'GPT-5.3',
            description: 'Previous frontier Codex model',
            hidden: false,
            isDefault: false,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'medium', description: 'Balanced reasoning effort' },
              { reasoningEffort: 'high', description: 'High reasoning effort' }
            ]
          }
        ]
      }),
      configBatchWrite: async (edits: ConfigEdit[]) => {
        configWrites.push(edits);

        const current = new Map<string, string>();
        const raw = await readConfigFile(codexHome);
        for (const line of raw.split('\n')) {
          const match = line.match(/^([a-z_]+)\s*=\s*"([^"]*)"$/);
          if (match) {
            current.set(match[1], match[2]);
          }
        }

        for (const edit of edits) {
          current.set(edit.keyPath, String(edit.value));
        }

        await writeConfigFile(codexHome, Object.fromEntries(current.entries()));
      },
      dispose: async () => {}
    })
  );

  const state = await settingsService.getState();
  assert.equal(state.effectiveModel, 'gpt-5.4');
  assert.equal(state.effectiveReasoningEffort, 'xhigh');
  assert.equal(state.effectivePermissionMode, 'default');

  await assert.rejects(
    () => settingsService.setModelSelection('gpt-5.3'),
    /Remote model changes are disabled/
  );
  await assert.rejects(
    () => settingsService.setReasoningSelection('high'),
    /Remote reasoning changes are disabled/
  );
  await assert.rejects(
    () => settingsService.setPermissionSelection('full-access'),
    /Remote permission changes are disabled/
  );

  const finalConfig = await readConfigFile(codexHome);
  assert.match(finalConfig, /^model = "gpt-5\.4"$/m);
  assert.match(finalConfig, /^model_reasoning_effort = "xhigh"$/m);
  assert.match(finalConfig, /^approval_policy = "on-request"$/m);
  assert.match(finalConfig, /^sandbox_mode = "workspace-write"$/m);
  assert.deepEqual(configWrites, []);

  const executionOverrides = await settingsService.resolveExecutionOverrides();
  assert.deepEqual(executionOverrides, {
    model: null,
    reasoningEffort: null,
    permissionMode: null
  });
});

test('RemoteExecutionSettingsService reports local Codex config without live settings sync', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-remote-companion-live-settings-'));
  await mkdir(codexHome, { recursive: true });
  await writeConfigFile(codexHome, {
    model: 'gpt-5.4',
    model_reasoning_effort: 'xhigh',
    approval_policy: 'on-request',
    sandbox_mode: 'workspace-write'
  });

  const settingsStore = new RemoteExecutionSettingsStore(join(codexHome, 'execution-settings.json'));
  const settingsService = new RemoteExecutionSettingsService(
    settingsStore,
    createFakeCodexStore(codexHome) as never,
    async () => ({
      modelList: async () => ({
        data: [
          {
            model: 'gpt-5.4',
            displayName: 'GPT-5.4',
            description: 'Latest flagship Codex model',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'medium', description: 'Balanced reasoning effort' },
              { reasoningEffort: 'high', description: 'High reasoning effort' },
              { reasoningEffort: 'xhigh', description: 'Maximum reasoning effort' }
            ]
          }
        ]
      }),
      configBatchWrite: async () => {},
      dispose: async () => {}
    })
  );

  const state = await settingsService.getState();
  assert.equal(state.effectiveModel, 'gpt-5.4');
  assert.equal(state.effectiveReasoningEffort, 'xhigh');
  assert.equal(state.effectivePermissionMode, 'default');
  assert.equal(state.reasoningSelection, 'xhigh');
  assert.equal(state.permissionSelection, 'default');
});
