import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

function findTopLevelJsonEnd(raw: string): number {
  const start = raw.search(/\S/);
  if (start === -1) {
    return -1;
  }

  const opener = raw[start];
  if (opener !== '{' && opener !== '[') {
    return -1;
  }

  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }

      if (char === '\\') {
        escaping = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === opener) {
      depth += 1;
      continue;
    }

    if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return -1;
}

export function parseJsonWithRecovery<T>(raw: string): {
  value: T;
  repaired: boolean;
} {
  try {
    return {
      value: JSON.parse(raw) as T,
      repaired: false
    };
  } catch (error) {
    const recoveredEnd = findTopLevelJsonEnd(raw);
    if (recoveredEnd === -1) {
      throw error;
    }

    const recoveredRaw = raw.slice(0, recoveredEnd);
    return {
      value: JSON.parse(recoveredRaw) as T,
      repaired: recoveredRaw.trim() !== raw.trim()
    };
  }
}

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tempPath, path);
}
