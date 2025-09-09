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
