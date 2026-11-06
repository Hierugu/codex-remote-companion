import { open } from 'node:fs/promises';

export interface CodexTurnActivity {
  active: boolean;
  changedAt: number | null;
}

const CHUNK_SIZE = 64 * 1024;

function activityFromLine(line: Buffer): CodexTurnActivity | null {
  if (line.length === 0) return null;
  try {
    const record = JSON.parse(line.toString('utf8')) as {
      type?: string;
      timestamp?: string;
      payload?: { type?: string };
    };
    if (record.type !== 'event_msg') return null;
    const event = record.payload?.type;
    if (event !== 'task_started' && event !== 'task_complete' && event !== 'turn_aborted') return null;
    const timestamp = Date.parse(record.timestamp ?? '');
    return { active: event === 'task_started', changedAt: Number.isFinite(timestamp) ? timestamp : null };
  } catch {
    return null; // Codex may be writing the final JSONL line.
  }
}

export async function readLatestCodexTurnActivity(path: string): Promise<CodexTurnActivity | null> {
  const file = await open(path, 'r');
  try {
    let position = (await file.stat()).size;
    let remainder = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(CHUNK_SIZE, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(chunk, 0, length, position);
      const data = Buffer.concat([chunk.subarray(0, bytesRead), remainder]);
      let lineEnd = data.length;
      for (let index = data.length - 1; index >= 0; index -= 1) {
        if (data[index] !== 10) continue;
        const activity = activityFromLine(data.subarray(index + 1, lineEnd));
        if (activity) return activity;
        lineEnd = index;
      }
      remainder = data.subarray(0, lineEnd);
    }
    return activityFromLine(remainder);
  } finally {
    await file.close();
  }
}
