# Configuration

Codex Remote Companion is configured through the app UI and local JSON files. It does not require `.env` files for normal desktop use.

## Companion State

Main local state directory:

```text
~/.codex-remote-companion/
```

For the clean public release build on the release machine:

```text
~/.codex-remote-companion-public/
```

The public release build intentionally does not migrate legacy `~/.codex-companion/` state, so Alex's personal Telegram token and APs binding do not appear in public artifacts during local release testing.

Important files:

```text
~/.codex-remote-companion/telegram-config.json
~/.codex-remote-companion/backend-registry.json
```

`telegram-config.json` stores:

- Telegram bot token.
- Telegram bot identity.
- Configured Telegram project rows.
- Last Telegram update ID.
- Last sync summary.
- Last connection issue.

`backend-registry.json` stores:

- Local install identity.
- Local machine record.
- Companion project records.
- Project thread records.
- Telegram surface bindings.
- Codex thread bindings.
- Active thread states.
- Sync snapshots.

The app can migrate legacy state from:

```text
~/.codex-companion/
```

## Codex State Read By The App

The app reads local Codex state from:

```text
~/.codex/
```

Read paths include:

```text
~/.codex/config.toml
~/.codex/auth.json
~/.codex/.codex-global-state.json
~/.codex/session_index.jsonl
~/.codex/sessions/
~/.codex/archived_sessions/
```

These files are used to detect projects, threads, user email, selected model/reasoning for read-only status, permissions signal, rate limits, and thread messages.

## Telegram Requirements

The Telegram group must be a supergroup with forum topics enabled.

The bot must be an administrator with enough permissions to:

- Read messages sent in the forum topics.
- Create forum topics.
- Rename forum topics.
- Close and reopen forum topics.
- Send messages.
- Edit its own progress messages.

The app uses Telegram Bot API `getUpdates`, so the bot should not be simultaneously managed by another poller using the same token.

## Codex Requirements

The app starts Codex through:

```bash
codex app-server --listen stdio://
```

The `codex` command must be available on `PATH` for real Telegram-to-Codex message execution.

Codex App settings are not modified. The active model, reasoning, and permissions are controlled by the user's Codex App / Codex CLI state.

## Files Ignored By Git

The repository ignores:

```text
node_modules
out
dist
.DS_Store
agents/
archive.zip
```

Do not commit local Telegram tokens or user-specific Codex state.
