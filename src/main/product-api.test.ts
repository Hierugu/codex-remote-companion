import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { PersistentBackendRegistry } from './backend-registry';
import { CodexLocalStore } from './codex-store';
import { LocalCompanionRegistry } from './companion-registry';
import { InProcessCompanionTransport } from './companion-transport';
import { ControlPlaneBackend } from './control-plane';
import { ProductApiService } from './product-api';
import {
  buildRuntimeBootstrapState,
  createDefaultChannels,
  LocalRuntimeController,
  resolveCodexAppStatus,
  resolveCodexCliStatus
} from './runtime';

async function createProductApiCodexHome(root: string): Promise<string> {
  const codexHome = join(root, 'codex-home');
  await mkdir(join(codexHome, 'sessions', '2026', '04', '20'), { recursive: true });
  await mkdir(join(codexHome, 'archived_sessions'), { recursive: true });
  await writeFile(join(codexHome, 'config.toml'), 'model = "gpt-5.4"');
  await writeFile(
    join(codexHome, '.codex-global-state.json'),
    JSON.stringify({
      'project-order': ['/workspace/aps'],
      'electron-saved-workspace-roots': ['/workspace/aps', '/workspace/side']
    })
  );
  await writeFile(
    join(codexHome, 'session_index.jsonl'),
    JSON.stringify({
      id: 'thread-aps-1',
      thread_name: 'APs main thread',
      updated_at: '2026-04-20T08:00:00.000Z'
    })
  );
  await writeFile(
    join(codexHome, 'sessions', '2026', '04', '20', 'thread-aps-1.jsonl'),
    JSON.stringify({
      timestamp: '2026-04-20T08:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'thread-aps-1',
        timestamp: '2026-04-20T08:00:00.000Z',
        cwd: '/workspace/aps',
        originator: 'Codex Desktop',
        cli_version: '0.121.0'
      }
    })
  );

  return codexHome;
}

test('ProductApiService exposes installation, machine and sync surfaces', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase5-'));
  const runtimeController = new LocalRuntimeController({ port: 0 });
  await runtimeController.start();

  try {
    const productApi = new ProductApiService({
      getRuntimeState: () =>
        buildRuntimeBootstrapState({
          codexStatus: { tone: 'green', text: 'Codex App and CLI detected' },
          codexAppStatus: resolveCodexAppStatus(true),
          codexCliStatus: resolveCodexCliStatus(true),
          serverRunning: runtimeController.isRunning(),
          serverPort: runtimeController.getPort(),
          channels: createDefaultChannels()
        }),
      controlPlane: new ControlPlaneBackend({
        registry: new LocalCompanionRegistry(join(tempRoot, 'companion-registry.json')),
        backendRegistry: new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json')),
        transport: new InProcessCompanionTransport(runtimeController)
      }),
      backendRegistry: new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json')),
      codexStore: new CodexLocalStore()
    });

    const installation = await productApi.getInstallationState();
    const machine = await productApi.getMachineState();
    const syncBefore = await productApi.getSyncStatus();
    const syncAfter = await productApi.triggerSync();
    const health = await productApi.getHealthSummary();

    assert.equal(installation.initialized, true);
    assert.equal(installation.nextStep, 'ready');
    assert.equal(machine.runtimeReady, true);
    assert.equal(machine.codexAvailable, true);
    assert.equal(syncBefore.lastSync, null);
    assert.equal(syncAfter.ok, true);
    assert.equal(syncAfter.syncStatus.lastSync?.status, 'ok');
    assert.equal(health.failures.highestSeverity, 'none');
  } finally {
    await runtimeController.stop();
  }
});

