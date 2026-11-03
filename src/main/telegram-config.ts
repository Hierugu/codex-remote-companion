import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import type {
  TelegramConnectionState,
  TelegramProjectSyncRow,
  TelegramProjectSyncRowInput,
  TelegramSyncSummary
} from '@shared/contracts';

import { parseJsonWithRecovery, writeJsonAtomically } from './json-file';
import { getCompanionStatePath, getLegacyCompanionStatePath } from './companion-paths';

interface TelegramConfigFileShape {
  botToken: string | null;
  ownerUserId: string | null;
  botUsername: string | null;
  botUserId: string | null;
  rows: TelegramProjectSyncRow[];
  lastSync: TelegramSyncSummary | null;
  lastUpdateId: number | null;
  issue: string | null;
}

function normalizeProjectRow(
  row: TelegramProjectSyncRow,
  setupCompletedAtFallback: string | null
): TelegramProjectSyncRow {
  return {
    ...row,
    setupCompletedAt: row.setupCompletedAt ?? setupCompletedAtFallback,
    lastIssue: row.lastIssue ?? null
  };
}

function createDefaultState(): TelegramConfigFileShape {
  return {
    botToken: null,
    ownerUserId: null,
    botUsername: null,
    botUserId: null,
    rows: [],
    lastSync: null,
    lastUpdateId: null,
    issue: null
  };
}

function maskTelegramBotToken(token: string | null): string | null {
  if (!token) {
    return null;
  }

  const [prefix, suffix] = token.split(':');
  if (!suffix) {
    return '********';
  }

  const suffixTail = suffix.slice(-4);
  return `${prefix}:********${suffixTail}`;
}

function isNonBlockingTelegramIssue(issue: string | null): boolean {
  return issue === 'Broken Telegram binding';
}

export function getDefaultTelegramConfigPath(): string {
  return getCompanionStatePath('telegram-config.json');
}

function getLegacyTelegramConfigPath(): string | null {
  return getLegacyCompanionStatePath('telegram-config.json');
}

export class TelegramConfigStore {
  constructor(
    private readonly configPath = getDefaultTelegramConfigPath(),
    private readonly legacyConfigPath = getLegacyTelegramConfigPath()
  ) {}

  getConfigPath(): string {
    return this.configPath;
  }

  async readState(): Promise<TelegramConfigFileShape> {
    const sourcePath = this.getReadableConfigPath();
    if (!sourcePath) {
      return createDefaultState();
    }

    const raw = await readFile(sourcePath, 'utf8');
    const { value, repaired } = parseJsonWithRecovery<TelegramConfigFileShape>(raw);
    const normalized: TelegramConfigFileShape = {
      botToken: value.botToken ?? null,
      ownerUserId: value.ownerUserId ?? null,
      botUsername: value.botUsername ?? null,
      botUserId: value.botUserId ?? null,
      rows: Array.isArray(value.rows)
        ? value.rows.map((row) => normalizeProjectRow(row, value.lastSync?.syncedAt ?? null))
        : [],
      lastSync: value.lastSync ?? null,
      lastUpdateId: value.lastUpdateId ?? null,
      issue: value.issue ?? null
    };

    if (repaired || sourcePath !== this.configPath) {
      await this.writeState(normalized);
    }

    return normalized;
  }

  async writeBotToken(input: {
    botToken: string;
    ownerUserId?: string;
    botUsername: string | null;
    botUserId: string | null;
  }): Promise<TelegramConfigFileShape> {
    const state = await this.readState();
    const nextState: TelegramConfigFileShape = {
      ...state,
      botToken: input.botToken,
      ownerUserId: input.ownerUserId ?? state.ownerUserId,
      botUsername: input.botUsername,
      botUserId: input.botUserId,
      issue: null
    };

    await this.writeState(nextState);
    return nextState;
  }

  async removeBotToken(): Promise<TelegramConfigFileShape> {
    const state = await this.readState();
    const nextState: TelegramConfigFileShape = {
      ...state,
      botToken: null,
      ownerUserId: null,
      botUsername: null,
      botUserId: null,
      lastUpdateId: null,
      issue: null
    };

    await this.writeState(nextState);
    return nextState;
  }

  async upsertProjectRow(input: TelegramProjectSyncRowInput): Promise<TelegramConfigFileShape> {
    const state = await this.readState();
    const existingRow = state.rows.find((item) => item.id === input.rowId);
    const preservesSetup =
      existingRow != null &&
      existingRow.forumGroupId === input.forumGroupId &&
      existingRow.projectId === input.projectId;
    const row: TelegramProjectSyncRow = {
      id: input.rowId ?? `telegram-row:${randomUUID()}`,
      forumGroupId: input.forumGroupId,
      forumGroupTitle: input.forumGroupTitle,
      projectId: input.projectId,
      setupCompletedAt: preservesSetup ? existingRow.setupCompletedAt : null,
      lastIssue: preservesSetup ? existingRow.lastIssue : null
    };

    const existingIndex = state.rows.findIndex((item) => item.id === row.id);
    const rows =
      existingIndex === -1
        ? [...state.rows, row]
        : state.rows.map((item, index) => (index === existingIndex ? row : item));

    const nextState: TelegramConfigFileShape = {
      ...state,
      rows
    };

    await this.writeState(nextState);
    return nextState;
  }

