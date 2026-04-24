import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import type {
  BackendActiveThreadStateRecord,
  BackendCodexThreadBindingRecord,
  BackendLocalMachineRecord,
  BackendPlatformBindingRecord,
  BackendProjectRecord,
  BackendProjectThreadRecord,
  BackendRegistrySummary,
  BackendSyncSnapshotRecord,
  BackendUserRecord,
  InstallIdentityRecord,
  PersistentBackendRegistryState,
  SyncSnapshotStatus
} from '@shared/contracts';

import { parseJsonWithRecovery, writeJsonAtomically } from './json-file';
import { getCompanionStatePath, getLegacyCompanionStatePath } from './companion-paths';

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptyState(): PersistentBackendRegistryState {
  return {
    version: 1,
    source: 'persistent-backend-registry',
    updatedAt: nowIso(),
    users: [],
    localMachines: [],
    projects: [],
    projectThreads: [],
    platformBindings: [],
    codexThreadBindings: [],
    activeThreadStates: [],
    syncSnapshots: []
  };
}

function withTimestamps<T extends { id: string; createdAt: string; updatedAt: string }>(
  current: T | undefined,
  next: Omit<T, 'createdAt' | 'updatedAt'>
): T {
  const timestamp = nowIso();

  return {
    ...next,
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp
  } as T;
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const existingIndex = items.findIndex((item) => item.id === next.id);
  if (existingIndex === -1) {
    return [...items, next];
  }

  const cloned = [...items];
  cloned[existingIndex] = next;
  return cloned;
}

export function getDefaultBackendRegistryPath(): string {
  return getCompanionStatePath('backend-registry.json');
}

function getLegacyBackendRegistryPath(): string | null {
  return getLegacyCompanionStatePath('backend-registry.json');
}

export class PersistentBackendRegistry {
  constructor(
    private readonly registryPath = getDefaultBackendRegistryPath(),
    private readonly legacyRegistryPath = getLegacyBackendRegistryPath()
  ) {}

  getRegistryPath(): string {
    return this.registryPath;
  }

  async ensureBootstrap(identity: InstallIdentityRecord): Promise<PersistentBackendRegistryState> {
    const state = await this.readState();
    const userId = `user:${identity.installId}`;
    const machineRecordId = `machine:${identity.machineId}`;

    const nextUser = withTimestamps<BackendUserRecord>(
      state.users.find((record) => record.id === userId),
      { id: userId }
    );

    const nextMachine = withTimestamps<BackendLocalMachineRecord>(
      state.localMachines.find((record) => record.id === machineRecordId),
      {
        id: machineRecordId,
        userId,
        installId: identity.installId,
        machineId: identity.machineId
      }
    );

    const nextState: PersistentBackendRegistryState = {
      ...state,
      updatedAt: nowIso(),
      users: upsertById(state.users, nextUser),
      localMachines: upsertById(state.localMachines, nextMachine)
    };

    await this.writeState(nextState);
    return nextState;
  }

  async upsertProject(
    record: Omit<BackendProjectRecord, 'createdAt' | 'updatedAt'>
  ): Promise<BackendProjectRecord> {
    return this.upsertEntity('projects', record);
  }

  async upsertProjectThread(
    record: Omit<BackendProjectThreadRecord, 'createdAt' | 'updatedAt'>
  ): Promise<BackendProjectThreadRecord> {
    return this.upsertEntity('projectThreads', record);
  }

  async upsertPlatformBinding(
    record: Omit<BackendPlatformBindingRecord, 'createdAt' | 'updatedAt'>
  ): Promise<BackendPlatformBindingRecord> {
    return this.upsertEntity('platformBindings', record);
  }

  async upsertCodexThreadBinding(
    record: Omit<BackendCodexThreadBindingRecord, 'createdAt' | 'updatedAt'>
  ): Promise<BackendCodexThreadBindingRecord> {
    return this.upsertEntity('codexThreadBindings', record);
  }

  async upsertActiveThreadState(
    record: Omit<BackendActiveThreadStateRecord, 'createdAt' | 'updatedAt'>
  ): Promise<BackendActiveThreadStateRecord> {
    return this.upsertEntity('activeThreadStates', record);
  }

  async appendSyncSnapshot(input: {
    id: string;
    machineId: string;
    status: SyncSnapshotStatus;
    details?: string | null;
    observedAt?: string;
  }): Promise<BackendSyncSnapshotRecord> {
    const state = await this.readState();
    const snapshot: BackendSyncSnapshotRecord = {
      id: input.id,
      machineId: input.machineId,
      status: input.status,
      observedAt: input.observedAt ?? nowIso(),
      details: input.details ?? null
    };

    const nextState: PersistentBackendRegistryState = {
      ...state,
      updatedAt: nowIso(),
      syncSnapshots: [...state.syncSnapshots, snapshot]
    };

    await this.writeState(nextState);
    return snapshot;
  }

  async readState(): Promise<PersistentBackendRegistryState> {
    const sourcePath = this.getReadableRegistryPath();
    if (!sourcePath) {
      return createEmptyState();
    }

    const raw = await readFile(sourcePath, 'utf8');
    const { value, repaired } = parseJsonWithRecovery<PersistentBackendRegistryState>(raw);
    if (repaired || sourcePath !== this.registryPath) {
      await this.writeState(value);
    }

    return value;
  }

  async getSummary(): Promise<BackendRegistrySummary> {
    const state = await this.readState();

    return {
      registryPath: this.registryPath,
      userCount: state.users.length,
      localMachineCount: state.localMachines.length,
      projectCount: state.projects.length,
      projectThreadCount: state.projectThreads.length,
      platformBindingCount: state.platformBindings.length,
      codexThreadBindingCount: state.codexThreadBindings.length,
      activeThreadStateCount: state.activeThreadStates.length,
      syncSnapshotCount: state.syncSnapshots.length
    };
  }

  private async upsertEntity<T extends { id: string; createdAt: string; updatedAt: string }>(
    key:
      | 'projects'
      | 'projectThreads'
      | 'platformBindings'
      | 'codexThreadBindings'
      | 'activeThreadStates',
    record: Omit<T, 'createdAt' | 'updatedAt'>
  ): Promise<T> {
    const state = await this.readState();
    const collection = state[key] as unknown as T[];
    const nextRecord = withTimestamps<T>(
      collection.find((item) => item.id === record.id),
      record
    );

    const nextState: PersistentBackendRegistryState = {
      ...state,
      updatedAt: nowIso(),
      [key]: upsertById(collection, nextRecord)
    };

    await this.writeState(nextState);
    return nextRecord;
  }

  private async writeState(nextState: PersistentBackendRegistryState): Promise<void> {
    await writeJsonAtomically(this.registryPath, nextState);
  }

  private getReadableRegistryPath(): string | null {
    if (existsSync(this.registryPath)) {
      return this.registryPath;
    }

    if (
      this.registryPath === getDefaultBackendRegistryPath() &&
      this.legacyRegistryPath !== null &&
      existsSync(this.legacyRegistryPath)
    ) {
      return this.legacyRegistryPath;
    }

    return null;
  }
}
