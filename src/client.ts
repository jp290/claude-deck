import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const $ = (id: string) => document.getElementById(id)!;
const app = $("app"), ta = $("input") as HTMLTextAreaElement, dot = $("dot"),
  jump = $("jump"), keys = $("keys"), send = $("send") as HTMLButtonElement;

const term = new Terminal({
  scrollback: 50000,
  fontSize: 13,
  disableStdin: true,
  fontFamily: "ui-monospace, Menlo, Consolas, monospace",
  theme: { background: "#141414", foreground: "#d8d8d8" },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open($("term"));
// read-only view: never pop the iOS keyboard when tapping/scrolling the terminal
term.textarea!.readOnly = true;
term.textarea!.setAttribute("inputmode", "none");

function post(path: string, body: unknown) {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- layout: iOS keyboard shrinks visualViewport but not the layout viewport ---
function vfit() {
  const vv = window.visualViewport;
  app.style.height = (vv?.height ?? window.innerHeight) + "px";
  app.style.transform = `translateY(${vv?.offsetTop ?? 0}px)`;
  window.scrollTo(0, 0);
}
let lastCols = 0, lastRows = 0;
function sendResize() {
  if (term.cols === lastCols && term.rows === lastRows) return;
  lastCols = term.cols;
  lastRows = term.rows;
  post("/resize", { cols: term.cols, rows: term.rows });
}
let resizeTimer: ReturnType<typeof setTimeout>;
function onViewportChange() {
  vfit();
  fit.fit(); // resize the visual terminal immediately — never let it lag the flex box,
             // or it can paint over #bar (both are positioned; source order won't save it)
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(sendResize, 500); // only the network reflow of the tmux pane is debounced
}
window.addEventListener("resize", onViewportChange);
window.visualViewport?.addEventListener("resize", onViewportChange);
vfit();
fit.fit();

// --- websocket stream (server→client: pane output; client→server: live keystrokes) ---
let ws: WebSocket | null = null;
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    dot.className = "on";
    sendResize();
  };
  ws.onmessage = (e) => term.write(new Uint8Array(e.data as ArrayBuffer));
  ws.onclose = () => {
    dot.className = "off";
    setTimeout(connect, 1500);
  };
}
connect();

// --- live input mode: a real visible input relays every keystroke to the pane ---
// (xterm's hidden helper textarea is unreliable on iOS: keyboard often won't open,
//  autocorrect swallows input — so we never use it for typing)
const live = $("live"), livebar = $("livebar"), livein = $("livein") as HTMLInputElement;
let liveOn = false;
const MAX_CHUNK = 1000; // stay under the server's 1024-byte cap per WS message
function sendRaw(s: string) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const bytes = new TextEncoder().encode(s);
  // splitting mid-codepoint is safe: tmux relays raw bytes to the pty, which
  // reassembles UTF-8 the same way it would from fast individual keystrokes
  for (let i = 0; i < bytes.length; i += MAX_CHUNK) ws.send(bytes.slice(i, i + MAX_CHUNK));
}
live.onclick = () => {
  liveOn = !liveOn;
  live.classList.toggle("on", liveOn);
  livebar.style.display = liveOn ? "flex" : "none";
  // reveal the field but don't focus it — tapping it is what should open the keyboard
  if (!liveOn) livein.blur();
};
const KEYMAP: Record<string, string> = {
  Enter: "\r", Escape: "\x1b", Backspace: "\x7f", Tab: "\t",
  ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D",
};
livein.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  const seq = KEYMAP[e.key];
  if (seq) {
    e.preventDefault();
    sendRaw(seq);
  }
});
livein.addEventListener("beforeinput", (e) => {
  if (e.inputType === "insertCompositionText") return; // not cancelable; handled on compositionend
  if (e.inputType === "insertText" || e.inputType === "insertFromPaste") {
    e.preventDefault();
    if (e.data) sendRaw(e.data);
  }
});
livein.addEventListener("compositionend", (e) => {
  if (e.data) sendRaw(e.data);
  livein.value = "";
});
livein.addEventListener("input", () => {
  // sweeper: the field must stay empty so autocorrect has nothing to rewrite
  if (livein.value) livein.value = "";
});

// --- jump-to-bottom pill ---
function updateJump() {
  const b = term.buffer.active;
  jump.style.display = b.viewportY < b.baseY - 1 ? "flex" : "none";
}
term.onScroll(updateJump);
term.onWriteParsed(updateJump);
document.querySelector(".xterm-viewport")!.addEventListener("scroll", updateJump, { passive: true });
jump.onclick = () => term.scrollToBottom();

// keys row is for navigating TUI dialogs — reclaim its space while composing
ta.addEventListener("focus", () => { keys.style.display = "none"; });
ta.addEventListener("blur", () => { keys.style.display = "flex"; });

// --- command prefix chips ---
// these are examples of this author's own custom Claude Code skills — swap in your own
// slash commands (or none) in both this array and the matching buttons in index.html
const CMDS = ["/sharpen", "/gosharp", "/sharpen3", "/gosharp3"];
function currentPrefix(): string | null {
  for (const c of CMDS) if (ta.value === c || ta.value.startsWith(c + " ")) return c;
  return null;
}
function updateChips() {
  const active = currentPrefix();
  for (const el of document.querySelectorAll<HTMLButtonElement>("#chips .chip"))
    el.classList.toggle("active", el.dataset.cmd === active);
}
function togglePrefix(cmd: string) {
  const active = currentPrefix();
  const rest = active ? ta.value.slice(active.length).replace(/^ /, "") : ta.value;
  ta.value = active === cmd ? rest : cmd + " " + rest;
  updateChips();
}
ta.addEventListener("input", updateChips);

// --- toolbar ---
for (const el of document.querySelectorAll<HTMLButtonElement>("#bar [data-key]"))
  el.onclick = () => post("/key", { key: el.dataset.key });
for (const el of document.querySelectorAll<HTMLButtonElement>("#bar [data-cmd]"))
  el.onclick = () => togglePrefix(el.dataset.cmd!);

// voice = iOS keyboard dictation: focus the input so the keyboard (with its mic key) opens
$("mic").onclick = () => ta.focus();

function flashSendError() {
  send.style.background = "#f85149"; // reuses the existing "disconnected" red
  setTimeout(() => { send.style.background = ""; }, 1200);
}
send.onclick = async () => {
  const text = ta.value.trim();
  if (!text || send.disabled) return;
  send.disabled = true;
  try {
    const res = await post("/send", { text, submit: true });
    if (!res.ok) throw new Error(`send failed: ${res.status}`);
    ta.value = "";
    updateChips();
    term.scrollToBottom();
  } catch {
    flashSendError(); // text stays in the box so nothing typed is silently lost
  } finally {
    send.disabled = false;
  }
};
