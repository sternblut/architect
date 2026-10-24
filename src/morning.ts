// The 8:00 summary is built by the host from facts, not by the model: nothing is made up, and it arrives even when the
// limit is out. First what the owner needs to do, then who worked overnight and what they did, then new pages as buttons.
// Messages held back overnight go to the architect, which adds what matters; only when it can't reply do the last five
// go here.
import { tr } from "./config";
import { headline, problemLines, waitingLines, type View } from "./status";
import type { Button } from "./telegram";
import { clip, hhmm, sentences } from "./util";

export type NightWork = { name: string; doing?: string; until: number };
export type NightPage = { name: string; title?: string; url: string };

const dot = (x: string) => (/[.?!…:]$/.test(x) ? x : `${x}.`);
// Lowercase after the dash: "A* — собрала 12 снимков". In English only a plain capitalized word, so "GitHub" and "I" stay
const low = (x: string) => (tr(/^\p{Lu}\p{Ll}/u, /^[A-Z][a-z]+\b/).test(x) ? x.charAt(0).toLowerCase() + x.slice(1) : x);
// The name is already before the dash: no "Reviews — reviews paused"
const withoutName = (doing: string, name: string) => (doing.toLowerCase().startsWith(name.toLowerCase()) ? doing.slice(name.length).replace(/^[\s,:—–-]+/, "") : doing);

export function morningMd(o: { view: View; worked: NightWork[]; pages: NightPage[]; held?: string[] }): { md: string; buttons: Button[][] } {
  const v = o.view;
  // the same lines as the dashboard
  const lines: string[] = [`**${tr("Утро.", "Morning.")}** ${headline(v)}${v.waiting.length ? ":" : "."}`, ...waitingLines(v.waiting).map(dot)];
  // problems get their own paragraph, apart from decisions
  const problems = problemLines(v).map(dot);
  // each group is its own paragraph, as in the pinned message
  const night: string[] = [];
  if (o.worked.length) {
    night.push(tr("Ночью работали:", "Worked overnight:"));
    // at most five, in whole sentences
    for (const w of o.worked.slice(0, 5))
      night.push(dot(w.doing ? `${w.name} — ${low(sentences(withoutName(w.doing, w.name), 140))}` : tr(`${w.name} — работала до ${hhmm(new Date(w.until))}`, `${w.name} — worked until ${hhmm(new Date(w.until))}`)));
    if (o.worked.length > 5) night.push(tr(`И ещё ${o.worked.length - 5}.`, `And ${o.worked.length - 5} more.`));
  } else night.push(tr("Ночью работы не было.", "No work overnight."));
  const accept = v.accept.length ? [dot(tr(`${v.accept.length === 1 ? "Ждёт" : "Ждут"} вашей проверки: ${v.accept.map((i) => i.name).join(", ")}`, `Ready for your review: ${v.accept.map((i) => i.name).join(", ")}`))] : [];
  const held = o.held?.length ? [tr("Ночью отложил:", "Held back overnight:"), ...o.held.slice(-5).map((h) => dot(clip(h.replace(/\s+/g, " "), 160)))] : [];
  // no "Docs: Docs: draft" when the title already starts with the name
  const label = (p: NightPage) => (!p.title ? p.name : p.title.toLowerCase().startsWith(p.name.toLowerCase()) ? p.title : `${p.name}: ${p.title}`);
  const buttons = o.pages.slice(0, 6).map((p) => [{ text: clip(label(p), 40), url: p.url }]);
  const pages = o.pages.length
    ? [o.pages.length === 1 ? tr("Новая страница для просмотра — кнопкой ниже.", "New preview page — button below.") : tr("Новые страницы для просмотра — кнопками ниже.", "New preview pages — buttons below.")]
    : [];
  return { md: [lines, problems, night, accept, held, pages].filter((b) => b.length).map((b) => b.join("\n")).join("\n\n"), buttons };
}
