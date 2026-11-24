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
    scene_not_found: "Esse modo não existe mais. Recarregue a página.",
    invalid_scene: "Modo inválido. Confira o nome e as opções.",
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
    groups: [], saved: "[]", undo: [], open: null, groupsConflict: false,
    sel: new Set(), last: null,
    overlays: [], frame: null,
    tab: "inicio", stages: {},
    scenes: [], scenesSaved: "[]", scEdit: null, scenesConflict: false, srcFilter: "*", wiz: null,
  };
  const TABS = ["inicio", "zonas", "modos", "gatilhos"];
  const KNOWN_SOURCES = ["claude", "chatgpt", "whatsapp", "sistema"];
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
    if (S.wiz && name !== "zonas") wizEnd();
    S.tab = name;
    local.set("prismatik.tab", name);
    for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
    for (const s of TABS) $("tab-" + s).hidden = s !== name;
    drawFrame();
    if (name === "gatilhos") { renderPolicy(); renderOverlays(); }
    if (name === "modos") renderScenes();
  }

  // ---------------------------------------------------------------------------
  // basic mode
  let brightnessDragging = false;
  let profileRevision = 0;
  let groupsRequest = 0, scenesRequest = 0;
  const profileDrafts = new Map();

  function switchEditorProfile(previous, next) {
    if (previous && (isDirty() || scenesDirty() || S.undo.length)) {
      profileDrafts.set(previous, {
        groups: S.groups, saved: S.saved, undo: S.undo, open: S.open, groupsConflict: S.groupsConflict,
        scenes: S.scenes, scenesSaved: S.scenesSaved, scEdit: S.scEdit, scenesConflict: S.scenesConflict,
      });
    }
    if (S.wiz) wizEnd();
    Object.assign(S, {
      groups: [], saved: "[]", undo: [], open: null, groupsConflict: false,
      scenes: [], scenesSaved: "[]", scEdit: null, scenesConflict: false,
    }, profileDrafts.get(next));
    profileDrafts.delete(next);
    S.groupsProfile = next;
    S.sel.clear();
    S.last = null;
    profileRevision++;
    afterChange();
    renderScenes();
    renderPolicy();
  }
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
    if (prevProfile !== S.state.profile) {
      switchEditorProfile(prevProfile, S.state.profile);
      if (prevProfile) onProfileSwitchedSoon();
    }
    renderModeBtns();
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
    const revision = profileRevision;
    try {
      const layout = await api("GET", "/layout");
      if (revision !== profileRevision) return;
      S.layout = layout;
      buildStages();
    } catch (e) { if (e.status !== 401 && revision === profileRevision) toast(e.message, true); }
    if (revision === profileRevision)
      await Promise.all([loadGroups({ preserve: true }), loadScenes({ preserve: true })]);
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
    try {
      const r = await api("POST", "/trigger", t);
      if (r && r.suppressed) toast("O modo atual silenciou este aviso (origem fora da lista ou prioridade baixa demais).", true);
    } catch (e) { toast(e.message, true); }
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
    return { scr, desk, pos, r, vb, side };
  }

  function buildStage(container, editable) {
    container.textContent = "";
    const g = computeGeometry();
    if (!g) { container.append(el("p", { class: "empty" }, "Nenhum LED configurado neste perfil.")); return null; }
    const { scr, desk, pos, r, vb } = g;
    if (editable) S.sides = g.side;
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
    renderDeskSides();
  }
  function updateSaveBar() {
    const dirty = isDirty();
    $("savebar").hidden = !dirty && !S.undo.length;
    $("saveMsg").textContent = dirty && S.groupsConflict ? "As zonas remotas mudaram. Seu rascunho foi mantido."
      : dirty ? "Há mudanças ainda não aplicadas na fita." : "Tudo aplicado.";
    $("save").disabled = !dirty;
    $("discard").disabled = !dirty;
    $("undo").disabled = !S.undo.length;
  }
  async function loadGroups({ preserve = true, retry = false } = {}) {
    if (!S.state) return;
    const profile = S.state.profile;
    const revision = profileRevision;
    const request = ++groupsRequest;
    const current = () => revision === profileRevision && request === groupsRequest;
    try {
      const g = await api("GET", "/profiles/" + encodeURIComponent(profile) + "/groups");
      if (!current()) return;
      const groups = Array.isArray(g) ? g : [];
      const saved = JSON.stringify(groups);
      if (preserve && isDirty()) {
        S.groupsConflict = saved !== S.saved;
        updateSaveBar();
      } else if (!preserve || saved !== S.saved) {
        S.groups = groups;
        S.saved = saved;
        S.groupsConflict = false;
        S.undo = [];
        afterChange();
      }
    } catch (e) {
      if (!current()) return;
      if (retry) throw e;
      if (e.status !== 401) toast(e.message, true);
    }
  }
  async function saveGroups() {
    for (const g of S.groups) if (!groupIndices(g).length) { toast("O grupo “" + nameOf(g) + "” está sem LEDs. Escolha LEDs para ele ou apague.", true); return; }
    if (S.groupsConflict && !confirm("As zonas remotas mudaram. Substituir as zonas remotas pelo rascunho?")) return;
    const revision = profileRevision;
    const submitted = JSON.stringify(S.groups);
    ++groupsRequest;
    $("save").disabled = true;
    try {
      const res = await api("PUT", "/profiles/" + encodeURIComponent(S.groupsProfile || S.state.profile) + "/groups", JSON.parse(submitted));
      if (revision !== profileRevision) return;
      ++groupsRequest;
      const saved = Array.isArray(res) ? res : JSON.parse(submitted);
      if (JSON.stringify(S.groups) === submitted) S.groups = saved;
      S.saved = JSON.stringify(saved);
      S.groupsConflict = false;
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

  function modeParams(g, gi, apply) {
    const m = g.mode || { type: "source" };
    const run = apply || mutate;
    const set = (patch) => run(() => { g.mode = Object.assign({}, g.mode, patch); });
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
      case "source":
      case "screen":
        box.append(bright());
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
  // individual colour: one LED / one side with its own colour = a small group ("cor-*"), never a permanent overlay
  const ORIGIN_KEY = "prismatik.ledOrigin";
  function readOrigins() {
    const all = safe(() => JSON.parse(local.get(ORIGIN_KEY) || "{}"), {}) || {};
    return all[S.groupsProfile || (S.state && S.state.profile) || ""] || {};
  }
  function writeOrigins(map) {
    const all = safe(() => JSON.parse(local.get(ORIGIN_KEY) || "{}"), {}) || {};
    all[S.groupsProfile || (S.state && S.state.profile) || ""] = map;
    local.set(ORIGIN_KEY, JSON.stringify(all));
  }
  const isColorGroup = (g) => /^cor-/.test(g.id);
  function selectByPredicate(fn) {
    const out = new Set();
    for (let i = 0; i < ledCount(); i++) if (fn(i)) out.add(i);
    S.sel = out;
    paintEditor();
  }
  function renderDeskSides() {
    const box = $("deskSides");
    if (!box) return;
    box.textContent = "";
    for (const [id, label] of [["desk-left", "Mesa: esquerda"], ["desk-center", "Mesa: centro"], ["desk-right", "Mesa: direita"]]) {
      const gi = S.groups.findIndex((g) => g.id === id);
      if (gi >= 0) box.append(el("button", { type: "button", onclick: () => selectGroup(gi, false) }, label));
    }
  }
  async function applyLedColor() {
    if (!S.sel.size) { toast("Escolha alguns LEDs no desenho primeiro.", true); return; }
    const sel = [...S.sel].sort((a, b) => a - b);
    const color = $("lcColor").value;
    const origins = readOrigins();
    const own = owners();
    for (const i of sel) if (own[i] >= 0 && !isColorGroup(S.groups[own[i]])) origins[i] = S.groups[own[i]].id;
    writeOrigins(origins);
    const text = rangesText(sel, 2);
    mutate(() => {
      const notes = takeFromOthers(sel, null);
      const id = uniqueId("cor-" + (sel[0] + 1) + (sel.length > 1 ? "-" + (sel[sel.length - 1] + 1) : ""));
      S.groups.push({ id, name: (sel.length === 1 ? "Cor do LED " : "Cor dos LEDs ") + text, leds: { ranges: toRanges(sel) }, mode: { type: "solid", color, brightness: 1 } });
      return notes;
    });
    await saveGroups();
  }
  async function clearLedColor() {
    const own = owners();
    const hit = [...S.sel].filter((i) => own[i] >= 0 && isColorGroup(S.groups[own[i]]));
    if (!hit.length) { toast("Nenhum dos LEDs escolhidos tem cor individual.", true); return; }
    const origins = readOrigins();
    mutate(() => {
      const back = new Set(hit);
      const home = {};
      for (const i of hit) { const id = origins[i]; if (id && S.groups.some((g) => g.id === id)) (home[id] = home[id] || []).push(i); }
      S.groups = S.groups.filter((g) => {
        if (!isColorGroup(g)) return true;
        const keep = groupIndices(g).filter((i) => !back.has(i));
        if (!keep.length) return false;
        setGroupIndices(g, keep);
        return true;
      });
      for (const id in home) { const g = S.groups.find((x) => x.id === id); setGroupIndices(g, groupIndices(g).concat(home[id])); }
      for (const i of hit) delete origins[i];
      writeOrigins(origins);
    });
    await saveGroups();
  }

  // ---------------------------------------------------------------------------
  // "Achar o centro" wizard (desk strip -> desk-left / desk-center / desk-right)
  // indices are 0-based inside, shown 1-based (like the Prismatik window)
  const WIZ_FLASH = "painel-centro", WIZ_BAND = "painel-centro-faixa";
  function wizStart() {
    const n = ledCount();
    if (n < 4) { toast("Este perfil não tem LEDs suficientes.", true); return; }
    const idxOf = (id) => { const g = S.groups.find((x) => x.id === id); return g ? groupIndices(g).sort((a, b) => a - b) : []; };
    const c = idxOf("desk-center"), l = idxOf("desk-left"), r = idxOf("desk-right");
    // calibrated on 2026-11-14: desk 71-158 (left = lower number), centre under the monitor 98-131
    const w = { step: 0, D0: 71, D1: Math.min(158, n - 1), L: 98, R: 131 };
    if (l.length) w.D0 = l[0];
    if (r.length) w.D1 = r[r.length - 1];
    if (c.length) { w.L = c[0]; w.R = c[c.length - 1]; }
    w.D1 = clamp(w.D1, 2, n - 1);
    w.D0 = clamp(w.D0, 0, w.D1 - 2);
    w.L = clamp(w.L, w.D0 + 1, w.D1 - 1);
    w.R = clamp(w.R, w.L, w.D1 - 1);
    S.wiz = w;
    $("wizStart").hidden = true;
    wizRender();
  }
  const wizFlash = debounce(() => {
    const w = S.wiz;
    if (!w) return;
    const base = { effect: { type: "flash", color: "#ffffff", period_ms: 500, count: 0 }, duration_ms: 180000, priority: 95, blend: "override" };
    if (w.step === 2) trigger(Object.assign({ id: WIZ_FLASH, target: { leds: { ranges: [[w.L, w.L]] } } }, base));
    else if (w.step === 3) trigger(Object.assign({ id: WIZ_FLASH, target: { leds: { ranges: [[w.R, w.R]] } } }, base));
    else if (w.step === 4) trigger(Object.assign({ id: WIZ_FLASH, target: { leds: { ranges: [[w.L, w.L], [w.R, w.R]] } } }, base));
    if (w.step >= 2) trigger({ id: WIZ_BAND, target: { leds: { ranges: [[w.L, w.R]] } }, effect: { type: "solid", color: "#2a7bff" }, duration_ms: 180000, priority: 80, blend: "alpha" });
  }, 300);
  async function wizStop() {
    for (const id of [WIZ_FLASH, WIZ_BAND]) { try { await api("DELETE", "/trigger/" + encodeURIComponent(id)); } catch (e) { /* already gone */ } }
    setTimeout(loadOverlays, 400);
  }
  function wizEnd() {
    S.wiz = null;
    $("wiz").hidden = true;
    $("wiz").textContent = "";
    $("wizStart").hidden = false;
    wizStop();
  }
  function wizGo(step) { S.wiz.step = step; wizRender(); }
  function nudge(label, key, lo, hi) {
    const w = S.wiz;
    const move = (d) => { w[key] = clamp(w[key] + d, lo(), hi()); wizRender(); };
    return el("div", { class: "nudge" }, el("b", {}, label),
      el("button", { type: "button", title: "5 LEDs para a esquerda", onclick: () => move(-5) }, "◀◀"),
      el("button", { type: "button", title: "1 LED para a esquerda", onclick: () => move(-1) }, "◀"),
      el("output", {}, String(w[key] + 1)),
      el("button", { type: "button", title: "1 LED para a direita", onclick: () => move(1) }, "▶"),
      el("button", { type: "button", title: "5 LEDs para a direita", onclick: () => move(5) }, "▶▶"),
      el("button", { type: "button", onclick: () => wizFlash() }, "Piscar de novo"));
  }
  function wizRender() {
    const w = S.wiz, box = $("wiz");
    if (!w) return;
    box.hidden = false;
    box.className = "wiz";
    box.textContent = "";
    const n = ledCount();
    const num = (label, key, hint) => {
      const input = el("input", { type: "number", min: 1, max: n, value: w[key] + 1 });
      input.addEventListener("change", () => {
        w[key] = clamp((Math.round(+input.value) || 1) - 1, 0, n - 1);
        w.D1 = clamp(w.D1, 2, n - 1);
        w.D0 = clamp(w.D0, 0, w.D1 - 2);
        w.L = clamp(w.L, w.D0 + 1, w.D1 - 1);
        w.R = clamp(w.R, w.L, w.D1 - 1);
        wizRender();
      });
      return el("label", { class: "field" }, el("span", {}, el("b", {}, label)), input, el("small", { class: "muted" }, hint));
    };
    const nav = (back, next) => el("div", { class: "row" },
      back !== null ? el("button", { type: "button", onclick: () => wizGo(back) }, "Voltar") : null,
      next !== null ? el("button", { type: "button", class: "primary", onclick: () => wizGo(next) }, "Próximo") : null,
      el("span", { class: "spacer" }),
      el("button", { type: "button", class: "danger", onclick: wizEnd }, "Cancelar"));
    if (w.step === 0 || w.step === 1) {
      box.append(el("div", { class: "step" },
        el("p", {}, el("b", {}, "1 de 4 · A mesa"), " — onde a fita da mesa começa e termina. Já vem com o valor medido; só mude se a fita mudou."),
        el("div", { class: "grid2" },
          num("Primeiro LED da mesa (esquerda)", "D0", "Número menor = esquerda."),
          num("Último LED da mesa (direita)", "D1", "Número maior = direita.")),
        nav(null, 2)));
    } else if (w.step === 2 || w.step === 3) {
      const left = w.step === 2;
      const key = left ? "L" : "R";
      const lo = () => (left ? w.D0 + 1 : w.L), hi = () => (left ? w.R : w.D1 - 1);
      box.append(el("div", { class: "step" },
        el("p", {}, el("b", {}, (left ? "2" : "3") + " de 4 · Borda " + (left ? "esquerda" : "direita")),
          " — um LED está piscando em branco na fita (o resto do centro fica azul fixo). Mexa até o branco ficar exatamente na " +
          (left ? "borda esquerda" : "borda direita") + " do monitor."),
        nudge(left ? "Primeiro LED do centro:" : "Último LED do centro:", key, lo, hi),
        nav(left ? 1 : 2, left ? 3 : 4)));
      wizFlash();
    } else if (w.step === 4) {
      box.append(el("div", { class: "step" },
        el("p", {}, el("b", {}, "4 de 4 · Conferir e gravar"), " — os dois LEDs das bordas piscam. Se estiver certo, grave."),
        el("div", { class: "summary" },
          el("span", {}, "Esquerda: " + (w.D0 + 1) + "–" + w.L + " (" + (w.L - w.D0) + " LEDs)"),
          el("span", {}, "Centro: " + (w.L + 1) + "–" + (w.R + 1) + " (" + (w.R - w.L + 1) + " LEDs)"),
          el("span", {}, "Direita: " + (w.R + 2) + "–" + (w.D1 + 1) + " (" + (w.D1 - w.R) + " LEDs)")),
        el("p", { class: "muted small" }, "Grava os grupos desk-left, desk-center e desk-right e aplica na fita. LEDs que estavam em outros grupos saem deles."),
        el("div", { class: "row" },
          el("button", { type: "button", onclick: () => wizGo(3) }, "Voltar"),
          el("button", { type: "button", class: "primary", onclick: wizSave }, "Gravar os 3 grupos"),
          el("span", { class: "spacer" }),
          el("button", { type: "button", class: "danger", onclick: wizEnd }, "Cancelar"))));
      wizFlash();
    }
  }
  async function wizSave() {
    const w = S.wiz;
    if (!w) return;
    const parts = [["desk-left", "Mesa: esquerda", w.D0, w.L - 1, "solid"], ["desk-center", "Mesa: centro", w.L, w.R, "source"], ["desk-right", "Mesa: direita", w.R + 1, w.D1, "solid"]];
    const existing = {};
    for (const [id] of parts) existing[id] = S.groups.find((g) => g.id === id) || null;
    mutate(() => {
      const notes = [];
      for (const [id, name, a, b, type] of parts) {
        const idx = [];
        for (let i = a; i <= b; i++) idx.push(i);
        let g = existing[id];
        notes.push(...takeFromOthers(idx, g));
        if (g && !S.groups.includes(g)) S.groups.push(g);
        if (g) setGroupIndices(g, idx);
        else {
          g = { id, name, leds: { ranges: toRanges(idx) }, mode: type === "source" ? { type: "source" } : { type: "solid", color: "#ff9f40", brightness: 1 } };
          S.groups.push(g);
        }
      }
      return notes;
    });
    await saveGroups();
    if (!isDirty()) { wizEnd(); toast("Centro gravado: desk-left, desk-center e desk-right já estão na fita."); }
  }

  // ---------------------------------------------------------------------------
  // modes (scenes). Saved in the profile; the app applies a scene without restarting the capture.
  const sceneIdOf = (v) => (v && typeof v === "object" ? v.id : v) || "";
  const savedScenes = () => safe(() => JSON.parse(S.scenesSaved), []);
  const scenesDirty = () => JSON.stringify(S.scenes) !== S.scenesSaved;
  const activeSceneId = () => sceneIdOf(S.state && S.state.scene);
  const trigOf = (sc) => {
    const t = sc.triggers = sc.triggers || {};
    t.allow = Array.isArray(t.allow) ? t.allow : [];
    t.target_groups = Array.isArray(t.target_groups) ? t.target_groups : [];
    t.min_priority = +t.min_priority || 0;
    return t;
  };
  async function loadScenes({ preserve = true, retry = false } = {}) {
    const revision = profileRevision;
    const request = ++scenesRequest;
    const current = () => revision === profileRevision && request === scenesRequest;
    let r;
    try {
      r = await api("GET", "/scenes");
    } catch (e) {
      if (!current()) return;
      if (e.status !== 404) {
        if (retry) throw e;
        if (e.status !== 401) toast(e.message, true);
        return;
      }
    }
    if (!current()) return;
    const scenes = Array.isArray(r) ? r : (r && r.scenes) || [];
    scenes.forEach(trigOf);
    const saved = JSON.stringify(scenes);
    if (r && !Array.isArray(r) && r.active !== undefined) S.state.scene = r.active;
    if (preserve && scenesDirty()) {
      if (saved !== S.scenesSaved && !S.scenesConflict)
        toast("Os modos remotos mudaram. Seu rascunho foi mantido.", true);
      S.scenesConflict = saved !== S.scenesSaved;
      renderModeBtns();
      renderPolicy();
      return;
    }
    S.scenes = scenes;
    S.scenesSaved = saved;
    S.scenesConflict = false;
    if (!S.scenes.some((s) => s.id === S.scEdit)) S.scEdit = (S.scenes.find((s) => s.id === activeSceneId()) || S.scenes[0] || {}).id || null;
    renderModeBtns();
    renderScenes();
    renderPolicy();
  }
  function renderModeBtns() {
    const box = $("modeBtns");
    if (!box) return;
    box.textContent = "";
    const list = savedScenes();
    const cur = activeSceneId();
    if (!list.length) {
      box.append(el("p", { class: "empty" }, "Os modos ainda não aparecem aqui (versão do Prismatik sem modos, ou nenhum criado)."));
      $("modeInfo").textContent = "";
      return;
    }
    for (const sc of list) {
      box.append(el("button", { type: "button", "aria-pressed": String(sc.id === cur), onclick: () => activateScene(sc.id) }, sc.name || sc.id));
    }
    const a = list.find((s) => s.id === cur);
    $("modeInfo").textContent = a ? "Ligado agora: " + (a.name || a.id) + ". " + policyText(a) : "Nenhum modo ligado ainda. Escolha um acima.";
  }
  function policyText(sc) {
    const t = trigOf(JSON.parse(JSON.stringify(sc)));
    const who = t.allow.length ? "Podem avisar: " + t.allow.join(", ") : "Nenhuma origem pode avisar";
    const prio = t.min_priority > 0 ? "; só prioridade " + t.min_priority + " ou mais" : "";
    const where = t.target_groups.length ? "; avisos sem alvo acendem em " + t.target_groups.join(", ") : "";
    return who + prio + where + ".";
  }
  async function activateScene(id) {
    if (id === activeSceneId() && !isDirty()) return;
    if (isDirty() && !confirm("Há mudanças de zonas não aplicadas. Trocar de modo vai descartá-las. Continuar?")) return;
    const sc = savedScenes().find((s) => s.id === id);
    try {
      await api("POST", "/scenes/" + encodeURIComponent(id) + "/activate");
      applyState({ scene: id });
      toast("Modo “" + ((sc && sc.name) || id) + "” ligado.");
      renderScenes(); renderPolicy();
      await loadGroups({ preserve: false });
    } catch (e) { toast(e.message, true); }
  }
  const curScene = () => S.scenes.find((s) => s.id === S.scEdit) || null;
  function scMutate(fn) { fn(); renderScenes(); }
  function updateSceneBar() {
    const dirty = scenesDirty();
    $("scBar").hidden = !dirty;
    $("scSave").disabled = !dirty;
  }
  function renderScenes() {
    const tabs = $("scTabs"), ed = $("scEditor");
    if (!tabs) return;
    tabs.textContent = "";
    ed.textContent = "";
    const cur = activeSceneId();
    for (const sc of S.scenes) tabs.append(el("button", { type: "button", "aria-pressed": String(sc.id === S.scEdit), onclick: () => { S.scEdit = sc.id; renderScenes(); } }, (sc.id === cur ? "● " : "") + (sc.name || sc.id)));
    if (!S.scenes.length) tabs.append(el("p", { class: "empty" }, "Nenhum modo. Clique em “Novo modo” para criar um a partir das zonas atuais."));
    $("scDup").disabled = $("scDel").disabled = !curScene();
    updateSceneBar();
    const sc = curScene();
    if (!sc) return;
    const t = trigOf(sc);
    const nameInput = el("input", { type: "text", value: sc.name || "", maxlength: 40 });
    nameInput.addEventListener("change", () => { const v = nameInput.value.trim(); if (!v) { nameInput.value = sc.name || ""; return; } sc.name = v; renderScenes(); });
    ed.append(el("div", { class: "card" },
      el("div", { class: "row" }, el("h2", {}, "Modo “" + (sc.name || sc.id) + "”"), el("span", { class: "spacer" }),
        el("button", { type: "button", class: "primary", onclick: () => { if (scenesDirty()) toast("Salve as mudanças antes de ligar o modo.", true); else activateScene(sc.id); } }, sc.id === cur ? "Ligado ✓" : "Ligar este modo")),
      el("label", { class: "field" }, el("span", {}, el("b", {}, "Nome")), nameInput, el("small", { class: "muted" }, "Código: ", el("code", {}, sc.id)))));

    // what each group does in this mode
    const gcard = el("div", { class: "card" }, el("h2", {}, "O que cada parte da fita faz neste modo"),
      el("p", { class: "muted small" }, "Cada grupo pode seguir a tela, ficar numa cor, apagar… Os LEDs de cada grupo vêm das zonas (aba Zonas); aqui você escolhe só o jeito de acender."));
    if (!sc.groups || !sc.groups.length) gcard.append(el("p", { class: "empty" }, "Este modo ainda não tem grupos. Use “Copiar as zonas atuais”."));
    (sc.groups || []).forEach((g, gi) => {
      const idx = groupIndices(g);
      const key = sc.id + "/" + g.id;
      const open = S.scOpen === key;
      const head = el("header", { onclick: () => { S.scOpen = open ? null : key; renderScenes(); } },
        el("span", { class: "chip", style: "background:" + groupColor(gi) }),
        el("span", { class: "name" }, nameOf(g)),
        el("span", { class: "meta" }, (idx.length ? rangesText(idx, 3) : "sem LEDs") + " · " + modeLabel((g.mode || {}).type)),
        el("span", { class: "spacer" }),
        el("span", { class: "muted small" }, open ? "▲ fechar" : "▼ editar"));
      const card = el("div", { class: "group" }, head);
      if (open) {
        const modeSel = el("select", {});
        for (const [v, label] of MODES) modeSel.append(el("option", { value: v }, label));
        const ty = (g.mode || {}).type || "source";
        modeSel.value = ty === "screen" ? "source" : ty;
        modeSel.addEventListener("change", () => scMutate(() => { g.mode = defaultMode(modeSel.value, g.mode, gi); }));
        card.append(el("div", { class: "body" },
          el("div", { class: "grid" }, el("label", { class: "field" }, el("span", {}, el("b", {}, "Como acende")), modeSel,
            el("small", { class: "muted" }, (MODES.find((x) => x[0] === modeSel.value) || [])[2] || ""))),
          modeParams(g, gi, scMutate),
          el("div", { class: "actions" }, el("span", { class: "spacer" }),
            el("button", { type: "button", class: "danger", onclick: () => scMutate(() => { sc.groups.splice(gi, 1); t.target_groups = t.target_groups.filter((x) => x !== g.id); }) }, "Tirar do modo"))));
      }
      gcard.append(card);
    });
    gcard.append(el("div", { class: "actions row" },
      el("button", { type: "button", title: "Troca os grupos deste modo pelos que estão no perfil agora (aba Zonas, já aplicados)",
        onclick: () => { if (!confirm("Trocar os grupos deste modo pelas zonas atuais do perfil?")) return; scMutate(() => { sc.groups = JSON.parse(S.saved); t.target_groups = t.target_groups.filter((x) => sc.groups.some((g) => g.id === x)); }); } }, "Copiar as zonas atuais")));
    ed.append(gcard);

    // which sources may notify
    const srcs = [...new Set([...KNOWN_SOURCES, ...t.allow])];
    const allowBox = el("div", { class: "checks" });
    for (const s of srcs) {
      const cb = el("input", { type: "checkbox" });
      cb.checked = t.allow.includes(s);
      cb.addEventListener("change", () => { t.allow = cb.checked ? t.allow.concat([s]) : t.allow.filter((x) => x !== s); updateSceneBar(); });
      allowBox.append(el("label", { class: "chk" }, cb, s));
    }
    const addSrc = el("input", { type: "text", maxlength: 30, placeholder: "outra origem (ex.: meu-script)" });
    const addIt = () => { const v = addSrc.value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-"); if (!v) return; if (!t.allow.includes(v)) t.allow.push(v); renderScenes(); };
    addSrc.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); addIt(); } });
    const tgBox = el("div", { class: "checks" });
    for (const g of sc.groups || []) {
      const cb = el("input", { type: "checkbox" });
      cb.checked = t.target_groups.includes(g.id);
      cb.addEventListener("change", () => { t.target_groups = cb.checked ? t.target_groups.concat([g.id]) : t.target_groups.filter((x) => x !== g.id); updateSceneBar(); });
      tgBox.append(el("label", { class: "chk" }, cb, nameOf(g)));
    }
    ed.append(el("div", { class: "card" }, el("h2", {}, "Quais origens avisam neste modo"),
      el("p", { class: "muted small" }, "Só as origens marcadas acendem a fita neste modo. As outras são silenciadas (o app que avisou não vê erro)."),
      allowBox,
      el("div", { class: "row" }, addSrc, el("button", { type: "button", onclick: addIt }, "Adicionar origem")),
      slider("Prioridade mínima", t.min_priority, 0, 100, 1, (v) => String(v), (v) => { t.min_priority = v; updateSceneBar(); }, "Avisos com prioridade menor que isso são silenciados. 0 = todos passam; 90 = só os urgentes."),
      el("div", { class: "field" }, el("span", {}, el("b", {}, "Onde os avisos acendem")), tgBox,
        el("small", { class: "muted" }, "Vale para avisos que não dizem onde acender. Nenhum marcado = como o Prismatik decidir."))));
  }
  function newSceneId(name) {
    const ids = new Set(S.scenes.map((s) => s.id));
    const base = slug(name);
    if (!ids.has(base)) return base;
    for (let k = 2; ; k++) if (!ids.has(base + "-" + k)) return base + "-" + k;
  }
  function addScene(src, name) {
    const sc = src ? JSON.parse(JSON.stringify(src)) : { groups: JSON.parse(S.saved), triggers: { allow: KNOWN_SOURCES.slice(), min_priority: 0, target_groups: [] } };
    sc.name = name;
    sc.id = newSceneId(name);
    S.scenes.push(sc);
    S.scEdit = sc.id;
    renderScenes();
  }
  async function saveScenes() {
    for (const sc of S.scenes) if (!(sc.name || "").trim()) { toast("Todo modo precisa de nome.", true); return; }
    if (S.scenesConflict && !confirm("Os modos remotos mudaram. Substituir os modos remotos pelo rascunho?")) return;
    const revision = profileRevision;
    const submitted = JSON.stringify(S.scenes);
    ++scenesRequest;
    $("scSave").disabled = true;
    try {
      const r = await api("PUT", "/scenes", JSON.parse(submitted));
      if (revision !== profileRevision) return;
      ++scenesRequest;
      const saved = Array.isArray(r) ? r : r && Array.isArray(r.scenes) ? r.scenes : JSON.parse(submitted);
      saved.forEach(trigOf);
      if (JSON.stringify(S.scenes) === submitted) S.scenes = saved;
      S.scenesSaved = JSON.stringify(saved);
      S.scenesConflict = false;
      renderScenes(); renderModeBtns(); renderPolicy();
      toast("Modos salvos no perfil.");
    } catch (e) { toast(e.message, true); updateSceneBar(); }
  }

  // ---------------------------------------------------------------------------
  // triggers
  async function loadOverlays() {
    try {
      const o = await api("GET", "/overlays");
      S.overlays = Array.isArray(o) ? o : [];
    } catch (e) { S.overlays = []; }
    renderPolicy();
    renderOverlays();
  }
  const loadOverlaysSoon = debounce(loadOverlays, 250);
  const EFFECT_PT = { pulse: "pulsar", flash: "piscar", wave: "onda", breathe: "respirar", rainbow: "arco-íris", solid: "cor fixa", gradient: "degradê" };
  const srcKey = (o) => String(o.source || "");
  function allowedSources() {
    const sc = savedScenes().find((x) => x.id === activeSceneId());
    return sc ? trigOf(JSON.parse(JSON.stringify(sc))).allow : null;
  }
  function renderPolicy() {
    const info = $("policyInfo");
    if (!info) return;
    const sc = savedScenes().find((x) => x.id === activeSceneId());
    info.textContent = sc ? "Modo “" + (sc.name || sc.id) + "”. " + policyText(sc) : "Nenhum modo ligado: todos os avisos acendem normalmente.";
    const allow = allowedSources();
    const seen = new Set([...KNOWN_SOURCES, ...(allow || []), ...S.overlays.map(srcKey).filter(Boolean)]);
    const dl = $("srcList");
    dl.textContent = "";
    for (const s of seen) dl.append(el("option", { value: s }));
    const box = $("srcFilter");
    box.textContent = "";
    const chip = (key, label, title) => box.append(el("button", { type: "button", title, "aria-pressed": String(S.srcFilter === key),
      onclick: () => { S.srcFilter = key; renderPolicy(); renderOverlays(); } }, label));
    chip("*", "Todas");
    for (const s of seen) chip(s, s + (allow && !allow.includes(s) ? " (silenciada)" : ""), allow && !allow.includes(s) ? "Silenciada pelo modo atual" : "Pode avisar no modo atual");
    chip("-", "sem origem");
  }
  function renderOverlays() {
    const box = $("overlays");
    box.textContent = "";
    if (!S.overlays.length) { box.append(el("p", { class: "empty" }, "Nenhum efeito tocando agora.")); $("stopAll").disabled = true; return; }
    $("stopAll").disabled = false;
    const now = Date.now();
    const shown = S.overlays.filter((o) => S.srcFilter === "*" || (S.srcFilter === "-" ? !srcKey(o) : srcKey(o) === S.srcFilter));
    if (!shown.length) box.append(el("p", { class: "empty" }, "Nenhum efeito dessa origem tocando agora."));
    for (const o of shown) {
      let when = "até alguém parar";
      if (o.removing) when = "terminando…";
      else if (o.duration_ms > 0) when = "termina em " + Math.max(0, Math.ceil((o.started_at_ms + o.duration_ms - now) / 1000)) + " s";
      box.append(el("div", { class: "ov" },
        el("b", {}, o.id),
        o.source ? el("span", { class: "chip-src muted small" }, "[" + o.source + "]") : null,
        el("span", {}, EFFECT_PT[o.effect] || o.effect || ""),
        el("span", { class: "muted small" }, "prioridade " + o.priority + " · " + when),
        el("span", { class: "spacer" }),
        el("button", { type: "button", onclick: () => stopOverlay(o.id) }, "Parar")));
    }
  }
  function renderTargetOptions() {
    const sel = $("tTarget");
    const keep = sel.value;
    while (sel.options.length > 3) sel.remove(3);
    for (const g of JSON.parse(S.saved)) sel.append(el("option", { value: "g:" + g.id }, "Grupo: " + nameOf(g)));
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
  function buildTrigger() {
    const type = $("tType").value;
    const t = { id: $("tId").value.trim() || "teste-painel", effect: { type }, priority: +$("tPrio").value, blend: $("tBlend").value };
    const target = $("tTarget").value;
    const src = $("tSource").value.trim().toLowerCase();
    if (src) t.source = src;
    if (target === "all") t.target = { all: true };
    else if (target === "scene") { /* no target: the active mode decides where it lights */ }
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
          if (wsWasDown) {
            wsWasDown = false;
            refreshAfterReconnect(ws);
          }
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
    else if (name === "scene.changed") {
      const id = sceneIdOf(data.scene || data.id || data.active);
      if (id) applyState({ scene: id });
      if (!isDirty()) loadGroups();
      if (!scenesDirty()) loadScenes(); else { renderModeBtns(); renderScenes(); renderPolicy(); }
    }
    else if (name === "profile.changed" && data.profile) applyState({ profile: data.profile });
  }

  // ---------------------------------------------------------------------------
  // start
  async function refreshAll(reconnecting = false, current = () => true) {
    const revision = profileRevision;
    const [state, layout, profiles] = await Promise.all([api("GET", "/state"), api("GET", "/layout"), api("GET", "/profiles")]);
    if (!current() || revision !== profileRevision) return;
    S.profiles = (profiles && profiles.profiles) || [];
    S.layout = layout;
    applyState(state);
    buildStages();
    await Promise.all([loadGroups({ retry: reconnecting }), loadScenes({ retry: reconnecting }), loadOverlays()]);
  }
  async function refreshAfterReconnect(socket) {
    const current = () => ws === socket;
    try {
      await refreshAll(true, current);
    } catch (e) {
      if (!current() || e.status === 401) return;
      toast(e.message + " Tentando sincronizar de novo…", true);
      setTimeout(() => { if (current()) refreshAfterReconnect(socket); }, 3000);
    }
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
    $("goModos").addEventListener("click", () => selectTab("modos"));
    for (const b of document.querySelectorAll("[data-side]")) b.addEventListener("click", () => selectByPredicate((i) => (S.sides || [])[i] === b.dataset.side));
    $("lcApply").addEventListener("click", applyLedColor);
    $("lcClear").addEventListener("click", clearLedColor);
    $("wizStart").addEventListener("click", wizStart);
    $("scNew").addEventListener("click", () => {
      const name = (prompt("Nome do novo modo:", "Novo modo") || "").trim();
      if (name) addScene(null, name.slice(0, 40));
    });
    $("scDup").addEventListener("click", () => { const sc = curScene(); if (sc) addScene(sc, (sc.name + " (cópia)").slice(0, 40)); });
    $("scDel").addEventListener("click", () => {
      const sc = curScene();
      if (!sc || !confirm("Apagar o modo “" + (sc.name || sc.id) + "”?")) return;
      S.scenes = S.scenes.filter((x) => x !== sc);
      S.scEdit = (S.scenes[0] || {}).id || null;
      renderScenes();
    });
    $("scSave").addEventListener("click", saveScenes);
    $("scDiscard").addEventListener("click", () => { S.scenes = JSON.parse(S.scenesSaved); if (!S.scenes.some((x) => x.id === S.scEdit)) S.scEdit = (S.scenes[0] || {}).id || null; renderScenes(); });
    $("trigForm").addEventListener("submit", (ev) => {
      ev.preventDefault();
      if ($("tTarget").value === "sel" && !S.sel.size) { toast("Escolha LEDs na aba Zonas primeiro.", true); return; }
      trigger(buildTrigger());
      setTimeout(loadOverlays, 300);
    });
    $("trigForm").addEventListener("input", updateTriggerForm);
    $("trigForm").addEventListener("change", updateTriggerForm);
    window.addEventListener("beforeunload", (ev) => { if (isDirty() || scenesDirty() || [...profileDrafts.values()].some((draft) =>
      JSON.stringify(draft.groups) !== draft.saved || JSON.stringify(draft.scenes) !== draft.scenesSaved)) { ev.preventDefault(); ev.returnValue = ""; } });
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
  selectTab(TABS.includes(savedTab) ? savedTab : "inicio");
  boot();
})();
