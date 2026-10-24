# Security

Architect runs commands on your Mac on your behalf, so security reports matter here.

## Reporting

Report privately through GitHub: **Security → Report a vulnerability**. Please do not open a public issue.
Include what you did, what happened, and the version from `archi version`.

## What counts

- Someone other than the paired Telegram account gets a message or a tap through to the architect.
- An irreversible action of the architect's sessions (deleting, pushing to main, deploying, spending money, sending email) runs without your button, or the policy gate in `src/policy.ts` can be bypassed.
- The bot token or another secret reaches a Claude session, the logs, a message or the cloud relay.
- The cloud relay accepts a decision.
- Text from a forwarded message, a web page, a file or tool output is treated as your instruction.

## Supported versions

The latest commit of the `build` branch.
