import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, ipcMain } from 'electron';

import type {
  CodexEnvironmentSnapshot,
  CodexThreadListResult,
  CodexThreadRecord,
  RuntimeBootstrapState,
  RuntimeServerStartResult,
} from '@shared/contracts';
import {
  buildRuntimeBootstrapState,
  createDefaultChannels,
  LocalRuntimeController,
  resolveCodexAppStatus,
  resolveCodexCliStatus,
  resolveCodexStatus
} from './runtime';
import { PersistentBackendRegistry } from './backend-registry';
import { LocalCompanionRegistry } from './companion-registry';
import { InProcessCompanionTransport } from './companion-transport';
import { ControlPlaneBackend } from './control-plane';
import { CodexLocalStore } from './codex-store';
import { ProductApiService } from './product-api';
import { TelegramConfigStore } from './telegram-config';
import { HttpTelegramBotProvider } from './telegram-provider';
import { TelegramService } from './telegram-service';
import { CodexThreadExecutor } from './codex-thread-executor';
import { CodexAppServerClient } from './app-server-client';
import { TelegramInboundPoller } from './telegram-poller';
import {
  RemoteExecutionSettingsService,
  RemoteExecutionSettingsStore
} from './remote-execution-settings';
import { TelegramSlashCommandService } from './telegram-slash-commands';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TELEGRAM_POLL_INTERVAL_MS = 3000;

const runtimeController = new LocalRuntimeController();
const codexStore = new CodexLocalStore();
const companionRegistry = new LocalCompanionRegistry();
const backendRegistry = new PersistentBackendRegistry();
const telegramConfigStore = new TelegramConfigStore();
const remoteExecutionSettingsStore = new RemoteExecutionSettingsStore();
const telegramProvider = new HttpTelegramBotProvider();
const telegramService = new TelegramService(
  telegramConfigStore,
  backendRegistry,
  telegramProvider
);
const codexExecutor = new CodexThreadExecutor(codexStore);
const remoteExecutionSettingsService = new RemoteExecutionSettingsService(
  remoteExecutionSettingsStore,
  codexStore,
  () => CodexAppServerClient.start()
);
const telegramSlashCommands = new TelegramSlashCommandService(
  remoteExecutionSettingsService,
  codexStore
);
const controlPlane = new ControlPlaneBackend({
  registry: companionRegistry,
  backendRegistry,
  transport: new InProcessCompanionTransport(runtimeController)
});
const telegramPoller = new TelegramInboundPoller(
  telegramConfigStore,
  telegramService,
  controlPlane,
  codexExecutor,
  telegramSlashCommands,
  telegramProvider,
  TELEGRAM_POLL_INTERVAL_MS
);
const productApi = new ProductApiService({
  getRuntimeState,
  controlPlane,
  backendRegistry,
  codexStore,
  telegramService
});
const windows = new Set<BrowserWindow>();
const channels = createDefaultChannels();

function isBrokenPipeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EPIPE';
}

function safeConsoleLog(message: string): void {
  try {
    if (!process.stdout || process.stdout.destroyed || !process.stdout.writable) {
      return;
    }
    console.log(message);
  } catch (error) {
    if (!isBrokenPipeError(error)) {
      throw error;
    }
  }
}

function safeConsoleError(message: string): void {
  try {
    if (!process.stderr || process.stderr.destroyed || !process.stderr.writable) {
      return;
    }
    console.error(message);
  } catch (error) {
    if (!isBrokenPipeError(error)) {
      throw error;
    }
  }
}

function getCodexDetection() {
  const appPath = [
    '/Applications/Codex.app',
    join(homedir(), 'Applications', 'Codex.app')
  ].find((candidate) => existsSync(candidate)) ?? null;
  const appDetected = appPath !== null;

  const cliDetected = spawnSync('which', ['codex'], {
    stdio: 'ignore'
  }).status === 0;

  return {
    appDetected,
    cliDetected,
    appVersion: appPath ? readCodexAppVersion(appPath) : null,
    cliVersion: cliDetected ? readCodexCliVersion() : null
  };
}

