// The shared hook for every Claude Code session: `bun src/install-hooks.ts install | uninstall | status`.
// Writes three entries to ~/.claude/settings.json (PermissionRequest, PreToolUse for AskUserQuestion, Stop) and nothing else.
// Finds its own entries by the path to anyhook.ts and backs the file up to state/backups/ before each change.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ARCH_HOME, HOME, STATE, tr } from "./config";

const SETTINGS = process.env.ARCH_USER_SETTINGS ?? join(HOME, ".claude", "settings.json"); // tests use their own file
const SCRIPT = join(ARCH_HOME, "src", "anyhook.ts");
const COMMAND = `'${process.execPath}' '${SCRIPT}'`;

type HookEntry = { matcher?: string; hooks: { type: string; command?: string; timeout?: number }[] };
type Settings = { hooks?: Record<string, HookEntry[]>; [k: string]: unknown };

const ours = (e: HookEntry) => (e.hooks ?? []).some((h) => String(h.command ?? "").includes(SCRIPT));

function load(): { s: Settings; indent: number } {
  if (!existsSync(SETTINGS)) return { s: {}, indent: 2 };
  const raw = readFileSync(SETTINGS, "utf8");
  return { s: JSON.parse(raw) as Settings, indent: raw.match(/^\{\n( +)"/)?.[1].length ?? 2 };
}

function save(s: Settings, indent: number) {
  if (existsSync(SETTINGS)) {
    const dir = join(STATE, "backups");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    copyFileSync(SETTINGS, join(dir, `settings.json.${new Date().toISOString().replace(/[:.]/g, "-")}`));
  }
  const mode = existsSync(SETTINGS) ? statSync(SETTINGS).mode & 0o777 : 0o600;
  mkdirSync(dirname(SETTINGS), { recursive: true }); // ~/.claude may not exist yet
  const tmp = `${SETTINGS}.arch-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s, null, indent) + "\n", { mode });
  renameSync(tmp, SETTINGS);
}

function strip(s: Settings) {
  if (!s.hooks) return;
  for (const [ev, list] of Object.entries(s.hooks)) {
    const kept = (list ?? []).filter((e) => !ours(e));
    if (kept.length) s.hooks[ev] = kept;
    else delete s.hooks[ev];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
}

export function installed(): boolean {
  const { s } = load();
  return Object.values(s.hooks ?? {}).some((list) => (list ?? []).some(ours));
}

export function install() {
  const { s, indent } = load();
  strip(s);
  s.hooks ??= {};
  const entry = (timeout: number, matcher?: string): HookEntry => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: COMMAND, timeout }] });
  (s.hooks.PermissionRequest ??= []).push(entry(21600));
  (s.hooks.PreToolUse ??= []).push(entry(21600, "AskUserQuestion"));
  (s.hooks.Stop ??= []).push(entry(7200));
  save(s, indent);
}

export function uninstall() {
  const { s, indent } = load();
  if (!installed()) return;
  strip(s);
  save(s, indent);
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === "install") {
    install();
    console.log(tr("Общий хук для всех сессий Claude Code поставлен.", "Shared hook for all Claude Code sessions installed."));
  } else if (cmd === "uninstall") {
    uninstall();
    console.log(tr("Общий хук снят.", "Shared hook removed."));
  } else console.log(installed() ? tr("Общий хук: стоит", "Shared hook: installed") : tr("Общий хук: не стоит", "Shared hook: not installed"));
}
