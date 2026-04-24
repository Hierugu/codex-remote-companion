import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  buildRuntimeBootstrapState,
  createDefaultChannels,
  LocalRuntimeController,
  resolveCodexAppStatus,
  resolveCodexCliStatus,
  resolveCodexStatus
} from './runtime';

test('resolveCodexStatus returns red when nothing is detected', () => {
  assert.deepEqual(
    resolveCodexStatus({ appDetected: false, cliDetected: false }),
    { tone: 'red', text: 'Codex not detected' }
  );
});

test('resolveCodexStatus returns correct green variants', () => {
  assert.deepEqual(
    resolveCodexStatus({ appDetected: true, cliDetected: false }),
    { tone: 'green', text: 'Codex App detected' }
  );
  assert.deepEqual(
    resolveCodexStatus({ appDetected: false, cliDetected: true }),
    { tone: 'green', text: 'Codex CLI detected' }
  );
  assert.deepEqual(
    resolveCodexStatus({ appDetected: true, cliDetected: true }),
    { tone: 'green', text: 'Codex App and CLI detected' }
  );
});

test('buildRuntimeBootstrapState creates the dashboard state shape', () => {
  const state = buildRuntimeBootstrapState({
    codexStatus: { tone: 'green', text: 'Codex CLI detected' },
    codexAppStatus: resolveCodexAppStatus(false),
    codexCliStatus: resolveCodexCliStatus(true),
    serverRunning: false,
    serverPort: null
  });

  assert.equal(state.codexStatus.text, 'Codex CLI detected');
  assert.equal(state.codexAppStatus.text, 'Not detected');
  assert.equal(state.codexCliStatus.text, 'Detected');
  assert.equal(state.serverStatus.text, 'Codex server turned off');
  assert.equal(state.channels.length, createDefaultChannels().length);
});

test('split Codex readiness statuses include versions when available', () => {
  const state = buildRuntimeBootstrapState({
    codexStatus: { tone: 'green', text: 'Codex App and CLI detected' },
    codexAppStatus: resolveCodexAppStatus(true),
    codexAppVersion: '1.2.3',
    codexCliStatus: resolveCodexCliStatus(true),
    codexCliVersion: 'codex-cli 0.50.0',
    serverRunning: false,
    serverPort: null
  });

  assert.equal(state.codexAppStatus.text, 'Detected');
  assert.equal(state.codexAppVersion, '1.2.3');
  assert.equal(state.codexCliStatus.text, 'Detected');
  assert.equal(state.codexCliVersion, 'codex-cli 0.50.0');
});

test('LocalRuntimeController starts a health endpoint and stops cleanly', async () => {
  const controller = new LocalRuntimeController({ port: 0 });

  await controller.start();
  assert.equal(controller.isRunning(), true);

  const port = controller.getPort();
  assert.ok(port);

  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);

  const payload = (await response.json()) as { ok: boolean; port: number };
  assert.equal(payload.ok, true);
  assert.equal(payload.port, port);

  await controller.stop();
  assert.equal(controller.isRunning(), false);
  assert.equal(controller.getPort(), null);
});

test('LocalRuntimeController start is idempotent after first boot', async () => {
  const controller = new LocalRuntimeController({ port: 0 });

  await controller.start();
  const firstPort = controller.getPort();
  await controller.start();
  const secondPort = controller.getPort();

  assert.equal(firstPort, secondPort);

  await controller.stop();
});

test('LocalRuntimeController falls back to a free port when the preferred port is busy', async () => {
  const blocker = createServer((_request, response) => {
    response.writeHead(200);
    response.end('busy');
  });

  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
  const blockerAddress = blocker.address();
  assert.ok(blockerAddress && typeof blockerAddress !== 'string');

  const controller = new LocalRuntimeController({ port: blockerAddress.port });

  try {
    await controller.start();
    const runtimePort = controller.getPort();
    assert.ok(runtimePort);
    assert.notEqual(runtimePort, blockerAddress.port);
  } finally {
    await controller.stop();
    await new Promise<void>((resolve, reject) =>
      blocker.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test('LocalRuntimeController accepts a dispatched control-plane task when running', async () => {
  const controller = new LocalRuntimeController({ port: 0 });

  await controller.start();

  try {
    const dispatched = await controller.dispatchTask({
      taskId: 'task-1',
      installId: 'install-1',
      machineId: 'machine-1',
      eventId: 'event-1',
      createdAt: new Date().toISOString(),
      routeKey: 'telegram:chat-1',
      routedThreadId: 'thread-1',
      prompt: 'hello',
      source: 'internal-smoke',
      projectKey: 'project-1'
    });

    assert.equal(dispatched.accepted, true);
    assert.equal(dispatched.taskId, 'task-1');
    assert.equal(controller.getLastDispatchedTask()?.taskId, 'task-1');
  } finally {
    await controller.stop();
  }
});
