import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

import type { InstallIdentityRecord } from '@shared/contracts';

import { parseJsonWithRecovery, writeJsonAtomically } from './json-file';
import { getCompanionStatePath, getLegacyCompanionStatePath } from './companion-paths';

interface CompanionRegistryShape {
  installId: string;
  machineId: string;
  createdAt: string;
  updatedAt: string;
}

function buildMachineId(): string {
  return createHash('sha256').update(hostname()).digest('hex').slice(0, 16);
}

export function getDefaultCompanionRegistryPath(): string {
  return getCompanionStatePath('companion-registry.json');
}

function getLegacyCompanionRegistryPath(): string | null {
  return getLegacyCompanionStatePath('companion-registry.json');
}

export class LocalCompanionRegistry {
  constructor(
    private readonly registryPath = getDefaultCompanionRegistryPath(),
    private readonly legacyRegistryPath = getLegacyCompanionRegistryPath()
  ) {}

  getRegistryPath(): string {
    return this.registryPath;
  }

  async ensureInstallIdentity(): Promise<InstallIdentityRecord> {
    const existing = await this.readInstallIdentity();
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const created: CompanionRegistryShape = {
      installId: randomUUID(),
      machineId: buildMachineId(),
      createdAt: now,
      updatedAt: now
    };

    await this.writeRegistry(created);
    return this.toInstallIdentity(created);
  }

  async readInstallIdentity(): Promise<InstallIdentityRecord | null> {
    const sourcePath = this.getReadableRegistryPath();
    if (!sourcePath) {
      return null;
    }

    const raw = await readFile(sourcePath, 'utf8');
    const { value: parsed, repaired } = parseJsonWithRecovery<CompanionRegistryShape>(raw);

    if (repaired || sourcePath !== this.registryPath) {
      await this.writeRegistry(parsed);
    }

    if (!parsed.installId || !parsed.machineId) {
      return null;
    }

    return this.toInstallIdentity(parsed);
  }

  private async writeRegistry(nextState: CompanionRegistryShape): Promise<void> {
    await writeJsonAtomically(this.registryPath, nextState);
  }

  private getReadableRegistryPath(): string | null {
    if (existsSync(this.registryPath)) {
      return this.registryPath;
    }

    if (
      this.registryPath === getDefaultCompanionRegistryPath() &&
      this.legacyRegistryPath !== null &&
      existsSync(this.legacyRegistryPath)
    ) {
      return this.legacyRegistryPath;
    }

    return null;
  }

  private toInstallIdentity(input: CompanionRegistryShape): InstallIdentityRecord {
    return {
      installId: input.installId,
      machineId: input.machineId,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      source: 'local-companion-registry'
    };
  }
}
