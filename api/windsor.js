// =============================================================================
//  api/windsor.js  —  Função serverless (Vercel) para o Painel LNR
// -----------------------------------------------------------------------------
//  O que ela faz:
//   1. Busca os dados do Windsor.ai (perfil-dia + conteúdo) no servidor.
//   2. Sua chave do Windsor NUNCA aparece no navegador — fica numa env var.
//   3. Transforma o resultado no MESMO formato que o painel espera (DATA).
//
//  Como configurar (uma vez):
//   a) No painel do Windsor, monte a seleção (a mesma que fizemos) e copie a
//      URL de API no formato JSON. São DUAS URLs:
//        • diária  -> fields: date, reach, views, total_interactions, likes, comments, saves
//        • conteúdo-> fields: timestamp, media_caption, media_type, media_reach,
//                              media_views, media_engagement, media_saved,
//                              media_comments_count, media_permalink
//      Cada URL já vem com sua api_key embutida.
//   b) Na Vercel, em Settings → Environment Variables, crie:
//        WINDSOR_FEED_DAILY = (cole a 1ª URL)
//        WINDSOR_FEED_POSTS = (cole a 2ª URL)
//   c) No painel (index.html), troque CONFIG.mode para 'live'.
//
//  Atualização: cada abertura do painel chama esta função e puxa dado fresco.
//  Para um snapshot agendado (diário/semanal), veja vercel.json (cron opcional).
// =============================================================================

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');

  const DAILY_URL = process.env.WINDSOR_FEED_DAILY;
  const POSTS_URL = process.env.WINDSOR_FEED_POSTS;

  if (!DAILY_URL || !POSTS_URL) {
    return res.status(500).json({
      error: 'Defina WINDSOR_FEED_DAILY e WINDSOR_FEED_POSTS nas variáveis de ambiente da Vercel.'
    });
  }

  try {
    const [dailyRaw, postsRaw] = await Promise.all([
      fetch(DAILY_URL).then(r => r.json()),
      fetch(POSTS_URL).then(r => r.json())
    ]);

    // Windsor devolve { data: [...] } ou direto [...] dependendo da conta.
    const dailyRows = dailyRaw.data || dailyRaw || [];
    const postRows  = postsRaw.data || postsRaw || [];

    const out = transform(dailyRows, postRows);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: 'Falha ao buscar Windsor', detail: String(e) });
  }
}

// ---- helpers ----------------------------------------------------------------
const ddmm = iso => {
  // "2026-06-08" ou "2026-06-08T11:23:50+0000" -> "08/06"
  const d = String(iso).slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}/${d[1]}` : String(iso);
};
const num = v => (v == null || v === '' ? 0 : Number(v));

function transform(dailyRows, postRows) {
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

  const posts = postRows
    .map(r => ({
      date: ddmm(r.timestamp || r.date),
      type: isReel(r) ? 'Reel' : 'Carrossel',
      title: cleanTitle(r.media_caption),
      reach: num(r.media_reach),
      views: num(r.media_views),
      eng: num(r.media_engagement),
      saves: num(r.media_saved),
      comments: num(r.media_comments_count),
      url: r.media_permalink || '#'
    }))
    .sort((a, b) => b.reach - a.reach)
    .slice(0, 12);

  // -------- comparação de formato --------
  const reels = posts.filter(p => p.type === 'Reel');
  const carr  = posts.filter(p => p.type === 'Carrossel');
  const avg = arr => (arr.length ? arr.reduce((s, p) => s + p.reach, 0) / arr.length : 0);
  const format = {
    reelReach: +avg(reels).toFixed(1),
    carrReach: +avg(carr).toFixed(1),
    reels: reels.length,
    carrossels: carr.length
  };

  // -------- perfil (snapshot) --------
  // Se você adicionar followers_count/media_count numa 3ª chamada, injete aqui.
  const profile = { followers: 5, follows: 12, mediaCount: postRows.length };

  return { profile, totals, format, daily, posts };
}

function cleanTitle(caption) {
  if (!caption) return 'Post';
  // primeira linha, sem emoji solto no fim, cortada
  const first = String(caption).split('\n')[0].trim();
  return first.length > 70 ? first.slice(0, 67) + '…' : first;
}
