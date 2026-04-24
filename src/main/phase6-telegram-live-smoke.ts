import assert from 'node:assert/strict';

import { PersistentBackendRegistry } from './backend-registry';
import { CodexLocalStore } from './codex-store';
import { LocalCompanionRegistry } from './companion-registry';
import { TelegramConfigStore } from './telegram-config';
import { HttpTelegramBotProvider } from './telegram-provider';
import { TelegramService } from './telegram-service';

interface CliInputs {
  botToken: string;
  forumGroupId: string;
  forumGroupTitle: string;
}

function readCliInputs(): CliInputs {
  const [, , botToken, forumGroupId, forumGroupTitle] = process.argv;

  assert.ok(botToken, 'Telegram bot token is required.');
  assert.ok(forumGroupId, 'Telegram forum group id is required.');

  return {
    botToken,
    forumGroupId,
    forumGroupTitle: forumGroupTitle ?? forumGroupId
  };
}

async function main() {
  const { botToken, forumGroupId, forumGroupTitle } = readCliInputs();

  const companionRegistry = new LocalCompanionRegistry();
  const backendRegistry = new PersistentBackendRegistry();
  const codexStore = new CodexLocalStore();
  const telegramService = new TelegramService(
    new TelegramConfigStore(),
    backendRegistry,
    new HttpTelegramBotProvider()
  );

  const identity = await companionRegistry.ensureInstallIdentity();
  await backendRegistry.ensureBootstrap(identity);

  const localThreads = await codexStore.listThreads(2);
  const selectedThreads = localThreads.slice(0, 2);
  assert.ok(selectedThreads.length > 0, 'No local Codex threads found for Telegram live smoke.');

  const userId = `user:${identity.installId}`;
  const project = await backendRegistry.upsertProject({
    id: 'project:telegram-live-smoke',
    userId,
    platform: 'telegram',
    name: 'Telegram live smoke'
  });

  for (const [index, thread] of selectedThreads.entries()) {
    const projectThreadId = `project-thread:telegram-live-smoke:${index + 1}`;
    await backendRegistry.upsertProjectThread({
      id: projectThreadId,
      projectId: project.id,
      title: thread.title,
      archived: false
    });
    await backendRegistry.upsertCodexThreadBinding({
      id: `codex-binding:telegram-live-smoke:${index + 1}`,
      projectThreadId,
      machineId: identity.machineId,
      codexThreadId: thread.id
    });
  }

  await telegramService.setBotToken(botToken);
  await telegramService.upsertProjectSyncRow({
    rowId: 'telegram-row:live-smoke',
    forumGroupId,
    forumGroupTitle,
    projectId: project.id
  });

  const syncResult = await telegramService.sync();
  const registryState = await backendRegistry.readState();
  const topicBindings = registryState.platformBindings.filter(
    (binding) =>
      binding.platform === 'telegram' &&
      binding.bindingType === 'thread-surface' &&
      binding.projectId === project.id
  );

  const firstProjectThread = registryState.projectThreads.find(
    (thread) => thread.projectId === project.id
  );

  let outboundProbe = null;
  if (firstProjectThread) {
    outboundProbe = await telegramService.sendThreadReply({
      projectThreadId: firstProjectThread.id,
      text: 'Codex Remote Companion Telegram live smoke ok'
    });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        projectId: project.id,
        threadTitles: registryState.projectThreads
          .filter((thread) => thread.projectId === project.id)
          .map((thread) => thread.title),
        sync: syncResult.summary,
        topicBindings: topicBindings.map((binding) => ({
          projectThreadId: binding.projectThreadId,
          surfaceId: binding.surfaceId,
          surfaceLabel: binding.surfaceLabel
        })),
        outboundProbe
      },
      null,
      2
    )
  );
}

void main();
