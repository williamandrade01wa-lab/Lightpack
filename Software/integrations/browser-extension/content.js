// Observa a pagina e avisa o service worker (background.js) quando algo acontece.
// A pagina nunca fala com o Prismatik diretamente: so o background tem o token.
(function () {
  "use strict";

  var site = PRISMATIK_SITES[location.hostname];
  if (!site) return;

  function countMatches(selectors) {
    var total = 0;
    for (var i = 0; i < selectors.length; i++) {
      try {
        total += document.querySelectorAll(selectors[i]).length;
      } catch (e) { /* seletor invalido: ignora */ }
    }
    return total;
  }

  var wasBusy = false;
  var lastUnread = null;
  var lastFire = 0;
  var scheduled = false;

  function fire() {
    var now = Date.now();
    if (now - lastFire < PRISMATIK_COOLDOWN_MS) return;
    lastFire = now;
    try {
      chrome.runtime.sendMessage({ type: "notify", source: site.source, color: site.color });
    } catch (e) { /* extensao recarregada: ignora */ }
  }

  function check() {
    scheduled = false;
    if (site.mode === "busy") {
      var busy = countMatches(site.busy) > 0;
      if (wasBusy && !busy) fire();
      wasBusy = busy;
    } else {
      var unread = countMatches(site.unread);
      if (lastUnread !== null && unread > lastUnread) fire();
      lastUnread = unread;
    }
  }

  // Agrupa rajadas de mudancas do DOM em uma unica checagem.
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(check, 250);
  }

  new MutationObserver(schedule).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-label", "data-testid", "disabled"]
  });
  check();
})();
