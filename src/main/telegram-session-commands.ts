import { readFile } from 'node:fs/promises';

import type { TelegramProjectSyncRow } from '@shared/contracts';

import { CodexAppServerClient } from './app-server-client';
import type { PersistentBackendRegistry } from './backend-registry';
import type { CodexLocalStore } from './codex-store';
import { getCompanionStatePath } from './companion-paths';
import { writeJsonAtomically } from './json-file';
import type { TelegramConfigStore } from './telegram-config';
import type { TelegramBotProvider, TelegramUpdateMessage } from './telegram-provider';
import type { TelegramTopicAutoSync } from './telegram-topic-auto-sync';
import { TelegramTopicCreationGate } from './telegram-topic-gate';

interface CommandRequest {
  updateId: number;
  chatId: string;
  messageThreadId: number | null;
  kind: 'new' | 'fork';
  name: string;
  rowIds: string[];
  sourceThreadId?: string;
  selectedRowId?: string;
  status: 'selecting' | 'creating' | 'created' | 'queued' | 'needsReview';
  threadId?: string;
  error?: string;
}

interface CommandFile {
  version: 1;
  requests: Record<string, CommandRequest>;
}

interface AppServerSession {
  threadStart(cwd: string): Promise<{ thread?: { id: string } }>;
  threadFork(threadId: string): Promise<{ thread?: { id: string } }>;
  threadSetName(threadId: string, name: string): Promise<void>;
  dispose(): Promise<void>;
}

const PREFIX = 'crc:new:';

export class TelegramSessionCommands {
  private readonly stateGate = new TelegramTopicCreationGate();
  private readonly executionGate = new TelegramTopicCreationGate();

  constructor(
    private readonly configStore: Pick<TelegramConfigStore, 'readState'>,
    private readonly registry: Pick<PersistentBackendRegistry, 'readState'>,
    private readonly codexStore: Pick<CodexLocalStore, 'listProjectOptions'>,
    private readonly provider: Pick<TelegramBotProvider, 'sendMessage' | 'answerCallbackQuery'>,
    private readonly topicSync: Pick<TelegramTopicAutoSync, 'enqueue'>,
    private readonly startAppServer: () => Promise<AppServerSession> = () => CodexAppServerClient.start(),
    private readonly statePath = getCompanionStatePath('telegram-session-commands.json')
  ) {}

  async recoverPending(): Promise<void> {
    const state = await this.readState();
    for (const request of Object.values(state.requests)) {
      if (request.status === 'created' && request.threadId && request.selectedRowId) {
        await this.execute(request, request.selectedRowId);
      }
    }
  }

  async handleMessage(updateId: number, message: TelegramUpdateMessage): Promise<boolean> {
    if (/^\/help(?:@\w+)?$/i.test(message.text?.trim() ?? '') &&
      (message.messageThreadId == null || message.messageThreadId === 1)) {
      const config = await this.configStore.readState();
      if (!config.rows.some((row) => row.forumGroupId === message.chatId && row.setupCompletedAt)) return false;
      await this.reply(message.chatId, null,
        'Group commands:\n/new <name> — create a Codex chat; choose its project with a button.\n' +
        '/fork <name> — send inside an existing chat topic to fork its history.\n' +
        '/release — close VS Code or Codex app after confirmation.');
      return true;
    }
    const match = /^\/(new|fork)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(message.text?.trim() ?? '');
    if (!match) return false;
    const kind = match[1]!.toLowerCase() as 'new' | 'fork';
    const name = match[2]?.trim() ?? '';
    if (!name || name.length > 200) {
      await this.reply(message.chatId, message.messageThreadId,
        `Usage: /${kind} <name> (1–200 characters).`);
      return true;
    }

    const config = await this.configStore.readState();
    const rows = config.rows.filter((row) =>
      row.forumGroupId === message.chatId && row.setupCompletedAt
    );
    if (!config.botToken || rows.length === 0) return false;

    const existing = (await this.readState()).requests[String(updateId)];
    if (existing?.status === 'queued') return true;
    if (existing?.status === 'created' && existing.selectedRowId) {
      await this.execute(existing, existing.selectedRowId);
      return true;
    }
    if (existing?.status === 'creating' || existing?.status === 'needsReview') {
      await this.reply(message.chatId, message.messageThreadId,
        'The previous creation result is uncertain. Check Codex before sending the command again.');
      return true;
    }

    const topic = await this.findTopic(message.chatId, message.messageThreadId);
    if (kind === 'fork' && !topic) {
      await this.reply(message.chatId, message.messageThreadId,
        'Send /fork inside the topic of the chat you want to fork.');
      return true;
    }
    const eligibleRows = topic
      ? rows.filter((row) => row.projectId === topic.projectId)
      : rows;
    if (eligibleRows.length === 0) {
      await this.reply(message.chatId, message.messageThreadId,
        'This Codex project is not connected to this Telegram group.');
      return true;
    }
    const request: CommandRequest = existing ?? {
      updateId, chatId: message.chatId, messageThreadId: message.messageThreadId,
      kind, name, rowIds: eligibleRows.map((row) => row.id),
      sourceThreadId: topic?.codexThreadId,
      status: 'selecting'
    };
    await this.saveRequest(request);
    if (request.rowIds.length === 1) {
      await this.execute(request, request.rowIds[0]!);
    } else {
      await this.showProjectPicker(config.botToken, request, eligibleRows);
    }
    return true;
  }

