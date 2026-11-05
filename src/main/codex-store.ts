import { open, readdir, readFile, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

import type {
  CodexEnvironmentSnapshot,
  CodexProjectOption,
  CodexProjectThreadOption,
  CodexThreadMessage,
  CodexThreadRecord,
  CodexThreadSummary
} from '@shared/contracts';

interface SessionIndexEntry {
  id: string;
  thread_name: string;
  updated_at: string;
}

interface GlobalStateShape {
  'electron-saved-workspace-roots'?: string[];
  'active-workspace-roots'?: string[];
  'project-order'?: string[];
  'local-projects'?: Record<string, { rootPaths?: string[] }>;
}

interface AuthSummary {
  email: string | null;
}

interface RolloutMeta {
  id: string;
  timestamp: string | null;
  cwd: string | null;
  originator: string | null;
  cli_version: string | null;
  hiddenFromProjectThreads: boolean;
  source: string | null;
}

interface RolloutLookupEntry {
  id: string;
  cwd: string | null;
  timestamp: string | null;
  path: string;
  archived: boolean;
  originator: string | null;
  cliVersion: string | null;
  hiddenFromProjectThreads: boolean;
  source: string | null;
}

interface SnapshotRolloutSignals {
  permissionMode: string | null;
  primaryRateLimitRemainingPercent: number | null;
  primaryRateLimitWindowMinutes: number | null;
  primaryRateLimitResetsAt: string | null;
  weeklyRateLimitRemainingPercent: number | null;
  weeklyRateLimitWindowMinutes: number | null;
  weeklyRateLimitResetsAt: string | null;
}

interface SnapshotRolloutCacheEntry {
  key: string;
  path: string | null;
  archived: boolean;
}

type RateLimitSignals = Omit<SnapshotRolloutSignals, 'permissionMode'>;

interface RateLimitSignalObservation {
  timestamp: string | null;
  signals: RateLimitSignals;
}

const CONFIG_MODEL_PATTERN = /^model\s*=\s*"([^"]+)"/m;
const CONFIG_REASONING_PATTERN = /^model_reasoning_effort\s*=\s*"([^"]+)"/m;
const CONFIG_PERSONALITY_PATTERN = /^personality\s*=\s*"([^"]+)"/m;
const UUID_LIKE_THREAD_TITLE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INJECTED_THREAD_TITLE_PREFIXES = [
  '# AGENTS.md instructions for ',
  '# AGENTS instructions for '
];

function buildCodexProjectId(cwd: string): string {
  return `codex-project:${Buffer.from(cwd, 'utf8').toString('base64url')}`;
}

function decodeCodexProjectId(projectId: string): string | null {
  if (!projectId.startsWith('codex-project:')) {
    return null;
  }

  try {
    return Buffer.from(projectId.slice('codex-project:'.length), 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function isLikelyEphemeralWorkspace(root: string): boolean {
  const name = basename(root);
  const parentName = basename(dirname(root));

  return (
    /^repo\d*$/.test(name) ||
    /^pre-pm-review\./.test(name) ||
    /-workspace-e2e-/.test(name) ||
    parentName === 'worktrees'
  );
}

function extractQuotedTomlValue(raw: string, pattern: RegExp): string | null {
  return raw.match(pattern)?.[1] ?? null;
}

function parseJsonLines<T>(raw: string): T[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJsonLine<T>(line))
    .filter((value): value is T => value !== null);
}

function parseJsonLine<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function extractEmailFromAuthPayload(payload: Record<string, unknown> | null): string | null {
  if (!payload) {
    return null;
  }

  const directEmail = payload.email;
  if (typeof directEmail === 'string' && directEmail.trim().length > 0) {
    return directEmail.trim();
  }

  const profile = payload['https://api.openai.com/profile'];
  if (profile && typeof profile === 'object' && 'email' in profile) {
    const profileEmail = profile.email;
    if (typeof profileEmail === 'string' && profileEmail.trim().length > 0) {
      return profileEmail.trim();
    }
  }

  return null;
}

function normalizePermissionMode(
  approvalPolicy: unknown,
  sandboxPolicy: unknown
): string | null {
  const sandboxRecord =
    sandboxPolicy && typeof sandboxPolicy === 'object'
      ? (sandboxPolicy as Record<string, unknown>)
      : null;
  const sandboxType =
    sandboxRecord && typeof sandboxRecord.type === 'string'
      ? sandboxRecord.type
      : null;
  const approval = typeof approvalPolicy === 'string' ? approvalPolicy : null;

  if (sandboxType === 'read-only') {
    return 'Read-only';
  }

  if (sandboxType === 'danger-full-access') {
    return 'Full access';
  }

  if (sandboxType === 'workspace-write' && approval === 'on-request') {
    return 'Default permissions';
  }

  if (sandboxType === 'workspace-write' && approval === 'never') {
    return 'Full access';
  }

  if (sandboxType === 'workspace-write') {
    return 'Workspace write';
  }

  return null;
}

function toRemainingPercent(usedPercent: unknown): number | null {
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) {
    return null;
  }

  return Math.max(0, Math.min(100, 100 - usedPercent));
}

function toIntegerOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.round(value);
}

function toIsoFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return new Date(value * 1000).toISOString();
}

function emptySnapshotRolloutSignals(): SnapshotRolloutSignals {
  return {
    permissionMode: null,
    primaryRateLimitRemainingPercent: null,
    primaryRateLimitWindowMinutes: null,
    primaryRateLimitResetsAt: null,
    weeklyRateLimitRemainingPercent: null,
    weeklyRateLimitWindowMinutes: null,
    weeklyRateLimitResetsAt: null
  };
}

function emptyRateLimitSignals(): RateLimitSignals {
  return {
    primaryRateLimitRemainingPercent: null,
    primaryRateLimitWindowMinutes: null,
    primaryRateLimitResetsAt: null,
    weeklyRateLimitRemainingPercent: null,
    weeklyRateLimitWindowMinutes: null,
    weeklyRateLimitResetsAt: null
  };
}

function extractRateLimitSignals(rateLimits: unknown): RateLimitSignals {
  const empty = emptySnapshotRolloutSignals();
  if (!rateLimits || typeof rateLimits !== 'object') {
    return {
      primaryRateLimitRemainingPercent: empty.primaryRateLimitRemainingPercent,
      primaryRateLimitWindowMinutes: empty.primaryRateLimitWindowMinutes,
      primaryRateLimitResetsAt: empty.primaryRateLimitResetsAt,
      weeklyRateLimitRemainingPercent: empty.weeklyRateLimitRemainingPercent,
      weeklyRateLimitWindowMinutes: empty.weeklyRateLimitWindowMinutes,
      weeklyRateLimitResetsAt: empty.weeklyRateLimitResetsAt
    };
  }

  const rateLimitRecord = rateLimits as Record<string, unknown>;
  const primary =
    rateLimitRecord.primary && typeof rateLimitRecord.primary === 'object'
      ? (rateLimitRecord.primary as Record<string, unknown>)
      : null;
  const secondary =
    rateLimitRecord.secondary && typeof rateLimitRecord.secondary === 'object'
      ? (rateLimitRecord.secondary as Record<string, unknown>)
      : null;

  return {
    primaryRateLimitRemainingPercent: primary
      ? toRemainingPercent(primary.used_percent)
      : null,
    primaryRateLimitWindowMinutes: primary ? toIntegerOrNull(primary.window_minutes) : null,
    primaryRateLimitResetsAt: primary ? toIsoFromUnixSeconds(primary.resets_at) : null,
    weeklyRateLimitRemainingPercent: secondary
      ? toRemainingPercent(secondary.used_percent)
      : null,
    weeklyRateLimitWindowMinutes: secondary ? toIntegerOrNull(secondary.window_minutes) : null,
    weeklyRateLimitResetsAt: secondary ? toIsoFromUnixSeconds(secondary.resets_at) : null
  };
}

function extractTextParts(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const textParts: string[] = [];

  for (const item of content) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const maybeText = (item as { text?: unknown }).text;
    if (typeof maybeText === 'string' && maybeText.trim().length > 0) {
      textParts.push(maybeText.trim());
    }
  }

  return textParts;
}

