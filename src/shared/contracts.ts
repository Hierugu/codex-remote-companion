export type StatusTone = 'green' | 'yellow' | 'red';

export type MessengerKey = 'telegram' | 'discord' | 'whatsapp';
export type CodexThreadRole = 'user' | 'assistant' | 'system' | 'developer' | 'unknown';
export type RemoteExecutionPermissionMode = 'default' | 'full-access';

export interface StatusBadgeState {
  tone: StatusTone;
  text: string;
}

export interface MessengerChannelState {
  key: MessengerKey;
  label: string;
  status: StatusBadgeState;
}

export interface RuntimeBootstrapState {
  codexStatus: StatusBadgeState;
  codexAppStatus: StatusBadgeState;
  codexAppVersion: string | null;
  codexCliStatus: StatusBadgeState;
  codexCliVersion: string | null;
  serverStatus: StatusBadgeState;
  channels: MessengerChannelState[];
  serverPort: number | null;
}

export interface RuntimeServerStartResult {
  ok: boolean;
  state: RuntimeBootstrapState;
}

export interface CodexEnvironmentSnapshot {
  model: string | null;
  reasoningEffort: string | null;
  personality: string | null;
  activeUserEmail: string | null;
  permissionMode: string | null;
  primaryRateLimitRemainingPercent: number | null;
  primaryRateLimitWindowMinutes: number | null;
  primaryRateLimitResetsAt: string | null;
  weeklyRateLimitRemainingPercent: number | null;
  weeklyRateLimitWindowMinutes: number | null;
  weeklyRateLimitResetsAt: string | null;
  savedWorkspaceRoots: string[];
  activeWorkspaceRoots: string[];
  projectOrder: string[];
  threadCount: number;
  archivedThreadCount: number;
  source: 'local-files';
}

export interface RemoteExecutionSettings {
  model: string | null;
  reasoningEffort: string | null;
  permissionMode: RemoteExecutionPermissionMode | null;
}

export interface RemoteExecutionOption {
  value: string;
  label: string;
  description: string;
}

export interface RemoteExecutionSettingsState {
  overrides: RemoteExecutionSettings;
  effectiveModel: string | null;
  effectiveReasoningEffort: string | null;
  effectivePermissionMode: RemoteExecutionPermissionMode;
  effectivePermissionLabel: string;
  modelSelection: string;
  reasoningSelection: string;
  permissionSelection: string;
  modelOptions: RemoteExecutionOption[];
  reasoningOptions: RemoteExecutionOption[];
  permissionOptions: RemoteExecutionOption[];
}

export interface CodexProjectOption {
  id: string;
  name: string;
  cwd: string;
  threadCount: number;
  activeThreadCount: number;
  archivedThreadCount: number;
}

export interface CodexProjectThreadOption {
  id: string;
  title: string;
  updatedAt: string | null;
  archived: boolean;
  cwd: string | null;
}

export interface CodexThreadSummary {
  id: string;
  title: string;
  updatedAt: string | null;
  archived: boolean;
  cwd: string | null;
  path: string;
}

export interface CodexThreadMessage {
  timestamp: string | null;
  role: CodexThreadRole;
  text: string;
  sourceType: string;
  phase?: string | null;
  isHarnessGenerated?: boolean;
}

export interface CodexThreadRecord {
  id: string;
  title: string;
  updatedAt: string | null;
  archived: boolean;
  cwd: string | null;
  path: string;
  originator: string | null;
  cliVersion: string | null;
  messages: CodexThreadMessage[];
}

export interface CodexThreadListResult {
  threads: CodexThreadSummary[];
  source: 'local-files' | 'app-server';
}

export interface CodexAppServerProbe {
  available: boolean;
  initializeOk: boolean;
  listedThreadCount: number;
  resumedThreadId: string | null;
  readThreadId: string | null;
  error: string | null;
}

