// =============================================================================
//  api/windsor.js  —  Função serverless (Vercel) para o Painel LNR
// -----------------------------------------------------------------------------
//  O que ela faz:
//   1. Busca os dados do Windsor.ai (perfil-dia + conteúdo + perfil) no servidor.
//   2. Sua chave do Windsor NUNCA aparece no navegador — fica numa env var.
//   3. Transforma o resultado no MESMO formato que o painel espera (DATA).
//
//  IMPORTANTE — janela SEMPRE móvel:
//   As URLs salvas no Windsor podem ter um intervalo de datas FIXO embutido
//   (date_from / date_to). Se isso acontecer, o painel "congela" naquele período.
//   Para evitar isso, esta função REESCREVE a query: remove qualquer data fixa e
//   aplica uma janela contínua (últimos 30 dias para o diário, 90 para posts),
//   além de pedir os campos certos. Assim o painel é de fato AO VIVO, sem você
//   precisar mexer nas variáveis de ambiente.
//
//  Como configurar (uma vez):
//   a) No painel do Windsor, monte a seleção do conector Instagram e copie a URL
//      de API no formato JSON. Basta UMA URL (com a sua api_key embutida) — a
//      função deriva as três consultas a partir dela. Se quiser, pode informar
//      duas (diária e conteúdo); ambas são tratadas como base.
//   b) Na Vercel, em Settings → Environment Variables, crie:
//        WINDSOR_FEED_DAILY = (cole a URL — usada como base p/ diário e perfil)
//        WINDSOR_FEED_POSTS = (cole a URL — usada como base p/ conteúdo)
//      Podem ser a mesma URL nas duas; os campos e datas são reescritos aqui.
//   c) No painel (index.html), CONFIG.mode já está em 'live'.
// =============================================================================

export default async function handler(req, res) {
  // 30 min de cache na borda; serve "stale" por 1 dia enquanto revalida.
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');

  const DAILY_BASE = process.env.WINDSOR_FEED_DAILY;
  const POSTS_BASE = process.env.WINDSOR_FEED_POSTS || DAILY_BASE;

  if (!DAILY_BASE) {
    return res.status(500).json({
      error: 'Defina WINDSOR_FEED_DAILY (e opcionalmente WINDSOR_FEED_POSTS) nas variáveis de ambiente da Vercel.'
    });
  }

  // Janela móvel calculada no servidor (datas explícitas = formato mais
  // compatível com a API de conectores do Windsor).
  const today = new Date();
  const iso = d => d.toISOString().slice(0, 10);
  const daysAgo = n => { const d = new Date(today); d.setUTCDate(d.getUTCDate() - n); return iso(d); };
  const TODAY = iso(today);

  // Reescreve cada consulta forçando campos + janela móvel.
  const dailyUrl = withQuery(DAILY_BASE, {
    fields: 'date,reach,views,total_interactions,likes,comments,saves,accounts_engaged',
    date_from: daysAgo(30), date_to: TODAY
  });
  const postsUrl = withQuery(POSTS_BASE, {
    fields: 'timestamp,media_caption,media_type,media_product_type,media_reach,media_views,media_engagement,media_saved,media_comments_count,media_permalink',
    date_from: daysAgo(90), date_to: TODAY
  });
  const profileUrl = withQuery(DAILY_BASE, {
    fields: 'followers_count,follows_count,media_count,account_name,username',
    date_from: daysAgo(7), date_to: TODAY
  });

  try {
    const [dailyRaw, postsRaw, profileRaw] = await Promise.all([
      fetchJson(dailyUrl),
      fetchJson(postsUrl),
      fetchJson(profileUrl).catch(() => null)   // perfil é "bônus": não derruba tudo
    ]);

    const out = transform(rows(dailyRaw), rows(postsRaw), rows(profileRaw));
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: 'Falha ao buscar Windsor', detail: String(e) });
  }
}

// ---- helpers ----------------------------------------------------------------

