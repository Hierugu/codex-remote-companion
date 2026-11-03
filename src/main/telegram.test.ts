import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { PersistentBackendRegistry } from './backend-registry';
import { TelegramConfigStore } from './telegram-config';
import type {
  TelegramEditMessageInput,
  TelegramBotIdentity,
  TelegramBotPermissions,
  TelegramBotProvider,
  TelegramForumGroupInfo,
  TelegramForumTopicInfo,
  TelegramInboundUpdate,
  TelegramSendMessageInput,
  TelegramSendMessageResult
} from './telegram-provider';
import { TelegramService } from './telegram-service';

class FakeTelegramBotProvider implements TelegramBotProvider {
  readonly createdTopics: Array<{ chatId: string; name: string }> = [];

  readonly editedTopics: Array<{ chatId: string; messageThreadId: number; name: string }> = [];

  readonly closedTopics: Array<{ chatId: string; messageThreadId: number }> = [];

  readonly reopenedTopics: Array<{ chatId: string; messageThreadId: number }> = [];

  readonly sentMessages: TelegramSendMessageInput[] = [];

  readonly editedMessages: TelegramEditMessageInput[] = [];

  constructor(
    private readonly options: {
      identity?: TelegramBotIdentity;
      forumGroup?: TelegramForumGroupInfo;
      permissions?: TelegramBotPermissions;
      identityError?: Error | null;
      forumGroupError?: Error | null;
      permissionsError?: Error | null;
      closeError?: Error | null;
      reopenError?: Error | null;
    } = {}
  ) {}

  async getIdentity(): Promise<TelegramBotIdentity> {
    if (this.options.identityError) {
      throw this.options.identityError;
    }

    return this.options.identity ?? {
      id: '9001',
      username: 'codex_remote_companion_bot'
    };
  }

  async getForumGroup(_botToken: string, chatId: string): Promise<TelegramForumGroupInfo> {
    if (this.options.forumGroupError) {
      throw this.options.forumGroupError;
    }

    return (
      this.options.forumGroup ?? {
        chatId,
        title: 'Main forum group',
        type: 'supergroup',
        isForum: true
      }
    );
  }

  async getBotPermissions(): Promise<TelegramBotPermissions> {
    if (this.options.permissionsError) {
      throw this.options.permissionsError;
    }

    return (
      this.options.permissions ?? {
        isAdministrator: true,
        canManageTopics: true
      }
    );
  }

  async getUpdates(): Promise<TelegramInboundUpdate[]> {
    return [];
  }

  async createForumTopic(_botToken: string, chatId: string, name: string): Promise<TelegramForumTopicInfo> {
    this.createdTopics.push({ chatId, name });
    return {
      messageThreadId: this.createdTopics.length,
      name
    };
  }

  async editForumTopic(
    _botToken: string,
    chatId: string,
    messageThreadId: number,
    name: string
  ): Promise<void> {
    this.editedTopics.push({ chatId, messageThreadId, name });
  }

  async closeForumTopic(
    _botToken: string,
    chatId: string,
    messageThreadId: number
  ): Promise<void> {
    if (this.options.closeError) {
      throw this.options.closeError;
    }
    this.closedTopics.push({ chatId, messageThreadId });
  }

  async reopenForumTopic(
    _botToken: string,
    chatId: string,
    messageThreadId: number
  ): Promise<void> {
    if (this.options.reopenError) {
      throw this.options.reopenError;
    }
    this.reopenedTopics.push({ chatId, messageThreadId });
  }

  async sendMessage(
    _botToken: string,
    input: TelegramSendMessageInput
  ): Promise<TelegramSendMessageResult> {
    this.sentMessages.push(input);
    return {
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
      messageId: this.sentMessages.length,
      text: input.text
    };
  }

  async editMessage(
    _botToken: string,
    input: TelegramEditMessageInput
  ): Promise<TelegramSendMessageResult> {
    this.editedMessages.push(input);
    return {
      chatId: input.chatId,
      messageThreadId: null,
      messageId: input.messageId,
      text: input.text
    };
  }
}