function extractMessageFromRolloutLine(line: unknown): CodexThreadMessage | null {
  if (!line || typeof line !== 'object') {
    return null;
  }

  const entry = line as {
    timestamp?: unknown;
    type?: unknown;
    payload?: Record<string, unknown>;
  };

  if (entry.type === 'response_item' && entry.payload) {
    const payload = entry.payload;
    if (payload.type === 'message') {
      const role = typeof payload.role === 'string' ? payload.role : 'unknown';
      const text = extractTextParts(payload.content).join('\n\n');
      if (!text) {
        return null;
      }

      const metadata = payload.internal_chat_message_metadata_passthrough;
      const contentMetadata =
        metadata && typeof metadata === 'object' && 'content_item_metadata' in metadata
          ? (metadata as { content_item_metadata?: unknown }).content_item_metadata
          : null;
      const isHarnessGenerated = role === 'user' &&
        Array.isArray(contentMetadata) &&
        contentMetadata.length > 0 &&
        contentMetadata.every((item) =>
          item && typeof item === 'object' &&
          'provenance' in item &&
          item.provenance && typeof item.provenance === 'object' &&
          'type' in item.provenance && item.provenance.type === 'harness'
        );

      return {
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
        role: role === 'user' || role === 'assistant' || role === 'system' || role === 'developer'
          ? role
          : 'unknown',
        text,
        sourceType: 'response_item.message',
        phase: typeof payload.phase === 'string' ? payload.phase : null,
        isHarnessGenerated
      };
    }
  }

  if (entry.type === 'event_msg' && entry.payload) {
    const payload = entry.payload;
    if (payload.type === 'user_message' && typeof payload.message === 'string') {
      return {
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
        role: 'user',
        text: payload.message,
        sourceType: 'event_msg.user_message'
      };
    }

    if (payload.type === 'agent_message' && typeof payload.message === 'string') {
      return {
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
        role: 'assistant',
        text: payload.message,
        sourceType: 'event_msg.agent_message'
      };
    }
  }

  return null;
}

function isContextEnvelopeText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith('<environment_context>') ||
    trimmed.startsWith('<deployment_context>') ||
    trimmed.startsWith('<app-context>') ||
    trimmed.startsWith('<permissions instructions>') ||
    trimmed.startsWith('<collaboration_mode>') ||
    trimmed.startsWith('<apps_instructions>') ||
    trimmed.startsWith('<skills_instructions>')
  );
}

function isMachineGeneratedThreadTitle(title: string | null, threadId: string): boolean {
  if (!title || title.trim().length === 0) {
    return true;
  }

  const normalizedTitle = title.trim();
  return normalizedTitle === threadId || UUID_LIKE_THREAD_TITLE_PATTERN.test(normalizedTitle);
}

function isInjectedThreadTitleText(text: string): boolean {
  const trimmed = text.trimStart();
  return INJECTED_THREAD_TITLE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function extractThreadTitleCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || isContextEnvelopeText(trimmed) || isInjectedThreadTitleText(trimmed)) {
    return null;
  }

  const firstLine = trimmed
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  return firstLine ? firstLine.replace(/\s+/g, ' ').slice(0, 80) : null;
}

function deriveThreadTitle(
  preferredTitle: string | null,
  messages: CodexThreadMessage[],
  threadId: string
): string {
  if (preferredTitle && !isMachineGeneratedThreadTitle(preferredTitle, threadId)) {
    return preferredTitle;
  }

  const firstUserOrAssistantMessage = messages.find(
    (message) =>
      (message.role === 'user' || message.role === 'assistant') &&
      !message.isHarnessGenerated &&
      extractThreadTitleCandidate(message.text) !== null
  );

  if (firstUserOrAssistantMessage) {
    return extractThreadTitleCandidate(firstUserOrAssistantMessage.text) ?? threadId;
  }

  return threadId;
}

