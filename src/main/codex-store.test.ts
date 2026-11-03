import assert from 'node:assert/strict';
import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexLocalStore } from './codex-store';

async function createFixtureCodexHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase2-'));
  await mkdir(join(root, 'sessions', '2026', '04', '19'), { recursive: true });
  await mkdir(join(root, 'archived_sessions', '2026', '04', '18'), { recursive: true });

  await writeFile(
    join(root, 'config.toml'),
    [
      'model = "gpt-5.4"',
      'model_reasoning_effort = "xhigh"',
      'personality = "pragmatic"'
    ].join('\n')
  );

  await writeFile(
    join(root, '.codex-global-state.json'),
    JSON.stringify({
      'electron-saved-workspace-roots': ['/workspace/a', '/workspace/b'],
      'active-workspace-roots': ['/workspace/a'],
      'project-order': [
        '/workspace/a',
        '/workspace/b',
        '/var/folders/tmp/worktrees/pre-pm-review.ABC12',
        '/tmp/repo'
      ],
      'prompt-history': ['must-not-be-used']
    })
  );

  await writeFile(
    join(root, 'auth.json'),
    JSON.stringify({
      tokens: {
        id_token: [
          'header',
          Buffer.from(
            JSON.stringify({
              email: 'user@example.com'
            }),
            'utf8'
          ).toString('base64url'),
          'signature'
        ].join('.')
      }
    })
  );

  await writeFile(
    join(root, 'session_index.jsonl'),
    [
      JSON.stringify({
        id: 'thr_live',
        thread_name: 'Live thread',
        updated_at: '2026-04-19T12:00:00.000Z'
      }),
      JSON.stringify({
        id: 'thr_archived',
        thread_name: 'Archived thread',
        updated_at: '2026-04-18T12:00:00.000Z'
      })
    ].join('\n')
  );

  await writeFile(
    join(root, 'sessions', '2026', '04', '19', 'rollout-live.jsonl'),
    [
      JSON.stringify({
        timestamp: '2026-04-19T11:59:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'thr_live',
          timestamp: '2026-04-19T11:59:00.000Z',
          cwd: '/workspace/a',
          originator: 'Codex Desktop',
          cli_version: '0.123.0'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-19T11:59:00.500Z',
        type: 'turn_context',
        payload: {
          approval_policy: 'on-request',
          sandbox_policy: {
            type: 'workspace-write',
            writable_roots: ['/workspace/a'],
            network_access: false
          }
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-19T11:59:00.750Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: {
              used_percent: 11,
              window_minutes: 300,
              resets_at: 1776523729
            },
            secondary: {
              used_percent: 23,
              window_minutes: 10080,
              resets_at: 1777055659
            }
          }
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-19T11:59:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'Hello from user'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-19T11:59:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello from assistant' }]
        }
      })
    ].join('\n')
  );

  await writeFile(
    join(root, 'archived_sessions', '2026', '04', '18', 'rollout-archived.jsonl'),
    [
      JSON.stringify({
        timestamp: '2026-04-18T11:59:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'thr_archived',
          timestamp: '2026-04-18T11:59:00.000Z',
          cwd: '/workspace/b',
          originator: 'Codex Desktop',
          cli_version: '0.123.0'
        }
      })
    ].join('\n')
  );

  return root;
}

test('CodexLocalStore reads environment snapshot from researched local files', async () => {
  const codexHome = await createFixtureCodexHome();
  const store = new CodexLocalStore(codexHome);

  const snapshot = await store.getEnvironmentSnapshot();

  assert.equal(snapshot.model, 'gpt-5.4');
  assert.equal(snapshot.reasoningEffort, 'xhigh');
  assert.equal(snapshot.personality, 'pragmatic');
  assert.equal(snapshot.activeUserEmail, 'user@example.com');
  assert.equal(snapshot.permissionMode, 'Default permissions');
  assert.equal(snapshot.primaryRateLimitRemainingPercent, 89);
  assert.equal(snapshot.primaryRateLimitWindowMinutes, 300);
  assert.equal(snapshot.primaryRateLimitResetsAt, '2026-04-18T14:48:49.000Z');
  assert.equal(snapshot.weeklyRateLimitRemainingPercent, 77);
  assert.equal(snapshot.weeklyRateLimitWindowMinutes, 10080);
  assert.equal(snapshot.weeklyRateLimitResetsAt, '2026-04-24T18:34:19.000Z');
  assert.deepEqual(snapshot.savedWorkspaceRoots, ['/workspace/a', '/workspace/b']);
  assert.deepEqual(snapshot.activeWorkspaceRoots, ['/workspace/a']);
  assert.equal(snapshot.threadCount, 1);
  assert.equal(snapshot.archivedThreadCount, 1);
});