  async handleCallback(input: {
    id: string; data: string | null; chatId: string | null; senderId: string;
  }): Promise<boolean> {
    if (!input.data?.startsWith(PREFIX)) return false;
    const config = await this.configStore.readState();
    if (!config.botToken) return true;
    if (input.senderId !== config.ownerUserId) {
      await this.provider.answerCallbackQuery(config.botToken, input.id, 'Only the configured owner can do this.');
      return true;
    }
    const match = /^crc:new:(\d+):(\d+)$/.exec(input.data);
    const request = match ? (await this.readState()).requests[match[1]!] : null;
    const rowId = request?.rowIds[Number(match?.[2])];
    if (!request || !rowId || request.chatId !== input.chatId) {
      await this.provider.answerCallbackQuery(config.botToken, input.id, 'This project choice has expired.');
      return true;
    }
    if (request.status === 'created' && request.selectedRowId) {
      await this.provider.answerCallbackQuery(config.botToken, input.id, 'Finishing the Telegram topic…');
      await this.execute(request, request.selectedRowId);
      return true;
    }
    if (request.status !== 'selecting') {
      await this.provider.answerCallbackQuery(config.botToken, input.id, 'Already processed.');
      return true;
    }
    await this.provider.answerCallbackQuery(config.botToken, input.id, 'Creating Codex chat…');
    await this.execute(request, rowId);
    return true;
  }

  private async execute(request: CommandRequest, rowId: string): Promise<void> {
    await this.executionGate.run(String(request.updateId), async () => {
      const current = (await this.readState()).requests[String(request.updateId)] ?? request;
      if (current.status === 'queued' || current.status === 'creating' || current.status === 'needsReview') return;
      await this.executeOnce(current, rowId);
    });
  }

  private async executeOnce(request: CommandRequest, rowId: string): Promise<void> {
    const config = await this.configStore.readState();
    const row = config.rows.find((item) => item.id === rowId && item.forumGroupId === request.chatId && item.setupCompletedAt);
    const project = (await this.codexStore.listProjectOptions()).find((item) => item.id === row?.projectId);
    if (!row || !project?.cwd) {
      await this.reply(request.chatId, request.messageThreadId, 'The selected Codex project is unavailable.');
      return;
    }

    request.selectedRowId = rowId;
    request.status = request.threadId ? 'created' : 'creating';
    await this.saveRequest(request);
    try {
      const appServer = await this.startAppServer();
      try {
        if (!request.threadId) {
          const result = request.kind === 'fork'
            ? await appServer.threadFork(request.sourceThreadId!)
            : await appServer.threadStart(project.cwd);
          const threadId = result.thread?.id;
          if (!threadId) throw new Error('Codex did not return a thread ID.');
          request.threadId = threadId;
          request.status = 'created';
          await this.saveRequest(request);
        }
        await appServer.threadSetName(request.threadId, request.name);
      } finally {
        await appServer.dispose();
      }
      await this.topicSync.enqueue(row.id, request.threadId!, row.projectId, request.name);
      request.status = 'queued';
      await this.saveRequest(request);
      await this.reply(request.chatId, request.messageThreadId,
        `Created Codex chat “${request.name}”. Its Telegram topic will appear shortly.`);
    } catch (error) {
      request.status = request.threadId ? 'created' : 'needsReview';
      request.error = error instanceof Error ? error.message : String(error);
      await this.saveRequest(request);
      await this.reply(request.chatId, request.messageThreadId,
        `Could not finish creating this chat: ${request.error}. Check Codex before retrying.`);
    }
  }

  private async showProjectPicker(token: string, request: CommandRequest, rows: TelegramProjectSyncRow[]): Promise<void> {
    const projects = await this.codexStore.listProjectOptions();
    const labels = new Map(projects.map((project) => [project.id, `${project.name} · ${project.cwd}`]));
    await this.provider.sendMessage(token, {
      chatId: request.chatId, messageThreadId: request.messageThreadId === 1 ? null : request.messageThreadId,
      text: `Choose a project for “${request.name}”:`,
      inlineKeyboard: rows.map((row, index) => [{
        text: (labels.get(row.projectId) ?? row.projectId).slice(0, 64),
        callbackData: `${PREFIX}${request.updateId}:${index}`
      }])
    });
  }

  private async findTopic(chatId: string, topicId: number | null): Promise<{ projectId: string; codexThreadId: string } | null> {
    if (topicId == null || topicId === 1) return null;
    const state = await this.registry.readState();
    const binding = state.platformBindings.find((item) =>
      item.platform === 'telegram' && item.bindingType === 'thread-surface' &&
      item.surfaceId === `telegram:topic:${chatId}:${topicId}`
    );
    const codex = state.codexThreadBindings.find((item) => item.projectThreadId === binding?.projectThreadId);
    return binding?.projectId && codex
      ? { projectId: binding.projectId, codexThreadId: codex.codexThreadId } : null;
  }

  private async reply(chatId: string, messageThreadId: number | null, text: string): Promise<void> {
    const token = (await this.configStore.readState()).botToken;
    if (token) await this.provider.sendMessage(token, {
      chatId, messageThreadId: messageThreadId === 1 ? null : messageThreadId, text
    });
  }

  private async readState(): Promise<CommandFile> {
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8')) as CommandFile;
      return state.version === 1 && state.requests ? state : { version: 1, requests: {} };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { version: 1, requests: {} };
      throw error;
    }
  }

  private async saveRequest(request: CommandRequest): Promise<void> {
    await this.stateGate.run('commands-file', async () => {
      const state = await this.readState();
      state.requests[String(request.updateId)] = { ...request };
      await writeJsonAtomically(this.statePath, state);
    });
  }
}