export type NormalizedEventSource =
  | 'telegram'
  | 'discord'
  | 'whatsapp'
  | 'internal-smoke';
export type PlatformKey = 'telegram' | 'discord' | 'whatsapp';
export type PlatformBindingType = 'project-surface' | 'thread-surface' | 'transport-only';
export type SyncSnapshotStatus = 'ok' | 'error';

export interface InstallIdentityRecord {
  installId: string;
  machineId: string;
  createdAt: string;
  updatedAt: string;
  source: 'local-companion-registry';
}

export interface NormalizedInboundEvent {
  id: string;
  source: NormalizedEventSource;
  receivedAt: string;
  text: string;
  externalThreadId: string | null;
  projectKey: string | null;
  projectThreadId?: string | null;
  threadId: string | null;
}

export interface RoutedConversationTask {
  routeKey: string | null;
  routedThreadId: string | null;
  prompt: string;
  source: NormalizedEventSource;
  projectKey: string | null;
  externalThreadId: string | null;
}

export interface CompanionDispatchTask {
  taskId: string;
  installId: string;
  machineId: string;
  eventId: string;
  createdAt: string;
  routeKey: string | null;
  routedThreadId: string | null;
  prompt: string;
  source: NormalizedEventSource;
  projectKey: string | null;
}

export interface RuntimeTaskDispatchResult {
  accepted: boolean;
  taskId: string;
  receivedAt: string;
}

export interface ControlPlaneDispatchReceipt {
  accepted: boolean;
  taskId: string;
  installId: string;
  machineId: string;
  routedThreadId: string | null;
  routeKey: string | null;
  receivedAt: string;
}

export interface SyncDispatchRecord {
  eventId: string;
  taskId: string;
  routeKey: string | null;
  routedThreadId: string | null;
  source: NormalizedEventSource;
  syncedAt: string;
}

export interface BackendUserRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface BackendLocalMachineRecord {
  id: string;
  userId: string;
  installId: string;
  machineId: string;
  createdAt: string;
  updatedAt: string;
}