async function seedProjectThreads(
  registry: PersistentBackendRegistry,
  count = 2,
  archivedLast = false
) {
  const state = await registry.readState();
  const userId = state.users[0]?.id;
  const machineId = state.localMachines[0]?.machineId;

  assert.ok(userId);
  assert.ok(machineId);

  const project = await registry.upsertProject({
    id: 'project-telegram-1',
    userId,
    platform: 'telegram',
    name: 'Telegram project'
  });

  for (let index = 0; index < count; index += 1) {
    const threadId = `project-thread-${index + 1}`;
    await registry.upsertProjectThread({
      id: threadId,
      projectId: project.id,
      title: index === 0 ? 'Alpha thread' : 'Beta thread',
      archived: archivedLast && index === count - 1
    });
    await registry.upsertCodexThreadBinding({
      id: `codex-binding-${index + 1}`,
      projectThreadId: threadId,
      machineId,
      codexThreadId: `codex-thread-${index + 1}`
    });
  }

  return project;
}

test('TelegramService masks bot token and stores forum-group project rows', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramBotProvider();

  await backendRegistry.ensureBootstrap({
    installId: 'install-1',
    machineId: 'machine-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'local-companion-registry'
  });

  const service = new TelegramService(configStore, backendRegistry, provider);
  const tokenResult = await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');
  const rowState = await service.upsertProjectSyncRow({
    forumGroupId: '-100123',
    forumGroupTitle: 'Core forum',
    projectId: 'project-telegram-1'
  });

  assert.equal(tokenResult.ok, true);
  assert.equal(tokenResult.connection.maskedBotToken, '123456:********1234');
  assert.equal(rowState.rows.length, 1);
  assert.equal(rowState.status.text, 'Setup required');
});

test('TelegramService reports invalid bot token with product error text', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramBotProvider({
    identityError: new Error('Not Found')
  });

  await backendRegistry.ensureBootstrap({
    installId: 'install-1',
    machineId: 'machine-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'local-companion-registry'
  });

  const service = new TelegramService(configStore, backendRegistry, provider);

  await assert.rejects(
    () => service.setBotToken('invalid-token'),
    /Bot token is invalid/
  );
  assert.equal((await service.getConnectionState()).maskedBotToken, null);
});

test('TelegramService sync creates missing topic bindings and returns exact summary text', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramBotProvider();
  const service = new TelegramService(configStore, backendRegistry, provider);

  await backendRegistry.ensureBootstrap({
    installId: 'install-2',
    machineId: 'machine-2',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'local-companion-registry'
  });
  const project = await seedProjectThreads(backendRegistry);
  await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');
  await service.upsertProjectSyncRow({
    forumGroupId: '-100555',
    forumGroupTitle: 'Project forum',
    projectId: project.id
  });

  const result = await service.sync();
  const state = await backendRegistry.readState();

  assert.equal(result.ok, true);
  assert.equal(result.summary.statusText, 'Sync completed successfully');
  assert.equal(result.summary.threadsFound, 2);
  assert.equal(result.summary.created, 2);
  assert.equal(result.summary.updated, 0);
  assert.equal(result.summary.alreadyLinked, 0);
  assert.equal(result.connection.status.text, 'Active');
  assert.equal(
    state.platformBindings.filter((binding) => binding.bindingType === 'thread-surface').length,
    2
  );
});

test('Telegram connection stays active for non-blocking binding noise after a successful sync', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramBotProvider();
  const service = new TelegramService(configStore, backendRegistry, provider);

  await backendRegistry.ensureBootstrap({
    installId: 'install-2b',
    machineId: 'machine-2b',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'local-companion-registry'
  });
  const project = await seedProjectThreads(backendRegistry);
  await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');
  await service.upsertProjectSyncRow({
    forumGroupId: '-100556',
    forumGroupTitle: 'Project forum',
    projectId: project.id
  });
  await service.sync();

  await configStore.recordIssue('Broken Telegram binding');

  const connection = await service.getConnectionState();
  assert.equal(connection.status.text, 'Active');
  assert.equal(connection.issue, null);
});

test('TelegramService validates saved connection without provisioning topics', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramBotProvider();
  const service = new TelegramService(configStore, backendRegistry, provider);

  await backendRegistry.ensureBootstrap({
    installId: 'install-2c',
    machineId: 'machine-2c',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'local-companion-registry'
  });
  const project = await seedProjectThreads(backendRegistry);
  await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');
  await service.upsertProjectSyncRow({
    forumGroupId: '-100557',
    forumGroupTitle: 'Saved title',
    projectId: project.id
  });
  await service.sync();

  const createdBeforeValidate = provider.createdTopics.length;
  const connection = await service.validateConnection();

  assert.equal(connection.status.text, 'Active');
  assert.equal(connection.issue, null);
  assert.equal(provider.createdTopics.length, createdBeforeValidate);
  assert.equal(connection.rows[0]?.forumGroupTitle, 'Main forum group');
});

