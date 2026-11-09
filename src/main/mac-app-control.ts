import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type RemoteApp = 'vscode' | 'codex';
export type RemoteAppStatus = Record<RemoteApp, boolean>;
export interface RemoteAppQuitResult {
  requested: Record<RemoteApp, boolean>;
  exited: Record<RemoteApp, boolean>;
}

const execFileAsync = promisify(execFile);

export class MacAppControl {
  constructor(private readonly executable: string) {}

  async status(): Promise<RemoteAppStatus> {
    return this.run<RemoteAppStatus>(['status']);
  }

  async quit(targets: RemoteApp[]): Promise<RemoteAppQuitResult> {
    if (targets.length === 0 || targets.some((target) => target !== 'vscode' && target !== 'codex')) {
      throw new Error('Invalid application selection.');
    }
    return this.run<RemoteAppQuitResult>(['quit', ...targets]);
  }

  private async run<T>(args: string[]): Promise<T> {
    if (process.platform !== 'darwin') throw new Error('Remote application control requires macOS.');
    const { stdout } = await execFileAsync(this.executable, args, {
      timeout: 18_000,
      maxBuffer: 4096
    });
    return JSON.parse(stdout) as T;
  }
}
