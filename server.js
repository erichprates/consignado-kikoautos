// Servidor Express — Hostinger Node.js (Node 20+).
// Serve a LP estática + proxy /api/lead-consignacao para o RVops.
// Lógica do proxy idêntica à netlify/functions/lead-consignacao.js (mesmas
// validações, mesmos nomes internos das properties, mesmos timeouts e logs).

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_VERSION = '1.0.0'; // hardcoded — espelha o package.json. Bumpar manualmente no release.

// Hostinger usa proxy reverso na frente — habilita req.ip / X-Forwarded-For corretos.
app.set('trust proxy', true);

// JSON body parser com limite (anti-payload-bomb).
app.use(express.json({ limit: '10kb' }));

// Boot-time env check — apenas warning. O erro real só dispara em /api/lead-consignacao
// (assim o servidor sobe mesmo se as envs ainda não tiverem sido configuradas).
const { RVOPS_CLIENT_ID, RVOPS_API_KEY, RVOPS_LP_ORIGEM } = process.env;
if (!RVOPS_CLIENT_ID || !RVOPS_API_KEY || !RVOPS_LP_ORIGEM) {
  console.warn('[boot] env vars do RVops faltando', {
    hasClientId: !!RVOPS_CLIENT_ID,
    hasApiKey: !!RVOPS_API_KEY,
    hasLpOrigem: !!RVOPS_LP_ORIGEM
  });
}

// Pipeline/stage do funil RVops para criação do Negócio. Default validado via curl
// (pipeline 2 = "Consignação", stage 8 = "Novo Lead"). Override via env se mudar.
const RVOPS_PIPELINE_ID = parseInt(process.env.RVOPS_PIPELINE_ID, 10) || 2;
const RVOPS_STAGE_ID = parseInt(process.env.RVOPS_STAGE_ID, 10) || 8;

// Cache headers — convertido do _headers Netlify:
//   /assets/*   → 1 ano immutable
//   /*.webp     → 1 ano immutable
//   /*.svg      → 1 ano immutable
// Roda antes do express.static, que só seta Cache-Control se ainda não existir.
app.use((req, res, next) => {
  const p = req.path;
  if (p.startsWith('/assets/') || /\.(webp|svg)$/i.test(p)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  next();
});

// Static — pasta /assets/ (única pasta de assets do projeto).
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Health check — enriquecido pra debug remoto sem SSH. Não inclui envs/paths
// (segurança) nem chamada ao RVops (custo de quota a cada ping).
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime_seconds: process.uptime(),
    node_version: process.version,
    app_version: APP_VERSION
  });
});

// === Helpers idênticos à Netlify Function ===
function normalizeWhatsapp(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length !== 10 && digits.length !== 11) return null;
  return digits.startsWith('55') ? digits : '55' + digits;
}
function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function sanitize(s, max = 200) {
  return String(s == null ? '' : s).trim().slice(0, max);
}