function readCodexAppVersion(appPath: string): string | null {
  const infoPlistPath = join(appPath, 'Contents', 'Info.plist');
  if (!existsSync(infoPlistPath)) {
    return null;
  }

  const versionResult = spawnSync(
    'plutil',
    ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlistPath],
    { encoding: 'utf8' }
  );

  const shortVersion = versionResult.status === 0 ? versionResult.stdout.trim() : '';
  if (shortVersion) {
    return shortVersion;
  }

  const buildResult = spawnSync(
    'plutil',
    ['-extract', 'CFBundleVersion', 'raw', '-o', '-', infoPlistPath],
    { encoding: 'utf8' }
  );
  const buildVersion = buildResult.status === 0 ? buildResult.stdout.trim() : '';
  return buildVersion || null;
}

function readCodexCliVersion(): string | null {
  const versionResult = spawnSync('codex', ['--version'], {
    encoding: 'utf8'
  });

  if (versionResult.status !== 0) {
    return null;
  }

  return versionResult.stdout.trim() || null;
}

function getRuntimeState(): RuntimeBootstrapState {
  const detection = getCodexDetection();
  return buildRuntimeBootstrapState({
    codexStatus: resolveCodexStatus(detection),
    codexAppStatus: resolveCodexAppStatus(detection.appDetected),
    codexAppVersion: detection.appVersion,
    codexCliStatus: resolveCodexCliStatus(detection.cliDetected),
    codexCliVersion: detection.cliVersion,
    serverRunning: runtimeController.isRunning(),
    serverPort: runtimeController.getPort(),
    channels
  });
}

function getMainWindowTitle(): string {
  return 'Codex Remote Companion';
}

function getWindowOptions() {
  return {
    width: 1240,
    height: 860,
    minWidth: 960,
    minHeight: 720,
    title: getMainWindowTitle(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false
    }
  } satisfies ConstructorParameters<typeof BrowserWindow>[0];
}

function broadcastRuntimeState(): void {
  const state = getRuntimeState();
  for (const window of windows) {
    window.webContents.send('runtime:state-changed', state);
  }
}

