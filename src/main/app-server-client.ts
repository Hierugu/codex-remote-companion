import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export function resolveCodexCliExecutable(): string {
  const appRoots = [
    '/Applications/ChatGPT.app',
    join(homedir(), 'Applications', 'ChatGPT.app'),
    '/Applications/Codex.app',
    join(homedir(), 'Applications', 'Codex.app')
  ];
  for (const appRoot of appRoots) {
    const bundledCli = join(appRoot, 'Contents', 'Resources', 'codex-cli', 'bin', 'codex');
    if (existsSync(bundledCli)) {
      return bundledCli;
    }
  }
  return 'codex';
}

interface JsonRpcLiteResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
  params?: unknown;
}

interface AppServerThreadSummary {
  id: string;
}

interface AppServerThreadListResponse {
  data?: {
    threads?: AppServerThreadSummary[];
  };
  threads?: AppServerThreadSummary[];
}

interface AppServerThreadStartResponse {
  thread?: { id: string };
}

interface AppServerThreadReadResponse {
  thread?: { id: string };
}

interface AppServerThreadResumeResponse {
  thread?: { id: string };
}

interface AppServerTurnStartResponse {
  turn?: { id: string; status?: string };
}

export interface AppServerModelListEntry {
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: Array<{
    reasoningEffort: string;
    description: string;
  }>;
}

interface AppServerModelListResponse {
  data?: AppServerModelListEntry[];
  nextCursor?: string | null;
}

export interface AppServerTurnStartOptions {
  cwd?: string | null;
  approvalPolicy?: string | null;
  sandboxPolicy?: Record<string, unknown> | null;
  model?: string | null;
  effort?: string | null;
}

export interface AppServerThreadProbeResult {
  listedThreadCount: number;
  listedThreadIds: string[];
  resumedThreadId: string | null;
  readThreadId: string | null;
}

