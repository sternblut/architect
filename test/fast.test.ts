import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
process.env.ARCH_STATE_DIR = mkdtempSync(join(tmpdir(), "arch-fast-"));
const { fits } = await import("../src/fast");

test("the owner's word finds a session by its name, its stem, or A* typed on a Russian keyboard", () => {
  expect(fits("маяк", "Маяк")).toBe(true);
  expect(fits("маяка", "Маяк")).toBe(true);
  expect(fits("отзывы", "Анализ отзывов")).toBe(true);
  expect(fits("а*", "A*")).toBe(true); // Cyrillic "а"
  expect(fits("прогон", "Маяк")).toBe(false);
  expect(fits("регламенты", "Маяк")).toBe(false);
});

// A conversation can have two rows, a process in a tab and a background entry with the same id; a restart must not pick the latter
test("one row per conversation: a live process in a tab wins over the background entry", async () => {
  const { oneRowPerSession } = await import("../src/sessions");
  const rows = [
    { id: "c3a758b4", kind: "background", sessionId: "s1", status: "idle" },
    { kind: "interactive", sessionId: "s1", pid: 4424, status: "idle" },
    { kind: "interactive", sessionId: "s2", pid: 7, status: "busy" },
  ] as any;
  const out = oneRowPerSession(rows);
  expect(out.length).toBe(2);
  expect(out.find((r) => r.sessionId === "s1")!.pid).toBe(4424);
  expect(oneRowPerSession([{ id: "b", kind: "background", sessionId: "s3", pid: 9 }, { kind: "interactive", sessionId: "s3" }] as any)[0].kind).toBe("background"); // the background one is alive, the tab has no process
});
