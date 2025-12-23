import { ipcMain, dialog } from 'electron';
import keytar from 'keytar';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { DB } from './db';
import { zipAllProfiles, extractProfiles } from './profileExporter';
import archiver from 'archiver';

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

// 移行機能: 全データのエクスポート（DBデータのみ）
ipcMain.handle('migration.exportAll', async () => {
  try {
    // コンテナ
    const containers = DB.listContainers();
    
    // セッション
    const sessions = DB.listAllSessions();
    
    // タブ
    const tabs = DB.listAllTabs();
    
    // ブックマーク
    const bookmarks = DB.listBookmarks();
    
    // サイト設定
    const sitePrefs = DB.listAllSitePrefs();
    
    // 認証情報（パスワード含む）
    const credentials: Array<{ containerId: string; origin: string; username: string; password: string }> = [];
    const credentialRows = DB.listAllCredentials();
    for (const row of credentialRows) {
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
        console.warn(`[migration] Failed to get password for ${row.keytarAccount}:`, e);
      }
    }
    
    const exportData = {
      version: '1.0',
      exportedAt: Date.now(),
      data: {
        containers,
        sessions,
        tabs,
        bookmarks,
        sitePrefs,
        credentials
      },
      summary: {
        containers: containers.length,
        sessions: sessions.length,
        tabs: tabs.length,
        bookmarks: bookmarks.length,
        sitePrefs: sitePrefs.length,
        credentials: credentials.length
      }
    };
    
    return { ok: true, data: exportData };
  } catch (e: any) {
    console.error('[migration] exportAll error:', e);
    return { ok: false, error: e?.message || String(e) };
  }
});