interface NotificationWaiter {
  method: string;
  resolve: (params: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

type NotificationListener = (method: string, params: unknown) => void;

export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;

  private readonly readlineInterface;

  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  private readonly notificationWaiters = new Set<NotificationWaiter>();

  private readonly notificationListeners = new Set<NotificationListener>();

  private nextRequestId = 1;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.readlineInterface = createInterface({ input: child.stdout });
    this.readlineInterface.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', () => {
      // Ignore tracing chatter for now. The runtime test cares about responses, not logs.
    });
    child.on('exit', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('codex app-server exited before responding.'));
      }
      this.pending.clear();
    });
  }

  static async start(): Promise<CodexAppServerClient> {
    const child = spawn(resolveCodexCliExecutable(), ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const client = new CodexAppServerClient(child);
    await client.initialize();
    return client;
  }

  async dispose(): Promise<void> {
    this.readlineInterface.close();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('codex app-server client disposed before notification arrived.'));
    }
    this.notificationWaiters.clear();
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => this.child.kill('SIGKILL'), 5000);
      this.child.once('exit', () => {
        clearTimeout(forceKill);
        resolve();
      });
      this.child.kill('SIGTERM');
    });
  }

  async threadStart(cwd: string): Promise<AppServerThreadStartResponse> {
    return this.request<AppServerThreadStartResponse>('thread/start', {
      cwd
    });
  }

  async threadFork(threadId: string): Promise<AppServerThreadStartResponse> {
    return this.request<AppServerThreadStartResponse>('thread/fork', {
      threadId,
      excludeTurns: true
    });
  }

  async threadSetName(threadId: string, name: string): Promise<void> {
    await this.request('thread/name/set', { threadId, name });
  }

  async threadList(limit = 5): Promise<AppServerThreadListResponse> {
    return this.request<AppServerThreadListResponse>('thread/list', { limit });
  }

  async threadRead(threadId: string): Promise<AppServerThreadReadResponse> {
    return this.request<AppServerThreadReadResponse>('thread/read', {
      threadId,
      includeTurns: false
    });
  }

  async threadResume(threadId: string): Promise<AppServerThreadResumeResponse> {
    return this.request<AppServerThreadResumeResponse>('thread/resume', {
      threadId,
      excludeTurns: true
    });
  }

  async turnStart(
    threadId: string,
    prompt: string,
    options: AppServerTurnStartOptions = {}
  ): Promise<AppServerTurnStartResponse> {
    return this.request<AppServerTurnStartResponse>('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
      cwd: options.cwd ?? process.cwd(),
      approvalPolicy: options.approvalPolicy ?? undefined,
      sandboxPolicy: options.sandboxPolicy ?? undefined,
      model: options.model ?? undefined,
      effort: options.effort ?? undefined
    });
  }

  async modelList(limit = 100): Promise<AppServerModelListResponse> {
    return this.request<AppServerModelListResponse>('model/list', {
      includeHidden: false,
      limit
    });
  }

  async configBatchWrite(
    edits: Array<{
      keyPath: string;
      value: unknown;
      mergeStrategy?: 'replace' | 'upsert';
    }>,
    reloadUserConfig = true
  ): Promise<void> {
    await this.request('config/batchWrite', {
      edits: edits.map((edit) => ({
        keyPath: edit.keyPath,
        value: edit.value,
        mergeStrategy: edit.mergeStrategy ?? 'upsert'
      })),
      reloadUserConfig
    });
  }

  async waitForNotification(method: string, timeoutMs = 120000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = {
        method,
        resolve: (params) => {
          clearTimeout(waiter.timeout);
          this.notificationWaiters.delete(waiter);
          resolve(params);
        },
        reject: (error) => {
          clearTimeout(waiter.timeout);
          this.notificationWaiters.delete(waiter);
          reject(error);
        },
        timeout: setTimeout(() => {
          this.notificationWaiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${method} notification.`));
        }, timeoutMs)
      };

      this.notificationWaiters.add(waiter);
    });
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);

    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  async probeThreadReadSurface(): Promise<AppServerThreadProbeResult> {
    const listed = await this.threadList();
    const threads = listed.data?.threads ?? listed.threads ?? [];
    const listedThreadIds = threads
      .map((thread) => thread.id)
      .filter((id): id is string => typeof id === 'string');

    if (listedThreadIds.length === 0) {
      return {
        listedThreadCount: threads.length,
        listedThreadIds,
        resumedThreadId: null,
        readThreadId: null
      };
    }

    const firstThreadId = listedThreadIds[0];
    const [read, resumed] = await Promise.all([
      this.threadRead(firstThreadId),
      this.threadResume(firstThreadId)
    ]);

    return {
      listedThreadCount: threads.length,
      listedThreadIds,
      resumedThreadId: resumed.thread?.id ?? null,
      readThreadId: read.thread?.id ?? null
    };
  }

  private async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'codex_remote_companion',
        title: 'Codex Remote Companion',
        version: '0.1.0'
      }
    });

    this.notify('initialized', {});
  }

  private request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextRequestId++;

    const payload = JSON.stringify({
      method,
      id,
      params
    });

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} response.`));
      }, 60000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout
      });
      this.child.stdin.write(`${payload}\n`);
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(
      `${JSON.stringify({
        method,
        params
      })}\n`
    );
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const parsed = JSON.parse(trimmed) as JsonRpcLiteResponse;
    if (typeof parsed.id === 'number' && this.pending.has(parsed.id)) {
      const request = this.pending.get(parsed.id)!;
      this.pending.delete(parsed.id);

      if (parsed.error) {
        request.reject(
          new Error(parsed.error.message ?? `app-server request ${parsed.id} failed`)
        );
        return;
      }

      request.resolve(parsed.result);
      return;
    }

    if (typeof parsed.method === 'string' && parsed.id == null) {
      for (const listener of this.notificationListeners) {
        listener(parsed.method, parsed.params);
      }

      for (const waiter of this.notificationWaiters) {
        if (waiter.method === parsed.method) {
          waiter.resolve(parsed.params);
        }
      }
    }
  }
}