async function createMainWindow(): Promise<void> {
  const window = new BrowserWindow(getWindowOptions());

  windows.add(window);
  window.on('closed', () => windows.delete(window));
  window.webContents.on('console-message', (_event, level, message) => {
    safeConsoleLog(`[renderer:${level}] ${message}`);
  });
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    safeConsoleError(`[preload-error] ${preloadPath}: ${error.message}`);
  });
  window.webContents.on('did-finish-load', () => {
    void window.webContents
      .executeJavaScript('typeof window.codexDesktop')
      .then((value) => safeConsoleLog(`[bridge-check] window.codexDesktop => ${value}`))
      .catch((error) => safeConsoleError(`[bridge-check:error] ${error.message}`));
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

ipcMain.handle('runtime:get-bootstrap-state', async () => getRuntimeState());
ipcMain.handle(
  'codex:get-environment-snapshot',
  async (): Promise<CodexEnvironmentSnapshot> => codexStore.getEnvironmentSnapshot()
);
ipcMain.handle(
  'codex:list-threads',
  async (): Promise<CodexThreadListResult> => ({
    threads: await codexStore.listThreads(),
    source: 'local-files'
  })
);
ipcMain.handle(
  'codex:read-thread',
  async (_event, threadId: string): Promise<CodexThreadRecord> => codexStore.readThread(threadId)
);
ipcMain.handle('control-plane:get-status', async () => controlPlane.getStatus());
ipcMain.handle('product:get-installation-state', async () => productApi.getInstallationState());
ipcMain.handle('product:get-machine-state', async () => productApi.getMachineState());
ipcMain.handle('product:get-sync-status', async () => productApi.getSyncStatus());
ipcMain.handle('product:trigger-sync', async () => productApi.triggerSync());
ipcMain.handle('product:list-codex-projects', async () => productApi.listCodexProjects());
ipcMain.handle('product:list-codex-project-threads', async (_event, projectId: string) =>
  productApi.listCodexProjectThreads(projectId)
);
ipcMain.handle('product:ensure-codex-project', async (_event, projectId: string) =>
  productApi.ensureCodexProject(projectId)
);
ipcMain.handle('product:list-projects', async () => productApi.listProjects());
ipcMain.handle('product:create-project', async (_event, input) => productApi.createProject(input));
ipcMain.handle('product:list-project-threads', async (_event, projectId: string) =>
  productApi.listProjectThreads(projectId)
);
ipcMain.handle('product:create-project-thread', async (_event, input) =>
  productApi.createProjectThread(input)
);
ipcMain.handle('product:list-channel-connections', async () =>
  productApi.listChannelConnections()
);
ipcMain.handle('product:list-platform-bindings', async () => productApi.listPlatformBindings());
ipcMain.handle('product:create-platform-binding', async (_event, input) =>
  productApi.createPlatformBinding(input)
);
ipcMain.handle('product:list-codex-thread-bindings', async () =>
  productApi.listCodexThreadBindings()
);
ipcMain.handle('product:create-codex-thread-binding', async (_event, input) =>
  productApi.createCodexThreadBinding(input)
);
ipcMain.handle('product:list-active-thread-states', async () =>
  productApi.listActiveThreadStates()
);
ipcMain.handle('product:upsert-active-thread-state', async (_event, input) =>
  productApi.upsertActiveThreadState(input)
);
ipcMain.handle('product:get-failure-summary', async () => productApi.getFailureSummary());
ipcMain.handle('product:get-health-summary', async () => productApi.getHealthSummary());
ipcMain.handle('product:repair-bootstrap', async () => productApi.repairBootstrap());
ipcMain.handle('telegram:get-connection-state', async () => telegramService.getConnectionState());
ipcMain.handle('telegram:validate-connection', async () =>
  telegramService.validateConnection()
);
ipcMain.handle('telegram:check-environment', async (_event, rowId: string) =>
  telegramService.checkEnvironment(rowId)
);
ipcMain.handle('telegram:set-bot-token', async (_event, token: string, ownerUserId: string) =>
  telegramService.setBotToken(token, ownerUserId)
);
ipcMain.handle('telegram:remove-bot-token', async () =>
  telegramService.removeBotToken()
);
ipcMain.handle('telegram:upsert-project-sync-row', async (_event, input) =>
  telegramService.upsertProjectSyncRow(input)
);
ipcMain.handle('telegram:remove-project-sync-row', async (_event, rowId: string) =>
  telegramService.removeProjectSyncRow(rowId)
);
ipcMain.handle('telegram:setup-environment', async (_event, input) =>
  telegramService.setupEnvironment(input)
);
ipcMain.handle('telegram:repair-environment', async (_event, rowId: string) =>
  telegramService.repairEnvironment(rowId)
);
ipcMain.handle('telegram:sync', async () => telegramService.sync());

ipcMain.handle(
  'runtime:start-server',
  async (): Promise<RuntimeServerStartResult> => {
    await runtimeController.start();
    telegramPoller.start();
    const state = getRuntimeState();
    broadcastRuntimeState();
    return { ok: true, state };
  }
);

ipcMain.handle(
  'runtime:stop-server',
  async (): Promise<RuntimeServerStartResult> => {
    await telegramPoller.stop();
    await codexExecutor.dispose();
    await runtimeController.stop();
    const state = getRuntimeState();
    broadcastRuntimeState();
    return { ok: true, state };
  }
);

app.whenReady().then(async () => {
  await createMainWindow();
  broadcastRuntimeState();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
      broadcastRuntimeState();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  void telegramPoller.stop();
  void codexExecutor.dispose();
});