test('CodexLocalStore prefers freshest token_count from recent rollout activity for rate limits', async () => {
  const codexHome = await createFixtureCodexHome();
  await mkdir(join(codexHome, 'sessions', '2026', '04', '20'), { recursive: true });
  await writeFile(
    join(codexHome, 'sessions', '2026', '04', '20', 'rollout-rate-limit-live.jsonl'),
    [
      JSON.stringify({
        timestamp: '2026-04-20T12:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'thr_live_rate_limit',
          timestamp: '2026-04-20T12:00:00.000Z',
          cwd: '/workspace/z',
          originator: 'Codex Desktop',
          cli_version: '0.123.0'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-20T12:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: {
              used_percent: 8.2,
              window_minutes: 300,
              resets_at: 1776528000
            },
            secondary: {
              used_percent: 24.4,
              window_minutes: 10080,
              resets_at: 1777059200
            }
          }
        }
      })
    ].join('\n')
  );

  const store = new CodexLocalStore(codexHome);
  const snapshot = await store.getEnvironmentSnapshot();

  assert.equal(snapshot.permissionMode, 'Default permissions');
  assert.equal(snapshot.primaryRateLimitRemainingPercent, 91.8);
  assert.equal(snapshot.primaryRateLimitWindowMinutes, 300);
  assert.equal(snapshot.primaryRateLimitResetsAt, '2026-04-18T16:00:00.000Z');
  assert.equal(snapshot.weeklyRateLimitRemainingPercent, 75.6);
  assert.equal(snapshot.weeklyRateLimitWindowMinutes, 10080);
  assert.equal(snapshot.weeklyRateLimitResetsAt, '2026-04-24T19:33:20.000Z');
});

test('CodexLocalStore prefers latest token_count timestamp instead of newest file mtime', async () => {
  const codexHome = await createFixtureCodexHome();
  await mkdir(join(codexHome, 'sessions', '2026', '04', '20'), { recursive: true });
  const stalePath = join(codexHome, 'sessions', '2026', '04', '20', 'rollout-stale.jsonl');
  const freshPath = join(codexHome, 'sessions', '2026', '04', '20', 'rollout-fresh.jsonl');

  await writeFile(
    stalePath,
    [
      JSON.stringify({
        timestamp: '2026-04-20T12:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'thr_stale',
          timestamp: '2026-04-20T12:00:00.000Z',
          cwd: '/workspace/stale',
          originator: 'Codex Desktop',
          cli_version: '0.123.0'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-20T12:00:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: {
              used_percent: 7,
              window_minutes: 300,
              resets_at: 1776527709
            },
            secondary: {
              used_percent: 24,
              window_minutes: 10080,
              resets_at: 1777055659
            }
          }
        }
      })
    ].join('\n')
  );

  await writeFile(
    freshPath,
    [
      JSON.stringify({
        timestamp: '2026-04-20T12:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'thr_fresh',
          timestamp: '2026-04-20T12:00:00.000Z',
          cwd: '/workspace/fresh',
          originator: 'Codex Desktop',
          cli_version: '0.123.0'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-20T12:05:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: {
              used_percent: 14,
              window_minutes: 300,
              resets_at: 1776527709
            },
            secondary: {
              used_percent: 25,
              window_minutes: 10080,
              resets_at: 1777055659
            }
          }
        }
      })
    ].join('\n')
  );

  const later = new Date('2026-04-20T12:10:00.000Z');
  await utimes(stalePath, later, later);

  const store = new CodexLocalStore(codexHome);
  const snapshot = await store.getEnvironmentSnapshot();

  assert.equal(snapshot.primaryRateLimitRemainingPercent, 86);
  assert.equal(snapshot.weeklyRateLimitRemainingPercent, 75);
});

test('CodexLocalStore lists live and archived threads from session index plus rollout metadata', async () => {
  const codexHome = await createFixtureCodexHome();
  const store = new CodexLocalStore(codexHome);

  const threads = await store.listThreads(10);

  assert.equal(threads.length, 2);
  assert.equal(threads[0]?.id, 'thr_live');
  assert.equal(threads[0]?.cwd, '/workspace/a');
  assert.equal(threads[1]?.archived, true);
});

