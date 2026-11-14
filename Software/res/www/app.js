/* Prismatik web panel: plain JS, no build, no CDN (served from the app's resources). */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const TOKEN_KEY = "prismatik.token";
  const safe = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };
  const session = {
    get: (k) => safe(() => sessionStorage.getItem(k), null),
    set: (k, v) => safe(() => sessionStorage.setItem(k, v)),
    del: (k) => safe(() => sessionStorage.removeItem(k)),
  };
  const local = {
    get: (k) => safe(() => localStorage.getItem(k), null),
    set: (k, v) => safe(() => localStorage.setItem(k, v)),
  };

  // ---------------------------------------------------------------------------
  // token: arrives in the URL fragment (#t=...), which the browser never sends to the server
  let TOKEN = "";
  function readToken() {
    const m = /(?:^#|&)t=([^&]+)/.exec(location.hash);
    if (m) {
      TOKEN = decodeURIComponent(m[1]);
      session.set(TOKEN_KEY, TOKEN);
      history.replaceState(null, "", location.pathname + location.search);
    } else {
      TOKEN = TOKEN || session.get(TOKEN_KEY) || "";
    }
  }

  // ---------------------------------------------------------------------------
  // small helpers
  let toastTimer = 0;
  function toast(msg, isError) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "show" + (isError ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ""; }, isError ? 6000 : 3000);
  }
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === "class") e.className = attrs[k];
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    }
    for (const kid of kids) if (kid !== null && kid !== undefined) e.append(kid.nodeType ? kid : String(kid));
    return e;
  }
  function svgEl(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const debounce = (fn, ms) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // sorted unique indices -> [[a,b],...]
  function toRanges(indices) {
    const s = [...new Set(indices)].sort((a, b) => a - b);
    const out = [];
    for (const i of s) {
      const last = out[out.length - 1];
      if (last && i === last[1] + 1) last[1] = i; else out.push([i, i]);
    }
    return out;
  }
  // human text, 1-based like the Prismatik window: "72–98, 132"
  function rangesText(indices, max) {
    const parts = toRanges(indices).map(([a, b]) => (a === b ? String(a + 1) : (a + 1) + "–" + (b + 1)));
    const lim = max || 6;
    return parts.length > lim ? parts.slice(0, lim).join(", ") + " …" : parts.join(", ");
  }

  // ---------------------------------------------------------------------------
  // API
  const ERR = {
    led_conflict: "Um LED não pode ficar em dois grupos ao mesmo tempo.",
    invalid_group: "Nome de grupo inválido.",
    id_exists: "Já existe um grupo com esse código.",
    invalid_leds: "Escolha de LEDs inválida.",
    invalid_mode: "Configuração do modo inválida.",
    profile_not_found: "Perfil não encontrado.",
    rate_limited: "Muitos efeitos de uma vez. Espere um segundo.",
    invalid_trigger: "Efeito inválido.",
    unknown_group: "Esse grupo ainda não existe na fita. Aplique as mudanças na aba Zonas primeiro.",
    invalid_value: "Valor inválido.",
    invalid_json: "Pedido inválido.",
  };
  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }
  async function api(method, path, body) {
    const opt = { method, cache: "no-store", headers: { Authorization: "Bearer " + TOKEN } };
    if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
    let r;
    try { r = await fetch("/api/v1" + path, opt); }
    catch (e) { throw new ApiError(0, "offline", "Sem conexão com o Prismatik. Ele está aberto?"); }
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (r.status === 401) {
      showLogin("A senha deste painel não vale mais (o Prismatik pode ter gerado outra). Abra de novo pelo Prismatik.");
      throw new ApiError(401, "unauthorized", "não autorizado");
    }
    if (!r.ok) {
      const e = (data && data.error) || {};
      const base = ERR[e.code] || "Algo deu errado (código " + r.status + ").";
      throw new ApiError(r.status, e.code || "http_" + r.status, base + (e.message ? " Detalhe: " + e.message : ""));
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // state
  const S = {
    state: null, layout: null, profiles: [],
    groups: [], saved: "[]", undo: [], open: null,
    sel: new Set(), last: null,
    overlays: [], frame: null,
    tab: "inicio", stages: {},
  };
  const PALETTE = ["#ff9f1c", "#2ec4b6", "#e71d36", "#a06cd5", "#3a86ff", "#8ac926", "#ff70a6", "#ffd60a", "#00b4d8", "#f15bb5"];
  const groupColor = (gi) => PALETTE[gi % PALETTE.length];
  const ledCount = () => (S.layout && S.layout.leds ? S.layout.leds.length : 0);

  // ---------------------------------------------------------------------------
  // screens
  function showLogin(why) {
    TOKEN = "";
    session.del(TOKEN_KEY);
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) { /* ignore */ } ws = null; }
    $("app").hidden = true;
    document.querySelector(".tabs").hidden = true;
    $("login").hidden = false;
    $("loginWhy").textContent = why || "";
    setConn(false);
  }
  function showApp() {
    $("login").hidden = true;
    $("app").hidden = false;
    document.querySelector(".tabs").hidden = false;
  }
  function setConn(on) {
    const d = $("conn");
    d.className = "dot " + (on ? "on" : "off");
    d.title = on ? "Conectado ao Prismatik" : "Sem conexão com o Prismatik";
    if (!on) $("fps").textContent = "desconectado";
  }
  function selectTab(name) {
    S.tab = name;
    local.set("prismatik.tab", name);
    for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
    for (const s of ["inicio", "zonas", "gatilhos"]) $("tab-" + s).hidden = s !== name;
    drawFrame();
    if (name === "gatilhos") renderOverlays();
  }

  // ---------------------------------------------------------------------------
  // basic mode
  let brightnessDragging = false;
  function applyState(st) {
    const prevProfile = S.state && S.state.profile;
    S.state = Object.assign(S.state || {}, st);
    $("on").checked = !!S.state.on;
    if (!brightnessDragging) {
      $("brightness").value = S.state.brightness;
      $("brightnessOut").textContent = S.state.brightness + "%";
    }
    renderProfiles();
    $("deviceInfo").textContent = [S.state.device, S.state.led_count ? S.state.led_count + " LEDs" : "", S.state.version ? "versão " + S.state.version : ""].filter(Boolean).join(" · ");
    $("groupsProfile").textContent = "“" + S.state.profile + "”";
    if (prevProfile && prevProfile !== S.state.profile) onProfileSwitchedSoon();
  }
  function renderProfiles() {
    const sel = $("profile");
    const names = S.profiles.length ? S.profiles : (S.state ? [S.state.profile] : []);
    if (sel.options.length !== names.length || [...sel.options].some((o, i) => o.value !== names[i])) {
      sel.textContent = "";
      for (const n of names) sel.append(el("option", { value: n }, n));
    }
    if (S.state) sel.value = S.state.profile;
  }
  async function onProfileSwitched() {
    try {
      S.layout = await api("GET", "/layout");
      buildStages();
    } catch (e) { /* shown elsewhere */ }
    if (S.state.profile === S.groupsProfile && isDirty()) return; // same profile re-announced: keep the draft
    if (isDirty()) {
      toast("O perfil mudou. Suas mudanças de zonas não aplicadas foram descartadas.", true);
    }
    S.sel.clear();
    await loadGroups();
  }
  // the switch happens in the app a moment after the request: wait before reading layout/groups
  const onProfileSwitchedSoon = debounce(onProfileSwitched, 500);
  const sendBrightness = debounce(async (v) => {
    try { await api("PATCH", "/state", { brightness: v }); } catch (e) { toast(e.message, true); }
    brightnessDragging = false;
  }, 150);

  const QUICK = {
    whats: { id: "painel-whats", target: { all: true }, effect: { type: "pulse", color: "#25d366", period_ms: 700, count: 3 }, priority: 70 },
    pulse: { id: "painel-pulso", target: { all: true }, effect: { type: "pulse", color: "#ff6a00", period_ms: 900, count: 3 }, priority: 70 },
    wave: { id: "painel-onda", target: { all: true }, effect: { type: "wave", color: "#2a7bff", period_ms: 1500, width: 0.3 }, duration_ms: 4500, priority: 70 },
    rainbow: { id: "painel-arcoiris", target: { all: true }, effect: { type: "rainbow", period_ms: 3000 }, duration_ms: 5000, priority: 70 },
  };
  async function trigger(t) {
    try { await api("POST", "/trigger", t); }
    catch (e) { toast(e.message, true); }
  }
  async function stopOverlay(id) {
    try { await api("DELETE", "/trigger/" + encodeURIComponent(id)); }
    catch (e) { toast(e.message, true); }
    setTimeout(loadOverlays, 400);
  }

  // ---------------------------------------------------------------------------
  // LED drawing (monitor + desk, positions from /layout)
  function computeGeometry() {
    const L = S.layout;
    const leds = (L && L.leds) || [];
    if (!leds.length) return null;
    const c = leds.map((l) => ({ i: l.index, x: l.x + l.w / 2, y: l.y + l.h / 2, enabled: l.enabled !== false }));
    // the screen holding most zones; else the bounding box of the zones
    let scr = null, best = 0;
    for (const s of (L.screens || [])) {
      const n = c.filter((p) => p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h).length;
      if (n > best) { best = n; scr = s; }
    }
    if (!scr) {
      const xs = leds.map((l) => l.x), ys = leds.map((l) => l.y);
      const x0 = Math.min(...xs), y0 = Math.min(...ys);
      const x1 = Math.max(...leds.map((l) => l.x + l.w)), y1 = Math.max(...leds.map((l) => l.y + l.h));
      scr = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
    }
    // nearest edge, then majority over neighbours in strip order (fixes corner zones)
    const raw = c.map((p) => {
      const d = { l: p.x - scr.x, r: scr.x + scr.w - p.x, t: p.y - scr.y, b: scr.y + scr.h - p.y };
      return Object.keys(d).reduce((a, k) => (d[k] < d[a] ? k : a), "l");
    });
    const side = raw.map((s, i) => {
      const votes = {};
      for (let k = -2; k <= 2; k++) { const v = raw[i + k]; if (v) votes[v] = (votes[v] || 0) + 1; }
      return Object.keys(votes).reduce((a, k) => (votes[k] > votes[a] ? k : a), s);
    });
    const counts = { l: 0, r: 0, t: 0, b: 0 };
    side.forEach((s) => counts[s]++);
    const len = { l: scr.h, r: scr.h, t: scr.w, b: scr.w };
    // dot size per side: as big as the spacing on that side allows
    const rMax = Math.min(scr.w, scr.h) / 40;
    const rSide = {};
    for (const k in counts) rSide[k] = counts[k] >= 2 ? clamp((len[k] / counts[k]) * 0.42, 4, rMax) : rMax;
    const r = Math.max(rSide.l, rSide.r, rSide.t, rSide.b);
    const gap = r * 2.5;
    const deskTop = scr.y + scr.h + scr.h * 0.16;
    const deskH = Math.max(scr.h * 0.12, r * 5);
    const desk = { x: scr.x - scr.w * 0.06, y: deskTop, w: scr.w * 1.12, h: deskH };
    const pos = [];
    c.forEach((p, k) => {
      const x = clamp(p.x, scr.x, scr.x + scr.w), y = clamp(p.y, scr.y, scr.y + scr.h);
      let q;
      switch (side[k]) {
        case "l": q = { x: scr.x - gap, y }; break;
        case "r": q = { x: scr.x + scr.w + gap, y }; break;
        case "t": q = { x, y: scr.y - gap }; break;
        default: q = { x, y: deskTop + deskH * 0.45 };
      }
      const rr = rSide[side[k]];
      pos[p.i] = { x: q.x, y: q.y, r: rr, enabled: p.enabled, hit: Math.max(rr, (len[side[k]] / Math.max(1, counts[side[k]])) * 0.5) };
    });
    const pad = r * 4;
    const vb = {
      x: Math.min(desk.x, scr.x - gap - r) - pad,
      y: scr.y - gap - r - pad,
    };
    vb.w = Math.max(desk.x + desk.w, scr.x + scr.w + gap + r) + pad - vb.x;
    vb.h = desk.y + desk.h + pad - vb.y;
    return { scr, desk, pos, r, vb };
  }

  function buildStage(container, editable) {
    container.textContent = "";
    const g = computeGeometry();
    if (!g) { container.append(el("p", { class: "empty" }, "Nenhum LED configurado neste perfil.")); return null; }
    const { scr, desk, pos, r, vb } = g;
    const svg = svgEl("svg", { viewBox: [vb.x, vb.y, vb.w, vb.h].map((v) => v.toFixed(1)).join(" "), role: "img",
      "aria-label": "Desenho do monitor e da mesa com os LEDs" });
    const fs = (scr.h * 0.05).toFixed(1);
    svg.append(svgEl("rect", { class: "desk", x: desk.x, y: desk.y, width: desk.w, height: desk.h, rx: desk.h * 0.15 }));
    svg.append(svgEl("rect", { class: "monitor", x: scr.x + scr.w * 0.46, y: scr.y + scr.h, width: scr.w * 0.08, height: desk.y - scr.y - scr.h }));
    svg.append(svgEl("rect", { class: "monitor", x: scr.x, y: scr.y, width: scr.w, height: scr.h, rx: r }));
    const t1 = svgEl("text", { class: "label", x: scr.x + scr.w / 2, y: scr.y + scr.h / 2, "text-anchor": "middle", "font-size": fs });
    t1.textContent = "Monitor";
    const t2 = svgEl("text", { class: "label", x: desk.x + desk.w / 2, y: desk.y + desk.h * 0.92, "text-anchor": "middle", "font-size": (fs * 0.7).toFixed(1) });
    t2.textContent = "Mesa";
    svg.append(t1, t2);
    const els = [];
    const ledLayer = svgEl("g", {});
    pos.forEach((p, i) => {
      if (!p) return;
      if (editable) ledLayer.append(svgEl("circle", { cx: p.x, cy: p.y, r: p.hit, fill: "transparent", "data-i": i }));
      const c = svgEl("circle", { class: "led" + (p.enabled ? "" : " off"), cx: p.x, cy: p.y, r: p.r, fill: "#000", "data-i": i });
      const title = svgEl("title", {});
      title.textContent = "LED " + (i + 1);
      c.append(title);
      ledLayer.append(c);
      els[i] = c;
    });
    svg.append(ledLayer);
    const band = svgEl("rect", { class: "band", x: 0, y: 0, width: 0, height: 0, visibility: "hidden" });
    svg.append(band);
    container.append(svg);
    const stage = { svg, els, pos, r, band };
    if (editable) wireEditor(stage);
    return stage;
  }
  function buildStages() {
    S.stages.preview = buildStage($("previewStage"), false);
    S.stages.editor = buildStage($("editorStage"), true);
    paintEditor();
    drawFrame();
  }

  let rafPending = false;
  function onFrame(b64) {
    const bin = atob(b64);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    S.frame = a;
    if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; drawFrame(); }); }
  }
  function drawFrame() {
    const stage = S.tab === "inicio" ? S.stages.preview : S.tab === "zonas" ? S.stages.editor : null;
    if (!stage || !S.frame || document.hidden) return;
    const f = S.frame;
    for (let i = 0; i < stage.els.length; i++) {
      const c = stage.els[i];
      if (!c) continue;
      c.setAttribute("fill", i * 3 + 2 < f.length ? "rgb(" + f[i * 3] + "," + f[i * 3 + 1] + "," + f[i * 3 + 2] + ")" : "#000");
    }
  }

  // ---------------------------------------------------------------------------
  // zone editor: selection
  function svgPoint(svg, ev) {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  function wireEditor(stage) {
    const { svg, band, pos } = stage;
    let drag = null;
    svg.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      const t = ev.target.closest("[data-i]");
      const p = svgPoint(svg, ev);
      drag = { x0: p.x, y0: p.y, sx: ev.clientX, sy: ev.clientY, idx: t ? +t.dataset.i : null, moved: false,
        add: ev.ctrlKey || ev.metaKey || $("addMode").checked, shift: ev.shiftKey, base: new Set(S.sel) };
      try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      ev.preventDefault();
    });
    svg.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 6) return;
      drag.moved = true;
      const p = svgPoint(svg, ev);
      const x = Math.min(drag.x0, p.x), y = Math.min(drag.y0, p.y), w = Math.abs(p.x - drag.x0), h = Math.abs(p.y - drag.y0);
      band.setAttribute("x", x); band.setAttribute("y", y); band.setAttribute("width", w); band.setAttribute("height", h);
      band.setAttribute("visibility", "visible");
      const inside = new Set(drag.add || drag.shift ? drag.base : []);
      pos.forEach((q, i) => { if (q && q.x >= x && q.x <= x + w && q.y >= y && q.y <= y + h) inside.add(i); });
      S.sel = inside;
      paintEditor();
    });
    const finish = (ev, cancelled) => {
      if (!drag) return;
      band.setAttribute("visibility", "hidden");
      if (!drag.moved && !cancelled) {
        const i = drag.idx;
        if (i === null) {
          if (!drag.add && !drag.shift) S.sel.clear();
        } else if (drag.shift && S.last !== null && S.last !== undefined) {
          const a = Math.min(S.last, i), b = Math.max(S.last, i);
          for (let k = a; k <= b; k++) S.sel.add(k);
          S.last = i;
        } else if (drag.add) {
          if (S.sel.has(i)) S.sel.delete(i); else S.sel.add(i);
          S.last = i;
        } else {
          S.sel = new Set([i]);
          S.last = i;
        }
      }
      drag = null;
      paintEditor();
    };
    svg.addEventListener("pointerup", (ev) => finish(ev, false));
    svg.addEventListener("pointercancel", (ev) => finish(ev, true));
    svg.addEventListener("dblclick", (ev) => {
      const t = ev.target.closest("[data-i]");
      if (!t) return;
      const gi = ownerOf(+t.dataset.i);
      if (gi < 0) return;
      selectGroup(gi, ev.ctrlKey || ev.metaKey || $("addMode").checked);
    });
  }
  function selectGroup(gi, add) {
    if (!add) S.sel.clear();
    for (const i of groupIndices(S.groups[gi])) S.sel.add(i);
    paintEditor();
  }
  let ownerCache = null;
  function owners() {
    if (ownerCache) return ownerCache;
    const n = ledCount();
    ownerCache = new Array(n).fill(-1);
    S.groups.forEach((g, gi) => { for (const i of groupIndices(g)) if (i >= 0 && i < n) ownerCache[i] = gi; });
    return ownerCache;
  }
  const ownerOf = (i) => owners()[i] ?? -1;

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function paintEditor() {
    const stage = S.stages.editor;
    updateSelInfo();
    if (!stage) return;
    const accent = cssVar("--accent") || "#2a6cf0";
    const line = cssVar("--line") || "#888";
    const own = owners();
    stage.els.forEach((c, i) => {
      if (!c) return;
      const r = stage.pos[i].r;
      if (S.sel.has(i)) { c.setAttribute("stroke", accent); c.setAttribute("stroke-width", r * 0.8); }
      else if (own[i] >= 0) { c.setAttribute("stroke", groupColor(own[i])); c.setAttribute("stroke-width", r * 0.5); }
      else { c.setAttribute("stroke", line); c.setAttribute("stroke-width", r * 0.25); }
    });
  }
  function updateSelInfo() {
    const n = S.sel.size;
    $("selInfo").textContent = n ? n + (n === 1 ? " LED escolhido: " : " LEDs escolhidos: ") + rangesText([...S.sel]) : "Nenhum LED escolhido.";
    $("newGroup").disabled = !n;
  }

  // ---------------------------------------------------------------------------
  // groups (draft edited locally, applied with "Aplicar na fita")
  function groupIndices(g) {
    const leds = (g && g.leds) || {};
    const n = ledCount();
    const out = [];
    if (leds.all) { for (let i = 0; i < n; i++) out.push(i); return out; }
    for (const r of leds.ranges || []) if (Array.isArray(r) && r.length === 2) for (let i = r[0]; i <= r[1]; i++) out.push(i);
    for (const i of leds.list || []) out.push(i);
    return out;
  }
  function setGroupIndices(g, indices) { g.leds = { ranges: toRanges(indices) }; }
  const nameOf = (g) => g.name || g.id;
  function slug(s) {
    const base = String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 34);
    return base || "grupo";
  }
  function uniqueId(base) {
    const ids = new Set(S.groups.map((g) => g.id));
    if (!ids.has(base)) return base;
    for (let k = 2; ; k++) if (!ids.has(base + "-" + k)) return base + "-" + k;
  }
  function nextName() {
    const names = new Set(S.groups.map(nameOf));
    for (let k = S.groups.length + 1; ; k++) if (!names.has("Grupo " + k)) return "Grupo " + k;
  }
  // removes the LEDs from every group except `keep`; empty groups disappear
  function takeFromOthers(indices, keep) {
    const take = new Set(indices);
    const notes = [];
    S.groups = S.groups.filter((g) => {
      if (g === keep) return true;
      const before = groupIndices(g);
      const after = before.filter((i) => !take.has(i));
      if (after.length === before.length) return true;
      if (!after.length) { notes.push("o grupo “" + nameOf(g) + "” ficou vazio e foi removido"); return false; }
      setGroupIndices(g, after);
      notes.push((before.length - after.length) + " LED(s) saíram de “" + nameOf(g) + "”");
      return true;
    });
    return notes;
  }
  const isDirty = () => JSON.stringify(S.groups) !== S.saved;
  function mutate(fn) {
    S.undo.push(JSON.stringify(S.groups));
    if (S.undo.length > 60) S.undo.shift();
    const notes = fn() || [];
    afterChange();
    if (notes.length) toast("Atenção: " + notes.join("; ") + ".");
  }
  function afterChange() {
    ownerCache = null;
    renderGroups();
    paintEditor();
    updateSaveBar();
    renderTargetOptions();
  }
  function updateSaveBar() {
    const dirty = isDirty();
    $("savebar").hidden = !dirty && !S.undo.length;
    $("saveMsg").textContent = dirty ? "Há mudanças ainda não aplicadas na fita." : "Tudo aplicado.";
    $("save").disabled = !dirty;
    $("discard").disabled = !dirty;
    $("undo").disabled = !S.undo.length;
  }
  async function loadGroups() {
    if (!S.state) return;
    try {
      const g = await api("GET", "/profiles/" + encodeURIComponent(S.state.profile) + "/groups");
      S.groups = Array.isArray(g) ? g : [];
      S.groupsProfile = S.state.profile;
      S.saved = JSON.stringify(S.groups);
      S.undo = [];
      afterChange();
    } catch (e) { if (e.status !== 401) toast(e.message, true); }
  }
  async function saveGroups() {
    for (const g of S.groups) if (!groupIndices(g).length) { toast("O grupo “" + nameOf(g) + "” está sem LEDs. Escolha LEDs para ele ou apague.", true); return; }
    $("save").disabled = true;
    try {
      const res = await api("PUT", "/profiles/" + encodeURIComponent(S.groupsProfile || S.state.profile) + "/groups", S.groups);
      S.groups = Array.isArray(res) ? res : S.groups;
      S.saved = JSON.stringify(S.groups);
      afterChange();
      toast("Pronto! As mudanças já estão na fita.");
    } catch (e) {
      toast(e.message, true);
      updateSaveBar();
    }
  }

  const MODES = [
    ["source", "Seguir a tela", "Copia as cores da tela que ficam perto desses LEDs."],
    ["solid", "Cor fixa", "Uma cor só, parada. Bom para luz de ambiente na mesa."],
    ["gradient", "Degradê", "Passa de uma cor para outra ao longo do grupo."],
    ["breathe", "Respirar (efeito)", "Acende e apaga devagar, como uma respiração."],
    ["rainbow", "Arco-íris (efeito)", "As cores do arco-íris andando pela fita."],
    ["off", "Apagado", "Esses LEDs ficam desligados."],
  ];
  const modeLabel = (t) => { const m = MODES.find((x) => x[0] === (t === "screen" ? "source" : t)); return m ? m[1] : t; };
  function defaultMode(type, old, gi) {
    const color = (old && old.color) || groupColor(gi);
    switch (type) {
      case "solid": return { type, color, brightness: 1 };
      case "gradient": return { type, brightness: 1, stops: [{ at: 0, color: "#ff6a00" }, { at: 1, color: "#7a00ff" }] };
      case "breathe": return { type, color, period_ms: 4000, min: 0.1, brightness: 1 };
      case "rainbow": return { type, period_ms: 8000, brightness: 1 };
      default: return { type };
    }
  }

  function slider(label, value, min, max, step, fmt, onCommit, hint) {
    const out = el("output", {}, fmt(value));
    const input = el("input", { type: "range", min, max, step, value });
    input.addEventListener("input", () => { out.textContent = fmt(+input.value); });
    input.addEventListener("change", () => onCommit(+input.value));
    return el("label", { class: "field" }, el("span", {}, el("b", {}, label), " ", out), input, hint ? el("small", { class: "muted" }, hint) : null);
  }
  function colorField(label, value, onCommit) {
    const input = el("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(value || "") ? value : "#ffffff" });
    input.addEventListener("change", () => onCommit(input.value));
    return el("label", { class: "field" }, el("span", {}, el("b", {}, label)), input);
  }
  const pct = (v) => Math.round(v) + "%";
  const secs = (v) => (v / 1000).toFixed(1).replace(".", ",") + " s";

  function modeParams(g, gi) {
    const m = g.mode || { type: "source" };
    const set = (patch) => mutate(() => { g.mode = Object.assign({}, g.mode, patch); });
    const box = el("div", { class: "grid" });
    const bright = () => slider("Brilho do grupo", Math.round((m.brightness ?? 1) * 100), 0, 100, 1, pct, (v) => set({ brightness: v / 100 }));
    switch (m.type) {
      case "solid":
        box.append(colorField("Cor", m.color, (v) => set({ color: v })), bright());
        break;
      case "gradient": {
        const stops = (m.stops && m.stops.length >= 2) ? m.stops : [{ at: 0, color: "#ff6a00" }, { at: 1, color: "#7a00ff" }];
        const row = el("div", { class: "stops" });
        const commit = (colors) => set({ stops: colors.map((c, k) => ({ at: +(k / (colors.length - 1)).toFixed(3), color: c })) });
        const colors = stops.map((s) => s.color);
        colors.forEach((c, k) => {
          const input = el("input", { type: "color", value: c, title: k === 0 ? "Começo" : k === colors.length - 1 ? "Fim" : "Meio" });
          input.addEventListener("change", () => { const next = colors.slice(); next[k] = input.value; commit(next); });
          row.append(input);
        });
        if (colors.length < 5) row.append(el("button", { type: "button", onclick: () => { const next = colors.slice(); next.splice(next.length - 1, 0, "#ffffff"); commit(next); } }, "+ cor"));
        if (colors.length > 2) row.append(el("button", { type: "button", onclick: () => { const next = colors.slice(); next.splice(next.length - 2, 1); commit(next); } }, "− cor"));
        box.append(el("div", { class: "field" }, el("span", {}, el("b", {}, "Cores (do começo ao fim do grupo)")), row,
          el("small", { class: "muted" }, "O começo é o LED de número menor.")), bright());
        break;
      }
      case "breathe":
        box.append(colorField("Cor", m.color, (v) => set({ color: v })),
          slider("Velocidade (um ciclo)", m.period_ms || 4000, 1000, 15000, 250, secs, (v) => set({ period_ms: v }), "Menor = mais rápido."),
          slider("Brilho mínimo", Math.round((m.min ?? 0.1) * 100), 0, 90, 1, pct, (v) => set({ min: v / 100 })),
          bright());
        break;
      case "rainbow":
        box.append(slider("Velocidade (uma volta)", m.period_ms || 8000, 1000, 60000, 500, secs, (v) => set({ period_ms: v }), "Menor = mais rápido."), bright());
        break;
      default:
        break;
    }
    return box;
  }

  function renderGroups() {
    const box = $("groups");
    box.textContent = "";
    if (!S.groups.length) {
      box.append(el("p", { class: "empty" }, "Nenhum grupo ainda. Escolha LEDs no desenho e clique em “Criar grupo com os escolhidos”."));
      return;
    }
    S.groups.forEach((g, gi) => {
      const idx = groupIndices(g);
      const open = S.open === g.id;
      const head = el("header", { onclick: () => { S.open = open ? null : g.id; renderGroups(); } },
        el("span", { class: "chip", style: "background:" + groupColor(gi) }),
        el("span", { class: "name" }, nameOf(g)),
        el("span", { class: "meta" }, idx.length + " LEDs · " + (idx.length ? rangesText(idx, 4) : "sem LEDs") + " · " + modeLabel((g.mode || {}).type)),
        el("span", { class: "spacer" }),
        el("span", { class: "muted small" }, open ? "▲ fechar" : "▼ editar"));
      const card = el("div", { class: "group" }, head);
      if (open) {
        const nameInput = el("input", { type: "text", value: nameOf(g), maxlength: 60 });
        nameInput.addEventListener("change", () => {
          const v = nameInput.value.trim();
          if (!v) { nameInput.value = nameOf(g); return; }
          mutate(() => { g.name = v; });
        });
        const modeSel = el("select", {});
        for (const [v, label] of MODES) modeSel.append(el("option", { value: v }, label));
        const t = (g.mode || {}).type || "source";
        modeSel.value = t === "screen" ? "source" : t;
        modeSel.addEventListener("change", () => mutate(() => { g.mode = defaultMode(modeSel.value, g.mode, gi); }));
        const hint = (MODES.find((x) => x[0] === modeSel.value) || [])[2] || "";
        const hasSel = S.sel.size > 0;
        const body = el("div", { class: "body" },
          el("div", { class: "grid" },
            el("label", { class: "field" }, el("span", {}, el("b", {}, "Nome")), nameInput,
              el("small", { class: "muted" }, "Código usado pelos gatilhos: ", el("code", {}, g.id))),
            el("label", { class: "field" }, el("span", {}, el("b", {}, "Como acende")), modeSel, el("small", { class: "muted" }, hint))),
          modeParams(g, gi),
          el("div", { class: "actions" },
            el("button", { type: "button", onclick: () => selectGroup(gi, false) }, "Mostrar os LEDs dele"),
            el("button", { type: "button", disabled: !hasSel, title: "Os LEDs escolhidos passam a ser os deste grupo",
              onclick: () => mutate(() => { const sel = [...S.sel]; const notes = takeFromOthers(sel, g); setGroupIndices(g, sel); return notes; }) }, "Trocar pelos escolhidos"),
            el("button", { type: "button", disabled: !hasSel,
              onclick: () => mutate(() => { const sel = [...S.sel]; const notes = takeFromOthers(sel, g); setGroupIndices(g, groupIndices(g).concat(sel)); return notes; }) }, "Somar os escolhidos"),
            el("button", { type: "button", disabled: !hasSel,
              onclick: () => mutate(() => { setGroupIndices(g, groupIndices(g).filter((i) => !S.sel.has(i))); }) }, "Tirar os escolhidos"),
            el("button", { type: "button", title: "Pisca esses LEDs em branco para você achar na fita",
              onclick: () => idx.length && trigger({ id: "painel-achar", target: { leds: { ranges: toRanges(idx) } }, effect: { type: "flash", color: "#ffffff", period_ms: 400, count: 3 }, priority: 90, blend: "override" }) }, "Piscar na fita"),
            el("span", { class: "spacer" }),
            el("button", { type: "button", class: "danger",
              onclick: () => { if (confirm("Apagar o grupo “" + nameOf(g) + "”? Os LEDs dele voltam a seguir o modo do perfil.")) mutate(() => { S.groups.splice(gi, 1); }); } }, "Apagar grupo")));
        card.append(body);
      }
      box.append(card);
    });
  }

  function createGroupFromSelection() {
    if (!S.sel.size) { toast("Escolha alguns LEDs no desenho primeiro.", true); return; }
    let newId = null;
    mutate(() => {
      const sel = [...S.sel];
      const notes = takeFromOthers(sel, null);
      const name = nextName();
      newId = uniqueId(slug(name));
      const gi = S.groups.length;
      const g = { id: newId, name, leds: { ranges: toRanges(sel) }, mode: defaultMode("solid", null, gi) };
      S.groups.push(g);
      S.open = newId;
      return notes;
    });
    toast("Grupo criado. Dê um nome, escolha a cor e clique em “Aplicar na fita”.");
    const input = document.querySelector("#groups .group .body input[type=text]");
    if (input) { input.focus(); input.select(); }
  }

  // ---------------------------------------------------------------------------
  // triggers
  async function loadOverlays() {
    try {
      const o = await api("GET", "/overlays");
      S.overlays = Array.isArray(o) ? o : [];
    } catch (e) { S.overlays = []; }
    renderOverlays();
  }
  const loadOverlaysSoon = debounce(loadOverlays, 250);
  const EFFECT_PT = { pulse: "pulsar", flash: "piscar", wave: "onda", breathe: "respirar", rainbow: "arco-íris", solid: "cor fixa", gradient: "degradê" };
  function renderOverlays() {
    const box = $("overlays");
    box.textContent = "";
    if (!S.overlays.length) { box.append(el("p", { class: "empty" }, "Nenhum efeito tocando agora.")); $("stopAll").disabled = true; return; }
    $("stopAll").disabled = false;
    const now = Date.now();
    for (const o of S.overlays) {
      let when = "até alguém parar";
      if (o.removing) when = "terminando…";
      else if (o.duration_ms > 0) when = "termina em " + Math.max(0, Math.ceil((o.started_at_ms + o.duration_ms - now) / 1000)) + " s";
      box.append(el("div", { class: "ov" },
        el("b", {}, o.id),
        el("span", {}, EFFECT_PT[o.effect] || o.effect || ""),
        el("span", { class: "muted small" }, "prioridade " + o.priority + " · " + when),
        el("span", { class: "spacer" }),
        el("button", { type: "button", onclick: () => stopOverlay(o.id) }, "Parar")));
    }
  }
  function renderTargetOptions() {
    const sel = $("tTarget");
    const keep = sel.value;
    while (sel.options.length > 2) sel.remove(2);
    for (const g of JSON.parse(S.saved)) sel.append(el("option", { value: "g:" + g.id }, "Grupo: " + nameOf(g)));
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
  function buildTrigger() {
    const type = $("tType").value;
    const t = { id: $("tId").value.trim() || "teste-painel", effect: { type }, priority: +$("tPrio").value, blend: $("tBlend").value };
    const target = $("tTarget").value;
    if (target === "all") t.target = { all: true };
    else if (target === "sel") t.target = { leds: { ranges: toRanges([...S.sel]) } };
    else t.target = { groups: [target.slice(2)] };
    if (type !== "rainbow") t.effect.color = $("tColor").value;
    if (type !== "solid") t.effect.period_ms = +$("tPeriod").value;
    if (type === "pulse" || type === "flash") t.effect.count = clamp(Math.round(+$("tCount").value || 0), 0, 100);
    if (type === "wave") t.effect.width = 0.3;
    const dur = Math.round(+$("tDur").value || 0);
    if (dur > 0) t.duration_ms = dur * 1000;
    return t;
  }
  function updateTriggerForm() {
    const type = $("tType").value;
    document.querySelector('[data-for="color"]').hidden = type === "rainbow";
    document.querySelector('[data-for="count"]').hidden = !(type === "pulse" || type === "flash");
    $("tPeriodOut").textContent = secs(+$("tPeriod").value);
    $("tPrioOut").textContent = $("tPrio").value;
    const json = JSON.stringify(buildTrigger());
    const url = location.origin + "/api/v1/trigger";
    $("tCmd").textContent =
      "# PowerShell\n$t = 'SEU_TOKEN'\nInvoke-RestMethod -Method Post -Uri " + url +
      " -Headers @{ Authorization = \"Bearer $t\" } -ContentType 'application/json' -Body '" + json.replace(/'/g, "''") + "'\n\n" +
      "# curl\ncurl -X POST " + url + " -H \"Authorization: Bearer SEU_TOKEN\" -H \"Content-Type: application/json\" -d '" + json.replace(/'/g, "'\\''") + "'";
  }

  // ---------------------------------------------------------------------------
  // WebSocket: live frames, stats and events
  let ws = null, wsTimer = 0, wsBackoff = 1000, wsWasDown = false;
  function connectWs() {
    clearTimeout(wsTimer);
    if (!TOKEN) return;
    try { ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws"); }
    catch (e) { scheduleWs(); return; }
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      switch (m.type) {
        case "auth_ok":
          wsBackoff = 1000;
          setConn(true);
          ws.send(JSON.stringify({ type: "subscribe", channels: ["frame", "stats", "events"] }));
          if (m.state) applyState(m.state);
          if (wsWasDown) { wsWasDown = false; refreshAll(); }
          break;
        case "frame": onFrame(m.rgb); break;
        case "stats": {
          const fps = Math.round(m.fps || 0), max = Math.round(m.serial_max_fps || 0);
          $("fps").textContent = fps + (max ? " / " + max : "") + " quadros/s";
          $("fps").title = "Quadros por segundo indo para a fita" + (max ? " (máximo do cabo: " + max + ")" : "");
          break;
        }
        case "event": onEvent(m.event, m.data || {}); break;
        case "error": toast(ERR[m.code] || m.message || "Erro", true); break;
        default: break;
      }
    };
    ws.onclose = (ev) => {
      setConn(false);
      ws = null;
      if (ev.code === 1008 && /unauthorized/.test(ev.reason || "")) {
        showLogin("A senha deste painel não vale mais. Abra de novo pelo Prismatik.");
        return;
      }
      wsWasDown = true;
      scheduleWs();
    };
  }
  function scheduleWs() {
    clearTimeout(wsTimer);
    wsTimer = setTimeout(connectWs, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 2, 15000);
  }
  function onEvent(name, data) {
    if (name === "overlay.started" || name === "overlay.ended") loadOverlaysSoon();
    else if (name === "status.changed") applyState({ on: !!data.on });
    else if (name === "profile.changed" && data.profile) { applyState({ profile: data.profile }); onProfileSwitchedSoon(); }
  }

  // ---------------------------------------------------------------------------
  // start
  async function refreshAll() {
    const [state, layout, profiles] = await Promise.all([api("GET", "/state"), api("GET", "/layout"), api("GET", "/profiles")]);
    S.profiles = (profiles && profiles.profiles) || [];
    S.layout = layout;
    S.state = null;
    applyState(state);
    buildStages();
    await loadGroups();
    await loadOverlays();
  }
  let bootTimer = 0;
  async function boot() {
    clearTimeout(bootTimer);
    readToken();
    if (!TOKEN) { showLogin(""); return; }
    showApp();
    try {
      await refreshAll();
      connectWs();
    } catch (e) {
      if (e.status === 401) return;
      setConn(false);
      toast(e.message + " Tentando de novo…", true);
      bootTimer = setTimeout(boot, 3000);
    }
  }

  function wireUi() {
    for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => selectTab(b.dataset.tab));
    $("theme").addEventListener("click", () => {
      const dark = document.documentElement.dataset.theme
        ? document.documentElement.dataset.theme === "dark"
        : matchMedia("(prefers-color-scheme: dark)").matches;
      const next = dark ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      local.set("prismatik.theme", next);
      paintEditor();
    });
    $("on").addEventListener("change", async () => {
      try { await api("PATCH", "/state", { on: $("on").checked }); }
      catch (e) { toast(e.message, true); $("on").checked = !$("on").checked; }
    });
    $("brightness").addEventListener("input", () => {
      brightnessDragging = true;
      $("brightnessOut").textContent = $("brightness").value + "%";
      sendBrightness(+$("brightness").value);
    });
    $("profile").addEventListener("change", async () => {
      const p = $("profile").value;
      if (isDirty() && !confirm("Há mudanças de zonas não aplicadas. Trocar de perfil vai descartá-las. Continuar?")) {
        $("profile").value = S.state.profile;
        return;
      }
      try { await api("PATCH", "/state", { profile: p }); applyState({ profile: p }); }
      catch (e) { toast(e.message, true); $("profile").value = S.state.profile; }
    });
    for (const b of document.querySelectorAll("[data-quick]")) {
      b.addEventListener("click", () => {
        if (b.dataset.quick === "stop") stopOverlay("*");
        else trigger(QUICK[b.dataset.quick]);
      });
    }
    $("selAll").addEventListener("click", () => { S.sel = new Set([...Array(ledCount()).keys()]); paintEditor(); });
    $("selFree").addEventListener("click", () => { const own = owners(); S.sel = new Set(own.map((o, i) => (o < 0 ? i : -1)).filter((i) => i >= 0)); paintEditor(); });
    $("selClear").addEventListener("click", () => { S.sel.clear(); paintEditor(); });
    $("newGroup").addEventListener("click", createGroupFromSelection);
    $("save").addEventListener("click", saveGroups);
    $("undo").addEventListener("click", undo);
    $("discard").addEventListener("click", () => {
      if (!isDirty()) return;
      S.undo.push(JSON.stringify(S.groups));
      S.groups = JSON.parse(S.saved);
      afterChange();
      toast("Mudanças descartadas. Use Desfazer se foi sem querer.");
    });
    document.addEventListener("keydown", (ev) => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((ev.target && ev.target.tagName) || "");
      if (S.tab !== "zonas" || typing) return;
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") { ev.preventDefault(); undo(); }
      else if (ev.key === "Escape") { S.sel.clear(); paintEditor(); }
    });
    $("stopAll").addEventListener("click", () => stopOverlay("*"));
    $("trigForm").addEventListener("submit", (ev) => {
      ev.preventDefault();
      if ($("tTarget").value === "sel" && !S.sel.size) { toast("Escolha LEDs na aba Zonas primeiro.", true); return; }
      trigger(buildTrigger());
      setTimeout(loadOverlays, 300);
    });
    $("trigForm").addEventListener("input", updateTriggerForm);
    $("trigForm").addEventListener("change", updateTriggerForm);
    window.addEventListener("beforeunload", (ev) => { if (isDirty()) { ev.preventDefault(); ev.returnValue = ""; } });
    window.addEventListener("hashchange", () => { if (/(?:^#|&)t=/.test(location.hash)) boot(); });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && TOKEN && S.state) api("GET", "/state").then(applyState).catch(() => {});
    });
    setInterval(() => {
      if (!document.hidden && TOKEN && S.state) api("GET", "/state").then(applyState).catch(() => {});
    }, 15000);
    setInterval(() => { if (S.tab === "gatilhos" && S.overlays.length) renderOverlays(); }, 1000);
  }
  function undo() {
    if (!S.undo.length) return;
    S.groups = JSON.parse(S.undo.pop());
    afterChange();
  }

  const theme = local.get("prismatik.theme");
  if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
  wireUi();
  updateTriggerForm();
  const savedTab = local.get("prismatik.tab");
  selectTab(["inicio", "zonas", "gatilhos"].includes(savedTab) ? savedTab : "inicio");
  boot();
})();
