// Page screenshots: the host shoots the live site after a deploy; worker sessions leave their own candidate shots.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ARCH_HOME, HOME, SHOTS } from "./config";
import { clip, log, run } from "./util";

let bunPath = process.execPath;
export function setBunPath(p: string) {
  bunPath = p;
}

export async function shoot(url: string, device: "iphone" | "macbook" | "monitor" = "iphone", keychain?: string, full = false): Promise<{ path?: string; status?: number; title?: string; error?: string }> {
  const out = join(SHOTS, `${new Date().toISOString().replace(/[:.]/g, "-")}-${device}.png`);
  const r = await run([bunPath, join(ARCH_HOME, "src", "shot-cli.ts"), url, device, out, full ? "full" : "", ...(keychain ? [keychain] : [])], { timeoutMs: 180_000, cwd: ARCH_HOME });
  if (r.code !== 0 || !existsSync(out)) return { error: clip(r.stderr || r.stdout, 300) };
  try {
    const info = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
    return { path: out, status: info.status, title: info.title };
  } catch {
    return { path: out };
  }
}

// Candidate shots the worker saved to $CLAUDE_JOB_DIR/tmp/evidence in the last 2 hours
export function candidateShots(jobId?: string): string[] {
  if (!jobId) return [];
  const dir = join(HOME, ".claude", "jobs", jobId, "tmp", "evidence");
  if (!existsSync(dir)) return [];
  const since = Date.now() - 2 * 3600_000;
  try {
    return readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .map((f) => join(dir, f))
      .filter((p) => statSync(p).mtimeMs >= since)
      .sort()
      .slice(0, 8);
  } catch (e) {
    log("shots", "не прочитал снимки кандидата", String(e));
    return [];
  }
}
