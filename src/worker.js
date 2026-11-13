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
        'ALTER TABLE news ADD COLUMN image TEXT',
        "CREATE TABLE IF NOT EXISTS lists (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, name TEXT NOT NULL, descr TEXT, is_public INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
        "CREATE TABLE IF NOT EXISTS list_items (list_id INTEGER NOT NULL, title_id INTEGER NOT NULL, pos INTEGER NOT NULL DEFAULT 0, added_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (list_id, title_id))",
        'ALTER TABLE posts ADD COLUMN list_id INTEGER',
        'ALTER TABLE users ADD COLUMN email TEXT',
        'ALTER TABLE users ADD COLUMN rec_hash TEXT',
        'ALTER TABLE users ADD COLUMN rec_salt TEXT',
        'ALTER TABLE users ADD COLUMN mail_hash TEXT',
        'ALTER TABLE users ADD COLUMN mail_salt TEXT',
        'ALTER TABLE users ADD COLUMN mail_exp INTEGER',
        'ALTER TABLE users ADD COLUMN fails INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE users ADD COLUMN lock_until INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE plans ADD COLUMN title TEXT',
        "CREATE TABLE IF NOT EXISTS plan_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, user_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
        'CREATE TABLE IF NOT EXISTS blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')), PRIMARY KEY (blocker_id, blocked_id))',
        "CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, reporter_id TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
        "CREATE TABLE IF NOT EXISTS plans (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, title_id INTEGER NOT NULL, date TEXT NOT NULL, time TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
        'CREATE TABLE IF NOT EXISTS plan_members (plan_id INTEGER NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (plan_id, user_id))',
        'ALTER TABLE posts ADD COLUMN spoiler INTEGER NOT NULL DEFAULT 0',
        "CREATE TABLE IF NOT EXISTS post_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, user_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
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
  const u = await env.DB.prepare('SELECT id, handle, display, bio, pass_hash, is_private, avatar, banner, email, rec_hash FROM users WHERE id = ?').bind(uid).first();
  const f = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM follows WHERE followed_id = ?1 AND status = 'accepted') AS followers,
            (SELECT COUNT(*) FROM follows WHERE follower_id = ?1 AND status = 'accepted') AS following,
            (SELECT COUNT(*) FROM follows WHERE followed_id = ?1 AND status = 'pending') AS requests`
  ).bind(uid).first();
  return { handle: u.handle, display: u.display || '', bio: u.bio || '', avatar: u.avatar || '', banner: u.banner || '', has_pass: !!u.pass_hash, email: u.email || '', has_recovery: !!u.rec_hash, mail_ready: mailReady(env), is_private: !!u.is_private, followers: f.followers, following: f.following, requests: f.requests };
}

const RECOVERY_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRecoveryCode() {
  const r = crypto.getRandomValues(new Uint8Array(12));
  const c = Array.from(r, (x) => RECOVERY_ALPHA[x % RECOVERY_ALPHA.length]).join('');
  return c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8);
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function setRecovery(env, uid) {
  const code = newRecoveryCode();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await env.DB.prepare('UPDATE users SET rec_hash = ?, rec_salt = ? WHERE id = ?').bind(await hashPw(normCode(code), salt), b64(salt), uid).run();
  return code;
}
// Bloqueo por intentos: 5 fallos seguidos = 15 minutos sin poder probar.
async function lockedOut(env, row) { return !!(row && row.lock_until && row.lock_until > Date.now()); }
async function noteFail(env, id) {
  await env.DB.prepare('UPDATE users SET fails = fails + 1, lock_until = CASE WHEN fails + 1 >= 5 THEN ? ELSE lock_until END WHERE id = ?').bind(Date.now() + 15 * 60000, id).run();
  await env.DB.prepare('UPDATE users SET fails = 0 WHERE id = ? AND fails >= 5').bind(id).run();
}
const mailReady = (env) => !!(env.RESEND_API_KEY && env.MAIL_FROM);
async function sendMail(env, to, subject, text) {
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }) });
  return r.ok;
}

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

async function handleApi(request, env, url) {
  await migrate(env);
  if (url.pathname === '/api/login' && request.method === 'POST') {
    const b = await readBody(request);
    const h = txt(b && b.handle, 30).toLowerCase().replace(/^@/, '');
    const row = await env.DB.prepare('SELECT id, pass_hash, pass_salt, lock_until FROM users WHERE handle = ?').bind(h).first();
    if (await lockedOut(env, row)) return bad('Demasiados intentos. Prueba de nuevo en 15 minutos.', 429);
    if (!row || !(await checkPw(row, b && b.password))) { if (row) await noteFail(env, row.id); return bad('usuario o contraseña incorrectos', 401); }
    return json({ uid: row.id });
  }
  if (url.pathname === '/api/reset-request' && request.method === 'POST') {
    const b = await readBody(request);
    const h = txt(b && b.handle, 30).toLowerCase().replace(/^@/, '');
    const row = await env.DB.prepare('SELECT id, email, lock_until FROM users WHERE handle = ?').bind(h).first();
    if (row && row.email && mailReady(env) && !(await lockedOut(env, row))) {
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
      const salt = crypto.getRandomValues(new Uint8Array(16));
      await env.DB.prepare('UPDATE users SET mail_hash = ?, mail_salt = ?, mail_exp = ? WHERE id = ?').bind(await hashPw(code, salt), b64(salt), Date.now() + 15 * 60000, row.id).run();
      await sendMail(env, row.email, 'Tu código para recuperar la cuenta', 'Tu código es ' + code + '. Caduca en 15 minutos. Si no lo has pedido tú, ignora este correo.');
    }
    return json({ ok: true });
  }
  if (url.pathname === '/api/reset' && request.method === 'POST') {
    const b = await readBody(request);
    const h = txt(b && b.handle, 30).toLowerCase().replace(/^@/, '');
    const pw = b && typeof b.password === 'string' ? b.password : '';
    if (pw.length < 8 || pw.length > 72) return bad('La contraseña debe tener entre 8 y 72 caracteres');
    const row = await env.DB.prepare('SELECT id, rec_hash, rec_salt, mail_hash, mail_salt, mail_exp, lock_until FROM users WHERE handle = ?').bind(h).first();
    if (await lockedOut(env, row)) return bad('Demasiados intentos. Prueba de nuevo en 15 minutos.', 429);
    const code = normCode(b && b.code);
    let how = '';
    if (row && code) {
      if (row.rec_hash && row.rec_salt && (await hashPw(code, unb64(row.rec_salt))) === row.rec_hash) how = 'rec';
      else if (row.mail_hash && row.mail_exp > Date.now() && (await hashPw(code, unb64(row.mail_salt))) === row.mail_hash) how = 'mail';
    }
    if (!how) { if (row) await noteFail(env, row.id); return bad('El código no es correcto', 403); }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    await env.DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ?, mail_hash = NULL, mail_exp = NULL, fails = 0, lock_until = 0 WHERE id = ?').bind(await hashPw(pw, salt), b64(salt), row.id).run();
    const out = { uid: row.id };
    if (how === 'rec') out.code = await setRecovery(env, row.id);
    return json(out);
  }
  const uid = request.headers.get('x-uid') || '';
  if (!/^[0-9a-f-]{36}$/i.test(uid)) return bad('identificador no válido');
  await ensureUser(env, uid);
  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method;

  if (path === '/state' && method === 'GET') {
    const titles = await env.DB.prepare(
      "SELECT id, title, type, year, episodes, minutes, synopsis, genre, hue, platforms, tags, poster, director, writers, release_date, age, collections, saga, source, review_status,\n        (SELECT ROUND(AVG(json_extract(l.ratings, '$.score'))) FROM library l WHERE l.title_id = titles.id AND json_extract(l.ratings, '$.score') > 0) AS avg,\n        (SELECT COUNT(*) FROM library l WHERE l.title_id = titles.id AND json_extract(l.ratings, '$.score') > 0) AS votes,\n        (SELECT COUNT(*) FROM library l WHERE l.title_id = titles.id) AS fans,\n        (SELECT COUNT(*) FROM library l WHERE l.title_id = titles.id AND l.updated_at >= datetime('now', '-30 days')) AS fans30\n       FROM titles WHERE (owner_id = ? OR review_status = 'approved')"
    ).bind(uid).all();
    const library = await env.DB.prepare('SELECT title_id, status, episode, ratings, review FROM library WHERE user_id = ?').bind(uid).all();
    const posts = await env.DB.prepare(
      `SELECT p.id, p.body, p.title_id, p.created_at, p.spoiler, p.list_id, (SELECT name FROM lists li WHERE li.id = p.list_id AND li.is_public = 1) AS list_name, (SELECT COUNT(*) FROM list_items x WHERE x.list_id = p.list_id) AS list_n, u.handle, u.display,
        (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id) AS comments,
        (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS likes,
        (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
       FROM posts p JOIN users u ON u.id = p.user_id WHERE 1=1 AND p.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?) AND p.user_id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?) ORDER BY p.id DESC LIMIT 50`
    ).bind(uid, uid, uid).all();
    const weekly = await env.DB.prepare(
      `SELECT title_id, ROUND(AVG(score)) AS avg, COUNT(*) AS votes FROM (
         SELECT title_id, json_extract(ratings, '$.score') AS score FROM library
         WHERE updated_at >= datetime('now', '-7 days') AND json_extract(ratings, '$.score') > 0)
       GROUP BY title_id ORDER BY avg DESC, votes DESC LIMIT 10`
    ).all();
    const critics = await env.DB.prepare(
      `SELECT u.handle, u.display, COUNT(*) AS reviews,
         (SELECT COUNT(*) FROM follows f WHERE f.followed_id = u.id AND f.status = 'accepted') AS followers
       FROM library l JOIN users u ON u.id = l.user_id
       WHERE l.review IS NOT NULL AND l.review <> '' AND u.is_private = 0 AND l.updated_at >= datetime('now', '-30 days')
       AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?) AND u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?) GROUP BY u.id ORDER BY reviews DESC LIMIT 20`
    ).bind(uid, uid).all();
    const plans = await env.DB.prepare(
      `SELECT p.id, p.kind, p.title_id, p.title, p.date, p.time, p.note, u.handle, u.display,
         (SELECT COUNT(*) FROM plan_members m WHERE m.plan_id = p.id) AS members,
         (SELECT COUNT(*) FROM plan_members m WHERE m.plan_id = p.id AND m.user_id = ?) AS joined
       FROM plans p JOIN users u ON u.id = p.user_id WHERE p.date >= date('now', '-1 day') AND p.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?) AND p.user_id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?) ORDER BY p.date, p.time LIMIT 60`
    ).bind(uid, uid, uid).all();
    const news = await env.DB.prepare('SELECT id, kind, title, body, title_id, event_date, platform, image, published_at FROM news ORDER BY published_at DESC, id DESC LIMIT 40').all();
    const me = await meInfo(env, uid);
    return json({ me, titles: titles.results, library: library.results, posts: posts.results, weekly: weekly.results, news: news.results, critics: critics.results, plans: plans.results });
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

  if (path === '/recovery' && method === 'POST') {
    const b = await readBody(request);
    const row = await env.DB.prepare('SELECT pass_hash, pass_salt FROM users WHERE id = ?').bind(uid).first();
    if (!row || !row.pass_hash) return bad('Primero crea una contraseña', 400);
    if (!(await checkPw(row, b && b.current))) return bad('La contraseña no es correcta', 403);
    return json({ code: await setRecovery(env, uid) });
  }
  if (path === '/email' && method === 'PUT') {
    const b = await readBody(request);
    const e = txt(b && b.email, 120).toLowerCase();
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return bad('Correo no válido');
    await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind(e || null, uid).run();
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
        `SELECT p.id, p.body, p.title_id, p.created_at, p.spoiler, p.list_id, (SELECT name FROM lists li WHERE li.id = p.list_id AND li.is_public = 1) AS list_name, (SELECT COUNT(*) FROM list_items x WHERE x.list_id = p.list_id) AS list_n,
          (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id) AS comments,
          (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS likes,
          (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
         FROM posts p WHERE p.user_id = ? ORDER BY p.id DESC LIMIT 30`
      ).bind(uid, u.id).all();
      out.library = lib.results; out.posts = posts.results;
      const pl = await env.DB.prepare(`SELECT l.id, l.name, l.descr, l.is_public, (SELECT COUNT(*) FROM list_items x WHERE x.list_id = l.id) AS n,
          (SELECT group_concat(title_id) FROM (SELECT title_id FROM list_items x WHERE x.list_id = l.id ORDER BY pos LIMIT 3)) AS covers
        FROM lists l WHERE l.user_id = ? ${isMe ? '' : 'AND l.is_public = 1'} ORDER BY l.id DESC LIMIT 50`).bind(u.id).all();
      out.lists = pl.results;
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
    let listId = null;
    if (b.list_id) {
      const l = await env.DB.prepare('SELECT id FROM lists WHERE id = ? AND user_id = ? AND is_public = 1').bind(Number(b.list_id), uid).first();
      if (!l) return bad('Esa lista no existe o es privada', 400);
      listId = l.id;
    }
    try {
      const res = await env.DB.prepare('INSERT INTO posts (user_id, body, title_id, spoiler, list_id) VALUES (?, ?, ?, ?, ?)').bind(uid, body, titleId, b.spoiler ? 1 : 0, listId).run();
      return json({ id: res.meta.last_row_id });
    } catch { return bad('título no encontrado', 404); }
  }

  if (path === '/plans' && method === 'POST') {
    const b = await readBody(request);
    if (!b) return bad('cuerpo no válido');
    const kind = b.kind === 'quedada' ? 'quedada' : 'maraton';
    const date = typeof b.date === 'string' && /^\d{4}-\d\d-\d\d$/.test(b.date) ? b.date : '';
    const time = typeof b.time === 'string' && /^\d\d:\d\d$/.test(b.time) ? b.time : '';
    let tid = Number(b.title_id) || 0;
    const name = txt(b.title, 80);
    if (tid) { const t = await env.DB.prepare('SELECT title FROM titles WHERE id = ?').bind(tid).first(); if (!t) tid = 0; }
    if (!date || (!tid && !name)) return bad('faltan título o fecha');
    const res = await env.DB.prepare('INSERT INTO plans (user_id, kind, title_id, title, date, time, note) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(uid, kind, tid, name, date, time, txt(b.note, 140)).run();
    await env.DB.prepare('INSERT OR IGNORE INTO plan_members (plan_id, user_id) VALUES (?, ?)').bind(res.meta.last_row_id, uid).run();
    return json({ id: res.meta.last_row_id });
  }
  m = path.match(/^\/plans\/(\d+)\/chat$/);
  if (m) {
    const id = Number(m[1]);
    const mem = await env.DB.prepare('SELECT 1 AS x FROM plan_members WHERE plan_id = ? AND user_id = ?').bind(id, uid).first();
    if (!mem) return bad('apúntate para entrar al chat', 403);
    if (method === 'GET') {
      const after = Number(url.searchParams.get('after')) || 0;
      const r = await env.DB.prepare(
        `SELECT * FROM (SELECT g.id, g.body, g.created_at, u.handle, u.display FROM plan_msgs g JOIN users u ON u.id = g.user_id
           WHERE g.plan_id = ? AND g.id > ? AND g.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?) AND g.user_id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)
           ORDER BY g.id DESC LIMIT 100) ORDER BY id ASC`
      ).bind(id, after, uid, uid).all();
      return json({ messages: r.results });
    }
    if (method === 'POST') {
      const b = await readBody(request);
      const body = b && txt(b.body, 300);
      if (!body) return bad('mensaje vacío');
      const res = await env.DB.prepare('INSERT INTO plan_msgs (plan_id, user_id, body) VALUES (?, ?, ?)').bind(id, uid, body).run();
      return json({ id: res.meta.last_row_id });
    }
  }
  m = path.match(/^\/plans\/(\d+)\/join$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    const ok = await env.DB.prepare('SELECT 1 AS x FROM plans WHERE id = ?').bind(id).first();
    if (!ok) return bad('plan no encontrado', 404);
    const had = await env.DB.prepare('SELECT 1 AS x FROM plan_members WHERE plan_id = ? AND user_id = ?').bind(id, uid).first();
    if (had) await env.DB.prepare('DELETE FROM plan_members WHERE plan_id = ? AND user_id = ?').bind(id, uid).run();
    else await env.DB.prepare('INSERT INTO plan_members (plan_id, user_id) VALUES (?, ?)').bind(id, uid).run();
    return json({ joined: !had });
  }
  m = path.match(/^\/plans\/(\d+)$/);
  if (m && method === 'DELETE') {
    const id = Number(m[1]);
    const r = await env.DB.prepare('DELETE FROM plans WHERE id = ? AND user_id = ?').bind(id, uid).run();
    if (r.meta.changes) await env.DB.prepare('DELETE FROM plan_members WHERE plan_id = ?').bind(id).run();
    return json({ ok: true });
  }

  if (path === '/lists' && method === 'GET') {
    const r = await env.DB.prepare(`SELECT l.id, l.name, l.descr, l.is_public, (SELECT COUNT(*) FROM list_items x WHERE x.list_id = l.id) AS n,
        (SELECT group_concat(title_id) FROM (SELECT title_id FROM list_items x WHERE x.list_id = l.id ORDER BY pos)) AS ids
      FROM lists l WHERE l.user_id = ? ORDER BY l.id DESC LIMIT 50`).bind(uid).all();
    return json({ lists: r.results });
  }
  if (path === '/lists' && method === 'POST') {
    const b = await readBody(request);
    const name = b && txt(b.name, 60);
    if (!name) return bad('Ponle un nombre a la lista');
    const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM lists WHERE user_id = ?').bind(uid).first();
    if (cnt.c >= 50) return bad('Has llegado al máximo de listas', 400);
    const res = await env.DB.prepare('INSERT INTO lists (user_id, name, descr, is_public) VALUES (?, ?, ?, ?)').bind(uid, name, txt(b.descr, 200), b.is_public === false ? 0 : 1).run();
    return json({ id: res.meta.last_row_id });
  }
  m = path.match(/^\/lists\/(\d+)(?:\/items(?:\/(\d+))?)?$/);
  if (m) {
    const id = Number(m[1]);
    const L = await env.DB.prepare('SELECT l.id, l.user_id, l.name, l.descr, l.is_public, u.handle, u.display, u.is_private FROM lists l JOIN users u ON u.id = l.user_id WHERE l.id = ?').bind(id).first();
    if (!L) return bad('Lista no encontrada', 404);
    const mine = L.user_id === uid;
    const isItems = path.includes('/items');
    if (method === 'GET' && !isItems) {
      let ok = mine;
      if (!ok && L.is_public) {
        const blocked = await env.DB.prepare('SELECT 1 AS x FROM blocks WHERE (blocker_id = ?1 AND blocked_id = ?2) OR (blocker_id = ?2 AND blocked_id = ?1)').bind(uid, L.user_id).first();
        let seen = !L.is_private;
        if (!seen) { const f = await env.DB.prepare("SELECT 1 AS x FROM follows WHERE follower_id = ? AND followed_id = ? AND status = 'accepted'").bind(uid, L.user_id).first(); seen = !!f; }
        ok = !blocked && seen;
      }
      if (!ok) return bad('Lista no encontrada', 404);
      const it = await env.DB.prepare('SELECT title_id FROM list_items WHERE list_id = ? ORDER BY pos, added_at').bind(id).all();
      return json({ list: { id, name: L.name, descr: L.descr || '', is_public: !!L.is_public, mine, handle: L.handle, display: L.display || '' }, items: it.results.map((x) => x.title_id) });
    }
    if (!mine) return bad('No es tu lista', 403);
    if (!isItems && method === 'PUT') {
      const b = await readBody(request) || {};
      if (typeof b.name === 'string' && txt(b.name, 60)) await env.DB.prepare('UPDATE lists SET name = ? WHERE id = ?').bind(txt(b.name, 60), id).run();
      if (typeof b.descr === 'string') await env.DB.prepare('UPDATE lists SET descr = ? WHERE id = ?').bind(txt(b.descr, 200), id).run();
      if (typeof b.is_public === 'boolean') {
        await env.DB.prepare('UPDATE lists SET is_public = ? WHERE id = ?').bind(b.is_public ? 1 : 0, id).run();
        if (!b.is_public) await env.DB.prepare('UPDATE posts SET list_id = NULL WHERE list_id = ?').bind(id).run();
      }
      return json({ ok: true });
    }
    if (!isItems && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM list_items WHERE list_id = ?').bind(id).run();
      await env.DB.prepare('UPDATE posts SET list_id = NULL WHERE list_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM lists WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
    if (isItems && method === 'POST') {
      const b = await readBody(request);
      const tid = Number(b && b.title_id);
      if (!tid) return bad('título no válido');
      const t = await env.DB.prepare('SELECT 1 AS x FROM titles WHERE id = ?').bind(tid).first();
      if (!t) return bad('título no encontrado', 404);
      const c = await env.DB.prepare('SELECT COUNT(*) AS c, COALESCE(MAX(pos), 0) AS mx FROM list_items WHERE list_id = ?').bind(id).first();
      if (c.c >= 100) return bad('La lista está llena (100 títulos)', 400);
      await env.DB.prepare('INSERT OR IGNORE INTO list_items (list_id, title_id, pos) VALUES (?, ?, ?)').bind(id, tid, c.mx + 1).run();
      return json({ ok: true });
    }
    if (isItems && method === 'DELETE' && m[2]) {
      await env.DB.prepare('DELETE FROM list_items WHERE list_id = ? AND title_id = ?').bind(id, Number(m[2])).run();
      return json({ ok: true });
    }
  }
  if (path === '/reports' && method === 'POST') {
    const b = await readBody(request);
    const kind = b && ['post', 'comment', 'user'].includes(b.kind) ? b.kind : '';
    const target = b && txt(String(b.target ?? ''), 40);
    if (!kind || !target) return bad('denuncia no válida');
    await env.DB.prepare('INSERT INTO reports (reporter_id, kind, target, reason) VALUES (?, ?, ?, ?)').bind(uid, kind, target, txt(b.reason, 60)).run();
    return json({ ok: true });
  }
  if (path === '/blocks' && method === 'GET') {
    const r = await env.DB.prepare('SELECT u.handle, u.display FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC').bind(uid).all();
    return json({ blocks: r.results });
  }
  m = path.match(/^\/block\/([a-z0-9_.]{3,20})$/);
  if (m && (method === 'POST' || method === 'DELETE')) {
    const t = await env.DB.prepare('SELECT id FROM users WHERE handle = ?').bind(m[1]).first();
    if (!t || t.id === uid) return bad('usuario no encontrado', 404);
    if (method === 'POST') {
      await env.DB.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').bind(uid, t.id).run();
      await env.DB.prepare('DELETE FROM follows WHERE (follower_id = ?1 AND followed_id = ?2) OR (follower_id = ?2 AND followed_id = ?1)').bind(uid, t.id).run();
    } else {
      await env.DB.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind(uid, t.id).run();
    }
    return json({ ok: true });
  }
  m = path.match(/^\/posts\/(\d+)$/);
  if (m && method === 'DELETE') {
    const id = Number(m[1]);
    const r = await env.DB.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').bind(id, uid).run();
    if (r.meta.changes) {
      await env.DB.prepare('DELETE FROM post_comments WHERE post_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM post_likes WHERE post_id = ?').bind(id).run();
    }
    return json({ ok: true });
  }
  m = path.match(/^\/comments\/(\d+)$/);
  if (m && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM post_comments WHERE id = ? AND user_id = ?').bind(Number(m[1]), uid).run();
    return json({ ok: true });
  }

  m = path.match(/^\/posts\/(\d+)\/comments$/);
  if (m && method === 'GET') {
    const r = await env.DB.prepare(
      `SELECT c.id, c.body, c.created_at, u.handle, u.display FROM post_comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? AND c.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?) AND c.user_id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?) ORDER BY c.id ASC LIMIT 200`
    ).bind(Number(m[1]), uid, uid).all();
    return json({ comments: r.results });
  }
  if (m && method === 'POST') {
    const b = await readBody(request);
    const body = b && txt(b.body, 300);
    if (!body) return bad('comentario vacío');
    const ok = await env.DB.prepare('SELECT 1 AS x FROM posts WHERE id = ?').bind(Number(m[1])).first();
    if (!ok) return bad('publicación no encontrada', 404);
    const res = await env.DB.prepare('INSERT INTO post_comments (post_id, user_id, body) VALUES (?, ?, ?)').bind(Number(m[1]), uid, body).run();
    return json({ id: res.meta.last_row_id });
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
