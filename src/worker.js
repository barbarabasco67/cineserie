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

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function hashPw(pw, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}
async function checkPw(row, pw) {
  if (!row || !row.pass_hash || !row.pass_salt || typeof pw !== 'string') return false;
  return (await hashPw(pw, unb64(row.pass_salt))) === row.pass_hash;
}
// Cambios de esquema que se aplican solos la primera vez (si ya existen, se ignoran).
let migrated;
function migrate(env) {
  if (!migrated) {
    migrated = (async () => {
      const steps = [
        'ALTER TABLE users ADD COLUMN display TEXT',
        'ALTER TABLE users ADD COLUMN bio TEXT',
        'ALTER TABLE users ADD COLUMN pass_hash TEXT',
        'ALTER TABLE users ADD COLUMN pass_salt TEXT',
        'ALTER TABLE library ADD COLUMN review TEXT',
        'ALTER TABLE titles ADD COLUMN collections TEXT',
        'ALTER TABLE titles ADD COLUMN saga TEXT',
        'ALTER TABLE users ADD COLUMN avatar TEXT',
        'ALTER TABLE users ADD COLUMN banner TEXT',
        'ALTER TABLE users ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0',
        "ALTER TABLE follows ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted'",
        "CREATE TABLE IF NOT EXISTS news (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, title_id INTEGER, event_date TEXT, platform TEXT, published_at TEXT NOT NULL DEFAULT (datetime('now')))",
        'CREATE TABLE IF NOT EXISTS follows (follower_id TEXT NOT NULL REFERENCES users(id), followed_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime(\'now\')), PRIMARY KEY (follower_id, followed_id))',
      ];
      steps.sort((a, b) => (a.startsWith('CREATE') ? 0 : 1) - (b.startsWith('CREATE') ? 0 : 1));
      for (const s of steps) { try { await env.DB.prepare(s).run(); } catch { /* ya existe */ } }
    })();
  }
  return migrated;
}
const HANDLE = /^[a-z0-9_.]{3,20}$/;
async function meInfo(env, uid) {
  const u = await env.DB.prepare('SELECT id, handle, display, bio, pass_hash, is_private, avatar, banner FROM users WHERE id = ?').bind(uid).first();
  const f = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM follows WHERE followed_id = ?1 AND status = 'accepted') AS followers,
            (SELECT COUNT(*) FROM follows WHERE follower_id = ?1 AND status = 'accepted') AS following,
            (SELECT COUNT(*) FROM follows WHERE followed_id = ?1 AND status = 'pending') AS requests`
  ).bind(uid).first();
  return { handle: u.handle, display: u.display || '', bio: u.bio || '', avatar: u.avatar || '', banner: u.banner || '', has_pass: !!u.pass_hash, is_private: !!u.is_private, followers: f.followers, following: f.following, requests: f.requests };
}

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

async function handleApi(request, env, url) {
  await migrate(env);
  if (url.pathname === '/api/login' && request.method === 'POST') {
    const b = await readBody(request);
    const h = txt(b && b.handle, 30).toLowerCase().replace(/^@/, '');
    const row = await env.DB.prepare('SELECT id, pass_hash, pass_salt FROM users WHERE handle = ?').bind(h).first();
    if (!row || !(await checkPw(row, b && b.password))) return bad('usuario o contraseña incorrectos', 401);
    return json({ uid: row.id });
  }
  const uid = request.headers.get('x-uid') || '';
  if (!/^[0-9a-f-]{36}$/i.test(uid)) return bad('identificador no válido');
  await ensureUser(env, uid);
  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method;

  if (path === '/state' && method === 'GET') {
    const titles = await env.DB.prepare(
      "SELECT id, title, type, year, episodes, minutes, synopsis, genre, hue, platforms, tags, poster, director, writers, release_date, age, collections, saga, source, review_status,\n        (SELECT ROUND(AVG(json_extract(l.ratings, '$.score'))) FROM library l WHERE l.title_id = titles.id AND json_extract(l.ratings, '$.score') > 0) AS avg,\n        (SELECT COUNT(*) FROM library l WHERE l.title_id = titles.id AND json_extract(l.ratings, '$.score') > 0) AS votes\n       FROM titles WHERE (owner_id = ? OR review_status = 'approved')"
    ).bind(uid).all();
    const library = await env.DB.prepare('SELECT title_id, status, episode, ratings, review FROM library WHERE user_id = ?').bind(uid).all();
    const posts = await env.DB.prepare(
      `SELECT p.id, p.body, p.title_id, p.created_at, u.handle, u.display,
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
    const news = await env.DB.prepare('SELECT id, kind, title, body, title_id, event_date, platform, published_at FROM news ORDER BY published_at DESC, id DESC LIMIT 40').all();
    const me = await meInfo(env, uid);
    return json({ me, titles: titles.results, library: library.results, posts: posts.results, weekly: weekly.results, news: news.results });
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
  if (m && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM library WHERE user_id = ? AND title_id = ?').bind(uid, Number(m[1])).run();
    return json({ ok: true });
  }
  if (m && method === 'PUT') {
    const b = await readBody(request);
    if (!b || !STATUS.includes(b.status)) return bad('estado no válido');
    const rt = b.ratings && typeof b.ratings === 'object' ? { ...b.ratings } : {};
    if ('score' in rt) rt.score = int(rt.score, 0, 100, 0);
    const ratings = JSON.stringify(rt).slice(0, 300);
    const review = txt(b.review, 400);
    try {
      await env.DB.prepare(
        `INSERT INTO library (user_id, title_id, status, episode, ratings, review, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, title_id) DO UPDATE SET status = excluded.status, episode = excluded.episode, ratings = excluded.ratings, review = excluded.review, updated_at = excluded.updated_at`
      ).bind(uid, Number(m[1]), b.status, int(b.episode, 0, 9999, 0), ratings, review).run();
    } catch { return bad('título no encontrado', 404); }
    return json({ ok: true });
  }

  if (path === '/me' && method === 'PUT') {
    const b = await readBody(request);
    if (!b) return bad('cuerpo no válido');
    const handle = txt(b.handle, 30).toLowerCase().replace(/^@/, '');
    if (!HANDLE.test(handle)) return bad('El usuario debe tener de 3 a 20 letras, números, punto o guion bajo');
    try {
      await env.DB.prepare('UPDATE users SET handle = ?, display = ?, bio = ? WHERE id = ?').bind(handle, txt(b.display, 30), txt(b.bio, 160), uid).run();
    } catch { return bad('Ese nombre de usuario ya está cogido', 409); }
    return json(await meInfo(env, uid));
  }

  if (path === '/media' && method === 'PUT') {
    const b = await readBody(request);
    if (!b) return bad('cuerpo no válido');
    const ok = (v, max) => v === '' || (typeof v === 'string' && v.length <= max && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(v));
    for (const [k, max] of [['avatar', 90000], ['banner', 220000]]) {
      if (b[k] === undefined) continue;
      if (!ok(b[k], max)) return bad('La imagen no es válida o pesa demasiado');
      await env.DB.prepare('UPDATE users SET ' + k + ' = ? WHERE id = ?').bind(b[k] || null, uid).run();
    }
    return json(await meInfo(env, uid));
  }

  if (path === '/password' && method === 'POST') {
    const b = await readBody(request);
    const pw = b && typeof b.password === 'string' ? b.password : '';
    if (pw.length < 8 || pw.length > 72) return bad('La contraseña debe tener entre 8 y 72 caracteres');
    const row = await env.DB.prepare('SELECT pass_hash, pass_salt FROM users WHERE id = ?').bind(uid).first();
    if (row && row.pass_hash && !(await checkPw(row, b.current))) return bad('La contraseña actual no es correcta', 403);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    await env.DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').bind(await hashPw(pw, salt), b64(salt), uid).run();
    return json({ ok: true });
  }

  m = path.match(/^\/profile\/([a-z0-9_.]{3,20})(?:\/(followers|following))?$/);
  if (m && method === 'GET') {
    const u = await env.DB.prepare('SELECT id, handle, display, bio, created_at, is_private, avatar, banner FROM users WHERE handle = ?').bind(m[1]).first();
    if (!u) return bad('Perfil no encontrado', 404);
    const rel = await env.DB.prepare('SELECT status FROM follows WHERE follower_id = ? AND followed_id = ?').bind(uid, u.id).first();
    const isMe = u.id === uid;
    const visible = isMe || !u.is_private || (rel && rel.status === 'accepted');
    if (m[2]) {
      if (!visible) return bad('Perfil privado', 403);
      const col = m[2] === 'followers' ? ['follower_id', 'followed_id'] : ['followed_id', 'follower_id'];
      const r = await env.DB.prepare(
        `SELECT p.handle, p.display, (p.id = ?1) AS me, (SELECT status FROM follows x WHERE x.follower_id = ?1 AND x.followed_id = p.id) AS rel
         FROM follows f JOIN users p ON p.id = f.${col[0]} WHERE f.${col[1]} = ?2 AND f.status = 'accepted' ORDER BY f.created_at DESC LIMIT 100`
      ).bind(uid, u.id).all();
      return json({ users: r.results.map((x) => ({ handle: x.handle, display: x.display || '', me: !!x.me, rel: x.rel || null })) });
    }
    const f = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM follows WHERE followed_id = ?1 AND status = 'accepted') AS followers,
              (SELECT COUNT(*) FROM follows WHERE follower_id = ?1 AND status = 'accepted') AS following,
              (SELECT COUNT(*) FROM follows WHERE follower_id = ?1 AND followed_id = ?2 AND status = 'accepted') AS follows_me`
    ).bind(u.id, uid).first();
    const out = { user: { handle: u.handle, display: u.display || '', bio: u.bio || '', avatar: u.avatar || '', banner: u.banner || '', joined: u.created_at }, followers: f.followers, following: f.following, is_me: isMe, is_private: !!u.is_private, visible: !!visible, status: rel ? rel.status : null, follows_me: f.follows_me > 0, library: [], posts: [] };
    if (visible) {
      const lib = await env.DB.prepare('SELECT title_id, status, episode, ratings, review, updated_at FROM library WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200').bind(u.id).all();
      const posts = await env.DB.prepare(
        `SELECT p.id, p.body, p.title_id, p.created_at,
          (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS likes,
          (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
         FROM posts p WHERE p.user_id = ? ORDER BY p.id DESC LIMIT 30`
      ).bind(uid, u.id).all();
      out.library = lib.results; out.posts = posts.results;
    }
    return json(out);
  }

  m = path.match(/^\/follow\/([a-z0-9_.]{3,20})$/);
  if (m && (method === 'POST' || method === 'DELETE')) {
    const u = await env.DB.prepare('SELECT id, is_private FROM users WHERE handle = ?').bind(m[1]).first();
    if (!u) return bad('Perfil no encontrado', 404);
    if (u.id === uid) return bad('No puedes seguirte a ti misma');
    let status = null;
    if (method === 'POST') {
      await env.DB.prepare('INSERT OR IGNORE INTO follows (follower_id, followed_id, status) VALUES (?, ?, ?)').bind(uid, u.id, u.is_private ? 'pending' : 'accepted').run();
      const cur = await env.DB.prepare('SELECT status FROM follows WHERE follower_id = ? AND followed_id = ?').bind(uid, u.id).first();
      status = cur.status;
    } else await env.DB.prepare('DELETE FROM follows WHERE follower_id = ? AND followed_id = ?').bind(uid, u.id).run();
    const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM follows WHERE followed_id = ? AND status = 'accepted'").bind(u.id).first();
    return json({ status, followers: c.n });
  }

  if (path === '/privacy' && method === 'PUT') {
    const b = await readBody(request);
    await env.DB.prepare('UPDATE users SET is_private = ? WHERE id = ?').bind(b && b.private ? 1 : 0, uid).run();
    return json(await meInfo(env, uid));
  }

  if (path === '/requests' && method === 'GET') {
    const r = await env.DB.prepare("SELECT u.handle, u.display FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followed_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC LIMIT 50").bind(uid).all();
    return json({ requests: r.results.map((x) => ({ handle: x.handle, display: x.display || '' })) });
  }

  m = path.match(/^\/requests\/([a-z0-9_.]{3,20})$/);
  if (m && (method === 'POST' || method === 'DELETE')) {
    const u = await env.DB.prepare('SELECT id FROM users WHERE handle = ?').bind(m[1]).first();
    if (!u) return bad('Perfil no encontrado', 404);
    if (method === 'POST') await env.DB.prepare("UPDATE follows SET status = 'accepted' WHERE follower_id = ? AND followed_id = ? AND status = 'pending'").bind(u.id, uid).run();
    else await env.DB.prepare("DELETE FROM follows WHERE follower_id = ? AND followed_id = ? AND status = 'pending'").bind(u.id, uid).run();
    return json(await meInfo(env, uid));
  }

  if (path === '/people' && method === 'GET') {
    const r = await env.DB.prepare(
      `SELECT u.handle, u.display, (SELECT COUNT(*) FROM follows f WHERE f.followed_id = u.id AND f.status = 'accepted') AS followers
       FROM users u WHERE u.id != ?1 AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ?1 AND f.followed_id = u.id)
         AND EXISTS (SELECT 1 FROM library l WHERE l.user_id = u.id)
       ORDER BY followers DESC, u.created_at DESC LIMIT 10`
    ).bind(uid).all();
    return json({ people: r.results });
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
