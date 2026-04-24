import { randomUUID } from 'node:crypto';

import type {
  BackendPlatformBindingRecord,
  BackendProjectThreadRecord,
  NormalizedInboundEvent,
  TelegramConnectionState,
  TelegramProjectSyncRowInput,
  TelegramRemoveBotTokenResult,
  TelegramRepairResult,
  TelegramSetBotTokenResult,
  TelegramSyncResult
} from '@shared/contracts';

import { PersistentBackendRegistry } from './backend-registry';
import { TelegramConfigStore } from './telegram-config';
import type {
  TelegramBotProvider,
  TelegramSendMessageResult,
  TelegramSendMessageInput
} from './telegram-provider';

function buildProjectSurfaceId(chatId: string): string {
  return `telegram:chat:${chatId}`;
}

function buildThreadSurfaceId(chatId: string, messageThreadId: number): string {
  return `telegram:topic:${chatId}:${messageThreadId}`;
}

function parseThreadSurfaceId(surfaceId: string): { chatId: string; messageThreadId: number } {
  const parts = surfaceId.split(':');
  if (parts.length !== 4 || parts[0] !== 'telegram' || parts[1] !== 'topic') {
    throw new Error(`Unsupported Telegram surface id: ${surfaceId}`);
  }

  return {
    chatId: parts[2],
    messageThreadId: Number(parts[3])
  };
}

function isBenignTelegramTopicNoop(error: unknown): boolean {
  return error instanceof Error && error.message.includes('TOPIC_NOT_MODIFIED');
}

async function closeForumTopicIgnoringNoop(
  provider: TelegramBotProvider,
  botToken: string,
  chatId: string,
  messageThreadId: number
): Promise<void> {
  try {
    await provider.closeForumTopic(botToken, chatId, messageThreadId);
  } catch (error) {
    if (!isBenignTelegramTopicNoop(error)) {
      throw error;
    }
  }
}

function stripOldPrefix(name: string | null): string {
  return (
    (name?.trim() || 'Codex topic').replace(/^Old(?: \d+)?\s+/i, '').trim() || 'Codex topic'
  );
}

function parseOldGeneration(name: string | null): number | null {
  const trimmed = name?.trim() ?? '';
  const match = /^Old(?: (\d+))?\s+/i.exec(trimmed);
  if (!match) {
    return null;
  }

  return match[1] ? Number(match[1]) : 1;
}

function buildOldTopicNameForGeneration(name: string | null, generation: number): string {
  const prefix = generation === 1 ? 'Old ' : `Old ${generation} `;
  const baseName = stripOldPrefix(name);
  return `${prefix}${baseName.slice(0, Math.max(1, 128 - prefix.length))}`;
}

function isTelegramThreadBindingForChat(
  binding: BackendPlatformBindingRecord,
  chatId: string
): boolean {
  if (
    binding.platform !== 'telegram' ||
    binding.bindingType !== 'thread-surface' ||
    !binding.projectThreadId
  ) {
    return false;
  }

  try {
    return parseThreadSurfaceId(binding.surfaceId).chatId === chatId;
  } catch {
    return false;
  }
}

export interface TelegramInboundMessageInput {
  chatId: string;
  messageId: number;
  text: string;
  messageThreadId: number | null;
  receivedAt?: string;
}

export interface TelegramReplyInput {
  projectThreadId: string;
  text: string;
  replyToMessageId?: number;
}

export interface TelegramEditReplyInput {
  projectThreadId: string;
  messageId: number;
  text: string;
}

export class TelegramService {
  constructor(
    private readonly configStore: TelegramConfigStore,
    private readonly backendRegistry: PersistentBackendRegistry,
    private readonly provider: TelegramBotProvider
  ) {}

  async getConnectionState(): Promise<TelegramConnectionState> {
    const state = await this.configStore.readState();
    return this.configStore.toConnectionState(state);
  }

