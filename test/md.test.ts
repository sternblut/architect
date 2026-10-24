import { describe, expect, test } from "bun:test";
import { richSafe } from "../src/md";

describe("richSafe", () => {
  // an architect reply that Telegram would merge into one paragraph and italicize between the two "A*"
  const reply =
    "9 сессий, все запущены вами в терминалах.\n\n🟡 Каталог стоит: в терминале открыт запрос.\n🟡 Сайт A* ждёт вашего решения.\n🟢 Ещё работает доработка этого бота.\n⏸ Ждут вашего слова план A* на год и Маяк.";

  test("every line stays a line", () => {
    const out = richSafe(reply).split("\n");
    expect(out[2].endsWith("  ")).toBe(true);
    expect(out[3].endsWith("  ")).toBe(true);
    expect(out.at(-1)!.endsWith("  ")).toBe(false);
  });

  test("a blank line between paragraphs stays visible, as Telegram for iOS draws paragraphs with no gap", () => {
    const out = richSafe(reply).split("\n");
    expect(out[0].endsWith("  ")).toBe(true);
    expect(out[1]).toBe("\u00a0  ");
    expect(richSafe("а\n\n\nб")).toBe("а  \n\u00a0  \nб");
  });

  test("blank lines around lists, code and collapsible blocks stay", () => {
    expect(richSafe("Итог:\n\n- раз")).toBe("Итог:\n\n- раз");
    expect(richSafe("- раз\n\nтекст")).toBe("- раз\n\nтекст");
    expect(richSafe("а\n\n```\nx\n```")).toBe("а\n\n```\nx\n```");
    expect(richSafe("<details><summary>Ещё</summary>\n\nтекст\n\n</details>")).toBe("<details><summary>Ещё</summary>\n\nтекст\n\n</details>");
  });

  test("Details without blank lines: the lines inside don't run together", () => {
    expect(richSafe("<details><summary>Подробнее</summary>\nраз\n**два**\n</details>")).toBe("<details><summary>Подробнее</summary>\n\nраз  \n**два**\n\n</details>");
    expect(richSafe("<details><summary>Подробнее</summary>текст</details>")).toBe("<details><summary>Подробнее</summary>\n\nтекст\n\n</details>");
  });

  test("the asterisk of A* doesn't start italics", () => {
    expect(richSafe(reply)).toContain("Сайт A\\* ждёт");
    expect(richSafe(reply)).toContain("план A\\* на год");
  });

  test("intended markup, links and code are untouched", () => {
    expect(richSafe("**Пульт** готов")).toBe("**Пульт** готов");
    expect(richSafe("[открыть](https://x.ru/a_b) и https://x.ru/c_d")).toBe("[открыть](https://x.ru/a_b) и https://x.ru/c_d");
    expect(richSafe("файл `worker_settings.json`")).toBe("файл `worker_settings.json`");
    expect(richSafe("worker_settings")).toBe("worker\\_settings");
  });

  test("lists, tables and code get no extra breaks", () => {
    expect(richSafe("Итог:\n- раз\n- два")).toBe("Итог:\n- раз\n- два");
    expect(richSafe("| a | b |\n| - | - |")).toBe("| a | b |\n| - | - |");
    expect(richSafe("```\nx_y\nA*\n```")).toBe("```\nx_y\nA*\n```");
  });
});

describe("openers about itself", () => {
  test("are dropped at the start; a bare Passed on stays short", async () => {
    const { noOpener } = await import("../src/architect");
    expect(noOpener("**Понял. Что именно не так?** Последнее — сводка в 14:04.")).toBe("**Что именно не так?** Последнее — сводка в 14:04.");
    expect(noOpener("Понял. Сейчас проверю.")).toBe("Сейчас проверю.");
    expect(noOpener("**Передал «Architect» ваши слова дословно.** Я зря написал, что последним присылал разбор.")).toBe("Я зря написал, что последним присылал разбор.");
    expect(noOpener("Передал «Регламентам» ваши слова.")).toBe("Передал.");
    expect(noOpener("Каталог работает: правит экран отчёта.")).toBe("Каталог работает: правит экран отчёта.");
    // a large request says what was passed and what comes next: not an opener
    expect(noOpener("Передал Арене: отдельный агент на оформление и мелкие коммиты. Её ответ пришлю.")).toBe("Передал Арене: отдельный агент на оформление и мелкие коммиты. Её ответ пришлю.");
  });
});
