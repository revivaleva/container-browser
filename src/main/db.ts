import Database from 'better-sqlite3';
import path from 'node:path';
import { app } from 'electron';
import type { Container, CredentialRow, SitePref, TabEntry } from '@shared/types';

let db: Database.Database;

export function initDB() {
  const dbPath = path.join(app.getPath('userData'), 'data.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
  CREATE TABLE IF NOT EXISTS containers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    userDataDir TEXT NOT NULL,
    partition TEXT NOT NULL,
    userAgent TEXT,
    locale TEXT,
    timezone TEXT,
    fingerprint TEXT,
    proxy TEXT,
    createdAt INTEGER,
    updatedAt INTEGER,
    lastSessionId TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    containerId TEXT NOT NULL,
    startedAt INTEGER,
    closedAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS tabs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    containerId TEXT NOT NULL,
    sessionId TEXT NOT NULL,
    url TEXT NOT NULL,
    tabIndex INTEGER,
    title TEXT,
    favicon TEXT,
    scrollY INTEGER,
    updatedAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS credentials (
    containerId TEXT NOT NULL,
    origin TEXT NOT NULL,
    username TEXT NOT NULL,
    keytarAccount TEXT NOT NULL,
    updatedAt INTEGER,
    PRIMARY KEY (containerId, origin)
  );

  CREATE TABLE IF NOT EXISTS site_prefs (
    containerId TEXT NOT NULL,
    origin TEXT NOT NULL,
    autoFill INTEGER NOT NULL DEFAULT 0,
    autoSaveForms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (containerId, origin)
  );
  
  CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY,
    containerId TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    createdAt INTEGER,
    sortOrder INTEGER DEFAULT 0
  );
  `);

  // migrate: add fingerprint column if missing
  try {
    const cols = db.prepare('PRAGMA table_info(containers)').all() as any[];
    const hasFingerprint = cols.some(c => c.name === 'fingerprint');
    if (!hasFingerprint) {
      db.prepare('ALTER TABLE containers ADD COLUMN fingerprint TEXT').run();
    }
    // migrate: ensure bookmarks have sortOrder column
    try {
      const bcols = db.prepare("PRAGMA table_info(bookmarks)").all() as any[];
      const hasSort = bcols.some(c => c.name === 'sortOrder');
      if (!hasSort) {
        db.prepare('ALTER TABLE bookmarks ADD COLUMN sortOrder INTEGER DEFAULT 0').run();
        // populate sortOrder with createdAt ordering
        const rows = db.prepare('SELECT id FROM bookmarks ORDER BY createdAt ASC').all();
        const tx = db.transaction((r:any[]) => { for (let i=0;i<r.length;i++) { db.prepare('UPDATE bookmarks SET sortOrder=? WHERE id=?').run(i, r[i].id); } });
        tx(rows);
      }
    } catch {}
    // migrate: ensure tabs have tabIndex column
    try {
      const tcols = db.prepare("PRAGMA table_info(tabs)").all() as any[];
      const hasTabIndex = tcols.some(c => c.name === 'tabIndex');
      if (!hasTabIndex) {
        try { db.prepare('ALTER TABLE tabs ADD COLUMN tabIndex INTEGER').run(); } catch (e) { /* ignore */ }
      }
    } catch {}
  } catch {}
}

export const DB = {
  upsertContainer(c: Container) {
    const stmt = db.prepare(`
      INSERT INTO containers (id,name,userDataDir,partition,userAgent,locale,timezone,fingerprint,proxy,createdAt,updatedAt,lastSessionId)
      VALUES (@id,@name,@userDataDir,@partition,@userAgent,@locale,@timezone,@fingerprint,@proxy,@createdAt,@updatedAt,@lastSessionId)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        userDataDir=excluded.userDataDir,
        partition=excluded.partition,
        userAgent=excluded.userAgent,
        locale=excluded.locale,
        timezone=excluded.timezone,
        fingerprint=excluded.fingerprint,
        proxy=excluded.proxy,
        updatedAt=excluded.updatedAt,
        lastSessionId=excluded.lastSessionId
    `);
    stmt.run({
      ...c,
      fingerprint: c.fingerprint ? JSON.stringify(c.fingerprint) : null,
      proxy: c.proxy ? JSON.stringify(c.proxy) : null,
    });
  },
  listContainers(): Container[] {
    const rows = db.prepare('SELECT * FROM containers ORDER BY createdAt DESC').all();
    return rows.map((r:any)=> ({
      ...r,
      proxy: r.proxy ? JSON.parse(r.proxy) : null,
      fingerprint: r.fingerprint ? JSON.parse(r.fingerprint) : undefined,
    }));
  },
  getContainer(id: string): Container | undefined {
    const r = db.prepare('SELECT * FROM containers WHERE id=?').get(id);
    if (!r) return undefined;
    return {
      ...r,
      proxy: r.proxy ? JSON.parse(r.proxy) : null,
      fingerprint: r.fingerprint ? JSON.parse(r.fingerprint) : undefined,
    } as Container;
  },
  getContainerByName(name: string): Container | undefined {
    const r = db.prepare('SELECT * FROM containers WHERE name=? ORDER BY createdAt DESC').get(name);
    if (!r) return undefined;
    return {
      ...r,
      proxy: r.proxy ? JSON.parse(r.proxy) : null,
      fingerprint: r.fingerprint ? JSON.parse(r.fingerprint) : undefined,
    } as Container;
  },
  asyncDeleteContainer(id: string) {
    const tx = db.transaction((containerId: string) => {
      db.prepare('DELETE FROM tabs WHERE containerId=?').run(containerId);
      db.prepare('DELETE FROM sessions WHERE containerId=?').run(containerId);
      db.prepare('DELETE FROM credentials WHERE containerId=?').run(containerId);
      db.prepare('DELETE FROM site_prefs WHERE containerId=?').run(containerId);
      db.prepare('DELETE FROM containers WHERE id=?').run(containerId);
    });
    tx(id);
  },
  recordSession(id: string, containerId: string, startedAt: number) {
    db.prepare('INSERT OR REPLACE INTO sessions(id,containerId,startedAt) VALUES (?,?,?)').run(id, containerId, startedAt);
    db.prepare('UPDATE containers SET lastSessionId=? WHERE id=?').run(id, containerId);
  },
  closeSession(id: string, closedAt: number) {
    db.prepare('UPDATE sessions SET closedAt=? WHERE id=?').run(closedAt, id);
  },
  addOrUpdateTab(t: TabEntry) {
    const stmt = db.prepare(`INSERT INTO tabs(containerId,sessionId,url,tabIndex,title,favicon,scrollY,updatedAt)
      VALUES (@containerId,@sessionId,@url,@tabIndex,@title,@favicon,@scrollY,@updatedAt)`);
    // better-sqlite3 の named parameter は省略不可のため既定値を補完
    stmt.run({
      containerId: t.containerId,
      sessionId: t.sessionId,
      url: t.url,
      tabIndex: (t as any).tabIndex ?? null,
      title: t.title ?? null,
      favicon: t.favicon ?? null,
      scrollY: t.scrollY ?? 0,
      updatedAt: t.updatedAt,
    });
  },
  tabsOfSession(sessionId: string): TabEntry[] {
    return db.prepare('SELECT * FROM tabs WHERE sessionId=? ORDER BY id ASC').all(sessionId);
  },
  upsertCredential(row: CredentialRow) {
    db.prepare(`INSERT INTO credentials(containerId,origin,username,keytarAccount,updatedAt)
               VALUES(@containerId,@origin,@username,@keytarAccount,@updatedAt)
               ON CONFLICT(containerId,origin) DO UPDATE SET username=excluded.username, keytarAccount=excluded.keytarAccount, updatedAt=excluded.updatedAt
    `).run(row);
  },
  getCredential(containerId: string, origin: string): CredentialRow | undefined {
    return db.prepare('SELECT * FROM credentials WHERE containerId=? AND origin=?').get(containerId, origin);
  },
  upsertSitePref(pref: SitePref) {
    db.prepare(`INSERT INTO site_prefs(containerId,origin,autoFill,autoSaveForms)
                VALUES(@containerId,@origin,@autoFill,@autoSaveForms)
                ON CONFLICT(containerId,origin) DO UPDATE SET autoFill=excluded.autoFill, autoSaveForms=excluded.autoSaveForms`).run(pref);
  },
  getSitePref(containerId: string, origin: string): SitePref | undefined {
    return db.prepare('SELECT * FROM site_prefs WHERE containerId=? AND origin=?').get(containerId, origin);
  }
  ,
  listBookmarks() {
    return db.prepare('SELECT * FROM bookmarks ORDER BY sortOrder ASC, createdAt DESC').all();
  },
  addBookmark(b: { id: string; containerId: string; title: string; url: string; createdAt: number }) {
    // determine next sortOrder (append to end)
    const max = db.prepare('SELECT COALESCE(MAX(sortOrder),0) as m FROM bookmarks').get().m || 0;
    const next = max + 1;
    // allow containerId to be empty string for global bookmarks
    const cid = b.containerId || '';
    db.prepare('INSERT INTO bookmarks(id,containerId,title,url,createdAt,sortOrder) VALUES(?,?,?,?,?,?)').run(b.id, cid, b.title, b.url, b.createdAt, next);
  },
  deleteBookmark(id: string) {
    db.prepare('DELETE FROM bookmarks WHERE id=?').run(id);
  }
  ,
  setBookmarksOrder(ids: string[]) {
    const tx = db.transaction((arr: string[]) => {
      for (let i = 0; i < arr.length; i++) {
        db.prepare('UPDATE bookmarks SET sortOrder=? WHERE id=?').run(i, arr[i]);
      }
    });
    tx(ids);
  }
};
