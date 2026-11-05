import { useEffect, useState } from 'react';

import type {
  BackendProjectRecord,
  BackendProjectThreadRecord,
  ChannelConnectionRecord,
  CodexEnvironmentSnapshot,
  CodexProjectOption,
  CodexProjectThreadOption,
  MessengerKey,
  RuntimeBootstrapState,
  StartupSettingsState,
  StatusBadgeState,
  TelegramConnectionState,
  TelegramTopicSyncRowStatus
} from '@shared/contracts';

import { SectionCard } from './components/SectionCard';
import { StatusPill } from './components/StatusPill';

const initialState: RuntimeBootstrapState = {
  codexStatus: { tone: 'yellow', text: 'Checking Codex' },
  codexAppStatus: { tone: 'yellow', text: 'Checking' },
  codexAppVersion: null,
  codexCliStatus: { tone: 'yellow', text: 'Checking' },
  codexCliVersion: null,
  serverStatus: { tone: 'red', text: 'Codex server turned off' },
  channels: [
    {
      key: 'telegram',
      label: 'Telegram',
      status: { tone: 'yellow', text: 'Checking' }
    }
  ],
  serverPort: null
};

const initialStartupSettings: StartupSettingsState = {
  launchAtLogin: false,
  loginItemStatus: null,
  autoStartServer: false
};

const initialSnapshot: CodexEnvironmentSnapshot = {
  model: null,
  reasoningEffort: null,
  personality: null,
  activeUserEmail: null,
  permissionMode: null,
  primaryRateLimitRemainingPercent: null,
  primaryRateLimitWindowMinutes: null,
  primaryRateLimitResetsAt: null,
  weeklyRateLimitRemainingPercent: null,
  weeklyRateLimitWindowMinutes: null,
  weeklyRateLimitResetsAt: null,
  savedWorkspaceRoots: [],
  activeWorkspaceRoots: [],
  projectOrder: [],
  threadCount: 0,
  archivedThreadCount: 0,
  source: 'local-files'
};

const initialTelegramConnection: TelegramConnectionState = {
  status: { tone: 'yellow', text: 'Loading saved state' },
  maskedBotToken: null,
  botUsername: null,
  ownerUserId: null,
  rows: [],
  lastSync: null,
  issue: null
};

type AppScreen = 'dashboard' | 'messaging-settings';
type ServerAction = 'starting' | 'stopping' | null;
type TelegramAction =
  | 'saving-token'
  | 'removing-token'
  | 'setting-up'
  | 'checking-health'
  | 'repairing'
  | 'removing-row'
  | null;

interface ProjectSelectOption {
  id: string;
  name: string;
  detail: string;
  source: 'local-codex' | 'saved-binding';
  cwd: string | null;
}

interface TelegramDraftRow {
  localId: string;
  rowId?: string;
  forumGroupId: string;
  forumGroupTitle: string;
  projectId: string;
  setupCompletedAt: string | null;
  lastIssue: string | null;
  preserveOnRefresh?: boolean;
}

interface TelegramRowHealthFeedback {
  tone: StatusBadgeState['tone'];
  text: string;
}

interface CodexDetectionItem {
  label: string;
  version: string | null;
}

interface CodexDetectionSummary {
  status: StatusBadgeState;
  items: CodexDetectionItem[];
  fallbackText: string | null;
}

const SNAPSHOT_REFRESH_INTERVAL_MS = 30000;
const VISIBLE_MESSENGER_KEYS: MessengerKey[] = ['telegram'];

export function getServerUiStatus(
  serverStatus: StatusBadgeState,
  serverAction: ServerAction
): StatusBadgeState {
  if (serverAction === 'starting') {
    return { tone: 'yellow', text: 'Codex server turning on' };
  }

  if (serverAction === 'stopping') {
    return { tone: 'yellow', text: 'Codex server turning off' };
  }

  return serverStatus;
}

export function getServerSupportText(
  serverStatus: StatusBadgeState,
  serverAction: ServerAction,
  serverPort: number | null
): string {
  if (serverAction === 'starting') {
    return 'Starting the local runtime and channel workers...';
  }

  if (serverAction === 'stopping') {
    return 'Stopping the local runtime and disconnecting channel workers...';
  }

  if (serverStatus.tone === 'green' && serverPort) {
    return `Local server port: ${serverPort}`;
  }

  return 'Start the local server to enable channel runtimes.';
}

export function getChannelStatusForServerState(
  channelStatus: StatusBadgeState,
  serverStatus: StatusBadgeState
): StatusBadgeState {
  if (serverStatus.tone !== 'green' && channelStatus.tone === 'green') {
    return {
      tone: 'yellow',
      text: 'Awaiting server start'
    };
  }

  return channelStatus;
}

function isVisibleMessengerKey(key: MessengerKey): boolean {
  return VISIBLE_MESSENGER_KEYS.includes(key);
}

function isStatusBadgeState(status: unknown): status is StatusBadgeState {
  return (
    typeof status === 'object' &&
    status !== null &&
    'tone' in status &&
    'text' in status
  );
}

function deriveCodexAppStatus(codexStatus: StatusBadgeState): StatusBadgeState {
  return {
    tone: codexStatus.text.includes('App') ? 'green' : 'red',
    text: codexStatus.text.includes('App') ? 'Detected' : 'Not detected'
  };
}

function deriveCodexCliStatus(codexStatus: StatusBadgeState): StatusBadgeState {
  return {
    tone: codexStatus.text.includes('CLI') ? 'green' : 'red',
    text: codexStatus.text.includes('CLI') ? 'Detected' : 'Not detected'
  };
}

function normalizeBootstrapState(nextState: RuntimeBootstrapState): RuntimeBootstrapState {
  const codexStatus = isStatusBadgeState(nextState.codexStatus)
    ? nextState.codexStatus
    : initialState.codexStatus;

  return {
    codexStatus,
    codexAppStatus: isStatusBadgeState(nextState.codexAppStatus)
      ? nextState.codexAppStatus
      : deriveCodexAppStatus(codexStatus),
    codexAppVersion:
      typeof nextState.codexAppVersion === 'string' ? nextState.codexAppVersion : null,
    codexCliStatus: isStatusBadgeState(nextState.codexCliStatus)
      ? nextState.codexCliStatus
      : deriveCodexCliStatus(codexStatus),
    codexCliVersion:
      typeof nextState.codexCliVersion === 'string' ? nextState.codexCliVersion : null,
    serverStatus: isStatusBadgeState(nextState.serverStatus)
      ? nextState.serverStatus
      : initialState.serverStatus,
    channels: Array.isArray(nextState.channels) ? nextState.channels : initialState.channels,
    serverPort: typeof nextState.serverPort === 'number' ? nextState.serverPort : null
  };
}

