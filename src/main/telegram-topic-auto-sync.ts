import { readFile } from 'node:fs/promises';

import type { CodexProjectThreadOption, TelegramTopicSyncRowStatus } from '@shared/contracts';

import type { PersistentBackendRegistry } from './backend-registry';
import type { CodexLocalStore } from './codex-store';
import { getCompanionStatePath } from './companion-paths';
import { parseJsonWithRecovery, writeJsonAtomically } from './json-file';
import type { TelegramConfigStore } from './telegram-config';
import { TelegramApiError, type TelegramBotProvider } from './telegram-provider';
import { TelegramTopicCreationGate } from './telegram-topic-gate';

type JobStatus = 'queued' | 'creating' | 'created' | 'needsReview';

interface TopicJob {
  rowId: string;
  codexThreadId: string;
  status: JobStatus;
  topicId?: number;
  retryAt?: number;
  reason?: string;
}

interface TopicJobFile {
  version: 1;
  rateLimitUntil?: number;
  jobs: Record<string, TopicJob>;
}

interface Candidate {
  rowId: string;
  projectId: string;
  chatId: string;
  botToken: string;
  machineId: string;
  projectThreadId: string;
  thread: CodexProjectThreadOption;
}

const POLL_INTERVAL_MS = 30_000;

function jobKey(rowId: string, threadId: string): string {
  return `${rowId}:${threadId}`;
}

function topicName(title: string): string {
  return Array.from(title).slice(0, 128).join('') || 'Codex chat';
}

export class TelegramTopicAutoSync {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly configStore: Pick<TelegramConfigStore, 'readState'>,
    private readonly codexStore: Pick<CodexLocalStore, 'listProjectThreadOptions'>,
    private readonly registry: Pick<PersistentBackendRegistry, 'readState' | 'linkCodexThreadToTelegramTopic'>,
    private readonly provider: Pick<TelegramBotProvider, 'createForumTopic' | 'editForumTopic'>,
    private readonly topicGate: TelegramTopicCreationGate,
    private readonly statePath = getCompanionStatePath('telegram-topic-jobs.json'),
    private readonly onError: (message: string) => void = console.error
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  async getStatus(): Promise<TelegramTopicSyncRowStatus[]> {
    const { candidates, rowIds } = await this.scan();
    const jobs = (await this.readJobs()).jobs;
    return rowIds.map((rowId) => {
      const rowCandidates = candidates.filter((candidate) => candidate.rowId === rowId);
      const needsReview = rowCandidates.flatMap((candidate) => {
        const job = jobs[jobKey(rowId, candidate.thread.id)];
        return job?.status === 'needsReview' || job?.status === 'creating'
          ? [{
              rowId,
              codexThreadId: candidate.thread.id,
              title: candidate.thread.title,
              reason: job.reason ?? 'Topic creation result is unknown.'
            }]
          : [];
      });
      const lastError = rowCandidates
        .map((candidate) => jobs[jobKey(rowId, candidate.thread.id)]?.reason)
        .find((reason): reason is string => Boolean(reason)) ?? null;
      return {
        rowId,
        pending: rowCandidates.length - needsReview.length,
        needsReview,
        lastError
      };
    });
  }

  async retry(rowId: string, codexThreadId: string): Promise<void> {
    const state = await this.readJobs();
    const key = jobKey(rowId, codexThreadId);
    const job = state.jobs[key];
    if (!job || job.status !== 'needsReview') {
      throw new Error('This topic does not need a manual retry.');
    }
    state.jobs[key] = { rowId, codexThreadId, status: 'queued' };
    await this.writeJobs(state);
    if (this.running) void this.tick();
  }

