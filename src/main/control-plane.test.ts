import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import type { NormalizedInboundEvent } from '@shared/contracts';

import { PersistentBackendRegistry } from './backend-registry';
import { LocalCompanionRegistry } from './companion-registry';
import { InProcessCompanionTransport } from './companion-transport';
import { ControlPlaneBackend } from './control-plane';
import { LocalRuntimeController } from './runtime';

test('LocalCompanionRegistry persists install identity across reloads', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase3-'));
  const registryPath = join(tempRoot, 'companion-registry.json');

  const firstRegistry = new LocalCompanionRegistry(registryPath);
  const firstIdentity = await firstRegistry.ensureInstallIdentity();

  const secondRegistry = new LocalCompanionRegistry(registryPath);
  const secondIdentity = await secondRegistry.ensureInstallIdentity();

  assert.equal(secondIdentity.installId, firstIdentity.installId);
  assert.equal(secondIdentity.machineId, firstIdentity.machineId);
});

test('ControlPlaneBackend routes inbound events into the local runtime', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase3-'));
  const runtimeController = new LocalRuntimeController({ port: 0 });
  await runtimeController.start();

  try {
    const backend = new ControlPlaneBackend({
      registry: new LocalCompanionRegistry(join(tempRoot, 'companion-registry.json')),
      backendRegistry: new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json')),
      transport: new InProcessCompanionTransport(runtimeController)
    });

    const inboundEvent: NormalizedInboundEvent = {
      id: 'evt-phase3-1',
      source: 'internal-smoke',
      receivedAt: new Date().toISOString(),
      text: 'Control-plane skeleton probe',
      externalThreadId: 'telegram:chat-1',
      projectKey: 'project-alpha',
      threadId: 'codex-thread-1'
    };

    const receipt = await backend.handleInboundEvent(inboundEvent);
    const runtimeTask = runtimeController.getLastDispatchedTask();
    const status = await backend.getStatus();

    assert.equal(receipt.accepted, true);
    assert.equal(receipt.routedThreadId, 'codex-thread-1');
    assert.ok(receipt.installId.length > 0);
    assert.ok(runtimeTask);
    assert.equal(runtimeTask?.eventId, inboundEvent.id);
    assert.equal(runtimeTask?.prompt, inboundEvent.text);
    assert.equal(runtimeTask?.routedThreadId, inboundEvent.threadId);
    assert.equal(status.lastDispatch?.eventId, inboundEvent.id);
    assert.equal(status.runtimeTaskId, runtimeTask?.taskId ?? null);
    assert.equal(status.backendRegistry?.userCount, 1);
    assert.equal(status.backendRegistry?.localMachineCount, 1);
    assert.equal(status.backendRegistry?.syncSnapshotCount, 1);
  } finally {
    await runtimeController.stop();
  }
});