  async validateConnection(): Promise<TelegramConnectionState> {
    const configState = await this.configStore.readState();
    if (!configState.botToken) {
      return this.configStore.toConnectionState(configState);
    }

    try {
      await this.provider.getIdentity(configState.botToken);
    } catch {
      const state = await this.configStore.recordIssue('Bot token is invalid');
      return this.configStore.toConnectionState(state);
    }

    if (configState.rows.length === 0) {
      const state = await this.configStore.recordIssue('Telegram forum group is not configured.');
      return this.configStore.toConnectionState(state);
    }

    for (const row of configState.rows) {
      try {
        const forumGroup = await this.validateRowAccess(configState.botToken, row);
        await this.configStore.upsertProjectRow({
          rowId: row.id,
          forumGroupId: row.forumGroupId,
          forumGroupTitle: forumGroup.title,
          projectId: row.projectId
        });
        await this.configStore.recordRowIssue(row.id, null);
      } catch (error) {
        const state = await this.configStore.recordRowIssue(row.id, this.toTelegramIssue(error));
        return this.configStore.toConnectionState(state);
      }
    }

    const state = await this.configStore.recordIssue(null);
    return this.configStore.toConnectionState(state);
  }

  async checkEnvironment(rowId: string): Promise<TelegramConnectionState> {
    const configState = await this.configStore.readState();
    const row = configState.rows.find((item) => item.id === rowId);
    if (!row) {
      throw new Error('Telegram binding was not found');
    }

    if (!configState.botToken) {
      const state = await this.configStore.recordRowIssue(row.id, 'Bot token is invalid');
      return this.configStore.toConnectionState(state);
    }

    try {
      await this.provider.getIdentity(configState.botToken);
      const forumGroup = await this.validateRowAccess(configState.botToken, row);
      await this.configStore.upsertProjectRow({
        rowId: row.id,
        forumGroupId: row.forumGroupId,
        forumGroupTitle: forumGroup.title,
        projectId: row.projectId
      });
      await this.reconcileExistingThreadNames(configState.botToken, row);
      await this.ensureRowHasActiveMappings(row);
      const state = await this.configStore.recordRowIssue(row.id, null);
      return this.configStore.toConnectionState(state);
    } catch (error) {
      const state = await this.configStore.recordRowIssue(row.id, this.toTelegramIssue(error));
      return this.configStore.toConnectionState(state);
    }
  }

  async setBotToken(botToken: string): Promise<TelegramSetBotTokenResult> {
    let identity;
    try {
      identity = await this.provider.getIdentity(botToken);
    } catch {
      throw new Error('Bot token is invalid');
    }

    const state = await this.configStore.writeBotToken({
      botToken,
      botUsername: identity.username,
      botUserId: identity.id
    });

    return {
      ok: true,
      connection: this.configStore.toConnectionState(state)
    };
  }

  async removeBotToken(): Promise<TelegramRemoveBotTokenResult> {
    const state = await this.configStore.removeBotToken();

    return {
      ok: true,
      connection: this.configStore.toConnectionState(state)
    };
  }

  async upsertProjectSyncRow(input: TelegramProjectSyncRowInput): Promise<TelegramConnectionState> {
    const state = await this.configStore.upsertProjectRow(input);
    return this.configStore.toConnectionState(state);
  }

  async removeProjectSyncRow(rowId: string): Promise<TelegramConnectionState> {
    const state = await this.configStore.removeProjectRow(rowId);
    return this.configStore.toConnectionState(state);
  }

