// The weekly Claude limit is shared by all sessions and the architect: if it runs out before the reset, all work stops.
// A flag on the dashboard is not enough, so the owner gets a message in advance. The pace comes from the last hours:
// a weekly average is wrong when sessions work in bursts.
import { join } from "node:path";
import { STATE, tr } from "./config";
import { type Limits, whenHuman } from "./status";
import { readJson, writeJson } from "./util";

type Sample = { at: number; week: number };
const FILE = join(STATE, "limits.json");
const st = readJson<{ samples: Sample[]; warned?: string }>(FILE, { samples: [] });

// Claude's usage page: more usage is bought there, and it opens on an iPhone
export const USAGE_URL = "https://claude.ai/settings/usage";

// The warning text when one is due, otherwise undefined
export function weekWarning(l: Limits | undefined, now = Date.now()): string | undefined {
  if (l?.week === undefined || !l.weekResets) return;
  const last = st.samples.at(-1);
  if (!last || now - last.at >= 5 * 60_000) {
    st.samples = [...st.samples.filter((s) => now - s.at < 6 * 3600_000), { at: now, week: l.week }];
    writeJson(FILE, st);
  }
  if (l.week < 80 || l.week >= 100) return; // at 100% the dashboard already says sessions are stopped
  const end = recentEnd(l.week, now);
  const resets = Date.parse(l.weekResets);
  if (end === undefined || end >= resets - 3600_000) return;
  // Repeat only at a new step (80, 90, 95%) within the same week. The reset time jitters by fractions of a second
  // (01:59:59.53, 02:00:00.38), so the week is keyed by the hour.
  const key = `${Math.round(resets / 3600_000)}:${l.week >= 95 ? 95 : l.week >= 90 ? 90 : 80}`;
  if (st.warned === key) return;
  st.warned = key;
  writeJson(FILE, st);
  // When work stops comes first. The host may send this while the architect can't reply, so nothing asks for a reply.
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

// When the weekly limit reaches 100% at the pace of the last hours. Infinity: nothing was used in that time;
// undefined: less than 30 minutes of data. The status answer uses the same estimate, so the two never disagree.
export function recentEnd(week: number, now = Date.now()): number | undefined {
  const base = st.samples.find((s) => now - s.at <= 3 * 3600_000);
  if (!base || now - base.at < 30 * 60_000) return undefined;
  if (week <= base.week) return Infinity;
  return now + ((100 - week) / ((week - base.week) / ((now - base.at) / 3600_000))) * 3600_000;
}