// POST /api/lead-consignacao — proxy server-side pro RVops.
app.post('/api/lead-consignacao', async (req, res) => {
  if (!RVOPS_CLIENT_ID || !RVOPS_API_KEY || !RVOPS_LP_ORIGEM) {
    console.error('[lead-consignacao] missing env vars', {
      hasClientId: !!RVOPS_CLIENT_ID,
      hasApiKey: !!RVOPS_API_KEY,
      hasLpOrigem: !!RVOPS_LP_ORIGEM
    });
    return res.status(500).json({ error: 'Configuração indisponível, tente novamente em instantes.' });
  }

  const body = req.body || {};

  // Honeypot — preenchido = bot, simula sucesso e descarta.
  if (body.website && String(body.website).trim() !== '') {
    console.warn('[lead-consignacao] honeypot triggered — discarded', { ip: req.ip });
    return res.status(200).json({ ok: true });
  }

  const firstname = sanitize(body.firstname, 120);
  const email = sanitize(body.email, 200).toLowerCase();
  const phone = normalizeWhatsapp(body.phone);
  const marca = sanitize(body.marca, 80);
  const modelo = sanitize(body.modelo, 120);
  const ano = sanitize(body.ano, 4);
  const quilometragem = sanitize(body.quilometragem, 10);

  if (!firstname) return res.status(400).json({ error: 'Nome é obrigatório.' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Email inválido.' });
  if (!phone) return res.status(400).json({ error: 'WhatsApp inválido.' });
  if (!marca) return res.status(400).json({ error: 'Marca é obrigatória.' });
  if (!modelo) return res.status(400).json({ error: 'Modelo é obrigatório.' });
  const anoInt = parseInt(ano, 10);
  const currentYear = new Date().getFullYear();
  if (Number.isNaN(anoInt) || anoInt < 1990 || anoInt > currentYear) {
    return res.status(400).json({ error: 'Ano inválido.' });
  }
  const kmInt = parseInt(quilometragem, 10);
  if (Number.isNaN(kmInt) || kmInt < 0 || kmInt > 999999) {
    return res.status(400).json({ error: 'Quilometragem inválida.' });
  }

  // Nomes EXATOS validados via curl. Hífens onde tem hífen, sem separador nos utm*.
  // tipo-de-conversao-21 / origem-do-negocio-21 / tipo-de-veiculo2 são as
  // properties de segmentação RVops no Contato (sufixos -21/2 são parte do nome).
  const properties = {
    firstname,
    email,
    phone,
    'marca-do-veiculo': marca,
    'modelo-do-veiculo': modelo,
    'ano-de-fabricacaomodelo': String(anoInt),
    quilometragem: String(kmInt),
    lp_origem: RVOPS_LP_ORIGEM,
    'tipo-de-conversao-21': '-consignado',
    'origem-do-negocio-21': '-site',
    'tipo-de-veiculo2': 'carro-4'
  };

  // Mapa UTM: front manda com underscore (utm_source), RVops espera sem
  // separador (utmsource). Vazios são omitidos pra não apagar valor existente.
  const utmMap = {
    utm_source: 'utmsource',
    utm_medium: 'utmmedium',
    utm_campaign: 'utmcampaign',
    utm_content: 'utmcontent',
    utm_term: 'utmterm'
  };
  for (const [from, to] of Object.entries(utmMap)) {
    const v = sanitize(body[from]);
    if (v) properties[to] = v;
  }

  const url = `https://app.rvops.com/${encodeURIComponent(RVOPS_CLIENT_ID)}/api/v1/contacts`;

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 12000);

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'rvops-apikey': RVOPS_API_KEY
      },
      body: JSON.stringify({ properties }),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timeout);
    const aborted = e && e.name === 'AbortError';

    if (aborted) {
      // Timeout do nosso lado, mas o RVops provavelmente processou.
      // Retorna sucesso otimista — se falhou de verdade, o lead se perde
      // (raro com timeout de 12s); se o usuário retentar, 409 = sucesso.
      console.warn('[lead-consignacao] upstream timeout — assuming success', {
        email,
        phone
      });
      return res.status(200).json({ ok: true, deferred: true });
    }

    // Erro de rede real (DNS, TLS, conexão derrubada).
    console.error('[lead-consignacao] upstream fetch failed', {
      aborted: false,
      message: e && e.message,
      email
    });
    return res.status(502).json({ error: 'Não conseguimos registrar agora, tente novamente.' });
  }
  clearTimeout(timeout);

  let upstreamBody = null;
  try { upstreamBody = await upstream.json(); } catch (_) { /* RVops pode devolver não-JSON em erro */ }

  // 409 = duplicado: email OU phone já existe (ambos são identificadores únicos).
  if (upstream.status === 409) {
    console.info('[lead-consignacao] lead recorrente (409 ConflictError)', {
      email,
      phone,
      marca,
      modelo,
      message: upstreamBody && upstreamBody.message
    });
    return res.status(200).json({ ok: true, recurring: true });
  }

  if (upstream.status >= 200 && upstream.status < 300) {
    const contactId = upstreamBody && upstreamBody.id;
    console.info('[lead-consignacao] created', {
      id: contactId,
      email
    });

    // Cria Negócio associado ao Contato. Falha aqui NÃO propaga erro pro
    // usuário — o lead já está no CRM. Logamos pra reconciliação manual.
    const vehicleParts = [marca, modelo, String(anoInt)].filter(Boolean).join(' ').trim();
    const dealName = vehicleParts ? `${firstname} - ${vehicleParts}` : firstname;
    const dealProperties = {
      name: dealName,
      pipeline_id: RVOPS_PIPELINE_ID,
      stage_id: RVOPS_STAGE_ID,
      'tipo-de-conversao-20': '-consignado',
      'origem-do-negocio-20': '-site',
      'tipo-de-veiculo1': 'carro',
      marca_do_veiculo: marca,
      form_consignado__modelo_do_veiculo: modelo,
      ano_do_modelo_fabricacao: String(anoInt),
      km: String(kmInt)
    };

    const dealUrl = `https://app.rvops.com/${encodeURIComponent(RVOPS_CLIENT_ID)}/api/v1/deals`;
    const dealCtrl = new AbortController();
    const dealTimeout = setTimeout(() => dealCtrl.abort(), 12000);

    let dealUpstream;
    try {
      dealUpstream = await fetch(dealUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'rvops-apikey': RVOPS_API_KEY
        },
        body: JSON.stringify({
          properties: dealProperties,
          associations: { contacts: [contactId] }
        }),
        signal: dealCtrl.signal
      });
    } catch (e) {
      clearTimeout(dealTimeout);
      const aborted = e && e.name === 'AbortError';
      console.error('[lead-consignacao] deal creation failed', {
        contactId,
        aborted,
        message: e && e.message,
        sentDealProperties: dealProperties
      });
      return res.status(200).json({ ok: true, dealCreationFailed: true });
    }
    clearTimeout(dealTimeout);

    let dealBody = null;
    try { dealBody = await dealUpstream.json(); } catch (_) { /* RVops pode devolver não-JSON em erro */ }

    if (dealUpstream.status >= 200 && dealUpstream.status < 300) {
      console.info('[lead-consignacao] deal created', {
        dealId: dealBody && dealBody.id,
        contactId
      });
      return res.status(200).json({ ok: true });
    }

    console.error('[lead-consignacao] deal creation failed', {
      contactId,
      dealStatus: dealUpstream.status,
      dealBody,
      sentDealProperties: dealProperties
    });
    return res.status(200).json({ ok: true, dealCreationFailed: true });
  }

  // Erro upstream — log detalhado pro server (inclui body enviado pra debug).
  // API key NUNCA aparece no response.
  console.error('[lead-consignacao] upstream error', {
    status: upstream.status,
    upstreamBody,
    email,
    phone,
    sentProperties: properties
  });
  return res.status(502).json({ error: 'Não conseguimos registrar agora, tente novamente.' });
});

// /api/* não-encontrado → JSON 404 (não cair no SPA fallback).
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Index na raiz.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Página de obrigado (destino do redirect pós-submit do form).
app.get('/obrigado', (req, res) => {
  res.sendFile(path.join(__dirname, 'obrigado.html'));
});

// Política de privacidade (LGPD).
app.get('/privacidade', (req, res) => {
  res.sendFile(path.join(__dirname, 'privacidade.html'));
});

// Catch-all 404 — qualquer rota não-API não-encontrada retorna 404 com a home.
// (Hoje o site é single-page; se virar SPA com rotas client-side no futuro, troca o status pra 200.)
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'index.html'));
});

// Error handler global.
app.use((err, req, res, next) => {
  console.error('[server] unhandled error', err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

app.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT}`);
});
