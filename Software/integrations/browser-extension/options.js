"use strict";

var SOURCES = ["claude", "chatgpt", "whatsapp"];
var $ = function (id) { return document.getElementById(id); };

function show(text, ok) {
  var el = $("msg");
  el.textContent = text;
  el.className = ok ? "ok" : "erro";
}

chrome.storage.local.get({ token: "", port: 3637, enabled: {} }, function (s) {
  $("token").value = s.token;
  $("port").value = s.port;
  SOURCES.forEach(function (src) {
    $("en-" + src).checked = s.enabled[src] !== false;
  });
});

$("save").addEventListener("click", function () {
  var enabled = {};
  SOURCES.forEach(function (src) { enabled[src] = $("en-" + src).checked; });
  chrome.storage.local.set({
    token: $("token").value.trim(),
    port: parseInt($("port").value, 10) || 3637,
    enabled: enabled
  }, function () { show("Salvo.", true); });
});

$("test").addEventListener("click", function () {
  // Salva antes de testar, para usar o token digitado agora.
  chrome.storage.local.set({
    token: $("token").value.trim(),
    port: parseInt($("port").value, 10) || 3637
  }, function () {
    chrome.runtime.sendMessage({ type: "test", source: "sistema", color: "#FFFFFF" }, function (r) {
      if (!r) return show("Sem resposta da extensao.", false);
      if (r.error === "token_ausente") return show("Cole o token primeiro.", false);
      if (r.error === "prismatik_indisponivel") return show("Prismatik fechado ou API web desligada (ou origem nao permitida).", false);
      if (r.status === 401) return show("Token recusado (401). Confira o token.", false);
      if (r.status === 403) return show("Origem recusada (403). Veja o passo AllowedOrigins no README.", false);
      if (r.suppressed) return show("O Prismatik recebeu, mas a cena atual silenciou o aviso.", true);
      show(r.ok ? "Enviado! A fita deve piscar." : "Erro " + r.status + ".", r.ok);
    });
  });
});