test('TelegramService validation records actionable issues without destructive sync', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramBotProvider({
    permissions: {
      isAdministrator: false,
      canManageTopics: false
    }
  });
  const service = new TelegramService(configStore, backendRegistry, provider);

  await backendRegistry.ensureBootstrap({
    installId: 'install-2d',
    machineId: 'machine-2d',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'local-companion-registry'
  });
  const project = await seedProjectThreads(backendRegistry);
  await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');
  await service.upsertProjectSyncRow({
    forumGroupId: '-100558',
    forumGroupTitle: 'Saved title',
    projectId: project.id
  });

  const connection = await service.validateConnection();

  assert.equal(connection.status.text, 'Needs attention');
  assert.equal(connection.issue, 'Bot is not administrator');
  assert.equal(provider.createdTopics.length, 0);
});

test('TelegramService sets up one Telegram environment row and marks it ready', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramBotProvider();
  const service = new TelegramService(configStore, backendRegistry, provider);

  await backendRegistry.ensureBootstrap({
    installId: 'install-2e',
    machineId: 'machine-2e',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'local-companion-registry'
  });
  const project = await seedProjectThreads(backendRegistry);
  await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');

  const result = await service.setupEnvironment({
    forumGroupId: '-100559',
    forumGroupTitle: '-100559',
    projectId: project.id
  });

  assert.equal(result.summary.statusText, 'Telegram environment set up successfully');
  assert.equal(result.connection.rows[0]?.setupCompletedAt != null, true);
  assert.equal(result.connection.rows[0]?.lastIssue, null);
  assert.equal(result.connection.status.text, 'Active');
});

test('TelegramService does not persist a new binding row when first setup fails', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramBotProvider({
    forumGroupError: new Error('chat not found')
  });
  const service = new TelegramService(configStore, backendRegistry, provider);

  await backendRegistry.ensureBootstrap({
    installId: 'install-2e-failed',
    machineId: 'machine-2e-failed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'local-companion-registry'
  });
  const project = await seedProjectThreads(backendRegistry);
  await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');

  await assert.rejects(
    () =>
      service.setupEnvironment({
        forumGroupId: '-100404',
        forumGroupTitle: '-100404',
        projectId: project.id
      }),
    /Telegram group was not found/
  );

  assert.equal((await service.getConnectionState()).rows.length, 0);
});

test('TelegramService repair renames old topics and remaps threads to fresh topics', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramBotProvider();
  const service = new TelegramService(configStore, backendRegistry, provider);

  await backendRegistry.ensureBootstrap({
    installId: 'install-2f',
    machineId: 'machine-2f',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'local-companion-registry'
  });
  const project = await seedProjectThreads(backendRegistry);
  await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');
  const setupResult = await service.setupEnvironment({
    forumGroupId: '-100560',
    forumGroupTitle: '-100560',
    projectId: project.id
  });

  const rowId = setupResult.connection.rows[0]!.id;
  const repairResult = await service.repairEnvironment(rowId);
  const registryState = await backendRegistry.readState();

  assert.equal(repairResult.summary.statusText, 'Repair completed successfully');
  assert.equal(repairResult.summary.oldTopicsRenamed, 2);
  assert.equal(repairResult.summary.newTopicsCreated, 2);
  assert.equal(repairResult.summary.mappingsUpdated, 2);
  assert.deepEqual(
    provider.editedTopics.map((topic) => topic.name),
    ['Old Alpha thread', 'Old Beta thread']
  );
  assert.equal(
    registryState.platformBindings.filter((binding) => binding.id.startsWith('telegram-old-thread:')).length,
    2
  );
  assert.equal(repairResult.connection.rows[0]?.setupCompletedAt != null, true);
  assert.equal(repairResult.connection.status.text, 'Active');
});

