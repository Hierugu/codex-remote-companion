import { randomUUID } from 'node:crypto';

import type {
  BackendActiveThreadStateRecord,
  BackendCodexThreadBindingRecord,
  BackendPlatformBindingRecord,
  BackendProjectRecord,
  BackendProjectThreadRecord,
  ChannelConnectionRecord,
  CodexProjectOption,
  CodexProjectThreadOption,
  CreateCodexThreadBindingInput,
  CreatePlatformBindingInput,
  CreateProjectInput,
  CreateProjectThreadInput,
  EnsureCodexProjectResult,
  FailureIssue,
  FailureSeverity,
  FailureSummary,
  ProductHealthSummary,
  ProductInstallationState,
  ProductMachineState,
  ProductSyncStatus,
  RepairResult,
  RuntimeBootstrapState,
  TriggerSyncResult,
  UpsertActiveThreadStateInput
} from '@shared/contracts';

import { PersistentBackendRegistry } from './backend-registry';
import { CodexLocalStore } from './codex-store';
import { ControlPlaneBackend } from './control-plane';
import { TelegramService } from './telegram-service';

interface ProductApiServiceOptions {
  getRuntimeState: () => RuntimeBootstrapState;
  controlPlane: ControlPlaneBackend;
  backendRegistry: PersistentBackendRegistry;
  codexStore: CodexLocalStore;
  telegramService?: TelegramService;
}

export class ProductApiService {
  private readonly getRuntimeStateValue: () => RuntimeBootstrapState;

  private readonly controlPlane: ControlPlaneBackend;

  private readonly backendRegistry: PersistentBackendRegistry;

  private readonly codexStore: CodexLocalStore;

  private readonly telegramService?: TelegramService;

  constructor(options: ProductApiServiceOptions) {
    this.getRuntimeStateValue = options.getRuntimeState;
    this.controlPlane = options.controlPlane;
    this.backendRegistry = options.backendRegistry;
    this.codexStore = options.codexStore;
    this.telegramService = options.telegramService;
  }

  async getInstallationState(): Promise<ProductInstallationState> {
    const controlPlaneStatus = await this.controlPlane.getStatus();
    const runtimeState = this.getRuntimeStateValue();
    const nextStep =
      runtimeState.codexStatus.tone === 'red'
        ? 'detect_codex'
        : runtimeState.serverStatus.tone === 'red'
          ? 'start_server'
          : 'ready';

    return {
      initialized: Boolean(controlPlaneStatus.installIdentity),
      installIdentity: controlPlaneStatus.installIdentity,
      nextStep,
      setupReady: nextStep === 'ready'
    };
  }

  async getMachineState(): Promise<ProductMachineState> {
    const controlPlaneStatus = await this.controlPlane.getStatus();
    const runtimeState = this.getRuntimeStateValue();
    const registryState = await this.backendRegistry.readState();

    return {
      localMachine:
        controlPlaneStatus.installIdentity == null
          ? null
          : registryState.localMachines.find(
              (machine) => machine.machineId === controlPlaneStatus.installIdentity?.machineId
            ) ?? null,
      codexStatus: runtimeState.codexStatus,
      serverStatus: runtimeState.serverStatus,
      serverPort: runtimeState.serverPort,
      runtimeReady: runtimeState.serverStatus.tone === 'green',
      codexAvailable: runtimeState.codexStatus.tone === 'green'
    };
  }

  async getSyncStatus(): Promise<ProductSyncStatus> {
    const snapshot = await this.codexStore.getEnvironmentSnapshot();
    const registryState = await this.backendRegistry.readState();
    const lastSync = registryState.syncSnapshots.at(-1) ?? null;

    return {
      available: true,
      lastSync,
      sourceThreadCount: snapshot.threadCount,
      archivedThreadCount: snapshot.archivedThreadCount,
      summaryText: lastSync
        ? `Last sync ${lastSync.status} at ${new Date(lastSync.observedAt).toLocaleString()}`
        : 'No sync has been run yet.'
    };
  }

