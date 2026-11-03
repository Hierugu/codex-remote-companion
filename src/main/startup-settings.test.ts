import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { StartupSettingsStore } from './startup-settings';

test('StartupSettingsStore keeps server auto-start independent of macOS login', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-remote-companion-startup-'));
  const path = join(root, 'startup-settings.json');
  const store = new StartupSettingsStore(path);

  assert.equal(await store.getAutoStartServer(), false);
  await store.setAutoStartServer(true);
  assert.equal(await new StartupSettingsStore(path).getAutoStartServer(), true);
  await store.setAutoStartServer(false);
  assert.equal(await new StartupSettingsStore(path).getAutoStartServer(), false);
});
