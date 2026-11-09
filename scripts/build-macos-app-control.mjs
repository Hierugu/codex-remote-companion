import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') process.exit(0);

const root = process.cwd();
const output = join(root, 'build', 'remote-app-control');
mkdirSync(join(root, 'build'), { recursive: true });
const result = spawnSync('xcrun', [
  'swiftc', '-O', '-o', output, join(root, 'native', 'remote-app-control.swift')
], {
  stdio: 'inherit',
  env: {
    ...process.env,
    SWIFT_MODULE_CACHE_PATH: '/private/tmp/codex-remote-companion-swift-cache',
    CLANG_MODULE_CACHE_PATH: '/private/tmp/codex-remote-companion-clang-cache'
  }
});
if (result.status !== 0) process.exit(result.status ?? 1);
