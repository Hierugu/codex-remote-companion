import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import type {
  ControlPlaneDispatchReceipt,
  NormalizedInboundEvent
} from '@shared/contracts';

import type { CodexThreadExecutionOptions } from './codex-thread-executor';
import { PersistentBackendRegistry } from './backend-registry';
import { TelegramConfigStore } from './telegram-config';
import { TelegramInboundPoller } from './telegram-poller';
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
import type { TelegramSlashCommandService } from './telegram-slash-commands';

function fakeSlashCommandService(
  handle: TelegramSlashCommandService['handle'] = async () => null
): TelegramSlashCommandService {
  return {
    handle
  } as unknown as TelegramSlashCommandService;
}

class FakeTelegramPollingProvider implements TelegramBotProvider {
  readonly createdTopics: Array<{ chatId: string; name: string }> = [];

  readonly sentMessages: TelegramSendMessageInput[] = [];

  readonly editedMessages: TelegramEditMessageInput[] = [];

  updates: TelegramInboundUpdate[] = [];

  async getIdentity(_botToken: string): Promise<TelegramBotIdentity> {
    return {
      id: '9001',
      username: 'codex_remote_companion_bot'
    };
  }

  async getForumGroup(_botToken: string, chatId: string): Promise<TelegramForumGroupInfo> {
    return {
      chatId,
      title: 'Main forum group',
      type: 'supergroup',
      isForum: true
    };
  }

  async getBotPermissions(
    _botToken: string,
    _chatId: string
  ): Promise<TelegramBotPermissions> {
    return {
      isAdministrator: true,
      canManageTopics: true
    };
  }

  async getUpdates(
    _botToken: string,
    _input: { offset?: number; timeoutSeconds?: number; limit?: number }
  ): Promise<TelegramInboundUpdate[]> {
    const next = [...this.updates];
    this.updates = [];
    return next;
  }

  async createForumTopic(
    _botToken: string,
    chatId: string,
    name: string
  ): Promise<TelegramForumTopicInfo> {
    this.createdTopics.push({ chatId, name });
    return {
      messageThreadId: this.createdTopics.length,
      name
    };
  }

  async editForumTopic(): Promise<void> {}

  async closeForumTopic(): Promise<void> {}