  async setupEnvironment(input: TelegramProjectSyncRowInput): Promise<TelegramSyncResult> {
    const stateWithRow = await this.configStore.upsertProjectRow(input);
    const row = input.rowId
      ? stateWithRow.rows.find((item) => item.id === input.rowId)
      : stateWithRow.rows.at(-1);
    const shouldRemoveFailedDraftRow = !input.rowId;

    if (!row) {
      throw new Error('Telegram binding was not found');
    }

    if (!stateWithRow.botToken) {
      if (shouldRemoveFailedDraftRow) {
        await this.configStore.removeProjectRow(row.id);
      } else {
        await this.configStore.recordRowIssue(row.id, 'Bot token is invalid');
      }
      throw new Error('Bot token is invalid');
    }

    try {
      const result = await this.setupRows({
        botToken: stateWithRow.botToken,
        rows: [row],
        statusText: 'Telegram environment set up successfully'
      });
      await this.configStore.recordRowSetup(row.id);
      const finalState = await this.configStore.readState();
      return {
        ok: true,
        summary: result.summary,
        connection: this.configStore.toConnectionState(finalState)
      };
    } catch (error) {
      if (shouldRemoveFailedDraftRow) {
        await this.configStore.removeProjectRow(row.id);
      } else {
        await this.configStore.recordRowIssue(row.id, this.toTelegramIssue(error));
      }
      throw error;
    }
  }

  async sync(): Promise<TelegramSyncResult> {
    const configState = await this.configStore.readState();
    if (!configState.botToken) {
      throw new Error('Bot token is invalid');
    }

    if (configState.rows.length === 0) {
      await this.configStore.recordIssue('Telegram forum group is not configured.');
      throw new Error('Telegram forum group is not configured.');
    }

    let result;
    try {
      result = await this.setupRows({
        botToken: configState.botToken,
        rows: configState.rows,
        statusText: 'Sync completed successfully'
      });
      for (const row of configState.rows) {
        await this.configStore.recordRowSetup(row.id);
      }
    } catch (error) {
      await this.configStore.recordIssue(this.toTelegramIssue(error));
      throw error;
    }

    const nextState = await this.configStore.readState();
    return {
      ok: true,
      summary: result.summary,
      connection: this.configStore.toConnectionState(nextState)
    };
  }

  async repairEnvironment(rowId: string): Promise<TelegramRepairResult> {
    const configState = await this.configStore.readState();
    const row = configState.rows.find((item) => item.id === rowId);
    if (!row) {
      throw new Error('Telegram binding was not found');
    }

    if (!configState.botToken) {
      await this.configStore.recordRowIssue(row.id, 'Bot token is invalid');
      throw new Error('Bot token is invalid');
    }

    try {
      const forumGroup = await this.validateRowAccess(configState.botToken, row);
      const registryState = await this.backendRegistry.readState();
      const projectThreads = registryState.projectThreads.filter(
        (thread) => thread.projectId === row.projectId
      );

      if (projectThreads.length === 0) {
        throw new Error('No threads found. Create threads in Codex first.');
      }

      await this.configStore.upsertProjectRow({
        rowId: row.id,
        forumGroupId: row.forumGroupId,
        forumGroupTitle: forumGroup.title,
        projectId: row.projectId
      });

      await this.backendRegistry.upsertPlatformBinding({
        id: `telegram-project:${row.projectId}:${row.forumGroupId}`,
        platform: 'telegram',
        bindingType: 'project-surface',
        projectId: row.projectId,
        projectThreadId: null,
        surfaceId: buildProjectSurfaceId(row.forumGroupId),
        surfaceLabel: forumGroup.title
      });

      const existingActiveBindings = registryState.platformBindings.filter(
        (binding) =>
          binding.projectId === row.projectId &&
          isTelegramThreadBindingForChat(binding, row.forumGroupId)
      );
      const oldGeneration = Math.max(
        0,
        ...registryState.platformBindings
          .filter(
            (binding) =>
              binding.platform === 'telegram' &&
              binding.projectId === row.projectId &&
              binding.bindingType === 'transport-only'
          )
          .map((binding) => parseOldGeneration(binding.surfaceLabel))
          .filter((value): value is number => value != null)
      );
      const nextOldGeneration = oldGeneration + 1;

      let oldTopicsRenamed = 0;
      for (const binding of existingActiveBindings) {
        const destination = parseThreadSurfaceId(binding.surfaceId);
        const oldName = buildOldTopicNameForGeneration(
          binding.surfaceLabel,
          nextOldGeneration
        );
        await this.provider.editForumTopic(
          configState.botToken,
          destination.chatId,
          destination.messageThreadId,
          oldName
        );
        await this.backendRegistry.upsertPlatformBinding({
          id: `telegram-old-thread:${binding.projectThreadId}:${destination.messageThreadId}`,
          platform: 'telegram',
          bindingType: 'transport-only',
          projectId: row.projectId,
          projectThreadId: null,
          surfaceId: binding.surfaceId,
          surfaceLabel: oldName
        });
        oldTopicsRenamed += 1;
      }

      let newTopicsCreated = 0;
      let mappingsUpdated = 0;
      for (const projectThread of projectThreads) {
        const topic = await this.provider.createForumTopic(
          configState.botToken,
          row.forumGroupId,
          projectThread.title
        );
        await this.backendRegistry.upsertPlatformBinding({
          id: `telegram-thread:${projectThread.id}`,
          platform: 'telegram',
          bindingType: 'thread-surface',
          projectId: projectThread.projectId,
          projectThreadId: projectThread.id,
          surfaceId: buildThreadSurfaceId(row.forumGroupId, topic.messageThreadId),
          surfaceLabel: topic.name
        });
        newTopicsCreated += 1;
        mappingsUpdated += 1;

        if (projectThread.archived) {
          await closeForumTopicIgnoringNoop(
            this.provider,
            configState.botToken,
            row.forumGroupId,
            topic.messageThreadId
          );
        }
      }

      const summary = {
        repairedAt: new Date().toISOString(),
        statusText: 'Repair completed successfully',
        oldTopicsRenamed,
        newTopicsCreated,
        mappingsUpdated
      };
      await this.configStore.recordRowSetup(row.id);
      const finalState = await this.configStore.readState();
      return {
        ok: true,
        summary,
        connection: this.configStore.toConnectionState(finalState)
      };
    } catch (error) {
      await this.configStore.recordRowIssue(row.id, this.toTelegramIssue(error));
      throw error;
    }
  }