// Reescreve a query string de uma URL do Windsor: remove datas fixas e aplica
// os parâmetros desejados (campos + janela). Se a URL for inválida, devolve crua.
function withQuery(rawUrl, params) {
  try {
    const u = new URL(rawUrl);
    ['date_from', 'date_to', 'start_date', 'end_date', 'last_n_days', 'date_range', 'date_preset']
      .forEach(k => u.searchParams.delete(k));
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function fetchJson(url) {
  return fetch(url).then(r => r.json());
}

// Windsor devolve { data: [...] } ou direto [...] dependendo da conta.
function rows(raw) {
  if (!raw) return [];
  return raw.data || (Array.isArray(raw) ? raw : []);
}

const ddmm = iso => {
  // "2026-06-08" ou "2026-06-08T11:23:50+0000" -> "08/06"
  const d = String(iso).slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}/${d[1]}` : String(iso);
};
const num = v => (v == null || v === '' ? 0 : Number(v));

function transform(dailyRows, postRows, profileRows) {
  // -------- diário --------
  const daily = dailyRows
    .map(r => ({
      d: ddmm(r.date),
      iso: String(r.date).slice(0, 10),
      reach: num(r.reach),
      views: num(r.views),
      interactions: num(r.total_interactions)
    }))
    .sort((a, b) => a.iso.localeCompare(b.iso))
    .map(({ iso, ...rest }) => rest);

  const sum = k => dailyRows.reduce((s, r) => s + num(r[k]), 0);
  const totals = {
    reach: sum('reach'),
    views: sum('views'),
    interactions: sum('total_interactions'),
    likes: sum('likes'),
    comments: sum('comments'),
    saves: sum('saves'),
    accountsEngaged: sum('accounts_engaged'),
    activeDays: dailyRows.filter(r => num(r.reach) > 0).length,
    totalDays: dailyRows.length
  };

  // -------- conteúdo --------
  const isReel = r =>
    /REEL/i.test(r.media_type || '') || /REEL/i.test(r.media_product_type || '');

  const allPosts = postRows.map(r => ({
    date: ddmm(r.timestamp || r.date),
    type: isReel(r) ? 'Reel' : 'Carrossel',
    title: cleanTitle(r.media_caption),
    reach: num(r.media_reach),
    views: num(r.media_views),
    eng: num(r.media_engagement),
    saves: num(r.media_saved),
    comments: num(r.media_comments_count),
    url: r.media_permalink || '#'
  }));

  // Comparação de formato calculada sobre TODOS os posts (não só o top 12).
  const reels = allPosts.filter(p => p.type === 'Reel');
  const carr  = allPosts.filter(p => p.type === 'Carrossel');
  const avg = arr => (arr.length ? arr.reduce((s, p) => s + p.reach, 0) / arr.length : 0);
  const format = {
    reelReach: +avg(reels).toFixed(1),
    carrReach: +avg(carr).toFixed(1),
    reels: reels.length,
    carrossels: carr.length
  };

  // Ranking exibido: top 12 por alcance.
  const posts = [...allPosts].sort((a, b) => b.reach - a.reach).slice(0, 12);

  // -------- perfil (seguidores reais) --------
  let followers = 0, follows = 0, mediaCount = allPosts.length, username = '';
  if (profileRows && profileRows.length) {
    // pega a linha mais recente com followers_count válido
    const valid = profileRows.filter(r => r.followers_count != null && r.followers_count !== '');
    const p = valid.length ? valid[valid.length - 1] : profileRows[profileRows.length - 1];
    followers  = num(p.followers_count);
    follows    = num(p.follows_count);
    mediaCount = num(p.media_count) || allPosts.length;
    username   = p.username || p.account_name || '';
  }
  const profile = { followers, follows, mediaCount, username };

  return { profile, totals, format, daily, posts };
}

function cleanTitle(caption) {
  if (!caption) return 'Post';
  const first = String(caption).split('\n')[0].trim();
  return first.length > 70 ? first.slice(0, 67) + '…' : first;
}
