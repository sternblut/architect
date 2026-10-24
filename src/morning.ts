// Утренний итог в 8:00 собирает хост из фактов, а не модель: модель может присочинить,
// а упрись она в лимит — итога не было бы вовсе. Первая строка — что нужно от владельца; дальше — кто работал ночью
// и что сделал (строка слоя понимания), новые страницы кнопками. Что бот ночью отложил, сюда не сыплется: таких строк
// бывает больше десятка, и многие — устаревшие цифры лимита. Их читает архитектор и дописывает главное сам; только
// если он не может ответить (кончился лимит), отложенное идёт сюда же — последними пятью.
import { tr } from "./config";
import { headline, problemLines, waitingLines, type View } from "./status";
import type { Button } from "./telegram";
import { clip, hhmm, sentences } from "./util";

export type NightWork = { name: string; doing?: string; until: number };
export type NightPage = { name: string; title?: string; url: string };

const dot = (x: string) => (/[.?!…:]$/.test(x) ? x : `${x}.`);
// «Собрала 12 снимков» после тире — со строчной: «A* — собрала 12 снимков»; «GitHub» и «I» по-английски не трогаем
const low = (x: string) => (tr(/^\p{Lu}\p{Ll}/u, /^[A-Z][a-z]+\b/).test(x) ? x.charAt(0).toLowerCase() + x.slice(1) : x);
// имя уже стоит перед тире: «Анализ отзывов — анализ отзывов поставлен на паузу»
const withoutName = (doing: string, name: string) => (doing.toLowerCase().startsWith(name.toLowerCase()) ? doing.slice(name.length).replace(/^[\s,:—–-]+/, "") : doing);

export function morningMd(o: { view: View; worked: NightWork[]; pages: NightPage[]; held?: string[] }): { md: string; buttons: Button[][] } {
  const v = o.view;
  // теми же словами и строками, что сводка: свой вопрос архитектора — сам вопрос, у сессии — имя и что от вас нужно
  const lines: string[] = [`**${tr("Утро.", "Morning.")}** ${headline(v)}${v.waiting.length ? ":" : "."}`, ...waitingLines(v.waiting).map(dot)];
  // что ломает работу — отдельным абзацем, как в сводке: не путать с решениями
  const problems = problemLines(v).map(dot);
  // группы — отдельными абзацами, как в закрепе: «Ждут вашей проверки» читалось ещё одним пунктом ночного списка
  const night: string[] = [];
  if (o.worked.length) {
    night.push(tr("Ночью работали:", "Worked overnight:"));
    // самые занятые — первыми, не больше пяти; что сделала — целыми фразами, не обрывая на полуслове
    for (const w of o.worked.slice(0, 5))
      night.push(dot(w.doing ? `${w.name} — ${low(sentences(withoutName(w.doing, w.name), 140))}` : tr(`${w.name} — работала до ${hhmm(new Date(w.until))}`, `${w.name} — worked until ${hhmm(new Date(w.until))}`)));
    if (o.worked.length > 5) night.push(tr(`И ещё ${o.worked.length - 5}.`, `And ${o.worked.length - 5} more.`));
  } else night.push(tr("Ночью работы не было.", "No work overnight."));
  const accept = v.accept.length ? [dot(tr(`${v.accept.length === 1 ? "Ждёт" : "Ждут"} вашей проверки: ${v.accept.map((i) => i.name).join(", ")}`, `Ready for your review: ${v.accept.map((i) => i.name).join(", ")}`))] : [];
  const held = o.held?.length ? [tr("Ночью отложил:", "Held back overnight:"), ...o.held.slice(-5).map((h) => dot(clip(h.replace(/\s+/g, " "), 160)))] : [];
  // заголовок страницы уже с именем сессии — без повтора, иначе выйдет «Регламенты: Регламенты: черновик»
  const label = (p: NightPage) => (!p.title ? p.name : p.title.toLowerCase().startsWith(p.name.toLowerCase()) ? p.title : `${p.name}: ${p.title}`);
  const buttons = o.pages.slice(0, 6).map((p) => [{ text: clip(label(p), 40), url: p.url }]);
  const pages = o.pages.length
    ? [o.pages.length === 1 ? tr("Новая страница для просмотра — кнопкой ниже.", "New preview page — button below.") : tr("Новые страницы для просмотра — кнопками ниже.", "New preview pages — buttons below.")]
    : [];
  return { md: [lines, problems, night, accept, held, pages].filter((b) => b.length).map((b) => b.join("\n")).join("\n\n"), buttons };
}
