// What a pkill or killall would stop: the arguments for pgrep, and one live lookup of a running helper.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selection, stopsNow } from "../src/procs";

describe("what pgrep is asked", () => {
  test("pkill: the signal and -I are pkill's own", () => {
    expect(selection("pkill", ["-INT", "-f", "simctl io booted recordVideo"])).toEqual(["-f", "simctl io booted recordVideo"]);
    expect(selection("pkill", ["-9", "-If", "vite"])).toEqual(["-f", "vite"]);
    expect(selection("pkill", ["-P", "123"])).toEqual(["-P", "123"]); // -P selects by parent, it is not a signal
    expect(selection("pkill", ["-sigkill", "simctl"])).toEqual(["simctl"]);
    expect(selection("pkill", ["-TERM"])).toEqual([]);
  });

  test("killall: exact names, -m for patterns, -u, -t and -c select", () => {
    expect(selection("killall", ["simctl"])).toEqual(["-x", "simctl"]);
    expect(selection("killall", ["-9", "-v", "ffmpeg", "simctl"])).toEqual(["-x", "ffmpeg", "simctl"]);
    expect(selection("killall", ["-m", "vit."])).toEqual(["vit."]);
    expect(selection("killall", ["-u", "x"])).toEqual(["-x", "-u", "x"]);
    expect(selection("killall", ["-c", "node"])).toEqual(["-x", "node"]);
  });

  test("killall that only lists or shows stops nothing; an unknown flag can't be told", () => {
    expect(selection("killall", ["-s", "node"])).toEqual([]);
    expect(selection("killall", ["-l"])).toEqual([]);
    expect(selection("killall", ["-q", "node"])).toBeNull();
    expect(selection("killall", ["-u"])).toBeNull();
  });
});

test("finds a running helper with its folder and parent", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "arch-procs-")));
  const secs = `37.${Date.now() % 100000}`;
  const p = Bun.spawn(["sleep", secs], { cwd: dir });
  await Bun.sleep(300);
  try {
    const hits = stopsNow("pkill", ["-f", `sleep ${secs}`]);
    expect(hits?.map((h) => [h.pid, h.name, h.cwd])).toEqual([[p.pid, "sleep", dir]]);
    expect(hits?.[0].parent).toContain("bun");
  } finally {
    p.kill();
  }
});
