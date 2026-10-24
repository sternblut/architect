// Недельный лимит Claude — общий для всех сессий и архитектора: кончится раньше сброса — встанет вся работа владельца.
// Одного флага в «Пульте» мало: о таком предупреждаем сообщением заранее.
// Темп считаем по последним часам: средний за неделю врёт, когда сессии работают рывками.
import { join } from "node:path";
import { STATE, tr } from "./config";
import { type Limits, whenHuman } from "./status";
import { readJson, writeJson } from "./util";

type Sample = { at: number; week: number };
const FILE = join(STATE, "limits.json");
const st = readJson<{ samples: Sample[]; warned?: string }>(FILE, { samples: [] });

// Текст предупреждения, если его пора отправить; undefined — молчим.
// Страница лимитов Claude: там же докупают лимит, и она открывается с iPhone. Тот же адрес Claude Code показывает
// сам при упоре в лимит. Раньше бот слал «на Mac наберите /usage-credits»
export const USAGE_URL = "https://claude.ai/settings/usage";

export function weekWarning(l: Limits | undefined, now = Date.now()): string | undefined {
  if (l?.week === undefined || !l.weekResets) return;
  const last = st.samples.at(-1);
  if (!last || now - last.at >= 5 * 60_000) {
    st.samples = [...st.samples.filter((s) => now - s.at < 6 * 3600_000), { at: now, week: l.week }];
    writeJson(FILE, st);
  }
  if (l.week < 80 || l.week >= 100) return; // кончился — об этом флаг «сессии стоят»
  const end = recentEnd(l.week, now);
  const resets = Date.parse(l.weekResets);
  if (end === undefined || end >= resets - 3600_000) return;
  // повторяем только на новой ступени (80, 90, 95%) в том же недельном окне
  // время сброса Claude отдаёт с дрожью в доли секунды (01:59:59.53 и 02:00:00.38) — окно узнаём по часу, иначе
  // одно и то же предупреждение уходит дважды
  const key = `${Math.round(resets / 3600_000)}:${l.week >= 95 ? 95 : l.week >= 90 ? 90 : 80}`;
  if (st.warned === key) return;
  st.warned = key;
  writeJson(FILE, st);
  // главное — когда встанет работа — первой строкой; хост шлёт это сам, когда архитектор не отвечает, поэтому без
  // «скажите мне, какие поставить на паузу»
  return tr(
    [
      `**Недельный лимит Claude кончится ${whenHuman(end)}.**`,
      `Потрачено ${Math.round(l.week)}%, а сбросится он только ${whenHuman(resets)}: до сброса встанет вся работа, и мои ответы тоже.`,
      "Чтобы работа не встала, докупите лимит.",
      USAGE_URL,
    ],
    [
      `**Weekly Claude limit will run out ${whenHuman(end)}.**`,
      `${Math.round(l.week)}% used, and it only resets ${whenHuman(resets)}: until then all work stops, including my replies.`,
      "To keep work going, buy more usage.",
      USAGE_URL,
    ],
  ).join("\n");
}

// Когда недельный лимит дойдёт до 100% при темпе последних часов. Infinity — за эти часы он не тратился, undefined — данных
// меньше получаса. Тот же срок — и в ответе на «лимиты?»: посчитанный по среднему за неделю, он расходился бы
// с предупреждением.
export function recentEnd(week: number, now = Date.now()): number | undefined {
  const base = st.samples.find((s) => now - s.at <= 3 * 3600_000);
  if (!base || now - base.at < 30 * 60_000) return undefined;
  if (week <= base.week) return Infinity;
  return now + ((100 - week) / ((week - base.week) / ((now - base.at) / 3600_000))) * 3600_000;
}
