// Servidor de teste do painel (so para desenvolvimento; nao entra no .qrc nem no build).
//   node mock-server.js [porta]      -> http://127.0.0.1:3637/#t=teste
// Serve os arquivos de ../ e imita a API v1 (incl. modos/cenas, "source" e WebSocket) com dados falsos.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = +process.argv[2] || 3637;
const ROOT = path.resolve(__dirname, "..");
const TOKEN = "teste";
const N = 159;                       // 0-70 monitor, 71-158 mesa
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const state = { on: true, brightness: 80, profile: "Mock", device: "Mock (sem fita)", led_count: N, version: "5.13.0.0-mock", scene: "" };
const profiles = ["Mock", "Outro"];
const W = 1920, H = 1080;
const layout = { leds: [], screens: [{ x: 0, y: 0, w: W, h: H }] };
for (let i = 0; i < N; i++) {
  let x, y, w = 60, h = 60;
  if (i < 20) { x = 0; y = H - 60 - i * (H / 20); }                       // esquerda, de baixo para cima
  else if (i < 51) { x = (i - 20) * (W / 31); y = 0; }                    // topo
  else if (i < 71) { x = W - 60; y = (i - 51) * (H / 20); }               // direita, de cima para baixo
  else { x = (i - 71) * (W / 88); y = H - 60; }                           // mesa (71 esquerda ... 158 direita)
  layout.leds.push({ index: i, x, y, w, h, enabled: true });
}
const range = (a, b) => [[a, b]];
let groups = [
  { id: "monitor", name: "Monitor", leds: { ranges: range(0, 70) }, mode: { type: "source" } },
  { id: "mesa", name: "Mesa", leds: { ranges: range(71, 158) }, mode: { type: "solid", color: "#ff9f40", brightness: 1 } },
];
const warm = { type: "solid", color: "#ff9f40", brightness: 1 };
const G = (id, name, a, b, mode) => ({ id, name, leds: { ranges: range(a, b) }, mode });
let scenes = [
  { id: "trabalho", name: "Trabalho",
    groups: [G("monitor", "Monitor", 0, 70, { type: "source", brightness: 0.6 }), G("desk-left", "Mesa: esquerda", 71, 97, warm),
      G("desk-center", "Mesa: centro", 98, 131, { type: "source" }), G("desk-right", "Mesa: direita", 132, 158, warm)],
    triggers: { allow: ["claude", "chatgpt", "whatsapp", "sistema"], min_priority: 0, target_groups: ["desk-left", "desk-right"] } },
  { id: "midia", name: "Mídia",
    groups: [G("monitor", "Monitor", 0, 70, { type: "source" }), G("desk-left", "Mesa: esquerda", 71, 97, { type: "source" }),
      G("desk-center", "Mesa: centro", 98, 131, { type: "source" }), G("desk-right", "Mesa: direita", 132, 158, { type: "source" })],
    triggers: { allow: ["claude", "chatgpt", "whatsapp", "sistema"], min_priority: 90, target_groups: [] } },
  { id: "foco", name: "Foco",
    groups: [G("monitor", "Monitor", 0, 70, { type: "source" }), G("desk-left", "Mesa: esquerda", 71, 97, warm),
      G("desk-center", "Mesa: centro", 98, 131, { type: "source" }), G("desk-right", "Mesa: direita", 132, 158, warm)],
    triggers: { allow: ["claude", "chatgpt", "whatsapp", "sistema"], min_priority: 0, target_groups: ["desk-left", "desk-right"] } },
];
let overlays = [];                   // {id, effect, priority, started_at_ms, duration_ms, source, target, color}
const sockets = new Set();

