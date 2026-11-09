# Codex Remote Companion

Control your local Codex App threads from Telegram while Codex continues running on your Mac.

Codex Remote Companion is an alpha local-first messenger bridge. It runs on the user's machine, reads local Codex project/thread metadata, creates Telegram topic bindings, and forwards Telegram messages into the selected local Codex thread through `codex app-server`.

## What It Does

- Detects local Codex App and Codex CLI availability.
- Reads local Codex projects and threads from `~/.codex`.
- Connects Telegram forum groups to local Codex projects.
- Creates or repairs Telegram forum topics for project threads.
- Automatically creates topics for new chats and forks in configured projects while the local server runs (one topic per scan, with a pause after Telegram rate limits).
- Updates an existing Telegram topic when its linked Codex chat is renamed.
- Supports `/new <name>` in General (choose a connected project with a button) or in a chat topic (use that chat's project), and `/fork <name>` inside a chat topic. New chats receive their own topics through the durable topic queue.
- Supports `/release` in a connected Telegram group or topic. After owner confirmation, Companion asks macOS to quit VS Code, Codex app, or both normally, then reports whether they exited. It never force-quits apps or discards unsaved work.
- Receives Telegram messages from bound topics.
- Sends those messages into the matching Codex thread.
- Sends progress updates and the final assistant reply back to Telegram.
- Supports read-only slash commands for status, model catalog, reasoning modes, permissions, limits, and latest local thread message.

## What It Does Not Do

- It does not change Codex App model, reasoning, permissions, or personality.
- It does not patch Codex App.
- It does not require Codex App DevTools/debug mode.
- It does not automate the user's desktop with Accessibility or UI clicking.
- It does not currently provide Discord or WhatsApp channels.

Remote prompts use the model, reasoning, permissions, and sandbox settings that are already selected by the user in Codex App / Codex CLI.

## Requirements

- macOS.
- Node.js with npm.
- Installed Codex App.
- Installed `codex` CLI available on `PATH`.
- A Telegram bot token from BotFather.
- A Telegram supergroup with forum topics enabled.
- The bot must be an administrator in the Telegram group and able to manage topics.

## Alpha Release Status

This is an alpha desktop release.

Supported:

- Source install for technical users.
- Local macOS production packaging with separate public and personal `.dmg` / `.zip` artifacts.
- Telegram-only bridge into local Codex threads.

Not yet supported:

- Apple notarization.
- Signed installer.
- Auto-update.
- Consumer-grade onboarding.
- Remote control of Codex App model/reasoning/permissions.

## Quick Start

```bash
npm install
npm run dev
```

In the app:

1. Confirm Codex App / Codex CLI are detected.
2. Click `Start server`.
3. Open `Messaging settings`.
4. Paste and save the Telegram bot token.
5. Add a Telegram project binding.
6. Enter the Telegram group chat ID, for example `-1003739703024`.
7. Select a local Codex project.
8. Click `Set up Telegram environment`.
9. Send messages inside the created Telegram topic.

## Common Commands

```bash
npm run dev
npm run build
npm run dist:mac:release
npm run dist:mac:personal
npm run typecheck
npm run test:phase6
npm run test:ui
```

`npm run dist:mac:release` creates the clean public artifacts under:

```text
release/public/
```

Expected public alpha artifacts:

```text
Codex-Remote-Companion-0.1.0-arm64.dmg
Codex-Remote-Companion-0.1.0-arm64.zip
```

`npm run dist:mac:personal` creates Alex's personal artifacts under:

```text
release/alex/
```

Expected personal artifacts:

```text
Codex-Remote-Companion-Alex-0.1.0-arm64.dmg
Codex-Remote-Companion-Alex-0.1.0-arm64.zip
```

The exact architecture suffix depends on the machine that builds the release.

For a real Telegram API smoke test:

```bash
npm run smoke:phase6-telegram
```

The live smoke requires a real Telegram bot token and real local Codex state.

## Telegram Slash Commands

- `/help` shows available commands.
- `/status` shows current detected model, reasoning, and permissions.
- `/model` lists available models.
- `/reasoning` lists available reasoning modes.
- `/permissions` lists available permission modes.
- `/limits` shows detected rate-limit remaining values.
- `/threadsync` sends the latest local user/assistant message from the bound Codex thread.

Change attempts such as `/model gpt-5.4` are intentionally rejected. Settings must be changed directly in Codex App.

## Local Data

Companion state is stored locally under:

```text
~/.codex-remote-companion/
```

The clean public release build uses:

```text
~/.codex-remote-companion-public/
```

This prevents Alex's local Telegram token and APs binding from appearing in the public build on the release machine.

Codex state is read from:

```text
~/.codex/
```

Do not commit local state files, bot tokens, `agents/`, or `archive.zip`.

## More Docs

- [INSTALL.md](INSTALL.md)
- [CONFIG.md](CONFIG.md)
- [LIMITATIONS.md](LIMITATIONS.md)
- [SECURITY.md](SECURITY.md)
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- [CHANGELOG.md](CHANGELOG.md)
