# Troubleshooting

## Codex Is Not Detected

Check that Codex App is installed in one of these locations:

```text
/Applications/Codex.app
~/Applications/Codex.app
```

Check that the CLI is available:

```bash
which codex
codex --version
```

Real Telegram-to-Codex execution requires `codex app-server --listen stdio://` to work.

## No Codex Projects Found

Open Codex App with the target project at least once.

The companion reads projects from local Codex state:

```text
~/.codex/.codex-global-state.json
~/.codex/session_index.jsonl
~/.codex/sessions/
```

If the project never appeared in Codex, it may not be visible to the companion.

## Telegram Token Is Invalid

Confirm the token in BotFather.

Then paste it again in `Messaging settings` and click `Save token`.

If the token was leaked, revoke it and create a new one.

## Telegram Group Setup Fails

Check that:

- The group is a supergroup.
- Forum topics are enabled.
- The bot is added to the group.
- The bot is an administrator.
- The bot can manage topics.
- The chat ID is correct and usually starts with `-100`.

## Messages Do Not Arrive From Telegram

Check that:

- The local server is started.
- The Telegram binding status is `Active`.
- The message is sent inside a bound topic.
- The sender is not the bot itself.
- No other process is consuming `getUpdates` for the same bot token.

The poller processes up to 20 updates per cycle and stores `lastUpdateId` in:

```text
~/.codex-remote-companion/telegram-config.json
```

## Telegram Gets Progress But No Final Reply

Codex may still be running, waiting for tool approval, or stuck behind a local error.

Check:

- Codex App / Codex CLI is authenticated.
- The selected Codex thread still exists locally.
- The user has approved any required Codex permission prompt.
- The local machine has enough model quota.

The executor waits for Codex completion and then waits for the assistant message to be persisted in the local thread file.

## Port 4317 Is Busy

The app falls back to a random local port if `127.0.0.1:4317` is already in use.

The current port is shown in the app server status area.

## Model Or Reasoning Did Not Change

This is expected.

The companion does not change model, reasoning, permissions, or personality. Change those directly in Codex App.

Use read-only Telegram commands to inspect what the app can currently detect:

```text
/status
/model
/reasoning
/permissions
/limits
```

## Reset Local Companion State

Stop the app first.

Then move or delete:

```text
~/.codex-remote-companion/
```

This removes saved Telegram token and bindings. It does not delete Codex threads or Telegram topics.
