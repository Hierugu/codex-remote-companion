import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readLatestCodexTurnActivity } from './codex-turn-activity';

test('finds the latest lifecycle event through large output and an unfinished final line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-turn-activity-'));
  const path = join(root, 'rollout.jsonl');
  const record = (type: string) => JSON.stringify({
    type: 'event_msg', timestamp: '2026-01-01T00:00:00Z', payload: { type }
  }) + '\n';
  await writeFile(path,
    record('task_started') +
    JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(200_000) } }) + '\n' +
    record('task_complete') +
    '{"type":"event_msg","payload":'
  );
  assert.deepEqual(await readLatestCodexTurnActivity(path), {
    active: false, changedAt: Date.parse('2026-01-01T00:00:00Z')
  });
});
