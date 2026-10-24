// Доставка слова сессии не плодит копии и не выбивает её из вкладки Терминала.
// Два слова подряд одной фоновой сессии, открытой через `claude attach`: раньше её останавливали и поднимали
// наперегонки, вкладка показывала «Session has exited», а Claude Code заводил копии.
// Здесь вместо claude и ps — заглушки с состоянием в файле: они ведут себя как Claude Code 2.1.3xx.
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

const { deliver, setClaudeBin, setPsBin } = await import("../src/sessions");
setClaudeBin(join(dir, "claude"));
setPsBin(join(dir, "ps"));

const fake = (): Fake => JSON.parse(readFileSync(FAKE, "utf8"));
const row = (): Row => fake().sessions[0];

beforeEach(() => {
  const s: Fake = {
    sessions: [{ id: "a1b2c3d4", sessionId: "a1b2c3d4-0001", name: "Арена", cwd: dir, kind: "background", startedAt: 0, status: "idle", state: "done", pid: 7000 }],
    attached: [],
    stuck: [],
    copy: false,
    calls: [],
  };
  writeFileSync(FAKE, JSON.stringify(s));
});

const set = (patch: Partial<Fake>) => writeFileSync(FAKE, JSON.stringify({ ...fake(), ...patch }));

describe("слово простаивающей фоновой сессии", () => {
  test("будит тот же разговор: остановка, потом подъём с текстом, без копии", async () => {
    const res = await deliver(row(), "Посмотри итоги недели");
    expect(res.ok).toBe(true);
    expect(fake().calls).toEqual(["stop a1b2c3d4", "resume a1b2c3d4 Посмотри итоги недели"]);
    expect(fake().sessions.length).toBe(1);
  });

  test("открытую во вкладке через attach не трогает: вкладка не слетает, слово идёт сообщением", async () => {
    set({ attached: ["a1b2c3d4"] });
    const res = await deliver(row(), "Посмотри итоги недели");
    expect(res).toMatchObject({ ok: false, how: "needs-sendmessage" });
    expect(fake().calls).toEqual([]);
  });

  test("не остановилась — не поднимает заново: иначе Claude Code завёл бы копию", async () => {
    set({ stuck: ["a1b2c3d4"] });
    const res = await deliver(row(), "Посмотри итоги недели");
    expect(res.ok).toBe(false);
    expect(fake().calls).toEqual(["stop a1b2c3d4"]);
    expect(fake().sessions.length).toBe(1);
  }, 30_000);

  test("копию, если Claude Code её всё же завёл, сразу останавливает и честно говорит, что не передано", async () => {
    set({ copy: true });
    const res = await deliver(row(), "Посмотри итоги недели");
    expect(res.ok).toBe(false);
    const s = fake();
    const copy = s.sessions[1];
    expect(s.calls).toEqual(["stop a1b2c3d4", "resume a1b2c3d4 Посмотри итоги недели", `stop ${copy.id}`]);
    expect(copy.pid).toBeUndefined();
  });

  test("два слова подряд идут по очереди: второе видит, что сессия уже работает, и не перезапускает её", async () => {
    const idle = row();
    const [a, b] = await Promise.all([deliver(idle, "голосовое"), deliver(idle, "/goal довести фичу")]);
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, how: "needs-sendmessage" });
    expect(fake().calls).toEqual(["stop a1b2c3d4", "resume a1b2c3d4 голосовое"]);
    expect(fake().sessions.length).toBe(1);
  });
});
