import { contextBridge, ipcRenderer } from 'electron';

import type {
  BackendActiveThreadStateRecord,
  BackendCodexThreadBindingRecord,
  BackendPlatformBindingRecord,
  BackendProjectRecord,
  BackendProjectThreadRecord,
  ChannelConnectionRecord,
  ControlPlaneStatus,
  CodexDesktopApi,
  CodexEnvironmentSnapshot,
  CodexProjectOption,
  CodexProjectThreadOption,
  CodexThreadListResult,
  CodexThreadRecord,
  CreateCodexThreadBindingInput,
  CreatePlatformBindingInput,
  CreateProjectInput,
  CreateProjectThreadInput,
  EnsureCodexProjectResult,
  FailureSummary,
  ProductHealthSummary,
  ProductInstallationState,
  ProductMachineState,
  ProductSyncStatus,
  RepairResult,
  RuntimeBootstrapState,
  RuntimeServerStartResult,
  StartupSettingsState,
  TelegramConnectionState,
  TelegramProjectSyncRowInput,
  TelegramRemoveBotTokenResult,
  TelegramRepairResult,
  TelegramSetBotTokenResult,
  TelegramSyncResult,
  TelegramTopicSyncRowStatus,
  TriggerSyncResult,
  UpsertActiveThreadStateInput
} from '@shared/contracts';

