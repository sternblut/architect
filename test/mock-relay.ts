// A mock box and distribution server for live checks (127.0.0.1), following the box protocol:
//   POST /v1/box/{id}          put an envelope (JSON up to 8 KB; up to 8 per box, kept 15 minutes) → 201
//   GET  /v1/box/{id}?wait=25  {messages: [...]} right away if any, else after waiting up to wait seconds
// No keys or passwords: the server keeps only ciphertext. It also serves the distribution: /i (installer), /archi.tgz.
import { existsSync } from "node:fs";
import { join } from "node:path";

type Box = { at: number; messages: unknown[]; waiters: (() => void)[] };

export class MockRelay {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  boxes = new Map<string, Box>();
  bodies: string[] = []; // every raw body posted, to check that no token travels in the clear

  constructor(private dist: string) {
    this.server = Bun.serve({ port: 0, idleTimeout: 60, fetch: (req) => this.handle(req) });
    this.url = `http://127.0.0.1:${this.server.port}`;
  }

  stop() {
    for (const b of this.boxes.values()) for (const w of b.waiters) w();
    this.server.stop(true);
  }

  private box(id: string): Box {
    const now = Date.now();
    for (const [k, b] of this.boxes) if (now - b.at > 15 * 60_000) this.boxes.delete(k);
    let b = this.boxes.get(id);
    if (!b) this.boxes.set(id, (b = { at: now, messages: [], waiters: [] }));
    return b;
  }

  private async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const m = u.pathname.match(/^\/v1\/box\/([\w-]{16,64})$/);
    if (m && req.method === "POST") {
      const raw = await req.text();
      if (raw.length > 8192) return new Response("too large", { status: 413 });
      this.bodies.push(raw);
      const b = this.box(m[1]);
      if (b.messages.length >= 8) return new Response("full", { status: 429 });
      b.messages.push(JSON.parse(raw));
      for (const w of b.waiters.splice(0)) w();
      return new Response("{}", { status: 201 });
    }
    if (m && req.method === "GET") {
      const b = this.box(m[1]);
      const wait = Math.min(Number(u.searchParams.get("wait") ?? 0), 25);
      if (!b.messages.length && wait > 0) await new Promise<void>((r) => (b.waiters.push(r), setTimeout(r, wait * 1000)));
      return Response.json({ messages: b.messages });
    }
    const file = join(this.dist, u.pathname.replace(/^\/+/, ""));
    if (/^\/(i|archi\.tgz)$/.test(u.pathname) && existsSync(file)) return new Response(Bun.file(file));
    return new Response("not found", { status: 404 });
  }
}
