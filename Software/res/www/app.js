/* Prismatik 5.13: same-origin REST + WebSocket, local preview when disconnected. */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const room = $("room");
  const NS = "http://www.w3.org/2000/svg";
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const simulation = new URLSearchParams(location.search).get("mock") === "1";
  const storagePrefix = simulation ? "prismatik.lofi.mock." : "prismatik.lofi.";
  const session = {
    get: (k) => safe(() => sessionStorage.getItem(k), null),
    set: (k, v) => safe(() => sessionStorage.setItem(k, v)),
    del: (k) => safe(() => sessionStorage.removeItem(k)),
  };
  const local = {
    get: (k) => safe(() => localStorage.getItem(storagePrefix + k), null),
    set: (k, v) => safe(() => localStorage.setItem(storagePrefix + k, v)),
  };
  const TOKEN_KEY = "prismatik.token";
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
  const prefersDark = matchMedia("(prefers-color-scheme: dark)");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const styleIds = ["lofi", "retro", "cozy"];
  const baseColors = ["#afc8ff", "#ffb884", "#a4e3c1", "#f3a9db", "#f5d590", "#c2b4ff"];
  const outlineColors = ["#dce6ff", "#ffcc95", "#b4ffe0", "#ffd1f5", "#fff3ab", "#dfd4ff"];
  const views = [
    { id:"desk", name:"Mesa", icon:"▱", x:565, y:371, zoom:1.45 },
    { id:"monitor", name:"Monitor", icon:"▣", x:602, y:286, zoom:2.25 },
    { id:"window", name:"Janela", icon:"⊞", x:285, y:193, zoom:2.3 },
    { id:"shelf", name:"Estante", icon:"▤", x:848, y:147, zoom:2.4 },
    { id:"chair", name:"Poltrona", icon:"◒", x:926, y:361, zoom:2.55 },
    { id:"lights", name:"Luzinhas", icon:"✦", x:548, y:80, zoom:1.35 },
  ];
  const presets = [
    { name:"Agente terminou", icon:"✓", color:"#97e6b6", brightness:.86 },
    { name:"Notificação", icon:"!", color:"#f7ad77", brightness:.88 },
    { name:"Horário", icon:"◷", color:"#ffc578", brightness:.67 },
    { name:"Foco", icon:"◎", color:"#aacfff", brightness:.76 },
    { name:"Mídia", icon:"▶", color:"#c1a3f8", brightness:.47 },
    { name:"Trabalho", icon:"▤", color:"#f4dcba", brightness:1 },
  ];
  const fixtureURL = "mock/layout-159.json";
  let fixture;
  let S = { state:null, layout:null, groups:[], scenes:[], profiles:[], live:false, wsUp:false, frame:null, selected:null, draft:null, editing:false, overlay:null, geometryMock:false, groupsMock:false };
  let ws, reconnectTimer, reconnectMs = 950, snapshotSerial = 0, pendingFrame = null, busy = false;
  const pointMap = new Map();
  const zoneMap = new Map();
  const ledLayer = $("dots");
  let sceneGeometry = [], ledScale = 1;
  const errors = {
    led_conflict:"Um LED não pode pertencer a duas zonas.",
    invalid_leds:"Confira os LEDs selecionados.",
    invalid_mode:"Este modo de luz não é aceito.",
    invalid_group:"A zona não pôde ser salva.",
    unknown_group:"Esta zona ainda não existe no perfil.",
    rate_limited:"Espere um segundo e tente novamente.",
    invalid_trigger:"Confira a configuração do efeito.",
    profile_not_found:"Esse perfil não está disponível.",
    scene_not_found:"Essa cena não está mais disponível."
  };
  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  function showLogin() {
    TOKEN = "";
    session.del(TOKEN_KEY);
    clearTimeout(reconnectTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    S.live = S.wsUp = false;
    S.frame = pendingFrame = null;
    updateConnection("Acesso expirado. Reabra pelo Prismatik.");
  }
  async function api(method, path, body, { ifMatch, withVersion = false } = {}) {
    if (simulation) throw new ApiError(0, "A API está desativada na simulação [mock].");
    const opt = { method, cache:"no-store", headers:{ Authorization:"Bearer " + TOKEN }, signal:AbortSignal.timeout(12000) };
    if (ifMatch) opt.headers["If-Match"] = ifMatch;
    if (body !== undefined) {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    let r;
    try { r = await fetch("/api/v1" + path, opt); }
    catch { throw new ApiError(0, "Sem resposta do Prismatik. Tente novamente."); }
    const data = await r.json().catch(() => null);
    if (r.status === 401) {
      showLogin();
      throw new ApiError(401, "Acesso expirado. Reabra pelo Prismatik.");
    }
    if (!r.ok) {
      const code = data?.error?.code;
      const message = errors[code] || data?.error?.message || "O Prismatik retornou o código " + r.status + ".";
      throw new ApiError(r.status, r.status === 409 ? "Conflito: " + message : message);
    }
    return withVersion ? { data, etag:r.headers.get("ETag") } : data;
  }
  const mk = (tag, attrs = {}, value = "") => {
    const e = document.createElement(tag);
    for (const [key,v] of Object.entries(attrs)) e.setAttribute(key, v);
    e.textContent = value;
    return e;
  };
  const svg = (tag, attrs = {}) => {
    const e = document.createElementNS(NS, tag);
    for (const [key,v] of Object.entries(attrs)) e.setAttribute(key, v);
    return e;
  };
  const button = (label, click, attrs = {}) => {
    const b = mk("button", { type:"button", ...attrs }, label);
    b.addEventListener("click", click);
    return b;
  };
  const groupName = (g) => g?.name || g?.id || "";
  const sceneID = (v) => typeof v === "object" ? v?.id : v;
  const groupRoute = (profile = S.state.profile) => "/profiles/" + encodeURIComponent(profile) + "/groups";
  const stateNow = () => S.state || {};
  const groupIds = (g) => {
    const leds = g?.leds || {};
    return sceneGeometry.map((p) => p.index).filter((i) =>
      leds.all || leds.list?.includes(i) || leds.ranges?.some(([a,b]) => i >= a && i <= b));
  };
  function toRanges(indices) {
    const out = [];
    for (const i of [...new Set(indices)].sort((a,b) => a-b)) {
      const last = out.at(-1);
      if (last && i === last[1]+1) last[1] = i;
      else out.push([i,i]);
    }
    return out;
  }
  const quietHex = (c, fallback) => /^#[a-f0-9]{6}$/i.test(c || "") ? c : fallback;
  const deskWord = /(?:^|[\s_-])(desk|mesa|table)(?:$|[\s_-])/i;
  const monitorWord = /monitor|tela|screen/i;
  function areaOfGroup(g) {
    const name = g.id + " " + groupName(g);
    if (deskWord.test(name)) return "desk";
    if (monitorWord.test(name)) return "monitor";
    return views.find((v) => v.id === g.id || normalized(v.name) === normalized(groupName(g)))?.id;
  }
  function normalized(s) { return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase(); }
  const baseRect = { x:0,y:0,w:1100,h:510 };
  const camera = { ...baseRect };
  let cameraAnimation = 0, activeView = "", drag = null, orderPick = null;
  const pointers = new Map();
  function clientPoint(x, y) {
    const p = new DOMPoint(x,y);
    return p.matrixTransform(room.getScreenCTM().inverse());
  }
  function fitView(x,y,zoom) {
    const w = baseRect.w/zoom, h = baseRect.h/zoom;
    return { x:clamp(x-w/2,0,baseRect.w-w), y:clamp(y-h/2,0,baseRect.h-h), w,h };
  }
  function showCamera(v) {
    Object.assign(camera,v);
    room.setAttribute("viewBox", [v.x,v.y,v.w,v.h].join(" "));
    const box = room.getBoundingClientRect();
    ledScale = 1 / (room.getScreenCTM()?.a || Math.max(box.width/v.w,box.height/v.h) || 1);
    room.dataset.zoomed = String(v.w < baseRect.w-.1);
    updateDotSizes();
    placeControls();
  }
  function goCamera(v, animated = true) {
    cancelAnimationFrame(cameraAnimation);
    cameraAnimation = 0;
    if (!animated || reducedMotion.matches || document.hidden) {
      showCamera(v);
      return;
    }
    const start = performance.now(), origin = { ...camera };
    function frame(now) {
      const t = clamp((now-start)/320,0,1), f = 1 - (1-t)**3;
      const next = Object.fromEntries(Object.keys(v).map((k) => [k,origin[k]+(v[k]-origin[k])*f]));
      showCamera(next);
      cameraAnimation = t < 1 ? requestAnimationFrame(frame) : 0;
    }
    cameraAnimation = requestAnimationFrame(frame);
  }
  function zoomAround(factor, point, animated) {
    const zoom = clamp(baseRect.w/camera.w*factor,1,4);
    const w = baseRect.w/zoom, h=baseRect.h/zoom;
    const center = point || { x:camera.x+camera.w/2,y:camera.y+camera.h/2 };
    activeView = "";
    markSelections();
    goCamera(fitView(center.x+(camera.x+camera.w/2-center.x)*w/camera.w,
      center.y+(camera.y+camera.h/2-center.y)*h/camera.h,zoom),animated);
  }
  function setHint(message) { $("hint").textContent = message; }
  function navigateView(id) {
    const v = views.find((item) => item.id === id);
    activeView = id;
    if (!v) {
      goCamera(baseRect);
      markSelections();
      setHint("");
      return;
    }
    const matching = [...zoneMap.values()].filter((z) => z.section === id);
    if (matching.length) selectZone(matching.find((z) => z.id === S.selected)?.id || matching[0].id);
    else { S.selected = null; renderControls(); }
    markSelections();
    setHint(matching.length ? v.name : v.name + " · sem LEDs nesta seção");
    goCamera(fitView(v.x,v.y,v.zoom));
  }
  function buildLayout() {
    const layout = S.layout || { leds:[] };
    const leds = (layout.leds || []).filter((p) => Number.isInteger(p.index) && p.index >= 0 && [p.x,p.y,p.w,p.h].every(Number.isFinite));
    if (!leds.length) { sceneGeometry = []; return; }
    const deskCodes = new Set();
    for (const g of S.groups.filter((g) => areaOfGroup(g) === "desk")) {
      for (const p of leds) if (g.leds?.all || g.leds?.list?.includes(p.index) || g.leds?.ranges?.some(([a,b]) => p.index >= a && p.index <= b)) deskCodes.add(p.index);
    }
    const centers = leds.map((p) => ({ ...p, cx:p.x+p.w/2, cy:p.y+p.h/2 }));
    const isDesk = (p) => p.section === "desk" || deskCodes.has(p.index);
    const main = centers.filter((p) => !isDesk(p));
    const ranked = (layout.screens || []).map((scr) => ({ ...scr, count:main.filter((p) =>
      p.cx >= scr.x && p.cx <= scr.x+scr.w && p.cy >= scr.y && p.cy <= scr.y+scr.h).length })).sort((a,b) => b.count-a.count);
    const bounding = (points) => {
      const x = Math.min(...points.map((p) => p.x)), y = Math.min(...points.map((p) => p.y));
      return { x,y,w:Math.max(1,...points.map((p) => p.x+p.w-x)),h:Math.max(1,...points.map((p) => p.y+p.h-y)) };
    };
    const scr = ranked[0]?.count ? ranked[0] : bounding(main.length ? main : centers);
    const desk = centers.filter((p) => isDesk(p) || (ranked[0]?.count && p.cy > scr.y + scr.h));
    const deskSet = new Set(desk.map((p) => p.index));
    const deskBounds = desk.length ? bounding(desk) : scr;
    const deskRanks = new Map([...desk].sort((a,b) => a.cx-b.cx || a.index-b.index).map((p,i) => [p.index,i]));
    const atX = (x) => 458+x*286, atY = (y) => 215+y*163;
    sceneGeometry = centers.map((p) => {
      const x = clamp((p.cx-scr.x)/Math.max(1,scr.w),0,1), y = clamp((p.cy-scr.y)/Math.max(1,scr.h),0,1);
      if (deskSet.has(p.index)) {
        const horizontal = deskBounds.w > ((desk[0]?.w || 0) + 1);
        const ratio = horizontal ? clamp((p.cx-deskBounds.x)/deskBounds.w,0,1) : deskRanks.get(p.index)/Math.max(1,desk.length-1);
        return { index:p.index,x:310+514*ratio,y:391,enabled:p.enabled !== false,section:"desk" };
      }
      const distance = [x,1-x,y,1-y];
      const side = distance.indexOf(Math.min(...distance));
      return { index:p.index,x:atX(side === 0 ? 0 : side === 1 ? 1 : x),
        y:atY(side === 2 ? 0 : side === 3 ? 1 : y),enabled:p.enabled !== false,section:"monitor",side };
    }).sort((a,b) => a.index-b.index);
  }
  function paintZoneGeometry() {
    const layer = $("zones-art");
    layer.replaceChildren();
    for (const z of zoneMap.values()) {
      const points = z.points;
      if (!points.length) continue;
      const d = points.map((p,i) => {
        const prev = points[i-1];
        const join = prev && prev.section === p.section && Math.hypot(prev.x-p.x,prev.y-p.y) < (p.section === "desk" ? 35 : 130);
        return (join ? "L" : "M") + p.x + " " + (p.y+(p.section === "desk" ? 6 : 0));
      }).join(" ");
      layer.append(svg("path",{ d,stroke:z.outline,"data-zone":z.id,"data-part":z.section }));
    }
  }
  function updateDotSizes() {
    const density = sceneGeometry.length;
    const radius = density > 240 ? 2.3 : density > 100 ? 2.6 : 3.3;
    ledLayer.style.setProperty("--dot-radius", radius * ledScale + "px");
    ledLayer.style.setProperty("--glow-radius", radius * 2.15 * ledScale + "px");
    ledLayer.style.setProperty("--hit-radius", Math.max(8, radius * 2.2) * ledScale + "px");
  }
  function renderGeometry() {
    buildLayout();
    zoneMap.clear();
    pointMap.clear();
    ledLayer.replaceChildren();
    const owner = new Map();
    S.groups.forEach((g,i) => {
      const set = new Set(groupIds(g));
      if (!set.size) return;
      const points = sceneGeometry.filter((p) => set.has(p.index));
      const desk = points.filter((p) => p.section === "desk").length;
      const z = { ...g,points,section:areaOfGroup(g) || (desk > points.length/2 ? "desk" : "monitor"),
        color:baseColors[i%baseColors.length],outline:outlineColors[i%outlineColors.length] };
      zoneMap.set(g.id,z);
      for (const p of points) owner.set(p.index,z);
    });
    const rest = sceneGeometry.filter((p) => !owner.has(p.index));
    for (const section of ["monitor","desk"]) {
      const points = rest.filter((p) => p.section === section);
      if (!points.length) continue;
      const id = "unassigned-" + section;
      const z = { id,name: (section === "desk" ? "Mesa" : "Monitor") + (zoneMap.size ? " · livres" : ""),
        section, points, mode:{ type:"source" }, color:section === "desk" ? baseColors[1] : baseColors[0],outline:outlineColors[1],unsaved:true };
      zoneMap.set(id,z);
      for (const p of points) owner.set(p.index,z);
    }
    for (const p of sceneGeometry) {
      const z = owner.get(p.index);
      const hit = svg("circle",{ class:"hit",cx:p.x,cy:p.y,"data-led":p.index,"data-part":p.section });
      const title = svg("title"); title.textContent = groupName(z) + " · LED " + (p.index+1); hit.append(title);
      const glow = svg("circle",{ class:"glow",cx:p.x,cy:p.y,fill:"#000",opacity:0,"data-part":p.section });
      const dot = svg("circle",{ class:"led",cx:p.x,cy:p.y,fill:"#000","data-index":p.index,"data-part":p.section });
      ledLayer.append(glow,dot,hit);
      pointMap.set(p.index,{ ...p,z,hit,glow,dot });
    }
    if (S.selected && !zoneMap.has(S.selected)) S.selected = zoneMap.keys().next().value || null;
    paintZoneGeometry();
    renderMobileLeds();
    updateDotSizes();
    renderZones();
    drawPreview(performance.now(),true);
  }
  function renderZones() {
    $("zone-list").replaceChildren();
    for (const z of zoneMap.values()) {
      const b = button("",(ev) => { selectZone(z.id); openMenu(ev.currentTarget); },
        { class:"zone-chip","data-zone":z.id,title:groupName(z), "aria-haspopup":"dialog" });
      b.style.setProperty("--zone-chip",z.outline);
      b.append(mk("span",{ "aria-hidden":"true" },views.find((v) => v.id === z.section)?.icon || "◈"),groupName(z));
      $("zone-list").append(b);
    }
    if (!zoneMap.size) $("zone-list").append(mk("span",{ class:"muted" },"Nenhum LED configurado"));
    renderControls();
    markSelections();
  }
  function markSelections() {
    for (const b of $("views").children) b.setAttribute("aria-pressed",String(b.dataset.view === activeView));
    for (const b of $("zone-list").querySelectorAll("button")) b.setAttribute("aria-pressed",String(b.dataset.zone === S.selected));
    for (const path of $("zones-art").children) path.classList.toggle("selected",path.dataset.zone === S.selected);
    for (const p of pointMap.values()) p.dot.classList.toggle("selected",Boolean(S.draft?.indices.has(p.index)));
  }
  function selectZone(id) {
    if (!zoneMap.has(id)) return;
    S.selected = id;
    renderControls();
    markSelections();
  }
  function nearestLed(ev) {
    const p = clientPoint(ev.clientX,ev.clientY);
    if (!orderPick && !S.editing && room.dataset.zoomed !== "true" && !focusKind) return;
    let nearest, best=15*ledScale;
    for (const led of pointMap.values()) {
      const d = Math.hypot(p.x-led.x,p.y-led.y);
      if (d < best) { nearest=led; best=d; }
    }
    return nearest;
  }
  function rangeBand(a,b) {
    const bounds = { x:Math.min(a.x,b.x), y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y) };
    for (const [k,v] of Object.entries(bounds)) $("band").setAttribute(k,v);
    $("band").setAttribute("visibility","visible");
    return new Set(sceneGeometry.filter((p) => p.x >= bounds.x && p.x <= bounds.x+bounds.width && p.y >= bounds.y && p.y <= bounds.y+bounds.height).map((p) => p.index));
  }
  function editMode(on) {
    S.editing = on;
    S.draft = null;
    room.dataset.edit = String(on);
    $("edit").setAttribute("aria-pressed",String(on));
    setHint(on ? "Arraste sobre os pontos para rascunhar uma zona [mock]." : "");
    markSelections();
  }
  room.addEventListener("wheel",(ev) => {
    ev.preventDefault();
    zoomAround(ev.deltaY < 0 ? 1.19 : 1/1.19,clientPoint(ev.clientX,ev.clientY),false);
  },{ passive:false });
  room.addEventListener("pointerdown",(ev) => {
    if (ev.button !== 0) return;
    cancelAnimationFrame(cameraAnimation);
    pointers.set(ev.pointerId,{ x:ev.clientX,y:ev.clientY });
    room.setPointerCapture(ev.pointerId);
    if (pointers.size === 1) {
      drag = { origin:clientPoint(ev.clientX,ev.clientY), x:ev.clientX,y:ev.clientY,camera:{ ...camera },
        section:ev.target.closest("[data-view]")?.dataset.view, point:nearestLed(ev),moved:false };
    } else if (pointers.size === 2) {
      drag.moved = true;
      const [a,b] = pointers.values();
      drag.pinch = Math.hypot(b.x-a.x,b.y-a.y);
    }
  });
  room.addEventListener("pointermove",(ev) => {
    if (!pointers.has(ev.pointerId) || !drag) return;
    pointers.set(ev.pointerId,{ x:ev.clientX,y:ev.clientY });
    if (pointers.size > 1) {
      const [a,b] = pointers.values();
      const distance = Math.hypot(b.x-a.x,b.y-a.y);
      if (drag.pinch > 0) zoomAround(distance/drag.pinch,clientPoint((a.x+b.x)/2,(a.y+b.y)/2),false);
      drag.pinch = distance;
      return;
    }
    if (drag.pinch || (!drag.moved && Math.hypot(ev.clientX-drag.x,ev.clientY-drag.y) < 5)) return;
    drag.moved = true;
    if (S.editing) {
      S.draft = { zone:S.selected,indices:rangeBand(drag.origin,clientPoint(ev.clientX,ev.clientY)) };
      markSelections();
    } else {
      room.dataset.grab = "true";
      const c = drag.camera;
      showCamera(fitView(c.x+c.w/2-(ev.clientX-drag.x)*ledScale,c.y+c.h/2-(ev.clientY-drag.y)*ledScale,baseRect.w/c.w));
    }
  });
  function releaseRoom(ev) {
    pointers.delete(ev.pointerId);
    if (pointers.size || !drag) return;
    room.dataset.grab = "false";
    $("band").setAttribute("visibility","hidden");
    if (ev.type !== "pointercancel") {
      if (S.editing && drag.moved) setHint((S.draft?.indices.size || 0) + " LEDs no rascunho [mock].");
      else if (!drag.moved && orderPick && drag.point) pickOrderPoint(drag.point.index);
      else if (!drag.moved && drag.point && S.editing) {
        const indices = new Set(S.draft?.indices || []);
        const i = drag.point.index;
        if (indices.has(i)) indices.delete(i); else indices.add(i);
        S.draft = { zone:S.selected,indices };
        setHint(indices.size + " LEDs no rascunho [mock].");
        markSelections();
      } else if (!drag.moved && drag.point?.z) {
        selectZone(drag.point.z.id);
        openMenu($("zone-list").querySelector('[aria-pressed="true"]') || $("menu"));
      } else if (!drag.moved && drag.section === "monitor" && !orderPick) {
        openArea("monitor",$("views").querySelector('[data-view="monitor"]'));
      } else if (!drag.moved && drag.section) navigateView(drag.section);
    }
    drag = null;
  }
  room.addEventListener("pointerup",releaseRoom);
  room.addEventListener("pointercancel",releaseRoom);
  new ResizeObserver(() => showCamera(camera)).observe(room);

  const popup = $("popup"), settings = $("settings"), orderDialog = $("order-dialog");
  const modalOrigins = new WeakMap();
  function focusables(dialog) {
    return [...dialog.querySelectorAll("button,select,input,summary,[tabindex]")].filter((e) =>
      !e.disabled && e.tabIndex >= 0 && e.getClientRects().length);
  }
  function setupDialog(dialog, close) {
    const pane = dialog.querySelector(".popup-inner");
    const updateScrollCue = () => {
      const remaining = pane.scrollHeight - pane.clientHeight - pane.scrollTop;
      dialog.toggleAttribute("data-more-below",pane.clientHeight > 0 && remaining > 2);
    };
    pane.addEventListener("scroll",updateScrollCue,{passive:true});
    const watchSize = new ResizeObserver(updateScrollCue);
    watchSize.observe(pane);
    for (const child of pane.children) watchSize.observe(child);
    $(close).addEventListener("click",() => dialog.close());
    let outside = false;
    dialog.addEventListener("pointerdown",(ev) => { outside = ev.target === dialog; });
    dialog.addEventListener("click",(ev) => { if (outside && ev.target === dialog) dialog.close(); outside = false; });
    dialog.addEventListener("keydown",(ev) => {
      if (ev.key !== "Tab") return;
      const controls = focusables(dialog), first = controls[0], last = controls.at(-1);
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last?.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first?.focus(); }
    });
    dialog.addEventListener("close",() => {
      if (document.querySelector("dialog[open]") || orderPick) return;
      leaveFocus();
      const origin = modalOrigins.get(dialog);
      (origin?.isConnected ? origin : $("menu")).focus({ preventScroll:true });
    });
  }
  setupDialog(popup,"close");
  setupDialog(settings,"settings-close");
  setupDialog(orderDialog,"order-close");
  function showModal(dialog, origin) {
    if (dialog.open) return;
    for (const d of [popup,settings,orderDialog]) if (d.open) d.close();
    modalOrigins.set(dialog,origin);
    activateFocus(focusKind || "monitor",dialog);
    dialog.showModal();
  }
  function openMenu(origin) {
    if (!S.selected) S.selected = zoneFor("monitor")?.id || zoneMap.keys().next().value || null;
    focusKind = zoneMap.get(S.selected)?.section === "desk" ? "desk" : "monitor";
    selectTab("now");
    $("notice").textContent = "";
    renderControls();
    markSelections();
    showModal(popup,origin);
  }
  function selectTab(id, focus = false) {
    const tabs = [...popup.querySelectorAll('[role="tab"]')];
    for (const tab of tabs) {
      const target = tab.getAttribute("aria-controls"), active = target === id;
      tab.setAttribute("aria-selected",String(active));
      tab.tabIndex = active ? 0 : -1;
      $(target).hidden = !active;
      if (active && focus) tab.focus();
    }
  }
  popup.querySelector(".tabs").addEventListener("click",(ev) => {
    const tab = ev.target.closest('[role="tab"]');
    if (tab) selectTab(tab.getAttribute("aria-controls"));
  });
  popup.querySelector(".tabs").addEventListener("keydown",(ev) => {
    const tabs = [...popup.querySelectorAll('[role="tab"]')], i = tabs.indexOf(ev.target);
    const index = { ArrowRight:(i+1)%tabs.length,ArrowLeft:(i+tabs.length-1)%tabs.length,Home:0,End:tabs.length-1 }[ev.key];
    if (i < 0 || index === undefined) return;
    ev.preventDefault();
    selectTab(tabs[index].getAttribute("aria-controls"),true);
  });
  function zoneOptions(select, active) {
    const zones = [...zoneMap.values()];
    const values = zones.map((z) => [z.id,groupName(z)]);
    if (JSON.stringify(values) !== select.dataset.options) {
      select.replaceChildren(...values.map(([id,name]) => mk("option",{value:id},name)));
      select.dataset.options = JSON.stringify(values);
    }
    if (active && zoneMap.has(active)) select.value = active;
    select.disabled = !zones.length;
  }
  function renderSceneButtons() {
    const list = $("scene-list");
    const prior = document.activeElement?.dataset?.scene;
    list.replaceChildren();
    if (!S.scenes.length) list.append(mk("p",{class:"muted"},"Nenhuma cena neste perfil."));
    for (const sc of S.scenes) {
      list.append(button(groupName(sc),() => activateScene(sc),
        { "data-scene":sc.id,"aria-pressed":String(sc.id === sceneID(stateNow().scene)) }));
    }
    if (prior && popup.open) [...list.children].find((b) => b.dataset.scene === prior)?.focus();
  }
  function paintSwitch(b,on) {
    b.setAttribute("aria-checked",String(on));
    b.textContent = on ? "Ligada" : "Desligada";
  }
  function renderControls() {
    const z = zoneMap.get(S.selected), mode = z?.mode || {};
    $("popup-zone").textContent = z ? groupName(z) + " · " + z.points.length + " LEDs" + (S.live && !S.groupsMock ? "" : " · [mock]") : "Selecione uma zona";
    zoneOptions($("zone-picker"),S.selected);
    zoneOptions($("target"),$("target").dataset.pinned === "true" ? $("target").value : S.selected);
    $("color").value = quietHex(mode.color,z?.color || "#ffb884");
    $("brightness").value = Math.round((mode.brightness ?? 1)*100);
    $("brightness-value").textContent = $("brightness").value + "%";
    paintSwitch($("power"),mode.type !== "off");
    for (const id of ["color","brightness","power","zone-order","event","effect","duration"]) $(id).disabled = !z;
    for (const b of $("preset-list").children) b.disabled = !z;
    $("trigger-form").querySelector('[type="submit"]').disabled = !z;
    const saved = safe(() => JSON.parse(local.get("rule." + stateNow().profile)),null);
    if (saved && $("trigger-form").dataset.profile !== stateNow().profile) {
      if ([...$("event").options].some((o) => o.value === saved.event)) $("event").value = saved.event;
      if ([...$("effect").options].some((o) => o.value === saved.effect)) $("effect").value = saved.effect;
      if ([...$("duration").options].some((o) => o.value === saved.duration)) $("duration").value = saved.duration;
      if (zoneMap.has(saved.zone)) $("target").value = saved.zone;
    }
    $("trigger-form").dataset.profile = stateNow().profile || "";
    renderSceneButtons();
    paintDock();
  }
  function updateConnection(message) {
    const count = stateNow().led_count ?? sceneGeometry.length;
    if (simulation) {
      $("connection").textContent = "[mock] Simulação local · " + (message || count + " LEDs · sem conexão com o Prismatik");
      return;
    }
    $("connection").textContent = message
      ? "[mock] · " + message
      : S.live
        ? (S.wsUp ? "Ao vivo" : "Conectado · atualizando luz") + " · " + count + " LEDs" + (S.geometryMock || S.groupsMock ? " · dados parciais [mock]" : "")
        : "Prévia [mock] · " + count + " LEDs · abra pelo Prismatik para conectar";
  }
  async function exclusive(notice, work) {
    if (busy) { $(notice).textContent = "Aguarde a mudança anterior."; return; }
    busy = true;
    try { await work(); }
    catch (e) { $(notice).textContent = e.message; }
    finally { busy = false; }
  }
  function paintBrightness() { $("brightness-value").textContent = $("brightness").value + "%"; }
  function newZone(z, groups, mode) {
    const base = "zona-" + z.section;
    let id = base;
    for (let i=2; groups.some((g) => g.id === id); i++) id = base + "-" + i;
    return { id,name:groupName(z),leds:{ranges:toRanges(z.points.map((p) => p.index))},mode };
  }
  function changeZone(updateMode, message, zoneId = S.selected) {
    const z = zoneMap.get(zoneId);
    if (!z) return;
    exclusive("notice",async () => {
      const profile = S.state.profile;
      const live = S.live && !S.groupsMock && !S.geometryMock;
      const actual = !z.unsaved;
      const collection = groupRoute(profile);
      const path = collection + "/" + encodeURIComponent(z.id);
      try {
        let result;
        if (live) {
          $("notice").textContent = "Salvando a zona…";
          if (actual) {
            const {data:latest, etag} = await api("GET",path,undefined,{withVersion:true});
            if (S.state.profile !== profile) return;
            const mode = updateMode(latest.mode);
            result = await api("PATCH",path,{mode},{ifMatch:etag?.startsWith('"') ? etag : undefined});
          } else {
            const latest = await api("GET",collection);
            if (S.state.profile !== profile) return;
            result = await api("POST",collection,newZone(z,latest,updateMode(z.mode)));
          }
        } else {
          const mode = updateMode(z.mode);
          result = actual ? { ...S.groups.find((g) => g.id === z.id),mode } : newZone(z,S.groups,mode);
        }
        if (S.state.profile !== profile) return;
        S.groups = actual ? S.groups.map((g) => g.id === result.id ? result : g)
          : [...S.groups.filter((g) => g.id !== result.id),result];
        S.state.scene = null;
        if (zoneId === S.selected) S.selected = result.id;
        renderGeometry();
        $("notice").textContent = message + (live ? " Salvo no perfil." : " Prévia [mock].");
      } catch (e) {
        if (live && [404,409,412].includes(e.status)) {
          await refreshLive().catch(() => {});
          if (e.status === 412) {
            renderControls();
            throw new ApiError(412,"A zona mudou durante o ajuste. Confira o perfil e tente novamente.");
          }
        }
        renderControls();
        throw e;
      }
    });
  }
  const poweredModes = new Map();
  function currentMode(mode, z) {
    return mode?.type === "off" ? poweredModes.get(stateNow().profile + ":" + z.id) || {type:"solid",color:z.color,brightness:1} :
      mode || {type:"solid"};
  }
  function changeColor(color, message, z) {
    if (z) changeZone((mode) => ({type:"solid",color,brightness:mode?.brightness ?? 1}),message,z.id);
  }
  function changePower(z, turnOff, message) {
    if (!z) return;
    const key = stateNow().profile + ":" + z.id;
    changeZone((mode) => {
      if (!turnOff) return currentMode(mode,z);
      if (mode && mode.type !== "off") poweredModes.set(key,mode);
      return {type:"off"};
    },message,z.id);
  }
  $("color").addEventListener("change",() => changeColor($("color").value,"Cor ajustada.",zoneMap.get(S.selected)));
  $("brightness").addEventListener("input",paintBrightness);
  $("brightness").addEventListener("change",() => {
    const z = zoneMap.get(S.selected);
    const bright = +$("brightness").value/100;
    changeZone((latest) => {
      const mode = currentMode(latest,z);
      return mode.type === "source" ? {type:"solid",color:z.color,brightness:bright} : {...mode,brightness:bright};
    },"Brilho ajustado.");
  });
  $("power").addEventListener("click",() => {
    const z = zoneMap.get(S.selected);
    const off = $("power").getAttribute("aria-checked") === "true";
    changePower(z,off,off ? "Zona desligada." : "Zona ligada.");
  });
  $("zone-picker").addEventListener("change",() => {
    $("target").dataset.pinned = "false";
    selectZone($("zone-picker").value);
  });
  for (const preset of presets) {
    const b = button("",() => changeZone(() => ({type:"solid",color:preset.color,brightness:preset.brightness}),"“" + preset.name + "” ativado."));
    const dot = mk("span",{class:"palette-dot","aria-hidden":"true"}); dot.style.setProperty("--preset",preset.color);
    b.append(dot,mk("span",{"aria-hidden":"true"},preset.icon),preset.name);
    $("preset-list").append(b);
  }
  async function activateScene(sc) {
    exclusive("notice",async () => {
      if (S.live) {
        $("notice").textContent = "Ativando a cena…";
        await api("POST","/scenes/"+encodeURIComponent(sc.id)+"/activate");
        await refreshLive();
      } else {
        S.groups = S.groups.map((g,i) => ({...g,mode:{type:"solid",color:sc.colors?.[i%sc.colors.length] || baseColors[i%baseColors.length],brightness:.9}}));
        renderGeometry();
      }
      S.state.scene = sc.id;
      renderSceneButtons();
      $("notice").textContent = "Cena “" + groupName(sc) + "” ativa." + (S.live ? "" : " Prévia [mock].");
    });
  }
  function recordRule() {
    local.set("rule." + stateNow().profile, JSON.stringify({
      event:$("event").value,effect:$("effect").value,zone:$("target").value,duration:$("duration").value
    }));
  }
  for (const id of ["event","effect","target","duration"]) $(id).addEventListener("change",() => {
    if (id === "target") $("target").dataset.pinned = "true";
    recordRule();
  });
  let testTrigger = null;
  $("trigger-form").addEventListener("submit",(ev) => {
    ev.preventDefault();
    exclusive("notice",async () => {
      const z = zoneMap.get($("target").value);
      if (!z) return;
      recordRule();
      const type = $("effect").value;
      const t = {
        id:"teste-painel-lofi", effect:{type,color:quietHex(z.mode?.color,z.color)},
        priority:50,blend:"override",duration_ms:Number($("duration").value)*1000,
        target:z.unsaved || S.groupsMock ? {leds:{ranges:toRanges(z.points.map((p) => p.index))}} : {groups:[z.id]}
      };
      if (type !== "solid") t.effect.period_ms = 1100;
      if (type === "wave") t.effect.width = .3;
      if ($("event").value) t.source = $("event").value;
      if (S.live && !S.geometryMock) {
        const result = await api("POST","/trigger",t);
        if (result?.suppressed) { $("notice").textContent = "A cena atual silenciou este teste."; return; }
        testTrigger = result?.overlay_id || t.id;
      } else {
        testTrigger = t.id;
        S.overlay = {z:z.id, type,color:t.effect.color, from:performance.now(),until:performance.now()+t.duration_ms};
        drawPreview(performance.now(),true);
      }
      $("undo").disabled = false;
      $("notice").textContent = "Teste disparado em " + groupName(z) + "." + (S.live ? "" : " Prévia [mock].");
    });
  });
  $("undo").addEventListener("click",() => exclusive("notice",async () => {
    if (!testTrigger) return;
    if (S.live && !S.geometryMock) await api("DELETE","/trigger/"+encodeURIComponent(testTrigger));
    S.overlay = null;
    testTrigger = null;
    $("undo").disabled = true;
    drawPreview(performance.now(),true);
    $("notice").textContent = "Teste desfeito. O rascunho foi mantido.";
  }));
  function addKeyboardNavigation(container) {
    container.addEventListener("keydown",(ev) => {
      const buttons = [...container.querySelectorAll("button")], i=buttons.indexOf(ev.target);
      if (i < 0) return;
      const offset = {ArrowLeft:-1,ArrowRight:1,ArrowUp:-1,ArrowDown:1}[ev.key];
      if (!offset) return;
      ev.preventDefault();
      buttons[(i+offset+buttons.length)%buttons.length].focus();
    });
  }
  for (const v of views) {
    const b = button("",(ev) => v.id === "monitor" ? openArea("monitor",ev.currentTarget) : navigateView(v.id),{"data-view":v.id,title:v.name,"aria-pressed":"false"});
    b.append(mk("span",{"aria-hidden":"true"},v.icon),v.name);
    $("views").append(b);
  }
  addKeyboardNavigation($("views"));
  addKeyboardNavigation($("zone-list"));
  $("menu").addEventListener("click",() => openMenu($("menu")));
  $("in").addEventListener("click",() => zoomAround(1.28));
  $("out").addEventListener("click",() => zoomAround(1/1.28));
  $("home").addEventListener("click",() => navigateView(""));
  $("edit").addEventListener("click",() => editMode(!S.editing));
  $("room").setAttribute("tabindex","0");
  room.addEventListener("keydown",(ev) => {
    const key = ev.key;
    if (key === "+" || key === "=") zoomAround(1.28);
    else if (key === "-") zoomAround(1/1.28);
    else if (key === "0" || key === "Escape") navigateView("");
    else if (key.startsWith("Arrow")) {
      const dx = key === "ArrowLeft" ? -.1 : key === "ArrowRight" ? .1 : 0;
      const dy = key === "ArrowUp" ? -.1 : key === "ArrowDown" ? .1 : 0;
      goCamera(fitView(camera.x+camera.w*(.5+dx),camera.y+camera.h*(.5+dy),baseRect.w/camera.w));
    } else return;
    ev.preventDefault();
  });
  document.addEventListener("keydown",(ev) => {
    if (ev.key !== "Escape" || document.querySelector("dialog[open]")) return;
    if (orderPick) endOrderPick();
    else if (S.editing) editMode(false);
    else navigateView("");
  });

  function applyStyle(value) {
    const id = styleIds.includes(value) ? value : styleIds[0];
    root.dataset.style = id;
    $("theme").value = $("settings-theme").value = id;
    local.set("style",id);
  }
  function applyScheme(value) {
    const pref = ["dark","light"].includes(value) ? value : "system";
    const mode = pref === "system" ? (prefersDark.matches ? "dark" : "light") : pref;
    root.dataset.mode = mode;
    $("settings-mode").value = pref;
    $("scheme").textContent = mode === "light" ? "☾" : "☀";
    $("scheme").setAttribute("aria-pressed",String(mode === "light"));
    local.set("scheme",pref);
    document.querySelector('meta[name="theme-color"]').content = getComputedStyle(root).getPropertyValue("--bg").trim();
  }
  for (const id of ["theme","settings-theme"]) $(id).addEventListener("change",() => applyStyle($(id).value));
  $("scheme").addEventListener("click",() => applyScheme(root.dataset.mode === "light" ? "dark" : "light"));
  $("settings-mode").addEventListener("change",() => applyScheme($("settings-mode").value));
  prefersDark.addEventListener("change",() => applyScheme(local.get("scheme")));
  const trackList = [
    { title:"Chill lofi inspired [loop edit]",file:"audio/chill-lofi.ogg" },
    { title:"Dimly lit",file:"audio/dimly-lit.mp3" },
  ];
  const music = $("music");
  let trackIndex = 0;
  function showMusic() {
    const track = trackList[trackIndex], playing = !music.paused;
    $("track-name").textContent = track.title;
    $("track-name").title = track.title;
    $("track-state").textContent = playing ? (music.muted ? "Tocando · mudo" : "Tocando") : "Pausado";
    $("play").textContent = playing ? "Ⅱ" : "▶";
    $("play").setAttribute("aria-label",playing ? "Pausar" : "Reproduzir");
    $("mute").title = music.muted ? "Ativar som" : "Silenciar música";
    $("mute").setAttribute("aria-pressed",String(music.muted));
    $("volume").value = Math.round(music.volume*100);
  }
  function playMusic() {
    if (!music.getAttribute("src")) music.src = trackList[trackIndex].file;
    music.play().catch(() => {
      if (music.paused) $("track-state").textContent = "Faixa indisponível";
    });
  }
  function stepTrack(by) {
    const playing = !music.paused;
    trackIndex = (trackIndex+by+trackList.length)%trackList.length;
    music.pause();
    music.removeAttribute("src");
    music.load();
    showMusic();
    if (playing) playMusic();
  }
  $("play").addEventListener("click",() => music.paused ? playMusic() : music.pause());
  $("prev-track").addEventListener("click",() => stepTrack(-1));
  $("next-track").addEventListener("click",() => stepTrack(1));
  $("mute").addEventListener("click",() => {
    music.muted = !music.muted;
    local.set("mute",String(music.muted));
    showMusic();
  });
  $("volume").addEventListener("input",() => {
    music.volume = +$("volume").value/100;
    local.set("volume",String(music.volume));
    showMusic();
  });
  for (const event of ["play","pause","volumechange"]) music.addEventListener(event,showMusic);
  music.addEventListener("error",() => { $("track-state").textContent = "Faixa indisponível"; });

  function settingRows(id, rows) {
    $(id).replaceChildren(...rows.map(([name,val]) => {
      const p = mk("p");
      p.append(mk("strong",{},name),mk("span",{},val));
      return p;
    }));
  }
  function renderSettings() {
    const st = stateNow(), items = [...new Set([...(S.profiles || []),st.profile].filter(Boolean))];
    const select = $("profile");
    if (JSON.stringify(items) !== select.dataset.options) {
      select.replaceChildren(...items.map((p) => mk("option",{value:p},p)));
      select.dataset.options = JSON.stringify(items);
    }
    select.value = st.profile || "";
    select.disabled = items.length < 2;
    $("global-bright").value = st.brightness ?? 100;
    $("global-value").textContent = $("global-bright").value + "%";
    paintSwitch($("global-power"),st.on !== false);
    const mode = { ambilight:"Captura da tela",moodlamp:"Lâmpada",soundvisualizer:"Visualizador de áudio" };
    settingRows("capture-info",[
      ["Modo ativo",mode[normalized(st.mode)] || st.mode || "Captura da tela [mock]"],
      ["Telas na geometria",String(S.layout?.screens?.length ?? 0)]
    ]);
    settingRows("device-info",[
      ["Dispositivo ativo",st.device || "Fita de demonstração [mock]"],["Número de LEDs",String(st.led_count ?? sceneGeometry.length)]
    ]);
    settingRows("integration-info",[
      ["Conexão com o Prismatik",simulation ? "Simulação local [mock]" : S.live ? "Conectado" : "Prévia [mock]"],
      ["Regras automáticas","Rascunho no navegador [mock]"]
    ]);
    settingRows("advanced-info",[
      ["Versão informada",st.version || "5.13 [mock]"],["Outros ajustes","Disponíveis na janela clássica"]
    ]);
    filterSettings();
  }
  function showSettings() {
    $("settings-notice").textContent = "";
    resetRestore();
    renderSettings();
    showModal(settings,$("settings-open"));
  }
  $("settings-open").addEventListener("click",showSettings);
  $("settings-search").addEventListener("input",filterSettings);
  const settingOpenStates = new Map();
  function filterSettings() {
    const q = normalized($("settings-search").value.trim());
    let match = 0;
    for (const d of $("settings-groups").querySelectorAll(":scope > details")) {
      const titleMatch = normalized(d.querySelector("summary").textContent).includes(q);
      const rows = [...d.querySelectorAll(".control,.setting-items p,.inventory-row,button")];
      let matchedRow = false;
      for (const row of rows) {
        const result = !q || titleMatch || normalized(row.textContent).includes(q);
        row.classList.toggle("search-hidden",!result);
        matchedRow ||= result && !row.hidden;
      }
      d.hidden = Boolean(q && !titleMatch && !matchedRow);
      if (!d.hidden) match++;
      if (q) {
        if (!settingOpenStates.has(d)) settingOpenStates.set(d,d.open);
        if (!d.hidden) d.open = true;
        const inv = d.querySelector(".inventory");
        if (inv && !titleMatch && inv.querySelector(".inventory-row:not(.search-hidden)")) inv.open = true;
      } else if (settingOpenStates.has(d)) {
        d.open = settingOpenStates.get(d);
        settingOpenStates.delete(d);
      }
    }
    $("settings-empty").hidden = match > 0;
  }
  function resetRestore() {
    $("restore").textContent = "Restaurar padrão";
    $("restore").dataset.confirm = "false";
    $("restore-cancel").hidden = true;
  }
  $("restore-cancel").addEventListener("click",() => { resetRestore(); $("settings-notice").textContent = "Restauração cancelada."; });
  $("restore").addEventListener("click",() => {
    if ($("restore").dataset.confirm !== "true") {
      $("restore").dataset.confirm = "true";
      $("restore").textContent = "Confirmar restauração";
      $("restore-cancel").hidden = false;
      $("settings-notice").textContent = "Restaura estilo, modo, fundo e volume deste navegador.";
      return;
    }
    applyStyle("lofi");
    applyScheme("system");
    navigateView("");
    clearScreenFile();
    setScreenLoop("stars");
    if (focusKind) goCamera(focusPose(focusKind));
    music.volume = .64;
    music.muted = true;
    local.set("volume",".64");
    local.set("mute","true");
    showMusic();
    resetRestore();
    $("settings-notice").textContent = "Preferências do quarto restauradas.";
  });
  function patchState(data, message) {
    exclusive("settings-notice",async () => {
      try {
        if (S.live) {
          $("settings-notice").textContent = "Salvando…";
          await api("PATCH","/state",data);
          if (Object.hasOwn(data,"profile")) await refreshLive();
          else S.state = { ...S.state,...data };
        } else S.state = { ...S.state,...data };
        drawPreview(performance.now(),true);
        $("settings-notice").textContent = message + (S.live ? " Salvo no Prismatik." : " Prévia [mock].");
      } finally {
        renderSettings();
      }
    });
  }
  $("profile").addEventListener("change",() => patchState({profile:$("profile").value},"Perfil trocado."));
  $("global-bright").addEventListener("input",() => { $("global-value").textContent = $("global-bright").value+"%"; });
  $("global-bright").addEventListener("change",() => patchState({brightness:+$("global-bright").value},"Brilho geral ajustado."));
  $("global-power").addEventListener("click",() => patchState({on:stateNow().on === false},"Luz geral ajustada."));

  let order = { profile:null,accepted:[],draft:[],slot:0,trial:null,expires:0,clock:0,previous:null,animation:null };
  function fallbackSegments() {
    const count = stateNow().led_count ?? sceneGeometry.length;
    const set = new Set(sceneGeometry.filter((p) => p.section === "desk").map((p) => p.index));
    const boundaries = [];
    for (let i=0;i<count;i++) {
      const latest = boundaries.at(-1);
      if (latest && set.has(i) === set.has(latest.start)) latest.end = i;
      else boundaries.push({start:i,end:i});
    }
    return boundaries;
  }
  const segmentValues = (s) => ({start:+s.start,end:+s.end,reverse:Boolean(s.reverse),offset:+s.offset||0,mirror:Boolean(s.mirror)});
  function mapOrder(segments, count) {
    const result = Array(count).fill(-1);
    for (const s of segments) {
      if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end >= count || s.start > s.end) throw new Error("Confira os números do primeiro e último LED.");
      if (!Number.isInteger(s.offset) || Math.abs(s.offset) >= count) throw new Error("Deslocamento fora do intervalo.");
      const size = s.end-s.start+1;
      const offset = ((s.offset % size)+size)%size;
      for (let index=s.start;index<=s.end;index++) {
        if (result[index] >= 0) throw new Error("Conflito: dois segmentos incluem o LED "+(index+1)+".");
        const n = (index-s.start+offset)%size;
        const physical = s.reverse ? s.end-n : s.start+n;
        result[index] = s.mirror ? s.start+s.end-physical : physical;
      }
    }
    if (result.includes(-1)) throw new Error("A ordem precisa cobrir todos os LEDs sem lacunas.");
    return result;
  }
  function displaySegment(s) {
    const desk = sceneGeometry.filter((p) => p.index >= s.start && p.index <= s.end && p.section === "desk").length;
    return (desk >= (s.end-s.start+1)/2 ? "Mesa" : "Contorno") + " · " + (s.start+1) + "–" + (s.end+1);
  }
  function updateOrderResult(res,commit = true) {
    const segments = (res?.segments || fallbackSegments()).map(segmentValues);
    if (commit && !res?.trial_id) order.accepted = segments.map(segmentValues);
    order.draft = segments;
    order.trial = res?.trial_id || null;
    order.expires = res?.expires_at_ms || 0;
    order.slot = clamp(order.slot,0,Math.max(0,segments.length-1));
    renderOrder();
    clearInterval(order.clock);
    if (order.trial) order.clock = setInterval(orderTick,250);
  }
  function orderTick() {
    if (!order.trial) return;
    const seconds = Math.ceil((order.expires-Date.now())/1000);
    if (seconds > 0) {
      $("order-subtitle").textContent = "Confirme em até " + seconds + " s";
      return;
    }
    clearInterval(order.clock);
    order.trial = null;
    updateOrderResult({segments:order.accepted});
    $("order-notice").textContent = "Tempo esgotado. Ordem anterior restaurada [mock].";
  }
  function renderOrder() {
    const count = stateNow().led_count ?? sceneGeometry.length;
    const select = $("order-segment"), list = order.draft;
    select.replaceChildren(...list.map((s,i) => mk("option",{value:i},displaySegment(s))));
    select.value = String(order.slot);
    const s = list[order.slot];
    if (s) {
      $("order-start").value = s.start+1;
      $("order-end").value = s.end+1;
      $("order-reverse").value = String(s.reverse);
      $("order-offset").value = s.offset;
      $("order-mirror").checked = s.mirror;
    }
    for (const id of ["order-start","order-end"]) $(id).max = count;
    $("order-offset").min = -(count-1);
    $("order-offset").max = count-1;
    for (const id of ["order-start","order-end","order-reverse","order-offset","order-mirror","order-pick","order-save","order-desk","order-cw","order-ccw"]) $(id).disabled = !s || Boolean(order.trial);
    $("order-undo").disabled = !s;
    $("order-test").disabled = !s;
    $("order-confirm").hidden = !order.trial;
    $("order-save").hidden = Boolean(order.trial);
    if (!order.trial) $("order-subtitle").textContent = "Prévia de ordem [mock]";
    else orderTick();
    paintOrderSummary();
  }
  function paintOrderSummary() {
    const s = order.draft[order.slot], prev = order.accepted[order.slot];
    if (!s) { $("order-preview").textContent = "Nenhum segmento neste perfil."; return; }
    const firstLast = (a) => {
      if (!a) return "—";
      const sequence = mapOrder([{...a,start:0,end:a.end-a.start}],a.end-a.start+1);
      const first = sequence[0]+a.start+1, last = sequence.at(-1)+a.start+1;
      return first + " → " + last;
    };
    try {
      const count = stateNow().led_count ?? sceneGeometry.length;
      mapOrder(order.draft,count);
      const desc = (a) => firstLast({...a,offset:(a.offset || 0)%(a.end-a.start+1)});
      $("order-preview").textContent = "Antes " + (prev ? desc(prev) : "—") + " · Agora " + desc(s);
    } catch (e) {
      $("order-preview").textContent = e.message;
    }
  }
  function updateOrderField() {
    if (!order.draft[order.slot]) return;
    order.draft[order.slot] = {
      start:+$("order-start").value-1,end:+$("order-end").value-1,reverse:$("order-reverse").value === "true",
      offset:+$("order-offset").value,mirror:$("order-mirror").checked
    };
    paintOrderSummary();
  }
  function openOrder(from) {
    const profile = stateNow().profile;
    const selected = pointMap.get(zoneMap.get(S.selected)?.points[0]?.index);
    if (order.profile !== profile) {
      clearInterval(order.clock);
      order = {...order,profile,slot:0,accepted:[],previous:null,trial:null};
      updateOrderResult(null);
    }
    $("order-notice").textContent = "";
    showModal(orderDialog,from);
    if (selected) {
      const idx = order.draft.findIndex((s) => selected.index >= s.start && selected.index <= s.end);
      if (idx >= 0) { order.slot = idx; renderOrder(); }
    }
  }
  $("zone-order").addEventListener("click",() => openOrder(modalOrigins.get(popup)||$("menu")));
  $("settings-order").addEventListener("click",() => openOrder($("settings-open")));
  $("order-segment").addEventListener("change",() => { order.slot=+$("order-segment").value; renderOrder(); });
  for (const id of ["order-start","order-end","order-reverse","order-offset","order-mirror"]) $(id).addEventListener("input",updateOrderField);
  function orderPreset(which) {
    const candidates = order.draft.map((s,i) => ({s,i,desk:sceneGeometry.filter((p) => p.section === "desk" && p.index >= s.start && p.index <= s.end).length}));
    const match = which === "desk" ? candidates.sort((a,b)=>b.desk-a.desk).find((x) => x.desk)
      : candidates.find((x) => x.desk < (x.s.end-x.s.start+1)/2);
    if (!match) { $("order-notice").textContent = "Esse segmento não está neste perfil."; return; }
    order.slot = match.i;
    order.draft[match.i] = {...match.s,reverse:which !== "cw",offset:0,mirror:false};
    $("order-notice").textContent = "Prévia ajustada. Teste para conferir.";
    renderOrder();
  }
  for (const id of ["desk","cw","ccw"]) $("order-"+id).addEventListener("click",() => orderPreset(id));
  function markOrderPath(a,b) {
    const layer = $("order-points"), arrow = $("order-arrow");
    layer.replaceChildren();
    arrow.setAttribute("visibility",a && b ? "visible" : "hidden");
    if (a && b) {
      const dx = b.x-a.x, dy=b.y-a.y, d=Math.hypot(dx,dy)||1;
      const u=dx/d,v=dy/d,k=11*ledScale;
      arrow.setAttribute("d",`M ${a.x} ${a.y} L ${b.x} ${b.y} m ${(-u+v*.48)*k} ${(-v-u*.48)*k} L ${b.x} ${b.y} l ${(-u-v*.48)*k} ${(-v+u*.48)*k}`);
    }
    [a,b].forEach((p,i) => {
      if (!p) return;
      const label = svg("text",{x:p.x+5*ledScale,y:p.y-10*ledScale,"font-size":11*ledScale});
      label.textContent = (i === 0 ? "Início " : "Fim ") + (p.index+1);
      layer.append(label);
    });
  }
  $("order-pick").addEventListener("click",() => {
    if (S.editing) editMode(false);
    orderPick = { first:null,origin:modalOrigins.get(orderDialog) };
    focusKind = "both";
    activateFocus("both",orderDialog);
    document.body.dataset.focusMode = "picking";
    if (mobileQuery.matches) {
      room.setAttribute("preserveAspectRatio","xMidYMid meet");
      goCamera({x:257,y:199,w:639,h:230},false);
    } else goCamera(focusPose("both"),false);
    orderDialog.close();
    room.dataset.edit = "true";
    room.focus({preventScroll:true});
    setHint("Clique no primeiro LED; Esc cancela.");
  });
  function endOrderPick(restore = true) {
    const from = orderPick?.origin || $("menu");
    orderPick = null;
    room.dataset.edit = "false";
    setHint("");
    if (restore) { showModal(orderDialog,from); renderOrder(); }
    else markOrderPath();
  }
  function pickOrderPoint(i) {
    if (orderPick.first === null) {
      orderPick.first = i;
      markOrderPath(pointMap.get(i));
      setHint("Agora clique no último LED; Esc cancela.");
      return;
    }
    const a = orderPick.first, b = i, old=order.draft[order.slot];
    const draft = { ...old,start:Math.min(a,b),end:Math.max(a,b),reverse:a>b };
    const before = old.start < draft.start ? [segmentValues({start:old.start,end:draft.start-1})] : [];
    const after = old.end > draft.end ? [segmentValues({start:draft.end+1,end:old.end})] : [];
    if (draft.start >= old.start && draft.end <= old.end) {
      order.draft.splice(order.slot,1,...before,draft,...after);
      order.slot += before.length;
    } else order.draft[order.slot] = draft;
    markOrderPath(pointMap.get(a),pointMap.get(b));
    endOrderPick();
  }
  $("order-test").addEventListener("click",() => exclusive("order-notice",async () => {
    const count = stateNow().led_count ?? sceneGeometry.length, mapping = mapOrder(order.draft,count);
    const segment = order.draft[order.slot];
    const vertices = [mapping[segment.start],mapping[segment.end]];
    markOrderPath(...vertices.map((index) => pointMap.get(index)));
    order.animation = { indices:mapping,start:performance.now(),duration:3000 };
    drawPreview(performance.now(),true);
    $("order-notice").textContent = "Teste no desenho [mock].";
  }));
  $("order-save").addEventListener("click",() => exclusive("order-notice",async () => {
    mapOrder(order.draft,stateNow().led_count ?? sceneGeometry.length);
    updateOrderResult({segments:order.draft,trial_id:"local",expires_at_ms:Date.now()+15000},false);
    $("order-notice").textContent = "Confira a ordem e confirme. Se o tempo acabar, o ajuste volta.";
  }));
  $("order-confirm").addEventListener("click",() => exclusive("order-notice",async () => {
    if (!order.trial) return;
    order.previous = order.accepted.map(segmentValues);
    updateOrderResult({segments:order.draft});
    $("order-notice").textContent = "Ordem mantida nesta prévia [mock].";
  }));
  $("order-undo").addEventListener("click",() => exclusive("order-notice",async () => {
    const target = order.trial ? order.accepted : order.previous || order.accepted;
    order.previous = null;
    updateOrderResult({segments:target});
    order.animation = null;
    markOrderPath();
    $("order-notice").textContent = "Alteração da ordem desfeita [mock].";
  }));

  const LED_STEP = 1000/15;
  let animationTimer = 0, lastAmbientFrame = -1;
  const ambient = { fairy:$("fairy"),rain:$("rain"),cat:$("cat"),steam:$("steam") };
  function paintDot(p, color, strength) {
    const mode = root.dataset.mode;
    const key = color + "|" + strength.toFixed(2) + "|" + mode;
    if (p.paint === key) return;
    p.paint = key;
    const lit = strength > .02;
    p.dot.setAttribute("fill",lit ? color : mode === "light" ? "#736271" : "#554459");
    p.dot.setAttribute("fill-opacity",lit ? Math.max(.28,strength) : .72);
    p.dot.style.setProperty("--led-ring",lit ? (mode === "light" ? "#493244" : "#ffe6cf") : "#654b62");
    p.glow.setAttribute("fill",color);
    p.glow.setAttribute("opacity",lit ? Math.min(.39,strength*.42) : 0);
    const mobile = mobileDots.get(p.index);
    if (mobile) mobile.setAttribute("fill",lit ? color : "#726476");
  }
  const biasLights = {
    monitor: { gradient:$("monitor-bias"), surfaces:[$("monitor-wall-light")], gains:[.82] },
    desk: { gradient:$("desk-bias"), surfaces:[$("desk-wall-light"),$("rug-light")], gains:[.51,.87] },
  };
  function hexRgb(color) {
    const value = Number.parseInt(color.slice(1),16);
    return [value >> 16,(value >> 8) & 255,value & 255];
  }
  function rainbowRgb(hue) {
    const channel = (offset) => {
      const sector = (offset+hue/30)%12;
      return Math.round(255*(.72-.2464*Math.max(-1,Math.min(sector-3,9-sector,1))));
    };
    return [channel(0),channel(8),channel(4)];
  }
  function paintBias(section, sample) {
    const light = biasLights[section];
    const peak = Math.max(sample.r,sample.g,sample.b);
    const level = sample.count ? peak/(255*sample.count) : 0;
    const strength = Math.pow(clamp(level,0,1),.68)*(root.dataset.mode === "light" ? .76 : 1);
    // Variations below a few RGB levels are invisible in the reflected light.
    if (peak) {
      const rgb = [sample.r,sample.g,sample.b].map((channel) => Math.round(channel/peak*255));
      if (!light.rgb || rgb.some((channel,i) => Math.abs(channel-light.rgb[i])>=5)) {
        light.rgb = rgb;
        light.gradient.style.color = "rgb("+rgb.join(",")+")";
      }
    }
    const wasLit = light.strength > 0, isLit = strength > 0;
    if (wasLit !== isLit || Math.abs(strength-light.strength)>=.012) {
      light.strength = strength;
      light.surfaces.forEach((surface,i) => surface.setAttribute("opacity",(strength*light.gains[i]).toFixed(3)));
    }
  }
  function drawPreview(now, force = false) {
    if (document.hidden) return;
    const isReduced = reducedMotion.matches;
    if (isReduced && !force) return;
    const showLeds=Boolean(force || focusKind || orderPick || S.editing || room.dataset.zoomed === "true");
    const ambientFrame = Math.floor(now/220);
    const animateRoom = !isReduced && lastAmbientFrame !== ambientFrame;
    const updateBias = force || animateRoom;
    if ((showLeds || updateBias) && pendingFrame && !isReduced) {
      const frame = safe(() => atob(pendingFrame),null);
      if (frame) S.frame = frame;
      pendingFrame = null;
    }
    const t = isReduced ? 0 : now/1000;
    if (S.overlay && now >= S.overlay.until) S.overlay = null;
    const running = order.animation && now-order.animation.start <= order.animation.duration ? order.animation : null;
    if (!running) order.animation = null;
    const runningIndex = running
      ? running.indices[isReduced ? 0 : clamp(Math.floor((now-running.start)*running.indices.length/running.duration),0,running.indices.length-1)]
      : -1;
    const st = stateNow(), frame = S.wsUp && !isReduced ? S.frame : null;
    if (showLeds || updateBias) {
      const bias = {
        monitor:{r:0,g:0,b:0,count:0},
        desk:{r:0,g:0,b:0,count:0},
      };
      for (const p of pointMap.values()) {
        const colIdx = p.index*3;
        const m = p.z?.mode || {};
        let color = quietHex(m.color,p.z?.color || "#ffb884"), opacity = 0, rgb;
        if (running) {
          color = p.index === runningIndex ? "#fff6d4" : "#846c8e";
          opacity = p.index === runningIndex ? 1 : .07;
        } else if (p.enabled && st.on !== false) {
          if (frame && colIdx+2 < frame.length) {
            rgb = [frame.charCodeAt(colIdx),frame.charCodeAt(colIdx+1),frame.charCodeAt(colIdx+2)];
            opacity = Math.max(...rgb) > 0 ? 1 : 0;
          } else {
            const wave = Math.sin(t*1.3+p.index*.07);
            opacity = m.type === "off" ? 0 : (m.brightness ?? 1)*(.88+.12*wave)*(st.brightness ?? 100)/100;
            if (m.type === "rainbow") rgb = rainbowRgb((p.index*7+t*35)%360);
            const overlay = S.overlay?.z === p.z?.id ? S.overlay : null;
            if (overlay) {
              color = overlay.color;
              rgb = undefined;
              const phase = (isReduced ? 0 : (now-overlay.from)/1100)*2*Math.PI;
              opacity = overlay.type === "solid" || isReduced ? 1 : .49+.51*Math.cos(phase - (overlay.type === "wave" ? p.index*.12 : 0));
            }
          }
        }
        if (showLeds) paintDot(p,rgb ? "rgb("+rgb.join(",")+")" : color,opacity);
        if (updateBias) {
          const sample = bias[p.section];
          const [r,g,b] = rgb || (opacity > 0 ? hexRgb(color) : [0,0,0]);
          sample.r += r*opacity;
          sample.g += g*opacity;
          sample.b += b*opacity;
          sample.count++;
        }
      }
      if (updateBias) {
        paintBias("monitor",bias.monitor);
        paintBias("desk",bias.desk);
      }
    }
    if (animateRoom) {
      lastAmbientFrame = ambientFrame;
      ambient.fairy.style.opacity = (.84+.16*Math.sin(t*.9)).toFixed(3);
      ambient.rain.setAttribute("transform","translate("+(-t*2%6).toFixed(2)+" "+(t*6%18).toFixed(2)+")");
      ambient.steam.style.opacity=(.52+.29*Math.sin(t*1.7)).toFixed(3);
      ambient.cat.setAttribute("transform","translate(0 "+(.68*Math.sin(t*1.43)).toFixed(2)+")");
      if (room.dataset.loop === "stars") $("screen-stars").style.opacity=(.58+.42*Math.sin(t*.8)**2).toFixed(3);
      else if (room.dataset.loop === "waves") $("screen-wave").setAttribute("transform","translate("+(-18*Math.sin(t*.61)).toFixed(2)+" 0)");
      else $("screen-embers").setAttribute("transform","translate(0 "+(-6*Math.sin(t*.91)).toFixed(2)+")");
    }
  }
  function scheduleAnimation() {
    clearInterval(animationTimer);
    syncScreenMedia();
    if (document.hidden) { cancelAnimationFrame(cameraAnimation); return; }
    if (reducedMotion.matches) {
      if (cameraAnimation) { cancelAnimationFrame(cameraAnimation); cameraAnimation=0; }
      ambient.fairy.style.opacity = "";
      ambient.rain.removeAttribute("transform");
      ambient.steam.style.opacity = "";
      ambient.cat.removeAttribute("transform");
      $("screen-stars").style.opacity="";
      $("screen-wave").removeAttribute("transform");
      $("screen-embers").removeAttribute("transform");
    }
    lastAmbientFrame = -1;
    drawPreview(performance.now(),true);
    animationTimer = setInterval(() => drawPreview(performance.now()),LED_STEP);
  }
  document.addEventListener("visibilitychange",scheduleAnimation);
  reducedMotion.addEventListener("change",scheduleAnimation);

  let connectedOnce = false;
  async function fixtureData() {
    if (fixture) return fixture;
    const res = await fetch(fixtureURL);
    if (!res.ok) throw new Error("A prévia do quarto não foi encontrada.");
    fixture = await res.json();
    return fixture;
  }
  async function startOffline(problem = "") {
    try {
      const data = await fixtureData();
      Object.assign(S,{ state:structuredClone(data.state),layout:data.layout,groups:structuredClone(data.groups),
        scenes:structuredClone(data.scenes),profiles:[],live:false,wsUp:false,frame:null,geometryMock:false,groupsMock:false });
      renderGeometry();
      renderSettings();
      updateConnection(problem);
    } catch {
      updateConnection("Prévia indisponível. Abra pelo Prismatik.");
    }
  }
  async function refreshLive() {
    const serial = ++snapshotSerial;
    const st = await api("GET","/state");
    if (!st?.profile || !Number.isInteger(st.led_count)) throw new ApiError(0,"O estado não chegou completo.");
    const optional = (path) => api("GET",path).catch((e) => {
      if (e.status === 401) throw e;
      return null;
    });
    const [layout,groups,scenes,profiles] = await Promise.all([
      optional("/layout"), optional(groupRoute(st.profile)), optional("/scenes"), optional("/profiles")
    ]);
    if (serial !== snapshotSerial) return;
    const missingLayout = !Array.isArray(layout?.leds);
    let resolved = layout;
    if (missingLayout) {
      const data = await fixtureData();
      if (st.led_count === data.state.led_count) resolved = data.layout;
      else resolved = {screens:[],leds:[]};
    }
    const sameProfile = S.state?.profile === st.profile;
    const resolvedGroups = Array.isArray(groups) ? groups : missingLayout && resolved.leds.length ? (await fixtureData()).groups : [];
    if (serial !== snapshotSerial) return;
    Object.assign(S,{state:st,layout:resolved,groups:resolvedGroups,scenes:Array.isArray(scenes) ? scenes : scenes?.scenes || [],
      profiles:(profiles?.profiles || []).map((p)=>typeof p === "string" ? p : p.name).filter(Boolean),
      live:true,geometryMock:missingLayout,groupsMock:groups === null});
    if (!sameProfile) {
      S.selected=null;
      S.frame=pendingFrame=null;
      S.overlay=null;
      testTrigger=null;
      $("undo").disabled=true;
      $("target").dataset.pinned="false";
      markOrderPath();
    }
    if (!S.state.scene && scenes?.active) S.state.scene=scenes.active;
    renderGeometry();
    renderSettings();
    updateConnection();
  }
  function queueRecon() {
    if (!TOKEN) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWs,reconnectMs);
    reconnectMs = Math.min(reconnectMs*2,15000);
  }
  function connectWs() {
    if (simulation || !TOKEN) return;
    const socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://")+location.host+"/ws");
    ws = socket;
    socket.onopen = () => socket.send(JSON.stringify({type:"auth",token:TOKEN}));
    socket.onmessage = (ev) => {
      const msg = safe(() => JSON.parse(ev.data),null);
      if (!msg) return;
      if (msg.type === "auth_ok") {
        reconnectMs = 950;
        S.wsUp = true;
        socket.send(JSON.stringify({type:"subscribe",channels:["frame","events"]}));
        updateConnection();
        if (connectedOnce || !S.live) refreshLive().catch(()=>{});
        connectedOnce = true;
      } else if (msg.type === "frame" && !document.hidden && !reducedMotion.matches) {
        pendingFrame = msg.rgb;
      } else if (msg.type === "event") {
        const {event,data} = msg;
        if (event === "status.changed" && S.state && typeof data?.on === "boolean") {
          S.state.on = data.on;
          renderSettings();
          drawPreview(performance.now(),true);
        } else if (event === "profile.changed" || event === "scene.changed" || event?.startsWith("led_order.")) {
          if (!busy) refreshLive().catch(()=>{});
        } else if (event === "overlay.ended" && testTrigger && (data?.id === testTrigger || data?.overlay_id === testTrigger)) {
          testTrigger = null;
          $("undo").disabled = true;
        }
      }
    };
    socket.onclose = (ev) => {
      S.wsUp = false;
      S.frame = pendingFrame = null;
      if (ev.code === 1008 && /unauthorized/i.test(ev.reason)) { showLogin(); return; }
      if (S.live) updateConnection();
      queueRecon();
    };
  }

  function installInventory(inventory) {
    const buckets = { "Aparência":0,"Captura":1,"Dispositivo":2,"Integrações":3,"Avançado":4 };
    const details = [...$("settings-groups").children];
    const sections = details.map((d) => {
      const group = mk("details",{class:"inventory"});
      group.append(mk("summary",{},"Opções da janela clássica [mock]"));
      d.append(group);
      return group;
    });
    for (const [bucket,key,type,range,description] of inventory) {
      const row = mk("div",{class:"inventory-row"});
      row.append(mk("strong",{},description),mk("small",{},key+" · "+type+" · "+range));
      sections[buckets[bucket] ?? 4].append(row);
    }
  }
  async function init() {
    applyStyle(local.get("style"));
    applyScheme(local.get("scheme"));
    const volume = local.get("volume");
    music.volume = volume === null ? .64 : clamp(Number(volume)||0,0,1);
    music.muted = local.get("mute") !== "false";
    showMusic();
    setScreenLoop(local.get("screen-loop"));
    installInventory(inventory);
    scheduleAnimation();
    if (simulation) { await startOffline(); return; }
    readToken();
    if (!TOKEN) { await startOffline(); return; }
    try { await refreshLive(); }
    catch (e) {
      const offlineMessage = e.status === 401 ? "Acesso expirado. Reabra pelo Prismatik." : "Sem resposta do Prismatik.";
      await startOffline(offlineMessage);
    }
    if (TOKEN) connectWs();
  }

  const mobileQuery = matchMedia("(max-width:780px)");
  const stage = document.querySelector(".stage");
  let focusKind = "", leaveTimer = 0;
  const mobileDots = new Map();
  const zoneFor = (section) => {
    const matches = [...zoneMap.values()].filter((z) => z.section === section);
    return matches.find((z) => z.id === S.selected) || matches[0];
  };
  function renderMobileLeds() {
    const preview = $("mobile-leds");
    const type = focusKind || "monitor";
    const box = type === "desk" ? [285,371,566,50] : type === "both" ? [285,197,566,218] : [440,199,320,190];
    preview.setAttribute("viewBox",box.join(" "));
    preview.replaceChildren();
    mobileDots.clear();
    if (!mobileQuery.matches) return;
    const sections = type === "both" ? ["monitor","desk"] : [type];
    for (const section of sections) {
      const rect = section === "desk"
        ? { x:290,y:386,width:549,height:23,rx:5 }
        : { x:466,y:223,width:271,height:147,rx:9 };
      preview.append(svg("rect",{ ...rect,fill:"#241d32",stroke:"#97748b","stroke-width":"2" }));
    }
    for (const p of pointMap.values()) {
      if (!sections.includes(p.section)) continue;
      const dot = svg("circle",{cx:p.x,cy:p.y,r:type === "both" ? 4.5 : 3,fill:p.dot.getAttribute("fill")||"#bc8b9c"});
      preview.append(dot);
      mobileDots.set(p.index,dot);
    }
  }
  function placeControls() {
    if (!focusKind || mobileQuery.matches) return;
    const box = $("screen-anchor").getBoundingClientRect(), width = innerWidth, height = innerHeight;
    const position = (x,y,w,h) => {
      root.style.setProperty("--focus-left",x+"px");
      root.style.setProperty("--focus-top",y+"px");
      root.style.setProperty("--focus-width",w+"px");
      root.style.setProperty("--focus-height",h+"px");
    };
    if (focusKind === "desk") {
      const edge = new DOMPoint(289,392).matrixTransform(room.getScreenCTM());
      const windowRight = room.querySelector('#section-hits [data-view="window"]').getBoundingClientRect().right;
      const bottom = clamp(edge.y-22,Math.min(190,height-12),height-12);
      const heightLimit = Math.min(420,bottom-12);
      const left = Math.max(windowRight+16,width*.31);
      position(left,bottom-heightLimit,Math.min(840,width-left-20),heightLimit);
      return;
    }
    const left = clamp(box.left,4,width-210);
    const top = clamp(box.top,4,height-169);
    position(left,top,Math.min(width-left-4,Math.max(205,box.width)),Math.min(height-top-4,Math.max(165,box.height)));
    if (focusKind === "both") {
      const edge = new DOMPoint(310,391).matrixTransform(room.getScreenCTM());
      const dockWidth = Math.min(480,width*.59);
      root.style.setProperty("--dock-left",((width-dockWidth)/2)+"px");
      root.style.setProperty("--dock-top",clamp(edge.y+22,88,height-82)+"px");
      root.style.setProperty("--dock-width",dockWidth+"px");
    }
  }
  function focusPose(type) {
    const w = stage.clientWidth,h = stage.clientHeight;
    const scale = Math.max(w/baseRect.w,h/baseRect.h);
    if (type === "monitor") return fitView(601,300,clamp(Math.min(w*.82/270,h*.84/175)/scale,1,4));
    if (type === "desk") return fitView(568,385,clamp(Math.min(w*.88/550,h*.95/245)/scale,1,4));
    return fitView(567,294,clamp(Math.min(w*.9/575,h*.66/205)/scale,1,4));
  }
  function activateFocus(type, dialog) {
    clearTimeout(leaveTimer);
    const switched = focusKind !== type;
    focusKind=type;
    room.setAttribute("preserveAspectRatio","xMidYMid slice");
    document.body.dataset.focusMode=type;
    const pane = dialog.querySelector(".popup-inner");
    if (switched) pane.scrollTop=0;
    let nav = pane.querySelector(".focus-controls");
    if (!nav) {
      nav = $("focus-controls").content.firstElementChild.cloneNode(true);
      pane.prepend(nav);
      const back = nav.querySelector("[data-focus-back]");
      back.addEventListener("click",() => dialog.close());
      let touchY = null;
      back.addEventListener("pointerdown",(ev) => {
        if (ev.pointerType !== "touch") return;
        touchY=ev.clientY;
        back.setPointerCapture(ev.pointerId);
      });
      back.addEventListener("pointerup",(ev) => {
        if (touchY !== null && ev.clientY-touchY > 48) dialog.close();
        touchY=null;
      });
      back.addEventListener("pointercancel",() => { touchY=null; });
      for (const b of nav.querySelectorAll("[data-focus-mode]")) b.addEventListener("click",() => {
        const next=b.dataset.focusMode;
        const z = zoneFor(next === "desk" ? "desk" : "monitor");
        if (z) selectZone(z.id);
        activateFocus(next,dialog);
      });
    }
    for (const b of nav.querySelectorAll("[data-focus-mode]")) b.setAttribute("aria-pressed",String(b.dataset.focusMode === type));
    goCamera(focusPose(type));
    placeControls();
    renderMobileLeds();
    paintDock();
  }
  function leaveFocus() {
    if (!focusKind) return;
    focusKind="";
    room.setAttribute("preserveAspectRatio","xMidYMid slice");
    markOrderPath();
    goCamera(baseRect);
    const release = () => { if (!focusKind) { delete document.body.dataset.focusMode; showCamera(baseRect); } };
    if (reducedMotion.matches || document.hidden) release();
    else leaveTimer=setTimeout(release,330);
  }
  function openArea(type,from) {
    const z = zoneFor(type);
    if (z) selectZone(z.id);
    openMenu(from);
    if (focusKind !== type) activateFocus(type,popup);
  }
  function paintDock() {
    const z=zoneFor("desk");
    $("desk-dock").hidden=focusKind!=="both" || !z;
    if (!z) return;
    $("desk-dock-label").textContent=z.points.length+" LEDs";
    $("dock-color").value=quietHex(z.mode?.color,z.color);
    paintSwitch($("dock-power"),z.mode?.type !== "off");
  }
  $("dock-now").addEventListener("click",() => {
    const z=zoneFor("desk");
    if (!z) return;
    selectZone(z.id);
    selectTab("now");
    activateFocus("desk",popup);
    $("zone-picker").focus();
  });
  $("dock-color").addEventListener("change",() => {
    changeColor($("dock-color").value,"Cor da mesa ajustada.",zoneFor("desk"));
  });
  $("dock-power").addEventListener("click",() => {
    const z=zoneFor("desk");
    if (!z) return;
    const on = z.mode?.type !== "off";
    changePower(z,on,on ? "Mesa desligada." : "Mesa ligada.");
  });
  $("screen-order").addEventListener("click",() => openOrder(modalOrigins.get(popup)||$("menu")));
  $("screen-settings").addEventListener("click",showSettings);
  mobileQuery.addEventListener("change",() => {
    renderMobileLeds();
    if (focusKind) goCamera(focusPose(focusKind));
  });

  const screenImage=$("screen-image"),screenStill=$("screen-still");
  let imageRead=0;
  function setScreenLoop(value) {
    const id = ["stars","waves","embers"].includes(value) ? value : "stars";
    room.dataset.loop=id;
    $("screen-loop").value=id;
    local.set("screen-loop",id);
  }
  function clearScreenFile() {
    imageRead++;
    screenImage.removeAttribute("src");
    $("custom-screen").setAttribute("hidden","");
    $("custom-screen").style.display="none";
    screenImage.hidden=screenStill.hidden=true;
    $("screen-file").value="";
    $("remove-screen-file").hidden=true;
  }
  function syncScreenMedia() {
    if (!screenImage.getAttribute("src")) return;
    const freeze = document.hidden || reducedMotion.matches;
    screenImage.hidden=freeze;
    screenStill.hidden=!freeze;
    if (freeze && screenImage.complete && screenImage.naturalWidth) {
      const ctx=screenStill.getContext("2d");
      const w=screenImage.naturalWidth,h=screenImage.naturalHeight;
      const scale=Math.max(screenStill.width/w,screenStill.height/h);
      ctx.drawImage(screenImage,(screenStill.width-w*scale)/2,(screenStill.height-h*scale)/2,w*scale,h*scale);
    }
  }
  $("screen-loop").addEventListener("change",() => { clearScreenFile(); setScreenLoop($("screen-loop").value); });
  $("remove-screen-file").addEventListener("click",clearScreenFile);
  $("screen-file-pick").addEventListener("click",() => $("screen-file").click());
  $("screen-file").addEventListener("change",() => {
    const image=$("screen-file").files[0];
    if (!image) return;
    clearScreenFile();
    const generation=imageRead;
    if (!["image/png","image/jpeg","image/webp","image/gif","image/avif"].includes(image.type)) {
      $("settings-notice").textContent="Escolha uma imagem PNG, JPEG, WebP, GIF ou AVIF.";
      return;
    }
    const reader=new FileReader();
    reader.addEventListener("load",() => {
      if (generation !== imageRead) return;
      $("custom-screen").removeAttribute("hidden");
      $("custom-screen").style.display="inline";
      $("remove-screen-file").hidden=false;
      screenImage.hidden=false;
      screenImage.src=reader.result;
      $("settings-notice").textContent="Fundo local selecionado para esta sessão.";
      syncScreenMedia();
    });
    reader.addEventListener("error",() => { $("settings-notice").textContent="Não foi possível ler esta imagem."; });
    reader.readAsDataURL(image);
  });
  screenImage.addEventListener("load",syncScreenMedia);
  screenImage.addEventListener("error",() => {
    if (screenImage.getAttribute("src")) $("settings-notice").textContent="Esta imagem não abriu no navegador.";
  });

  // Ranga, inventário 5.13: descrições de referência, sem leitura de valores privados.
  const inventory = [
    ["Avançado","MainConfigVersion","texto de versão","4.0 atual; migrações 1.0→2.0→3.0→4.0","Versão interna do esquema de armazenamento."],
    ["Aparência","ProfileLast","nome de perfil","Nome de arquivo .ini; API só ativa perfil existente","Persiste o perfil selecionado; carrega modo, geometria e parâmetros do perfil."],
    ["Avançado","Language","enum texto","<System>, English, Russian, Ukrainian, Portuguese (Brazil)","Idioma da janela Qt."],
    ["Avançado","DebugLevel","inteiro","0–3 na UI (inicialização aceita int não negativo)","Verbosidade dos logs."],
    ["Avançado","IsExpertMode","booleano","false / true","Modo Básico/Especialista da janela Qt."],
    ["Dispositivo","IsKeepLightsOnAfterExit","booleano","false / true","Manter luz durante o evento de saída do programa."],
    ["Dispositivo","IsKeepLightsOnAfterLock","booleano","false / true","Manter luz durante o evento de bloqueio da sessão."],
    ["Dispositivo","IsKeepLightsOnAfterSuspend","booleano","false / true","Manter luz durante o evento de suspensão do sistema."],
    ["Dispositivo","IsKeepLightsOnAfterScreenOff","booleano","false / true","Manter luz durante o evento de desligamento do monitor."],
    ["Dispositivo","IsPingDeviceEverySecond","booleano","false / true","Consulta de presença do Lightpack enquanto luz está ligada."],
    ["Avançado","IsUpdateFirmwareMessageShown","booleano","false / true","Marca interna de aviso de firmware exibido."],
    ["Dispositivo","ConnectedDevice","enum texto","Lightpack, Adalight, Ardulight, Virtual, DRGB, DNRGB, WARLS; AlienFx se compilado","Seleciona o adaptador de saída. A troca direta do gerenciador não está ligada ao sinal do setter."],
    ["Avançado","SupportedDevices","lista em texto CSV","Dispositivos compilados","Metadado derivado e regravado na inicialização; getter consulta a constante de compilação."],
    ["Integrações","CheckForUpdates","booleano","false / true","Habilita a checagem automática executada na abertura da janela Qt."],
    ["Integrações","InstallForUpdates","booleano","false / true","Preferência do instalador de atualizações; controle oculto em configurações de compilação."],
    ["Avançado","AutoUpdatingVersion","texto","Versão de atualização ou vazio","Marcador mantido pelo atualizador."],
    ["Avançado","HotKeys/{ação}","QKeySequence em texto","Sequência Qt; Undefined para limpar","Família de atalhos com getter/setter; conexão Qt comentada."],
    ["Integrações","API/IsEnabled","booleano","false / true","Liga API TCP legada (padrão 3636). O botão de gerar chave grava API/AuthKey."],
    ["Integrações","API/ListenOnlyOnLoInterface","booleano","false / true","Limita o bind da API TCP legada ao loopback."],
    ["Integrações","API/Port","inteiro","Porta TCP 1–65535; handler Qt só verifica conversão para int","Porta da API TCP legada."],
    ["Integrações","WebApi/IsEnabled","booleano","false / true","Liga servidor HTTP/WebSocket se compilado com WEBAPI_SUPPORT."],
    ["Integrações","WebApi/Port","inteiro","1–65535; getter cai em 3637 para valor inválido","Porta HTTP/WebSocket; configura o listener."],
    ["Integrações","WebApi/AllowedOrigins","lista em texto CSV","Origens separadas por vírgula; remove espaços externos e vazios","Origens web adicionais aceitas."],
    ["Integrações","WebApi/AllowLan","booleano","false / true","Permite bind na rede; padrão loopback."],
    ["Dispositivo","Adalight/NumberOfLeds","inteiro","1–511 no assistente; setter sem validação de faixa","Adalight: Quantidade de índices enviados; não define a ordem dos índices."],
    ["Dispositivo","Adalight/LedMilliAmps","inteiro","1–100 mA na UI; setter sem validação de faixa","Adalight: Estimativa de corrente por LED usada no limite de potência."],
    ["Dispositivo","Adalight/PowerSupplyAmps","decimal","0–99,99 A na UI Qt, passo 0,1; setter sem validação de faixa","Adalight: Limite de corrente total da fonte aplicado em software."],
    ["Dispositivo","Adalight/SerialPort","texto","Nome/caminho de porta serial disponível","Adalight: Porta da controladora."],
    ["Dispositivo","Adalight/BaudRate","inteiro em texto","9600, 57600, 115200, 128000, 153600, 230400, 256000, 460800, 500000, 921600, 1000000, 1500000, 2000000 na UI","Adalight: Velocidade serial; o compositor também recalcula o limite de quadros."],
    ["Dispositivo","Adalight/ColorSequence","enum texto","RGB, RBG, GRB, GBR, BRG, BGR na UI","Adalight: Ordem dos canais de cada LED."],
    ["Dispositivo","Ardulight/NumberOfLeds","inteiro","1–255 no assistente; setter sem validação de faixa","Ardulight: Quantidade de índices enviados; não define a ordem dos índices."],
    ["Dispositivo","Ardulight/LedMilliAmps","inteiro","1–100 mA na UI; setter sem validação de faixa","Ardulight: Estimativa de corrente por LED usada no limite de potência."],
    ["Dispositivo","Ardulight/PowerSupplyAmps","decimal","0–99,99 A na UI Qt, passo 0,1; setter sem validação de faixa","Ardulight: Limite de corrente total da fonte aplicado em software."],
    ["Dispositivo","Ardulight/SerialPort","texto","Nome/caminho de porta serial disponível","Ardulight: Porta da controladora."],
    ["Dispositivo","Ardulight/BaudRate","inteiro em texto","9600, 57600, 115200, 128000, 153600, 230400, 256000, 460800, 500000, 921600, 1000000, 1500000, 2000000 na UI","Ardulight: Velocidade serial; o compositor também recalcula o limite de quadros."],
    ["Dispositivo","Ardulight/ColorSequence","enum texto","RGB, RBG, GRB, GBR, BRG, BGR na UI","Ardulight: Ordem dos canais de cada LED."],
    ["Dispositivo","AlienFx/NumberOfLeds","inteiro","1–1 no assistente; setter sem validação de faixa","AlienFx: Quantidade de índices enviados; não define a ordem dos índices. Uso condicionado a ALIEN_FX_SUPPORTED."],
    ["Dispositivo","AlienFx/LedMilliAmps","inteiro","1–100 mA na UI; setter sem validação de faixa","AlienFx: Estimativa de corrente por LED usada no limite de potência. Uso condicionado a ALIEN_FX_SUPPORTED."],
    ["Dispositivo","AlienFx/PowerSupplyAmps","decimal","0–99,99 A na UI Qt, passo 0,1; setter sem validação de faixa","AlienFx: Limite de corrente total da fonte aplicado em software. Uso condicionado a ALIEN_FX_SUPPORTED."],
    ["Dispositivo","Lightpack/NumberOfLeds","inteiro","1–10 no assistente; setter sem validação de faixa; Lightpack 4 suporta 8","Lightpack: Quantidade de índices enviados; não define a ordem dos índices."],
    ["Dispositivo","Lightpack/LedMilliAmps","inteiro","1–100 mA na UI; setter sem validação de faixa","Lightpack: Estimativa de corrente por LED usada no limite de potência."],
    ["Dispositivo","Lightpack/PowerSupplyAmps","decimal","0–99,99 A na UI Qt, passo 0,1; setter sem validação de faixa","Lightpack: Limite de corrente total da fonte aplicado em software."],
    ["Dispositivo","Virtual/NumberOfLeds","inteiro","1–511 no assistente; setter sem validação de faixa","Virtual: Quantidade de índices enviados; não define a ordem dos índices."],
    ["Dispositivo","Virtual/LedMilliAmps","inteiro","1–100 mA na UI; setter sem validação de faixa","Virtual: Estimativa de corrente por LED usada no limite de potência."],
    ["Dispositivo","Virtual/PowerSupplyAmps","decimal","0–99,99 A na UI Qt, passo 0,1; setter sem validação de faixa","Virtual: Limite de corrente total da fonte aplicado em software."],
    ["Dispositivo","Drgb/NumberOfLeds","inteiro","1–490 no assistente; setter sem validação de faixa","Drgb: Quantidade de índices enviados; não define a ordem dos índices."],
    ["Dispositivo","Drgb/LedMilliAmps","inteiro","1–100 mA na UI; setter sem validação de faixa","Drgb: Estimativa de corrente por LED usada no limite de potência."],
    ["Dispositivo","Drgb/PowerSupplyAmps","decimal","0–99,99 A na UI Qt, passo 0,1; setter sem validação de faixa","Drgb: Limite de corrente total da fonte aplicado em software."],
    ["Dispositivo","Drgb/Address","texto","Endereço IP aceito por QHostAddress","Drgb: Destino UDP."],
    ["Dispositivo","Drgb/Port","inteiro em texto","Porta UDP 1–65535; backend converte para ushort","Drgb: Porta do destino UDP."],
    ["Dispositivo","Drgb/Timeout","inteiro","1–255 s na UI; 255 desativa expiração; backend usa uint8","Drgb: Prazo para apagar após faltar dados, se suportado pelo receptor."],
    ["Dispositivo","Dnrgb/NumberOfLeds","inteiro","1–1500 no assistente; setter sem validação de faixa","Dnrgb: Quantidade de índices enviados; não define a ordem dos índices."],
    ["Dispositivo","Dnrgb/LedMilliAmps","inteiro","1–100 mA na UI; setter sem validação de faixa","Dnrgb: Estimativa de corrente por LED usada no limite de potência."],
    ["Dispositivo","Dnrgb/PowerSupplyAmps","decimal","0–99,99 A na UI Qt, passo 0,1; setter sem validação de faixa","Dnrgb: Limite de corrente total da fonte aplicado em software."],
    ["Dispositivo","Dnrgb/Address","texto","Endereço IP aceito por QHostAddress","Dnrgb: Destino UDP."],
    ["Dispositivo","Dnrgb/Port","inteiro em texto","Porta UDP 1–65535; backend converte para ushort","Dnrgb: Porta do destino UDP."],
    ["Dispositivo","Dnrgb/Timeout","inteiro","1–255 s na UI; 255 desativa expiração; backend usa uint8","Dnrgb: Prazo para apagar após faltar dados, se suportado pelo receptor."],
    ["Dispositivo","Warls/NumberOfLeds","inteiro","1–255 no assistente; setter sem validação de faixa","Warls: Quantidade de índices enviados; não define a ordem dos índices."],
    ["Dispositivo","Warls/LedMilliAmps","inteiro","1–100 mA na UI; setter sem validação de faixa","Warls: Estimativa de corrente por LED usada no limite de potência."],
    ["Dispositivo","Warls/PowerSupplyAmps","decimal","0–99,99 A na UI Qt, passo 0,1; setter sem validação de faixa","Warls: Limite de corrente total da fonte aplicado em software."],
    ["Dispositivo","Warls/Address","texto","Endereço IP aceito por QHostAddress","Warls: Destino UDP."],
    ["Dispositivo","Warls/Port","inteiro em texto","Porta UDP 1–65535; backend converte para ushort","Warls: Porta do destino UDP."],
    ["Dispositivo","Warls/Timeout","inteiro","1–255 s na UI; 255 desativa expiração; backend usa uint8","Warls: Prazo para apagar após faltar dados, se suportado pelo receptor."],
    ["Aparência","LightpackMode","enum texto","Ambilight, MoodLamp, SoundVisualizer (SOUNDVIZ_SUPPORT)","Escolhe captura da tela, lâmpada ou áudio; PATCH da 3637 não altera o modo."],
    ["Aparência","IsBacklightEnabled","booleano","false / true","Liga/desliga a saída de luz."],
    ["Captura","Grab/Grabber","enum texto","Qt, QtEachWidget (legado), WinAPI, WinAPIEachWidget (legado), X11, D3D9, MacCoreGraphics, MacAVFoundation, DDupl; depende da build","Backend de captura da tela."],
    ["Captura","Grab/IsAvgColorsEnabled","booleano","false / true","Calcula uma média comum para LEDs capturados."],
    ["Captura","Grab/IsSendDataOnlyIfColorsChanges","booleano","false / true","Suprime reenvio de cores iguais; afeta tela e modos geradores."],
    ["Captura","Grab/Slowdown","inteiro","1–1000 ms, clamp no Settings","Intervalo nominal de captura; backend pode aplicar limite efetivo."],
    ["Aparência","Grab/LuminosityThreshold","inteiro","0–100, clamp no Settings","Limiar de luminosidade baixa para piso/área morta."],
    ["Captura","Grab/OverBrighten","inteiro","0–100, clamp no Settings","Realça cores da captura."],
    ["Aparência","Grab/IsMinimumLuminosityEnabled","booleano","false / true","Usa piso de luminosidade; false seleciona área morta na UI."],
    ["Captura","Grab/IsDX1011GrabberEnabled","booleano","false / true","Ativa captura via hook DX10/11, condicionada a D3D10_GRAB_SUPPORT."],
    ["Captura","Grab/IsDX9GrabbingEnabled","booleano","false / true","Ativa captura via hook DX9, condicionada a D3D10_GRAB_SUPPORT."],
    ["Captura","Grab/IsApplyGammaRampEnabled","booleano","false / true","Aplica compensação de redução de luz azul/rampa do sistema; UI desativa temperatura manual ao ligar."],
    ["Captura","Grab/IsApplyColorTemperatureEnabled","booleano","false / true","Aplica temperatura manual; UI desativa compensação de luz azul ao ligar."],
    ["Captura","Grab/ColorTemperature","inteiro","1000–10000 K na UI; setter grava int sem clamp","Temperatura da captura, se ativada."],
    ["Captura","Grab/Gamma","decimal","0,05–10 na UI; setter grava decimal sem clamp","Gama da captura, antes da gama do dispositivo."],
    ["Captura","Grab/DownscaleLevel","inteiro","0–4, clamp no Settings; escala 1 / 2^nível","Reduz resolução antes de amostrar as zonas."],
    ["Captura","Grab/IsFullscreenWatchdogEnabled","booleano","false / true","Vigia de travamento em tela cheia no capturador DXGI."],
    ["Captura","Grab/WatchdogStallMs","inteiro","500–10000 ms, clamp no Settings","Tempo sem quadros antes da ação do vigia."],
    ["Aparência","Compositor/Groups","array JSON gravado em texto","ID único com 1–40 caracteres; seletores all/ranges/list; índices abaixo de led_count; API rejeita sobreposição entre grupos","Modos e ordem de efeito por grupo; não altera a correspondência física de índices."],
    ["Aparência","Compositor/Scenes","array JSON gravado em texto","Máx. 16 via API; IDs de 1–40, nome até 60, groups, triggers.allow/target_groups/min_priority (0–100)","Cenas do perfil com grupos e regras para efeitos acionados por eventos."],
    ["Aparência","Compositor/ActiveScene","ID em texto","ID de cena existente via API; vazio sem cena ativa","Guarda a cena ativa e, via ativação, substitui os grupos em uso."],
    ["Aparência","MoodLamp/LiquidMode","booleano","false / true","Alterna transição de cores e cor constante."],
    ["Aparência","MoodLamp/Color","cor RGB (#RRGGBB)","Hex RGB / QColor","Cor estática da lâmpada."],
    ["Aparência","MoodLamp/Speed","inteiro","1–100, clamp no Settings","Velocidade da transição de cor."],
    ["Aparência","MoodLamp/Lamp","enum inteiro","0 Static, 1 Fire, 2 RGB is Life","Variante de efeito da lâmpada."],
    ["Aparência","SoundVisualizer/Device","inteiro","-1 (padrão) ou ID enumerado pelo backend","Dispositivo de áudio capturado. Requer SOUNDVIZ_SUPPORT."],
    ["Aparência","SoundVisualizer/Visualizer","enum inteiro","IDs fornecidos pelo backend de visualização","Algoritmo de visualização. Requer SOUNDVIZ_SUPPORT."],
    ["Aparência","SoundVisualizer/MinColor","cor RGB (#RRGGBB)","Hex RGB / QColor","Cor de mínimo do visualizador. Requer SOUNDVIZ_SUPPORT."],
    ["Aparência","SoundVisualizer/MaxColor","cor RGB (#RRGGBB)","Hex RGB / QColor","Cor de máximo do visualizador. Requer SOUNDVIZ_SUPPORT."],
    ["Aparência","SoundVisualizer/LiquidMode","booleano","false / true","Alterna cor variável e constante. Requer SOUNDVIZ_SUPPORT."],
    ["Aparência","SoundVisualizer/LiquidSpeed","inteiro","1–100, clamp no Settings","Velocidade da cor variável. Requer SOUNDVIZ_SUPPORT."],
    ["Dispositivo","Device/RefreshDelay","inteiro","64–1023 (timer), clamp no Settings","Ajusta a cadência do firmware Lightpack."],
    ["Dispositivo","Device/IsUsbPowerLedDisabled","booleano","false / true","Desativa o indicador de energia USB nos dispositivos compatíveis."],
    ["Aparência","Device/Smooth","inteiro","0–255, clamp no Settings","Suavização no compositor por software e comando no Lightpack, conforme caminho."],
    ["Aparência","Device/Brightness","inteiro","0–100%, clamp no Settings","Brilho da saída."],
    ["Aparência","Device/BrightnessCap","inteiro","1–100%, clamp no Settings","Teto do brilho da saída."],
    ["Dispositivo","Device/ColorDepth","inteiro","32–255, clamp no Settings","Profundidade de cor enviada ao dispositivo compatível."],
    ["Aparência","Device/Gamma","decimal","0,01–10 no Settings; 0,05–10 na UI","Correção de gama na saída."],
    ["Aparência","Device/IsDitheringEnabled","booleano","false / true","Difusão do erro de quantização no processamento de saída compatível."],
    ["Dispositivo","LED_{n}/IsEnabled","booleano","false / true","Habilita a amostragem/saída do índice."],
    ["Dispositivo","LED_{n}/Size","QSize em px","Largura e altura da zona; setter sem clamp próprio","Área de amostragem associada ao índice."],
    ["Dispositivo","LED_{n}/Position","QPoint em px","Coordenadas de tela, inclusive negativas em multimonitor","Posição de captura associada ao índice de saída físico."],
    ["Dispositivo","LED_{n}/CoefRed","decimal","0,0–1,0; inválido retorna ao padrão","Ganho de branco do canal Red."],
    ["Dispositivo","LED_{n}/CoefGreen","decimal","0,0–1,0; inválido retorna ao padrão","Ganho de branco do canal Green."],
    ["Dispositivo","LED_{n}/CoefBlue","decimal","0,0–1,0; inválido retorna ao padrão","Ganho de branco do canal Blue."],
    ["Integrações","{plugin}/Enable","booleano","false / true","Habilita a extensão; extensão ativa pode controlar a luz indiretamente."],
    ["Integrações","{plugin}/Priority","inteiro","UI atribui 1–N conforme posição; setter sem faixa própria","Ordena prioridade na lista de extensões."],
    ["Dispositivo","LED_{n} → layout.index","índice derivado","n = 1–1500 no INI; index = n−1, 0–led_count−1 na Web API","Identidade física usada pela aplicação: posição e tamanho por índice. Não há uma chave Index."],
    ["Dispositivo","(assistente) Primeiro LED","inteiro","UI se apresenta em base 1; máximo definido como maxLedsCount−1","Numeração inicial por monitor; o código soma startId aos IDs calculados."],
    ["Dispositivo","(assistente) Último LED","inteiro derivado","startId + quantidade de áreas − 1 na distribuição contínua","Extremo obtido pela contagem na distribuição; não há campo de fim independente no assistente legado."],
    ["Dispositivo","(assistente) Inverter ordem","booleano","false / true","Inverte a numeração de toda a distribuição no monitor."],
    ["Dispositivo","(assistente) Deslocamento","inteiro","−999 a +999 na UI; módulo da quantidade de zonas","Rotaciona a numeração na distribuição."],
    ["Dispositivo","(assistente) Inverter fileira inferior","booleano","false / true","Reverte retângulos da metade inferior que não tocam as laterais, mantendo os IDs. Atalho geométrico para a mesa."],
    ["Dispositivo","(assistente) Monitor","inteiro","Monitores ativos","Entrada de distribuição; o assistente grava a geometria resultante e a contagem do dispositivo."],
    ["Dispositivo","(assistente) Quantidade de LEDs","inteiro","1–máximo do dispositivo (assistente)","Entrada de distribuição; o assistente grava a geometria resultante e a contagem do dispositivo."],
    ["Dispositivo","(assistente) LEDs no topo/laterais/base","inteiro","0–999 por campo na UI","Entrada de distribuição; o assistente grava a geometria resultante e a contagem do dispositivo."],
    ["Dispositivo","(assistente) Espessura","inteiro","1–50% na UI","Entrada de distribuição; o assistente grava a geometria resultante e a contagem do dispositivo."],
    ["Dispositivo","(assistente) Largura do suporte","inteiro","0–99 na UI Qt","Entrada de distribuição; o assistente grava a geometria resultante e a contagem do dispositivo."],
    ["Dispositivo","(assistente) Margens topo/laterais/base","decimal","0–40% na UI","Entrada de distribuição; o assistente grava a geometria resultante e a contagem do dispositivo."],
    ["Dispositivo","(assistente) Pular cantos","booleano","false / true","Entrada de distribuição; o assistente grava a geometria resultante e a contagem do dispositivo."],
    ["Captura","(Qt) Mostrar áreas de captura","enum","ocultar / numeradas brancas / coloridas","Sobreposição de diagnóstico da captura. A navegação por abas e os botões de abrir logs, perfil e painel são ações de sessão."],
    ["Aparência","(Qt) Criar/renomear/excluir/restaurar perfil","ações","Nome de perfil conforme UI; restaurar usa padrões de initCurrentProfile","Administração dos arquivos de perfil. Restaurar usa initCurrentProfile; as três chaves Compositor/* não são inicializadas por ele."],
    ["Avançado","(Qt) Tema da janela","derivado","Paleta do sistema Qt","Conforme paleta do sistema e troca de tema Qt."],
    ["Integrações","(Qt) Metadados do plugin","manifesto INI","[Main] Name, Execute e variante por SO, Guid, Author, Description, Version, Icon","Configuração do manifesto externo; Qt exibe metadados e recarrega extensões."],
    ["Avançado","API/IsAuthEnabled (legado)","booleano","false / true","Declaração setIsApiAuthEnabled sem definição nesta revisão. A chave ativa é API/AuthKey."],
    ["Dispositivo","(V17) Ordem por segmento · início","inteiro","Índice válido; inclusivo","Primeiro LED do segmento."],
    ["Dispositivo","(V17) Ordem por segmento · fim","inteiro","Índice válido; inclusivo","Último LED do segmento."],
    ["Dispositivo","(V17) Ordem por segmento · sentido","enum","Normal / invertido","Define a orientação do segmento."],
    ["Dispositivo","(V17) Ordem por segmento · deslocamento","inteiro","Inteiro normalizado pelo tamanho do segmento","Rotaciona o ponto de partida."],
    ["Dispositivo","(V17) Ordem por segmento · espelhar","booleano","false / true","Espelhamento opcional; a composição com sentido fica para a especificação V17."],
  ];
  init();
})();
