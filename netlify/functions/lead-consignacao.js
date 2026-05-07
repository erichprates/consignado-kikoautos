// Proxy server-side: recebe lead da LP, normaliza e envia ao RVops.
// Roda em Node 18+ (Netlify Functions) — usa fetch global, sem deps.
//
// Os nomes internos das properties no RVops são inconsistentes (testados via
// curl): hífens em umas, sem separador em outras. Mantidos exatamente como
// validados — qualquer divergência faz o RVops rejeitar ou ignorar silenciosamente.

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const { RVOPS_CLIENT_ID, RVOPS_API_KEY, RVOPS_LP_ORIGEM } = process.env;
  if (!RVOPS_CLIENT_ID || !RVOPS_API_KEY || !RVOPS_LP_ORIGEM) {
    console.error('[lead-consignacao] missing env vars', {
      hasClientId: !!RVOPS_CLIENT_ID,
      hasApiKey: !!RVOPS_API_KEY,
      hasLpOrigem: !!RVOPS_LP_ORIGEM
    });
    return json(500, { error: 'Configuração indisponível, tente novamente em instantes.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Payload inválido.' });
  }

  // Honeypot — se vier preenchido, simula sucesso e descarta silenciosamente.
  if (body.website && String(body.website).trim() !== '') {
    console.warn('[lead-consignacao] honeypot triggered — discarded', {
      ip: event.headers['x-forwarded-for'] || event.headers['x-nf-client-connection-ip']
    });
    return json(200, { ok: true });
  }

  const firstname = sanitize(body.firstname, 120);
  const email = sanitize(body.email, 200).toLowerCase();
  const phone = normalizeWhatsapp(body.phone);
  const marca = sanitize(body.marca, 80);
  const modelo = sanitize(body.modelo, 120);
  const ano = sanitize(body.ano, 4);
  const quilometragem = sanitize(body.quilometragem, 10);

  if (!firstname) return json(400, { error: 'Nome é obrigatório.' });
  if (!isValidEmail(email)) return json(400, { error: 'Email inválido.' });
  if (!phone) return json(400, { error: 'WhatsApp inválido.' });
  if (!marca) return json(400, { error: 'Marca é obrigatória.' });
  if (!modelo) return json(400, { error: 'Modelo é obrigatório.' });
  const anoInt = parseInt(ano, 10);
  const currentYear = new Date().getFullYear();
  if (Number.isNaN(anoInt) || anoInt < 1990 || anoInt > currentYear) {
    return json(400, { error: 'Ano inválido.' });
  }
  const kmInt = parseInt(quilometragem, 10);
  if (Number.isNaN(kmInt) || kmInt < 0) return json(400, { error: 'Quilometragem inválida.' });

  // Nomes EXATOS conforme validados via curl. Hífens onde tem hífen, sem
  // separador nos utm*. Bracket notation obrigatória pelos hífens.
  const properties = {
    firstname,
    email,
    phone,
    'marca-do-veiculo': marca,
    'modelo-do-veiculo': modelo,
    'ano-de-fabricacaomodelo': String(anoInt),
    quilometragem: String(kmInt),
    lp_origem: RVOPS_LP_ORIGEM
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
  const timeout = setTimeout(() => ctrl.abort(), 5000);

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
    console.error('[lead-consignacao] upstream fetch failed', {
      aborted,
      message: e && e.message,
      email
    });
    return json(502, { error: 'Não conseguimos registrar agora, tente novamente.' });
  }
  clearTimeout(timeout);

  let upstreamBody = null;
  try { upstreamBody = await upstream.json(); } catch (_) { /* RVops pode devolver não-JSON em erro */ }

  // 409 = duplicado: email OU phone já existe em outro contato (ambos são
  // identificadores únicos no RVops). Tratamos como sucesso pro usuário.
  if (upstream.status === 409) {
    console.info('[lead-consignacao] lead recorrente (409 ConflictError)', {
      email,
      phone,
      marca,
      modelo,
      message: upstreamBody && upstreamBody.message
    });
    return json(200, { ok: true, recurring: true });
  }

  if (upstream.status >= 200 && upstream.status < 300) {
    console.info('[lead-consignacao] created', {
      id: upstreamBody && upstreamBody.id,
      email
    });
    return json(200, { ok: true });
  }

  // Erro upstream — log detalhado pro server (inclui body enviado pra debug),
  // mensagem genérica pro cliente. API key NUNCA aparece no response.
  console.error('[lead-consignacao] upstream error', {
    status: upstream.status,
    upstreamBody,
    email,
    phone,
    sentProperties: properties
  });
  return json(502, { error: 'Não conseguimos registrar agora, tente novamente.' });
};
