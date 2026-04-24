# Limitations

## No Remote Settings Control

Codex Remote Companion intentionally does not change:

- Model.
- Reasoning effort.
- Permissions.
- Personality.
- Codex App footer state.

Those values must be changed directly in Codex App by the user.

Reason: local config/DB writes can become stale versus the live renderer state, and DevTools/debug/UI automation approaches are not production-safe for user machines.

## Telegram Only

The current product surface only exposes Telegram.

Discord and WhatsApp UI surfaces are hidden and not considered production-ready.

## No Signed Installer Yet

The project can be run from source and packaged locally with `npm run dist:mac`.

There is no Apple Developer signing, notarization, auto-update pipeline, or polished installer flow yet.

## Local-First Only

The app assumes it runs on the same machine as Codex App / Codex CLI and reads local Codex files from `~/.codex`.

It is not a hosted service and should not be deployed as a shared remote server for multiple users.

## Telegram Polling Constraints

The app uses Telegram Bot API polling through `getUpdates`.

Only one active poller should use the same bot token. If another process consumes updates for the same token, messages may be skipped or delayed.

## Thread Binding Assumptions

Telegram topics are mapped to local Codex project threads.

If Codex local files are moved, deleted, archived unexpectedly, or belong to a different local machine, bindings can become stale and may require repair or re-setup.

## Long-Running Stability

The project has unit and integration-style tests, but it has not yet been fully proven with long soak/load sessions on end-user machines.

For a cautious release, run at least:

```bash
npm run typecheck
npm run test:phase6
npm run test:ui
```

Then run a real manual Telegram session before sharing with non-technical users.