  async triggerSync(): Promise<TriggerSyncResult> {
    const installation = await this.getInstallationState();
    const snapshot = await this.codexStore.getEnvironmentSnapshot();
    const runtimeState = this.getRuntimeStateValue();
    const machineId = installation.installIdentity?.machineId ?? 'machine:unknown';

    const syncStatus =
      runtimeState.codexStatus.tone === 'red'
        ? 'error'
        : 'ok';

    await this.backendRegistry.appendSyncSnapshot({
      id: `snapshot:${randomUUID()}`,
      machineId,
      status: syncStatus,
      details:
        syncStatus === 'ok'
          ? `threads=${snapshot.threadCount}, archived=${snapshot.archivedThreadCount}`
          : 'Codex not detected during manual sync.'
    });

    return {
      ok: syncStatus === 'ok',
      syncStatus: await this.getSyncStatus()
    };
  }

  async listCodexProjects(): Promise<CodexProjectOption[]> {
    return this.codexStore.listProjectOptions();
  }

  async listCodexProjectThreads(projectId: string): Promise<CodexProjectThreadOption[]> {
    return this.codexStore.listProjectThreadOptions(projectId);
  }

  async ensureCodexProject(projectId: string): Promise<EnsureCodexProjectResult> {
    const installation = await this.getInstallationState();
    if (!installation.installIdentity) {
      throw new Error('Installation identity is not initialized.');
    }

    const projectOptions = await this.codexStore.listProjectOptions();
    const selectedProject = projectOptions.find((project) => project.id === projectId);
    if (!selectedProject) {
      throw new Error('Codex project was not found.');
    }

    const projectThreads = await this.codexStore.listProjectThreadOptions(projectId);
    const project = await this.backendRegistry.upsertProject({
      id: selectedProject.id,
      userId: `user:${installation.installIdentity.installId}`,
      platform: 'telegram',
      name: selectedProject.name
    });

    for (const thread of projectThreads) {
      const projectThreadId = `project-thread:${thread.id}`;
      await this.backendRegistry.upsertProjectThread({
        id: projectThreadId,
        projectId: project.id,
        title: thread.title,
        archived: thread.archived
      });
      await this.backendRegistry.upsertCodexThreadBinding({
        id: `codex-binding:${thread.id}`,
        projectThreadId,
        machineId: installation.installIdentity.machineId,
        codexThreadId: thread.id
      });
    }

    return {
      project,
      threadCount: projectThreads.length
    };
  }

  async listProjects(): Promise<BackendProjectRecord[]> {
    const state = await this.backendRegistry.readState();
    return state.projects;
  }

  async createProject(input: CreateProjectInput): Promise<BackendProjectRecord> {
    const installation = await this.getInstallationState();
    if (!installation.installIdentity) {
      throw new Error('Installation identity is not initialized.');
    }

    return this.backendRegistry.upsertProject({
      id: `project:${randomUUID()}`,
      userId: `user:${installation.installIdentity.installId}`,
      platform: input.platform,
      name: input.name
    });
  }

  async listProjectThreads(projectId: string): Promise<BackendProjectThreadRecord[]> {
    const state = await this.backendRegistry.readState();
    return state.projectThreads.filter((thread) => thread.projectId === projectId);
  }

  async createProjectThread(
    input: CreateProjectThreadInput
  ): Promise<BackendProjectThreadRecord> {
    return this.backendRegistry.upsertProjectThread({
      id: `project-thread:${randomUUID()}`,
      projectId: input.projectId,
      title: input.title,
      archived: false
    });
  }

  async listChannelConnections(): Promise<ChannelConnectionRecord[]> {
    const runtimeState = this.getRuntimeStateValue();
    const telegramConnection = this.telegramService
      ? await this.telegramService.getConnectionState()
      : null;

    return runtimeState.channels.map((channel) => ({
      key: channel.key,
      label: channel.label,
      status:
        channel.key === 'telegram' && telegramConnection != null
          ? telegramConnection.status
          : channel.status,
      configured:
        channel.key === 'telegram' && telegramConnection != null
          ? telegramConnection.maskedBotToken != null
          : channel.status.tone !== 'red',
      detail:
        channel.key === 'telegram' && telegramConnection != null
          ? telegramConnection.issue ??
            (telegramConnection.status.tone === 'green'
              ? 'Bot connected'
              : 'Telegram bot not fully configured')
          : channel.status.tone === 'red'
            ? `${channel.label} is not connected`
            : `${channel.label} status is ${channel.status.text}`
    }));
  }