  async normalizeInboundMessage(
    input: TelegramInboundMessageInput
  ): Promise<NormalizedInboundEvent> {
    const registryState = await this.backendRegistry.readState();
    const surfaceId =
      input.messageThreadId == null
        ? buildProjectSurfaceId(input.chatId)
        : buildThreadSurfaceId(input.chatId, input.messageThreadId);

    const binding = registryState.platformBindings.find(
      (item) => item.platform === 'telegram' && item.surfaceId === surfaceId
    );

    if (!binding || !binding.projectThreadId) {
      throw new Error('Broken Telegram binding');
    }

    const codexBinding = registryState.codexThreadBindings.find(
      (item) => item.projectThreadId === binding.projectThreadId
    );

    return {
      id: `telegram:${input.chatId}:${input.messageId}`,
      source: 'telegram',
      receivedAt: input.receivedAt ?? new Date().toISOString(),
      text: input.text,
      externalThreadId: surfaceId,
      projectKey: binding.projectId,
      projectThreadId: binding.projectThreadId,
      threadId: codexBinding?.codexThreadId ?? null
    };
  }

  async sendThreadReply(input: TelegramReplyInput): Promise<TelegramSendMessageResult> {
    const configState = await this.configStore.readState();
    if (!configState.botToken) {
      throw new Error('Bot token is invalid');
    }

    const registryState = await this.backendRegistry.readState();
    const binding = registryState.platformBindings.find(
      (item) =>
        item.platform === 'telegram' &&
        item.bindingType === 'thread-surface' &&
        item.projectThreadId === input.projectThreadId
    );

    if (!binding) {
      throw new Error('Broken Telegram binding');
    }

    const destination = parseThreadSurfaceId(binding.surfaceId);

    const messageInput: TelegramSendMessageInput = {
      chatId: destination.chatId,
      messageThreadId: destination.messageThreadId,
      text: input.text,
      replyToMessageId: input.replyToMessageId
    };

    return this.provider.sendMessage(configState.botToken, messageInput);
  }