test('CodexLocalStore lists project options and project threads from local Codex cwd state', async () => {
  const codexHome = await createFixtureCodexHome();
  const store = new CodexLocalStore(codexHome);

  const projects = await store.listProjectOptions();
  const workspaceA = projects.find((project) => project.cwd === '/workspace/a');
  const workspaceB = projects.find((project) => project.cwd === '/workspace/b');

  assert.ok(workspaceA);
  assert.equal(workspaceA.name, 'a');
  assert.equal(workspaceA.activeThreadCount, 1);
  assert.ok(workspaceB);
  assert.equal(workspaceB.archivedThreadCount, 1);
  assert.equal(projects.some((project) => project.name.startsWith('pre-pm-review.')), false);
  assert.equal(projects.some((project) => project.name === 'repo'), false);

  const threads = await store.listProjectThreadOptions(workspaceA.id);
  assert.equal(threads.length, 1);
  assert.equal(threads[0]?.title, 'Live thread');
});

test('CodexLocalStore lists current local projects and existing chat workspaces', async () => {
  const codexHome = await createFixtureCodexHome();
  await writeFile(
    join(codexHome, '.codex-global-state.json'),
    JSON.stringify({
      'local-projects': {
        project_c: { id: 'project_c', name: 'Project C', rootPaths: ['/workspace/c'] }
      }
    })
  );

  const store = new CodexLocalStore(codexHome);
  const projects = await store.listProjectOptions();

  assert.deepEqual(
    projects.map((project) => project.cwd),
    ['/workspace/c', '/workspace/a', '/workspace/b']
  );
  assert.equal(projects.find((project) => project.cwd === '/workspace/a')?.threadCount, 1);
  assert.equal(projects.find((project) => project.cwd === '/workspace/c')?.threadCount, 0);
});

test('CodexLocalStore reads persisted thread messages from rollout jsonl', async () => {
  const codexHome = await createFixtureCodexHome();
  const store = new CodexLocalStore(codexHome);

  const thread = await store.readThread('thr_live');

  assert.equal(thread.title, 'Live thread');
  assert.equal(thread.cwd, '/workspace/a');
  assert.equal(thread.messages.length, 2);
  assert.equal(thread.messages[0]?.role, 'user');
  assert.equal(thread.messages[1]?.role, 'assistant');
  assert.match(thread.messages[1]?.text ?? '', /assistant/);
});

test('CodexLocalStore marks harness-generated user items separately from user text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-remote-companion-harness-'));
  const sessionDir = join(root, 'sessions', '2026', '04', '19');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(root, 'session_index.jsonl'), '');
  await writeFile(join(sessionDir, 'rollout-harness.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'thr_harness', cwd: '/workspace/a' } }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>' }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ['additional_content.codex_apps_open_page'],
          content_item_metadata: [{ provenance: { type: 'harness', hook: false } }]
        }
      }
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'Actual user prompt' }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ['user.text'],
          content_item_metadata: [{ provenance: { type: 'user' } }]
        }
      }
    })
  ].join('\n'));

  const thread = await new CodexLocalStore(root).readThread('thr_harness');
  assert.equal(thread.title, 'Actual user prompt');
  assert.equal(thread.messages[0]?.isHarnessGenerated, true);
  assert.equal(thread.messages[1]?.isHarnessGenerated, false);
});

test('CodexLocalStore skips environment context wrappers when deriving thread title', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase2-'));
  await mkdir(join(root, 'sessions', '2026', '04', '19'), { recursive: true });
  await writeFile(join(root, 'config.toml'), 'model = "gpt-5.4"');
  await writeFile(join(root, '.codex-global-state.json'), JSON.stringify({}));
  await writeFile(
    join(root, 'session_index.jsonl'),
    JSON.stringify({
      id: 'thr_env',
      thread_name: '',
      updated_at: '2026-04-19T12:00:00.000Z'
    })
  );
  await writeFile(
    join(root, 'sessions', '2026', '04', '19', 'rollout-env.jsonl'),
    [
      JSON.stringify({
        timestamp: '2026-04-19T11:59:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'thr_env',
          timestamp: '2026-04-19T11:59:00.000Z',
          cwd: '/workspace/a',
          originator: 'Codex Desktop',
          cli_version: '0.123.0'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-19T11:59:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '<environment_context>\n  <cwd>/workspace/a</cwd>\n</environment_context>'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-19T11:59:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'Real first message'
        }
      })
    ].join('\n')
  );

  const store = new CodexLocalStore(root);
  const thread = await store.readThread('thr_env');

  assert.equal(thread.title, 'Real first message');
});

