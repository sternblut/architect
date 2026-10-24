// Разведка: что приходит в http-хуки фоновой сессии и как работают ответы хоста.
const port = Number(process.argv[2] ?? 47321);
const logFile = process.argv[3] ?? "hook-probe.log";
let stops = 0;
const out = Bun.file(logFile).writer();
Bun.serve({
  hostname: "127.0.0.1", port,
  async fetch(req) {
    const body = await req.json() as any;
    const ev = body.hook_event_name;
    out.write(JSON.stringify({ t: Date.now(), ev, secret: req.headers.get("x-arch-secret"), body }) + "\n"); out.flush();
    if (ev === "PreToolUse" && body.tool_name === "Bash" && String(body.tool_input?.command).includes("probe-ask"))
      return Response.json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "probe: owner must confirm" } });
    if (ev === "PreToolUse" && body.tool_name === "AskUserQuestion") {
      const qs = body.tool_input.questions; const answers: Record<string,string> = {};
      for (const q of qs) answers[q.question] = q.options?.[1]?.label ?? "B";
      return Response.json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...body.tool_input, answers } } });
    }
    if (ev === "PermissionRequest") return Response.json({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    if (ev === "Stop" && stops++ === 0) return Response.json({ decision: "block", reason: "Сообщение владельца из Telegram: «Напиши одно слово: АНАНАС»" });
    return Response.json({});
  },
});
console.log("listening", port);