function ledsOf(spec) {
  const out = new Set();
  if (!spec) return out;
  if (spec.all) { for (let i = 0; i < N; i++) out.add(i); return out; }
  for (const r of spec.ranges || []) for (let i = r[0]; i <= r[1]; i++) out.add(i);
  for (const i of spec.list || []) out.add(i);
  return out;
}
function targetLeds(t) {
  if (!t) return new Set();
  if (t.all) return ledsOf({ all: true });
  if (t.leds) return ledsOf(t.leds);
  const out = new Set();
  for (const id of t.groups || []) { const g = groups.find((x) => x.id === id); if (g) for (const i of ledsOf(g.leds)) out.add(i); }
  return out;
}
const hex = (c) => { const m = /^#([0-9a-f]{6})$/i.exec(c || ""); return m ? [0, 2, 4].map((k) => parseInt(m[1].substr(k, 2), 16)) : [255, 255, 255]; };

function frame() {
  const f = Buffer.alloc(N * 3);
  const t = Date.now() / 1000;
  const set = (i, c, k) => { f[i * 3] = c[0] * k; f[i * 3 + 1] = c[1] * k; f[i * 3 + 2] = c[2] * k; };
  if (!state.on) return f;
  const bright = state.brightness / 100;
  for (const g of groups) {
    const m = g.mode || { type: "source" };
    const k = (m.brightness ?? 1) * bright;
    for (const i of ledsOf(g.leds)) {
      if (m.type === "off") continue;
      if (m.type === "solid") set(i, hex(m.color), k);
      else if (m.type === "breathe") set(i, hex(m.color), k * (0.5 + 0.5 * Math.sin(t * 2)));
      else if (m.type === "rainbow") { const h = ((t / 4) + i / N) % 1; set(i, hsv(h), k); }
      else if (m.type === "gradient") { const s = (m.stops || [])[0]; set(i, hex(s && s.color), k); }
      else set(i, [Math.round(128 + 127 * Math.sin(t + i / 8)), Math.round(128 + 127 * Math.sin(t * 0.7 + i / 11)), 160], k);
    }
  }
  const now = Date.now();
  for (const o of overlays.slice().sort((a, b) => a.priority - b.priority)) {
    const blink = o.effect === "flash" ? (Math.floor((now - o.started_at_ms) / (o.period_ms / 2)) % 2 === 0) : true;
    if (!blink) continue;
    for (const i of targetLeds(o.target)) set(i, hex(o.color), 1);
  }
  return f;
}
function hsv(h) { const i = Math.floor(h * 6), f = h * 6 - i, q = 1 - f, r = [[1, f, 0], [q, 1, 0], [0, 1, f], [0, q, 1], [f, 0, 1], [1, 0, q]][i % 6]; return r.map((v) => v * 255); }

function wsSend(sock, obj) {
  const p = Buffer.from(JSON.stringify(obj));
  let head;
  if (p.length < 126) head = Buffer.from([0x81, p.length]);
  else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(p.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
  try { sock.write(Buffer.concat([head, p])); } catch (e) { /* closed */ }
}
const broadcast = (obj, ch) => { for (const s of sockets) if (s.authed && (!ch || s.subs.has(ch))) wsSend(s, obj); };
const event = (event, data) => broadcast({ type: "event", event, data }, "events");

const send = (res, code, body, type) => {
  res.writeHead(code, { "Content-Type": type || "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const err = (res, code, c, message) => send(res, code, { error: { code: c, message } });

function api(req, res, url, body) {
  if ((req.headers.authorization || "") !== "Bearer " + TOKEN) return err(res, 401, "unauthorized", "token");
  const parts = url.pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const m = req.method;
  const [what, a, b] = parts;
  if (what === "state") {
    if (m === "PATCH") {
      Object.assign(state, body);
      if (body.on !== undefined) event("status.changed", { on: state.on });
      if (body.profile) event("profile.changed", { profile: state.profile });
    }
    return send(res, 200, state);
  }
  if (what === "layout") return send(res, 200, layout);
  if (what === "profiles" && !a) return send(res, 200, { profiles, current: state.profile });
  if (what === "profiles" && b === "groups") {
    if (m === "PUT") {
      if (!Array.isArray(body)) return err(res, 400, "invalid_group", "esperava lista");
      const seen = new Set();
      for (const g of body) for (const i of ledsOf(g.leds)) { if (seen.has(i)) return err(res, 409, "led_conflict", "LED " + i); seen.add(i); }
      groups = body;
    }
    return send(res, 200, groups);
  }
  if (what === "overlays") {
    const now = Date.now();
    overlays = overlays.filter((o) => !o.duration_ms || o.started_at_ms + o.duration_ms > now);
    return send(res, 200, overlays.map((o) => ({ id: o.id, effect: o.effect, priority: o.priority, started_at_ms: o.started_at_ms, duration_ms: o.duration_ms, source: o.source })));
  }
  if (what === "trigger" && m === "POST") {
    if (!body || !body.id || !body.effect) return err(res, 400, "invalid_trigger", "faltam campos");
    const sc = scenes.find((s) => s.id === state.scene);
    if (sc) {
      const t = sc.triggers || {};
      const srcOk = !body.source || (t.allow || []).includes(body.source);
      if (!srcOk || (body.priority || 0) < (t.min_priority || 0)) return send(res, 202, { suppressed: true });
      if (!body.target) body.target = { groups: t.target_groups || [] };
    } else if (!body.target) body.target = { all: true };
    overlays = overlays.filter((o) => o.id !== body.id);
    overlays.push({ id: body.id, effect: body.effect.type, color: body.effect.color, period_ms: body.effect.period_ms || 700, priority: body.priority || 50,
      started_at_ms: Date.now(), duration_ms: body.duration_ms || 0, source: body.source || "", target: body.target });
    event("overlay.started", { id: body.id });
    return send(res, 200, { ok: true, id: body.id });
  }
  if (what === "trigger" && m === "DELETE") {
    const before = overlays.length;
    overlays = a === "*" ? [] : overlays.filter((o) => o.id !== a);
    if (overlays.length !== before) event("overlay.ended", { id: a });
    return send(res, 200, { ok: true });
  }
  if (what === "scenes" && !a) {
    if (m === "PUT") {
      if (!Array.isArray(body) || body.some((s) => !s.id || !s.name)) return err(res, 400, "invalid_scene", "modo invalido");
      scenes = body;
    }
    return send(res, 200, scenes);
  }
  if (what === "scenes" && b === "activate" && m === "POST") {
    const sc = scenes.find((s) => s.id === a);
    if (!sc) return err(res, 404, "scene_not_found", a);
    groups = JSON.parse(JSON.stringify(sc.groups));
    state.scene = sc.id;
    event("scene.changed", { scene: sc.id });
    return send(res, 200, { ok: true, scene: sc.id });
  }
  return err(res, 404, "not_found", url.pathname);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/v1")) {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (e) { return err(res, 400, "invalid_json", ""); }
      try { api(req, res, url, body); } catch (e) { err(res, 500, "internal", String(e)); }
    });
    return;
  }
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || file.startsWith(__dirname) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "nao achei", "text/plain");
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
});

