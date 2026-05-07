# Deploy na Hostinger Node.js

Checklist passo a passo pra publicar `vendaseucarro.kikoautos.com` no plano
Node.js da Hostinger. Os nomes exatos de menu podem variar conforme atualização
do hPanel — usa o nome mais próximo se algo mudou.

## Pré-requisitos

- [ ] Plano Hostinger com suporte a **Node.js** ativo (Cloud Startup, Business
  Web Hosting com Node.js, ou VPS com painel)
- [ ] Acesso ao hPanel
- [ ] Repo Git no GitHub (`https://github.com/erichprates/consignado-kikoautos.git`)
  com a branch `main` contendo este código
- [ ] **API key do RVops já rotacionada** (a anterior ficou só no `.env` local,
  não foi commitada nem chegou na Netlify, mas rotaciona por segurança antes
  de configurar na Hostinger)

## 1. Conectar o repo Git

No hPanel:

1. **Hosting** → escolhe a conta → **Avançado** (ou **Advanced**) → **Git**
2. **Criar repositório** ou **Add repository**
3. Repository URL: `https://github.com/erichprates/consignado-kikoautos.git`
4. Branch: `main`
5. Install path / Repository path: a pasta onde a app vai rodar (ex: `/domains/kikoautos.com/public_html/vendaseucarro` ou pasta dedicada da app Node)

Hostinger faz `git clone` automaticamente. Ativa **Auto-deploy** se quiser que
cada push pra `main` dispare redeploy.

## 2. Configurar a app Node.js

No hPanel → **Avançado** → **Node.js** (ou **Setup Node.js App**):

| Campo                  | Valor                                                |
| ---------------------- | ---------------------------------------------------- |
| Node.js version        | `20.x` (mais recente disponível)                     |
| Application mode       | `Production`                                         |
| Application root       | a mesma pasta usada no passo 1                       |
| Application URL        | `vendaseucarro.kikoautos.com` (sem https://, sem trailing slash) |
| Application startup file | `server.js`                                        |
| Run NPM Install        | **Sim** (clica no botão depois de salvar)            |
| Start command          | `npm start` (ou `node server.js`)                    |

Salva e clica em **Run NPM Install**. Isso vai instalar `express ^4.21.0` e
gerar o `node_modules/`. (Não commitar o `node_modules` — já está no `.gitignore`.)

## 3. Variáveis de ambiente

No mesmo painel Node.js, na seção **Environment Variables**:

| Nome              | Valor                       |
| ----------------- | --------------------------- |
| `RVOPS_CLIENT_ID` | `843790ca`                  |
| `RVOPS_API_KEY`   | (key rotacionada do painel RVops) |
| `RVOPS_LP_ORIGEM` | `vendaseucarro-kikoautos`   |

`PORT` é definida automaticamente pela Hostinger — não precisa setar.

Salva e **reinicia a app** (botão **Restart App**).

## 4. Subdomínio

No hPanel → **Domínios** → **Subdomínios**:

1. Cria subdomínio `vendaseucarro` sob `kikoautos.com`
2. Aponta o subdomínio pra mesma pasta da app (ou usa o "Application URL" da
   config Node, que cria o roteamento automático)
3. Aguarda propagação DNS (geralmente <30 min, até 24h no pior caso)
4. Habilita **SSL/HTTPS** (Let's Encrypt) — geralmente automático

## 5. Validação

```bash
# Health check
curl https://vendaseucarro.kikoautos.com/api/health
# esperado: {"status":"ok","timestamp":"2026-..."}

# LP carregando
curl -I https://vendaseucarro.kikoautos.com/
# esperado: HTTP/2 200, Content-Type: text/html

# Cache de assets
curl -I https://vendaseucarro.kikoautos.com/assets/logo-kiko.svg
# esperado: Cache-Control: public, max-age=31536000, immutable

# Lead end-to-end (smoke test — manda lead de teste)
# Abre vendaseucarro.kikoautos.com?utm_source=teste&utm_campaign=smoke,
# preenche o form, confere o contato no painel RVops com lp_origem=vendaseucarro-kikoautos
# e utmsource=teste, utmcampaign=smoke.
```

## 6. Logs

No painel Node.js da Hostinger:

- **Logs / Application Logs**: stdout/stderr da app (onde aparecem os
  `[lead-consignacao] ...` da function)
- **Errors / Error Logs**: stderr separado, em alguns planos
- Via SSH (se disponível): `tail -f ~/.pm2/logs/<app>.log` ou similar
  — verifica o caminho exato no painel

## 7. Restart / redeploy

- **Restart**: botão "Restart App" no painel Node.js (mantém o código atual)
- **Redeploy**: 
  - Auto-deploy ativo: `git push origin main` puxa e reinicia automaticamente
  - Manual: aba Git → **Pull**, depois Node.js → **Restart App**
  - Se mudou `package.json`: rodar **Run NPM Install** novamente antes do restart

## Voltar pra Netlify (rollback)

Os arquivos `netlify.toml`, `netlify/functions/`, `_headers` continuam no repo.
Pra reverter:

1. Reverter `index.html`: trocar `'/api/lead-consignacao'` de volta pra
   `'/.netlify/functions/lead-consignacao'`
2. Reverter `RVOPS_LP_ORIGEM` no painel Netlify pro valor anterior, se tiver
3. `git push` na branch `main` que a Netlify deploya
4. Apontar DNS de volta pra Netlify

## Troubleshooting

- **502 / Application Error**: app não subiu. Conferir Logs e env vars.
- **`[boot] env vars do RVops faltando`**: setar `RVOPS_CLIENT_ID`,
  `RVOPS_API_KEY`, `RVOPS_LP_ORIGEM` e restart.
- **/api/health funciona mas /api/lead-consignacao retorna 500 com "Configuração indisponível"**: env vars não estão sendo carregadas pelo runtime. Restart depois de salvar.
- **Form retorna 502 "Não conseguimos registrar agora"**: erro upstream RVops.
  Olhar `[lead-consignacao] upstream error` nos logs — o `sentProperties` mostra
  exatamente o que foi enviado.
- **CSS/imagens 404**: conferir se a pasta `assets/` foi clonada (deveria ter
  ~18 arquivos). Em último caso, pull manual + restart.
