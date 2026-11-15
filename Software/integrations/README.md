# Integrações do Prismatik (Fase 4)

Duas peças que fazem a fita avisar quando algo acontece:

| Pasta | O que faz |
|---|---|
| `browser-extension/` | Extensão Chrome/Edge: avisa quando o **Claude.ai** ou o **ChatGPT** terminam de responder e quando chega mensagem no **WhatsApp Web**. |
| `hooks/claude-done.ps1` | Cópia versionada do hook do **Claude Code** (avisa quando o Claude termina de responder no terminal). |

Todos usam `POST http://127.0.0.1:3637/api/v1/trigger` com o campo `source`
(`claude`, `chatgpt`, `whatsapp`). A **cena ativa** do Prismatik decide onde
acende (pontas da mesa) e se o aviso é permitido; no modo Mídia, por exemplo,
avisos de prioridade baixa ficam quietos (a resposta é `202` com `"suppressed": true`).

## 1. Extensão do navegador (Chrome ou Edge)

### Instalar (modo desenvolvedor)
1. Abra `chrome://extensions` (Edge: `edge://extensions`).
2. Ligue **Modo do desenvolvedor**.
3. Clique **Carregar sem compactação** e escolha a pasta `Software/integrations/browser-extension`.
4. Copie o **ID** que aparece no cartão da extensão (32 letras).

### Liberar a origem da extensão no Prismatik
O Prismatik só aceita pedidos de origens conhecidas. Acrescente a da extensão:

1. Feche o Prismatik.
2. Abra `C:\Users\<você>\Prismatik\main.conf`.
3. Na seção `[WebApi]`, preencha (troque `ID` pelo ID copiado):

   ```
   AllowedOrigins=chrome-extension://ID
   ```
   Para Chrome **e** Edge ao mesmo tempo, separe por vírgula (cada navegador dá um ID diferente).
4. Abra o Prismatik de novo.

### Colar o token (uma vez)
1. No Prismatik, copie o **token da API web** (aba da API / painel em `http://127.0.0.1:3637/`).
2. Clique no ícone da extensão, cole o token, **Salvar** e depois **Testar na fita**.
   O token fica só em `chrome.storage.local` deste navegador.

### Como detecta
- **Claude.ai / ChatGPT:** vê o botão "parar resposta" aparecer e sumir. Quando some, a resposta terminou → onda na cor do serviço.
- **WhatsApp Web:** conta as conversas com mensagem não lida; se o número aumenta → aviso.
- Há uma pausa de 4 s entre dois avisos do mesmo site.

### Se um site mudar e parar de avisar
Os seletores ficam em `browser-extension/sites.js`. Ajuste o seletor do botão/indicador
(F12 → inspecionar) e recarregue a extensão em `chrome://extensions`.

### Problemas comuns
| Sintoma do teste | Causa |
|---|---|
| "Prismatik fechado ou API web desligada" | Prismatik fechado, API web desligada ou porta diferente de 3637. |
| "Token recusado (401)" | Token errado ou antigo. |
| "Origem recusada (403)" | Falta o ID em `AllowedOrigins` (passo acima). |
| "cena atual silenciou o aviso" | Normal: a cena ativa não permite essa origem/prioridade. |

## 2. Hook do Claude Code

`hooks/claude-done.ps1` é a cópia do hook que fica em
`C:\Users\<você>\Prismatik-hooks\claude-done.ps1` (chamado pelo hook `Stop` em
`~/.claude/settings.json`).

- Lê o token de `[WebApi] Token` no `main.conf` (nunca imprime nem grava em log).
- Faz `POST /api/v1/trigger` com `source: "claude"`, sem `target` (a cena ativa escolhe as pontas).
- Se a API web falhar (Prismatik antigo, API desligada), usa a **reserva**: API TCP na porta 3636 com os grupos `desk-center` + `desk-ends`.
- Silencioso: se nada estiver disponível, sai sem erro.