  async reopenForumTopic(): Promise<void> {}

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

async function seedTelegramProject(registry: PersistentBackendRegistry) {
  await registry.ensureBootstrap({
    installId: 'install-telegram-poller',
    machineId: 'machine-telegram-poller',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'local-companion-registry'
  });

  const state = await registry.readState();
  const project = await registry.upsertProject({
    id: 'project-telegram-poller',
    userId: state.users[0]!.id,
    platform: 'telegram',
    name: 'Telegram poller project'
  });

  await registry.upsertProjectThread({
    id: 'project-thread-1',
    projectId: project.id,
    title: 'i love monkeys',
    archived: false
  });
  await registry.upsertCodexThreadBinding({
    id: 'codex-binding-1',
    projectThreadId: 'project-thread-1',
    machineId: 'machine-telegram-poller',
    codexThreadId: 'codex-thread-1'
  });

  return project;
}

test('TelegramInboundPoller routes bound topic messages into Codex and sends reply back', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-poller-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramPollingProvider();
  const service = new TelegramService(configStore, backendRegistry, provider);
  const project = await seedTelegramProject(backendRegistry);

  await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');
  await service.upsertProjectSyncRow({
    forumGroupId: '-100555',
    forumGroupTitle: 'Project forum',
    projectId: project.id
  });
  await service.sync();

  provider.updates = [
    {
      updateId: 101,
      message: {
        messageId: 55,
        text: 'i love monkeys',
        chatId: '-100555',
        chatType: 'supergroup',
        messageThreadId: 1,
        senderId: '12345',
        senderIsBot: false
      }
    }
  ];

  const routedEvents: NormalizedInboundEvent[] = [];
  const executionOptions: CodexThreadExecutionOptions[] = [];
  const poller = new TelegramInboundPoller(
    configStore,
    service,
    {
      handleInboundEvent: async (event: NormalizedInboundEvent): Promise<ControlPlaneDispatchReceipt> => {
        routedEvents.push(event);
        return {
          accepted: true,
          taskId: 'task-1',
          installId: 'install-telegram-poller',
          machineId: 'machine-telegram-poller',
          routedThreadId: event.threadId,
          routeKey: event.threadId,
          receivedAt: new Date().toISOString()
        };
      }
    },
    {
      resumeAndRun: async (threadId, _prompt, options) => {
        executionOptions.push(options ?? {});
        await options?.onProgress?.('Running Codex...');
        await options?.onProgress?.('Applying changes...');
        return {
          threadId,
          assistantReply: 'telegram inbound reply ok'
        };
      }
    },
    fakeSlashCommandService(),
    provider,
    10
  );

  const result = await poller.pollOnce();
  const pollingConfig = await configStore.getPollingConfig();

  assert.equal(result.processed, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.lastUpdateId, 101);
  assert.equal(pollingConfig.lastUpdateId, 101);
  assert.equal(routedEvents[0]?.projectThreadId, 'project-thread-1');
  assert.equal(routedEvents[0]?.threadId, 'codex-thread-1');
  assert.equal(provider.sentMessages[0]?.chatId, '-100555');
  assert.equal(provider.sentMessages[0]?.messageThreadId, 1);
  assert.equal(provider.sentMessages[0]?.replyToMessageId, undefined);
  assert.equal(provider.sentMessages[0]?.text, 'Prompt received. Working on it...');
  assert.equal(provider.editedMessages[0]?.messageId, 1);
  assert.equal(provider.editedMessages[0]?.text, 'Running Codex...');
  assert.equal(provider.editedMessages[1]?.messageId, 1);
  assert.equal(provider.editedMessages[1]?.text, 'Applying changes...');
  assert.equal(provider.editedMessages[2]?.messageId, 1);
  assert.equal(provider.editedMessages[2]?.text, 'telegram inbound reply ok');
  assert.equal(provider.sentMessages.length, 1);
  assert.equal('model' in (executionOptions[0] ?? {}), false);
  assert.equal('reasoningEffort' in (executionOptions[0] ?? {}), false);
  assert.equal('permissionMode' in (executionOptions[0] ?? {}), false);

  provider.updates = [{
    updateId: 104,
    message: {
      messageId: 58,
      text: 'unauthorized prompt',
      chatId: '-100555',
      chatType: 'supergroup',
      messageThreadId: 1,
      senderId: '99999',
      senderIsBot: false
    }
  }];
  const unauthorized = await poller.pollOnce();
  assert.equal(unauthorized.processed, 0);
  assert.equal(unauthorized.skipped, 1);
  assert.equal(routedEvents.length, 1);
  assert.equal(provider.sentMessages.length, 1);
});

test('TelegramInboundPoller replaces the working acknowledgement when Codex cannot resume', async () => {
  const provider = new FakeTelegramPollingProvider();
  provider.updates = [{
    updateId: 201,
    message: {
      messageId: 71,
      text: 'Continue this chat',
      chatId: '-100555',
      chatType: 'supergroup',
      messageThreadId: 1,
      senderId: '12345',
      senderIsBot: false
    }
  }];
  const edited: string[] = [];
  const issues: string[] = [];
  const config = {
    getPollingConfig: async () => ({ botToken: '123:token', ownerUserId: '12345', lastUpdateId: null }),
    recordLastUpdateId: async () => {},
    recordIssue: async (issue: string) => { issues.push(issue); }
  };
  const service = {
    normalizeInboundMessage: async () => ({
      id: 'telegram:-100555:71', source: 'telegram', receivedAt: new Date().toISOString(),
      text: 'Continue this chat', externalThreadId: 'telegram:topic:-100555:1',
      projectKey: 'project-1', projectThreadId: 'project-thread-1', threadId: 'codex-thread-1'
    }),
    sendThreadReply: async () => ({ messageId: 900 }),
    editThreadReply: async (input: { text: string }) => { edited.push(input.text); }
  };
  const poller = new TelegramInboundPoller(
    config as never,
    service as never,
    { handleInboundEvent: async () => ({ accepted: true }) as never },
    { resumeAndRun: async () => { throw new Error('unsupported stored thread item'); } },
    fakeSlashCommandService(),
    provider
  );

  const result = await poller.pollOnce();
  assert.equal(result.skipped, 1);
  assert.match(edited[0] ?? '', /Codex could not continue this chat: unsupported stored thread item/);
  assert.deepEqual(issues, ['unsupported stored thread item']);
});

