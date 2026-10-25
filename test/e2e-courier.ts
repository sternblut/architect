// Live check for issue #12: words reach a live session without restarting it.
// A sandbox background session is open in a window through `claude attach` (here a pseudo-terminal), then gets three
// messages within a minute. Expected: one process, the window still attached, all three in order; the courier never
// shows in the session list and leaves no conversation behind.
// Run: ARCH_STATE_DIR=<empty folder> [E2E_BOX=<a folder Claude Code trusts>] bun test/e2e-courier.ts
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TEST_HOME } from "../src/config";
import { courierIds, makeCourier } from "../src/courier";
import { deliver, listAgents, setClaudeBin, setCourier, stopSession } from "../src/sessions";

if (!process.env.ARCH_STATE_DIR) throw new Error("set ARCH_STATE_DIR");
const claude = Bun.which("claude")!;
setClaudeBin(claude);
setCourier(makeCourier({ claudePath: claude }));
const box = process.env.E2E_BOX ?? join(TEST_HOME, "sandbox-courier");
mkdirSync(box, { recursive: true });

const name = `courier-e2e-${Date.now().toString(36)}`;
Bun.spawnSync([claude, "--bg", "-n", name, "--model", "sonnet", "Reply with one word: READY. Then wait."], { cwd: box });
const find = async () => (await listAgents(true)).filter((r) => r.name === name);
let row = (await find())[0];
for (let i = 0; i < 90 && !(row?.pid && row.status === "idle"); i++) {
  await Bun.sleep(2000);
  row = (await find())[0];
}
if (!row?.pid || !row.id) throw new Error("the sandbox session did not come up");
const pid = row.pid;

// the owner's window: an attach client in a pseudo-terminal, kept reading so the client keeps running
const window = `import os, pty, sys, select
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], [sys.argv[1], "attach", sys.argv[2]])
while True:
    r, _, _ = select.select([fd], [], [], 1)
    if r:
        try: os.read(fd, 65536)
        except OSError: break
    if os.waitpid(pid, os.WNOHANG)[0]: break
`;
const tab = Bun.spawn(["python3", "-c", window, claude, row.id], { cwd: box, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await Bun.sleep(5000);
console.log("window attached after 5 s:", tab.exitCode === null);

// while delivering, watch the session list as the host sees it and as Claude Code lists it
const project = join(process.env.HOME!, ".claude", "projects", box.replace(/[^A-Za-z0-9]/g, "-"));
const conversations = () => readdirSync(project).filter((x) => x.endsWith(".jsonl")).length;
const before = conversations();
const old = new Set((await listAgents(true)).filter((r) => r.cwd === row.cwd).map((r) => r.sessionId));
const listed = new Map<string, string>();
const raw = new Set<string>();
let watching = true;
const watch = (async () => {
  while (watching) {
    for (const r of await listAgents(true)) if (r.cwd === row.cwd && !old.has(r.sessionId)) listed.set(r.sessionId ?? "?", `${r.name} ${r.kind} pid ${r.pid}`);
    const all = JSON.parse(Bun.spawnSync([claude, "agents", "--json"]).stdout.toString()) as { sessionId?: string }[];
    for (const r of all) if (r.sessionId && courierIds.has(r.sessionId)) raw.add(r.sessionId);
    await Bun.sleep(200);
  }
})();

// a long voice transcript first: quotes, backticks, $, a backslash, emoji and line breaks must arrive as they are
const voice = Array.from({ length: 50 }, (_, i) => `${i + 1}. Длинная расшифровка голосового: «ёлочки», "лапки", \`обратные\`, $HOME и \\ остаются как есть 🙂`).join("\n");
const texts = [`${voice}\nНичего не делай, ответь одним словом: OK-1`, "second: reply OK-2", "third: reply OK-3"];
const results = [];
for (const t of texts) results.push(await deliver(row, t));
watching = false;
await watch;
console.log(`deliveries: ${results.map((r) => `${r.how}${r.ok ? "" : ` (${r.note})`}`).join(", ")}; the first is ${texts[0].length} characters`);
console.log(`courier sessions seen by Claude Code: ${raw.size}, by the host: ${listed.size}`, [...listed.values()].join("; "));

// what the session's own conversation recorded as messages from other sessions
const received = () =>
  readFileSync(join(project, `${row.sessionId}.jsonl`), "utf8")
    .split("\n")
    .flatMap((l) => {
      const e = l ? JSON.parse(l) : {};
      return e.type === "user" && e.origin?.kind === "peer" ? [String(e.origin.body)] : [];
    });
let got: string[] = [];
for (let i = 0; i < 90 && got.length < texts.length; i++) {
  got = received();
  if (got.length < texts.length) await Bun.sleep(2000);
}
const after = await find();
const checks: [string, boolean][] = [
  ["all three deliveries went through the courier", results.every((r) => r.ok && r.how === "sent")],
  ["the session got all three word for word, in order", JSON.stringify(got) === JSON.stringify(texts.map((t) => `Сообщение владельца из Telegram: «${t}»`))],
  ["one process for the conversation, the same one", after.length === 1 && after[0].pid === pid],
  ["the window is still attached", tab.exitCode === null],
  ["the courier never shows in the host's session list", raw.size > 0 && listed.size === 0],
  ["the courier leaves no conversation behind", conversations() === before],
];
for (const [what, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${what}`);
tab.kill();
await stopSession(row.id);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