test('ProductApiService persists project, thread, binding and active-thread surfaces', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase5-'));
  const runtimeController = new LocalRuntimeController({ port: 0 });
  await runtimeController.start();

  try {
    const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
    const companionRegistry = new LocalCompanionRegistry(join(tempRoot, 'companion-registry.json'));
    const productApi = new ProductApiService({
      getRuntimeState: () =>
        buildRuntimeBootstrapState({
          codexStatus: { tone: 'green', text: 'Codex CLI detected' },
          codexAppStatus: resolveCodexAppStatus(false),
          codexCliStatus: resolveCodexCliStatus(true),
          serverRunning: runtimeController.isRunning(),
          serverPort: runtimeController.getPort(),
          channels: createDefaultChannels()
        }),
      controlPlane: new ControlPlaneBackend({
        registry: companionRegistry,
        backendRegistry,
        transport: new InProcessCompanionTransport(runtimeController)
      }),
      backendRegistry,
      codexStore: new CodexLocalStore()
    });

    const project = await productApi.createProject({
      platform: 'telegram',
      name: 'Telegram alpha'
    });
    const thread = await productApi.createProjectThread({
      projectId: project.id,
      title: 'Main discussion'
    });
    const binding = await productApi.createPlatformBinding({
      platform: 'telegram',
      bindingType: 'thread-surface',
      projectId: project.id,
      projectThreadId: thread.id,
      surfaceId: 'telegram:topic:123',
      surfaceLabel: 'Main topic'
    });
    const installation = await productApi.getInstallationState();
    const codexBinding = await productApi.createCodexThreadBinding({
      projectThreadId: thread.id,
      machineId: installation.installIdentity!.machineId,
      codexThreadId: 'codex-thread-123'
    });
    const activeState = await productApi.upsertActiveThreadState({
      platformBindingId: binding.id,
      projectId: project.id,
      projectThreadId: thread.id
    });

    const projects = await productApi.listProjects();
    const threads = await productApi.listProjectThreads(project.id);
    const bindings = await productApi.listPlatformBindings();
    const codexBindings = await productApi.listCodexThreadBindings();
    const activeStates = await productApi.listActiveThreadStates();

    assert.equal(projects.length, 1);
    assert.equal(threads.length, 1);
    assert.equal(bindings[0]?.surfaceId, 'telegram:topic:123');
    assert.equal(codexBindings[0]?.codexThreadId, 'codex-thread-123');
    assert.equal(activeStates[0]?.platformBindingId, binding.id);
    assert.equal(activeState.projectThreadId, thread.id);
    assert.equal(codexBinding.projectThreadId, thread.id);
  } finally {
    await runtimeController.stop();
  }
});

test('ProductApiService exposes and materializes local Codex projects for UI dropdowns', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase5-'));
  const codexHome = await createProductApiCodexHome(tempRoot);
  const runtimeController = new LocalRuntimeController({ port: 0 });
  await runtimeController.start();

  try {
    const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
    const companionRegistry = new LocalCompanionRegistry(join(tempRoot, 'companion-registry.json'));
    const productApi = new ProductApiService({
      getRuntimeState: () =>
        buildRuntimeBootstrapState({
          codexStatus: { tone: 'green', text: 'Codex CLI detected' },
          codexAppStatus: resolveCodexAppStatus(false),
          codexCliStatus: resolveCodexCliStatus(true),
          serverRunning: runtimeController.isRunning(),
          serverPort: runtimeController.getPort(),
          channels: createDefaultChannels()
        }),
      controlPlane: new ControlPlaneBackend({
        registry: companionRegistry,
        backendRegistry,
        transport: new InProcessCompanionTransport(runtimeController)
      }),
      backendRegistry,
      codexStore: new CodexLocalStore(codexHome)
    });

    const codexProjects = await productApi.listCodexProjects();
    const apsProject = codexProjects.find((project) => project.name === 'aps');
    assert.ok(apsProject);

    const localThreads = await productApi.listCodexProjectThreads(apsProject.id);
    const materialized = await productApi.ensureCodexProject(apsProject.id);
    const backendThreads = await productApi.listProjectThreads(materialized.project.id);
    const codexBindings = await productApi.listCodexThreadBindings();

    assert.equal(localThreads.length, 1);
    assert.equal(materialized.threadCount, 1);
    assert.equal(backendThreads[0]?.title, 'APs main thread');
    assert.equal(codexBindings[0]?.codexThreadId, 'thread-aps-1');
  } finally {
    await runtimeController.stop();
  }
});

test('ProductApiService reports failures and repair surfaces from runtime state', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase5-'));
  const runtimeController = new LocalRuntimeController({ port: 0 });
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const companionRegistry = new LocalCompanionRegistry(join(tempRoot, 'companion-registry.json'));
  const productApi = new ProductApiService({
    getRuntimeState: () =>
      buildRuntimeBootstrapState({
        codexStatus: { tone: 'red', text: 'Codex not detected' },
        codexAppStatus: resolveCodexAppStatus(false),
        codexCliStatus: resolveCodexCliStatus(false),
        serverRunning: runtimeController.isRunning(),
        serverPort: runtimeController.getPort(),
        channels: createDefaultChannels()
      }),
    controlPlane: new ControlPlaneBackend({
      registry: companionRegistry,
      backendRegistry,
      transport: new InProcessCompanionTransport(runtimeController)
    }),
    backendRegistry,
    codexStore: new CodexLocalStore()
  });

  const failures = await productApi.getFailureSummary();
  const repair = await productApi.repairBootstrap();

  assert.equal(failures.highestSeverity, 'critical');
  assert.ok(failures.issues.some((issue) => issue.code === 'codex_not_detected'));
  assert.equal(repair.ok, true);
  assert.equal(repair.installation.initialized, true);
});
