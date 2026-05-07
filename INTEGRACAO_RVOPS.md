# Integração formulário → RVops (LP consignação de CARRO)

Documento de referência pra rodar a integração local, fazer o deploy e validar
o fluxo no RVops.

> **Escopo**: esta LP é específica para consignação de CARRO. A futura LP de MOTO
> será um **deploy separado**, com seu próprio `RVOPS_LP_ORIGEM` (`lp-consignacao-moto-kikoautos`).
> O `lp_origem` é sempre lido do `.env` — nunca hardcodar no código.

## Arquivos envolvidos

- `index.html` — form (`#leadForm`), captura de UTM, máscara WhatsApp, submit via fetch
- `netlify/functions/lead-consignacao.js` — proxy server-side (Node 18, sem deps)
- `netlify.toml` — declara `publish=.` e `functions=netlify/functions`
- `.env.example` — template das variáveis (real fica no painel Netlify)

## Variáveis de ambiente

Configurar no painel Netlify em **Site settings → Environment variables**:

| Nome              | Valor                            | Obrigatória |
| ----------------- | -------------------------------- | ----------- |
| `RVOPS_CLIENT_ID` | `843790ca`                       | sim         |
| `RVOPS_API_KEY`   | `<segredo do painel RVops>`      | sim         |
| `RVOPS_LP_ORIGEM` | `lp-consignacao-carro-kikoautos` | sim         |

Para rodar local: `cp .env.example .env`, preencher a API key, `netlify dev`.

## Endpoint RVops

```
POST https://app.rvops.com/843790ca/api/v1/contacts
Headers:
  rvops-apikey: <RVOPS_API_KEY>
  Content-Type: application/json
```

- 201 Created → contato criado
- 409 ConflictError → email **ou** telefone já existe em outro contato (ambos são identificadores únicos)
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
> `properties["marca-do-veiculo"]`. A function já faz isso.

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

- [ ] Configurar `RVOPS_API_KEY` na Netlify (CLIENT_ID e LP_ORIGEM podem ser commitados via `.env.example`, mas a key não)
- [ ] Substituir `wa.me/55XXXXXXXXXXX` em `index.html` (busca por `WHATSAPP_FALLBACK`) pelo número real
- [ ] Plugar Meta Pixel / GA4 no `console.log('[conversion] lead-consignacao ok')`
- [ ] Teste E2E: enviar lead com UTMs na URL, conferir contato no RVops com **todas** as 11 propriedades preenchidas, repetir mesmo email pra validar 409 → tela obrigado
- [ ] Quando criar a LP de moto: **novo deploy** com `RVOPS_LP_ORIGEM=lp-consignacao-moto-kikoautos`, mesma function reutilizada
