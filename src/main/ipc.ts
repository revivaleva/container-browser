import { ipcMain } from 'electron';
import keytar from 'keytar';
import { DB } from './db';

const SERVICE = 'ContainerBrowserVault';

ipcMain.handle('vault.saveCredential', async (_e, { containerId, origin, username, password }) => {
  const account = `${containerId}|${origin}|${username}`;
  await keytar.setPassword(SERVICE, account, password);
  DB.upsertCredential({ containerId, origin, username, keytarAccount: account, updatedAt: Date.now() });
  return true;
});

ipcMain.handle('vault.getCredential', async (_e, { containerId, origin }) => {
  const row = DB.getCredential(containerId, origin);
  if (!row) return null;
  const password = await keytar.getPassword(SERVICE, row.keytarAccount);
  if (!password) return null;
  return { username: row.username, password };
});

ipcMain.handle('prefs.set', async (_e, pref) => { DB.upsertSitePref(pref); return true; });
ipcMain.handle('prefs.get', async (_e, { containerId, origin }) => DB.getSitePref(containerId, origin) ?? null);

ipcMain.handle('bookmarks.list', async () => {
  return DB.listBookmarks();
});
ipcMain.handle('bookmarks.add', async (_e, payload) => {
  DB.addBookmark({ ...payload, createdAt: Date.now() });
  return true;
});
ipcMain.handle('bookmarks.delete', async (_e, { id }) => {
  DB.deleteBookmark(id);
  return true;
});
ipcMain.handle('bookmarks.reorder', async (_e, { ids }) => {
  DB.setBookmarksOrder(ids);
  return true;
});

// 移行機能: 認証情報のエクスポート
ipcMain.handle('migration.exportCredentials', async () => {
  try {
    const credentials: Array<{ containerId: string; origin: string; username: string; password: string }> = [];
    // データベースから全認証情報の参照を取得
    const rows = DB.listAllCredentials();
    for (const row of rows) {
      try {
        const password = await keytar.getPassword(SERVICE, row.keytarAccount);
        if (password) {
          credentials.push({
            containerId: row.containerId,
            origin: row.origin,
            username: row.username,
            password
          });
        }
      } catch (e) {
        // 個別の取得エラーは無視して続行
        console.warn(`[migration] Failed to get password for ${row.keytarAccount}:`, e);
      }
    }
    return { ok: true, credentials };
  } catch (e: any) {
    console.error('[migration] exportCredentials error:', e);
    return { ok: false, error: e?.message || String(e) };
  }
});

// 移行機能: 認証情報のインポート
ipcMain.handle('migration.importCredentials', async (_e, { credentials }: { credentials: Array<{ containerId: string; origin: string; username: string; password: string }> }) => {
  try {
    let successCount = 0;
    let errorCount = 0;
    for (const cred of credentials) {
      try {
        const account = `${cred.containerId}|${cred.origin}|${cred.username}`;
        await keytar.setPassword(SERVICE, account, cred.password);
        DB.upsertCredential({
          containerId: cred.containerId,
          origin: cred.origin,
          username: cred.username,
          keytarAccount: account,
          updatedAt: Date.now()
        });
        successCount++;
      } catch (e) {
        console.warn(`[migration] Failed to import credential for ${cred.containerId}|${cred.origin}:`, e);
        errorCount++;
      }
    }
    return { ok: true, successCount, errorCount };
  } catch (e: any) {
    console.error('[migration] importCredentials error:', e);
    return { ok: false, error: e?.message || String(e) };
  }
});