const api: CodexDesktopApi = {
  getBootstrapState: () =>
    ipcRenderer.invoke('runtime:get-bootstrap-state') as Promise<RuntimeBootstrapState>,
  startServer: () =>
    ipcRenderer.invoke('runtime:start-server') as Promise<RuntimeServerStartResult>,
  stopServer: () =>
    ipcRenderer.invoke('runtime:stop-server') as Promise<RuntimeServerStartResult>,
  getStartupSettings: () =>
    ipcRenderer.invoke('startup:get-settings') as Promise<StartupSettingsState>,
  setLaunchAtLogin: (enabled) =>
    ipcRenderer.invoke('startup:set-launch-at-login', enabled) as Promise<StartupSettingsState>,
  setAutoStartServer: (enabled) =>
    ipcRenderer.invoke('startup:set-auto-start-server', enabled) as Promise<StartupSettingsState>,
  getCodexEnvironmentSnapshot: () =>
    ipcRenderer.invoke('codex:get-environment-snapshot') as Promise<CodexEnvironmentSnapshot>,
  listCodexThreads: () =>
    ipcRenderer.invoke('codex:list-threads') as Promise<CodexThreadListResult>,
  readCodexThread: (threadId) =>
    ipcRenderer.invoke('codex:read-thread', threadId) as Promise<CodexThreadRecord>,
  getControlPlaneStatus: () =>
    ipcRenderer.invoke('control-plane:get-status') as Promise<ControlPlaneStatus>,
  getInstallationState: () =>
    ipcRenderer.invoke('product:get-installation-state') as Promise<ProductInstallationState>,
  getMachineState: () =>
    ipcRenderer.invoke('product:get-machine-state') as Promise<ProductMachineState>,
  getSyncStatus: () =>
    ipcRenderer.invoke('product:get-sync-status') as Promise<ProductSyncStatus>,
  triggerSync: () =>
    ipcRenderer.invoke('product:trigger-sync') as Promise<TriggerSyncResult>,
  listCodexProjects: () =>
    ipcRenderer.invoke('product:list-codex-projects') as Promise<CodexProjectOption[]>,
  listCodexProjectThreads: (projectId: string) =>
    ipcRenderer.invoke('product:list-codex-project-threads', projectId) as Promise<
      CodexProjectThreadOption[]
    >,
  ensureCodexProject: (projectId: string) =>
    ipcRenderer.invoke('product:ensure-codex-project', projectId) as Promise<
      EnsureCodexProjectResult
    >,
  listProjects: () =>
    ipcRenderer.invoke('product:list-projects') as Promise<BackendProjectRecord[]>,
  createProject: (input: CreateProjectInput) =>
    ipcRenderer.invoke('product:create-project', input) as Promise<BackendProjectRecord>,
  listProjectThreads: (projectId: string) =>
    ipcRenderer.invoke('product:list-project-threads', projectId) as Promise<
      BackendProjectThreadRecord[]
    >,
  createProjectThread: (input: CreateProjectThreadInput) =>
    ipcRenderer.invoke('product:create-project-thread', input) as Promise<BackendProjectThreadRecord>,
  listChannelConnections: () =>
    ipcRenderer.invoke('product:list-channel-connections') as Promise<ChannelConnectionRecord[]>,
  listPlatformBindings: () =>
    ipcRenderer.invoke('product:list-platform-bindings') as Promise<BackendPlatformBindingRecord[]>,
  createPlatformBinding: (input: CreatePlatformBindingInput) =>
    ipcRenderer.invoke('product:create-platform-binding', input) as Promise<BackendPlatformBindingRecord>,
  listCodexThreadBindings: () =>
    ipcRenderer.invoke('product:list-codex-thread-bindings') as Promise<
      BackendCodexThreadBindingRecord[]
    >,
  createCodexThreadBinding: (input: CreateCodexThreadBindingInput) =>
    ipcRenderer.invoke('product:create-codex-thread-binding', input) as Promise<
      BackendCodexThreadBindingRecord
    >,
  listActiveThreadStates: () =>
    ipcRenderer.invoke('product:list-active-thread-states') as Promise<
      BackendActiveThreadStateRecord[]
    >,
  upsertActiveThreadState: (input: UpsertActiveThreadStateInput) =>
    ipcRenderer.invoke('product:upsert-active-thread-state', input) as Promise<
      BackendActiveThreadStateRecord
    >,
  getFailureSummary: () =>
    ipcRenderer.invoke('product:get-failure-summary') as Promise<FailureSummary>,
  getHealthSummary: () =>
    ipcRenderer.invoke('product:get-health-summary') as Promise<ProductHealthSummary>,
  repairBootstrap: () =>
    ipcRenderer.invoke('product:repair-bootstrap') as Promise<RepairResult>,
  getTelegramConnectionState: () =>
    ipcRenderer.invoke('telegram:get-connection-state') as Promise<TelegramConnectionState>,
  validateTelegramConnection: () =>
    ipcRenderer.invoke('telegram:validate-connection') as Promise<TelegramConnectionState>,
  checkTelegramEnvironment: (rowId: string) =>
    ipcRenderer.invoke('telegram:check-environment', rowId) as Promise<TelegramConnectionState>,
  setTelegramBotToken: (token: string, ownerUserId: string) =>
    ipcRenderer.invoke('telegram:set-bot-token', token, ownerUserId) as Promise<TelegramSetBotTokenResult>,
  removeTelegramBotToken: () =>
    ipcRenderer.invoke('telegram:remove-bot-token') as Promise<TelegramRemoveBotTokenResult>,
  upsertTelegramProjectSyncRow: (input: TelegramProjectSyncRowInput) =>
    ipcRenderer.invoke('telegram:upsert-project-sync-row', input) as Promise<TelegramConnectionState>,
  removeTelegramProjectSyncRow: (rowId: string) =>
    ipcRenderer.invoke('telegram:remove-project-sync-row', rowId) as Promise<TelegramConnectionState>,
  setupTelegramEnvironment: (input: TelegramProjectSyncRowInput) =>
    ipcRenderer.invoke('telegram:setup-environment', input) as Promise<TelegramSyncResult>,
  repairTelegramEnvironment: (rowId: string) =>
    ipcRenderer.invoke('telegram:repair-environment', rowId) as Promise<TelegramRepairResult>,
  syncTelegram: () =>
    ipcRenderer.invoke('telegram:sync') as Promise<TelegramSyncResult>,
  getTelegramTopicSyncStatus: () =>
    ipcRenderer.invoke('telegram:topic-sync-status') as Promise<TelegramTopicSyncRowStatus[]>,
  retryTelegramTopic: (rowId, codexThreadId) =>
    ipcRenderer.invoke('telegram:retry-topic', rowId, codexThreadId) as Promise<void>,
  attachTelegramTopic: (rowId, codexThreadId, topicId) =>
    ipcRenderer.invoke('telegram:attach-topic', rowId, codexThreadId, topicId) as Promise<void>,
  onRuntimeStateChanged: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      state: RuntimeBootstrapState
    ) => listener(state);

    ipcRenderer.on('runtime:state-changed', wrappedListener);

    return () => {
      ipcRenderer.removeListener('runtime:state-changed', wrappedListener);
    };
  }
};

contextBridge.exposeInMainWorld('codexDesktop', api);