async function deriveThreadTitleFromRolloutPath(
  preferredTitle: string | null,
  rolloutPath: string,
  threadId: string
): Promise<string> {
  if (preferredTitle && !isMachineGeneratedThreadTitle(preferredTitle, threadId)) {
    return preferredTitle;
  }

  const stream = createReadStream(rolloutPath, { encoding: 'utf8' });
  const reader = createInterface({
    input: stream,
    crlfDelay: Infinity
  });

  try {
    for await (const rawLine of reader) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      const parsed = parseJsonLine<unknown>(line);
      if (parsed === null) continue;
      const message = extractMessageFromRolloutLine(parsed);
      if (
        message &&
        (message.role === 'user' || message.role === 'assistant') &&
        !message.isHarnessGenerated &&
        extractThreadTitleCandidate(message.text) !== null
      ) {
        return extractThreadTitleCandidate(message.text) ?? threadId;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return preferredTitle?.trim() || threadId;
}

function parseRolloutMeta(rawFirstLine: string): RolloutMeta | null {
  if (!rawFirstLine.trim()) {
    return null;
  }

  const parsed = parseJsonLine<{
    type?: string;
    payload?: Record<string, unknown>;
  }>(rawFirstLine);

  if (parsed?.type !== 'session_meta' || !parsed.payload) {
    return null;
  }

  const source = parsed.payload.source;
  const baseInstructions = parsed.payload.base_instructions;
  const baseInstructionsText =
    baseInstructions &&
    typeof baseInstructions === 'object' &&
    'text' in baseInstructions &&
    typeof baseInstructions.text === 'string'
      ? baseInstructions.text
      : null;
  const isReviewThread =
    typeof baseInstructionsText === 'string' &&
    (baseInstructionsText.startsWith('# Review guidelines:') ||
      baseInstructionsText.includes('You are acting as a reviewer for a proposed code change'));
  const isSubagentThread =
    !!source && typeof source === 'object' && 'subagent' in source;

  return {
    id: typeof parsed.payload.id === 'string' ? parsed.payload.id : '',
    timestamp: typeof parsed.payload.timestamp === 'string' ? parsed.payload.timestamp : null,
    cwd: typeof parsed.payload.cwd === 'string' ? parsed.payload.cwd : null,
    originator:
      typeof parsed.payload.originator === 'string' ? parsed.payload.originator : null,
    cli_version:
      typeof parsed.payload.cli_version === 'string' ? parsed.payload.cli_version : null,
    hiddenFromProjectThreads: isReviewThread || isSubagentThread,
    source: typeof source === 'string' ? source : null
  };
}

async function collectJsonlFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(root, entry.name);
      if (entry.isDirectory()) {
        return collectJsonlFiles(fullPath);
      }

      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        return [fullPath];
      }

      return [];
    })
  );

  return files.flat();
}

