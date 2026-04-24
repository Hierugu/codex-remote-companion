import { homedir } from 'node:os';
import { join } from 'node:path';

export type CompanionReleaseChannel = 'personal' | 'public';

function normalizeReleaseChannel(value: string | undefined): CompanionReleaseChannel {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'public' || normalized === 'release' ? 'public' : 'personal';
}
export function getCompanionReleaseChannel(): CompanionReleaseChannel {
  return normalizeReleaseChannel(process.env.CRC_RELEASE_CHANNEL);
}

export function getCompanionStateRoot(): string {
  const directoryName =
    getCompanionReleaseChannel() === 'public'
      ? '.codex-remote-companion-public'
      : '.codex-remote-companion';

  return join(homedir(), directoryName);
}

export function getCompanionStatePath(fileName: string): string {
  return join(getCompanionStateRoot(), fileName);
}

export function getLegacyCompanionStatePath(fileName: string): string | null {
  if (getCompanionReleaseChannel() === 'public') {
    return null;
  }

  return join(homedir(), '.codex-companion', fileName);
}
