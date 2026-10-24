import { describe, expect, test } from "bun:test";
import { richSafe } from "../src/md";

describe("richSafe", () => {
  // ответ архитектора, который в Telegram слипался в абзац и уходил в курсив между двумя «A*»
  const reply =
    "9 сессий, все запущены вами в терминалах.\n\n🟡 Каталог стоит: в терминале открыт запрос.\n🟡 Сайт A* ждёт вашего решения.\n🟢 Ещё работает доработка этого бота.\n⏸ Ждут вашего слова план A* на год и Маяк.";

  test("каждая строка остаётся строкой", () => {
    const out = richSafe(reply).split("\n");
    expect(out[2].endsWith("  ")).toBe(true);
    expect(out[3].endsWith("  ")).toBe(true);
    expect(out.at(-1)!.endsWith("  ")).toBe(false);
  });

  test("пустая строка между абзацами видна и на iPhone: Telegram для iOS рисует абзацы вплотную", () => {
    const out = richSafe(reply).split("\n");
    expect(out[0].endsWith("  ")).toBe(true);
    expect(out[1]).toBe("\u00a0  ");
    expect(richSafe("а\n\n\nб")).toBe("а  \n\u00a0  \nб");
  });

  test("пустые строки вокруг списков, кода и раскрывашек не трогаем", () => {
    expect(richSafe("Итог:\n\n- раз")).toBe("Итог:\n\n- раз");
    expect(richSafe("- раз\n\nтекст")).toBe("- раз\n\nтекст");
    expect(richSafe("а\n\n```\nx\n```")).toBe("а\n\n```\nx\n```");
    expect(richSafe("<details><summary>Ещё</summary>\n\nтекст\n\n</details>")).toBe("<details><summary>Ещё</summary>\n\nтекст\n\n</details>");
  });

  test("«Подробнее» без пустых строк: строки внутри не слипаются", () => {
    expect(richSafe("<details><summary>Подробнее</summary>\nраз\n**два**\n</details>")).toBe("<details><summary>Подробнее</summary>\n\nраз  \n**два**\n\n</details>");
    expect(richSafe("<details><summary>Подробнее</summary>текст</details>")).toBe("<details><summary>Подробнее</summary>\n\nтекст\n\n</details>");
  });

  test("A* — звёздочка, а не начало курсива", () => {
    expect(richSafe(reply)).toContain("Сайт A\\* ждёт");
    expect(richSafe(reply)).toContain("план A\\* на год");
  });

  test("намеренная разметка, ссылки и код не тронуты", () => {
    expect(richSafe("**Пульт** готов")).toBe("**Пульт** готов");
    expect(richSafe("[открыть](https://x.ru/a_b) и https://x.ru/c_d")).toBe("[открыть](https://x.ru/a_b) и https://x.ru/c_d");
    expect(richSafe("файл `worker_settings.json`")).toBe("файл `worker_settings.json`");
    expect(richSafe("worker_settings")).toBe("worker\\_settings");
  });

  test("списки, таблицы и код — без лишних переносов", () => {
    expect(richSafe("Итог:\n- раз\n- два")).toBe("Итог:\n- раз\n- два");
    expect(richSafe("| a | b |\n| - | - |")).toBe("| a | b |\n| - | - |");
    expect(richSafe("```\nx_y\nA*\n```")).toBe("```\nx_y\nA*\n```");
  });
});

describe("зачин о себе убирает хост", () => {
  test("«Понял.», «Передал…» в начале — убираются; одно «Передал» остаётся коротким", async () => {
    const { noOpener } = await import("../src/architect");
    expect(noOpener("**Понял. Что именно не так?** Последнее — сводка в 14:04.")).toBe("**Что именно не так?** Последнее — сводка в 14:04.");
    expect(noOpener("Понял. Сейчас проверю.")).toBe("Сейчас проверю.");
    expect(noOpener("**Передал «Architect» ваши слова дословно.** Я зря написал, что последним присылал разбор.")).toBe("Я зря написал, что последним присылал разбор.");
    expect(noOpener("Передал «Регламентам» ваши слова.")).toBe("Передал.");
    expect(noOpener("Каталог работает: правит экран отчёта.")).toBe("Каталог работает: правит экран отчёта.");
    // большая просьба — что именно передано и что дальше; это не зачин: голое «Передал.» здесь слишком скупо
    expect(noOpener("Передал Арене: отдельный агент на оформление и мелкие коммиты. Её ответ пришлю.")).toBe("Передал Арене: отдельный агент на оформление и мелкие коммиты. Её ответ пришлю.");
  });
});
