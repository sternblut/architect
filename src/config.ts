import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const HOME = homedir();
export const ARCH_HOME = dirname(import.meta.dir);
export const TEST_HOME = join(ARCH_HOME, "test"); // test sessions run here; the real host ignores them
// The test folder of any Architect checkout, not only this one: otherwise the shared hook would send
// a test session from another checkout to the real chat.
export const isTestCwd = (cwd: string) => {
  if (cwd === TEST_HOME || cwd.startsWith(`${TEST_HOME}/`)) return true; // "test" but not "testing"
  const root = cwd.match(/^(.+)\/test(?:\/|$)/)?.[1];
  return !!root && existsSync(join(root, "src", "anyhook.ts"));
};
// Installed as a plugin, the code lives in a per-version folder that every update replaces. State, logs, settings and
// the architect's working folder go to the plugin data folder, found from the version folder or passed as ARCH_DATA
// by the launcher and the plugin hooks. In a git clone everything stays next to the code.
// ~/.claude/plugins/cache/<marketplace>/<plugin>/<version> → ~/.claude/plugins/data/<plugin>-<marketplace>
export function pluginData(root: string, home = HOME): string | undefined {
  const m = root.match(/\/\.claude\/plugins\/cache\/([^/]+)\/([^/]+)\/[^/]+$/);
  return m ? join(home, ".claude", "plugins", "data", `${m[2]}@${m[1]}`.replace(/[^A-Za-z0-9_-]/g, "-")) : undefined;
}
// Not CLAUDE_PLUGIN_DATA: Claude Code can leave another plugin's folder in it
export const DATA = process.env.ARCH_DATA ?? pluginData(ARCH_HOME);
export const WORK = DATA ? join(DATA, "architect") : ARCH_HOME;
// ARCH_STATE_DIR and ARCH_LOGS_DIR are set by tests
export const STATE = process.env.ARCH_STATE_DIR ?? join(DATA ?? ARCH_HOME, "state");
export const LOGS = process.env.ARCH_LOGS_DIR ?? join(DATA ?? ARCH_HOME, "logs");
export const INBOX = join(STATE, "inbox");
export const SHOTS = join(STATE, "shots");
export const PROJECTS = join(HOME, ".claude", "projects");

// keychain: the Keychain service holding a protected site's visitor password (account "admin"); only the screenshot process reads it
export type Site = { name: string; url: string; repo?: string; keychain?: string };
export type AskKind = "delete" | "main" | "deploy" | "spend" | "people";

export type Config = {
  keychainService: string;
  keychainAccount: string;
  hookPort: number;
  roots: string[];
  architect: { model: string; effort: string };
  workers: { model: string; effort: string };
  githubOwner: string;
  sites: Site[];
  repos: string[];
  hostingPattern: string;
  spendPattern?: string; // regex of paid commands; the gate asks about them as spending
  repoPrefix?: string; // shared repo name prefix, dropped from project names in cards
  monitor?: { width: number; height: number }; // desktop viewport for page screenshots
  ask?: AskKind[]; // which of the owner's five points still get a button; all five by default. Hosting is always refused
  richMessages?: boolean; // Bot API 10.1+ rich messages; false falls back to HTML
  voice?: { whisper: string; model: string; language: string; vocab?: string };
  relay?: { url: string }; // cloud relay that answers while the Mac sleeps (relay/, src/relay.ts)
  label: string; // launchd label
  setupDone?: boolean; // false on a new install: the bot opens with the setup questions
  connect?: { relay: string; dist: string }; // set when this bot connects other Macs: box relay URL and installer URL
  browserLock?: string; // module exporting acquireBrowserLock: a browser queue shared on this Mac
  lang?: "ru" | "en"; // language of everything the bot shows; Russian when unset
};

// config.json is the shared template. Each Mac's own settings live in config.local.json, which git ignores, so
// "archi update" never conflicts with them. ARCH_CONFIG replaces both with one complete file (tests, the bot manager).
export const CONFIG_FILE = process.env.ARCH_CONFIG ?? join(DATA ?? ARCH_HOME, "config.local.json");
// Local settings override the template; the template's setupDone applies only while there are no local settings
export function mergeConfig(template: Record<string, unknown>, local?: Record<string, unknown>): Record<string, unknown> {
  if (!local) return template;
  const { setupDone: _, ...rest } = template;
  return { ...rest, ...local };
}
const local = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : undefined;
const template = process.env.ARCH_CONFIG ? {} : JSON.parse(readFileSync(join(ARCH_HOME, "config.json"), "utf8"));
export const config: Config = { roots: ["~"], sites: [], repos: [], githubOwner: "", hostingPattern: "", label: "app.archi.host", ...(mergeConfig(template, local) as Partial<Config>) } as Config;
if (!config.hostingPattern) config.hostingPattern = "(?!)"; // matches nothing
config.roots = config.roots.map((r) => r.replace(/^~(?=\/|$)/, HOME));
if (process.env.ARCH_HOOK_PORT) config.hookPort = Number(process.env.ARCH_HOOK_PORT);
if (process.env.ARCH_LANG) config.lang = process.env.ARCH_LANG === "en" ? "en" : "ru";

// Owner-facing text as a Russian/English pair: tr("Сайт", "Site"). The language is read on every call,
// so tests switch it with setLang() without reloading modules.
export const tr = <T>(ru: T, en: T): T => (config.lang === "en" ? en : ru);
export const setLang = (lang: "ru" | "en") => void (config.lang = lang);

export function ensureDirs() {
  for (const d of [STATE, LOGS, INBOX, SHOTS]) mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(STATE, 0o700);
  // Plugin install: CLAUDE.md comes with each new version; the conversation and notes stay
  if (WORK !== ARCH_HOME) {
    mkdirSync(join(WORK, "notes"), { recursive: true, mode: 0o700 });
    copyFileSync(join(ARCH_HOME, "CLAUDE.md"), join(WORK, "CLAUDE.md"));
  }
}

// Claude Code's transcript folder for a cwd: every non-alphanumeric character becomes "-"
export function projectDir(cwd: string) {
  return join(PROJECTS, cwd.replace(/[^A-Za-z0-9]/g, "-"));
}