async function readFirstNonEmptyJsonlLine(path: string): Promise<string | null> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const reader = createInterface({
    input: stream,
    crlfDelay: Infinity
  });

  try {
    for await (const rawLine of reader) {
      const line = rawLine.trim();
      if (line) {
        return line;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return null;
}

async function readJsonlTail(path: string, maxBytes = 256 * 1024): Promise<string> {
  const handle = await open(path, 'r');

  try {
    const fileStat = await handle.stat();
    const length = Math.min(fileStat.size, maxBytes);
    if (length <= 0) {
      return '';
    }

    const start = Math.max(0, fileStat.size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const raw = buffer.toString('utf8');

    if (start === 0) {
      return raw;
    }

    const firstNewline = raw.indexOf('\n');
    return firstNewline >= 0 ? raw.slice(firstNewline + 1) : '';
  } finally {
    await handle.close();
  }
}

export class CodexLocalStore {
  private readonly codexHome: string;
  private snapshotRolloutCache: SnapshotRolloutCacheEntry | null = null;
  private globalStateCache: GlobalStateShape | null = null;

  constructor(codexHome = join(homedir(), '.codex')) {
    this.codexHome = codexHome;
  }

  getCodexHome(): string {
    return this.codexHome;
  }

  async getEnvironmentSnapshot(): Promise<CodexEnvironmentSnapshot> {
    const [configRaw, globalState, authSummary, threads, archivedThreads, indexEntries] =
      await Promise.all([
      this.readConfig(),
      this.readGlobalState(),
      this.readAuthSummary(),
      collectJsonlFiles(join(this.codexHome, 'sessions')),
      collectJsonlFiles(join(this.codexHome, 'archived_sessions')),
      this.readSessionIndex()
    ]);
    const snapshotRollout = await this.resolveSnapshotRollout(globalState, indexEntries);
    const [rolloutSignals, freshestRateLimitSignals] = await Promise.all([
      snapshotRollout
        ? this.readSnapshotRolloutSignals(snapshotRollout.path)
        : emptySnapshotRolloutSignals(),
      this.readLatestRateLimitSignals()
    ]);
    const rateLimitSignals = this.mergeRateLimitSignals(
      freshestRateLimitSignals,
      rolloutSignals
    );

    return {
      model: extractQuotedTomlValue(configRaw, CONFIG_MODEL_PATTERN),
      reasoningEffort: extractQuotedTomlValue(configRaw, CONFIG_REASONING_PATTERN),
      personality: extractQuotedTomlValue(configRaw, CONFIG_PERSONALITY_PATTERN),
      activeUserEmail: authSummary.email,
      permissionMode: rolloutSignals.permissionMode,
      primaryRateLimitRemainingPercent: rateLimitSignals.primaryRateLimitRemainingPercent,
      primaryRateLimitWindowMinutes: rateLimitSignals.primaryRateLimitWindowMinutes,
      primaryRateLimitResetsAt: rateLimitSignals.primaryRateLimitResetsAt,
      weeklyRateLimitRemainingPercent: rateLimitSignals.weeklyRateLimitRemainingPercent,
      weeklyRateLimitWindowMinutes: rateLimitSignals.weeklyRateLimitWindowMinutes,
      weeklyRateLimitResetsAt: rateLimitSignals.weeklyRateLimitResetsAt,
      savedWorkspaceRoots: globalState['electron-saved-workspace-roots'] ?? [],
      activeWorkspaceRoots: globalState['active-workspace-roots'] ?? [],
      projectOrder: globalState['project-order'] ?? [],
      threadCount: threads.length,
      archivedThreadCount: archivedThreads.length,
      source: 'local-files'
    };
  }

  async listThreads(limit = 20): Promise<CodexThreadSummary[]> {
    const [indexEntries, rolloutLookup] = await Promise.all([
      this.readSessionIndex(),
      this.buildRolloutLookup()
    ]);

    const indexById = new Map(indexEntries.map((entry) => [entry.id, entry]));
    const rolloutBackedThreads = [...rolloutLookup.values()]
      .filter((rollout) => !rollout.hiddenFromProjectThreads)
      .map((rollout) => {
        const indexEntry = indexById.get(rollout.id);
        const isUserFacingRollout = Boolean(indexEntry) || rollout.source === 'vscode';

        if (!isUserFacingRollout) {
          return null;
        }

        return {
          id: rollout.id,
          title: indexEntry?.thread_name ?? rollout.id,
          updatedAt: indexEntry?.updated_at ?? rollout.timestamp,
          archived: rollout.archived,
          cwd: rollout.cwd,
          path: rollout.path
        };
      })
      .filter((thread): thread is CodexThreadSummary => thread !== null);

    const indexOnlyThreads = indexEntries
      .filter((entry) => !rolloutLookup.has(entry.id))
      .map((entry) => ({
        id: entry.id,
        title: entry.thread_name,
        updatedAt: entry.updated_at,
        archived: false,
        cwd: null,
        path: ''
      }));

    return [...rolloutBackedThreads, ...indexOnlyThreads]
      .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
      .slice(0, limit);
  }

  async listProjectOptions(): Promise<CodexProjectOption[]> {
    const [snapshot, threads, globalState] = await Promise.all([
      this.getEnvironmentSnapshot(),
      this.listThreads(1000),
      this.readGlobalState()
    ]);
    const cwdRoots = new Set<string>();

    for (const root of [
      ...snapshot.projectOrder,
      ...snapshot.activeWorkspaceRoots,
      ...snapshot.savedWorkspaceRoots,
      ...Object.values(globalState['local-projects'] ?? {}).flatMap(
        (project) => project.rootPaths ?? []
      ),
      ...threads.map((thread) => thread.cwd)
    ]) {
      if (root) {
        cwdRoots.add(root);
      }
    }

    return [...cwdRoots].filter((cwd) => !isLikelyEphemeralWorkspace(cwd)).map((cwd) => {
      const projectThreads = threads.filter((thread) => thread.cwd === cwd);
      const activeThreadCount = projectThreads.filter((thread) => !thread.archived).length;
      const archivedThreadCount = projectThreads.length - activeThreadCount;

      return {
        id: buildCodexProjectId(cwd),
        name: basename(cwd),
        cwd,
        threadCount: projectThreads.length,
        activeThreadCount,
        archivedThreadCount
      };
    });
  }

  async listProjectThreadOptions(projectId: string): Promise<CodexProjectThreadOption[]> {
    const cwd = decodeCodexProjectId(projectId);
    if (!cwd) {
      return [];
    }

    const threads = await this.listThreads(Number.MAX_SAFE_INTEGER);
    const projectThreads = threads.filter((thread) => thread.cwd === cwd);

    return Promise.all(
      projectThreads.map(async (thread) => {
        const resolvedTitle = isMachineGeneratedThreadTitle(thread.title, thread.id)
          ? await deriveThreadTitleFromRolloutPath(thread.title, thread.path, thread.id).catch(
              () => thread.title
            )
          : thread.title;

        return {
          id: thread.id,
          title: resolvedTitle,
          updatedAt: thread.updatedAt,
          archived: thread.archived,
          cwd: thread.cwd
        };
      })
    );
  }

  async readThread(threadId: string): Promise<CodexThreadRecord> {
    const [indexEntries, rolloutLookup] = await Promise.all([
      this.readSessionIndex(),
      this.buildRolloutLookup()
    ]);

    const indexEntry = indexEntries.find((entry) => entry.id === threadId);
    const rollout = rolloutLookup.get(threadId);

    if (!rollout) {
      throw new Error(`Thread ${threadId} was not found in local Codex state.`);
    }

    const lines = parseJsonLines<unknown>(await readFile(rollout.path, 'utf8'));
    const messages = lines
      .map((line) => extractMessageFromRolloutLine(line))
      .filter((message): message is CodexThreadMessage => message !== null);

    return {
      id: threadId,
      title: deriveThreadTitle(indexEntry?.thread_name ?? null, messages, threadId),
      updatedAt: indexEntry?.updated_at ?? rollout.timestamp,
      archived: rollout.archived,
      cwd: rollout.cwd,
      path: rollout.path,
      originator: rollout.originator,
      cliVersion: rollout.cliVersion,
      messages
    };
  }

  private async readConfig(): Promise<string> {
    return readFile(join(this.codexHome, 'config.toml'), 'utf8');
  }

  private async readAuthSummary(): Promise<AuthSummary> {
    try {
      const raw = await readFile(join(this.codexHome, 'auth.json'), 'utf8');
      const parsed = JSON.parse(raw) as {
        tokens?: {
          id_token?: string | null;
          access_token?: string | null;
        };
      };
      const idPayload = decodeJwtPayload(parsed.tokens?.id_token);
      const accessPayload = decodeJwtPayload(parsed.tokens?.access_token);

      return {
        email: extractEmailFromAuthPayload(idPayload) ?? extractEmailFromAuthPayload(accessPayload)
      };
    } catch {
      return { email: null };
    }
  }

  private async readGlobalState(): Promise<GlobalStateShape> {
    const path = join(this.codexHome, '.codex-global-state.json');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const raw = await readFile(path, 'utf8');
      try {
        const state = JSON.parse(raw) as GlobalStateShape;
        this.globalStateCache = state;
        return state;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        if (attempt < 4) {
          await new Promise<void>((resolve) => setTimeout(resolve, 80));
        }
      }
    }
    console.warn('Codex global state is temporarily invalid; using the last valid snapshot.');
    return this.globalStateCache ?? {};
  }

  private async readSessionIndex(): Promise<SessionIndexEntry[]> {
    const raw = await readFile(join(this.codexHome, 'session_index.jsonl'), 'utf8');
    return parseJsonLines<SessionIndexEntry>(raw);
  }

  private async buildRolloutLookup(): Promise<Map<string, RolloutLookupEntry>> {
    const [sessionFiles, archivedFiles] = await Promise.all([
      collectJsonlFiles(join(this.codexHome, 'sessions')),
      collectJsonlFiles(join(this.codexHome, 'archived_sessions'))
    ]);
    const lookup = new Map<string, RolloutLookupEntry>();

    for (const [files, archived] of [
      [sessionFiles, false],
      [archivedFiles, true]
    ] as const) {
      for (const path of files) {
        const entry = await this.readRolloutLookupEntry(path, archived);
        if (entry) {
          lookup.set(entry.id, entry);
        }
      }
    }

    return lookup;
  }

  private async resolveSnapshotRollout(
    globalState: GlobalStateShape,
    indexEntries: SessionIndexEntry[]
  ): Promise<RolloutLookupEntry | null> {
    const sortedIndexEntries = [...indexEntries].sort((left, right) =>
      (right.updated_at ?? '').localeCompare(left.updated_at ?? '')
    );
    const candidateIds = sortedIndexEntries.slice(0, 100);
    if (candidateIds.length === 0) {
      return null;
    }

    const cacheKey = this.buildSnapshotRolloutCacheKey(globalState, candidateIds);
    if (this.snapshotRolloutCache?.key === cacheKey && this.snapshotRolloutCache.path) {
      const cachedEntry = await this.readRolloutLookupEntry(
        this.snapshotRolloutCache.path,
        this.snapshotRolloutCache.archived
      );
      if (cachedEntry) {
        return cachedEntry;
      }
    }

    const candidateRank = new Map(candidateIds.map((entry, index) => [entry.id, index]));
    const activeRoots = new Set(globalState['active-workspace-roots'] ?? []);
    let bestMatch: RolloutLookupEntry | null = null;
    let bestScore: [number, number, number] | null = null;

    const considerEntry = (entry: RolloutLookupEntry | null): RolloutLookupEntry | null => {
      if (!entry || entry.hiddenFromProjectThreads) {
        return null;
      }

      const rank = candidateRank.get(entry.id);
      if (rank === undefined) {
        return null;
      }

      const score: [number, number, number] = [
        entry.cwd && activeRoots.has(entry.cwd) ? 0 : 1,
        entry.archived ? 1 : 0,
        rank
      ];

      if (
        bestScore === null ||
        score[0] < bestScore[0] ||
        (score[0] === bestScore[0] && score[1] < bestScore[1]) ||
        (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] < bestScore[2])
      ) {
        bestMatch = entry;
        bestScore = score;
      }

      return bestScore?.[0] === 0 && bestScore?.[1] === 0 && bestScore?.[2] === 0
        ? bestMatch
        : null;
    };

    for (const [root, archived] of [
      [join(this.codexHome, 'sessions'), false],
      [join(this.codexHome, 'archived_sessions'), true]
    ] as const) {
      const files = await collectJsonlFiles(root);
      for (const path of files) {
        const perfectMatch = considerEntry(await this.readRolloutLookupEntry(path, archived));
        if (perfectMatch) {
          this.snapshotRolloutCache = {
            key: cacheKey,
            path: perfectMatch.path,
            archived: perfectMatch.archived
          };
          return perfectMatch;
        }
      }
    }

    const cachedBestMatch = bestMatch as RolloutLookupEntry | null;
    this.snapshotRolloutCache = {
      key: cacheKey,
      path: cachedBestMatch?.path ?? null,
      archived: cachedBestMatch?.archived ?? false
    };
    return cachedBestMatch;
  }

  private buildSnapshotRolloutCacheKey(
    globalState: GlobalStateShape,
    indexEntries: SessionIndexEntry[]
  ): string {
    return JSON.stringify({
      activeWorkspaceRoots: globalState['active-workspace-roots'] ?? [],
      recentSessions: indexEntries.map((entry) => ({
        id: entry.id,
        updatedAt: entry.updated_at
      }))
    });
  }

  private selectSnapshotRollout(
    globalState: GlobalStateShape,
    indexEntries: SessionIndexEntry[],
    rolloutLookup: Map<string, RolloutLookupEntry>
  ): RolloutLookupEntry | null {
    const indexById = new Map(indexEntries.map((entry) => [entry.id, entry]));
    const activeRoots = new Set(globalState['active-workspace-roots'] ?? []);
    const liveRollouts = [...rolloutLookup.values()].filter((rollout) => {
      if (rollout.archived || rollout.hiddenFromProjectThreads) {
        return false;
      }

      return Boolean(indexById.get(rollout.id)) || rollout.source === 'vscode';
    });
    const sortByUpdatedAt = (left: RolloutLookupEntry, right: RolloutLookupEntry): number =>
      (indexById.get(right.id)?.updated_at ?? right.timestamp ?? '').localeCompare(
        indexById.get(left.id)?.updated_at ?? left.timestamp ?? ''
      );
    const preferredRollouts =
      activeRoots.size > 0
        ? liveRollouts.filter((rollout) => rollout.cwd && activeRoots.has(rollout.cwd))
        : liveRollouts;

    return [...(preferredRollouts.length > 0 ? preferredRollouts : liveRollouts)].sort(
      sortByUpdatedAt
    )[0] ?? null;
  }

  private async readSnapshotRolloutSignals(path: string): Promise<SnapshotRolloutSignals> {
    const stream = createReadStream(path, { encoding: 'utf8' });
    const reader = createInterface({
      input: stream,
      crlfDelay: Infinity
    });
    const signals = emptySnapshotRolloutSignals();

    try {
      for await (const rawLine of reader) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        const parsed = parseJsonLine<{
          type?: unknown;
          payload?: Record<string, unknown>;
        }>(line);
        if (!parsed) continue;

        if (parsed.type === 'turn_context' && parsed.payload) {
          signals.permissionMode = normalizePermissionMode(
            parsed.payload.approval_policy,
            parsed.payload.sandbox_policy
          );
          continue;
        }

        if (
          parsed.type === 'event_msg' &&
          parsed.payload &&
          parsed.payload.type === 'token_count'
        ) {
          const rateLimitSignals = extractRateLimitSignals(parsed.payload.rate_limits);
          signals.primaryRateLimitRemainingPercent =
            rateLimitSignals.primaryRateLimitRemainingPercent;
          signals.primaryRateLimitWindowMinutes = rateLimitSignals.primaryRateLimitWindowMinutes;
          signals.primaryRateLimitResetsAt = rateLimitSignals.primaryRateLimitResetsAt;
          signals.weeklyRateLimitRemainingPercent =
            rateLimitSignals.weeklyRateLimitRemainingPercent;
          signals.weeklyRateLimitWindowMinutes = rateLimitSignals.weeklyRateLimitWindowMinutes;
          signals.weeklyRateLimitResetsAt = rateLimitSignals.weeklyRateLimitResetsAt;
        }
      }
    } finally {
      reader.close();
      stream.destroy();
    }

    return signals;
  }

  private async readLatestRateLimitSignals(): Promise<RateLimitSignals> {
    const recentRolloutFiles = await this.listMostRecentlyModifiedRolloutFiles(12);
    let latestObservation: RateLimitSignalObservation | null = null;

    for (const path of recentRolloutFiles) {
      const observation = await this.readLatestRateLimitSignalsFromRolloutTail(path);
      if (!observation) {
        continue;
      }

      const observationTimestamp = observation.timestamp ? Date.parse(observation.timestamp) : NaN;
      const latestTimestamp =
        latestObservation?.timestamp ? Date.parse(latestObservation.timestamp) : NaN;

      if (
        latestObservation === null ||
        (!Number.isNaN(observationTimestamp) &&
          (Number.isNaN(latestTimestamp) || observationTimestamp > latestTimestamp))
      ) {
        latestObservation = observation;
      }
    }

    return latestObservation?.signals ?? emptyRateLimitSignals();
  }

  private async listMostRecentlyModifiedRolloutFiles(limit: number): Promise<string[]> {
    const files = await collectJsonlFiles(join(this.codexHome, 'sessions'));
    const filesWithStats = await Promise.all(
      files.map(async (path) => ({
        path,
        mtimeMs: (await stat(path)).mtimeMs
      }))
    );

    return filesWithStats
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, limit)
      .map((entry) => entry.path);
  }

  private async readLatestRateLimitSignalsFromRolloutTail(
    path: string
  ): Promise<RateLimitSignalObservation | null> {
    const raw = await readJsonlTail(path);
    if (!raw) {
      return null;
    }

    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) {
        continue;
      }

      const parsed = parseJsonLine<{
        timestamp?: unknown;
        type?: unknown;
        payload?: Record<string, unknown>;
      }>(line);
      if (!parsed) continue;

      if (
        parsed.type === 'event_msg' &&
        parsed.payload &&
        parsed.payload.type === 'token_count'
      ) {
        return {
          timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : null,
          signals: extractRateLimitSignals(parsed.payload.rate_limits)
        };
      }
    }

    return null;
  }

  private mergeRateLimitSignals(
    primary: RateLimitSignals,
    fallback: SnapshotRolloutSignals
  ): RateLimitSignals {
    return {
      primaryRateLimitRemainingPercent:
        primary.primaryRateLimitRemainingPercent ?? fallback.primaryRateLimitRemainingPercent,
      primaryRateLimitWindowMinutes:
        primary.primaryRateLimitWindowMinutes ?? fallback.primaryRateLimitWindowMinutes,
      primaryRateLimitResetsAt:
        primary.primaryRateLimitResetsAt ?? fallback.primaryRateLimitResetsAt,
      weeklyRateLimitRemainingPercent:
        primary.weeklyRateLimitRemainingPercent ?? fallback.weeklyRateLimitRemainingPercent,
      weeklyRateLimitWindowMinutes:
        primary.weeklyRateLimitWindowMinutes ?? fallback.weeklyRateLimitWindowMinutes,
      weeklyRateLimitResetsAt:
        primary.weeklyRateLimitResetsAt ?? fallback.weeklyRateLimitResetsAt
    };
  }

  private async readRolloutLookupEntry(
    path: string,
    archived: boolean
  ): Promise<RolloutLookupEntry | null> {
    const firstLine = await readFirstNonEmptyJsonlLine(path);
    const meta = firstLine ? parseRolloutMeta(firstLine) : null;

    if (!meta?.id) {
      return null;
    }

    return {
      id: meta.id,
      cwd: meta.cwd,
      timestamp: meta.timestamp,
      path,
      archived,
      originator: meta.originator,
      cliVersion: meta.cli_version,
      hiddenFromProjectThreads: meta.hiddenFromProjectThreads,
      source: meta.source
    };
  }
}

export function createRolloutPathExample(id: string): string {
  return basename(id);
}
