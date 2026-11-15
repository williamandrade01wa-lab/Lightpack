// Service worker: recebe o aviso do content.js e faz POST /api/v1/trigger no Prismatik.
// O token fica so em chrome.storage.local (colado pelo usuario na pagina de opcoes).
"use strict";

var DEFAULT_PORT = 3637;
var PRIORITY = 55;

function getSettings() {
  return new Promise(function (resolve) {
    chrome.storage.local.get({ token: "", port: DEFAULT_PORT, enabled: {} }, resolve);
  });
}

async function sendTrigger(source, color, testOnly) {
  var s = await getSettings();
  if (!s.token) return { ok: false, error: "token_ausente" };
  if (!testOnly && s.enabled && s.enabled[source] === false) return { ok: true, skipped: true };

  var body = {
    id: "browser-" + source,
    source: source,
    effect: { type: "wave", color: color || "#FFFFFF", period_ms: 1200, width: 0.2 },
    duration_ms: 2400,
    opacity: 0.8,
    priority: PRIORITY
  };
  try {
    var resp = await fetch("http://127.0.0.1:" + (s.port || DEFAULT_PORT) + "/api/v1/trigger", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + s.token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    var data = {};
    try { data = await resp.json(); } catch (e) { /* corpo vazio */ }
    return { ok: resp.ok, status: resp.status, suppressed: data.suppressed === true };
  } catch (e) {
    return { ok: false, error: "prismatik_indisponivel" };
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;
  if (msg.type === "notify") {
    sendTrigger(msg.source, msg.color, false).then(sendResponse);
    return true;
  }
  if (msg.type === "test") {
    sendTrigger(msg.source || "sistema", msg.color || "#FFFFFF", true).then(sendResponse);
    return true;
  }
});