  async editThreadReply(input: TelegramEditReplyInput): Promise<TelegramSendMessageResult> {
    const configState = await this.configStore.readState();
    if (!configState.botToken) {
      throw new Error('Bot token is invalid');
    }

    const registryState = await this.backendRegistry.readState();
    const binding = registryState.platformBindings.find(
      (item) =>
        item.platform === 'telegram' &&
        item.bindingType === 'thread-surface' &&
        item.projectThreadId === input.projectThreadId
    );

    if (!binding) {
      throw new Error('Broken Telegram binding');
    }

    const destination = parseThreadSurfaceId(binding.surfaceId);

    return this.provider.editMessage(configState.botToken, {
      chatId: destination.chatId,
      messageId: input.messageId,
      text: input.text
    });
  }

  private async syncProjectThreads(input: {
    botToken: string;
    chatId: string;
    projectThreads: BackendProjectThreadRecord[];
    existingBindings: BackendPlatformBindingRecord[];
  }): Promise<{ created: number; updated: number; alreadyLinked: number }> {
    let created = 0;
    let updated = 0;
    let alreadyLinked = 0;

    for (const projectThread of input.projectThreads) {
      const existingBinding = input.existingBindings.find(
        (binding) => binding.projectThreadId === projectThread.id
      );

      if (!existingBinding) {
        const topic = await this.provider.createForumTopic(
          input.botToken,
          input.chatId,
          projectThread.title
        );

        await this.backendRegistry.upsertPlatformBinding({
          id: `telegram-thread:${projectThread.id}`,
          platform: 'telegram',
          bindingType: 'thread-surface',
          projectId: projectThread.projectId,
          projectThreadId: projectThread.id,
          surfaceId: buildThreadSurfaceId(input.chatId, topic.messageThreadId),
          surfaceLabel: topic.name
        });
        created += 1;

        if (projectThread.archived) {
          await closeForumTopicIgnoringNoop(
            this.provider,
            input.botToken,
            input.chatId,
            topic.messageThreadId
          );
          updated += 1;
        }
        continue;
      }

      const destination = parseThreadSurfaceId(existingBinding.surfaceId);
      let changed = false;

      if (existingBinding.surfaceLabel !== projectThread.title) {
        await this.provider.editForumTopic(
          input.botToken,
          destination.chatId,
          destination.messageThreadId,
          projectThread.title
        );
        await this.backendRegistry.upsertPlatformBinding({
          ...existingBinding,
          surfaceLabel: projectThread.title
        });
        changed = true;
      }

      if (projectThread.archived) {
        await closeForumTopicIgnoringNoop(
          this.provider,
          input.botToken,
          destination.chatId,
          destination.messageThreadId
        );
        changed = true;
      } else if (changed) {
        try {
          await this.provider.reopenForumTopic(
            input.botToken,
            destination.chatId,
            destination.messageThreadId
          );
        } catch (error) {
          if (!isBenignTelegramTopicNoop(error)) {
            throw error;
          }
        }
      }

      if (changed) {
        updated += 1;
      } else {
        alreadyLinked += 1;
      }
    }

    return { created, updated, alreadyLinked };
  }