test('CodexLocalStore ignores UUID-like thread names when deriving project thread titles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase2-'));
  await mkdir(join(root, 'sessions', '2026', '04', '19'), { recursive: true });
  await writeFile(join(root, 'config.toml'), 'model = "gpt-5.4"');
  await writeFile(
    join(root, '.codex-global-state.json'),
    JSON.stringify({
      'project-order': ['/workspace/a']
    })
  );
  await writeFile(
    join(root, 'session_index.jsonl'),
    JSON.stringify({
      id: '019da0fc-fe06-7333-8e04-0cb5f872331b',
      thread_name: '019da0fc-fe06-7333-8e04-0cb5f872331b',
      updated_at: '2026-04-19T12:00:00.000Z'
    })
  );
  await writeFile(
    join(root, 'sessions', '2026', '04', '19', 'rollout-uuid-title.jsonl'),
    [
      JSON.stringify({
        timestamp: '2026-04-19T11:59:00.000Z',
        type: 'session_meta',
        payload: {
          id: '019da0fc-fe06-7333-8e04-0cb5f872331b',
          timestamp: '2026-04-19T11:59:00.000Z',
          cwd: '/workspace/a',
          originator: 'Codex Desktop',
          cli_version: '0.123.0'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-19T11:59:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message:
            '# AGENTS.md instructions for /workspace/a\n\n<INSTRUCTIONS>\nBoilerplate launcher'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-19T11:59:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'Human thread title'
        }
      })
    ].join('\n')
  );

  const store = new CodexLocalStore(root);
  const [project] = await store.listProjectOptions();
  const threads = await store.listProjectThreadOptions(project.id);

  assert.equal(threads[0]?.title, 'Human thread title');
});

test('CodexLocalStore hides review-only internal sessions from project thread surfaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-remote-companion-phase2-'));
  await mkdir(join(root, 'sessions', '2026', '04', '19'), { recursive: true });
  await writeFile(join(root, 'config.toml'), 'model = "gpt-5.4"');
  await writeFile(
    join(root, '.codex-global-state.json'),
    JSON.stringify({
      'project-order': ['/workspace/a']
    })
  );
  await writeFile(
    join(root, 'session_index.jsonl'),
    JSON.stringify({
      id: 'thr_visible',
      thread_name: 'Visible thread',
      updated_at: '2026-04-19T12:01:00.000Z'
    })
  );
  await writeFile(
    join(root, 'sessions', '2026', '04', '19', 'rollout-visible.jsonl'),
    [
      JSON.stringify({
        timestamp: '2026-04-19T12:01:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'thr_visible',
          timestamp: '2026-04-19T12:01:00.000Z',
          cwd: '/workspace/a',
          originator: 'Codex Desktop',
          cli_version: '0.123.0',
          source: 'vscode',
          base_instructions: { text: 'You are Codex, a coding agent.' }
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-19T12:01:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message:
            '<permissions instructions>\n# AGENTS.md instructions for /workspace/a\nHuman visible thread title'
        }
      })
    ].join('\n')
  );
  await writeFile(
    join(root, 'sessions', '2026', '04', '19', 'rollout-review.jsonl'),
    [
      JSON.stringify({
        timestamp: '2026-04-19T12:02:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'thr_review',
          timestamp: '2026-04-19T12:02:00.000Z',
          cwd: '/workspace/a',
          originator: 'Codex Desktop',
          cli_version: '0.123.0',
          source: { subagent: 'review' },
          base_instructions: {
            text: '# Review guidelines:\n\nYou are acting as a reviewer for a proposed code change.'
          }
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-19T12:02:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'Review the current code changes and provide prioritized findings.'
        }
      })
    ].join('\n')
  );
  await writeFile(
    join(root, 'sessions', '2026', '04', '19', 'rollout-orphan-exec.jsonl'),
    [
      JSON.stringify({
        timestamp: '2026-04-19T12:03:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'thr_orphan_exec',
          timestamp: '2026-04-19T12:03:00.000Z',
          cwd: '/workspace/a',
          originator: 'Codex Desktop',
          cli_version: '0.123.0',
          source: 'exec',
          base_instructions: { text: 'You are Codex, a coding agent.' }
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-19T12:03:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'Reply exactly: hidden-smoke-probe'
        }
      })
    ].join('\n')
  );

  const store = new CodexLocalStore(root);
  const [project] = await store.listProjectOptions();
  const threads = await store.listProjectThreadOptions(project.id);

  assert.equal(project.activeThreadCount, 1);
  assert.equal(threads.length, 1);
  assert.equal(threads[0]?.id, 'thr_visible');
});
