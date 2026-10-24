---
name: connect
description: Connect this Mac to Telegram so the user can run Claude Code from their phone through the architect. Use when the user asks to connect, set up, pair or start the architect, its Telegram bot or the phone.
---

# Connect the architect to Telegram

The user wants to drive Claude Code on this Mac from Telegram. Talk in the user's language, one short step at a time, and run the commands yourself. `archi` is this plugin's command: it is on your Bash PATH while the plugin is enabled.

1. **Bun.** Run `bun --version`. If Bun is missing or older than 1.2, ask whether to install it with the official installer, `curl -fsSL https://bun.sh/install | bash`, and run it only after a yes.
2. **Already connected?** Run `archi status`. If the host is running and the owner is paired, say so in one line and stop.
3. **One button, no BotFather.** Run `archi connect` in the background and read its output as it comes.
   - If it exits at once with code 3, this copy has no one-button connection: go to step 4.
   - Otherwise a QR code opens on the Mac screen. Tell the user to point the iPhone camera at it, or to open the link from the output, then enter the four-digit code from the output in Telegram and tap the button that creates their bot.
   - When the output shows `Telegram: <name>, bot @<bot>` and asks for confirmation, ask the user with AskUserQuestion whether this is their Telegram account and their new bot. On yes run `archi connect --yes`, on no `archi connect --no`.
   - When the output says the Mac is connected, the host starts by itself. Go to step 7.
4. **Own bot.** Ask the user to create a bot: in Telegram, open @BotFather, send `/newbot`, pick a name and keep the token it replies with. Never ask them to paste the token into this chat.
5. **The token.** Run `archi token --dialog`. A macOS window asks for the token with hidden input and puts it straight into the Keychain. Tell the user the window is open on the Mac. Then run `archi on`: the host starts now and at every login.
6. **Pair.** Run `archi pair`. It prints a link with a one-time code. Show the link; the user opens it on the phone and taps Start. From then on the bot answers only their Telegram account.
7. **Done.** The bot asks the setup questions right in the chat: folders, sites, GitHub. Tell the user in two lines: they write tasks to the bot in plain words or by voice, and `/architect:off` turns everything off.

If a step fails, show its last lines and stop. Do not retry blindly and do not edit files to work around it.