server.on("upgrade", (req, sock) => {
  if (new URL(req.url, "http://x").pathname !== "/ws") return sock.destroy();
  const key = req.headers["sec-websocket-key"];
  sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
    crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64") + "\r\n\r\n");
  sock.authed = false; sock.subs = new Set();
  sockets.add(sock);
  let buf = Buffer.alloc(0);
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.slice(off, off + 4);
      const data = Buffer.from(buf.slice(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.slice(off + 4 + len);
      if (op === 8) { sock.end(); return; }
      if (op !== 1) continue;
      let m;
      try { m = JSON.parse(data.toString()); } catch (e) { continue; }
      if (m.type === "auth") {
        if (m.token === TOKEN) { sock.authed = true; wsSend(sock, { type: "auth_ok", state }); }
        else sock.end();
      } else if (m.type === "subscribe") for (const c of m.channels || []) sock.subs.add(c);
    }
  });
  sock.on("close", () => sockets.delete(sock));
  sock.on("error", () => sockets.delete(sock));
});

setInterval(() => { if (sockets.size) broadcast({ type: "frame", rgb: frame().toString("base64") }, "frame"); }, 100);
setInterval(() => broadcast({ type: "stats", fps: 10, serial_max_fps: 60 }, "stats"), 1000);

server.listen(PORT, "127.0.0.1", () => console.log("mock em http://127.0.0.1:" + PORT + "/#t=" + TOKEN));
