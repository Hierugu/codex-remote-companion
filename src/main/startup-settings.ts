import { readFile } from 'node:fs/promises';

import { getCompanionStatePath } from './companion-paths';
import { parseJsonWithRecovery, writeJsonAtomically } from './json-file';

interface StartupSettingsFile {
  autoStartServer: boolean;
}

export class StartupSettingsStore {
  constructor(private readonly path = getCompanionStatePath('startup-settings.json')) {}

  async getAutoStartServer(): Promise<boolean> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const { value } = parseJsonWithRecovery<Partial<StartupSettingsFile>>(raw);
      return value.autoStartServer === true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async setAutoStartServer(enabled: boolean): Promise<void> {
    await writeJsonAtomically(this.path, { autoStartServer: enabled } satisfies StartupSettingsFile);
  }
}