test('TelegramInboundPoller ignores unbound topic noise without poisoning Telegram status', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-poller-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramPollingProvider();
  const service = new TelegramService(configStore, backendRegistry, provider);
  const project = await seedTelegramProject(backendRegistry);

  await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');
  await service.upsertProjectSyncRow({
    forumGroupId: '-100556',
    forumGroupTitle: 'Project forum',
    projectId: project.id
  });
  await service.sync();

  provider.updates = [
    {
      updateId: 102,
      message: {
        messageId: 56,
        text: 'noise from another topic',
        chatId: '-100556',
        chatType: 'supergroup',
        messageThreadId: 999,
        senderId: '12345',
        senderIsBot: false
      }
    }
  ];

  const poller = new TelegramInboundPoller(
    configStore,
    service,
    {
      handleInboundEvent: async () => {
        throw new Error('should not route unbound topic messages');
      }
    },
    {
      resumeAndRun: async () => {
        throw new Error('should not execute unbound topic messages');
      }
    },
    fakeSlashCommandService(),
    provider,
    10
  );

  const result = await poller.pollOnce();
  const connection = await service.getConnectionState();

  assert.equal(result.processed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(connection.status.text, 'Active');
  assert.equal(connection.issue, null);
});

test('TelegramInboundPoller handles slash commands without starting a Codex turn', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase6-poller-'));
  const backendRegistry = new PersistentBackendRegistry(join(tempRoot, 'backend-registry.json'));
  const configStore = new TelegramConfigStore(join(tempRoot, 'telegram-config.json'));
  const provider = new FakeTelegramPollingProvider();
  const service = new TelegramService(configStore, backendRegistry, provider);
  const project = await seedTelegramProject(backendRegistry);

  await service.setBotToken('123456:ABCDefghijklmnopqrstuvwxyz_1234', '12345');
  await service.upsertProjectSyncRow({
    forumGroupId: '-100557',
    forumGroupTitle: 'Project forum',
    projectId: project.id
  });
  await service.sync();

  provider.updates = [
    {
      updateId: 103,
      message: {
        messageId: 57,
        text: '/status',
        chatId: '-100557',
        chatType: 'supergroup',
        messageThreadId: 1,
        senderId: '12345',
        senderIsBot: false
      }
    }
  ];

  let executorRuns = 0;
  const poller = new TelegramInboundPoller(
    configStore,
    service,
    {
      handleInboundEvent: async (event: NormalizedInboundEvent): Promise<ControlPlaneDispatchReceipt> => ({
        accepted: true,
        taskId: 'task-1',
        installId: 'install-telegram-poller',
        machineId: 'machine-telegram-poller',
        routedThreadId: event.threadId,
        routeKey: event.threadId,
        receivedAt: new Date().toISOString()
      })
    },
    {
      resumeAndRun: async () => {
        executorRuns += 1;
        return {
          threadId: 'codex-thread-1',
          assistantReply: 'should not happen'
        };
      }
    },
    fakeSlashCommandService(async () => ({
      messages: ['status ok']
    })),
    provider,
    10
  );

  const result = await poller.pollOnce();

  assert.equal(result.processed, 1);
  assert.equal(result.skipped, 0);
  assert.equal(executorRuns, 0);
  assert.equal(provider.sentMessages.length, 1);
  assert.equal(provider.sentMessages[0]?.text, 'status ok');
  assert.equal(provider.sentMessages[0]?.replyToMessageId, undefined);
});