test('TelegramService repair increments Old prefix numbering on repeated repairs', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramBotProvider();
  const service = new TelegramService(configStore, backendRegistry, provider);

  await backendRegistry.ensureBootstrap({
    installId: 'install-2g',
    machineId: 'machine-2g',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'local-companion-registry'
  });
  const project = await seedProjectThreads(backendRegistry);
  await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');
  const setupResult = await service.setupEnvironment({
    forumGroupId: '-100561',
    forumGroupTitle: '-100561',
    projectId: project.id
  });

  const rowId = setupResult.connection.rows[0]!.id;
  await service.repairEnvironment(rowId);
  await service.repairEnvironment(rowId);

  assert.deepEqual(
    provider.editedTopics.map((topic) => topic.name),
    ['Old Alpha thread', 'Old Beta thread', 'Old 2 Alpha thread', 'Old 2 Beta thread']
  );
});

test('TelegramService sync fails clearly when bot lacks rights or project has no threads', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramBotProvider({
    permissions: {
      isAdministrator: false,
      canManageTopics: false
    }
  });
  const service = new TelegramService(configStore, backendRegistry, provider);

  await backendRegistry.ensureBootstrap({
    installId: 'install-3',
    machineId: 'machine-3',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'local-companion-registry'
  });
  const state = await backendRegistry.readState();
  await backendRegistry.upsertProject({
    id: 'project-no-threads',
    userId: state.users[0]!.id,
    platform: 'telegram',
    name: 'Broken project'
  });

  await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');
  await service.upsertProjectSyncRow({
    forumGroupId: '-100777',
    forumGroupTitle: 'Broken forum',
    projectId: 'project-no-threads'
  });

  await assert.rejects(() => service.sync(), /Bot is not administrator/);

  const providerWithRights = new FakeTelegramBotProvider();
  const serviceWithRights = new TelegramService(configStore, backendRegistry, providerWithRights);

  await assert.rejects(() => serviceWithRights.sync(), /No threads found\. Create threads in Codex first\./);
});

test('TelegramService normalizes inbound topic messages and sends outbound replies', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramBotProvider();
  const service = new TelegramService(configStore, backendRegistry, provider);

  await backendRegistry.ensureBootstrap({
    installId: 'install-4',
    machineId: 'machine-4',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'local-companion-registry'
  });
  const project = await seedProjectThreads(backendRegistry, 1);
  await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');
  await service.upsertProjectSyncRow({
    forumGroupId: '-100888',
    forumGroupTitle: 'Reply forum',
    projectId: project.id
  });
  await service.sync();

  const normalized = await service.normalizeInboundMessage({
    chatId: '-100888',
    messageId: 42,
    text: 'hello from telegram',
    messageThreadId: 1
  });
  const reply = await service.sendThreadReply({
    projectThreadId: 'project-thread-1',
    text: 'reply text',
    replyToMessageId: 42
  });
  const edited = await service.editThreadReply({
    projectThreadId: 'project-thread-1',
    messageId: 99,
    text: 'Running Codex...'
  });

  assert.equal(normalized.threadId, 'codex-thread-1');
  assert.equal(normalized.externalThreadId, 'telegram:topic:-100888:1');
  assert.equal(reply.text, 'reply text');
  assert.equal(provider.sentMessages[0]?.replyToMessageId, 42);
  assert.equal(provider.editedMessages[0]?.messageId, 99);
  assert.equal(provider.editedMessages[0]?.text, 'Running Codex...');
  assert.equal(edited.text, 'Running Codex...');
});

test('TelegramService partial sync creates only missing topics and keeps existing bindings', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramBotProvider();
  const service = new TelegramService(configStore, backendRegistry, provider);

  await backendRegistry.ensureBootstrap({
    installId: 'install-5',
    machineId: 'machine-5',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'local-companion-registry'
  });
  const project = await seedProjectThreads(backendRegistry, 2);
  await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');
  await service.upsertProjectSyncRow({
    forumGroupId: '-100999',
    forumGroupTitle: 'Partial sync forum',
    projectId: project.id
  });

  await backendRegistry.upsertPlatformBinding({
    id: 'telegram-thread:project-thread-1',
    platform: 'telegram',
    bindingType: 'thread-surface',
    projectId: project.id,
    projectThreadId: 'project-thread-1',
    surfaceId: 'telegram:topic:-100999:7',
    surfaceLabel: 'Alpha thread'
  });

  const result = await service.sync();

  assert.equal(result.summary.threadsFound, 2);
  assert.equal(result.summary.created, 1);
  assert.equal(result.summary.updated, 0);
  assert.equal(result.summary.alreadyLinked, 1);
});

