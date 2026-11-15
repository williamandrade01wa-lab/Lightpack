// Configuracao por site. Se um site mudar o visual e o aviso parar de acender,
// e aqui que se ajustam os seletores (nao precisa mexer em content.js).
//
// mode "busy":   o aviso dispara quando o indicador de "gerando resposta"
//                aparece e depois some (resposta terminou).
// mode "unread": o aviso dispara quando o numero de conversas nao lidas aumenta.
//
// Cada seletor e tentado em ordem; basta um bater.
var PRISMATIK_SITES = {
  "claude.ai": {
    source: "claude",
    mode: "busy",
    busy: [
      'button[aria-label="Stop response"]',
      'button[aria-label="Parar resposta"]',
      'button[aria-label="Stop Response"]'
    ],
    color: "#D97757"
  },
  "chatgpt.com": {
    source: "chatgpt",
    mode: "busy",
    busy: [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Parar de transmitir"]'
    ],
    color: "#10A37F"
  },
  "chat.openai.com": {
    source: "chatgpt",
    mode: "busy",
    busy: [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop streaming"]'
    ],
    color: "#10A37F"
  },
  "web.whatsapp.com": {
    source: "whatsapp",
    mode: "unread",
    unread: [
      'span[aria-label*="unread message" i]',
      'span[aria-label*="mensagem não lida" i]',
      'span[aria-label*="mensagens não lidas" i]',
      'span[aria-label*="mensagem nao lida" i]'
    ],
    color: "#25D366"
  }
};

// Tempo minimo entre dois avisos do mesmo site (ms).
var PRISMATIK_COOLDOWN_MS = 4000;
