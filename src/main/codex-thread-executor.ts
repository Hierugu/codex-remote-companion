import { CodexAppServerClient, type AppServerTurnStartOptions } from './app-server-client';
import { CodexLocalStore } from './codex-store';

interface AppServerClientLike {
  threadResume(threadId: string): Promise<{ thread?: { id: string } }>;
  turnStart(threadId: string, prompt: string, options?: AppServerTurnStartOptions): Promise<unknown>;
  waitForNotification(method: string, timeoutMs?: number): Promise<unknown>;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
  dispose(): Promise<void>;
}

export interface CodexThreadExecutionResult {
  threadId: string;
  assistantReply: string;
}

export type CodexProgressStage =
  | 'planning'
  | 'running'
  | 'running_tools'
  | 'applying_changes'
  | 'finalizing_reply';

const PROGRESS_MESSAGE_BY_STAGE: Record<CodexProgressStage, string> = {
  planning: 'Planning the next steps...',
  running: 'Running Codex...',
  running_tools: 'Running tools...',
  applying_changes: 'Applying changes...',
  finalizing_reply: 'Finalizing reply...'
};

export interface CodexThreadExecutionOptions {
  onProgress?: (message: string) => Promise<void> | void;
}

async function waitForAssistantAppend(
  store: CodexLocalStore,
  threadId: string,
  previousMessageCount: number,
  timeoutMs = 120000
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const thread = await store.readThread(threadId);
    const appendedAssistantMessage = getLastAssistantMessageText(
      thread.messages.slice(previousMessageCount)
    );

    if (thread.messages.length > previousMessageCount && appendedAssistantMessage) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for assistant append in thread ${threadId}.`);
}

function getLastAssistantMessageText(messages: Array<{ role: string; text: string }>): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && message.text) {
      return message.text;
    }
  }

  return null;
}

function resolveProgressStage(method: string, params: unknown): CodexProgressStage | null {
  if (method === 'turn/plan/updated') {
    return 'planning';
  }

  if (method === 'turn/started') {
    return 'running';
  }

  if (method === 'turn/diff/updated') {
    return 'applying_changes';
  }

  if (method === 'item/agentMessage/delta') {
    return 'finalizing_reply';
  }

  if ((method === 'item/started' || method === 'item/completed') && params && typeof params === 'object') {
    const itemType = (params as { item?: { type?: unknown } }).item?.type;
    if (typeof itemType !== 'string') {
      return null;
    }

    if (
      itemType === 'commandExecution' ||
      itemType === 'mcpToolCall' ||
      itemType === 'dynamicToolCall' ||
      itemType === 'webSearch'
    ) {
      return 'running_tools';
    }

    if (itemType === 'fileChange') {
      return 'applying_changes';
    }
  }

  return null;
}

export class CodexThreadExecutor {
  private clientPromise: Promise<AppServerClientLike> | null = null;

  constructor(
    private readonly store: CodexLocalStore,
    private readonly createClient: () => Promise<AppServerClientLike> = () =>
      CodexAppServerClient.start()
  ) {}

  async dispose(): Promise<void> {
    await this.resetClient();
  }

  async resumeAndRun(
    threadId: string,
    prompt: string,
    options?: CodexThreadExecutionOptions
  ): Promise<CodexThreadExecutionResult> {
    const before = await this.store.readThread(threadId);
    const previousMessageCount = before.messages.length;
    const client = await this.getClient();
    const cwd = before.cwd ?? process.cwd();
    let lastProgressStage: CodexProgressStage | null = null;
    const unsubscribe = client.onNotification((method, params) => {
      const nextStage = resolveProgressStage(method, params);
      if (!nextStage || nextStage === lastProgressStage || !options?.onProgress) {
        return;
      }

      lastProgressStage = nextStage;
      void options.onProgress(PROGRESS_MESSAGE_BY_STAGE[nextStage]);
    });

    try {
      const resumed = await client.threadResume(threadId);
      if (resumed.thread?.id !== threadId) {
        throw new Error(`thread/resume returned unexpected thread id for ${threadId}.`);
      }

      await client.turnStart(threadId, prompt, {
        cwd
      });
      await client.waitForNotification('turn/completed', 180000);
      await waitForAssistantAppend(this.store, threadId, previousMessageCount, 120000);

      const after = await this.store.readThread(threadId);
      const appendedAssistantReply = getLastAssistantMessageText(
        after.messages.slice(previousMessageCount)
      );

      if (!appendedAssistantReply) {
        throw new Error(`Assistant reply was not persisted for thread ${threadId}.`);
      }

      return {
        threadId,
        assistantReply: appendedAssistantReply
      };
    } catch (error) {
      await this.resetClient();
      throw error;
    } finally {
      unsubscribe();
    }
  }

  private async getClient(): Promise<AppServerClientLike> {
    if (!this.clientPromise) {
      this.clientPromise = this.createClient().catch((error) => {
        this.clientPromise = null;
        throw error;
      });
    }

    return this.clientPromise;
  }

  private async resetClient(): Promise<void> {
    const existingClientPromise = this.clientPromise;
    this.clientPromise = null;

    if (!existingClientPromise) {
      return;
    }

    const client = await existingClientPromise.catch(() => null);
    if (client) {
      await client.dispose().catch(() => {
        // Ignore cleanup errors while resetting the cached app-server client.
      });
    }
  }
}
