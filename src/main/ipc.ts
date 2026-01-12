import { ipcMain, dialog } from 'electron';
import keytar from 'keytar';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { DB } from './db';
import { zipAllProfiles, extractProfiles } from './profileExporter';
import archiver from 'archiver';
import type { Container } from '../shared/types';

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

// Clear container cache (HTTP cache only, preserves cookies and session data)
ipcMain.handle('containers.clearCache', async (_e, { id }: { id: string }) => {
  try {
    const { clearContainerCache } = await import('./containerManager');
    const result = clearContainerCache(id);
    return { ok: result };
  } catch (e: any) {
    console.error('[main] containers.clearCache error', e);
    return { ok: false, error: e?.message || String(e) };
  }
});

// Clear storage for X domains (for recovery from 400 errors)
ipcMain.handle('containers.clearStorageForX', async (_e, { id }: { id: string }) => {
  try {
    const { clearContainerStorageForX } = await import('./containerManager');
    const result = await clearContainerStorageForX(id);
    return { ok: result };
  } catch (e: any) {
    console.error('[main] containers.clearStorageForX error', e);
    return { ok: false, error: e?.message || String(e) };
  }
});

// Clear all storage data (cookies, localStorage, IndexedDB, etc.) for a container
ipcMain.handle('containers.clearAllData', async (_e, { id }: { id: string }) => {
  try {
    const { clearContainerAllData } = await import('./containerManager');
    const result = await clearContainerAllData(id);
    return { ok: result };
  } catch (e: any) {
    console.error('[main] containers.clearAllData error', e);
    return { ok: false, error: e?.message || String(e) };
  }
});

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
    const allContainers = DB.listContainers();
    
    // エクスポート対象コンテナリストを読み込む
    const exportListPath = path.join(app.getPath('userData'), 'export-container-list.txt');
    let allowedContainerIds: Set<string> | null = null;
    let allowedContainerNames: Set<string> | null = null;
    
    if (fs.existsSync(exportListPath)) {
      try {
        const listContent = fs.readFileSync(exportListPath, 'utf-8');
        const lines = listContent.split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#')); // 空行とコメント行を除外
        
        if (lines.length > 0) {
          allowedContainerIds = new Set<string>();
          allowedContainerNames = new Set<string>();
          
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              // IDまたは名前として追加
              allowedContainerIds.add(trimmed);
              allowedContainerNames.add(trimmed.toLowerCase());
            }
          }
          
          console.log(`[migration] エクスポート対象リストから ${lines.length}件のエントリを読み込みました`);
          sendProgress(`エクスポート対象リストから ${lines.length}件を読み込み`);
        }
      } catch (e) {
        console.warn(`[migration] エクスポート対象リストの読み込みに失敗:`, e);
        sendProgress(`警告: エクスポート対象リストの読み込みに失敗しました`);
      }
    }
    
    // Bannedグループのコンテナを除外（名前またはnoteに"Banned"が含まれる）
    const isBannedContainer = (container: Container) => {
      const name = (container.name || '').toLowerCase();
      const note = (container.note || '').toLowerCase();
      return name.includes('banned') || note.includes('banned');
    };
    
    // エクスポート対象のフィルタリング
    let filteredContainers = allContainers.filter(c => !isBannedContainer(c));
    
    // エクスポート対象リストが存在する場合は、リストに含まれるコンテナのみを対象にする
    if (allowedContainerIds && allowedContainerNames) {
      filteredContainers = filteredContainers.filter(c => {
        // IDまたは名前でマッチ
        return allowedContainerIds!.has(c.id) || allowedContainerNames!.has(c.name.toLowerCase());
      });
      console.log(`[migration] エクスポート対象リストに基づいて ${filteredContainers.length}件のコンテナを選択しました`);
      sendProgress(`エクスポート対象: ${filteredContainers.length}件のコンテナ`);
    }
    
    const containers = filteredContainers;
    const bannedContainers = allContainers.filter(c => isBannedContainer(c));
    const excludedContainers = allContainers.filter(c => 
      !isBannedContainer(c) && !containers.some(ec => ec.id === c.id)
    );
    
    if (bannedContainers.length > 0) {
      console.log(`[migration] Bannedグループのコンテナ ${bannedContainers.length}件をエクスポートから除外しました`);
      sendProgress(`Bannedグループのコンテナ ${bannedContainers.length}件を除外`);
    }
    
    if (excludedContainers.length > 0 && allowedContainerIds) {
      console.log(`[migration] エクスポート対象リストに含まれないコンテナ ${excludedContainers.length}件を除外しました`);
      sendProgress(`リスト外のコンテナ ${excludedContainers.length}件を除外`);
    }
    
    // Bannedグループを除外したコンテナIDのセットを作成
    const bannedContainerIds = new Set(bannedContainers.map(c => c.id));
    
    const sessions = DB.listAllSessions().filter(s => !bannedContainerIds.has(s.containerId));
    const tabs = DB.listAllTabs().filter(t => !bannedContainerIds.has(t.containerId));
    const bookmarks = DB.listBookmarks().filter(b => !bannedContainerIds.has(b.containerId));
    const sitePrefs = DB.listAllSitePrefs().filter(sp => !bannedContainerIds.has(sp.containerId));
    
    const credentials: Array<{ containerId: string; origin: string; username: string; password: string }> = [];
    const credentialRows = DB.listAllCredentials().filter(row => !bannedContainerIds.has(row.containerId));
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
        containersExcluded: bannedContainers.length + (excludedContainers?.length || 0),
        containersTotal: allContainers.length,
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
      let totalFiles = 0;
      let processedFiles = 0;
      let currentContainerIndex = 0;
      let totalContainers = 0;

      // 進捗を送信する関数
      const sendProgress = (message: string, progress?: { current: number; total: number; percent: number }) => {
        try {
          const mainWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
          if (mainWindow) {
            mainWindow.webContents.send('migration.exportProgress', {
              message,
              progress,
              timestamp: Date.now()
            });
          }
        } catch (e) {
          // 進捗送信エラーは無視
        }
      };

      output.on('close', () => {
        // 一時ファイルを削除
        try {
          if (fs.existsSync(dbJsonPath)) fs.unlinkSync(dbJsonPath);
        } catch (e) {
          console.warn('[migration] Failed to cleanup temp file:', e);
        }

        sendProgress('エクスポート完了', { current: 100, total: 100, percent: 100 });

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
        sendProgress(`エラー: ${err?.message || String(err)}`);
        resolve({ ok: false, error: err?.message || String(err) });
      });

      // アーカイブの進捗イベント
      archive.on('progress', (progress) => {
        // progress.entries が undefined の場合があるため、安全にアクセス
        const entries = progress.entries || {};
        const bytes = progress.bytes || {};
        const percent = entries.total && entries.processed !== undefined 
          ? Math.round((entries.processed / entries.total) * 100) 
          : (bytes.total && bytes.processed !== undefined 
            ? Math.round((bytes.processed / bytes.total) * 100) 
            : 0);
        
        const sizeInfo = bytes.processed !== undefined && bytes.total !== undefined
          ? `${(bytes.processed / 1024 / 1024).toFixed(2)} MB / ${(bytes.total / 1024 / 1024).toFixed(2)} MB`
          : bytes.processed !== undefined
          ? `${(bytes.processed / 1024 / 1024).toFixed(2)} MB`
          : '処理中...';
        
        sendProgress(
          `アーカイブ中... ${sizeInfo}${percent > 0 ? ` (${percent}%)` : ''}`,
          entries.total && entries.processed !== undefined 
            ? { current: entries.processed, total: entries.total, percent } 
            : undefined
        );
      });

      // 各ファイルが追加されたとき
      archive.on('entry', (entry) => {
        processedFiles++;
        if (processedFiles % 100 === 0 || processedFiles === 1) {
          sendProgress(`ファイル処理中... ${processedFiles}件`);
        }
      });

      archive.pipe(output);

      // DBデータをZIPに追加
      sendProgress('データベースデータをZIPに追加中...');
      archive.file(dbJsonPath, { name: 'data.json' });

      // プロファイルとPartitionsをZIPに追加（キャッシュ等を除外）
      if (includeProfiles) {
        // Bannedグループを除外したコンテナのみを処理（既にフィルタリング済み）
        const containersToExport = containers;
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

        totalContainers = containersToExport.length;
        sendProgress(`エクスポート開始: ${totalContainers}個のコンテナを処理します${bannedContainers.length > 0 ? ` (Bannedグループ ${bannedContainers.length}件を除外)` : ''}`);

        for (let i = 0; i < containersToExport.length; i++) {
          const container = containersToExport[i];
          currentContainerIndex = i + 1;
          sendProgress(`コンテナ処理中: ${container.name || container.id} (${currentContainerIndex}/${totalContainers})`);

          // profiles/${container.id} を追加（フィルタリング適用）
          const profilePath = path.join(profilesDir, container.id);
          if (fs.existsSync(profilePath)) {
            try {
              sendProgress(`  プロファイル追加中: ${container.id}`);
              addDirectoryFiltered(archive, profilePath, `profiles/${container.id}`, profilePath);
              profileCount++;
              console.log(`[migration] Added profile ${container.id} (with exclusions)`);
            } catch (e) {
              console.warn(`[migration] Failed to add profile ${container.id}:`, e);
              profileErrorCount++;
              sendProgress(`  警告: プロファイル ${container.id} の追加に失敗`);
            }
          }

          // Partitions/container-${container.id} を追加（フィルタリング適用）
          const partitionDirName = extractPartitionDirName(container.partition);
          if (partitionDirName) {
            const partitionPath = path.join(partitionsDir, partitionDirName);
            if (fs.existsSync(partitionPath)) {
              try {
                sendProgress(`  Partition追加中: ${partitionDirName}`);
                addDirectoryFiltered(archive, partitionPath, `Partitions/${partitionDirName}`, partitionPath);
                partitionCount++;
                console.log(`[migration] Added partition ${partitionDirName} for container ${container.id} (with exclusions)`);
              } catch (e) {
                console.warn(`[migration] Failed to add partition ${partitionDirName}:`, e);
                partitionErrorCount++;
                sendProgress(`  警告: Partition ${partitionDirName} の追加に失敗`);
              }
            } else {
              console.warn(`[migration] Partition not found: ${partitionPath}`);
            }
          } else {
            console.warn(`[migration] Invalid partition format: ${container.partition}`);
          }
        }

        sendProgress(`コンテナ処理完了: プロファイル ${profileCount}件, Partitions ${partitionCount}件`);

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
async function importAllData(data: any, updatePaths?: { oldBasePath: string; newBasePath: string }, containerIdMapping?: Record<string, string>, sendProgress?: (message: string, progress?: { current: number; total: number; percent: number }) => void) {
  try {
    const progressCallback = sendProgress || (() => {});
    console.log('[migration] importAllData: データインポートを開始します', {
      hasContainers: !!data.containers,
      containersCount: data.containers?.length || 0,
      hasSessions: !!data.sessions,
      hasTabs: !!data.tabs,
      hasBookmarks: !!data.bookmarks,
      hasSitePrefs: !!data.sitePrefs,
      hasCredentials: !!data.credentials,
      updatePaths,
      hasContainerIdMapping: !!containerIdMapping
    });
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
      const containersCount = data.containers.length;
      console.log('[migration] importAllData: コンテナのインポートを開始します (件数:', containersCount, ')');
      progressCallback(`コンテナをインポートしています... (0/${containersCount})`, { current: 0, total: containersCount, percent: 0 });
      for (let i = 0; i < data.containers.length; i++) {
        const container = data.containers[i];
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
          const percent = Math.round(((i + 1) / containersCount) * 100);
          progressCallback(`コンテナをインポートしています... (${i + 1}/${containersCount})`, { current: i + 1, total: containersCount, percent });
        } catch (e) {
          console.warn(`[migration] Failed to import container ${container.id}:`, e);
          results.containers.error++;
          const percent = Math.round(((i + 1) / containersCount) * 100);
          progressCallback(`コンテナインポート中にエラー: ${container.name || container.id}`, { current: i + 1, total: containersCount, percent });
        }
      }
      if (containersCount > 0) {
        progressCallback(`コンテナのインポートが完了しました (成功: ${results.containers.success}, エラー: ${results.containers.error})`, { current: containersCount, total: containersCount, percent: 100 });
      }
    }

    // セッションのインポート
    if (data.sessions && Array.isArray(data.sessions)) {
      const sessionsCount = data.sessions.length;
      if (sessionsCount > 0) {
        progressCallback(`セッションをインポートしています... (0/${sessionsCount})`, { current: 0, total: sessionsCount, percent: 0 });
      }
      for (let i = 0; i < data.sessions.length; i++) {
        const session = data.sessions[i];
        try {
          const newContainerId = containerIdMapping && containerIdMapping[session.containerId] 
            ? containerIdMapping[session.containerId] 
            : session.containerId;
          DB.recordSession(session.id, newContainerId, session.startedAt);
          if (session.closedAt) {
            DB.closeSession(session.id, session.closedAt);
          }
          results.sessions.success++;
          if (sessionsCount > 0) {
            const percent = Math.round(((i + 1) / sessionsCount) * 100);
            progressCallback(`セッションをインポートしています... (${i + 1}/${sessionsCount})`, { current: i + 1, total: sessionsCount, percent });
          }
        } catch (e) {
          console.warn(`[migration] Failed to import session ${session.id}:`, e);
          results.sessions.error++;
          if (sessionsCount > 0) {
            const percent = Math.round(((i + 1) / sessionsCount) * 100);
            progressCallback(`セッションインポート中にエラー`, { current: i + 1, total: sessionsCount, percent });
          }
        }
      }
      if (sessionsCount > 0) {
        progressCallback(`セッションのインポートが完了しました (成功: ${results.sessions.success}, エラー: ${results.sessions.error})`, { current: sessionsCount, total: sessionsCount, percent: 100 });
      }
    }

    // タブのインポート
    if (data.tabs && Array.isArray(data.tabs)) {
      const tabsCount = data.tabs.length;
      if (tabsCount > 0) {
        progressCallback(`タブをインポートしています... (0/${tabsCount})`, { current: 0, total: tabsCount, percent: 0 });
      }
      for (let i = 0; i < data.tabs.length; i++) {
        const tab = data.tabs[i];
        try {
          const newContainerId = containerIdMapping && containerIdMapping[tab.containerId] 
            ? containerIdMapping[tab.containerId] 
            : tab.containerId;
          DB.addOrUpdateTab({
            ...tab,
            containerId: newContainerId
          });
          results.tabs.success++;
          if (tabsCount > 0) {
            const percent = Math.round(((i + 1) / tabsCount) * 100);
            progressCallback(`タブをインポートしています... (${i + 1}/${tabsCount})`, { current: i + 1, total: tabsCount, percent });
          }
        } catch (e) {
          console.warn(`[migration] Failed to import tab:`, e);
          results.tabs.error++;
          if (tabsCount > 0) {
            const percent = Math.round(((i + 1) / tabsCount) * 100);
            progressCallback(`タブインポート中にエラー`, { current: i + 1, total: tabsCount, percent });
          }
        }
      }
      if (tabsCount > 0) {
        progressCallback(`タブのインポートが完了しました (成功: ${results.tabs.success}, エラー: ${results.tabs.error})`, { current: tabsCount, total: tabsCount, percent: 100 });
      }
    }

    // ブックマークのインポート
    if (data.bookmarks && Array.isArray(data.bookmarks)) {
      const bookmarksCount = data.bookmarks.length;
      if (bookmarksCount > 0) {
        progressCallback(`ブックマークをインポートしています... (0/${bookmarksCount})`, { current: 0, total: bookmarksCount, percent: 0 });
      }
      const existingBookmarks = DB.listBookmarks();
      const existingIds = new Set(existingBookmarks.map(b => b.id));
      
      for (let i = 0; i < data.bookmarks.length; i++) {
        const bookmark = data.bookmarks[i];
        try {
          const newContainerId = containerIdMapping && bookmark.containerId && containerIdMapping[bookmark.containerId] 
            ? containerIdMapping[bookmark.containerId] 
            : (bookmark.containerId || '');
          // 既存のブックマークをチェック
          if (existingIds.has(bookmark.id)) {
            // 既存の場合は先に削除してから追加（更新のため）
            DB.deleteBookmark(bookmark.id);
          }
          // 新規追加または更新（削除後に追加）
          DB.addBookmark({
            id: bookmark.id,
            containerId: newContainerId,
            title: bookmark.title,
            url: bookmark.url,
            createdAt: bookmark.createdAt || existingBookmarks.find(b => b.id === bookmark.id)?.createdAt || Date.now()
          });
          results.bookmarks.success++;
          if (bookmarksCount > 0) {
            const percent = Math.round(((i + 1) / bookmarksCount) * 100);
            progressCallback(`ブックマークをインポートしています... (${i + 1}/${bookmarksCount})`, { current: i + 1, total: bookmarksCount, percent });
          }
        } catch (e) {
          console.warn(`[migration] Failed to import bookmark ${bookmark.id}:`, e);
          results.bookmarks.error++;
          if (bookmarksCount > 0) {
            const percent = Math.round(((i + 1) / bookmarksCount) * 100);
            progressCallback(`ブックマークインポート中にエラー`, { current: i + 1, total: bookmarksCount, percent });
          }
        }
      }
      if (bookmarksCount > 0) {
        progressCallback(`ブックマークのインポートが完了しました (成功: ${results.bookmarks.success}, エラー: ${results.bookmarks.error})`, { current: bookmarksCount, total: bookmarksCount, percent: 100 });
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
      const sitePrefsCount = data.sitePrefs.length;
      if (sitePrefsCount > 0) {
        progressCallback(`サイト設定をインポートしています... (0/${sitePrefsCount})`, { current: 0, total: sitePrefsCount, percent: 0 });
      }
      for (let i = 0; i < data.sitePrefs.length; i++) {
        const pref = data.sitePrefs[i];
        try {
          const newContainerId = containerIdMapping && containerIdMapping[pref.containerId] 
            ? containerIdMapping[pref.containerId] 
            : pref.containerId;
          DB.upsertSitePref({
            ...pref,
            containerId: newContainerId
          });
          results.sitePrefs.success++;
          if (sitePrefsCount > 0) {
            const percent = Math.round(((i + 1) / sitePrefsCount) * 100);
            progressCallback(`サイト設定をインポートしています... (${i + 1}/${sitePrefsCount})`, { current: i + 1, total: sitePrefsCount, percent });
          }
        } catch (e) {
          console.warn(`[migration] Failed to import site pref:`, e);
          results.sitePrefs.error++;
          if (sitePrefsCount > 0) {
            const percent = Math.round(((i + 1) / sitePrefsCount) * 100);
            progressCallback(`サイト設定インポート中にエラー`, { current: i + 1, total: sitePrefsCount, percent });
          }
        }
      }
      if (sitePrefsCount > 0) {
        progressCallback(`サイト設定のインポートが完了しました (成功: ${results.sitePrefs.success}, エラー: ${results.sitePrefs.error})`, { current: sitePrefsCount, total: sitePrefsCount, percent: 100 });
      }
    }

    // 認証情報のインポート
    if (data.credentials && Array.isArray(data.credentials)) {
      const credentialsCount = data.credentials.length;
      if (credentialsCount > 0) {
        progressCallback(`認証情報をインポートしています... (0/${credentialsCount})`, { current: 0, total: credentialsCount, percent: 0 });
      }
      for (let i = 0; i < data.credentials.length; i++) {
        const cred = data.credentials[i];
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
          if (credentialsCount > 0) {
            const percent = Math.round(((i + 1) / credentialsCount) * 100);
            progressCallback(`認証情報をインポートしています... (${i + 1}/${credentialsCount})`, { current: i + 1, total: credentialsCount, percent });
          }
        } catch (e) {
          console.warn(`[migration] Failed to import credential for ${cred.containerId}|${cred.origin}:`, e);
          results.credentials.error++;
          if (credentialsCount > 0) {
            const percent = Math.round(((i + 1) / credentialsCount) * 100);
            progressCallback(`認証情報インポート中にエラー`, { current: i + 1, total: credentialsCount, percent });
          }
        }
      }
      if (credentialsCount > 0) {
        progressCallback(`認証情報のインポートが完了しました (成功: ${results.credentials.success}, エラー: ${results.credentials.error})`, { current: credentialsCount, total: credentialsCount, percent: 100 });
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

    console.log('[migration] importAllData: データインポートが完了しました', summary);
    return { ok: true, results, summary };
  } catch (e: any) {
    console.error('[migration] importAllData: データインポートでエラーが発生しました:', e);
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
    console.log('[migration] importComplete: インポート処理を開始します');
    const { BrowserWindow } = require('electron');
    const extractZip = require('extract-zip');

    // 進捗を送信する関数
    const sendProgress = (message: string, progress?: { current: number; total: number; percent: number }) => {
      try {
        const mainWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
        if (mainWindow) {
          mainWindow.webContents.send('migration.importProgress', {
            message,
            progress,
            timestamp: Date.now()
          });
        }
      } catch (e) {
        // 進捗送信エラーは無視
      }
    };

    // ファイル選択ダイアログを表示
    const mainWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!mainWindow) {
      console.warn('[migration] importComplete: ダイアログ表示用のウィンドウが見つかりません');
      return { ok: false, error: 'No window available for dialog' };
    }

    sendProgress('ファイル選択ダイアログを表示しています...');
    console.log('[migration] importComplete: ファイル選択ダイアログを表示します');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'エクスポートファイルを選択',
      filters: [
        { name: 'ZIP Files', extensions: ['zip'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      console.log('[migration] importComplete: インポートがキャンセルされました');
      return { ok: false, error: 'Import cancelled' };
    }

    const zipPath = result.filePaths[0];
    console.log('[migration] importComplete: 選択されたZIPファイル:', zipPath);
    if (!fs.existsSync(zipPath)) {
      console.error('[migration] importComplete: ZIPファイルが見つかりません:', zipPath);
      sendProgress('エラー: ZIPファイルが見つかりません', { current: 0, total: 100, percent: 0 });
      return { ok: false, error: 'ZIP file not found' };
    }

    const userDataPath = app.getPath('userData');
    const tempDir = path.join(userDataPath, 'temp', 'import-extract');
    console.log('[migration] importComplete: 一時ディレクトリ:', tempDir);
    
    // 既存の一時ディレクトリを削除
    if (fs.existsSync(tempDir)) {
      console.log('[migration] importComplete: 既存の一時ディレクトリを削除します');
      sendProgress('一時ディレクトリを準備しています...');
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    // ZIPを展開
    sendProgress('ZIPファイルを展開しています...', { current: 0, total: 100, percent: 0 });
    console.log('[migration] importComplete: ZIPファイルを展開します:', zipPath);
    try {
      await extractZip(zipPath, { dir: tempDir });
      sendProgress('ZIPファイルの展開が完了しました', { current: 100, total: 100, percent: 100 });
      console.log('[migration] importComplete: ZIPファイルの展開が完了しました');
      
      // 展開されたファイルを確認
      try {
        const extractedFiles = fs.readdirSync(tempDir);
        console.log('[migration] importComplete: 展開されたファイル/ディレクトリ:', extractedFiles);
        const hasDataJson = fs.existsSync(path.join(tempDir, 'data.json'));
        const hasProfiles = fs.existsSync(path.join(tempDir, 'profiles'));
        const hasPartitions = fs.existsSync(path.join(tempDir, 'Partitions'));
        console.log('[migration] importComplete: 展開内容確認 - data.json:', hasDataJson, 'profiles:', hasProfiles, 'Partitions:', hasPartitions);
      } catch (e) {
        console.warn('[migration] importComplete: 展開内容の確認でエラー:', e);
      }
    } catch (e: any) {
      const errorMsg = `ZIPファイルの展開でエラーが発生しました: ${e?.message || String(e)}`;
      console.error('[migration] importComplete:', errorMsg, e);
      sendProgress(errorMsg, { current: 0, total: 100, percent: 0 });
      throw e;
    }

    const results = {
      data: { ok: false, error: null as string | null },
      profiles: { successCount: 0, errorCount: 0 },
      partitions: { successCount: 0, errorCount: 0 }
    };

    // DBデータをインポート
    const dataJsonPath = path.join(tempDir, 'data.json');
    sendProgress('DBデータのインポートを開始します...', { current: 0, total: 100, percent: 0 });
    console.log('[migration] importComplete: DBデータのインポートを開始します');
    if (fs.existsSync(dataJsonPath)) {
      try {
        sendProgress('data.jsonを読み込んでいます...');
        console.log('[migration] importComplete: data.jsonを読み込みます');
        const dataJson = fs.readFileSync(dataJsonPath, 'utf-8');
        const exportData = JSON.parse(dataJson);
        
        const userDataPath = app.getPath('userData');
        const oldBasePath = exportData.data?.containers?.[0]?.userDataDir?.split('\\profiles')[0] || '';
        const newBasePath = userDataPath;

        const containersCount = exportData.data?.containers?.length || 0;
        sendProgress(`データをインポートしています... (コンテナ: ${containersCount}件)`, { current: 0, total: 100, percent: 0 });
        console.log('[migration] importComplete: importAllDataを実行します', {
          containersCount,
          oldBasePath,
          newBasePath
        });
        // importAllの処理を直接実行（進捗コールバック付き）
        const importResult = await importAllData(
          exportData.data, 
          oldBasePath && newBasePath && oldBasePath !== newBasePath
            ? { oldBasePath, newBasePath }
            : undefined,
          containerIdMapping,
          sendProgress
        );

        results.data = importResult;
        if (importResult.ok) {
          sendProgress('DBデータのインポートが完了しました', { current: 100, total: 100, percent: 100 });
        } else {
          sendProgress(`DBデータのインポートでエラー: ${importResult.error}`, { current: 0, total: 100, percent: 0 });
        }
        console.log('[migration] importComplete: DBデータのインポートが完了しました', results.data);
      } catch (e: any) {
        console.error('[migration] importComplete: DBデータのインポートでエラーが発生しました:', e);
        sendProgress(`DBデータのインポートでエラーが発生しました: ${e?.message || String(e)}`, { current: 0, total: 100, percent: 0 });
        results.data = { ok: false, error: e?.message || String(e) };
      }
    } else {
      console.warn('[migration] importComplete: data.jsonが見つかりません:', dataJsonPath);
      sendProgress('エラー: data.jsonが見つかりません', { current: 0, total: 100, percent: 0 });
      results.data = { ok: false, error: 'data.json not found in ZIP' };
    }

    // プロファイルをインポート
    const extractedProfilesDir = path.join(tempDir, 'profiles');
    console.log('[migration] importComplete: プロファイルのインポートを開始します');
    if (fs.existsSync(extractedProfilesDir)) {
      const profilesDir = path.join(userDataPath, 'profiles');
      if (!fs.existsSync(profilesDir)) {
        fs.mkdirSync(profilesDir, { recursive: true });
      }

      const profileDirs = fs.readdirSync(extractedProfilesDir);
      console.log('[migration] importComplete: インポート対象のプロファイル数:', profileDirs.length);
      sendProgress(`プロファイルをインポートしています... (0/${profileDirs.length})`, { current: 0, total: profileDirs.length, percent: 0 });
      for (let i = 0; i < profileDirs.length; i++) {
        const profileDir = profileDirs[i];
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
            const percent = Math.round(((i + 1) / profileDirs.length) * 100);
            sendProgress(`プロファイルをインポートしています... (${i + 1}/${profileDirs.length})`, { current: i + 1, total: profileDirs.length, percent });
          }
        } catch (e) {
          console.warn(`[migration] Failed to import profile ${profileDir}:`, e);
          results.profiles.errorCount++;
          const percent = Math.round(((i + 1) / profileDirs.length) * 100);
          sendProgress(`プロファイルインポート中にエラー: ${profileDir}`, { current: i + 1, total: profileDirs.length, percent });
        }
      }
      if (profileDirs.length > 0) {
        sendProgress(`プロファイルのインポートが完了しました (成功: ${results.profiles.successCount}, エラー: ${results.profiles.errorCount})`, { current: profileDirs.length, total: profileDirs.length, percent: 100 });
      }
    }

    // Partitionsをインポート（ロックファイルを除外）
    const extractedPartitionsDir = path.join(tempDir, 'Partitions');
    console.log('[migration] importComplete: Partitionsのインポートを開始します');
    if (fs.existsSync(extractedPartitionsDir)) {
      const partitionsDir = path.join(userDataPath, 'Partitions');
      if (!fs.existsSync(partitionsDir)) {
        fs.mkdirSync(partitionsDir, { recursive: true });
      }

      const partitionDirs = fs.readdirSync(extractedPartitionsDir);
      console.log('[migration] importComplete: インポート対象のPartition数:', partitionDirs.length);
      sendProgress(`Partitionsをインポートしています... (0/${partitionDirs.length})`, { current: 0, total: partitionDirs.length, percent: 0 });

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

      for (let i = 0; i < partitionDirs.length; i++) {
        const partitionDir = partitionDirs[i];
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
                  results.partitions.errorCount++;
                  const percent = Math.round(((i + 1) / partitionDirs.length) * 100);
                  sendProgress(`Partitionインポート中にエラー: ${partitionDir}`, { current: i + 1, total: partitionDirs.length, percent });
                  continue;
                }
              }
            }
            
            // Partitionをコピー（移動ではなく）
            fs.cpSync(sourcePath, targetPath, { recursive: true });
            
            // コピー後にロックファイルを削除
            removeLockFiles(targetPath);
            
            results.partitions.successCount++;
            const percent = Math.round(((i + 1) / partitionDirs.length) * 100);
            sendProgress(`Partitionsをインポートしています... (${i + 1}/${partitionDirs.length})`, { current: i + 1, total: partitionDirs.length, percent });
            console.log(`[migration] Imported partition ${newPartitionDir}${newPartitionDir !== partitionDir ? ` (from ${partitionDir})` : ''}`);
          }
        } catch (e) {
          console.warn(`[migration] Failed to import partition ${partitionDir}:`, e);
          results.partitions.errorCount++;
          const percent = Math.round(((i + 1) / partitionDirs.length) * 100);
          sendProgress(`Partitionインポート中にエラー: ${partitionDir}`, { current: i + 1, total: partitionDirs.length, percent });
        }
      }
      if (partitionDirs.length > 0) {
        sendProgress(`Partitionsのインポートが完了しました (成功: ${results.partitions.successCount}, エラー: ${results.partitions.errorCount})`, { current: partitionDirs.length, total: partitionDirs.length, percent: 100 });
      }
    }

    // 一時ディレクトリを削除
    sendProgress('一時ディレクトリをクリーンアップしています...');
    console.log('[migration] importComplete: 一時ディレクトリをクリーンアップします');
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log('[migration] importComplete: 一時ディレクトリの削除が完了しました');
    } catch (e) {
      console.warn('[migration] importComplete: 一時ディレクトリのクリーンアップに失敗しました:', e);
    }

    const summary = {
      data: results.data.ok ? 'Imported' : `Error: ${results.data.error}`,
      profiles: `${results.profiles.successCount} imported, ${results.profiles.errorCount} errors`,
      partitions: `${results.partitions.successCount} imported, ${results.partitions.errorCount} errors`
    };
    sendProgress('インポート処理が完了しました', { current: 100, total: 100, percent: 100 });
    console.log('[migration] importComplete: インポート処理が完了しました', summary);

    return {
      ok: results.data.ok,
      data: results.data,
      profiles: results.profiles,
      partitions: results.partitions,
      summary
    };
  } catch (e: any) {
    console.error('[migration] importComplete: インポート処理でエラーが発生しました:', e);
    return { ok: false, error: e?.message || String(e) };
  }
});
