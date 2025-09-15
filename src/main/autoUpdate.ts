import { BrowserWindow, dialog, app } from 'electron';
import log from 'electron-log';
import { autoUpdater } from 'electron-updater';

let wired = false;

export function initAutoUpdate(win: BrowserWindow): void {
  // dev ではスキップ
  if (!app.isPackaged) {
    log.info('[autoupdate] skip in dev');
    return;
  }

  if (wired) return;
  wired = true;

  // ログ設定
  try { (log.transports.file.level as any) = 'info'; } catch {}
  try { autoUpdater.logger = log as any; } catch {}

  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: 'https://updates.threadsbooster.jp' });
  } catch (e) {
    log.warn('[autoupdate] setFeedURL warning:', e);
  }

  autoUpdater.on('checking-for-update', () => log.info('[autoupdate] checking-for-update'));
  autoUpdater.on('update-available', () => {
    log.info('[autoupdate] update-available');
    try { void dialog.showMessageBox(win, { message: '新しいバージョンがあります。ダウンロードを開始します。' }); } catch (e) {}
  });
  autoUpdater.on('update-not-available', () => {
    log.info('[autoupdate] update-not-available');
    try { void dialog.showMessageBox(win, { message: '現在お使いのバージョンは最新です。' }); } catch (e) {}
  });
  autoUpdater.on('download-progress', (p) => {
    log.info('[autoupdate] download-progress', JSON.stringify(p));
  });
  autoUpdater.on('error', (err) => {
    log.error('[autoupdate] error', err);
    try { void dialog.showErrorBox('アップデートエラー', (err as any)?.message ?? String(err)); } catch (e) {}
  });
  autoUpdater.on('update-downloaded', async () => {
    log.info('[autoupdate] update-downloaded');
    try {
      const r = await dialog.showMessageBox(win, {
        type: 'question',
        message: '更新を適用しますか？（アプリを再起動します）',
        buttons: ['今すぐ再起動', 'あとで'],
        defaultId: 0,
        cancelId: 1,
      });
      if (r.response === 0) {
        setImmediate(() => autoUpdater.quitAndInstall());
      }
    } catch (e) { log.error('[autoupdate] dialog error', e); }
  });

  // 起動後 5 秒で自動チェック
  setTimeout(() => {
    try {
      autoUpdater.autoDownload = true;
      (autoUpdater as any).autoInstallOnAppQuit = true;
      (autoUpdater as any).allowDowngrade = false;
      void autoUpdater.checkForUpdates().catch((e) => log.error('[autoupdate] check fail', e));
    } catch (e) { log.error('[autoupdate] scheduled check error', e); }
  }, 5000);
}

export async function checkForUpdatesManually(win: BrowserWindow): Promise<void> {
  if (!app.isPackaged) {
    try { await dialog.showMessageBox(win, { message: '開発環境では自動更新は無効です。' }); } catch (e) {}
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (e: any) {
    log.error('[autoupdate] manual check error', e);
    try { await dialog.showErrorBox('アップデートエラー', e?.message ?? String(e)); } catch (ee) {}
  }
}


