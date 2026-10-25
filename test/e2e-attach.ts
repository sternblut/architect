// Live check for issue #12: the owner's own message to a background session open in a Terminal tab through
// `claude attach` restarts the session, and the tab attaches again by itself. The tab is a zsh in a pseudo-terminal
// with bin/claude-wrap.zsh, like a new Terminal tab with the wrapper in ~/.zshrc.
// Run: ARCH_STATE_DIR=<empty folder> [E2E_BOX=<a folder Claude Code trusts>] bun test/e2e-attach.ts
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.ARCH_STATE_DIR) throw new Error("set ARCH_STATE_DIR");
const restart = mkdtempSync(join(tmpdir(), "arch-restart-"));
process.env.CLAUDE_RESTART_DIR = restart; // the host and the tab share it, apart from the owner's real one
const { TEST_HOME, ARCH_HOME } = await import("../src/config");
const { deliver, listAgents, setClaudeBin, stopSession } = await import("../src/sessions");

const claude = Bun.which("claude")!;
setClaudeBin(claude);
const box = process.env.E2E_BOX ?? join(TEST_HOME, "sandbox-courier");
mkdirSync(box, { recursive: true });
// as from a fresh Terminal tab: no Claude Code markers of the session running this check
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))), CLAUDE_RESTART_DIR: restart };

const name = `attach-e2e-${Date.now().toString(36)}`;
Bun.spawnSync([claude, "--bg", "-n", name, "--model", "sonnet", "Reply with one word: READY. Then wait."], { cwd: box, env });
const find = async () => (await listAgents(true)).filter((r) => r.name === name);
let row = (await find())[0];
for (let i = 0; i < 90 && !(row?.pid && row.status === "idle"); i++) {
  await Bun.sleep(2000);
  row = (await find())[0];
}
if (!row?.pid || !row.id) throw new Error("the sandbox session did not come up");

// the tab: zsh with the wrapper running `claude attach <id>`, kept reading so the client keeps running
const tty = `import os, pty, sys, select
pid, fd = pty.fork()
if pid == 0:
    os.execvp("zsh", ["zsh", "-f", "-c", 'source "$0"; claude attach "$1"', sys.argv[1], sys.argv[2]])
print(pid, flush=True)
while True:
    r, _, _ = select.select([fd], [], [], 1)
    if r:
        try: os.read(fd, 65536)
        except OSError: break
    if os.waitpid(pid, os.WNOHANG)[0]: break
`;
const tab = Bun.spawn(["python3", "-c", tty, join(ARCH_HOME, "bin", "claude-wrap.zsh"), row.id], { cwd: box, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
const shell = Number(new TextDecoder().decode((await tab.stdout.getReader().read()).value).trim());
const attached = () => {
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,args="]).stdout.toString();
  return ps.split("\n").filter((l) => new RegExp(`^\\s*\\d+\\s+${shell}\\s+.*claude attach ${row!.id}(\\s|$)`).test(l)).map((l) => Number(l.trim().split(/\s+/)[0]));
};
for (let i = 0; i < 20 && !attached().length; i++) await Bun.sleep(500);
const before = attached();
console.log("tab attached:", before.length === 1, "| shell", shell);

// the owner gives a goal to a session that is waiting; right after an attach Claude Code can be busy for a moment
let waited = 0;
for (; waited < 60 && (await find())[0]?.status !== "idle"; waited++) await Bun.sleep(1000);
console.log(`idle again after attaching: ${waited} s`);
const goal = "/goal reply with the single word GOAL; the goal is met once you have written it";
const res = await deliver(row, goal);
console.log("delivery:", res.how, res.ok ? "" : res.note);
let after: number[] = [];
for (let i = 0; i < 60; i++) {
  after = attached();
  if (after.length && after[0] !== before[0]) break;
  await Bun.sleep(1000);
}
const t = readFileSync(join(process.env.HOME!, ".claude", "projects", box.replace(/[^A-Za-z0-9]/g, "-"), `${row.sessionId}.jsonl`), "utf8");
const rows = await find();
const checks: [string, boolean][] = [
  ["the goal went in by resuming the conversation", res.ok && res.how === "resumed"],
  ["the session got it as its user's command", t.includes("<command-name>/goal</command-name>") && t.includes("reply with the single word GOAL")],
  ["the same tab attached again, to the same session", after.length === 1 && after[0] !== before[0]],
  ["one process for the conversation", rows.filter((r) => r.pid).length === 1],
];
for (const [what, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${what}`);
tab.kill();
await stopSession(row.id);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
