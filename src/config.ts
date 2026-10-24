import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const HOME = homedir();
export const ARCH_HOME = dirname(import.meta.dir);
export const TEST_HOME = join(ARCH_HOME, "test"); // сессии проверок: настоящий хост их не видит
// Папка проверок любой копии кода архитектора, не только своей: иначе общий хук примет сессию проверки из другой копии
// за сессию владельца и пришлёт её пробные вопросы в настоящий чат.
export const isTestCwd = (cwd: string) => {
  if (cwd === TEST_HOME || cwd.startsWith(`${TEST_HOME}/`)) return true; // «test», но не «testing»
  const root = cwd.match(/^(.+)\/test(?:\/|$)/)?.[1];
  return !!root && existsSync(join(root, "src", "anyhook.ts"));
};
// Плагин Claude Code: код — в папке версии плагина, она меняется с каждым обновлением и через 14 дней удаляется. Всё
// постоянное — состояние, журналы, настройки и рабочая папка архитектора, где живёт его разговор, — в папке данных плагина:
// её находим по папке версии, а ARCH_DATA задают запуск хоста и хуки плагина явно. Без неё — всё рядом с кодом, как в git.
// папка версии из маркетплейса: ~/.claude/plugins/cache/<маркетплейс>/<плагин>/<версия> → ~/.claude/plugins/data/<плагин>-<маркетплейс>
export function pluginData(root: string, home = HOME): string | undefined {
  const m = root.match(/\/\.claude\/plugins\/cache\/([^/]+)\/([^/]+)\/[^/]+$/);
  return m ? join(home, ".claude", "plugins", "data", `${m[2]}@${m[1]}`.replace(/[^A-Za-z0-9_-]/g, "-")) : undefined;
}
// CLAUDE_PLUGIN_DATA из окружения не берём: Claude Code оставляет в нём папку чужого плагина
export const DATA = process.env.ARCH_DATA ?? pluginData(ARCH_HOME);
export const WORK = DATA ? join(DATA, "architect") : ARCH_HOME;
export const STATE = process.env.ARCH_STATE_DIR ?? join(DATA ?? ARCH_HOME, "state"); // ARCH_STATE_DIR — в тестах
export const LOGS = process.env.ARCH_LOGS_DIR ?? join(DATA ?? ARCH_HOME, "logs"); // в тестах — своя папка
export const INBOX = join(STATE, "inbox");
export const SHOTS = join(STATE, "shots");
export const PROJECTS = join(HOME, ".claude", "projects");

// keychain — запись связки ключей с паролем посетителя (аккаунт admin) для закрытых сайтов; читает только процесс снимка.
export type Site = { name: string; url: string; repo?: string; keychain?: string };
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
  richMessages?: boolean; // rich-сообщения Bot API 10.1+; false — старый HTML
  voice?: { whisper: string; model: string; language: string; vocab?: string };
  relay?: { url: string }; // дежурный в облаке, пока Mac спит (relay/, src/relay.ts); без него бот во сне молчит
  label: string; // служба launchd
  setupDone?: boolean; // false — новая установка: сначала мастер настройки в боте
  connect?: { relay: string; dist: string }; // этот бот подключает чужие Mac (менеджер личных ботов): адрес ящика и раздачи установщика
  browserLock?: string; // общая очередь браузера на этом Mac (модуль с acquireBrowserLock)
  lang?: "ru" | "en"; // язык владельца: всё, что бот ему показывает; без поля — русский
};

// Новая установка начинает с пустого: ни сайтов, ни репозиториев, ни правила хостинга. config.json в репозитории — общий
// образец; своё у каждого Mac — в config.local.json рядом (git его не хранит): так «archi update» не упирается в чужой
// config.json, а личные папки, сайты и ключи не попадают в репозиторий. ARCH_CONFIG —
// один готовый файл целиком (проверки, менеджер раздачи).
export const CONFIG_FILE = process.env.ARCH_CONFIG ?? join(DATA ?? ARCH_HOME, "config.local.json");
// свои настройки — поверх образца; мастер настройки (setupDone из образца) — только у новой установки без своих настроек
export function mergeConfig(template: Record<string, unknown>, local?: Record<string, unknown>): Record<string, unknown> {
  if (!local) return template;
  const { setupDone: _, ...rest } = template;
  return { ...rest, ...local };
}
const local = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : undefined;
const template = process.env.ARCH_CONFIG ? {} : JSON.parse(readFileSync(join(ARCH_HOME, "config.json"), "utf8"));
export const config: Config = { roots: ["~"], sites: [], repos: [], githubOwner: "", hostingPattern: "", label: "app.archi.host", ...(mergeConfig(template, local) as Partial<Config>) } as Config;
if (!config.hostingPattern) config.hostingPattern = "(?!)"; // хостинг не задан — правило не срабатывает
config.roots = config.roots.map((r) => r.replace(/^~(?=\/|$)/, HOME));
if (process.env.ARCH_HOOK_PORT) config.hookPort = Number(process.env.ARCH_HOOK_PORT);
if (process.env.ARCH_LANG) config.lang = process.env.ARCH_LANG === "en" ? "en" : "ru"; // английский без своего config.json (пробы, archi)

// Строка владельцу — парой на месте, по-русски и по-английски: tr("Сайт", "Site"). Язык читается при каждом вызове,
// поэтому проверки переключают его setLang(), не перезагружая модули.
export const tr = <T>(ru: T, en: T): T => (config.lang === "en" ? en : ru);
export const setLang = (lang: "ru" | "en") => void (config.lang = lang);

export function ensureDirs() {
  for (const d of [STATE, LOGS, INBOX, SHOTS]) mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(STATE, 0o700);
  // рабочая папка архитектора из плагина: его правила приходят с новой версией плагина, разговор и заметки остаются
  if (WORK !== ARCH_HOME) {
    mkdirSync(join(WORK, "notes"), { recursive: true, mode: 0o700 });
    copyFileSync(join(ARCH_HOME, "CLAUDE.md"), join(WORK, "CLAUDE.md"));
  }
}

// Каталог журналов сессии Claude Code: все не буквенно-цифровые знаки пути заменены на «-».
export function projectDir(cwd: string) {
  return join(PROJECTS, cwd.replace(/[^A-Za-z0-9]/g, "-"));
}