  private async setupRows(input: {
    botToken: string;
    rows: Array<{ id: string; forumGroupId: string; forumGroupTitle: string; projectId: string }>;
    statusText: string;
  }): Promise<{ summary: TelegramSyncResult['summary'] }> {
    const registryState = await this.backendRegistry.readState();
    let threadsFound = 0;
    let created = 0;
    let updated = 0;
    let alreadyLinked = 0;

    for (const row of input.rows) {
      const forumGroup = await this.validateRowAccess(input.botToken, row);
      await this.configStore.upsertProjectRow({
        rowId: row.id,
        forumGroupId: row.forumGroupId,
        forumGroupTitle: forumGroup.title,
        projectId: row.projectId
      });

      const projectThreads = registryState.projectThreads.filter(
        (thread) => thread.projectId === row.projectId
      );

      if (projectThreads.length === 0) {
        throw new Error('No threads found. Create threads in Codex first.');
      }

      threadsFound += projectThreads.length;

      await this.backendRegistry.upsertPlatformBinding({
        id: `telegram-project:${row.projectId}:${row.forumGroupId}`,
        platform: 'telegram',
        bindingType: 'project-surface',
        projectId: row.projectId,
        projectThreadId: null,
        surfaceId: buildProjectSurfaceId(row.forumGroupId),
        surfaceLabel: forumGroup.title
      });

      const rowResult = await this.syncProjectThreads({
        botToken: input.botToken,
        chatId: row.forumGroupId,
        projectThreads,
        existingBindings: registryState.platformBindings.filter(
          (binding) =>
            binding.projectId === row.projectId &&
            isTelegramThreadBindingForChat(binding, row.forumGroupId)
        )
      });

      created += rowResult.created;
      updated += rowResult.updated;
      alreadyLinked += rowResult.alreadyLinked;
    }

    const summary = {
      syncedAt: new Date().toISOString(),
      statusText: input.statusText,
      threadsFound,
      created,
      updated,
      alreadyLinked
    };

    await this.configStore.recordSync(summary);
    return { summary };
  }

  private async validateRowAccess(
    botToken: string,
    row: { forumGroupId: string }
  ): Promise<{ chatId: string; title: string; type: string; isForum: boolean }> {
    let forumGroup;
    try {
      forumGroup = await this.provider.getForumGroup(botToken, row.forumGroupId);
    } catch {
      throw new Error('Telegram group was not found');
    }

    if (forumGroup.type !== 'supergroup' || !forumGroup.isForum) {
      throw new Error('Forum group required');
    }

    let permissions;
    try {
      permissions = await this.provider.getBotPermissions(botToken, row.forumGroupId);
    } catch {
      throw new Error('Bot does not have enough rights to manage topics');
    }

    if (!permissions.isAdministrator) {
      throw new Error('Bot is not administrator');
    }

    if (!permissions.canManageTopics) {
      throw new Error('Bot does not have enough rights to manage topics');
    }

    return forumGroup;
  }

  private async ensureRowHasActiveMappings(row: {
    projectId: string;
    forumGroupId: string;
    setupCompletedAt?: string | null;
  }): Promise<void> {
    if (!row.setupCompletedAt) {
      return;
    }

    const registryState = await this.backendRegistry.readState();
    const activeBindings = registryState.platformBindings.filter(
      (binding) =>
        binding.projectId === row.projectId &&
        isTelegramThreadBindingForChat(binding, row.forumGroupId)
    );
    if (activeBindings.length === 0) {
      throw new Error('Telegram environment mapping is missing');
    }
  }

  private async reconcileExistingThreadNames(
    botToken: string,
    row: { projectId: string; forumGroupId: string }
  ): Promise<void> {
    const registryState = await this.backendRegistry.readState();
    const projectThreadsById = new Map(
      registryState.projectThreads
        .filter((thread) => thread.projectId === row.projectId)
        .map((thread) => [thread.id, thread])
    );
    const activeBindings = registryState.platformBindings.filter(
      (binding) =>
        binding.projectId === row.projectId &&
        isTelegramThreadBindingForChat(binding, row.forumGroupId)
    );

    for (const binding of activeBindings) {
      if (!binding.projectThreadId) {
        continue;
      }

      const projectThread = projectThreadsById.get(binding.projectThreadId);
      if (!projectThread || binding.surfaceLabel === projectThread.title) {
        continue;
      }

      const destination = parseThreadSurfaceId(binding.surfaceId);
      await this.provider.editForumTopic(
        botToken,
        destination.chatId,
        destination.messageThreadId,
        projectThread.title
      );
      await this.backendRegistry.upsertPlatformBinding({
        ...binding,
        surfaceLabel: projectThread.title
      });
    }
  }

  private toTelegramIssue(error: unknown): string {
    return error instanceof Error ? error.message : 'Unexpected Telegram error';
  }
}