test('TelegramService closes archived topics and updates renamed topics on resync', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramBotProvider();
  const service = new TelegramService(configStore, backendRegistry, provider);

  await backendRegistry.ensureBootstrap({
    installId: 'install-6',
    machineId: 'machine-6',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'local-companion-registry'
  });
  const project = await seedProjectThreads(backendRegistry, 2, true);
  await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');
  await service.upsertProjectSyncRow({
    forumGroupId: '-100654',
    forumGroupTitle: 'Archive forum',
    projectId: project.id
  });

  await service.sync();
  await backendRegistry.upsertProjectThread({
    id: 'project-thread-1',
    projectId: project.id,
    title: 'Alpha thread renamed',
    archived: false
  });

  const result = await service.sync();

  assert.equal(result.summary.created, 0);
  assert.equal(result.summary.updated, 2);
  assert.equal(provider.editedTopics.length >= 1, true);
  assert.equal(provider.closedTopics.length >= 1, true);
});

test('TelegramService ignores benign TOPIC_NOT_MODIFIED on reopen during rename sync', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramBotProvider({
    reopenError: new Error('Bad Request: TOPIC_NOT_MODIFIED')
  });
  const service = new TelegramService(configStore, backendRegistry, provider);

  await backendRegistry.ensureBootstrap({
    installId: 'install-7',
    machineId: 'machine-7',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'local-companion-registry'
  });
  const project = await seedProjectThreads(backendRegistry, 1);
  await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');
  await service.upsertProjectSyncRow({
    forumGroupId: '-100321',
    forumGroupTitle: 'Rename forum',
    projectId: project.id
  });

  await service.sync();
  await backendRegistry.upsertProjectThread({
    id: 'project-thread-1',
    projectId: project.id,
    title: 'Alpha thread renamed',
    archived: false
  });

  const result = await service.sync();

  assert.equal(result.ok, true);
  assert.equal(result.summary.updated, 1);
  assert.equal(provider.editedTopics.length, 1);
});

test('TelegramService ignores benign TOPIC_NOT_MODIFIED on close during archive sync', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramBotProvider({
    closeError: new Error('Bad Request: TOPIC_NOT_MODIFIED')
  });
  const service = new TelegramService(configStore, backendRegistry, provider);

  await backendRegistry.ensureBootstrap({
    installId: 'install-7b',
    machineId: 'machine-7b',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'local-companion-registry'
  });
  const project = await seedProjectThreads(backendRegistry, 1, true);
  await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');
  await service.upsertProjectSyncRow({
    forumGroupId: '-100322',
    forumGroupTitle: 'Archive noop forum',
    projectId: project.id
  });

  const result = await service.sync();

  assert.equal(result.ok, true);
  assert.equal(result.summary.created, 1);
  assert.equal(result.summary.updated, 1);
});

test('TelegramConfigStore repairs a config file with trailing garbage', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-telegram-config-'));
  const configPath = join(tempRoot, 'telegram-config.json');
  const validState = {
    botToken: '123:token',
    ownerUserId: '12345',
    botUsername: 'codex_remote_companion_bot',
    botUserId: '123',
    rows: [
      {
        id: 'telegram-row:aps',
        forumGroupId: '-1001',
        forumGroupTitle: 'asptest',
        projectId: 'project:aps',
        setupCompletedAt: '2026-04-20T10:04:01.637Z',
        lastIssue: null
      }
    ],
    lastSync: null,
    issue: null,
    lastUpdateId: 42
  };

  await writeFile(
    configPath,
    `${JSON.stringify(validState, null, 2)}broken trailing bytes`,
    'utf8'
  );

  const store = new TelegramConfigStore(configPath);
  const state = await store.readState();
  const repairedRaw = await readFile(configPath, 'utf8');

  assert.equal(state.botToken, '123:token');
  assert.equal(state.rows.length, 1);
  assert.doesNotMatch(repairedRaw, /broken trailing bytes/);
  assert.deepEqual(JSON.parse(repairedRaw), validState);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
});
