# Changelog

## Unreleased

### Added

- Local Electron companion app.
- macOS alpha packaging through `electron-builder`.
- `.dmg` and `.zip` release artifact targets.
- Separate public and Alex personal macOS release artifacts.
- Public release state directory isolated from Alex's local Telegram token and APs binding.
- Placeholder app icon for packaged builds.
- Codex App and Codex CLI detection.
- Local runtime server with `/health`.
- Telegram bot token setup.
- Telegram forum group project bindings.
- Telegram topic creation and repair flow.
- Local Codex project and thread discovery from `~/.codex`.
- Telegram inbound polling.
- Telegram-to-Codex thread execution through `codex app-server`.
- Progress message editing while Codex runs.
- Final assistant reply forwarding back to Telegram.
- Read-only Telegram slash commands for status, model list, reasoning list, permissions, limits, and latest local thread message.
- MIT license and project handoff documentation.

### Changed

- Dashboard now focuses on Codex status, server status, and Telegram messaging.
- Messaging channels now expose Telegram only.
- Messaging settings now expose Telegram only.
- Remote messages use the user's current Codex App / Codex CLI settings instead of companion-side overrides.
- Telegram polling interval increased from 500ms to 3000ms to reduce idle overhead.

### Removed

- Companion-side model selector.
- Companion-side reasoning selector.
- Companion-side permissions selector.
- Dashboard read-only settings block.
- Discord and WhatsApp visible UI surfaces.
- Remote setting mutation commands.
- Old debug/probe live-settings files from the production source path.

### Known Limitations

- No production-safe live sync for Codex App footer settings.
- No signed installer or auto-update flow.
- No long-duration production soak test yet.
- Telegram token is stored locally in JSON and must be protected by the user's machine security.
