import assert from 'node:assert/strict';

import { CodexAppServerClient } from './app-server-client';
import { CodexLocalStore } from './codex-store';

async function main() {
  const store = new CodexLocalStore();

  const snapshot = await store.getEnvironmentSnapshot();
  assert.equal(snapshot.source, 'local-files');
  assert.ok(snapshot.threadCount >= 0);

  const threads = await store.listThreads(5);
  assert.ok(Array.isArray(threads));

  if (threads.length > 0) {
    const firstThread = await store.readThread(threads[0]!.id);
    assert.equal(firstThread.id, threads[0]!.id);
  }

  const client = await CodexAppServerClient.start();
  try {
    const probe = await client.probeThreadReadSurface();
    assert.ok(probe.listedThreadCount >= 0);
    if (probe.listedThreadIds[0]) {
      assert.equal(probe.readThreadId, probe.listedThreadIds[0]);
      assert.equal(probe.resumedThreadId, probe.listedThreadIds[0]);
    }
  } finally {
    await client.dispose();
  }

  console.log('phase2-smoke-ok');
}

void main();
