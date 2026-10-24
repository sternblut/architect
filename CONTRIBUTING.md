# Contributing

Architect runs on macOS with Bun 1.2 or newer. Setup is in the [README](README.md#quick-start).

## Checks

Run what CI runs, and the type check, before you open a pull request:

```sh
bun install
for f in test/*.test.ts; do bun test "$f" || exit 1; done   # each file in its own process, no network
bun run check                                              # TypeScript, no emit
```

Live checks with real Claude Code sessions, a local Worker and a mock Telegram are in `test/e2e-*.ts`; run them by hand.

## Pull requests

- Open pull requests against `build`.
- One change per pull request. Say what changes for the person on the phone or at the Mac, and how you checked it.
- Your own settings (folders, sites, repos) live in `config.local.json`, which git ignores; keep tokens out of commits.

## Where things are

- `src/telegram.ts`: the bot, messages and buttons.
- `src/architect.ts`, `src/prompt.ts`: the architect session and its instructions.
- `src/anyhook.ts`, `src/hook.ts`, `src/hookserver.ts`: hooks of Claude Code sessions and the local server that receives them.
- `src/policy.ts`: the policy gate for irreversible actions.
- `src/status.ts`, `src/morning.ts`: the dashboard and the 8:00 summary.
- `bin/arch`: the `archi` command. `bin/install.sh`: the one-line installer.
- `relay/`: the optional cloud relay for when the Mac sleeps.

Security issues go to [SECURITY.md](SECURITY.md), not to public issues.