  async listPlatformBindings(): Promise<BackendPlatformBindingRecord[]> {
    const state = await this.backendRegistry.readState();
    return state.platformBindings;
  }

  async createPlatformBinding(
    input: CreatePlatformBindingInput
  ): Promise<BackendPlatformBindingRecord> {
    return this.backendRegistry.upsertPlatformBinding({
      id: `binding:${randomUUID()}`,
      platform: input.platform,
      bindingType: input.bindingType,
      projectId: input.projectId,
      projectThreadId: input.projectThreadId,
      surfaceId: input.surfaceId,
      surfaceLabel: input.surfaceLabel
    });
  }

  async listCodexThreadBindings(): Promise<BackendCodexThreadBindingRecord[]> {
    const state = await this.backendRegistry.readState();
    return state.codexThreadBindings;
  }

  async createCodexThreadBinding(
    input: CreateCodexThreadBindingInput
  ): Promise<BackendCodexThreadBindingRecord> {
    return this.backendRegistry.upsertCodexThreadBinding({
      id: `codex-binding:${randomUUID()}`,
      projectThreadId: input.projectThreadId,
      machineId: input.machineId,
      codexThreadId: input.codexThreadId
    });
  }

  async listActiveThreadStates(): Promise<BackendActiveThreadStateRecord[]> {
    const state = await this.backendRegistry.readState();
    return state.activeThreadStates;
  }

  async upsertActiveThreadState(
    input: UpsertActiveThreadStateInput
  ): Promise<BackendActiveThreadStateRecord> {
    const state = await this.backendRegistry.readState();
    const existing = state.activeThreadStates.find(
      (record) => record.platformBindingId === input.platformBindingId
    );

    return this.backendRegistry.upsertActiveThreadState({
      id: existing?.id ?? `active-thread:${randomUUID()}`,
      platformBindingId: input.platformBindingId,
      projectId: input.projectId,
      projectThreadId: input.projectThreadId
    });
  }

  async getFailureSummary(): Promise<FailureSummary> {
    const runtimeState = this.getRuntimeStateValue();
    const syncStatus = await this.getSyncStatus();
    const issues: FailureIssue[] = [];

    if (runtimeState.codexStatus.tone === 'red') {
      issues.push({
        code: 'codex_not_detected',
        severity: 'critical',
        message: 'Codex is not detected on this machine.',
        repairAction: 'detect_codex'
      });
    }

    if (runtimeState.serverStatus.tone === 'red') {
      issues.push({
        code: 'server_turned_off',
        severity: 'warning',
        message: 'Local server is turned off.',
        repairAction: 'start_server'
      });
    }

    if (!syncStatus.lastSync) {
      issues.push({
        code: 'sync_not_run',
        severity: 'warning',
        message: 'No sync has been run yet.',
        repairAction: 'run_sync'
      });
    }

    const highestSeverity = this.getHighestSeverity(issues);

    return {
      highestSeverity,
      issues
    };
  }

  async getHealthSummary(): Promise<ProductHealthSummary> {
    return {
      installation: await this.getInstallationState(),
      machine: await this.getMachineState(),
      sync: await this.getSyncStatus(),
      channels: await this.listChannelConnections(),
      failures: await this.getFailureSummary()
    };
  }

  async repairBootstrap(): Promise<RepairResult> {
    await this.controlPlane.getStatus();

    return {
      ok: true,
      installation: await this.getInstallationState(),
      machine: await this.getMachineState()
    };
  }

  private getHighestSeverity(issues: FailureIssue[]): FailureSeverity {
    if (issues.some((issue) => issue.severity === 'critical')) {
      return 'critical';
    }

    if (issues.length > 0) {
      return 'warning';
    }

    return 'none';
  }
}
