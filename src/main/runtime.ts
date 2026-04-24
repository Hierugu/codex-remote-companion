import { createServer, type Server } from 'node:http';

import type {
  CompanionDispatchTask,
  MessengerChannelState,
  RuntimeTaskDispatchResult,
  RuntimeBootstrapState,
  StatusBadgeState
} from '@shared/contracts';

export interface CodexDetectionInput {
  appDetected: boolean;
  cliDetected: boolean;
}

export interface LocalRuntimeControllerOptions {
  host?: string;
  port?: number;
}

export const DEFAULT_SERVER_HOST = '127.0.0.1';
export const DEFAULT_SERVER_PORT = 4317;

export function createDefaultChannels(): MessengerChannelState[] {
  return [
    {
      key: 'telegram',
      label: 'Telegram',
      status: { tone: 'red', text: 'Not connected' }
    }
  ];
}

export function resolveCodexStatus({
  appDetected,
  cliDetected
}: CodexDetectionInput): StatusBadgeState {
  if (appDetected && cliDetected) {
    return { tone: 'green', text: 'Codex App and CLI detected' };
  }

  if (appDetected) {
    return { tone: 'green', text: 'Codex App detected' };
  }

  if (cliDetected) {
    return { tone: 'green', text: 'Codex CLI detected' };
  }

  return { tone: 'red', text: 'Codex not detected' };
}

export function resolveCodexAppStatus(
  appDetected: boolean
): StatusBadgeState {
  return {
    tone: appDetected ? 'green' : 'red',
    text: appDetected ? 'Detected' : 'Not detected'
  };
}

export function resolveCodexCliStatus(
  cliDetected: boolean
): StatusBadgeState {
  return {
    tone: cliDetected ? 'green' : 'red',
    text: cliDetected ? 'Detected' : 'Not detected'
  };
}

export function getServerStatus(isRunning: boolean): StatusBadgeState {
  if (isRunning) {
    return { tone: 'green', text: 'Codex server is running' };
  }

  return { tone: 'red', text: 'Codex server turned off' };
}

export function buildRuntimeBootstrapState(input: {
  codexStatus: StatusBadgeState;
  codexAppStatus: StatusBadgeState;
  codexAppVersion?: string | null;
  codexCliStatus: StatusBadgeState;
  codexCliVersion?: string | null;
  serverRunning: boolean;
  serverPort: number | null;
  channels?: MessengerChannelState[];
}): RuntimeBootstrapState {
  return {
    codexStatus: input.codexStatus,
    codexAppStatus: input.codexAppStatus,
    codexAppVersion: input.codexAppVersion ?? null,
    codexCliStatus: input.codexCliStatus,
    codexCliVersion: input.codexCliVersion ?? null,
    serverStatus: getServerStatus(input.serverRunning),
    channels: input.channels ?? createDefaultChannels(),
    serverPort: input.serverPort
  };
}

export class LocalRuntimeController {
  private readonly host: string;

  private readonly requestedPort: number;

  private server: Server | null = null;

  private port: number | null = null;

  private lastDispatchedTask: CompanionDispatchTask | null = null;

  constructor(options: LocalRuntimeControllerOptions = {}) {
    this.host = options.host ?? DEFAULT_SERVER_HOST;
    this.requestedPort = options.port ?? DEFAULT_SERVER_PORT;
  }

  async start(): Promise<void> {
    if (this.server && this.port) {
      return;
    }

    const preferredServer = this.createHttpServer();
    try {
      await this.listenOnPort(preferredServer, this.requestedPort);
      this.server = preferredServer;
      return;
    } catch (error) {
      preferredServer.close();

      if (!this.isAddressInUseError(error)) {
        throw error;
      }
    }

    const fallbackServer = this.createHttpServer();
    await this.listenOnPort(fallbackServer, 0);
    this.server = fallbackServer;
  }

  async stop(): Promise<void> {
    if (!this.server) {
      this.port = null;
      return;
    }

    const activeServer = this.server;
    this.server = null;
    this.port = null;

    await new Promise<void>((resolvePromise, rejectPromise) => {
      activeServer.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }

        resolvePromise();
      });
    });
  }

  isRunning(): boolean {
    return Boolean(this.server && this.port);
  }

  getPort(): number | null {
    return this.port;
  }

  async dispatchTask(task: CompanionDispatchTask): Promise<RuntimeTaskDispatchResult> {
    if (!this.isRunning()) {
      throw new Error('Local runtime must be running before dispatching tasks.');
    }

    this.lastDispatchedTask = task;

    return {
      accepted: true,
      taskId: task.taskId,
      receivedAt: new Date().toISOString()
    };
  }

  getLastDispatchedTask(): CompanionDispatchTask | null {
    return this.lastDispatchedTask;
  }

  private createHttpServer(): Server {
    return createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            ok: true,
            service: 'codex-remote-companion-local-runtime',
            port: this.port,
            lastTaskId: this.lastDispatchedTask?.taskId ?? null
          })
        );
        return;
      }

      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'Not found' }));
    });
  }

  private async listenOnPort(server: Server, port: number): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const handleError = (error: Error) => {
        server.removeListener('listening', handleListening);
        rejectPromise(error);
      };

      const handleListening = () => {
        server.removeListener('error', handleError);
        const address = server.address();

        if (typeof address === 'string' || address == null) {
          rejectPromise(new Error('Local runtime did not expose a usable address.'));
          return;
        }

        this.port = address.port;
        resolvePromise();
      };

      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen(port, this.host);
    });
  }

  private isAddressInUseError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'EADDRINUSE'
    );
  }
}
