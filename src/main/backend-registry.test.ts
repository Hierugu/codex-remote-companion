import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { PersistentBackendRegistry } from './backend-registry';
import { LocalCompanionRegistry } from './companion-registry';

test('PersistentBackendRegistry bootstraps user and local machine from install identity', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase4-'));
  const companionRegistry = new LocalCompanionRegistry(join(tempRoot, 'companion-registry.json'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));

  const identity = await companionRegistry.ensureInstallIdentity();
  await backendRegistry.ensureBootstrap(identity);

  const summary = await backendRegistry.getSummary();
  const state = await backendRegistry.readState();

  assert.equal(summary.userCount, 1);
  assert.equal(summary.localMachineCount, 1);
  assert.equal(state.users[0]?.id, `user:${identity.installId}`);
  assert.equal(state.localMachines[0]?.machineId, identity.machineId);
});

test('PersistentBackendRegistry restores all backend entities after reload', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase4-'));
  const companionRegistry = new LocalCompanionRegistry(join(tempRoot, 'companion-registry.json'));
  const registryPath = join(tempRoot, 'backend-registry.json');
  const firstRegistry = new PersistentBackendRegistry(registryPath);

  const identity = await companionRegistry.ensureInstallIdentity();
  await firstRegistry.ensureBootstrap(identity);

  const userId = `user:${identity.installId}`;
  const machineRecordId = `machine:${identity.machineId}`;

  await firstRegistry.upsertProject({
    id: 'project-1',
    userId,
    platform: 'telegram',
    name: 'Project One'
  });
  await firstRegistry.upsertProjectThread({
    id: 'thread-1',
    projectId: 'project-1',
    title: 'Main thread',
    archived: false
  });
  await firstRegistry.upsertPlatformBinding({
    id: 'binding-1',
    platform: 'telegram',
    bindingType: 'thread-surface',
    projectId: 'project-1',
    projectThreadId: 'thread-1',
    surfaceId: 'telegram:topic:1',
    surfaceLabel: 'Main topic'
  });
  await firstRegistry.upsertCodexThreadBinding({
    id: 'codex-binding-1',
    projectThreadId: 'thread-1',
    machineId: identity.machineId,
    codexThreadId: 'codex-thread-1'
  });
  await firstRegistry.upsertActiveThreadState({
    id: 'active-1',
    platformBindingId: 'binding-1',
    projectId: 'project-1',
    projectThreadId: 'thread-1'
  });
  await firstRegistry.appendSyncSnapshot({
    id: 'snapshot-1',
    machineId: identity.machineId,
    status: 'ok',
    details: 'initial registry restore probe'
  });

  const secondRegistry = new PersistentBackendRegistry(registryPath);
  const summary = await secondRegistry.getSummary();
  const state = await secondRegistry.readState();

  assert.equal(summary.userCount, 1);
  assert.equal(summary.localMachineCount, 1);
  assert.equal(summary.projectCount, 1);
  assert.equal(summary.projectThreadCount, 1);
  assert.equal(summary.platformBindingCount, 1);
  assert.equal(summary.codexThreadBindingCount, 1);
  assert.equal(summary.activeThreadStateCount, 1);
  assert.equal(summary.syncSnapshotCount, 1);
  assert.equal(state.projects[0]?.name, 'Project One');
  assert.equal(state.projectThreads[0]?.title, 'Main thread');
  assert.equal(state.platformBindings[0]?.surfaceId, 'telegram:topic:1');
  assert.equal(state.codexThreadBindings[0]?.codexThreadId, 'codex-thread-1');
  assert.equal(state.activeThreadStates[0]?.projectThreadId, 'thread-1');
  assert.equal(state.syncSnapshots[0]?.status, 'ok');
  assert.equal(state.localMachines[0]?.id, machineRecordId);
});
