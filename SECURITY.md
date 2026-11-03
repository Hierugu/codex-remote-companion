# Security

## Security Model

Codex Remote Companion is a local desktop bridge. It gives a Telegram bot the ability to send prompts into local Codex threads on the user's machine.

Treat a connected Telegram group as a control surface for Codex.

## Sensitive Data

Sensitive local data includes:

- Telegram bot token.
- `~/.codex-remote-companion/telegram-config.json`.
- `~/.codex-remote-companion/backend-registry.json`.
- `~/.codex/auth.json`.
- Codex session JSONL files under `~/.codex/sessions/`.
- Codex archived session JSONL files under `~/.codex/archived_sessions/`.

Do not commit or share those files.

## Telegram Token Storage

The Telegram token is stored locally in:

```text
~/.codex-remote-companion/telegram-config.json
```

The companion writes the config file with owner-only permissions (0600).

The UI shows only a masked token, but the local JSON file contains the usable token. Protect the user's machine account and disk.

If a token is exposed:

1. Revoke it in BotFather.
2. Create a new token.
3. Replace it in the app.
4. Restart the local server if needed.

## Group Access

Configure your positive numeric Telegram user ID with the bot token. The bridge ignores messages from other users, including other members of a bound topic. If no owner ID is configured, it accepts no incoming prompts.

Only invite trusted people to a connected Telegram group or topic. The bot can read messages there, and Telegram group administrators can manage membership. Codex's filesystem and tool permissions still apply to accepted prompts.

## Permissions

The companion does not force Full Access or change Codex sandbox settings.

Model, reasoning, permissions, and approvals must be configured by the user in Codex App / Codex CLI.

## Network

The app talks to:

- Telegram Bot API over HTTPS.
- Local Codex CLI app-server over stdio.
- Local HTTP health endpoint on `127.0.0.1`.

The local runtime defaults to `127.0.0.1:4317`. It should not be exposed to the public internet.

## Reporting Issues

For private security issues, do not post tokens, session files, screenshots with secrets, or `~/.codex` contents in public channels.

Share only:

- App version or commit.
- Redacted logs.
- Redacted error messages.
- Steps to reproduce.
