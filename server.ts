import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ServerWebSocket } from "bun";

const HOST = process.env.DECK_HOST ?? "127.0.0.1";
const PORT = Number(process.env.DECK_PORT ?? 8788);
const SOCK = "claudedeck";
const SESSION = "deck";
const CWD = process.env.DECK_CWD ?? process.env.HOME!;
const STREAM = `${import.meta.dir}/stream.raw`;
const REPLAY_TAIL = 2_000_000;

const ALLOWED_KEYS = new Set(["Enter", "Escape", "Up", "Down", "Left", "Right", "Tab", "BTab", "C-c"]);

async function tmux(...args: string[]): Promise<{ out: string; code: number }> {
  const p = Bun.spawn(["tmux", "-L", SOCK, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  return { out: out.trim(), code };
}

async function ensureSession() {
  await tmux("start-server");
  const has = await tmux("has-session", "-t", SESSION);
  if (has.code !== 0) {
    await tmux("set", "-g", "history-limit", "50000");
    await tmux("new-session", "-d", "-s", SESSION, "-x", "100", "-y", "40", "-c", CWD, "claude --dangerously-skip-permissions; exec zsh");
    console.log(`created tmux session '${SESSION}' running claude in ${CWD}`);
  }
  const pipe = await tmux("display-message", "-p", "-t", SESSION, "#{pane_pipe}");
  const pipeOpen = pipe.out === "1";
  if (pipeOpen && existsSync(STREAM)) return;
  if (pipeOpen) await tmux("pipe-pane", "-t", SESSION); // close stale pipe (file was deleted)
  // seed stream with full pane history, then start piping raw output
  const cap = await tmux("capture-pane", "-t", SESSION, "-e", "-p", "-S", "-");
  await Bun.write(STREAM, cap.out + "\r\n");
  await tmux("pipe-pane", "-t", SESSION, "-o", `exec cat >> '${STREAM}'`);
  await repaint();
}

// resize jiggle: SIGWINCH makes the TUI repaint into the fresh pipe so the client aligns
async function repaint() {
  const size = await tmux("display-message", "-p", "-t", SESSION, "#{window_width} #{window_height}");
  const [w, h] = size.out.split(" ").map(Number);
  if (!w || !h) return;
  await tmux("resize-window", "-t", SESSION, "-x", String(w), "-y", String(h - 1));
  await Bun.sleep(200);
  await tmux("resize-window", "-t", SESSION, "-x", String(w), "-y", String(h));
}

async function sendText(text: string, submit: boolean) {
  const p = Bun.spawn(["tmux", "-L", SOCK, "load-buffer", "-b", "deckbuf", "-"], { stdin: "pipe" });
  p.stdin.write(text);
  await p.stdin.end();
  await p.exited;
  await tmux("paste-buffer", "-p", "-d", "-b", "deckbuf", "-t", SESSION);
  if (submit) {
    await Bun.sleep(150);
    await tmux("send-keys", "-t", SESSION, "Enter");
  }
}

type WSData = { queue: Uint8Array[]; ready: boolean };
const clients = new Set<ServerWebSocket<WSData>>();
let offset = 0;

function broadcast(chunk: Uint8Array) {
  for (const ws of clients) {
    if (ws.data.ready) ws.send(chunk);
    else ws.data.queue.push(chunk);
  }
}

async function poll() {
  try {
    const size = (await stat(STREAM)).size;
    if (size < offset) offset = 0;
    if (size > offset) {
      const buf = await Bun.file(STREAM).slice(offset, size).arrayBuffer();
      offset = size;
      broadcast(new Uint8Array(buf));
    }
  } catch {}
}

const STATIC: Record<string, { path: string; type: string }> = {
  "/": { path: `${import.meta.dir}/public/index.html`, type: "text/html; charset=utf-8" },
  "/app.js": { path: `${import.meta.dir}/public/app.js`, type: "text/javascript" },
  "/xterm.css": { path: `${import.meta.dir}/node_modules/@xterm/xterm/css/xterm.css`, type: "text/css" },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

await ensureSession();
offset = existsSync(STREAM) ? (await stat(STREAM)).size : 0;
setInterval(poll, 100);

Bun.serve<WSData>({
  hostname: HOST,
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: { queue: [], ready: false } })) return;
      return new Response("upgrade failed", { status: 400 });
    }
    if (req.method === "POST" && url.pathname === "/send") {
      const { text, submit } = await req.json();
      if (typeof text !== "string" || text.length > 100_000) return json({ error: "bad text" }, 400);
      await sendText(text, submit !== false);
      return json({ ok: true });
    }
    if (req.method === "POST" && url.pathname === "/key") {
      const { key } = await req.json();
      if (!ALLOWED_KEYS.has(key)) return json({ error: "key not allowed" }, 400);
      await tmux("send-keys", "-t", SESSION, key);
      return json({ ok: true });
    }
    if (req.method === "POST" && url.pathname === "/resize") {
      const { cols, rows } = await req.json();
      const c = Math.min(300, Math.max(20, Number(cols) | 0));
      const r = Math.min(200, Math.max(10, Number(rows) | 0));
      await tmux("resize-window", "-t", SESSION, "-x", String(c), "-y", String(r));
      return json({ ok: true, cols: c, rows: r });
    }
    const s = STATIC[url.pathname];
    if (s)
      return new Response(Bun.file(s.path), {
        headers: { "content-type": s.type, "cache-control": "no-store" },
      });
    return new Response("not found", { status: 404 });
  },
  websocket: {
    async open(ws) {
      clients.add(ws);
      const upTo = offset;
      const start = Math.max(0, upTo - REPLAY_TAIL);
      if (upTo > start) {
        const buf = await Bun.file(STREAM).slice(start, upTo).arrayBuffer();
        ws.send(new Uint8Array(buf));
      }
      ws.data.ready = true;
      for (const chunk of ws.data.queue) ws.send(chunk);
      ws.data.queue = [];
    },
    close(ws) {
      clients.delete(ws);
    },
    // live input: client sends raw keystroke bytes, forwarded verbatim to the pane
    async message(_ws, msg) {
      const bytes = typeof msg === "string" ? new TextEncoder().encode(msg) : new Uint8Array(msg);
      if (bytes.length === 0 || bytes.length > 1024) return;
      const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
      await tmux("send-keys", "-t", SESSION, "-H", ...hex);
    },
  },
});

console.log(`claude-deck: http://${HOST}:${PORT}  (tmux -L ${SOCK}, session '${SESSION}')`);
