// API de Cineserie sobre Cloudflare Workers + D1. Los archivos de public/ los sirve Cloudflare.
const STATUS = ['Quiero ver', 'Viendo', 'Vista', 'En pausa', 'Abandonada'];
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const txt = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v, min, max, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const list = (v, max) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, max).map((x) => x.slice(0, 40)) : []);

async function ensureUser(env, uid) {
  const handle = 'u' + uid.replace(/-/g, '').slice(0, 8);
  await env.DB.prepare('INSERT OR IGNORE INTO users (id, handle) VALUES (?, ?)').bind(uid, handle).run();
  return env.DB.prepare('SELECT id, handle FROM users WHERE id = ?').bind(uid).first();
}

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

async function handleApi(request, env, url) {
  const uid = request.headers.get('x-uid') || '';
  if (!/^[0-9a-f-]{36}$/i.test(uid)) return bad('identificador no válido');
  const me = await ensureUser(env, uid);
  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method;

  if (path === '/state' && method === 'GET') {
    const titles = await env.DB.prepare(
      "SELECT id, title, type, year, episodes, minutes, synopsis, genre, hue, platforms, tags, poster, director, writers, release_date, age, source, review_status,\n        (SELECT ROUND(AVG(json_extract(l.ratings, '$.score'))) FROM library l WHERE l.title_id = titles.id AND json_extract(l.ratings, '$.score') > 0) AS avg,\n        (SELECT COUNT(*) FROM library l WHERE l.title_id = titles.id AND json_extract(l.ratings, '$.score') > 0) AS votes\n       FROM titles WHERE (owner_id = ? OR review_status = 'approved')"
    ).bind(uid).all();
    const library = await env.DB.prepare('SELECT title_id, status, episode, ratings FROM library WHERE user_id = ?').bind(uid).all();
    const posts = await env.DB.prepare(
      `SELECT p.id, p.body, p.title_id, p.created_at, u.handle,
        (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS likes,
        (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
       FROM posts p JOIN users u ON u.id = p.user_id ORDER BY p.id DESC LIMIT 50`
    ).bind(uid).all();
    const weekly = await env.DB.prepare(
      `SELECT title_id, ROUND(AVG(score)) AS avg, COUNT(*) AS votes FROM (
         SELECT title_id, json_extract(ratings, '$.score') AS score FROM library
         WHERE updated_at >= datetime('now', '-7 days') AND json_extract(ratings, '$.score') > 0)
       GROUP BY title_id ORDER BY avg DESC, votes DESC LIMIT 10`
    ).all();
    return json({ me, titles: titles.results, library: library.results, posts: posts.results, weekly: weekly.results });
  }

  if (path === '/titles' && method === 'POST') {
    const b = await readBody(request);
    if (!b) return bad('cuerpo no válido');
    const title = txt(b.title, 80), synopsis = txt(b.synopsis, 400);
    if (!title || !synopsis) return bad('faltan título o sinopsis');
    const type = b.type === 'Película' ? 'Película' : 'Serie';
    const status = b.propose ? 'pending' : 'private';
    const res = await env.DB.prepare(
      `INSERT INTO titles (title, type, year, episodes, minutes, synopsis, hue, platforms, tags, source, review_status, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?)`
    ).bind(title, type, int(b.year, 1900, 2100, 2026), int(b.episodes, 1, 9999, 1), int(b.minutes, 0, 9999, 0), synopsis,
      int(b.hue, 0, 360, 30), JSON.stringify(list(b.platforms, 12)), JSON.stringify(list(b.tags, 12)), status, uid).run();
    const id = res.meta.last_row_id;
    await env.DB.prepare("INSERT OR IGNORE INTO library (user_id, title_id, status, episode) VALUES (?, ?, 'Quiero ver', 0)").bind(uid, id).run();
    return json({ id });
  }

  let m = path.match(/^\/library\/(\d+)$/);
  if (m && method === 'PUT') {
    const b = await readBody(request);
    if (!b || !STATUS.includes(b.status)) return bad('estado no válido');
    const rt = b.ratings && typeof b.ratings === 'object' ? { ...b.ratings } : {};
    if ('score' in rt) rt.score = int(rt.score, 0, 100, 0);
    const ratings = JSON.stringify(rt).slice(0, 300);
    try {
      await env.DB.prepare(
        `INSERT INTO library (user_id, title_id, status, episode, ratings, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, title_id) DO UPDATE SET status = excluded.status, episode = excluded.episode, ratings = excluded.ratings, updated_at = excluded.updated_at`
      ).bind(uid, Number(m[1]), b.status, int(b.episode, 0, 9999, 0), ratings).run();
    } catch { return bad('título no encontrado', 404); }
    return json({ ok: true });
  }

  if (path === '/posts' && method === 'POST') {
    const b = await readBody(request);
    const body = b && txt(b.body, 400);
    if (!body) return bad('mensaje vacío');
    const titleId = b.title_id ? Number(b.title_id) : null;
    try {
      const res = await env.DB.prepare('INSERT INTO posts (user_id, body, title_id) VALUES (?, ?, ?)').bind(uid, body, titleId).run();
      return json({ id: res.meta.last_row_id });
    } catch { return bad('título no encontrado', 404); }
  }

  m = path.match(/^\/posts\/(\d+)\/like$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    const had = await env.DB.prepare('SELECT 1 AS x FROM post_likes WHERE post_id = ? AND user_id = ?').bind(id, uid).first();
    try {
      if (had) await env.DB.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').bind(id, uid).run();
      else await env.DB.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)').bind(id, uid).run();
    } catch { return bad('publicación no encontrada', 404); }
    return json({ liked: !had });
  }

  return bad('no encontrado', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(request, env, url); }
      catch (e) { return bad('error del servidor', 500); }
    }
    return env.ASSETS.fetch(request);
  },
};
