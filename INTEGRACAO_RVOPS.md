# Integração formulário → RVops (LP venda/consignação de CARRO)

Documento de referência pra rodar a integração local, fazer o deploy e validar
o fluxo no RVops.

> **Escopo**: esta LP é específica para venda/consignação de CARRO, servida em
> `https://vendaseucarro.kikoautos.com`. A futura LP de MOTO será um **deploy
> separado**, com seu próprio `RVOPS_LP_ORIGEM`. O `lp_origem` é sempre lido do
> `.env`/painel — nunca hardcodar no código.

## Hospedagem

**Hostinger Node.js (Node 20+)**, deploy via Git. App entrypoint `server.js`,
servido por Express. Substitui o setup anterior (Netlify static + Functions),
cujos arquivos (`netlify.toml`, `netlify/functions/`, `_headers`) foram mantidos
no repo apenas como fallback caso seja necessário voltar.

Detalhes de deploy: `HOSTINGER_DEPLOY.md`.

## Arquivos envolvidos

- `index.html` — form (`#leadForm`), captura UTM, máscara WhatsApp, submit via fetch
- `server.js` — servidor Express: estático + `/api/lead-consignacao` + `/api/health`
- `package.json` — `express ^4.21.0`, Node `>=20`, `npm start` → `node server.js`
- `.env.example` — template (real fica no painel Hostinger)
- `netlify/functions/lead-consignacao.js`, `netlify.toml`, `_headers` — fallback Netlify (mantidos no repo, ignorados pela Hostinger)

## Variáveis de ambiente

Configurar no painel Hostinger (Node.js app → Environment variables):

| Nome              | Valor                       | Obrigatória |
| ----------------- | --------------------------- | ----------- |
| `RVOPS_CLIENT_ID` | `843790ca`                  | sim         |
| `RVOPS_API_KEY`   | `<segredo do painel RVops>` | sim         |
| `RVOPS_LP_ORIGEM` | `vendaseucarro-kikoautos`   | sim         |
| `PORT`            | (Hostinger seta automaticamente) | não    |

Local: `cp .env.example .env`, preencher a API key, `npm start`.

## Endpoints internos

- `GET  /api/health` — health check (`{ status: "ok", timestamp }`)
- `POST /api/lead-consignacao` — proxy pro RVops (chamado pelo form do `index.html`)

## Endpoint RVops (upstream)

```
POST https://app.rvops.com/843790ca/api/v1/contacts
Headers:
  rvops-apikey: <RVOPS_API_KEY>
  Content-Type: application/json
```

- 201 Created → contato criado
- 409 ConflictError → email **ou** telefone já existe (ambos são identificadores únicos)
- Rate limit: 100 requisições a cada 10s

## Mapeamento de propriedades (testado via curl)

A nomenclatura no RVops é inconsistente — hífens em umas, sem separador em
outras, palavra única em outras. Mantida exatamente como validada:

| Origem (front)  | Nome interno RVops          | Notas                              |
| --------------- | --------------------------- | ---------------------------------- |
| `firstname`     | `firstname`                 | Nativa                             |
| `email`         | `email`                     | Nativa, identificador único        |
| `phone`         | `phone`                     | Nativa, identificador único, formato `5511999999999` |
| `marca`         | `marca-do-veiculo`          | Hífens                             |
| `modelo`        | `modelo-do-veiculo`         | Hífens                             |
| `ano`           | `ano-de-fabricacaomodelo`   | Hífens; nota: `fabricacaomodelo` colado |
| `quilometragem` | `quilometragem`             | Palavra única                      |
| (env)           | `lp_origem`                 | Underscore; vem do `RVOPS_LP_ORIGEM` |
| `utm_source`    | `utmsource`                 | Sem separador                      |
| `utm_medium`    | `utmmedium`                 | Sem separador                      |
| `utm_campaign`  | `utmcampaign`               | Sem separador                      |
| `utm_content`   | `utmcontent`                | Sem separador                      |
| `utm_term`      | `utmterm`                   | Sem separador                      |

> Em JS, propriedades com hífen exigem **bracket notation**:
> `properties["marca-do-veiculo"]`. O `server.js` já faz isso.

UTM vazios são **omitidos** do payload (não enviados como string vazia, pra não
sobrescrever valor existente em algum fluxo de update futuro).

## Comportamento end-to-end

- **201 Created** → tela de obrigado
- **409 ConflictError** (email **ou** phone duplicado) → tela de obrigado também,
  log do servidor marca como lead recorrente com email + phone + marca/modelo
- **400/500/timeout/abort** → mensagem genérica + link de fallback WhatsApp
- **Honeypot** preenchido → simula sucesso, descarta silenciosamente
- **Timeout RVops**: 5s no servidor, 8s no cliente (margem pro server responder)

## TODOs antes do go-live

- [ ] Adicionar repo Git no painel Hostinger (ver `HOSTINGER_DEPLOY.md`)
- [ ] Configurar `RVOPS_CLIENT_ID`, `RVOPS_API_KEY` e `RVOPS_LP_ORIGEM` no painel Hostinger
- [ ] Apontar subdomínio `vendaseucarro.kikoautos.com` para a app Node
- [ ] Plugar Meta Pixel / GA4 no GTM via trigger `Custom Event = lead_consignacao_success` (ou `lead_consignacao_thankyou_pageview` na tela de obrigado)
- [ ] Teste E2E em prod: enviar lead com UTMs na URL, conferir contato no RVops com **todas** as 11 propriedades preenchidas, repetir mesmo email pra validar 409 → tela obrigado
- [ ] `GET https://vendaseucarro.kikoautos.com/api/health` deve responder `{ status: "ok", timestamp }`
- [ ] Quando criar a LP de moto: **novo deploy** (subdomínio próprio + `RVOPS_LP_ORIGEM` próprio), mesma estrutura reutilizada
