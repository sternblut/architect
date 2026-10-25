<div align="center">

# Architect

**Run Claude Code on your Mac from Telegram.**

An AI architect starts and watches your Claude Code sessions, brings their questions to your phone as buttons, and waits for your tap before deploys and deletions.

[![tests](https://github.com/sternblut/architect/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/sternblut/architect/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-555?labelColor=333)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-only-555?labelColor=333&logo=apple&logoColor=white)](#quick-start)
[![Bun](https://img.shields.io/badge/Bun-1.2%2B-555?labelColor=333&logo=bun&logoColor=white)](https://bun.sh)
[![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-0.3-555?labelColor=333&logo=claude&logoColor=white)](https://github.com/anthropics/claude-agent-sdk-typescript)

[Quick start](#quick-start) · [How it works](#how-it-works) · [Commands](#commands) · [Security](#security) · [Русский](README.ru.md)

</div>

You start a long Claude Code run and walk away. A session stops to ask for permission, a deploy waits for a yes, a question sits in a terminal nobody is watching. Architect is a Telegram bot that runs on your Mac and brings all of it to your phone.

> [!NOTE]
> The bot speaks English or Russian: `"lang": "en"` or `"ru"` in `config.local.json`.

## What you get

- **Ask in plain words.** The architect, a Claude agent on the Claude Agent SDK, starts Claude Code sessions in the right folders, passes your messages to them, sets their goals, restarts and stops them.
- **Your own sessions too.** After 3 minutes without keyboard or mouse input, permission requests and multiple-choice questions from any Claude Code session on the Mac, including the ones you started in a terminal, come to Telegram as buttons. When you are back, whatever is still waiting returns to the terminal.
- **Irreversible steps wait for your tap.** A policy gate checks every shell command and MCP tool call of the sessions the architect starts. Deleting files, pushing to main, deploying, spending money and sending email wait for your button, and stay blocked while the bot is off. Deploying by hand over ssh, scp, rsync or FTP is refused. For a routine step, a card can offer to allow it in that project from now on; `/rules` lists these rules and revokes them. The gate matches commands against rules: a guard rail, not a sandbox.
- **Decisions in one line.** A request opens with what will change, whether it can be undone and, when the facts allow, a recommendation. The command and the changed files are one tap deeper.
- **One pinned dashboard.** Who is waiting for you, what is running, whether your sites respond and how much of your weekly Claude limit is used. The bot edits it instead of posting new messages.
- **The deploy as a screenshot.** After you allow a push or merge, the bot waits for the GitHub Actions run and reports how it went. For a site linked to its repository, it sends a phone-sized screenshot of the live page.
- **Quiet nights.** From midnight to 8:00 messages arrive without sound and reports you did not ask for are held back; at 8:00 you get one summary of the night. You are woken only if work you expect by morning is about to stop.
- **Promises kept.** When the architect promises to send something once a session finishes, or to remind you at 9:30, the host records it and reminds the architect on time, even after a restart. If the Claude limit has run out, the bot tells you and comes back to it after the reset.
- **Voice, transcribed on the Mac.** Send a voice message instead of typing: [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper) turns it into text locally, offline.

## Quick start

You need a Mac with [Claude Code](https://code.claude.com/docs/en/setup) signed in, and Telegram on your phone.

**1. Install the plugin.** In Claude Code:

```
/plugin install architect --marketplace sternblut/architect
```

Claude Code installs the dependencies. The host runs on [Bun](https://bun.sh) 1.2 or newer; the next step offers to install it.

**2. Connect.** In Claude Code:

```
/architect:connect
```

Claude walks you through it: you create a bot in [@BotFather](https://t.me/BotFather), its token goes through a hidden macOS dialog straight into the Keychain, never into the chat, and a one-time link pairs the bot with your Telegram account. Where one-button connection is set up, a QR code on the Mac screen and a button in Telegram create the bot for you instead.

**3. Write to your bot.** It asks which folders to work in, which sites to watch and whether to follow your GitHub runs. Then send your first task, in plain words or by voice.

`/architect:off` turns everything off. Updates come with the plugin: `/plugin` → architect → Update. Settings and state live in `~/.claude/plugins/data/architect-sapfir/` and survive updates, and so does the architect's conversation.

### From source

For development, or to run your own copy. You also need a bot from [@BotFather](https://t.me/BotFather): send `/newbot` and keep the token.

```sh
git clone https://github.com/sternblut/architect.git
cd architect
bun install
bunx playwright-core install webkit chromium   # browsers for site screenshots
bin/arch token   # paste the bot token; it goes to the macOS Keychain
bin/arch on      # start the host now and at every login
bin/arch pair    # prints a one-time link: open it on your phone and tap Start
```

`config.json` in the repository is a shared template. The setup in the chat writes your folders, sites and GitHub to `config.local.json`, which git ignores, so `archi update` never runs into your changes. The bot speaks English; for Russian, start with `echo '{ "lang": "ru" }' > config.local.json`.

Optional, from the same folder:

- `ln -s "$PWD/bin/arch" ~/.local/bin/archi` gives you the `archi` command used below.
- `echo "source \"$PWD/bin/claude-wrap.zsh\"" >> ~/.zshrc` lets the bot restart a session you started in a terminal, in the same tab, and keeps a `claude attach` tab attached when it restarts a background session.
- `gh auth login`, then `/setup` in the chat, lets the bot follow your GitHub runs and pull requests.
- Turn on Threaded Mode for your bot in @BotFather to give each session its own topic.
- Deploy screenshots need a site linked to its repository: in `sites` in `config.local.json`, for example `{ "name": "Landing", "url": "https://example.com/", "repo": "landing" }`, then `bin/arch restart`.
- Voice, Apple Silicon only: add `"voice": { "whisper": "/path/to/mlx_whisper", "model": "mlx-community/whisper-large-v3-turbo", "language": "en" }` to `config.local.json`. Download the model into your Hugging Face cache first: the host runs it offline.

## How it works

```mermaid
flowchart LR
    phone(["Telegram<br>on your phone"])
    subgraph mac ["Your Mac"]
        host["Host<br>Bun, launchd"]
        architect["Architect<br>Claude Agent SDK"]
        workers["Sessions the<br>architect starts"]
        yours["Your own<br>sessions"]
    end
    phone <--> host
    host <--> architect
    architect --> workers
    workers -- "irreversible? ask first" --> host
    host <-- "permissions and questions<br>while you are away" --> yours
```

- **Host.** A Bun process that `archi on` registers with launchd, so it starts at login. It talks to Telegram through grammY and keeps the Mac from idle sleep while it runs.
- **Architect.** A Claude agent (Opus by default) with tools to start, message, restart and stop sessions, set goals, read session logs and take screenshots.
- **Shared hook.** Makes every Claude Code session on the Mac report to the host. `archi on` adds three entries to `~/.claude/settings.json` and `archi off` removes them; the plugin registers the same hook itself.
- **Policy gate** ([`src/policy.ts`](src/policy.ts)). Checks every shell command and MCP tool call of the architect's sessions before it runs. Your decisions are logged to `logs/decisions.jsonl`.
- **Cloud relay, optional** ([`relay/`](relay/)). A Cloudflare Worker for when the Mac sleeps: it says so, answers `/status` with the last summary and queues your messages until the Mac wakes. It holds no bot token or private key and never accepts a decision. Its replies are in Russian for now.

## Commands

| Command | What it does |
|---|---|
| `archi on` | Start the host and turn on start at login |
| `archi off` | Turn everything off: the bot goes quiet and the shared hook stops. Sessions keep running |
| `archi off --all` | The same, and stop the sessions the architect started |
| `archi status` | Host, pairing, shared hook, token, version, last log lines |
| `archi logs [-f]` | Host log |
| `archi restart` | Restart; waits up to 2 minutes for the architect to finish its reply |
| `archi update` | Update to the latest version and restart. Your settings in `config.local.json` stay as they are |
| `archi rollback` | Back to the version before the last update; `archi update` returns to the latest |
| `archi pair` | Print a pairing link and code, for the first pairing or to move the bot to another Telegram account (the previous one is told) |
| `archi token` | Save the bot token to the Keychain |
| `archi ask "what to do"` | Ask you with a button in Telegram; exits with 0 only if you allow |
| `archi uninstall` | Stop the architect's sessions; remove the service, the shared hook, the saved secrets and the `archi` command |

In Telegram you just write. `/status` returns the dashboard, `/stop` interrupts the architect's reply, `/new` starts the conversation over, `/rules` lists what runs without asking. To answer a session, reply to its message.

## Security

- The bot obeys only the Telegram account you paired using a six-digit code from your Mac. The code expires after 30 minutes or five wrong attempts.
- Forwarded messages, web pages, files and tool output are data, not instructions. A forwarded "yes" is not a decision.
- The bot token lives in the macOS Keychain. The policy gate blocks the usual commands that would read it from the architect's sessions, and logs and messages are scrubbed of secrets.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Docs

The user guide ([docs/guide.ru.md](docs/guide.ru.md)) is in Russian for now.

## License

[MIT](LICENSE)
