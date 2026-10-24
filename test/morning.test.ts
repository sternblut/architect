import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
process.env.ARCH_STATE_DIR = mkdtempSync(join(tmpdir(), "arch-morning-"));
const { morningMd } = await import("../src/morning");

const view = (o: Partial<{ waiting: { name: string; what: string; ask?: boolean }[]; accept: string[]; problems: string[] }> = {}) =>
  ({ total: 5, waiting: o.waiting ?? [], accept: (o.accept ?? []).map((name) => ({ name, what: "" })), paused: [], working: [], problems: o.problems ?? [], sites: "", limit: "" }) as any;

// итог — из фактов, а не от модели: модель может присочинить
test("ничего не нужно — так и сказано первой строкой; кто работал ночью и что сделал", () => {
  const { md, buttons } = morningMd({
    view: view({ accept: ["Маяк"] }),
    worked: [{ name: "A*", doing: "Собрала 12 снимков iPhone и Mac", until: Date.parse("2026-10-22T02:40:00Z") }, { name: "Регламенты", until: Date.parse("2026-10-22T01:15:00Z") }],
    pages: [
      { name: "A*", title: "A* прототип C", url: "https://claude.ai/artifact/X1" },
      { name: "Регламенты", title: "Регламенты: черновик", url: "https://claude.ai/artifact/X2" },
      { name: "Маяк", title: "Методика", url: "https://claude.ai/artifact/X3" },
    ],
  });
  expect(md).toStartWith("**Утро.** От вас ничего не нужно.\n\nНочью работали:\nA* — собрала 12 снимков iPhone и Mac.\nРегламенты — работала до ");
  expect(md).toContain("Ждёт вашей проверки: Маяк.");
  expect(md).not.toContain("Ночью отложил"); // отложенное читает архитектор и дописывает главное сам
  // заголовок уже с именем сессии — без повтора: не «Регламенты: Регламенты: черновик»
  expect(buttons.map((r) => r[0].text)).toEqual(["A* прототип C", "Регламенты: черновик", "Маяк: Методика"]);
});

// архитектор не может ответить (кончился лимит) — отложенное ночью в самом итоге, последними пятью, а не теряется
test("архитектор не отвечает — отложенное ночью в итоге, последние пять", () => {
  const held = Array.from({ length: 7 }, (_, i) => `Сообщение ${i + 1}`);
  const { md } = morningMd({ view: view(), worked: [], pages: [], held });
  expect(md).toContain("Ночью отложил:\nСообщение 3.\nСообщение 4.");
  expect(md).not.toContain("Сообщение 2.");
});

test("ждут решения — первой строкой число, ниже каждое; ночью никто не работал — так и сказано", () => {
  const { md, buttons } = morningMd({ view: view({ waiting: [{ name: "Каталог", what: "в терминале вопрос: «Отправить заказчику ответ?»" }, { name: "Маяк", what: "выложить на сайт?" }] }), worked: [], pages: [], held: [] });
  expect(md).toBe("**Утро.** 2 задачи ждут вашего решения:\n**Каталог** — в терминале вопрос: «Отправить заказчику ответ?».\n**Маяк** — выложить на сайт?\n\nНочью работы не было.");
  expect(buttons).toEqual([]);
});

test("работа ночью — это действия, а не любая запись в журнале", async () => {
  const { actionsSince } = await import("../src/sessions");
  const at = (h: string) => `2026-10-22T${h}:00.000Z`;
  const use = (t: string, k = 1) => ({ type: "assistant", timestamp: t, message: { role: "assistant", content: Array.from({ length: k }, (_, i) => ({ type: "tool_use", id: `u${t}${i}`, name: "Bash", input: {} })) } });
  const text = (t: string) => ({ type: "assistant", timestamp: t, message: { role: "assistant", content: [{ type: "text", text: "Жду." }] } });
  const since = Date.parse(at("00:00"));
  expect(actionsSince([use("2026-10-21T23:10:00.000Z"), text(at("01:00")), text(at("03:00"))] as any, since)).toEqual({ n: 0, last: 0 }); // вечер — до полуночи
  expect(actionsSince([use(at("01:00"), 2), use(at("02:30"))] as any, since)).toEqual({ n: 3, last: Date.parse(at("02:30")) });
});

test("больше пяти работавших — пять самых занятых и «и ещё»", () => {
  const worked = Array.from({ length: 7 }, (_, i) => ({ name: `S${i}`, doing: "работала", until: 0 }));
  const { md } = morningMd({ view: view(), worked, pages: [], held: [] });
  expect(md).toContain("S4 — работала.\nИ ещё 2");
  expect(md).not.toContain("S5");
});

test("свой вопрос архитектора — сам вопрос; имя не повторяется; фразы целиком; что ломает работу — отдельным абзацем", () => {
  const { md } = morningMd({
    view: view({
      waiting: [{ name: "Архитектор", what: "выложить новую версию сайта?", ask: true }],
      problems: ["Недельный лимит Claude потрачен на 93%: если кончится, работа встанет до 27 октября"],
    }),
    worked: [
      { name: "Анализ отзывов", doing: "Анализ отзывов поставлен на паузу, как вы просили: выпуск отменён, работает прежняя версия.", until: 0 },
      { name: "Лендинг", doing: "Остановилась на 93% недельного лимита и ждёт вашего слова. Вариант с крупными фото до уровня лучших вариантов не дотянул. Снимки главной страницы для iPhone и Mac сделаны.", until: 0 },
    ],
    pages: [],
  });
  expect(md).toStartWith("**Утро.** 1 задача ждёт вашего решения:\nВыложить новую версию сайта?\n\nНедельный лимит Claude потрачен на 93%: если кончится, работа встанет до 27 октября.\n\nНочью работали:");
  expect(md).toContain("Анализ отзывов — поставлен на паузу, как вы просили");
  expect(md).toEndWith("Лендинг — остановилась на 93% недельного лимита и ждёт вашего слова. Вариант с крупными фото до уровня лучших вариантов не дотянул.");
});