  async removeProjectRow(rowId: string): Promise<TelegramConfigFileShape> {
    const state = await this.readState();
    const nextState: TelegramConfigFileShape = {
      ...state,
      rows: state.rows.filter((row) => row.id !== rowId)
    };

    await this.writeState(nextState);
    return nextState;
  }

  async recordSync(summary: TelegramSyncSummary): Promise<TelegramConfigFileShape> {
    const state = await this.readState();
    const nextState: TelegramConfigFileShape = {
      ...state,
      lastSync: summary,
      issue: null
    };

    await this.writeState(nextState);
    return nextState;
  }

  async recordRowSetup(rowId: string): Promise<TelegramConfigFileShape> {
    const state = await this.readState();
    const nextState: TelegramConfigFileShape = {
      ...state,
      issue: null,
      rows: state.rows.map((row) =>
        row.id === rowId
          ? { ...row, setupCompletedAt: new Date().toISOString(), lastIssue: null }
          : row
      )
    };

    await this.writeState(nextState);
    return nextState;
  }

  async recordRowIssue(rowId: string, issue: string | null): Promise<TelegramConfigFileShape> {
    const state = await this.readState();
    const nextState: TelegramConfigFileShape = {
      ...state,
      issue,
      rows: state.rows.map((row) => (row.id === rowId ? { ...row, lastIssue: issue } : row))
    };

    await this.writeState(nextState);
    return nextState;
  }

  async recordLastUpdateId(lastUpdateId: number): Promise<TelegramConfigFileShape> {
    const state = await this.readState();
    const nextState: TelegramConfigFileShape = {
      ...state,
      lastUpdateId
    };

    await this.writeState(nextState);
    return nextState;
  }

  async getPollingConfig(): Promise<{
    botToken: string | null;
    botUserId: string | null;
    ownerUserId: string | null;
    rows: TelegramProjectSyncRow[];
    lastUpdateId: number | null;
  }> {
    const state = await this.readState();
    return {
      botToken: state.botToken,
      botUserId: state.botUserId,
      ownerUserId: state.ownerUserId,
      rows: state.rows,
      lastUpdateId: state.lastUpdateId
    };
  }

  async recordIssue(issue: string | null): Promise<TelegramConfigFileShape> {
    const state = await this.readState();
    const nextState: TelegramConfigFileShape = {
      ...state,
      issue
    };

    await this.writeState(nextState);
    return nextState;
  }

  toConnectionState(state: TelegramConfigFileShape): TelegramConnectionState {
    const hasToken = Boolean(state.botToken);
    const hasOwner = Boolean(state.ownerUserId);
    const hasRows = state.rows.length > 0;
    const hasBlockingIssue = Boolean(state.issue) && !isNonBlockingTelegramIssue(state.issue);
    const rowIssue = state.rows.find((row) => row.lastIssue)?.lastIssue ?? null;
    const hasRowIssue = Boolean(rowIssue);
    const allRowsCompleted = hasRows && state.rows.every((row) => row.setupCompletedAt);
    const displayIssue = hasBlockingIssue ? state.issue : rowIssue;

    if (!hasToken) {
      return {
        status: { tone: 'red', text: 'Not connected' },
        maskedBotToken: null,
        botUsername: null,
        ownerUserId: state.ownerUserId,
        rows: state.rows,
        lastSync: state.lastSync,
        issue: displayIssue
      };
    }

    if (!hasOwner) {
      return {
        status: { tone: 'yellow', text: 'Owner ID required' },
        maskedBotToken: maskTelegramBotToken(state.botToken),
        botUsername: state.botUsername,
        ownerUserId: null,
        rows: state.rows,
        lastSync: state.lastSync,
        issue: 'Set your numeric Telegram user ID before accepting messages.'
      };
    }

    if (hasBlockingIssue || hasRowIssue) {
      return {
        status: { tone: 'yellow', text: 'Needs attention' },
        maskedBotToken: maskTelegramBotToken(state.botToken),
        botUsername: state.botUsername,
        ownerUserId: state.ownerUserId,
        rows: state.rows,
        lastSync: state.lastSync,
        issue: displayIssue
      };
    }

    if (!hasRows || !allRowsCompleted) {
      return {
        status: { tone: 'yellow', text: 'Setup required' },
        maskedBotToken: maskTelegramBotToken(state.botToken),
        botUsername: state.botUsername,
        ownerUserId: state.ownerUserId,
        rows: state.rows,
        lastSync: state.lastSync,
        issue: displayIssue
      };
    }

    return {
      status: { tone: 'green', text: 'Active' },
      maskedBotToken: maskTelegramBotToken(state.botToken),
      botUsername: state.botUsername,
      ownerUserId: state.ownerUserId,
      rows: state.rows,
      lastSync: state.lastSync,
      issue: displayIssue
    };
  }

  private async writeState(nextState: TelegramConfigFileShape): Promise<void> {
    await writeJsonAtomically(this.configPath, nextState);
  }

  private getReadableConfigPath(): string | null {
    if (existsSync(this.configPath)) {
      return this.configPath;
    }

    if (
      this.configPath === getDefaultTelegramConfigPath() &&
      this.legacyConfigPath !== null &&
      existsSync(this.legacyConfigPath)
    ) {
      return this.legacyConfigPath;
    }

    return null;
  }
}
