import assert from 'node:assert/strict';
import test from 'node:test';

import type { StatusBadgeState, TelegramConnectionState } from '@shared/contracts';

import {
  buildCodexDetectionSummary,
  buildRateLimitCardModel,
  buildTelegramDraftRows,
  getActiveThreadsButtonModel,
  getChannelStatusForServerState,
  getServerButtonText,
  getServerSupportText,
  getServerUiStatus,
  getTelegramRowHealthStatus,
  getTelegramRowStatus,
  getTelegramTokenButtonLabel,
  isTelegramRowLocked
} from './App';

const serverOff: StatusBadgeState = { tone: 'red', text: 'Codex server turned off' };
const serverOn: StatusBadgeState = { tone: 'green', text: 'Codex server is running' };

function codexSummaryInput(overrides: Partial<{
  codexAppStatus: StatusBadgeState;
  codexAppVersion: string | null;
  codexCliStatus: StatusBadgeState;
  codexCliVersion: string | null;
}> = {}): {
  codexAppStatus: StatusBadgeState;
  codexAppVersion: string | null;
  codexCliStatus: StatusBadgeState;
  codexCliVersion: string | null;
} {
  return {
    codexAppStatus: { tone: 'red', text: 'Not detected' },
    codexAppVersion: null,
    codexCliStatus: { tone: 'red', text: 'Not detected' },
    codexCliVersion: null,
    ...overrides
  };
}

function connection(overrides: Partial<TelegramConnectionState> = {}): TelegramConnectionState {
  return {
    status: { tone: 'green', text: 'Active' },
    maskedBotToken: '8571788070:********56sY',
    botUsername: 'apsboydmdmmd_bot',
    ownerUserId: '12345',
    rows: [],
    lastSync: null,
    issue: null,
    ...overrides
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    localId: 'row:local',
    rowId: 'telegram-row:1',
    forumGroupId: '-1003739703024',
    forumGroupTitle: 'asptest',
    projectId: 'APs',
    setupCompletedAt: '2026-04-20T10:00:00.000Z',
    lastIssue: null,
    ...overrides
  };
}

test('dashboard server button and status labels cover off, on, starting and stopping states', () => {
  assert.deepEqual(getServerUiStatus(serverOff, null), serverOff);
  assert.deepEqual(getServerUiStatus(serverOn, null), serverOn);
  assert.deepEqual(getServerUiStatus(serverOff, 'starting'), {
    tone: 'yellow',
    text: 'Codex server turning on'
  });
  assert.deepEqual(getServerUiStatus(serverOn, 'stopping'), {
    tone: 'yellow',
    text: 'Codex server turning off'
  });

  assert.equal(getServerButtonText(serverOff, null), 'Start server');
  assert.equal(getServerButtonText(serverOn, null), 'Stop server');
  assert.equal(getServerButtonText(serverOff, 'starting'), 'Starting...');
  assert.equal(getServerButtonText(serverOn, 'stopping'), 'Stopping...');

  assert.equal(
    getServerSupportText(serverOff, null, null),
    'Start the local server to enable channel runtimes.'
  );
  assert.equal(
    getServerSupportText(serverOn, null, 4317),
    'Local server port: 4317'
  );
});

test('channel status downgrades active connections to awaiting server start when server is off', () => {
  assert.deepEqual(
    getChannelStatusForServerState({ tone: 'green', text: 'Active' }, serverOff),
    { tone: 'yellow', text: 'Awaiting server start' }
  );
  assert.deepEqual(
    getChannelStatusForServerState({ tone: 'green', text: 'Active' }, serverOn),
    { tone: 'green', text: 'Active' }
  );
  assert.deepEqual(
    getChannelStatusForServerState({ tone: 'red', text: 'Disconnected' }, serverOff),
    { tone: 'red', text: 'Disconnected' }
  );
});

test('codex status summary shows both detected runtimes when both are available', () => {
  const summary = buildCodexDetectionSummary(
    codexSummaryInput({
      codexAppStatus: { tone: 'green', text: 'Detected' },
      codexAppVersion: '26.417.40842',
      codexCliStatus: { tone: 'green', text: 'Detected' },
      codexCliVersion: 'codex-cli 0.121.0'
    })
  );

  assert.deepEqual(summary.status, { tone: 'green', text: 'Detected' });
  assert.deepEqual(summary.items, [
    { label: 'Codex App', version: '26.417.40842' },
    { label: 'Codex CLI', version: 'codex-cli 0.121.0' }
  ]);
  assert.equal(summary.fallbackText, null);
});

test('codex status summary hides missing runtime rows and still reports detected when one exists', () => {
  const summary = buildCodexDetectionSummary(
    codexSummaryInput({
      codexAppStatus: { tone: 'green', text: 'Detected' },
      codexAppVersion: '26.417.40842'
    })
  );

  assert.deepEqual(summary.status, { tone: 'green', text: 'Detected' });
  assert.deepEqual(summary.items, [
    { label: 'Codex App', version: '26.417.40842' }
  ]);
  assert.equal(summary.fallbackText, null);
});

test('codex status summary explains when both app and cli are undetected', () => {
  const summary = buildCodexDetectionSummary(codexSummaryInput());

  assert.deepEqual(summary.status, { tone: 'red', text: 'Not detected' });
  assert.deepEqual(summary.items, []);
  assert.equal(summary.fallbackText, 'Codex App and Codex CLI undetected');
});

