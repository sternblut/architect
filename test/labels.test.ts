// One name for a session everywhere, and a name that fits several sessions is never guessed.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "arch-labels-"));
process.env.ARCH_STATE_DIR = dir;
process.env.ARCH_LOGS_DIR = dir;
process.env.ARCH_LANG = "ru";

const at = (iso: string) => Date.parse(iso);
const rows = [
  { id: "aa11bb22", sessionId: "aa11bb22-0001", name: "Конкурс", cwd: "/x/contest", kind: "background", pid: 101, status: "idle", startedAt: at("2026-10-24T01:01:00Z") },
  { id: "cc33dd44", sessionId: "cc33dd44-0002", name: "Конкурс", cwd: "/x/contest", kind: "background", pid: 102, status: "busy", startedAt: at("2026-10-24T19:10:00Z") },
  { id: "ee55ff66", sessionId: "ee55ff66-0003", name: "Конкурс", cwd: "/x/contest", kind: "background", status: "idle", state: "stopped", startedAt: at("2026-10-20T09:00:00Z") },
  { id: "1a2b3c4d", sessionId: "1a2b3c4d-0004", name: "Маяк", cwd: "/x/mayak", kind: "background", pid: 103, status: "idle", startedAt: at("2026-10-24T09:00:00Z") },
  // two copies of one conversation: Claude Code gives them the same start
  { id: "77aa88bb", sessionId: "77aa88bb-0007", name: "Витрина", cwd: "/x/shop", kind: "background", pid: 105, status: "idle", startedAt: at("2026-10-24T20:27:00Z") },
  { id: "66cc99dd", sessionId: "66cc99dd-0008", name: "Витрина", cwd: "/x/shop", kind: "background", pid: 106, status: "busy", startedAt: at("2026-10-24T20:27:00Z") },
  { id: "5e6f7a8b", sessionId: "5e6f7a8b-0005", name: "Блог", cwd: "/x/blog", kind: "background", pid: 104, status: "idle", startedAt: at("2026-10-24T09:00:00Z") },
  { id: "9c0d1e2f", sessionId: "9c0d1e2f-0006", name: "Блог", cwd: "/x/blog", kind: "background", status: "idle", state: "stopped", startedAt: at("2026-10-01T09:00:00Z") },
];
writeFileSync(join(dir, "rows.json"), JSON.stringify(rows));
writeFileSync(join(dir, "claude"), `#!/usr/bin/env bun\nif (process.argv[2] === "agents") console.log(await Bun.file(${JSON.stringify(join(dir, "rows.json"))}).text());\n`, { mode: 0o755 });

const { setClaudeBin } = await import("../src/sessions");
const { findSession, missingSession, sessionLabel } = await import("../src/ui");
setClaudeBin(join(dir, "claude"));
const label = (i: number) => sessionLabel(rows[i].sessionId, rows[i].cwd, rows as never);
const hm = (t: number) => new Date(t).toTimeString().slice(0, 5); // Mac local time, as the labels show it

describe("the label", () => {
  test("two live sessions with one name are told apart by when they started; a single one keeps its name", () => {
    expect(label(0)).toBe(`Конкурс (с ${hm(rows[0].startedAt)})`);
    expect(label(1)).toBe(`Конкурс (с ${hm(rows[1].startedAt)})`);
    expect(label(3)).toBe("Маяк");
    expect(label(6)).toBe("Блог"); // the other «Блог» is stopped
  });

  test("copies that started at the same minute are numbered", () => {
    const at = hm(rows[4].startedAt);
    expect([label(5), label(4)]).toEqual([`Витрина (с ${at}, первая)`, `Витрина (с ${at}, вторая)`]);
  });
});

describe("finding a session by what it is called", () => {
  test("by its id, the start of its session id, or the label the owner sees", async () => {
    expect((await findSession("cc33dd44"))?.sessionId).toBe("cc33dd44-0002");
    expect((await findSession("aa11bb22-00"))?.sessionId).toBe("aa11bb22-0001");
    expect((await findSession(label(1)))?.sessionId).toBe("cc33dd44-0002");
    expect((await findSession("маяк"))?.sessionId).toBe("1a2b3c4d-0004");
  });

  test("a live session wins over a stopped one with the same name", async () => {
    expect((await findSession("Блог"))?.sessionId).toBe("5e6f7a8b-0005");
  });

  test("a name that fits two live sessions is not guessed: the reply names both", async () => {
    expect(await findSession("Конкурс")).toBeUndefined();
    expect(await findSession("онку")).toBeUndefined();
    const why = await missingSession("Конкурс");
    expect(why).toContain(`${label(0)} [id aa11bb22]`);
    expect(why).toContain(`${label(1)} [id cc33dd44]`);
    expect(why).not.toContain("ee55ff66");
  });

  test("a name that fits nothing says so", async () => {
    expect(await findSession("Несуществующая")).toBeUndefined();
    expect(await missingSession("Несуществующая")).toContain("не нашёл");
  });
});