export interface BackendProjectRecord {
  id: string;
  userId: string;
  platform: PlatformKey;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface BackendProjectThreadRecord {
  id: string;
  projectId: string;
  title: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BackendPlatformBindingRecord {
  id: string;
  platform: PlatformKey;
  bindingType: PlatformBindingType;
  projectId: string | null;
  projectThreadId: string | null;
  surfaceId: string;
  surfaceLabel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackendCodexThreadBindingRecord {
  id: string;
  projectThreadId: string;
  machineId: string;
  codexThreadId: string;
  createdAt: string;
  updatedAt: string;
}

export interface BackendActiveThreadStateRecord {
  id: string;
  platformBindingId: string;
  projectId: string | null;
  projectThreadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackendSyncSnapshotRecord {
  id: string;
  machineId: string;
  status: SyncSnapshotStatus;
  observedAt: string;
  details: string | null;
}

export interface PersistentBackendRegistryState {
  version: 1;
  source: 'persistent-backend-registry';
  updatedAt: string;
  users: BackendUserRecord[];
  localMachines: BackendLocalMachineRecord[];
  projects: BackendProjectRecord[];
  projectThreads: BackendProjectThreadRecord[];
  platformBindings: BackendPlatformBindingRecord[];
  codexThreadBindings: BackendCodexThreadBindingRecord[];
  activeThreadStates: BackendActiveThreadStateRecord[];
  syncSnapshots: BackendSyncSnapshotRecord[];
}

export interface BackendRegistrySummary {
  registryPath: string;
  userCount: number;
  localMachineCount: number;
  projectCount: number;
  projectThreadCount: number;
  platformBindingCount: number;
  codexThreadBindingCount: number;
  activeThreadStateCount: number;
  syncSnapshotCount: number;
}

export interface ControlPlaneStatus {
  installIdentity: InstallIdentityRecord | null;
  lastDispatch: SyncDispatchRecord | null;
  runtimeTaskId: string | null;
  backendRegistry: BackendRegistrySummary | null;
}

export type ProductSetupStep = 'detect_codex' | 'start_server' | 'ready';
export type FailureSeverity = 'none' | 'warning' | 'critical';
export type RepairActionKey = 'detect_codex' | 'start_server' | 'run_sync' | 'repair_bootstrap';

export interface ProductInstallationState {
  initialized: boolean;
  installIdentity: InstallIdentityRecord | null;
  nextStep: ProductSetupStep;
  setupReady: boolean;
}

export interface ProductMachineState {
  localMachine: BackendLocalMachineRecord | null;
  codexStatus: StatusBadgeState;
  serverStatus: StatusBadgeState;
  serverPort: number | null;
  runtimeReady: boolean;
  codexAvailable: boolean;
}

export interface ProductSyncStatus {
  available: boolean;
  lastSync: BackendSyncSnapshotRecord | null;
  sourceThreadCount: number;
  archivedThreadCount: number;
  summaryText: string;
}

export interface ChannelConnectionRecord {
  key: MessengerKey;
  label: string;
  status: StatusBadgeState;
  configured: boolean;
  detail: string;
}

export interface FailureIssue {
  code: string;
  severity: Exclude<FailureSeverity, 'none'>;
  message: string;
  repairAction: RepairActionKey;
}

export interface FailureSummary {
  highestSeverity: FailureSeverity;
  issues: FailureIssue[];
}

export interface ProductHealthSummary {
  installation: ProductInstallationState;
  machine: ProductMachineState;
  sync: ProductSyncStatus;
  channels: ChannelConnectionRecord[];
  failures: FailureSummary;
}

export interface TriggerSyncResult {
  ok: boolean;
  syncStatus: ProductSyncStatus;
}

export interface CreateProjectInput {
  platform: PlatformKey;
  name: string;
}

export interface CreateProjectThreadInput {
  projectId: string;
  title: string;
}

export interface CreatePlatformBindingInput {
  platform: PlatformKey;
  bindingType: PlatformBindingType;
  projectId: string | null;
  projectThreadId: string | null;
  surfaceId: string;
  surfaceLabel: string | null;
}

export interface CreateCodexThreadBindingInput {
  projectThreadId: string;
  machineId: string;
  codexThreadId: string;
}

export interface UpsertActiveThreadStateInput {
  platformBindingId: string;
  projectId: string | null;
  projectThreadId: string | null;
}

export interface RepairResult {
  ok: boolean;
  installation: ProductInstallationState;
  machine: ProductMachineState;
}

export interface EnsureCodexProjectResult {
  project: BackendProjectRecord;
  threadCount: number;
}

export interface TelegramProjectSyncRow {
  id: string;
  forumGroupId: string;
  forumGroupTitle: string;
  projectId: string;
  setupCompletedAt: string | null;
  lastIssue: string | null;
}

export interface TelegramSyncSummary {
  syncedAt: string;
  statusText: string;
  threadsFound: number;
  created: number;
  updated: number;
  alreadyLinked: number;
}

export interface TelegramConnectionState {
  status: StatusBadgeState;
  maskedBotToken: string | null;
  botUsername: string | null;
  ownerUserId: string | null;
  rows: TelegramProjectSyncRow[];
  lastSync: TelegramSyncSummary | null;
  issue: string | null;
}

export interface TelegramSetBotTokenResult {
  ok: boolean;
  connection: TelegramConnectionState;
}

export interface TelegramRemoveBotTokenResult {
  ok: boolean;
  connection: TelegramConnectionState;
}

export interface TelegramProjectSyncRowInput {
  rowId?: string;
  forumGroupId: string;
  forumGroupTitle: string;
  projectId: string;
}

export interface TelegramSyncResult {
  ok: boolean;
  summary: TelegramSyncSummary;
  connection: TelegramConnectionState;
}

export interface TelegramRepairSummary {
  repairedAt: string;
  statusText: string;
  oldTopicsRenamed: number;
  newTopicsCreated: number;
  mappingsUpdated: number;
}

export interface TelegramRepairResult {
  ok: boolean;
  summary: TelegramRepairSummary;
  connection: TelegramConnectionState;
}

export interface CodexDesktopApi {
  getBootstrapState: () => Promise<RuntimeBootstrapState>;
  startServer: () => Promise<RuntimeServerStartResult>;
  stopServer: () => Promise<RuntimeServerStartResult>;
  getCodexEnvironmentSnapshot: () => Promise<CodexEnvironmentSnapshot>;
  listCodexThreads: () => Promise<CodexThreadListResult>;
  readCodexThread: (threadId: string) => Promise<CodexThreadRecord>;
  getControlPlaneStatus: () => Promise<ControlPlaneStatus>;
  getInstallationState: () => Promise<ProductInstallationState>;
  getMachineState: () => Promise<ProductMachineState>;
  getSyncStatus: () => Promise<ProductSyncStatus>;
  triggerSync: () => Promise<TriggerSyncResult>;
  listCodexProjects: () => Promise<CodexProjectOption[]>;
  listCodexProjectThreads: (projectId: string) => Promise<CodexProjectThreadOption[]>;
  ensureCodexProject: (projectId: string) => Promise<EnsureCodexProjectResult>;
  listProjects: () => Promise<BackendProjectRecord[]>;
  createProject: (input: CreateProjectInput) => Promise<BackendProjectRecord>;
  listProjectThreads: (projectId: string) => Promise<BackendProjectThreadRecord[]>;
  createProjectThread: (input: CreateProjectThreadInput) => Promise<BackendProjectThreadRecord>;
  listChannelConnections: () => Promise<ChannelConnectionRecord[]>;
  listPlatformBindings: () => Promise<BackendPlatformBindingRecord[]>;
  createPlatformBinding: (
    input: CreatePlatformBindingInput
  ) => Promise<BackendPlatformBindingRecord>;
  listCodexThreadBindings: () => Promise<BackendCodexThreadBindingRecord[]>;
  createCodexThreadBinding: (
    input: CreateCodexThreadBindingInput
  ) => Promise<BackendCodexThreadBindingRecord>;
  listActiveThreadStates: () => Promise<BackendActiveThreadStateRecord[]>;
  upsertActiveThreadState: (
    input: UpsertActiveThreadStateInput
  ) => Promise<BackendActiveThreadStateRecord>;
  getFailureSummary: () => Promise<FailureSummary>;
  getHealthSummary: () => Promise<ProductHealthSummary>;
  repairBootstrap: () => Promise<RepairResult>;
  getTelegramConnectionState: () => Promise<TelegramConnectionState>;
  validateTelegramConnection: () => Promise<TelegramConnectionState>;
  checkTelegramEnvironment: (rowId: string) => Promise<TelegramConnectionState>;
  setTelegramBotToken: (token: string, ownerUserId: string) => Promise<TelegramSetBotTokenResult>;
  removeTelegramBotToken: () => Promise<TelegramRemoveBotTokenResult>;
  upsertTelegramProjectSyncRow: (
    input: TelegramProjectSyncRowInput
  ) => Promise<TelegramConnectionState>;
  removeTelegramProjectSyncRow: (rowId: string) => Promise<TelegramConnectionState>;
  setupTelegramEnvironment: (input: TelegramProjectSyncRowInput) => Promise<TelegramSyncResult>;
  repairTelegramEnvironment: (rowId: string) => Promise<TelegramRepairResult>;
  syncTelegram: () => Promise<TelegramSyncResult>;
  onRuntimeStateChanged: (
    listener: (state: RuntimeBootstrapState) => void
  ) => () => void;
}