function createTelegramDraftRow(defaultProjectId = '', preserveOnRefresh = false): TelegramDraftRow {
  return {
    localId: `telegram-draft:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    forumGroupId: '',
    forumGroupTitle: '',
    projectId: defaultProjectId,
    setupCompletedAt: null,
    lastIssue: null,
    preserveOnRefresh
  };
}

export function buildTelegramDraftRows(
  connection: TelegramConnectionState,
  currentRows: TelegramDraftRow[] = []
): TelegramDraftRow[] {
  const savedRows = connection.rows.map((row) => ({
    localId: row.id,
    rowId: row.id,
    forumGroupId: row.forumGroupId,
    forumGroupTitle: row.forumGroupTitle,
    projectId: row.projectId,
    setupCompletedAt: row.setupCompletedAt,
    lastIssue: row.lastIssue
  }));

  const savedBindingKeys = new Set(
    savedRows.map((row) => `${row.forumGroupId.trim()}::${row.projectId.trim()}`)
  );
  const preservedDraftRows = currentRows.filter((row) => {
    if (row.rowId) {
      return false;
    }

    const hasInput =
      row.forumGroupId.trim().length > 0 ||
      row.forumGroupTitle.trim().length > 0 ||
      row.projectId.trim().length > 0;
    const bindingKey = `${row.forumGroupId.trim()}::${row.projectId.trim()}`;

    if (savedBindingKeys.has(bindingKey) && bindingKey !== '::') {
      return false;
    }

    return row.preserveOnRefresh || hasInput;
  });

  if (savedRows.length === 0 && preservedDraftRows.length === 0) {
    return [createTelegramDraftRow()];
  }

  return [...preservedDraftRows, ...savedRows];
}

function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Unexpected error.';
  }

  return error.message
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(/^Error invoking remote method '[^']+': /, '');
}

function buildProjectSelectOptions(
  codexProjects: CodexProjectOption[],
  backendProjects: BackendProjectRecord[],
  selectedProjectIds: string[]
): ProjectSelectOption[] {
  const options: ProjectSelectOption[] = codexProjects.map((project) => ({
    id: project.id,
    name: project.name,
    detail: `${project.activeThreadCount} active threads`,
    source: 'local-codex',
    cwd: project.cwd
  }));
  const optionIds = new Set(options.map((option) => option.id));

  for (const backendProject of backendProjects) {
    if (optionIds.has(backendProject.id) || !selectedProjectIds.includes(backendProject.id)) {
      continue;
    }

    options.push({
      id: backendProject.id,
      name: backendProject.name,
      detail: 'Saved binding',
      source: 'saved-binding',
      cwd: null
    });
  }

  return options;
}

function getProjectOptionName(options: ProjectSelectOption[], projectId: string): string {
  return options.find((project) => project.id === projectId)?.name ?? projectId;
}

function getProjectOptionLabel(
  option: ProjectSelectOption,
  options: ProjectSelectOption[]
): string {
  const duplicateCount = options.filter((candidate) => candidate.name === option.name).length;
  if (duplicateCount <= 1 || !option.cwd) {
    return option.name;
  }

  const cwdParts = option.cwd.split('/').filter(Boolean);
  const pathTail = cwdParts.slice(-2).join('/');
  return pathTail ? `${option.name} — ${pathTail}` : option.name;
}

function isLocalCodexProject(projectOptions: ProjectSelectOption[], projectId: string): boolean {
  return projectOptions.some((project) => project.id === projectId && project.source === 'local-codex');
}

function getRowProjectOptions(
  options: ProjectSelectOption[],
  projectId: string,
  rowLocked: boolean
): ProjectSelectOption[] {
  const localOptions = options.filter((project) => project.source === 'local-codex');
  if (!rowLocked) {
    return localOptions;
  }

  const selectedOption = options.find((project) => project.id === projectId);
  if (!selectedOption || selectedOption.source === 'local-codex') {
    return localOptions;
  }

  return [...localOptions, selectedOption];
}

export function getServerButtonText(
  serverStatus: StatusBadgeState,
  serverAction: ServerAction
): string {
  if (serverAction === 'starting') {
    return 'Starting...';
  }

  if (serverAction === 'stopping') {
    return 'Stopping...';
  }

  return serverStatus.tone === 'green' ? 'Stop server' : 'Start server';
}

function formatRateLimitValue(remainingPercent: number | null): string {
  return remainingPercent === null ? 'Not found' : `${Math.round(remainingPercent)}%`;
}

function formatRateLimitWindow(windowMinutes: number | null): string {
  if (windowMinutes === null) {
    return 'Rate limit';
  }

  if (windowMinutes === 10080) {
    return 'Weekly remaining';
  }

  if (windowMinutes % 60 === 0 && windowMinutes < 1440) {
    return `${windowMinutes / 60}h remaining`;
  }

  return `${windowMinutes}m remaining`;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatRateLimitCountdown(resetsAt: string | null, now = new Date()): string | null {
  if (!resetsAt) {
    return null;
  }

  const resetDate = new Date(resetsAt);
  if (Number.isNaN(resetDate.getTime())) {
    return null;
  }

  const diffMs = Math.max(0, resetDate.getTime() - now.getTime());
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `Resets in ${days}d ${hours}h` : `Resets in ${days}d`;
  }

  if (hours > 0) {
    return minutes > 0 ? `Resets in ${hours}h ${minutes}m` : `Resets in ${hours}h`;
  }

  if (minutes > 0) {
    return `Resets in ${minutes}m`;
  }

  return 'Resets soon';
}

interface RateLimitCardModel {
  label: string;
  remainingText: string;
  remainingDetail: string;
  resetsText: string;
  reserveText: string | null;
  paceText: string | null;
  fillPercent: number | null;
  reserveThresholdPercent: number | null;
}

export function buildRateLimitCardModel(
  windowMinutes: number | null,
  remainingPercent: number | null,
  resetsAt: string | null,
  now = new Date()
): RateLimitCardModel {
  const label = formatRateLimitWindow(windowMinutes);
  const remainingText = formatRateLimitValue(remainingPercent);
  const remainingDetail =
    remainingPercent === null
      ? 'Latest local rate limit not found'
      : `${Math.round(remainingPercent)}% left`;
  const resetsText = formatRateLimitCountdown(resetsAt, now) ?? 'Reset time unavailable';
  const isWeeklyWindow = windowMinutes === 10080;

  if (
    remainingPercent === null ||
    windowMinutes === null ||
    windowMinutes <= 0 ||
    !resetsAt
  ) {
    return {
      label,
      remainingText,
      remainingDetail,
      resetsText,
      reserveText: null,
      paceText: null,
      fillPercent: remainingPercent === null ? null : clampPercent(remainingPercent),
      reserveThresholdPercent: null
    };
  }

  const resetDate = new Date(resetsAt);
  if (Number.isNaN(resetDate.getTime())) {
    return {
      label,
      remainingText,
      remainingDetail,
      resetsText,
      reserveText: null,
      paceText: null,
      fillPercent: clampPercent(remainingPercent),
      reserveThresholdPercent: null
    };
  }

  const windowMs = windowMinutes * 60 * 1000;
  const remainingWindowMs = Math.max(0, resetDate.getTime() - now.getTime());
  const thresholdPercent = clampPercent((remainingWindowMs / windowMs) * 100);
  const reserveDelta = Math.round(remainingPercent - thresholdPercent);
  const reserveText = !isWeeklyWindow
    ? null
    : reserveDelta > 0
      ? `${reserveDelta}% in reserve`
      : reserveDelta < 0
        ? `${Math.abs(reserveDelta)}% over pace`
        : 'On pace';
  const paceText = !isWeeklyWindow ? null : reserveDelta >= 0 ? 'Lasts until reset' : 'May run out early';

  return {
    label,
    remainingText,
    remainingDetail,
    resetsText,
    reserveText,
    paceText,
    fillPercent: clampPercent(remainingPercent),
    reserveThresholdPercent: isWeeklyWindow ? thresholdPercent : null
  };
}

function RateLimitCard({
  model,
  accent
}: {
  model: RateLimitCardModel;
  accent: 'session' | 'weekly';
}) {
  return (
    <div className={`rate-limit-row rate-limit-row--${accent}`}>
      <div className="rate-limit-row__header">
        <span className="rate-limit-row__label">{model.label}</span>
        <strong>{model.remainingText}</strong>
      </div>
      <div className="rate-limit-row__track">
        <div
          className="rate-limit-row__fill"
          style={{ width: `${model.fillPercent ?? 0}%` }}
        />
        {model.reserveThresholdPercent !== null ? (
          <span
            className="rate-limit-row__marker"
            style={{ left: `${model.reserveThresholdPercent}%` }}
          />
        ) : null}
      </div>
      <div className="rate-limit-row__summary">
        <span>{model.remainingDetail}</span>
        <span>{model.resetsText}</span>
      </div>
      {model.reserveText || model.paceText ? (
        <div className="rate-limit-row__meta">
          <span>{model.reserveText}</span>
          <span>{model.paceText}</span>
        </div>
      ) : null}
    </div>
  );
}

export function getTelegramTokenButtonLabel(maskedBotToken: string | null): string {
  return maskedBotToken ? 'Replace token' : 'Save token';
}

export function getActiveThreadsButtonModel(input: {
  projectId: string;
  threadsLoading: boolean;
  activeThreadsExpanded: boolean;
  rowActionInProgress: boolean;
}): { text: string; disabled: boolean; showChevron: boolean } {
  if (!input.projectId) {
    return {
      text: 'Project not chosen',
      disabled: true,
      showChevron: false
    };
  }

  if (input.threadsLoading) {
    return {
      text: 'Loading Active Threads...',
      disabled: true,
      showChevron: false
    };
  }

  return {
    text: input.activeThreadsExpanded ? 'Hide Active threads' : 'Show Active threads',
    disabled: input.rowActionInProgress,
    showChevron: true
  };
}

function renderWaveLabel(label: string, isLoading: boolean) {
  return isLoading ? (
    <span className="wave-text" data-text={label}>
      {label}
    </span>
  ) : (
    label
  );
}

export function getTelegramRowStatus(
  row: TelegramDraftRow,
  connection: TelegramConnectionState,
  error: string | null,
  isLoaded: boolean
): StatusBadgeState {
  if (!isLoaded) {
    return { tone: 'yellow', text: 'Loading' };
  }

  if (row.lastIssue || connection.issue) {
    return { tone: 'yellow', text: 'Needs attention' };
  }

  if (!connection.maskedBotToken && row.rowId && row.setupCompletedAt) {
    return { tone: 'yellow', text: 'Needs token' };
  }

  if (row.rowId && row.setupCompletedAt) {
    return { tone: 'green', text: 'Active' };
  }

  return { tone: 'yellow', text: 'Setup required' };
}

export function getTelegramRowHealthStatus(
  row: TelegramDraftRow,
  connection: TelegramConnectionState
): StatusBadgeState | null {
  if (!isTelegramRowLocked(row)) {
    return null;
  }

  if (!connection.maskedBotToken) {
    return { tone: 'red', text: 'Unhealthy' };
  }

  return row.lastIssue
    ? { tone: 'red', text: 'Unhealthy' }
    : { tone: 'green', text: 'Healthy' };
}

export function isTelegramRowLocked(row: TelegramDraftRow): boolean {
  return Boolean(row.rowId && row.setupCompletedAt);
}

function normalizeCodexVersion(version: string | null): string | null {
  if (typeof version !== 'string') {
    return null;
  }

  const trimmed = version.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isCodexRuntimeDetected(status: StatusBadgeState, version: string | null): boolean {
  return status.tone === 'green' || Boolean(version);
}

export function buildCodexDetectionSummary(
  state: Pick<
    RuntimeBootstrapState,
    'codexAppStatus' | 'codexAppVersion' | 'codexCliStatus' | 'codexCliVersion'
  >
): CodexDetectionSummary {
  const items: CodexDetectionItem[] = [];
  const codexAppVersion = normalizeCodexVersion(state.codexAppVersion);
  const codexCliVersion = normalizeCodexVersion(state.codexCliVersion);

  if (isCodexRuntimeDetected(state.codexAppStatus, codexAppVersion)) {
    items.push({ label: 'Codex App', version: codexAppVersion });
  }

  if (isCodexRuntimeDetected(state.codexCliStatus, codexCliVersion)) {
    items.push({ label: 'Codex CLI', version: codexCliVersion });
  }

  if (items.length > 0) {
    return {
      status: { tone: 'green', text: 'Detected' },
      items,
      fallbackText: null
    };
  }

  return {
    status: { tone: 'red', text: 'Not detected' },
    items,
    fallbackText: 'Codex App and Codex CLI undetected'
  };
}

function CodexReadinessLabel({ label, version }: { label: string; version: string | null }) {
  return (
    <span className="codex-readiness-label">
      <span className="channel-row__label">{label}</span>
      {version ? <span className="codex-readiness-label__version">{version}</span> : null}
    </span>
  );
}

export default function App() {
  const [screen, setScreen] = useState<AppScreen>('dashboard');
  const [bootReady, setBootReady] = useState(false);
  const [state, setState] = useState<RuntimeBootstrapState>(initialState);
  const [snapshot, setSnapshot] = useState<CodexEnvironmentSnapshot>(initialSnapshot);
  const [channelConnections, setChannelConnections] = useState<ChannelConnectionRecord[]>([]);
  const [projects, setProjects] = useState<BackendProjectRecord[]>([]);
  const [codexProjects, setCodexProjects] = useState<CodexProjectOption[]>([]);
  const [projectThreadCache, setProjectThreadCache] = useState<
    Record<string, Array<CodexProjectThreadOption | BackendProjectThreadRecord>>
  >({});
  const [projectThreadLoadingIds, setProjectThreadLoadingIds] = useState<string[]>([]);
  const [expandedThreadProjectIds, setExpandedThreadProjectIds] = useState<string[]>([]);
  const [telegramConnection, setTelegramConnection] = useState<TelegramConnectionState>(
    initialTelegramConnection
  );
  const [telegramSurfaceLoaded, setTelegramSurfaceLoaded] = useState(false);
  const [telegramDraftRows, setTelegramDraftRows] = useState<TelegramDraftRow[]>([
    createTelegramDraftRow()
  ]);
  const [telegramTokenInput, setTelegramTokenInput] = useState('');
  const [telegramOwnerIdInput, setTelegramOwnerIdInput] = useState('');
  const [telegramAction, setTelegramAction] = useState<TelegramAction>(null);
  const [telegramActionTargetLocalId, setTelegramActionTargetLocalId] = useState<string | null>(
    null
  );
  const [telegramError, setTelegramError] = useState<string | null>(null);
  const [topicSyncRows, setTopicSyncRows] = useState<TelegramTopicSyncRowStatus[]>([]);
  const [topicAttachIds, setTopicAttachIds] = useState<Record<string, string>>({});
  const [topicActionKey, setTopicActionKey] = useState<string | null>(null);
  const [telegramRowHealthFeedback, setTelegramRowHealthFeedback] = useState<
    Record<string, TelegramRowHealthFeedback>
  >({});
  const [pendingTelegramTokenReplacement, setPendingTelegramTokenReplacement] = useState<
    string | null
  >(null);
  const [pendingTelegramTokenRemoval, setPendingTelegramTokenRemoval] = useState(false);
  const [repairCandidateRow, setRepairCandidateRow] = useState<TelegramDraftRow | null>(null);
  const [removeCandidateRow, setRemoveCandidateRow] = useState<TelegramDraftRow | null>(null);
  const [serverAction, setServerAction] = useState<ServerAction>(null);
  const [startupSettings, setStartupSettings] = useState<StartupSettingsState>(initialStartupSettings);
  const [startupLoaded, setStartupLoaded] = useState(false);
  const [startupAction, setStartupAction] = useState<'login' | 'server' | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const displayedServerStatus = getServerUiStatus(state.serverStatus, serverAction);
  const displayedChannels = channelConnections.length > 0
    ? channelConnections.filter((connection) => isVisibleMessengerKey(connection.key)).map((connection) => ({
        key: connection.key,
        label: connection.label,
        status: getChannelStatusForServerState(connection.status, displayedServerStatus)
      }))
    : state.channels.filter((channel) => isVisibleMessengerKey(channel.key)).map((channel) => ({
        ...channel,
        status: getChannelStatusForServerState(channel.status, displayedServerStatus)
      }));
  const projectOptions = buildProjectSelectOptions(
    codexProjects,
    projects,
    telegramDraftRows.map((row) => row.projectId)
  );

  function applyTelegramSurfaceState(input: {
    connection: TelegramConnectionState;
    codexProjectOptions: CodexProjectOption[];
    backendProjects: BackendProjectRecord[];
    channelState: ChannelConnectionRecord[];
  }) {
    setTelegramConnection(input.connection);
    setTelegramSurfaceLoaded(true);
    setCodexProjects(input.codexProjectOptions);
    setProjects(input.backendProjects);
    setChannelConnections(input.channelState);
    setTelegramDraftRows(
      (currentRows) => buildTelegramDraftRows(input.connection, currentRows)
    );
  }

  useEffect(() => {
    if (!window.codexDesktop) {
      setBootError('Renderer bridge is unavailable. Restart Codex Remote Companion.');
      return;
    }

    void window.codexDesktop.getStartupSettings()
      .then(setStartupSettings)
      .catch((error) => setStartupError(error instanceof Error ? error.message : String(error)))
      .finally(() => setStartupLoaded(true));

    void (async () => {
      try {
        const [
          nextState,
          nextSnapshot,
          nextCodexProjects,
          nextProjects,
          nextTelegramConnection
        ] = await Promise.all([
          window.codexDesktop.getBootstrapState(),
          window.codexDesktop.getCodexEnvironmentSnapshot(),
          window.codexDesktop.listCodexProjects(),
          window.codexDesktop.listProjects(),
          window.codexDesktop.validateTelegramConnection()
        ]);
        const nextChannelConnections = await window.codexDesktop.listChannelConnections();

        setState(normalizeBootstrapState(nextState));
        setSnapshot(nextSnapshot);
        applyTelegramSurfaceState({
          connection: nextTelegramConnection,
          codexProjectOptions: nextCodexProjects,
          backendProjects: nextProjects,
          channelState: nextChannelConnections
        });
        setBootReady(true);
      } catch (error) {
        setBootError(
          error instanceof Error
            ? error.message
            : 'Failed to load Codex Remote Companion bootstrap state.'
        );
        setBootReady(true);
      }
    })();

    return window.codexDesktop.onRuntimeStateChanged((nextState) => {
      setState(normalizeBootstrapState(nextState));
      void refreshChannelConnections();
    });
  }, []);

  useEffect(() => {
    if (!window.codexDesktop) {
      return;
    }

    const projectIdsToLoad = [...new Set(
      telegramDraftRows
        .map((row) => row.projectId)
        .filter(
          (projectId) =>
            projectId.length > 0 &&
            !projectThreadCache[projectId] &&
            !projectThreadLoadingIds.includes(projectId)
        )
    )];

    for (const projectId of projectIdsToLoad) {
      setProjectThreadLoadingIds((projectIds) =>
        projectIds.includes(projectId) ? projectIds : [...projectIds, projectId]
      );

      void (async () => {
        try {
          const threads = isLocalCodexProject(projectOptions, projectId)
            ? await window.codexDesktop.listCodexProjectThreads(projectId)
            : await window.codexDesktop.listProjectThreads(projectId);
          setProjectThreadCache((cache) => ({
            ...cache,
            [projectId]: threads
          }));
        } catch (error) {
          setTelegramError(getErrorMessage(error));
        } finally {
          setProjectThreadLoadingIds((projectIds) =>
            projectIds.filter((candidateId) => candidateId !== projectId)
          );
        }
      })();
    }
  }, [telegramDraftRows, projectThreadCache, projectThreadLoadingIds, projectOptions]);

  useEffect(() => {
    if (screen !== 'messaging-settings' || !window.codexDesktop) return;
    let active = true;
    const refresh = () => {
      void window.codexDesktop.getTelegramTopicSyncStatus()
        .then((rows) => { if (active) setTopicSyncRows(rows); })
        .catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [screen]);

  async function handleTopicRetry(rowId: string, threadId: string) {
    const key = `${rowId}:${threadId}`;
    setTopicActionKey(key);
    setTelegramError(null);
    try {
      await window.codexDesktop.retryTelegramTopic(rowId, threadId);
      setTopicSyncRows(await window.codexDesktop.getTelegramTopicSyncStatus());
    } catch (error) {
      setTelegramError(getErrorMessage(error));
    } finally {
      setTopicActionKey(null);
    }
  }

  async function handleTopicAttach(rowId: string, threadId: string) {
    const key = `${rowId}:${threadId}`;
    const topicId = Number(topicAttachIds[key]);
    if (!Number.isSafeInteger(topicId) || topicId <= 0) {
      setTelegramError('Enter a valid Telegram topic ID.');
      return;
    }
    setTopicActionKey(key);
    setTelegramError(null);
    try {
      await window.codexDesktop.attachTelegramTopic(rowId, threadId, topicId);
      setTopicSyncRows(await window.codexDesktop.getTelegramTopicSyncStatus());
    } catch (error) {
      setTelegramError(getErrorMessage(error));
    } finally {
      setTopicActionKey(null);
    }
  }

  useEffect(() => {
    if (!bootReady || !window.codexDesktop || screen !== 'dashboard') {
      return;
    }

    let disposed = false;
    let refreshInFlight = false;

    const runRefresh = async () => {
      if (disposed || refreshInFlight) {
        return;
      }

      refreshInFlight = true;
      try {
        await refreshSnapshotSurface();
      } catch {
        // Keep the last known snapshot if auto-refresh fails.
      } finally {
        refreshInFlight = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void runRefresh();
    }, SNAPSHOT_REFRESH_INTERVAL_MS);
    const handleFocus = () => {
      void runRefresh();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void runRefresh();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [bootReady, screen]);

  async function refreshChannelConnections() {
    await window.codexDesktop
      .listChannelConnections()
      .then(setChannelConnections)
      .catch(() => {
        // Keep the last known channel state if channel refresh fails.
      });
  }

  async function refreshSnapshotSurface() {
    const nextSnapshot = await window.codexDesktop.getCodexEnvironmentSnapshot();
    setSnapshot(nextSnapshot);
  }

  async function refreshTelegramSurface() {
    const [
      nextTelegramConnection,
      nextCodexProjects,
      nextProjects,
      nextChannelConnections
    ] = await Promise.all([
      window.codexDesktop.getTelegramConnectionState(),
      window.codexDesktop.listCodexProjects(),
      window.codexDesktop.listProjects(),
      window.codexDesktop.listChannelConnections()
    ]);

    applyTelegramSurfaceState({
      connection: nextTelegramConnection,
      codexProjectOptions: nextCodexProjects,
      backendProjects: nextProjects,
      channelState: nextChannelConnections
    });
  }

  async function validateTelegramSurface() {
    const [
      nextTelegramConnection,
      nextCodexProjects,
      nextProjects,
      nextChannelConnections
    ] = await Promise.all([
      window.codexDesktop.validateTelegramConnection(),
      window.codexDesktop.listCodexProjects(),
      window.codexDesktop.listProjects(),
      window.codexDesktop.listChannelConnections()
    ]);

    applyTelegramSurfaceState({
      connection: nextTelegramConnection,
      codexProjectOptions: nextCodexProjects,
      backendProjects: nextProjects,
      channelState: nextChannelConnections
    });
  }

  async function handleStartServer() {
    setServerAction('starting');
    try {
      const result = await window.codexDesktop.startServer();
      setState(normalizeBootstrapState(result.state));
      await refreshChannelConnections();
    } finally {
      setServerAction(null);
    }
  }

  async function handleStopServer() {
    setServerAction('stopping');
    try {
      const result = await window.codexDesktop.stopServer();
      setState(normalizeBootstrapState(result.state));
      await refreshChannelConnections();
    } finally {
      setServerAction(null);
    }
  }

  async function handleStartupToggle(kind: 'login' | 'server', enabled: boolean) {
    setStartupAction(kind);
    setStartupError(null);
    try {
      const next = kind === 'login'
        ? await window.codexDesktop.setLaunchAtLogin(enabled)
        : await window.codexDesktop.setAutoStartServer(enabled);
      setStartupSettings(next);
      if (kind === 'login' && enabled && next.loginItemStatus === 'requires-approval') {
        setStartupError('Allow Codex Remote Companion in macOS System Settings → Login Items.');
      }
    } catch (error) {
      setStartupError(error instanceof Error ? error.message : String(error));
    } finally {
      setStartupAction(null);
    }
  }

  async function handleOpenMessagingSettings() {
    setScreen('messaging-settings');
    setTelegramError(null);
  }

  function shouldConfirmTelegramTokenReplacement(token: string): boolean {
    return Boolean(telegramConnection.maskedBotToken && token);
  }

  async function persistTelegramToken(token: string) {
    setTelegramAction('saving-token');
    setTelegramActionTargetLocalId(null);
    setTelegramError(null);
    try {
      const result = await window.codexDesktop.setTelegramBotToken(
        token,
        telegramOwnerIdInput.trim() || telegramConnection.ownerUserId || ''
      );
      setTelegramConnection(result.connection);
      setTelegramDraftRows((currentRows) => buildTelegramDraftRows(result.connection, currentRows));
      setTelegramTokenInput('');
      setPendingTelegramTokenReplacement(null);
      await refreshChannelConnections();
      return result.connection;
    } catch (error) {
      setTelegramError(getErrorMessage(error));
      setPendingTelegramTokenReplacement(null);
      return null;
    } finally {
      setTelegramAction(null);
      setTelegramActionTargetLocalId(null);
    }
  }

  async function handleSaveTelegramToken() {
    const token = telegramTokenInput.trim();
    if (!token || !/^[1-9][0-9]*$/.test(telegramOwnerIdInput.trim() || telegramConnection.ownerUserId || '')) {
      setTelegramError('Enter a bot token and your positive numeric Telegram user ID.');
      return null;
    }

    if (shouldConfirmTelegramTokenReplacement(token)) {
      setPendingTelegramTokenReplacement(token);
      setTelegramError(null);
      return null;
    }

    return persistTelegramToken(token);
  }

  async function handleRemoveTelegramToken() {
    setTelegramAction('removing-token');
    setTelegramActionTargetLocalId(null);
    setTelegramError(null);
    try {
      const result = await window.codexDesktop.removeTelegramBotToken();
      setTelegramConnection(result.connection);
      setTelegramDraftRows((currentRows) => buildTelegramDraftRows(result.connection, currentRows));
      setTelegramRowHealthFeedback({});
      setTelegramTokenInput('');
      setPendingTelegramTokenRemoval(false);
      await refreshChannelConnections();
      return result.connection;
    } catch (error) {
      setTelegramError(getErrorMessage(error));
      return null;
    } finally {
      setTelegramAction(null);
      setTelegramActionTargetLocalId(null);
    }
  }

  function updateTelegramDraftRow(
    localId: string,
    field: keyof Omit<TelegramDraftRow, 'localId' | 'rowId' | 'setupCompletedAt' | 'lastIssue'>,
    value: string
  ) {
    setTelegramDraftRows((rows) =>
      rows.map((row) => (row.localId === localId ? { ...row, [field]: value } : row))
    );
  }

  function handleAddTelegramRow() {
    setTelegramDraftRows((rows) => [createTelegramDraftRow('', true), ...rows]);
  }

  async function handleRemoveTelegramRow(row: TelegramDraftRow) {
    if (!row.rowId) {
      setTelegramError(null);
      setTelegramDraftRows((rows) => {
        const nextRows = rows.filter((item) => item.localId !== row.localId);
        return nextRows.length > 0 ? nextRows : [createTelegramDraftRow()];
      });
      setTelegramRowHealthFeedback((current) => {
        const next = { ...current };
        delete next[row.localId];
        return next;
      });
      setRemoveCandidateRow(null);
      return;
    }

    setTelegramAction('removing-row');
    setTelegramActionTargetLocalId(row.localId);
    setTelegramError(null);
    try {
      const nextConnection = await window.codexDesktop.removeTelegramProjectSyncRow(row.rowId);
      setTelegramConnection(nextConnection);
      setTelegramDraftRows((currentRows) => buildTelegramDraftRows(nextConnection, currentRows));
      setTelegramRowHealthFeedback((current) => {
        const next = { ...current };
        delete next[row.rowId ?? row.localId];
        delete next[row.localId];
        return next;
      });
      setRemoveCandidateRow(null);
      await refreshChannelConnections();
    } catch (error) {
      setTelegramError(getErrorMessage(error));
    } finally {
      setTelegramAction(null);
      setTelegramActionTargetLocalId(null);
    }
  }

  async function handleToggleActiveThreads(row: TelegramDraftRow) {
    if (!row.projectId) {
      return;
    }

    if (!projectThreadCache[row.projectId] || projectThreadLoadingIds.includes(row.projectId)) {
      return;
    }

    if (expandedThreadProjectIds.includes(row.projectId)) {
      setExpandedThreadProjectIds((projectIds) =>
        projectIds.filter((projectId) => projectId !== row.projectId)
      );
      return;
    }

    setExpandedThreadProjectIds((projectIds) => [...projectIds, row.projectId]);
  }

  function renderActiveThreads(row: TelegramDraftRow) {
    if (!expandedThreadProjectIds.includes(row.projectId)) {
      return null;
    }

    const threadsLoading =
      row.projectId.length > 0 &&
      (!projectThreadCache[row.projectId] || projectThreadLoadingIds.includes(row.projectId));
    const activeThreads = (projectThreadCache[row.projectId] ?? []).filter(
      (thread) => !thread.archived
    );

    return (
      <div className="active-threads">
        {threadsLoading ? (
          <p>Loading threads...</p>
        ) : activeThreads.length === 0 ? (
          <p>No active threads found for this project.</p>
        ) : (
          activeThreads.map((thread) => (
            <div className="active-thread-row" key={thread.id}>
              <span>{thread.title}</span>
            </div>
          ))
        )}
      </div>
    );
  }

  async function savePendingTelegramTokenIfNeeded() {
    const token = telegramTokenInput.trim();
    if (!token) {
      return;
    }

    if (shouldConfirmTelegramTokenReplacement(token)) {
      throw new Error('Confirm the new Telegram bot token with Save token before setting up the environment.');
    }

    await persistTelegramToken(token);
  }

  async function handleSetUpTelegramEnvironment(row: TelegramDraftRow) {
    setTelegramAction('setting-up');
    setTelegramActionTargetLocalId(row.localId);
    setTelegramError(null);

    try {
      await savePendingTelegramTokenIfNeeded();
      const preparedRow = {
        rowId: row.rowId,
        forumGroupId: row.forumGroupId.trim(),
        forumGroupTitle: row.forumGroupTitle.trim() || row.forumGroupId.trim(),
        projectId: row.projectId.trim()
      };

      if (!preparedRow.forumGroupId || !preparedRow.projectId) {
        throw new Error(
          'Telegram chat ID and Codex project are required before setting up the environment.'
        );
      }

      if (isLocalCodexProject(projectOptions, preparedRow.projectId)) {
        await window.codexDesktop.ensureCodexProject(preparedRow.projectId);
      }

      const setupResult = await window.codexDesktop.setupTelegramEnvironment(preparedRow);
      const [refreshedProjects, refreshedCodexProjects] = await Promise.all([
        window.codexDesktop.listProjects(),
        window.codexDesktop.listCodexProjects()
      ]);
      setTelegramConnection(setupResult.connection);
      setProjects(refreshedProjects);
      setCodexProjects(refreshedCodexProjects);
      setTelegramDraftRows(
        (currentRows) => buildTelegramDraftRows(setupResult.connection, currentRows)
      );
      await refreshChannelConnections();
    } catch (error) {
      setTelegramError(getErrorMessage(error));
    } finally {
      setTelegramAction(null);
      setTelegramActionTargetLocalId(null);
    }
  }

  async function handleCheckTelegramEnvironment(row: TelegramDraftRow) {
    if (!row.rowId) {
      return;
    }

    const rowId = row.rowId;
    setTelegramAction('checking-health');
    setTelegramActionTargetLocalId(row.localId);
    setTelegramError(null);
    try {
      if (isLocalCodexProject(projectOptions, row.projectId)) {
        await window.codexDesktop.ensureCodexProject(row.projectId);
      }

      const nextConnection = await window.codexDesktop.checkTelegramEnvironment(rowId);
      setTelegramConnection(nextConnection);
      setTelegramDraftRows((currentRows) => buildTelegramDraftRows(nextConnection, currentRows));
      const checkedRow = nextConnection.rows.find((item) => item.id === rowId);
      setTelegramRowHealthFeedback((current) => ({
        ...current,
        [rowId]: checkedRow?.lastIssue
          ? { tone: 'red', text: checkedRow.lastIssue }
          : { tone: 'green', text: 'Project is healthy' }
      }));
      await refreshChannelConnections();
    } catch (error) {
      setTelegramError(getErrorMessage(error));
    } finally {
      setTelegramAction(null);
      setTelegramActionTargetLocalId(null);
    }
  }

  async function handleRepairTelegramEnvironment() {
    if (!repairCandidateRow?.rowId) {
      return;
    }

    setTelegramAction('repairing');
    setTelegramActionTargetLocalId(repairCandidateRow.localId);
    setTelegramError(null);
    try {
      const repairResult = await window.codexDesktop.repairTelegramEnvironment(
        repairCandidateRow.rowId
      );
      setTelegramConnection(repairResult.connection);
      setTelegramDraftRows((currentRows) => buildTelegramDraftRows(repairResult.connection, currentRows));
      setRepairCandidateRow(null);
      await refreshChannelConnections();
    } catch (error) {
      setTelegramError(getErrorMessage(error));
    } finally {
      setTelegramAction(null);
      setTelegramActionTargetLocalId(null);
    }
  }

  function renderDashboard() {
    const codexDetection = buildCodexDetectionSummary(state);
    const primaryRateLimit = buildRateLimitCardModel(
      snapshot.primaryRateLimitWindowMinutes,
      snapshot.primaryRateLimitRemainingPercent,
      snapshot.primaryRateLimitResetsAt
    );
    const weeklyRateLimit = buildRateLimitCardModel(
      snapshot.weeklyRateLimitWindowMinutes,
      snapshot.weeklyRateLimitRemainingPercent,
      snapshot.weeklyRateLimitResetsAt
    );

    return (
      <div className="dashboard-grid">
        <div className="dashboard-column">
          <SectionCard title="Codex status">
            <div className="codex-status-summary">
              <div className="channel-list codex-status-summary__list">
                {codexDetection.items.length > 0 ? (
                  codexDetection.items.map((item) => (
                    <div className="channel-row" key={item.label}>
                      <CodexReadinessLabel label={item.label} version={item.version} />
                    </div>
                  ))
                ) : (
                  <p className="muted codex-status__empty">{codexDetection.fallbackText}</p>
                )}
              </div>
              <StatusPill status={codexDetection.status} />
            </div>
            <div className="snapshot-inline">
              <div className="snapshot-layout">
                <div className="snapshot-rate-shell">
                  <RateLimitCard model={primaryRateLimit} accent="session" />
                  <RateLimitCard model={weeklyRateLimit} accent="weekly" />
                </div>
              </div>
            </div>
          </SectionCard>
        </div>

        <div className="dashboard-column">
          <SectionCard
            title="Server status"
            action={<StatusPill status={displayedServerStatus} isLoading={serverAction !== null} />}
          >
            <div className="server-row">
              <div>
                <p>{getServerSupportText(state.serverStatus, serverAction, state.serverPort)}</p>
              </div>
              <button
                className={
                  serverAction !== null ? 'primary-button button--loading' : 'primary-button'
                }
                type="button"
                onClick={() =>
                  void (state.serverStatus.tone === 'green'
                    ? handleStopServer()
                    : handleStartServer())
                }
                disabled={serverAction !== null}
              >
                {renderWaveLabel(
                  getServerButtonText(state.serverStatus, serverAction),
                  serverAction !== null
                )}
              </button>
            </div>
            <div className="startup-options">
              <label className="startup-option">
                <input
                  type="checkbox"
                  checked={startupSettings.launchAtLogin}
                  disabled={!startupLoaded || startupAction !== null}
                  onChange={(event) => void handleStartupToggle('login', event.currentTarget.checked)}
                />
                <span>Launch Companion when I log in to macOS</span>
              </label>
              <label className="startup-option">
                <input
                  type="checkbox"
                  checked={startupSettings.autoStartServer}
                  disabled={!startupLoaded || startupAction !== null}
                  onChange={(event) => void handleStartupToggle('server', event.currentTarget.checked)}
                />
                <span>Start the server when Companion opens</span>
              </label>
              {startupError ? <p className="startup-error" role="status">{startupError}</p> : null}
            </div>
          </SectionCard>

          <SectionCard
            title="Messaging channels"
            action={
              <button
                className="secondary-button"
                type="button"
                onClick={() => void handleOpenMessagingSettings()}
              >
                Messaging settings
              </button>
            }
          >
            <div className="channel-list">
              {displayedChannels.map((channel) => (
                <div className="channel-row" key={channel.key}>
                  <span className="channel-row__label">{channel.label}</span>
                  <StatusPill status={channel.status} />
                </div>
              ))}
            </div>
          </SectionCard>
        </div>
      </div>
    );
  }

  function renderBootLoading() {
    return (
      <div className="boot-loading-text-wrap" aria-live="polite">
        <h1 className="boot-loading-text" data-text="Codex Remote Companion Loading...">
          Codex Remote Companion Loading...
        </h1>
      </div>
    );
  }

  function renderTelegramCard() {
    const globalActionInProgress =
      telegramAction !== null && telegramAction !== 'checking-health';
    const healthCheckInProgress = telegramAction === 'checking-health';
    const saveTokenLabel = getTelegramTokenButtonLabel(telegramConnection.maskedBotToken);

    return (
      <div className="settings-card-stack">
        <SectionCard
          title="Telegram"
          className="settings-card"
          scrollContent
          action={
            <StatusPill
              status={telegramConnection.status}
              isLoading={!telegramSurfaceLoaded || globalActionInProgress}
            />
          }
        >
          <div className="settings-stack">
            <div className="settings-note">
              <strong>Private Telegram bot setup</strong>
              <p>
                Use your own Telegram bot token. The token is stored locally and shown only as a
                masked value after it is saved.
              </p>
            </div>

            <label className="form-field">
              <span>Your Telegram user ID (only this account can send Codex prompts)</span>
              <input
                type="text"
                inputMode="numeric"
                value={telegramOwnerIdInput}
                onChange={(event) => setTelegramOwnerIdInput(event.target.value)}
                placeholder={telegramConnection.ownerUserId ?? 'Numeric user ID'}
                disabled={globalActionInProgress}
              />
            </label>

            <div className="form-grid form-grid--token">
              <label className="form-field">
                <span>Telegram bot token</span>
                <input
                  type="password"
                  value={telegramTokenInput}
                  onChange={(event) => {
                    setTelegramTokenInput(event.target.value);
                    setPendingTelegramTokenReplacement(null);
                  }}
                  placeholder={
                    telegramConnection.maskedBotToken
                      ? 'Paste a new token to replace saved token'
                      : 'Paste Telegram bot token'
                  }
                  disabled={globalActionInProgress}
                />
              </label>
              <button
                className={
                  telegramAction === 'saving-token'
                    ? 'secondary-button button--loading'
                    : 'secondary-button'
                }
                type="button"
                onClick={() => void handleSaveTelegramToken()}
                disabled={globalActionInProgress || !telegramTokenInput.trim()}
              >
              {renderWaveLabel(
                  telegramAction === 'saving-token' ? 'Saving...' : saveTokenLabel,
                  telegramAction === 'saving-token'
                )}
              </button>
            </div>

            <div className="token-meta">
              <span>
                Active Token:{' '}
                <strong>{telegramConnection.maskedBotToken ?? 'Not saved'}</strong>
              </span>
              {telegramConnection.maskedBotToken ? (
                <button
                  className={
                    telegramAction === 'removing-token'
                      ? 'text-button text-button--danger text-button--loading'
                      : 'text-button text-button--danger'
                  }
                  type="button"
                  onClick={() => setPendingTelegramTokenRemoval(true)}
                  disabled={globalActionInProgress}
                >
                  {renderWaveLabel(
                    telegramAction === 'removing-token' ? 'Removing token...' : 'Remove token',
                    telegramAction === 'removing-token'
                  )}
                </button>
              ) : null}
              <span>
                Telegram Bot Name:{' '}
                <strong>
                  {telegramConnection.botUsername ? `@${telegramConnection.botUsername}` : 'Unknown'}
                </strong>
              </span>
            </div>

            <div className="binding-header">
              <div>
                <h3>Project bindings</h3>
                <p>Each row connects one Telegram forum group to one local Codex project.</p>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={handleAddTelegramRow}
                disabled={globalActionInProgress}
              >
                + Add project
              </button>
            </div>

            <div className="binding-list">
              {telegramDraftRows.map((row) => {
                const topicSync = topicSyncRows.find((item) => item.rowId === row.rowId);
                const rowStatus = getTelegramRowStatus(
                  row,
                  telegramConnection,
                  telegramError,
                  telegramSurfaceLoaded
                );
                const activeThreadsExpanded = expandedThreadProjectIds.includes(row.projectId);
                const threadsLoading =
                  row.projectId.length > 0 &&
                  (!projectThreadCache[row.projectId] ||
                    projectThreadLoadingIds.includes(row.projectId));
                const rowLocked = isTelegramRowLocked(row);
                const rowProjectOptions = getRowProjectOptions(
                  projectOptions,
                  row.projectId,
                  rowLocked
                );
                const projectName = getProjectOptionName(projectOptions, row.projectId);
                const rowTitle = rowLocked ? `${projectName} binding` : 'New binding';
                const rowHealthCheckInProgress =
                  healthCheckInProgress && telegramActionTargetLocalId === row.localId;
                const rowActionInProgress = globalActionInProgress || rowHealthCheckInProgress;
                const rowHealthStatus = getTelegramRowHealthStatus(row, telegramConnection);
              const rowHealthFeedback = row.rowId
                ? telegramRowHealthFeedback[row.rowId]
                : telegramRowHealthFeedback[row.localId];
              const activeThreadsButton = getActiveThreadsButtonModel({
                projectId: row.projectId,
                threadsLoading,
                activeThreadsExpanded,
                rowActionInProgress
              });

                return (
                  <div className="binding-row" key={row.localId}>
                  <div className="binding-row__title">
                    <div>
                      <strong>{rowTitle}</strong>
                    </div>
                    <div className="binding-row__status-pills">
                        <StatusPill
                          status={rowStatus}
                          isLoading={
                            !telegramSurfaceLoaded ||
                            (globalActionInProgress &&
                              telegramActionTargetLocalId === row.localId)
                          }
                        />
                        {rowHealthStatus ? (
                          <StatusPill
                            status={
                              rowHealthCheckInProgress
                                ? { tone: 'yellow', text: 'Checking' }
                                : rowHealthStatus
                            }
                            isLoading={rowHealthCheckInProgress}
                          />
                        ) : null}
                      </div>
                    </div>
                    <div className="form-grid form-grid--binding">
                      <label className="form-field">
                        <span>Telegram chat ID</span>
                        <input
                          type="text"
                          value={row.forumGroupId}
                          onChange={(event) =>
                            updateTelegramDraftRow(row.localId, 'forumGroupId', event.target.value)
                          }
                          placeholder="-1003739703024"
                          disabled={rowActionInProgress || rowLocked}
                        />
                      </label>
                      <div className="form-field">
                        <span>Telegram group name</span>
                        <div className="readonly-field">
                          {row.forumGroupTitle || 'Not checked yet'}
                        </div>
                      </div>
                      <label className="form-field">
                        <span>Codex project</span>
                        <div
                          className={
                            rowActionInProgress || rowLocked || rowProjectOptions.length === 0
                              ? 'select-shell select-shell--disabled'
                              : 'select-shell'
                          }
                        >
                          <select
                            value={row.projectId}
                            onChange={(event) =>
                              updateTelegramDraftRow(row.localId, 'projectId', event.target.value)
                            }
                            disabled={
                              rowActionInProgress || rowLocked || rowProjectOptions.length === 0
                            }
                          >
                            {rowProjectOptions.length > 0 && !rowLocked ? (
                              <option value="">Select project</option>
                            ) : null}
                            {rowProjectOptions.length === 0 ? (
                              <option value="">No Codex projects found</option>
                            ) : null}
                            {rowProjectOptions.map((project) => (
                              <option value={project.id} key={project.id}>
                                {getProjectOptionLabel(project, rowProjectOptions)}
                              </option>
                            ))}
                          </select>
                        </div>
                      </label>
                    </div>
                    {rowHealthFeedback ? (
                      <div
                        className={
                          rowHealthFeedback.tone === 'green' ? 'inline-success' : 'inline-warning'
                        }
                      >
                        {rowHealthFeedback.text}
                      </div>
                    ) : row.lastIssue ? (
                      <div className="inline-warning">{row.lastIssue}</div>
                    ) : null}
                    {rowLocked ? (
                      <div className="topic-sync-panel">
                        <span>New chat topics: automatic</span>
                        {topicSync?.pending ? <span> · {topicSync.pending} pending</span> : null}
                        {topicSync?.lastError && !topicSync.needsReview.length ? (
                          <div className="inline-warning">{topicSync.lastError}</div>
                        ) : null}
                        {topicSync?.needsReview.map((issue) => {
                          const key = `${issue.rowId}:${issue.codexThreadId}`;
                          return (
                            <div className="topic-sync-issue" key={key}>
                              <strong>{issue.title}</strong>
                              <p>{issue.reason}</p>
                              <p>Check Telegram first. Retrying may create a duplicate topic.</p>
                              <div className="topic-sync-issue__actions">
                                <input
                                  type="number"
                                  min="1"
                                  placeholder="Existing topic ID"
                                  value={topicAttachIds[key] ?? ''}
                                  onChange={(event) => setTopicAttachIds((current) => ({
                                    ...current, [key]: event.target.value
                                  }))}
                                />
                                <button type="button" className="text-button" disabled={topicActionKey !== null}
                                  onClick={() => void handleTopicAttach(issue.rowId, issue.codexThreadId)}>
                                  Attach topic
                                </button>
                                <button type="button" className="text-button text-button--danger"
                                  disabled={topicActionKey !== null}
                                  onClick={() => void handleTopicRetry(issue.rowId, issue.codexThreadId)}>
                                  Create another topic
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    <div className="binding-row__footer">
                      <button
                      className="text-button text-button--toggle"
                      type="button"
                      onClick={() => void handleToggleActiveThreads(row)}
                      disabled={activeThreadsButton.disabled}
                    >
                        {activeThreadsButton.text}
                        {activeThreadsButton.showChevron ? (
                          <span
                            className={
                              activeThreadsExpanded
                                ? 'text-button__chevron text-button__chevron--open'
                                : 'text-button__chevron'
                            }
                            aria-hidden="true"
                          />
                        ) : null}
                      </button>
                      <div className="binding-row__footer-actions">
                        {rowLocked ? (
                          <button
                            className={
                              rowHealthCheckInProgress
                                ? 'text-button text-button--loading'
                                : 'text-button'
                            }
                            type="button"
                            onClick={() => void handleCheckTelegramEnvironment(row)}
                            disabled={rowActionInProgress}
                          >
                            {renderWaveLabel(
                              rowHealthCheckInProgress
                                ? 'Checking health...'
                                : 'Check health',
                              rowHealthCheckInProgress
                            )}
                          </button>
                        ) : (
                          <button
                            className={
                              telegramAction === 'setting-up' &&
                              telegramActionTargetLocalId === row.localId
                                ? 'text-button text-button--primary text-button--loading'
                                : 'text-button text-button--primary'
                            }
                            type="button"
                            onClick={() => void handleSetUpTelegramEnvironment(row)}
                            disabled={rowActionInProgress}
                          >
                            {renderWaveLabel(
                              telegramAction === 'setting-up' &&
                                telegramActionTargetLocalId === row.localId
                                ? 'Setting up...'
                                : 'Set up Telegram environment',
                              telegramAction === 'setting-up' &&
                                telegramActionTargetLocalId === row.localId
                            )}
                          </button>
                        )}
                        {rowLocked ? (
                          <button
                            className="text-button text-button--danger"
                            type="button"
                            onClick={() => setRepairCandidateRow(row)}
                            disabled={rowActionInProgress}
                          >
                            Repair environment
                          </button>
                        ) : null}
                        {rowLocked ? (
                          <button
                            className={
                              telegramAction === 'removing-row' &&
                              telegramActionTargetLocalId === row.localId
                                ? 'text-button text-button--danger text-button--loading'
                                : 'text-button text-button--danger'
                            }
                            type="button"
                            onClick={() => setRemoveCandidateRow(row)}
                            disabled={rowActionInProgress}
                          >
                            {renderWaveLabel(
                              telegramAction === 'removing-row' &&
                                telegramActionTargetLocalId === row.localId
                                ? 'Removing...'
                                : `Remove ${projectName} binding`,
                              telegramAction === 'removing-row' &&
                                telegramActionTargetLocalId === row.localId
                            )}
                          </button>
                        ) : (
                          <button
                            className={
                              telegramAction === 'removing-row' &&
                              telegramActionTargetLocalId === row.localId
                                ? 'text-button text-button--danger text-button--loading'
                                : 'text-button text-button--danger'
                            }
                            type="button"
                            onClick={() => void handleRemoveTelegramRow(row)}
                            disabled={rowActionInProgress}
                          >
                            {renderWaveLabel(
                              telegramAction === 'removing-row' &&
                                telegramActionTargetLocalId === row.localId
                                ? 'Removing...'
                                : 'Remove New binding',
                              telegramAction === 'removing-row' &&
                                telegramActionTargetLocalId === row.localId
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                    {renderActiveThreads(row)}
                  </div>
                );
              })}
            </div>

            {telegramError ? <div className="inline-error">{telegramError}</div> : null}
            {telegramConnection.issue ? (
              <div className="inline-warning">{telegramConnection.issue}</div>
            ) : null}
          </div>
        </SectionCard>
      </div>
    );
  }

  function renderRemoveModal() {
    if (!removeCandidateRow) {
      return null;
    }

    const projectName = removeCandidateRow.projectId
      ? getProjectOptionName(projectOptions, removeCandidateRow.projectId)
      : 'this binding';
    const isRemoving =
      telegramAction === 'removing-row' && telegramActionTargetLocalId === removeCandidateRow.localId;

    return (
      <div className="modal-backdrop" role="presentation">
        <div
          aria-labelledby="remove-modal-title"
          aria-modal="true"
          className="modal-card"
          role="dialog"
        >
          <h2 id="remove-modal-title">Remove binding?</h2>
          <p>
            Are you sure you want to remove the {projectName} binding from Codex Remote Companion?
          </p>
          <p>Telegram topics and Codex threads will stay unchanged.</p>
          <p className="modal-card__warning">
            This removes the saved binding only. You will need to set up the environment again if
            you want to reconnect it later.
          </p>
          <div className="modal-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setRemoveCandidateRow(null)}
              disabled={isRemoving}
            >
              Cancel
            </button>
            <button
              className={isRemoving ? 'danger-button button--loading' : 'danger-button'}
              type="button"
              onClick={() => void handleRemoveTelegramRow(removeCandidateRow)}
              disabled={isRemoving}
            >
              {renderWaveLabel(isRemoving ? 'Removing...' : 'Remove binding', isRemoving)}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderReplaceTokenModal() {
    if (!pendingTelegramTokenReplacement) {
      return null;
    }

    const isSaving = telegramAction === 'saving-token';

    return (
      <div className="modal-backdrop" role="presentation">
        <div
          aria-labelledby="replace-token-modal-title"
          aria-modal="true"
          className="modal-card"
          role="dialog"
        >
          <h2 id="replace-token-modal-title">Replace saved Telegram token?</h2>
          <p>
            Are you sure you want to replace the current Telegram bot token in Codex Remote Companion?
          </p>
          <p>
            Current saved token: <strong>{telegramConnection.maskedBotToken ?? 'Not saved'}</strong>
          </p>
          <p className="modal-card__warning">
            The previous token will stay unchanged until you confirm this replacement.
          </p>
          <div className="modal-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setPendingTelegramTokenReplacement(null)}
              disabled={isSaving}
            >
              Cancel
            </button>
            <button
              className={isSaving ? 'danger-button button--loading' : 'danger-button'}
              type="button"
              onClick={() => void persistTelegramToken(pendingTelegramTokenReplacement)}
              disabled={isSaving}
            >
              {renderWaveLabel(isSaving ? 'Saving...' : 'Replace token', isSaving)}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderRemoveTokenModal() {
    if (!pendingTelegramTokenRemoval) {
      return null;
    }

    const isRemoving = telegramAction === 'removing-token';

    return (
      <div className="modal-backdrop" role="presentation">
        <div
          aria-labelledby="remove-token-modal-title"
          aria-modal="true"
          className="modal-card"
          role="dialog"
        >
          <h2 id="remove-token-modal-title">Remove Telegram token?</h2>
          <p>
            Are you sure you want to remove the active Telegram bot token from Codex Remote Companion?
          </p>
          <p>
            Current active token: <strong>{telegramConnection.maskedBotToken ?? 'Not saved'}</strong>
          </p>
          <p className="modal-card__warning">
            Project bindings will stay saved. Telegram topics and Codex threads will not be deleted,
            but Telegram will be disconnected until you save a token again.
          </p>
          <div className="modal-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setPendingTelegramTokenRemoval(false)}
              disabled={isRemoving}
            >
              Cancel
            </button>
            <button
              className={isRemoving ? 'danger-button button--loading' : 'danger-button'}
              type="button"
              onClick={() => void handleRemoveTelegramToken()}
              disabled={isRemoving}
            >
              {renderWaveLabel(isRemoving ? 'Removing...' : 'Remove token', isRemoving)}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderRepairModal() {
    if (!repairCandidateRow) {
      return null;
    }

    const projectName = getProjectOptionName(projectOptions, repairCandidateRow.projectId);

    return (
      <div className="modal-backdrop" role="presentation">
        <div
          aria-labelledby="repair-modal-title"
          aria-modal="true"
          className="modal-card"
          role="dialog"
        >
          <h2 id="repair-modal-title">Repair Telegram environment?</h2>
          <p>
            Codex Remote Companion will create a fresh set of Telegram topics for the {projectName} binding.
          </p>
          <p>
            Existing Telegram topics will not be deleted. They will be renamed with the Old
            prefix, for example Old APs, Old 2 APs, Old 3 APs, and so on.
          </p>
          <p>Codex threads will stay unchanged.</p>
          <p className="modal-card__warning">
            Use this only if the current Telegram environment is broken.
          </p>
          <div className="modal-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setRepairCandidateRow(null)}
              disabled={telegramAction === 'repairing'}
            >
              Cancel
            </button>
            <button
              className={
                telegramAction === 'repairing' ? 'primary-button button--loading' : 'primary-button'
              }
              type="button"
              onClick={() => void handleRepairTelegramEnvironment()}
              disabled={telegramAction === 'repairing'}
            >
              {renderWaveLabel(
                telegramAction === 'repairing' ? 'Repairing...' : 'Repair environment',
                telegramAction === 'repairing'
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderMessagingSettings() {
    return (
      <div className="settings-screen">
        <header className="hero hero--settings">
          <div>
            <p className="eyebrow">Messaging Settings</p>
            <h1>Codex Remote Companion</h1>
            <p className="hero__copy">Connect messenger surfaces to Local Codex projects.</p>
          </div>
        </header>
        <nav className="settings-nav" aria-label="Messaging settings navigation">
          <button
            className="secondary-button"
            type="button"
            onClick={() => setScreen('dashboard')}
          >
            Back
          </button>
          <button className="tab-button tab-button--active" type="button">
            Telegram
          </button>
        </nav>

        <div className="settings-screen__content">
          <div className="settings-layout">
            {renderTelegramCard()}
          </div>
        </div>
      </div>
    );
  }

  return (
    <main className={screen === 'dashboard' ? 'app-shell' : 'app-shell app-shell--settings'}>
      {!bootReady && !bootError ? (
        <div aria-live="polite">{renderBootLoading()}</div>
      ) : null}
      {bootError ? (
        <section className="boot-error">
          <h2>Boot error</h2>
          <p>{bootError}</p>
        </section>
      ) : null}
      {bootReady && !bootError ? (
        <>
          {screen === 'dashboard' ? (
            <>
              <header className="hero">
                <div>
                  <p className="eyebrow">Status Dashboard</p>
                  <h1>Codex Remote Companion</h1>
                  <p className="hero__copy">
                    Local-first messenger bridge into the same Codex environment.
                  </p>
                </div>
              </header>

              {renderDashboard()}
            </>
          ) : (
            renderMessagingSettings()
          )}
        </>
      ) : null}
      {renderRepairModal()}
      {renderRemoveModal()}
      {renderReplaceTokenModal()}
      {renderRemoveTokenModal()}
    </main>
  );
}