// 移行機能: 全データとプロファイルをまとめてエクスポート（1つのZIPファイルに）
ipcMain.handle('migration.exportComplete', async (_e, { includeProfiles = true }) => {
  try {
    const { BrowserWindow } = require('electron');
    const archiver = require('archiver');

    // ファイル保存ダイアログを表示
    const mainWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!mainWindow) {
      return { ok: false, error: 'No window available for dialog' };
    }

    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'エクスポートファイルを保存',
      defaultPath: `container-browser-export-${dateStr}.zip`,
      filters: [
        { name: 'ZIP Files', extensions: ['zip'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { ok: false, error: 'Export cancelled' };
    }

    const outputZipPath = result.filePath;

    // DBデータをエクスポート（直接関数を呼び出し）
    const containers = DB.listContainers();
    const sessions = DB.listAllSessions();
    const tabs = DB.listAllTabs();
    const bookmarks = DB.listBookmarks();
    const sitePrefs = DB.listAllSitePrefs();
    
    const credentials: Array<{ containerId: string; origin: string; username: string; password: string }> = [];
    const credentialRows = DB.listAllCredentials();
    for (const row of credentialRows) {
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
        console.warn(`[migration] Failed to get password for ${row.keytarAccount}:`, e);
      }
    }

    const exportData = {
      version: '1.0',
      exportedAt: Date.now(),
      data: {
        containers,
        sessions,
        tabs,
        bookmarks,
        sitePrefs,
        credentials
      },
      summary: {
        containers: containers.length,
        sessions: sessions.length,
        tabs: tabs.length,
        bookmarks: bookmarks.length,
        sitePrefs: sitePrefs.length,
        credentials: credentials.length
      }
    };
    const userDataPath = app.getPath('userData');
    const tempDir = path.join(userDataPath, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // 一時ファイルにDBデータを保存
    const dbJsonPath = path.join(tempDir, 'data.json');
    fs.writeFileSync(dbJsonPath, JSON.stringify(exportData, null, 2), 'utf-8');

    // ZIPファイルを作成
    return new Promise((resolve) => {
      const output = fs.createWriteStream(outputZipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      let profilesInfo: { success: number; error: number; totalSize: number } | null = null;

      output.on('close', () => {
        // 一時ファイルを削除
        try {
          if (fs.existsSync(dbJsonPath)) fs.unlinkSync(dbJsonPath);
        } catch (e) {
          console.warn('[migration] Failed to cleanup temp file:', e);
        }

        resolve({
          ok: true,
          filePath: outputZipPath,
          fileSize: archive.pointer(),
          summary: {
            ...exportData.summary,
            profiles: profilesInfo ? `${profilesInfo.success} profiles, ${(profilesInfo.totalSize / 1024 / 1024).toFixed(2)} MB` : 'not included'
          }
        });
      });

      archive.on('error', (err: any) => {
        resolve({ ok: false, error: err?.message || String(err) });
      });

      archive.pipe(output);

      // DBデータをZIPに追加
      archive.file(dbJsonPath, { name: 'data.json' });

      // プロファイルとPartitionsをZIPに追加（キャッシュ等を除外）
      if (includeProfiles) {
        const containers = DB.listContainers();
        const profilesDir = path.join(userDataPath, 'profiles');
        const partitionsDir = path.join(userDataPath, 'Partitions');
        let profileCount = 0;
        let partitionCount = 0;
        let profileErrorCount = 0;
        let partitionErrorCount = 0;

        // エクスポートから除外するパターン（profileExporter.tsと同じ）
        const EXCLUDE_PATTERNS = [
          '**/Cache/**',
          '**/Code Cache/**',
          '**/GPUCache/**',
          '**/Service Worker/**',
          '**/ServiceWorker/**',
          '**/Media Cache/**',
          '**/ShaderCache/**',
          '**/VideoDecodeStats/**',
          '**/SingletonLock',
          '**/LOCK',
          '**/lockfile',
          '**/*.tmp',
          '**/*.temp',
          '**/*.log',
          '**/History*',
          '**/Top Sites*',
          '**/Favicons*',
          '**/Current Session',
          '**/Current Tabs',
          '**/Last Session',
          '**/Last Tabs',
          '**/Preferences.bak',
          '**/Secure Preferences.bak',
        ];

        const shouldExclude = (filePath: string, basePath: string): boolean => {
          const relativePath = path.relative(basePath, filePath).replace(/\\/g, '/');
          const fileName = path.basename(filePath);
          for (const pattern of EXCLUDE_PATTERNS) {
            const regex = new RegExp(
              pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\//g, '/')
            );
            if (regex.test(relativePath) || regex.test(fileName)) {
              return true;
            }
          }
          return false;
        };

        const addDirectoryFiltered = (
          archive: archiver.Archiver,
          sourcePath: string,
          archivePath: string,
          basePath: string
        ): void => {
          try {
            const entries = fs.readdirSync(sourcePath, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(sourcePath, entry.name);
              const archiveEntryPath = path.join(archivePath, entry.name);
              if (shouldExclude(fullPath, basePath)) {
                continue;
              }
              if (entry.isDirectory()) {
                addDirectoryFiltered(archive, fullPath, archiveEntryPath, basePath);
              } else {
                archive.file(fullPath, { name: archiveEntryPath });
              }
            }
          } catch (e) {
            console.warn(`[migration] Failed to process directory ${sourcePath}:`, e);
          }
        };

        // partition文字列から実体ディレクトリ名を抽出するヘルパー
        const extractPartitionDirName = (partition: string): string | null => {
          if (!partition || typeof partition !== 'string') return null;
          const m = partition.match(/^persist:(.+)$/);
          return m ? m[1] : null;
        };

        for (const container of containers) {
          // profiles/${container.id} を追加（フィルタリング適用）
          const profilePath = path.join(profilesDir, container.id);
          if (fs.existsSync(profilePath)) {
            try {
              addDirectoryFiltered(archive, profilePath, `profiles/${container.id}`, profilePath);
              profileCount++;
              console.log(`[migration] Added profile ${container.id} (with exclusions)`);
            } catch (e) {
              console.warn(`[migration] Failed to add profile ${container.id}:`, e);
              profileErrorCount++;
            }
          }

          // Partitions/container-${container.id} を追加（フィルタリング適用）
          const partitionDirName = extractPartitionDirName(container.partition);
          if (partitionDirName) {
            const partitionPath = path.join(partitionsDir, partitionDirName);
            if (fs.existsSync(partitionPath)) {
              try {
                addDirectoryFiltered(archive, partitionPath, `Partitions/${partitionDirName}`, partitionPath);
                partitionCount++;
                console.log(`[migration] Added partition ${partitionDirName} for container ${container.id} (with exclusions)`);
              } catch (e) {
                console.warn(`[migration] Failed to add partition ${partitionDirName}:`, e);
                partitionErrorCount++;
              }
            } else {
              console.warn(`[migration] Partition not found: ${partitionPath}`);
            }
          } else {
            console.warn(`[migration] Invalid partition format: ${container.partition}`);
          }
        }

        profilesInfo = { 
          success: profileCount + partitionCount, 
          error: profileErrorCount + partitionErrorCount, 
          totalSize: 0 
        };
      }

      archive.finalize();
    });
  } catch (e: any) {
    console.error('[migration] exportComplete error:', e);
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

// 移行機能: 全データのインポート（内部関数）
async function importAllData(data: any, updatePaths?: { oldBasePath: string; newBasePath: string }, containerIdMapping?: Record<string, string>) {
  try {
    const { app } = require('electron');
    const path = require('path');
    const results = {
      containers: { success: 0, error: 0 },
      sessions: { success: 0, error: 0 },
      tabs: { success: 0, error: 0 },
      bookmarks: { success: 0, error: 0 },
      sitePrefs: { success: 0, error: 0 },
      credentials: { success: 0, error: 0 }
    };

    // コンテナのインポート
    if (data.containers && Array.isArray(data.containers)) {
      for (const container of data.containers) {
        try {
          // コンテナIDのマッピング適用
          const originalId = container.id;
          const newId = containerIdMapping && containerIdMapping[originalId] ? containerIdMapping[originalId] : originalId;
          
          // コンテナ名で既存のコンテナを検索（マッピングが指定されていない場合のみ）
          if (!containerIdMapping && container.name) {
            const existingContainer = DB.getContainerByName(container.name);
            if (existingContainer && existingContainer.id !== newId) {
              // 同じ名前の既存コンテナを削除
              console.log(`[migration] Removing existing container with same name: ${existingContainer.id} (${existingContainer.name})`);
              try {
                DB.asyncDeleteContainer(existingContainer.id);
                // 関連するファイルも削除
                const userDataPath = app.getPath('userData');
                const profilesDir = path.join(userDataPath, 'profiles');
                const partitionsDir = path.join(userDataPath, 'Partitions');
                
                // プロファイルディレクトリを削除
                const profilePath = path.join(profilesDir, existingContainer.id);
                if (fs.existsSync(profilePath)) {
                  try {
                    fs.rmSync(profilePath, { recursive: true, force: true });
                    console.log(`[migration] Removed profile directory: ${profilePath}`);
                  } catch (e) {
                    console.warn(`[migration] Failed to remove profile directory ${profilePath}:`, e);
                  }
                }
                
                // Partitionsディレクトリを削除
                const partitionMatch = existingContainer.partition?.match(/^persist:(.+)$/);
                if (partitionMatch) {
                  const partitionDirName = partitionMatch[1];
                  const partitionPath = path.join(partitionsDir, partitionDirName);
                  if (fs.existsSync(partitionPath)) {
                    try {
                      fs.rmSync(partitionPath, { recursive: true, force: true });
                      console.log(`[migration] Removed partition directory: ${partitionPath}`);
                    } catch (e) {
                      console.warn(`[migration] Failed to remove partition directory ${partitionPath}:`, e);
                    }
                  }
                }
              } catch (e) {
                console.warn(`[migration] Failed to remove existing container ${existingContainer.id}:`, e);
              }
            }
          }
          
          // userDataDirを新しい環境に合わせて更新
          let userDataDir = container.userDataDir;
          if (updatePaths && userDataDir) {
            if (userDataDir.startsWith(updatePaths.oldBasePath)) {
              userDataDir = userDataDir.replace(updatePaths.oldBasePath, updatePaths.newBasePath);
            } else {
              // パスが一致しない場合、新しい環境のパスを生成
              userDataDir = path.join(app.getPath('userData'), 'profiles', newId);
            }
          } else if (!userDataDir || !userDataDir.includes('profiles')) {
            // userDataDirが無効な場合、新しい環境のパスを生成
            userDataDir = path.join(app.getPath('userData'), 'profiles', newId);
          }

          // partitionも新しいIDに更新
          const partitionMatch = container.partition?.match(/^persist:container-(.+)$/);
          const newPartition = partitionMatch ? `persist:container-${newId}` : container.partition;

          const updatedContainer = {
            ...container,
            id: newId,
            userDataDir,
            partition: newPartition,
            updatedAt: Date.now()
          };
          DB.upsertContainer(updatedContainer);
          if (newId !== originalId) {
            console.log(`[migration] Mapped container ID: ${originalId} -> ${newId}`);
          } else {
            console.log(`[migration] Imported container: ${container.name} (${newId})`);
          }
          results.containers.success++;
        } catch (e) {
          console.warn(`[migration] Failed to import container ${container.id}:`, e);
          results.containers.error++;
        }
      }
    }

    // セッションのインポート
    if (data.sessions && Array.isArray(data.sessions)) {
      for (const session of data.sessions) {
        try {
          const newContainerId = containerIdMapping && containerIdMapping[session.containerId] 
            ? containerIdMapping[session.containerId] 
            : session.containerId;
          DB.recordSession(session.id, newContainerId, session.startedAt);
          if (session.closedAt) {
            DB.closeSession(session.id, session.closedAt);
          }
          results.sessions.success++;
        } catch (e) {
          console.warn(`[migration] Failed to import session ${session.id}:`, e);
          results.sessions.error++;
        }
      }
    }

    // タブのインポート
    if (data.tabs && Array.isArray(data.tabs)) {
      for (const tab of data.tabs) {
        try {
          const newContainerId = containerIdMapping && containerIdMapping[tab.containerId] 
            ? containerIdMapping[tab.containerId] 
            : tab.containerId;
          DB.addOrUpdateTab({
            ...tab,
            containerId: newContainerId
          });
          results.tabs.success++;
        } catch (e) {
          console.warn(`[migration] Failed to import tab:`, e);
          results.tabs.error++;
        }
      }
    }

    // ブックマークのインポート
    if (data.bookmarks && Array.isArray(data.bookmarks)) {
      const existingBookmarks = DB.listBookmarks();
      const existingIds = new Set(existingBookmarks.map(b => b.id));
      
      for (const bookmark of data.bookmarks) {
        try {
          const newContainerId = containerIdMapping && bookmark.containerId && containerIdMapping[bookmark.containerId] 
            ? containerIdMapping[bookmark.containerId] 
            : (bookmark.containerId || '');
          // 既存のブックマークをチェック
          if (!existingIds.has(bookmark.id)) {
            // 新規追加
            DB.addBookmark({
              id: bookmark.id,
              containerId: newContainerId,
              title: bookmark.title,
              url: bookmark.url,
              createdAt: bookmark.createdAt || Date.now()
            });
            results.bookmarks.success++;
          } else {
            // 既存の場合は更新（タイトルとURLを更新）
            // addBookmarkは既存IDの場合は更新される
            DB.addBookmark({
              id: bookmark.id,
              containerId: newContainerId,
              title: bookmark.title,
              url: bookmark.url,
              createdAt: bookmark.createdAt || existingBookmarks.find(b => b.id === bookmark.id)?.createdAt || Date.now()
            });
            results.bookmarks.success++;
          }
        } catch (e) {
          console.warn(`[migration] Failed to import bookmark ${bookmark.id}:`, e);
          results.bookmarks.error++;
        }
      }
      
      // ブックマークの順序を復元
      if (data.bookmarks.length > 0) {
        try {
          // エクスポート時の順序を保持
          const sortedBookmarks = [...data.bookmarks].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
          const sortedIds = sortedBookmarks.map(b => b.id);
          
          // 既存のブックマークで、エクスポートデータに含まれていないものを末尾に追加
          const allBookmarks = DB.listBookmarks();
          for (const existing of allBookmarks) {
            if (!sortedIds.includes(existing.id)) {
              sortedIds.push(existing.id);
            }
          }
          
          DB.setBookmarksOrder(sortedIds);
        } catch (e) {
          console.warn('[migration] Failed to restore bookmark order:', e);
        }
      }
    }

    // サイト設定のインポート
    if (data.sitePrefs && Array.isArray(data.sitePrefs)) {
      for (const pref of data.sitePrefs) {
        try {
          const newContainerId = containerIdMapping && containerIdMapping[pref.containerId] 
            ? containerIdMapping[pref.containerId] 
            : pref.containerId;
          DB.upsertSitePref({
            ...pref,
            containerId: newContainerId
          });
          results.sitePrefs.success++;
        } catch (e) {
          console.warn(`[migration] Failed to import site pref:`, e);
          results.sitePrefs.error++;
        }
      }
    }

    // 認証情報のインポート
    if (data.credentials && Array.isArray(data.credentials)) {
      for (const cred of data.credentials) {
        try {
          const newContainerId = containerIdMapping && containerIdMapping[cred.containerId] 
            ? containerIdMapping[cred.containerId] 
            : cred.containerId;
          const account = `${newContainerId}|${cred.origin}|${cred.username}`;
          await keytar.setPassword(SERVICE, account, cred.password);
          DB.upsertCredential({
            containerId: newContainerId,
            origin: cred.origin,
            username: cred.username,
            keytarAccount: account,
            updatedAt: Date.now()
          });
          results.credentials.success++;
        } catch (e) {
          console.warn(`[migration] Failed to import credential for ${cred.containerId}|${cred.origin}:`, e);
          results.credentials.error++;
        }
      }
    }

    const summary = {
      containers: `${results.containers.success}/${results.containers.success + results.containers.error}`,
      sessions: `${results.sessions.success}/${results.sessions.success + results.sessions.error}`,
      tabs: `${results.tabs.success}/${results.tabs.success + results.tabs.error}`,
      bookmarks: `${results.bookmarks.success}/${results.bookmarks.success + results.bookmarks.error}`,
      sitePrefs: `${results.sitePrefs.success}/${results.sitePrefs.success + results.sitePrefs.error}`,
      credentials: `${results.credentials.success}/${results.credentials.success + results.credentials.error}`
    };

    return { ok: true, results, summary };
  } catch (e: any) {
    console.error('[migration] importAll error:', e);
    return { ok: false, error: e?.message || String(e) };
  }
}

// 移行機能: 全データのインポート（IPCハンドラー）
ipcMain.handle('migration.importAll', async (_e, { data, updatePaths, containerIdMapping }: { data: any; updatePaths?: { oldBasePath: string; newBasePath: string }; containerIdMapping?: Record<string, string> }) => {
  return importAllData(data, updatePaths, containerIdMapping);
});

// 移行機能: 完全なエクスポートファイル（ZIP）をインポート
ipcMain.handle('migration.importComplete', async (_e, { containerIdMapping }: { containerIdMapping?: Record<string, string> } = {}) => {
  try {
    const { BrowserWindow } = require('electron');
    const extractZip = require('extract-zip');

    // ファイル選択ダイアログを表示
    const mainWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!mainWindow) {
      return { ok: false, error: 'No window available for dialog' };
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'エクスポートファイルを選択',
      filters: [
        { name: 'ZIP Files', extensions: ['zip'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { ok: false, error: 'Import cancelled' };
    }

    const zipPath = result.filePaths[0];
    if (!fs.existsSync(zipPath)) {
      return { ok: false, error: 'ZIP file not found' };
    }

    const userDataPath = app.getPath('userData');
    const tempDir = path.join(userDataPath, 'temp', 'import-extract');
    
    // 既存の一時ディレクトリを削除
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    // ZIPを展開
    await extractZip(zipPath, { dir: tempDir });

    const results = {
      data: { ok: false, error: null as string | null },
      profiles: { successCount: 0, errorCount: 0 },
      partitions: { successCount: 0, errorCount: 0 }
    };

    // DBデータをインポート
    const dataJsonPath = path.join(tempDir, 'data.json');
    if (fs.existsSync(dataJsonPath)) {
      try {
        const dataJson = fs.readFileSync(dataJsonPath, 'utf-8');
        const exportData = JSON.parse(dataJson);
        
        const userDataPath = app.getPath('userData');
        const oldBasePath = exportData.data?.containers?.[0]?.userDataDir?.split('\\profiles')[0] || '';
        const newBasePath = userDataPath;

        // importAllの処理を直接実行
        const importResult = await importAllData(
          exportData.data, 
          oldBasePath && newBasePath && oldBasePath !== newBasePath
            ? { oldBasePath, newBasePath }
            : undefined,
          containerIdMapping
        );

        results.data = importResult;
      } catch (e: any) {
        results.data = { ok: false, error: e?.message || String(e) };
      }
    } else {
      results.data = { ok: false, error: 'data.json not found in ZIP' };
    }

    // プロファイルをインポート
    const extractedProfilesDir = path.join(tempDir, 'profiles');
    if (fs.existsSync(extractedProfilesDir)) {
      const profilesDir = path.join(userDataPath, 'profiles');
      if (!fs.existsSync(profilesDir)) {
        fs.mkdirSync(profilesDir, { recursive: true });
      }

      const profileDirs = fs.readdirSync(extractedProfilesDir);
      for (const profileDir of profileDirs) {
        try {
          const sourcePath = path.join(extractedProfilesDir, profileDir);
          // コンテナIDマッピングを適用
          const newProfileDir = containerIdMapping && containerIdMapping[profileDir] 
            ? containerIdMapping[profileDir] 
            : profileDir;
          const targetPath = path.join(profilesDir, newProfileDir);
          
          if (fs.statSync(sourcePath).isDirectory()) {
            // 既存のプロファイルがある場合はバックアップ
            if (fs.existsSync(targetPath)) {
              const backupPath = `${targetPath}.backup.${Date.now()}`;
              fs.renameSync(targetPath, backupPath);
            }
            
            // プロファイルをコピー（移動ではなく）
            fs.cpSync(sourcePath, targetPath, { recursive: true });
            if (newProfileDir !== profileDir) {
              console.log(`[migration] Mapped profile directory: ${profileDir} -> ${newProfileDir}`);
            }
            results.profiles.successCount++;
          }
        } catch (e) {
          console.warn(`[migration] Failed to import profile ${profileDir}:`, e);
          results.profiles.errorCount++;
        }
      }
    }

    // Partitionsをインポート（ロックファイルを除外）
    const extractedPartitionsDir = path.join(tempDir, 'Partitions');
    if (fs.existsSync(extractedPartitionsDir)) {
      const partitionsDir = path.join(userDataPath, 'Partitions');
      if (!fs.existsSync(partitionsDir)) {
        fs.mkdirSync(partitionsDir, { recursive: true });
      }

      // Chromium/Electronのロックファイル名（プラットフォーム別）
      const lockFileNames = ['SingletonLock', 'LOCK', 'lockfile'];

      // 再帰的にロックファイルを削除するヘルパー関数
      const removeLockFiles = (dirPath: string) => {
        try {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
              removeLockFiles(fullPath);
            } else if (lockFileNames.includes(entry.name)) {
              try {
                fs.unlinkSync(fullPath);
                console.log(`[migration] Removed lock file: ${fullPath}`);
              } catch (e) {
                console.warn(`[migration] Failed to remove lock file ${fullPath}:`, e);
              }
            }
          }
        } catch (e) {
          console.warn(`[migration] Failed to scan directory for lock files ${dirPath}:`, e);
        }
      };

      const partitionDirs = fs.readdirSync(extractedPartitionsDir);
      for (const partitionDir of partitionDirs) {
        try {
          const sourcePath = path.join(extractedPartitionsDir, partitionDir);
          // partitionディレクトリ名からコンテナIDを抽出（container-${id}形式）
          const partitionMatch = partitionDir.match(/^container-(.+)$/);
          let newPartitionDir = partitionDir;
          if (partitionMatch && containerIdMapping) {
            const originalContainerId = partitionMatch[1];
            const newContainerId = containerIdMapping[originalContainerId];
            if (newContainerId) {
              newPartitionDir = `container-${newContainerId}`;
              console.log(`[migration] Mapped partition directory: ${partitionDir} -> ${newPartitionDir}`);
            }
          }
          const targetPath = path.join(partitionsDir, newPartitionDir);
          
          if (fs.statSync(sourcePath).isDirectory()) {
            // 既存のPartitionがある場合はバックアップ
            if (fs.existsSync(targetPath)) {
              const backupPath = `${targetPath}.backup.${Date.now()}`;
              try {
                fs.renameSync(targetPath, backupPath);
                console.log(`[migration] Backed up existing partition: ${backupPath}`);
              } catch (e) {
                console.warn(`[migration] Failed to backup partition ${targetPath}, will overwrite:`, e);
                // バックアップ失敗時は強制削除を試みる
                try {
                  fs.rmSync(targetPath, { recursive: true, force: true });
                } catch (e2) {
                  console.error(`[migration] Failed to remove existing partition ${targetPath}:`, e2);
                  results.profiles.errorCount++;
                  continue;
                }
              }
            }
            
            // Partitionをコピー（移動ではなく）
            fs.cpSync(sourcePath, targetPath, { recursive: true });
            
            // コピー後にロックファイルを削除
            removeLockFiles(targetPath);
            
            results.partitions.successCount++;
            console.log(`[migration] Imported partition ${newPartitionDir}${newPartitionDir !== partitionDir ? ` (from ${partitionDir})` : ''}`);
          }
        } catch (e) {
          console.warn(`[migration] Failed to import partition ${partitionDir}:`, e);
          results.partitions.errorCount++;
        }
      }
    }

    // 一時ディレクトリを削除
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.warn('[migration] Failed to cleanup temp directory:', e);
    }

    return {
      ok: results.data.ok,
      data: results.data,
      profiles: results.profiles,
      partitions: results.partitions,
      summary: {
        data: results.data.ok ? 'Imported' : `Error: ${results.data.error}`,
        profiles: `${results.profiles.successCount} imported, ${results.profiles.errorCount} errors`,
        partitions: `${results.partitions.successCount} imported, ${results.partitions.errorCount} errors`
      }
    };
  } catch (e: any) {
    console.error('[migration] importComplete error:', e);
    return { ok: false, error: e?.message || String(e) };
  }
});
