import { readFile, stat } from 'node:fs/promises';

import type { CodexThreadMessage, CodexThreadRecord, CodexThreadSummary } from '@shared/contracts';

import { getCompanionStatePath } from './companion-paths';
import { writeJsonAtomically } from './json-file';
import type { PersistentBackendRegistry } from './backend-registry';
import type { CodexLocalStore } from './codex-store';
import type { TelegramService } from './telegram-service';

interface ThreadStore {
  listThreads(limit: number): Promise<CodexThreadSummary[]>;
  readThread(threadId: string): Promise<CodexThreadRecord>;
}

interface Registry {
  readState(): ReturnType<PersistentBackendRegistry['readState']>;
}

interface TelegramSender {
  sendThreadReply(input: { projectThreadId: string; text: string; format?: 'markdown' }): ReturnType<TelegramService['sendThreadReply']>;
}

interface CursorState {
  version: 1;
  cursors: Record<string, number>;
}

interface LinkedThread {
  codexThreadId: string;
  projectThreadId: string;
  path: string;
}

const POLL_INTERVAL_MS = 3000;
const MAX_MESSAGE_LENGTH = 3900;
const MAX_RICH_MESSAGE_BYTES = 30000;

function isMirrorable(message: CodexThreadMessage): boolean {
  return message.sourceType === 'response_item.message' &&
    ((message.role === 'user' && !message.isHarnessGenerated) ||
      (message.role === 'assistant' && message.phase === 'final_answer'));
}

function splitMessage(text: string, prefix: string): string[] {
  const characters = Array.from(text);
  const chunkSize = MAX_MESSAGE_LENGTH - prefix.length;
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += chunkSize) {
    chunks.push(prefix + characters.slice(index, index + chunkSize).join(''));
  }
  return chunks;
}

export class CodexOutboundPoller {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private cursors: Record<string, number> = {};
  private linkedThreads: LinkedThread[] = [];
  private registryUpdatedAt: string | null = null;
  private readonly mtimes = new Map<string, number>();
  private readonly suspended = new Set<string>();

  constructor(
    private readonly codexStore: ThreadStore,
    private readonly registry: Registry,
    private readonly telegram: TelegramSender,
    private readonly statePath = getCompanionStatePath('codex-outbound-cursors.json')
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.cursors = await this.readCursors();
    await this.pollOnce();
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
    this.loopPromise = null;
  }

  suspendThread(threadId: string): void {
    this.suspended.add(threadId);
  }

  async resumeThread(threadId: string): Promise<void> {
    try {
      const thread = await this.codexStore.readThread(threadId);
      this.cursors[threadId] = thread.messages.length;
      await this.writeCursors();
    } finally {
      this.suspended.delete(threadId);
    }
  }

  async pollOnce(): Promise<void> {
    await this.refreshLinks();
    for (const link of this.linkedThreads) {
      if (this.suspended.has(link.codexThreadId)) continue;

      let fileStat;
      try {
        fileStat = await stat(link.path);
      } catch {
        continue;
      }
      if (this.mtimes.get(link.codexThreadId) === fileStat.mtimeMs) continue;

      const thread = await this.codexStore.readThread(link.codexThreadId);
      const previousCount = this.cursors[link.codexThreadId];
      if (previousCount === undefined || previousCount > thread.messages.length) {
        this.cursors[link.codexThreadId] = thread.messages.length;
        await this.writeCursors();
        this.mtimes.set(link.codexThreadId, fileStat.mtimeMs);
        continue;
      }

      for (let index = previousCount; index < thread.messages.length; index += 1) {
        if (this.suspended.has(link.codexThreadId)) break;
        const message = thread.messages[index];
        if (message && isMirrorable(message) && message.text.trim()) {
          if (message.role === 'assistant' && Buffer.byteLength(message.text, 'utf8') <= MAX_RICH_MESSAGE_BYTES) {
            await this.telegram.sendThreadReply({
              projectThreadId: link.projectThreadId,
              text: `🤖\n${message.text}`,
              format: 'markdown'
            });
          } else {
            const prefix = message.role === 'user' ? '👤 ' : '🤖 ';
            for (const text of splitMessage(message.text, prefix)) {
              await this.telegram.sendThreadReply({ projectThreadId: link.projectThreadId, text });
            }
          }
        }
        this.cursors[link.codexThreadId] = index + 1;
        await this.writeCursors();
      }
      if (!this.suspended.has(link.codexThreadId)) {
        this.mtimes.set(link.codexThreadId, fileStat.mtimeMs);
      }
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        console.error('Codex outbound sync failed:', error);
      }
      if (this.running) {
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }
  }

  private async refreshLinks(): Promise<void> {
    const registryState = await this.registry.readState();
    if (registryState.updatedAt === this.registryUpdatedAt) return;
    const codexByProjectThread = new Map(
      registryState.codexThreadBindings.map((binding) => [binding.projectThreadId, binding.codexThreadId])
    );
    const threads = await this.codexStore.listThreads(1500);
    const paths = new Map(threads.map((thread) => [thread.id, thread.path]));
    this.linkedThreads = registryState.platformBindings
      .filter((binding) => binding.platform === 'telegram' && binding.bindingType === 'thread-surface' && binding.projectThreadId)
      .map((binding) => {
        const codexThreadId = codexByProjectThread.get(binding.projectThreadId!);
        const path = codexThreadId ? paths.get(codexThreadId) : null;
        return codexThreadId && path
          ? { codexThreadId, projectThreadId: binding.projectThreadId!, path }
          : null;
      })
      .filter((link): link is LinkedThread => link !== null);
    this.registryUpdatedAt = registryState.updatedAt;
  }

  private async readCursors(): Promise<Record<string, number>> {
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8')) as CursorState;
      return state.version === 1 && state.cursors && typeof state.cursors === 'object'
        ? state.cursors
        : {};
    } catch {
      return {};
    }
  }

  private async writeCursors(): Promise<void> {
    await writeJsonAtomically(this.statePath, { version: 1, cursors: this.cursors });
  }
}

export function createCodexOutboundPoller(
  codexStore: CodexLocalStore,
  registry: PersistentBackendRegistry,
  telegram: TelegramService
): CodexOutboundPoller {
  return new CodexOutboundPoller(codexStore, registry, telegram);
}
