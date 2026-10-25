// Delivering a message neither starts copies of a session nor kicks it out of its Terminal tab, including two messages
// in a row to a background session open through `claude attach`. claude and ps are stubs with state in a file that
// behave like Claude Code 2.1.3xx.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRow } from "../src/sessions";

const dir = mkdtempSync(join(tmpdir(), "arch-deliver-"));
process.env.ARCH_STATE_DIR = dir;
process.env.ARCH_LOGS_DIR = dir;
const FAKE = join(dir, "fake.json");
process.env.FAKE_STATE = FAKE;

type Row = AgentRow & { id: string; sessionId: string };
type Fake = { sessions: Row[]; attached: string[]; stuck: string[]; copy: boolean; calls: string[] };

writeFileSync(
  join(dir, "claude"),
  `#!/usr/bin/env bun
const f = process.env.FAKE_STATE;
const s = JSON.parse(await Bun.file(f).text());
const a = process.argv.slice(2);
const save = () => Bun.write(f, JSON.stringify(s));
if (a[0] === "agents") console.log(JSON.stringify(s.sessions));
else if (a[0] === "stop") {
  s.calls.push("stop " + a[1]);
  const r = s.sessions.find((x) => x.id === a[1]);
  if (r && !s.stuck.includes(a[1])) Object.assign(r, { pid: undefined, status: "idle", state: "stopped" });
  await save();
  console.log("stopped " + a[1]);
} else if (a[0] === "--resume") {
  const r = s.sessions.find((x) => x.sessionId === a[1]);
  s.calls.push("resume " + r.id + " " + a[a.length - 1]);
  if (r.pid || s.copy) {
    const id = Math.random().toString(16).slice(2, 10);
    s.sessions.push({ ...r, id, sessionId: id + "-copy", pid: 9000 + s.sessions.length, status: "busy", state: "working" });
    console.log("note: session " + r.id + " is already running in the background, so this started a copy as " + id + ".");
    console.log("backgrounded · " + id);
  } else {
    Object.assign(r, { pid: 8000, status: "busy", state: "working" });
    console.log("backgrounded · " + r.id);
  }
  await save();
}
`,
  { mode: 0o755 },
);
writeFileSync(
  join(dir, "ps"),
  `#!/usr/bin/env bun
const s = JSON.parse(await Bun.file(process.env.FAKE_STATE).text());
console.log("?? /usr/sbin/cfprefsd agent");
for (const id of s.attached) console.log("ttys016  /Users/x/.local/bin/claude attach " + id);
`,
  { mode: 0o755 },
);

const { ARCH_NOTE, deliver, setClaudeBin, setCourier, setPsBin } = await import("../src/sessions");
setClaudeBin(join(dir, "claude"));
setPsBin(join(dir, "ps"));

const fake = (): Fake => JSON.parse(readFileSync(FAKE, "utf8"));
const row = (): Row => fake().sessions[0];
let sent: [number, string][] = [];
let reaches = true;
setCourier(async (pid, text) => {
  sent.push([pid, text]);
  return reaches;
});

beforeEach(() => {
  const s: Fake = {
    sessions: [{ id: "a1b2c3d4", sessionId: "a1b2c3d4-0001", name: "Арена", cwd: dir, kind: "background", startedAt: 0, status: "idle", state: "done", pid: 7000 }],
    attached: [],
    stuck: [],
    copy: false,
    calls: [],
  };
  writeFileSync(FAKE, JSON.stringify(s));
  sent = [];
  reaches = true;
});

const set = (patch: Partial<Fake>) => writeFileSync(FAKE, JSON.stringify({ ...fake(), ...patch }));
const words = (t: string) => `Сообщение владельца из Telegram: «${t}»`;

describe("words to a live session go through the courier, never by restarting it", () => {
  test("an idle background session gets them in its live process: no stop, no resume, no copy", async () => {
    const res = await deliver(row(), "Посмотри итоги недели");
    expect(res).toMatchObject({ ok: true, how: "sent" });
    expect(sent).toEqual([[7000, words("Посмотри итоги недели")]]);
    expect(fake().calls).toEqual([]);
    expect(fake().sessions.length).toBe(1);
  });

  test("the same for a session open in a window through attach: the window stays", async () => {
    set({ attached: ["a1b2c3d4"] });
    expect((await deliver(row(), "Посмотри итоги недели")).ok).toBe(true);
    expect(fake().calls).toEqual([]);
  });

  test("the architect's own note goes as it is, not as the owner's words", async () => {
    const note = `${ARCH_NOTE}он про ночную выкладку`;
    await deliver(row(), note);
    expect(sent).toEqual([[7000, note]]);
  });

  test("the courier can't reach it: nothing restarts, the architect passes the words on", async () => {
    reaches = false;
    expect(await deliver(row(), "Посмотри итоги недели")).toMatchObject({ ok: false, how: "needs-sendmessage" });
    expect(fake().calls).toEqual([]);
  });

  test("two messages in a row go one at a time, both through the courier", async () => {
    const idle = row();
    const [a, b] = await Promise.all([deliver(idle, "голосовое"), deliver(idle, "и пересланные")]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(sent.map(([, t]) => t)).toEqual([words("голосовое"), words("и пересланные")]);
    expect(fake().calls).toEqual([]);
  });
});

describe("the owner's own message (принято, /goal) resumes the conversation with it", () => {
  test("«принято» that closes a goal goes in as his own reply", async () => {
    expect((await deliver(row(), "принято")).ok).toBe(true);
    expect(sent).toEqual([]);
    expect(fake().calls).toEqual(["stop a1b2c3d4", "resume a1b2c3d4 принято"]);
  });

  test("a slash command such as /goal too", async () => {
    await deliver(row(), "/goal довести фичу");
    expect(fake().calls).toEqual(["stop a1b2c3d4", "resume a1b2c3d4 /goal довести фичу"]);
  });

  test("a stopped session (no process) resumes with plain words", async () => {
    set({ sessions: [{ ...row(), pid: undefined, state: "stopped" }] });
    expect((await deliver(row(), "Посмотри итоги недели")).ok).toBe(true);
    expect(sent).toEqual([]);
    expect(fake().calls).toEqual(["resume a1b2c3d4 Посмотри итоги недели"]);
  });

  test("doesn't resume a session that didn't stop, which would start a copy", async () => {
    set({ stuck: ["a1b2c3d4"] });
    expect((await deliver(row(), "принято")).ok).toBe(false);
    expect(fake().calls).toEqual(["stop a1b2c3d4"]);
    expect(fake().sessions.length).toBe(1);
  }, 30_000);

  test("stops a copy Claude Code started anyway and reports the message as not delivered", async () => {
    set({ copy: true });
    expect((await deliver(row(), "принято")).ok).toBe(false);
    const s = fake();
    const copy = s.sessions[1];
    expect(s.calls).toEqual(["stop a1b2c3d4", "resume a1b2c3d4 принято", `stop ${copy.id}`]);
    expect(copy.pid).toBeUndefined();
  });
});