  async attach(rowId: string, codexThreadId: string, topicId: number): Promise<void> {
    if (!Number.isSafeInteger(topicId) || topicId <= 0) {
      throw new Error('Telegram topic ID must be a positive integer.');
    }
    const state = await this.readJobs();
    const key = jobKey(rowId, codexThreadId);
    if (state.jobs[key]?.status !== 'needsReview') {
      throw new Error('This topic does not need manual attachment.');
    }
    const { candidates } = await this.scan();
    const candidate = candidates.find((item) => item.rowId === rowId && item.thread.id === codexThreadId);
    if (!candidate) throw new Error('The Codex chat is no longer available for this project.');

    await this.topicGate.run(`${candidate.chatId}:project-thread:${codexThreadId}`, async () => {
      try {
        await this.provider.editForumTopic(
          candidate.botToken, candidate.chatId, topicId, topicName(candidate.thread.title)
        );
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('TOPIC_NOT_MODIFIED')) throw error;
      }
      await this.link(candidate, topicId);
      await this.removeJob(key);
    });
  }

  async runOnce(): Promise<void> {
    const { candidates } = await this.scan();
    const state = await this.readJobs();
    if ((state.rateLimitUntil ?? 0) > Date.now()) return;
    for (const candidate of candidates) {
      const key = jobKey(candidate.rowId, candidate.thread.id);
      const job = state.jobs[key];
      if (job?.status === 'needsReview') continue;
      if (job?.status === 'creating') {
        state.jobs[key] = {
          ...job,
          status: 'needsReview',
          reason: 'Companion stopped while creating this topic. Check Telegram before retrying.'
        };
        await this.writeJobs(state);
        continue;
      }
      if (job?.status === 'queued' && (job.retryAt ?? 0) > Date.now()) continue;

      await this.topicGate.run(`${candidate.chatId}:project-thread:${candidate.thread.id}`, async () => {
        const current = await this.registry.readState();
        if (this.hasBinding(current.platformBindings, candidate)) {
          await this.removeJob(key);
          return;
        }
        if (job?.status === 'created' && job.topicId) {
          await this.link(candidate, job.topicId);
          await this.removeJob(key);
          return;
        }

        await this.setJob(key, {
          rowId: candidate.rowId,
          codexThreadId: candidate.thread.id,
          status: 'creating'
        });
        let topic;
        try {
          topic = await this.provider.createForumTopic(
            candidate.botToken, candidate.chatId, topicName(candidate.thread.title)
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof TelegramApiError && error.status === 429) {
            const retryAt = Date.now() + ((error.retryAfterSeconds ?? 30) + 1) * 1000;
            await this.setJob(key, {
              rowId: candidate.rowId,
              codexThreadId: candidate.thread.id,
              status: 'queued',
              retryAt,
              reason: message
            }, retryAt);
          } else {
            await this.setJob(key, {
              rowId: candidate.rowId,
              codexThreadId: candidate.thread.id,
              status: 'needsReview',
              reason: `Topic creation result is uncertain: ${message}`
            });
          }
          return;
        }

        await this.setJob(key, {
          rowId: candidate.rowId,
          codexThreadId: candidate.thread.id,
          status: 'created',
          topicId: topic.messageThreadId
        });
        await this.link(candidate, topic.messageThreadId);
        await this.removeJob(key);
      });
      return; // One creation per polling interval limits bursts after long offline periods.
    }
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = this.runOnce().catch((error) => {
      this.onError(`Telegram topic auto-sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { this.inFlight = null; });
    await this.inFlight;
  }

  private async scan(): Promise<{ candidates: Candidate[]; rowIds: string[] }> {
    const config = await this.configStore.readState();
    if (!config.botToken) return { candidates: [], rowIds: [] };
    const rows = config.rows.filter((row) => row.setupCompletedAt);
    const registry = await this.registry.readState();
    const machineId = registry.localMachines[0]?.machineId;
    if (!machineId) return { candidates: [], rowIds: rows.map((row) => row.id) };

    const threadsByProject = new Map<string, CodexProjectThreadOption[]>();
    const candidates: Candidate[] = [];
    for (const row of rows) {
      let threads = threadsByProject.get(row.projectId);
      if (!threads) {
        threads = await this.codexStore.listProjectThreadOptions(row.projectId);
        threadsByProject.set(row.projectId, threads);
      }
      for (const thread of threads) {
        if (thread.archived || !thread.title || thread.title === thread.id) continue;
        const projectThreadId = registry.codexThreadBindings.find((binding) =>
          binding.codexThreadId === thread.id
        )?.projectThreadId ?? `project-thread:${thread.id}`;
        const candidate = {
          rowId: row.id,
          projectId: row.projectId,
          chatId: row.forumGroupId,
          botToken: config.botToken,
          machineId,
          projectThreadId,
          thread
        };
        if (!this.hasBinding(registry.platformBindings, candidate)) candidates.push(candidate);
      }
    }
    return { candidates, rowIds: rows.map((row) => row.id) };
  }

  private hasBinding(
    bindings: Array<{ platform: string; bindingType: string; projectThreadId: string | null; surfaceId: string }>,
    candidate: Candidate
  ): boolean {
    return bindings.some((binding) =>
      binding.platform === 'telegram' &&
      binding.bindingType === 'thread-surface' &&
      binding.projectThreadId === candidate.projectThreadId &&
      binding.surfaceId.startsWith(`telegram:topic:${candidate.chatId}:`)
    );
  }

  private async link(candidate: Candidate, topicId: number): Promise<void> {
    await this.registry.linkCodexThreadToTelegramTopic({
      projectId: candidate.projectId,
      codexThreadId: candidate.thread.id,
      machineId: candidate.machineId,
      title: candidate.thread.title,
      archived: candidate.thread.archived,
      chatId: candidate.chatId,
      messageThreadId: topicId
    });
  }

  private async readJobs(): Promise<TopicJobFile> {
    try {
      const raw = await readFile(this.statePath, 'utf8');
      const { value } = parseJsonWithRecovery<TopicJobFile>(raw);
      return value.version === 1 && value.jobs && typeof value.jobs === 'object'
        ? value : { version: 1, jobs: {} };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { version: 1, jobs: {} };
      }
      throw error;
    }
  }

  private async writeJobs(state: TopicJobFile): Promise<void> {
    await writeJsonAtomically(this.statePath, state);
  }

  private async setJob(key: string, job: TopicJob, rateLimitUntil?: number): Promise<void> {
    const state = await this.readJobs();
    state.jobs[key] = job;
    if (rateLimitUntil) state.rateLimitUntil = Math.max(state.rateLimitUntil ?? 0, rateLimitUntil);
    await this.writeJobs(state);
  }

  private async removeJob(key: string): Promise<void> {
    const state = await this.readJobs();
    if (!(key in state.jobs)) return;
    delete state.jobs[key];
    await this.writeJobs(state);
  }
}
