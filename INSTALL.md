# Install And Run

## Prerequisites

- macOS.
- Node.js and npm.
- Codex App installed in `/Applications/Codex.app` or `~/Applications/Codex.app`.
- `codex` CLI installed and available on `PATH`.
- Codex CLI authenticated and able to run `codex app-server --listen stdio://`.
- Telegram bot token.
- Your positive numeric Telegram user ID, entered with the bot token. Messages from other accounts are ignored.
- Telegram forum group where the bot is an admin with topic-management permissions.

## Install Dependencies

```bash
npm install
```

## Development Run

```bash
npm run dev
```

This starts Electron through `electron-vite dev`.

If port `5173` is blocked or already used, stop the existing dev server and retry.

## Build

```bash
npm run build
```

The build output is written to `out/`.

## Package For macOS

Clean public release:

```bash
npm run dist:mac:release
```

Alex personal build:

```bash
npm run dist:mac:personal
```

Both commands run `electron-vite build` and then `electron-builder --mac dmg zip`.

Public release artifacts are written to:

```text
release/public/
```

Expected alpha artifacts:

```text
Codex-Remote-Companion-0.1.0-arm64.dmg
Codex-Remote-Companion-0.1.0-arm64.zip
```

Alex personal artifacts are written to:

```text
release/alex/
```

Expected personal artifacts:

```text
Codex-Remote-Companion-Alex-0.1.0-arm64.dmg
Codex-Remote-Companion-Alex-0.1.0-arm64.zip
```

The exact architecture suffix depends on the machine that builds the release.

The app is currently unsigned and not notarized. macOS Gatekeeper may warn on first launch. For alpha testers, this is acceptable; for a public consumer release, add Apple Developer signing and notarization.

## Release State Separation

The Alex personal build uses:

```text
~/.codex-remote-companion/
```

The clean public release build uses:

```text
~/.codex-remote-companion-public/
```

This prevents the public app from showing Alex's local `Active Token` or APs binding on the release machine.

## Future Homebrew Cask

After publishing a GitHub release with the `.dmg`, a Homebrew cask can install it with a command like:

```bash
brew install --cask Wake0ne/tap/codex-remote-companion
```

Example cask:

```ruby
cask "codex-remote-companion" do
  version "0.1.0"
  sha256 "859bceb994214f24ae2cdc75e2d6d613b3177fcf05793b467653c79cbe80613f"

  url "https://github.com/Wake0ne/codex-remote-companion/releases/download/v#{version}/Codex-Remote-Companion-#{version}-arm64.dmg"
  name "Codex Remote Companion"
  desc "Local-first Telegram bridge into Codex App threads"
  homepage "https://github.com/Wake0ne/codex-remote-companion"

  app "Codex Remote Companion.app"
end
```

Create the GitHub release and upload the public `.dmg` before using the cask.

## Verification

```bash
npm run typecheck
npm run test:phase6
npm run test:ui
```

`test:phase6` covers the main backend path including runtime, store, control plane, product API, Telegram service, and Telegram polling logic.

## First App Setup

1. Launch the app.
2. Confirm Codex detection in `Codex status`.
3. Click `Start server`.
4. Open `Messaging settings`.
5. Save the Telegram bot token.
6. Add a project binding.
7. Enter the Telegram forum group chat ID.
8. Select a local Codex project.
9. Click `Set up Telegram environment`.
10. Use the created Telegram topics to send prompts into Codex threads.

## Runtime Behavior

- The local HTTP runtime listens on `127.0.0.1:4317` by default.
- If `4317` is already in use, the app falls back to a random free local port.
- Telegram polling starts when the local server starts.
- Telegram polling currently runs every 3 seconds to reduce idle CPU/network usage.
- Telegram polling stops when the local server stops or the app quits.
- Codex execution uses a cached `codex app-server` child process and resets it after execution errors.