test('rate limit card model shows countdown and reserve math from local window data', () => {
  const now = new Date('2026-04-20T10:00:00.000Z');

  const session = buildRateLimitCardModel(300, 93, '2026-04-20T14:12:00.000Z', now);
  assert.equal(session.label, '5h remaining');
  assert.equal(session.remainingText, '93%');
  assert.equal(session.resetsText, 'Resets in 4h 12m');
  assert.equal(session.reserveText, null);
  assert.equal(session.paceText, null);

  const weekly = buildRateLimitCardModel(10080, 76, '2026-04-24T09:00:00.000Z', now);
  assert.equal(weekly.label, 'Weekly remaining');
  assert.equal(weekly.resetsText, 'Resets in 3d 23h');
  assert.equal(weekly.reserveText, '19% in reserve');
  assert.equal(weekly.paceText, 'Lasts until reset');
});

test('rate limit card model flags overspend pace when remaining budget is below reset pace', () => {
  const now = new Date('2026-04-20T10:00:00.000Z');
  const weekly = buildRateLimitCardModel(10080, 40, '2026-04-24T09:00:00.000Z', now);

  assert.equal(weekly.reserveText, '17% over pace');
  assert.equal(weekly.paceText, 'May run out early');
});

test('telegram token button uses Save only before first token and Replace afterwards', () => {
  assert.equal(getTelegramTokenButtonLabel(null), 'Save token');
  assert.equal(getTelegramTokenButtonLabel('8571788070:********56sY'), 'Replace token');
});

test('telegram draft rows keep new Add project rows above saved bindings after refresh', () => {
  const savedConnection = connection({
    rows: [
      {
        id: 'telegram-row:saved',
        forumGroupId: '-1003739703024',
        forumGroupTitle: 'asptest',
        projectId: 'APs',
        setupCompletedAt: '2026-04-20T10:00:00.000Z',
        lastIssue: null
      }
    ]
  });
  const draft = row({
    localId: 'telegram-draft:new',
    rowId: undefined,
    forumGroupId: '-1003739703024',
    forumGroupTitle: '',
    projectId: 'Laboratory',
    setupCompletedAt: null,
    preserveOnRefresh: true
  });

  const rows = buildTelegramDraftRows(savedConnection, [draft]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].localId, 'telegram-draft:new');
  assert.equal(rows[1].rowId, 'telegram-row:saved');
});

test('telegram row status covers loading, setup required, active, needs token and issue states', () => {
  assert.deepEqual(getTelegramRowStatus(row(), connection(), null, false), {
    tone: 'yellow',
    text: 'Loading'
  });
  assert.deepEqual(
    getTelegramRowStatus(row({ rowId: undefined, setupCompletedAt: null }), connection(), null, true),
    { tone: 'yellow', text: 'Setup required' }
  );
  assert.deepEqual(getTelegramRowStatus(row(), connection(), null, true), {
    tone: 'green',
    text: 'Active'
  });
  assert.deepEqual(
    getTelegramRowStatus(row(), connection(), 'Draft setup failed', true),
    { tone: 'green', text: 'Active' }
  );
  assert.deepEqual(
    getTelegramRowStatus(row(), connection({ maskedBotToken: null }), null, true),
    { tone: 'yellow', text: 'Needs token' }
  );
  assert.deepEqual(
    getTelegramRowStatus(row({ lastIssue: 'Bot token is invalid' }), connection(), null, true),
    { tone: 'yellow', text: 'Needs attention' }
  );
});

test('telegram row health status follows locked/token/error state', () => {
  assert.equal(
    getTelegramRowHealthStatus(row({ rowId: undefined, setupCompletedAt: null }), connection()),
    null
  );
  assert.deepEqual(getTelegramRowHealthStatus(row(), connection()), {
    tone: 'green',
    text: 'Healthy'
  });
  assert.deepEqual(getTelegramRowHealthStatus(row(), connection({ maskedBotToken: null })), {
    tone: 'red',
    text: 'Unhealthy'
  });
  assert.deepEqual(getTelegramRowHealthStatus(row({ lastIssue: 'Bot cannot send messages' }), connection()), {
    tone: 'red',
    text: 'Unhealthy'
  });
});

test('telegram active thread toggle disables correctly for missing project and loading state', () => {
  assert.deepEqual(
    getActiveThreadsButtonModel({
      projectId: '',
      threadsLoading: false,
      activeThreadsExpanded: false,
      rowActionInProgress: false
    }),
    { text: 'Project not chosen', disabled: true, showChevron: false }
  );
  assert.deepEqual(
    getActiveThreadsButtonModel({
      projectId: 'APs',
      threadsLoading: true,
      activeThreadsExpanded: false,
      rowActionInProgress: false
    }),
    { text: 'Loading Active Threads...', disabled: true, showChevron: false }
  );
  assert.deepEqual(
    getActiveThreadsButtonModel({
      projectId: 'APs',
      threadsLoading: false,
      activeThreadsExpanded: false,
      rowActionInProgress: false
    }),
    { text: 'Show Active threads', disabled: false, showChevron: true }
  );
  assert.deepEqual(
    getActiveThreadsButtonModel({
      projectId: 'APs',
      threadsLoading: false,
      activeThreadsExpanded: true,
      rowActionInProgress: true
    }),
    { text: 'Hide Active threads', disabled: true, showChevron: true }
  );
});

test('telegram locked row is defined by saved row id plus completed setup timestamp', () => {
  assert.equal(isTelegramRowLocked(row()), true);
  assert.equal(isTelegramRowLocked(row({ rowId: undefined })), false);
  assert.equal(isTelegramRowLocked(row({ setupCompletedAt: null })), false);
});
