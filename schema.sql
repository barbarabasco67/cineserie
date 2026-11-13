-- Esquema inicial de la app. Pégalo entero en Cloudflare > D1 > tu base de datos > Console.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS titles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  poster TEXT,
  director TEXT,
  writers TEXT,
  release_date TEXT,
  age TEXT,
  type TEXT NOT NULL CHECK (type IN ('Serie','Película')),
  year INTEGER,
  episodes INTEGER NOT NULL DEFAULT 1,
  minutes INTEGER NOT NULL DEFAULT 0,
  synopsis TEXT NOT NULL,
  genre TEXT,
  hue INTEGER NOT NULL DEFAULT 30,
  platforms TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'base' CHECK (source IN ('base','user')),
  review_status TEXT NOT NULL DEFAULT 'approved' CHECK (review_status IN ('approved','pending','private')),
  owner_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_titles_type ON titles(type, review_status);
CREATE INDEX IF NOT EXISTS idx_titles_owner ON titles(owner_id);

CREATE TABLE IF NOT EXISTS library (
  user_id TEXT NOT NULL REFERENCES users(id),
  title_id INTEGER NOT NULL REFERENCES titles(id),
  status TEXT NOT NULL CHECK (status IN ('Quiero ver','Viendo','Vista','En pausa','Abandonada')),
  episode INTEGER NOT NULL DEFAULT 0,
  ratings TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, title_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  title_id INTEGER REFERENCES titles(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS premieres (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_id INTEGER REFERENCES titles(id),
  label TEXT NOT NULL,
  platform TEXT,
  date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_premieres_date ON premieres(date);

CREATE TABLE IF NOT EXISTS reminders (
  user_id TEXT NOT NULL REFERENCES users(id),
  premiere_id INTEGER NOT NULL REFERENCES premieres(id),
  PRIMARY KEY (user_id, premiere_id)
);
