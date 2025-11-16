import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut } from 'electron';
import { dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { initDB, DB } from './db';
import { openContainerWindow, closeAllContainers, closeAllNonMainWindows, forceCloseAllNonMainWindows } from './containerManager';
import './ipc';
import { loadConfig, getExportSettings, setExportSettings } from './settings';
import { registerCustomProtocol } from './protocol';
import { randomUUID } from 'node:crypto';
import type { Container, Fingerprint } from '../shared/types';
import logger from '../shared/logger';
import { saveToken, getToken, clearToken, getOrCreateDeviceId } from './tokenStore';

// Helper: after opening DevTools in detached mode, find the DevTools window and set its title/icon
function adjustDevtoolsWindowForWebContents(targetWC: Electron.WebContents) {
  try {
    setTimeout(() => {
      try {
        const devWC = (targetWC as any).getDevToolsWebContents ? (targetWC as any).getDevToolsWebContents() : (targetWC as any).devToolsWebContents;
        if (!devWC) return;
        const devWin = BrowserWindow.fromWebContents(devWC as any);
        const parentWin = BrowserWindow.fromWebContents(targetWC as any);
        if (devWin) {
          try {
            const parentTitle = parentWin ? (parentWin.getTitle && parentWin.getTitle()) || '' : '';
            if (parentTitle) try { devWin.setTitle(`Dev-${parentTitle}`); } catch {}
            // set a common icon if available
            try {
              const icoPath = path.join(app.getAppPath(), 'build-resources', 'Icon.ico');
              if (existsSync(icoPath)) devWin.setIcon(icoPath as any);
            } catch {}
          } catch {}
        }
      } catch {}
    }, 200);
  } catch {}
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
// prevent duplicate container opens from rapid repeated handleArgv calls
const _pendingOpenNames = new Set<string>();

async function createMainWindow() {
  const preloadPath = path.join(app.getAppPath(), 'out', 'preload', 'mainPreload.cjs');
  logger.debug('[main] main preload:', preloadPath, 'exists=', existsSync(preloadPath));

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath
    }
  });
  // set window icon if available
  try {
    const iconPath = path.join(app.getAppPath(), 'build-resources', 'Icon.ico');
    if (existsSync(iconPath)) mainWindow.setIcon(iconPath as any);
  } catch (e) { logger.error('[main] set main window icon error', e); }

  // When the main window is closed, ensure all container shells are also closed
  try {
    mainWindow.on('close', (e) => {
      if (isQuitting) return;
      try {
        e.preventDefault();
        logger.info('[main] mainWindow close event triggered -> hiding to tray');
        try { if (closeAllContainers) closeAllContainers(); } catch (err) { console.error('[main] closeAllContainers error', err); }
        try { if (closeAllNonMainWindows) closeAllNonMainWindows(); } catch (err) { console.error('[main] closeAllNonMainWindows error', err); }
        try { mainWindow?.hide(); } catch (err) { console.error('[main] hide mainWindow error', err); }
        // ensure force destroy shortly after
        setTimeout(() => { try { if (forceCloseAllNonMainWindows) forceCloseAllNonMainWindows(); } catch (e) {} }, 250);
      } catch (e) { console.error('[main] error in mainWindow.close handler', e); }
    });
  } catch (e) { console.error('[main] failed to attach mainWindow close handler', e); }

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    await mainWindow.loadURL(devUrl);
  } else {
    const url = new URL('file://' + path.join(app.getAppPath(), 'out', 'renderer', 'index.html'));
    await mainWindow.loadURL(url.toString());
  }

  // create tray icon and menu (robust lookup for packaged/app resources)
  try {
    const candidates = ['icon.ico', 'Icon.ico', 'icon.png', 'Icon.png'];
    let chosenPath: string | null = null;
    const bases = [path.join(app.getAppPath(), 'build-resources')];
    try { if (process && (process as any).resourcesPath) bases.push(path.join((process as any).resourcesPath, 'build-resources')); } catch {}
    for (const base of bases) {
      for (const n of candidates) {
        const p = path.join(base, n);
        try { if (existsSync(p)) { chosenPath = p; break; } } catch {}
      }
      if (chosenPath) break;
    }
    let img = nativeImage.createEmpty();
    logger.debug('[main] tray bases=', bases, 'chosenPath=', chosenPath);
    if (chosenPath) {
      try {
        // try buffer route then resize to small tray-friendly size
        const fs = require('fs');
        const buf = fs.readFileSync(chosenPath);
        img = nativeImage.createFromBuffer(buf);
        if (!img.isEmpty()) {
          try { img = img.resize({ width: 16, height: 16 }); } catch {}
        }
      } catch (e) {
        logger.error('[main] tray load error', e);
        try { img = nativeImage.createFromPath(chosenPath); } catch (e2) { logger.error('[main] createFromPath fallback error', e2); }
      }
    }
    try {
      if (chosenPath && !img.isEmpty()) tray = new Tray(img);
      else if (chosenPath) tray = new Tray(chosenPath as any);
      else tray = new Tray(nativeImage.createEmpty() as any);
    } catch (e) {
      logger.error('[main] tray creation error', e);
    }
    // use module-scope interactive check (defined below)

    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show', click: () => { try { mainWindow?.show(); } catch {} } },
      { type: 'separator' },
      { label: 'Exit', click: () => { isQuitting = true; app.quit(); } }
    ]);
    try { tray?.setToolTip('Container Browser'); tray?.setContextMenu(contextMenu); tray?.on('double-click', () => { try { mainWindow?.show(); } catch {} }); } catch (e) { logger.error('[main] tray setup error', e); }
  } catch (e) { logger.error('[main] failed to create tray', e); }

  // Ensure application menu contains File->Exit that fully quits the app
  try {
    const appMenuTemplate = [
      {
        label: 'File',
        submenu: [
          { label: 'Exit', click: () => { isQuitting = true; app.quit(); } }
        ]
      },
      {
        label: 'Help',
        submenu: [
          { label: 'Settings', click: () => { try { createSettingsWindow(); } catch (e) { logger.error('[menu] openSettings error', e); } } },
          { type: 'separator' },
          { label: 'Check for updates', click: () => { try { checkForUpdatesInteractive().catch((e) => logger.error('[menu] checkForUpdatesInteractive error', e)); } catch (e) { logger.error('[menu] checkForUpdates error', e); } } },
          { label: 'Show version', click: () => { try { dialog.showMessageBox({ message: `Version: ${app.getVersion()}` }); } catch (e) { logger.error('[menu] showVersion error', e); } } }
        ]
      }
    ];
    const appMenu = Menu.buildFromTemplate(appMenuTemplate as any);
    Menu.setApplicationMenu(appMenu);
  } catch (e) { logger.error('[main] failed to set application menu', e); }

// Create a separate Settings window that loads the renderer with ?settings=1
function createSettingsWindow() {
  try {
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    // In dev mode the renderer dev server root is provided in devUrl.
    // Use the root (or index) and append ?settings=1 so the renderer shows the Settings-only UI.
    let url: string;
    if (devUrl) {
      url = `${devUrl.replace(/\/$/, '')}/?settings=1`;
    } else {
      url = new URL('file://' + path.join(app.getAppPath(), 'out', 'renderer', 'index.html')).toString() + '?settings=1';
    }
    const win = new BrowserWindow({
      width: 600,
      height: 420,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(app.getAppPath(), 'out', 'preload', 'mainPreload.cjs')
      }
    });
    win.loadURL(url).catch(() => {});
    // Notify renderer instance that it should show Settings-only view after load
    win.webContents.once('did-finish-load', () => {
      try { win.webContents.send('open-settings'); } catch (e) { /* ignore */ }
    });
    return win;
  } catch (e) {
    logger.error('[main] createSettingsWindow error', e);
    return null;
  }
}

// IPC handlers for app actions exposed to renderer via preload
ipcMain.handle('app.getVersion', () => {
  try { return app.getVersion(); } catch { return 'unknown'; }
});
ipcMain.handle('app.openSettings', () => {
  try { createSettingsWindow(); return { ok: true }; } catch (e:any) { logger.error('[ipc] app.openSettings error', e); return { ok: false, error: e?.message || String(e) }; }
});
ipcMain.handle('app.checkForUpdates', async () => {
  try { await autoUpdater.checkForUpdates(); return { ok: true }; } catch (e:any) { logger.error('[ipc] checkForUpdates error', e); return { ok: false, error: e?.message || String(e) }; }
});
// Token storage IPC
ipcMain.handle('auth.saveToken', async (_e, { token }) => {
  try { const ok = await saveToken(token); return { ok }; } catch (e:any) { logger.error('[auth] saveToken error', e); return { ok: false, error: e?.message || String(e) }; }
});
ipcMain.handle('auth.getToken', async () => {
  try { const t = await getToken(); return { ok: true, token: t }; } catch (e:any) { logger.error('[auth] getToken error', e); return { ok: false, error: e?.message || String(e) }; }
});
ipcMain.handle('auth.clearToken', async () => {
  try { await clearToken(); return { ok: true }; } catch (e:any) { logger.error('[auth] clearToken error', e); return { ok: false, error: e?.message || String(e) }; }
});

ipcMain.handle('auth.getDeviceId', async () => {
  try { const id = getOrCreateDeviceId(); return { ok: true, deviceId: id }; } catch (e:any) { logger.error('[auth] getDeviceId error', e); return { ok: false, error: e?.message || String(e) }; }
});

// Validate token against auth API (uses AUTH_API_BASE env var)
ipcMain.handle('auth.validateToken', async (_e, { token }: { token?: string }) => {
  const MAX_RETRIES = 3;
  const BASE_URL = process.env.AUTH_API_BASE || 'https://2y8hntw0r3.execute-api.ap-northeast-1.amazonaws.com/prod';
  const timeoutMs = Number(process.env.AUTH_API_TIMEOUT_MS || 5000);
  try {
    const t = token || await getToken();
    if (!t) return { ok: false, code: 'NO_TOKEN' };
    const deviceId = getOrCreateDeviceId();
    const url = (BASE_URL.replace(/\/$/, '')) + '/auth/validate';

    // helper to perform fetch with timeout
    const doFetch = async () => {
      const ac = new AbortController();
      const id = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await (global as any).fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: deviceId, device_info: { name: app.getName(), hostname: app.getName() } }),
          signal: ac.signal
        });
        clearTimeout(id);
        const j = await res.json().catch(() => null);
        return { res, j };
      } catch (err:any) {
        clearTimeout(id);
        throw err;
      }
    };

    let attempt = 0;
    while (true) {
      try {
        attempt++;
        const { res, j } = await doFetch();
        if (!res.ok) {
          // 4xx -> do not retry
          if (res.status >= 400 && res.status < 500) {
            return { ok: false, status: res.status, body: j };
          }
          // 5xx -> may retry
          if (res.status >= 500) throw new Error(`server ${res.status}`);
        }
        // success
        const data = j && j.data ? j.data : j;
        return { ok: true, data };
      } catch (err:any) {
        logger.warn('[auth] validateToken attempt failed', attempt, err?.message || String(err));
        if (attempt >= MAX_RETRIES) {
          logger.error('[auth] validateToken: exhausted retries', err);
          return { ok: false, error: err?.message || String(err) };
        }
        // exponential backoff
        const backoff = 200 * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  } catch (err:any) {
    logger.error('[auth] validateToken error', err);
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('auth.getQuota', async () => {
  try {
    const resp = await (ipcMain as any).emit ? null : null; // placeholder
    // reuse validateToken handler to get current token state
    const out = await (exports as any).authValidate?.() || null;
    // Instead call validateToken IPC synchronously
    const r = await (async () => { return await (global as any).Promise.resolve(); })();
    // For simplicity, call the validateToken handler we just defined via ipcMain.handle directly
    const val = await (ipcMain as any).handlers && (ipcMain as any).handlers['auth.validateToken'] ? null : null;
    // Fallback: call validateToken by invoking via this process
    const v = await (exports as any).authValidate?.() .catch(()=>({}));
    return { ok: false, message: 'not implemented' };
  } catch (e:any) { logger.error('[auth] getQuota error', e); return { ok:false, error: e?.message || String(e) }; }
});
ipcMain.handle('app.exit', () => {
  try { isQuitting = true; app.quit(); return { ok: true }; } catch (e:any) { return { ok: false, error: e?.message || String(e) }; }
});
}

// Module-scope interactive update check used by menus/tray
async function checkForUpdatesInteractive() {
  try {
    const current = app.getVersion();
    const res = await autoUpdater.checkForUpdates();
    const remote = (res && (res as any).updateInfo && (res as any).updateInfo.version) ? (res as any).updateInfo.version : null;
    if (remote && remote !== current) {
      try { await dialog.showMessageBox({ message: `更新があります: ${remote}。ダウンロードを開始します。` }); } catch {}
    } else {
      try { await dialog.showMessageBox({ message: `既に最新バージョンです（${current}）。` }); } catch{}
    }
    return res;
  } catch (e:any) {
    logger.error('[update] interactive check failed', e);
    try { await dialog.showMessageBox({ type: 'error', message: `更新確認に失敗しました: ${e?.message || String(e)}` }); } catch {}
  }
}

app.whenReady().then(async () => {
  initDB();
  registerCustomProtocol();
  // Setup auto-updater (will check for updates once app is ready)
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.on('checking-for-update', () => logger.info('[auto-updater] checking for update'));
    autoUpdater.on('update-available', (info) => console.log('[auto-updater] update available', info));
    autoUpdater.on('update-not-available', (info) => console.log('[auto-updater] update not available', info));
    autoUpdater.on('update-available', (info) => logger.info('[auto-updater] update available', info));
    autoUpdater.on('update-not-available', (info) => logger.info('[auto-updater] update not available', info));
    autoUpdater.on('error', (err) => logger.error('[auto-updater] error', err));
    autoUpdater.on('download-progress', (progress) => logger.info('[auto-updater] progress', progress));
    autoUpdater.on('update-downloaded', (info) => {
      logger.info('[auto-updater] update downloaded', info);
      // quit and install automatically
      setTimeout(() => {
        try { autoUpdater.quitAndInstall(); } catch (e) { console.error('[auto-updater] quitAndInstall error', e); }
      }, 2000);
    });
    // trigger check
    setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch (e) { logger.error('[auto-updater] check error', e); } }, 3000);
  } catch (e) { console.error('[auto-updater] setup error', e); }
  await createMainWindow();
  try {
    const es = await import('./exportServer');
    // determine port/enabled from env or saved settings
    const cfg = loadConfig();
    const envPort = process.env.CONTAINER_EXPORT_PORT ? Number(process.env.CONTAINER_EXPORT_PORT) : null;
    const exportSettings = cfg.exportServer || getExportSettings();
    const shouldStart = !!envPort || !!exportSettings.enabled;
    const portToUse = envPort || Number(exportSettings.port || 3001);
    try {
      if (shouldStart) {
        const srv = es.startExportServer(Number(portToUse));
        // notify renderer of status
        try { mainWindow?.webContents.send('export.server.status', { running: true, port: Number(portToUse), error: null }); } catch {}
      } else {
        try { mainWindow?.webContents.send('export.server.status', { running: false, port: Number(portToUse), error: null }); } catch {}
      }
    } catch (e) {
      logger.error('[main] failed to start export server', e);
      try { mainWindow?.webContents.send('export.server.status', { running: false, port: Number(portToUse), error: String(e?.message || e) }); } catch {}
    }
  } catch (e) { logger.error('[main] failed to start export server', e); }

  // IPC: get/save export settings & status
  ipcMain.handle('export.getSettings', () => {
    try { return { ok: true, settings: getExportSettings() }; } catch (e:any) { return { ok: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('export.saveSettings', async (_e, payload: any) => {
    try {
      const ok = setExportSettings(payload || {});
      // If enabling, try to start the export server immediately (best-effort)
      try {
        const cfg = loadConfig();
        const s = cfg.exportServer || getExportSettings();
        if (s && s.enabled) {
          const es = await import('./exportServer');
          try {
            // start server on configured port
            const port = Number(s.port || 3001);
            es.startExportServer(Number(port));
            try { mainWindow?.webContents.send('export.server.status', { running: true, port: Number(port), error: null }); } catch {}
          } catch (e) {
            try { mainWindow?.webContents.send('export.server.status', { running: false, port: Number(s.port || 3001), error: String(e?.message || e) }); } catch {}
          }
        } else {
          try { mainWindow?.webContents.send('export.server.status', { running: false, port: Number(s?.port || 3001), error: null }); } catch {}
        }
      } catch (e) { /* ignore best-effort start errors */ }
      return { ok };
    } catch (e:any) { return { ok: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('export.getConfigPath', () => {
    try {
      const p = require('./settings').configPath();
      return { ok: true, path: p };
    } catch (e:any) { return { ok: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('export.getStatus', () => {
    try {
      // best-effort: check if server is listening by reading config + env
      const envPort2 = process.env.CONTAINER_EXPORT_PORT ? Number(process.env.CONTAINER_EXPORT_PORT) : null;
      const cur = loadConfig();
      const s = cur.exportServer || getExportSettings();
      const running = !!envPort2 || !!s.enabled;
      const port = envPort2 || Number(s.port || 3001);
      return { ok: true, running, port };
    } catch (e:any) { return { ok: false, error: e?.message || String(e) }; }
  });

  // Register F11 global shortcut to toggle DevTools for focused view/window
  try {
    globalShortcut.register('F11', () => {
      try {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        const windows = focusedWindow ? [focusedWindow] : BrowserWindow.getAllWindows();
        for (const w of windows) {
          try {
            const getViews = (w as any).getBrowserViews;
            const views = typeof getViews === 'function' ? (w as any).getBrowserViews() as any[] : [];
            const targetView = (views || []).find(v => v && v.webContents && typeof v.webContents.isFocused === 'function' && v.webContents.isFocused());
            if (targetView && targetView.webContents) {
              if (typeof targetView.webContents.isDevToolsOpened === 'function' && targetView.webContents.isDevToolsOpened()) {
                targetView.webContents.closeDevTools();
              } else {
                targetView.webContents.openDevTools({ mode: 'detach' });
              }
              return;
            }
          } catch (e) { /* ignore per-window errors */ }
        }
        const fw = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
        if (fw && fw.webContents) {
          if (typeof fw.webContents.isDevToolsOpened === 'function' && fw.webContents.isDevToolsOpened()) fw.webContents.closeDevTools();
          else fw.webContents.openDevTools({ mode: 'detach' });
        }
      } catch (e) { /* swallow */ }
    });
  } catch (e) { logger.error('[main] globalShortcut.register F11 error', e); }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createMainWindow();
  });
  handleArgv(process.argv);
});

// If app is launched externally with a container request, open the requested container(s).
// If the main window is not currently visible, keep it hidden (tray-minimized).
app.on('second-instance', (_event, argv) => {
  try {
    handleArgv(argv);
    try {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        } else {
          // keep main hidden when opened from external URL
          try { mainWindow.hide(); } catch {}
        }
      }
    } catch (e) { console.error('[main] second-instance window focus/hide error', e); }
  } catch (e) { console.error('[main] second-instance handleArgv error', e); }
});

// DevTools toggle handler (used by renderer via preload -> ipc)
ipcMain.handle('devtools.toggle', (_e) => {
  try {
    const all = BrowserWindow.getAllWindows();
    for (const w of all) {
      if (w.webContents && w.webContents.isDevToolsOpened && w.webContents.isDevToolsOpened()) {
        w.webContents.closeDevTools();
      } else {
        w.webContents.openDevTools({ mode: 'detach' });
      }
    }
    return true;
  } catch (e) { return false; }
});

// Toggle DevTools for the focused BrowserView (tab) if any; otherwise fall back to focused window
ipcMain.handle('devtools.toggleView', (_e) => {
  try {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const windows = focusedWindow ? [focusedWindow] : BrowserWindow.getAllWindows();
    for (const w of windows) {
      try {
        const getViews = (w as any).getBrowserViews;
        const views = typeof getViews === 'function' ? (w as any).getBrowserViews() as any[] : [];
        // Prefer the focused view
        const targetView = (views || []).find(v => v && v.webContents && typeof v.webContents.isFocused === 'function' && v.webContents.isFocused());
        if (targetView && targetView.webContents) {
          if (typeof targetView.webContents.isDevToolsOpened === 'function' && targetView.webContents.isDevToolsOpened()) {
            targetView.webContents.closeDevTools();
          } else {
            targetView.webContents.openDevTools({ mode: 'detach' });
          }
          return true;
        }
      } catch (e) { /* ignore view-level errors */ }
    }
    // fallback: toggle focused window's webContents
    const fw = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (fw && fw.webContents) {
      if (typeof fw.webContents.isDevToolsOpened === 'function' && fw.webContents.isDevToolsOpened()) fw.webContents.closeDevTools();
      else fw.webContents.openDevTools({ mode: 'detach' });
      return true;
    }
    return false;
  } catch (e) { return false; }
});

app.on('window-all-closed', () => {
  // Close all opened container windows when main window is closed, then quit.
  try {
    const cm = require('./containerManager');
    if (cm && cm.closeAllContainers) cm.closeAllContainers();
  } catch {}
  try { if (closeAllNonMainWindows) closeAllNonMainWindows(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});

// ensure before-quit also closes remaining container shells
app.on('before-quit', () => {
  try {
    if (closeAllContainers) closeAllContainers();
    if (closeAllNonMainWindows) closeAllNonMainWindows();
  } catch (e) { console.error('[main] before-quit close containers error', e); }
});

// fallback: force destroy non-main windows shortly after quit if any remain
app.on('will-quit', () => {
  try {
    const cm = require('./containerManager');
    if (cm && cm.forceCloseAllNonMainWindows) cm.forceCloseAllNonMainWindows();
  } catch (e) { console.error('[main] will-quit force close error', e); }
});

// === IPC（メインUI向け） ===
ipcMain.handle('containers.list', () => {
  console.log('[ipc] containers.list');
  return DB.listContainers();
});
ipcMain.handle('containers.setNote', (_e, { id, note }) => {
  try {
    console.log('[ipc] containers.setNote called', { id, note });
    const cur = DB.getContainer(id);
    if (!cur) {
      console.log('[ipc] containers.setNote: container not found', id);
      throw new Error('container not found');
    }
    DB.upsertContainer({ ...cur, note });
    console.log('[ipc] containers.setNote: success', { id });
    return { ok: true };
  } catch (e:any) {
    console.error('[ipc] containers.setNote error', e?.message || String(e));
    return { ok: false, error: e?.message || String(e) };
  }
});

// Receive logs from renderer for easier debugging in terminal
ipcMain.on('renderer.log', (_e, msg) => {
  try { logger.info('[renderer]', msg); } catch { console.log('[renderer]', msg); }
});
ipcMain.handle('containers.create', (_e, { name, ua, locale, timezone, proxy }) => {
  console.log('[ipc] containers.create', { name });
  const id = randomUUID();
  const fp: Fingerprint = {
    // ユーザ要望: Accept-Language 日本語固定 / timezone 日本時間固定
    // locale は ja-JP を既定（後で UI から変更可能）
    acceptLanguage: 'ja,en-US;q=0.8,en;q=0.7',
    locale: 'ja-JP',
    timezone: 'Asia/Tokyo',
    platform: 'Win32',
    hardwareConcurrency: [4, 6, 8, 12][Math.floor(Math.random()*4)],
    deviceMemory: [4, 6, 8, 12, 16][Math.floor(Math.random()*5)],
    canvasNoise: true,
    screenWidth: 2560,
    screenHeight: 1440,
    viewportWidth: 1280,
    viewportHeight: 800,
    colorDepth: 24,
    maxTouchPoints: 0,
    deviceScaleFactor: 1.0,
    cookieEnabled: true,
    connectionType: '4g',
    batteryLevel: 1,
    batteryCharging: true,
    fakeIp: undefined,
  };
  const c: Container = {
    id,
    name,
    userDataDir: path.join(app.getPath('userData'), 'profiles', id),
    partition: `persist:container-${id}`,
    userAgent: ua || undefined,
    locale: locale || 'ja-JP',
    timezone: timezone || 'Asia/Tokyo',
    fingerprint: fp,
    proxy: proxy || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastSessionId: null
  };
  DB.upsertContainer(c);
  return c;
});

ipcMain.handle('containers.open', async (_e, { id, url }) => {
  const c = DB.getContainer(id);
  if (!c) throw new Error('container not found');
  const win = await openContainerWindow(c, url);
  return !!win;
});
ipcMain.handle('tabs.navigate', async (_e, { containerId, url }) => {
  try {
    const cm = await import('./containerManager');
    // create a new tab and navigate
    return cm.createTab(containerId, url);
  } catch { return false; }
});
ipcMain.handle('tabs.create', async (_e, { containerId, url }) => {
  try { const cm = await import('./containerManager'); return cm.createTab(containerId, url); } catch { return false; }
});
ipcMain.handle('tabs.switch', async (_e, { containerId, index }) => {
  try { const cm = await import('./containerManager'); return cm.switchTab(containerId, index); } catch { return false; }
});
ipcMain.handle('tabs.close', async (_e, { containerId, index }) => {
  try { const cm = await import('./containerManager'); return cm.closeTab(containerId, index); } catch { return false; }
});
ipcMain.handle('tabs.back', async (_e, { containerId }) => {
  try { const cm = await import('./containerManager'); return cm.goBack(containerId); } catch { return false; }
});
ipcMain.handle('containers.openByName', async (_e, { name, url }) => {
  const c = DB.getContainerByName(name) || createContainerWithName(name);
  const win = await openContainerWindow(c, url);
  return !!win;
});
ipcMain.handle('containers.delete', async (_e, { id }) => {
  const c = DB.getContainer(id);
  if (!c) return false;
  try {
    const part = c.partition;
    const { session } = await import('electron');
    const ses = session.fromPartition(part, { cache: true });
    await ses.clearStorageData({});
  } catch {}
  DB.asyncDeleteContainer(id);
  return true;
});

ipcMain.handle('containers.update', async (_e, payload: Partial<Container> & { id: string }) => {
  console.log('[ipc] containers.update payload=', payload && { id: payload.id, proxy: (payload as any).proxy });
  const cur = DB.getContainer(payload.id);
  if (!cur) throw new Error('container not found');
  const next: Container = {
    ...cur,
    ...payload,
    fingerprint: payload.fingerprint ?? cur.fingerprint,
    updatedAt: Date.now(),
  } as Container;
  // handle proxy if provided
  if ((payload as any).proxy !== undefined) next.proxy = (payload as any).proxy;
  DB.upsertContainer(next);
  return next;
});

// proxy test endpoint: try to create a request via the proxy (basic TCP connect)
ipcMain.handle('proxy.test', async (_e, { proxy }) => {
  console.log('[ipc] proxy.test called, proxy=', proxy);
  // Enhanced proxy test: supports HTTP proxy (with CONNECT check) and SOCKS5 handshake
  try {
    if (!proxy || !proxy.server) return { ok: false, errorCode: 'no_proxy', error: 'no proxy' };
    const server = String(proxy.server).trim();
    const net = await import('node:net');

    // helper: parse host:port pair
    const parseHostPort = (s: string) => {
      // remove any scheme or leading "type=" prefix (e.g. "http=", "https=", "socks5=")
      let t = s.replace(/^\s+|\s+$/g, '');
      t = t.replace(/^[a-z0-9]+=/i, '');
      t = t.replace(/^.*:\/\//, '');
      const parts = t.split(':');
      const host = parts[0] || '';
      const port = parseInt(parts[1] || '0');
      return { host, port };
    };

    // detect SOCKS5 (prefix or scheme)
    if (/^socks5:\/\//i.test(server) || /^socks5=/i.test(server)) {
      // normalize to host:port
      const withoutScheme = server.replace(/^socks5:\/\//i, '').replace(/^socks5=/i, '');
      const { host, port } = parseHostPort(withoutScheme);
      if (!host || !port) return { ok: false, errorCode: 'invalid_format', error: 'invalid socks5 format' };

      return await new Promise((resolve) => {
        const sock = net.createConnection({ host, port }, async () => {
          try {
            // SOCKS5 greeting: no authentication
            sock.write(Buffer.from([0x05, 0x01, 0x00]));
            sock.once('data', (d: Buffer) => {
              if (d.length < 2 || d[0] !== 0x05) {
                sock.destroy();
                return resolve({ ok: false, errorCode: 'socks5_invalid_response', error: 'invalid socks5 greeting' });
              }
              const method = d[1];
              if (method !== 0x00) {
                sock.destroy();
                return resolve({ ok: false, errorCode: 'socks5_auth_required', error: 'socks5 requires auth', method });
              }
              // send CONNECT request to test remote reachability (use 1.1.1.1:443 as target)
              const addr = Buffer.from([0x01, 1,1,1,1]);
              const portBuf = Buffer.alloc(2);
              portBuf.writeUInt16BE(443, 0);
              const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]);
              sock.write(req);
              sock.once('data', (resp: Buffer) => {
                // resp[1] == 0x00 means succeeded
                const status = resp && resp.length >= 2 ? resp[1] : undefined;
                sock.end();
                if (status === 0x00) return resolve({ ok: true, protocol: 'socks5', host, port });
                else return resolve({ ok: false, errorCode: 'socks5_connect_failed', error: 'socks5 connect failed', status });
              });
            });
          } catch (err:any) {
            sock.destroy();
            return resolve({ ok: false, errorCode: 'socks5_error', error: err?.message || String(err) });
          }
        });
        sock.on('error', (err) => resolve({ ok: false, errorCode: 'connect_error', error: err?.message || String(err) }));
        setTimeout(() => { try { sock.destroy(); } catch {} ; resolve({ ok: false, errorCode: 'timeout', error: 'timeout' }); }, 7000);
      });
    }

    // HTTP-style proxy rule: could be 'http=host:port;https=host:port' or plain 'host:port' (normalized earlier)
    // Pick first host:port we can find
    let candidate = server;
    // if rules like 'http=host:port;https=host:port', prefer https= then http=
    const httpsMatch = server.match(/https=([^;]+)/i);
    const httpMatch = server.match(/http=([^;]+)/i);
    if (httpsMatch) candidate = httpsMatch[1];
    else if (httpMatch) candidate = httpMatch[1];
    // if still contains '=', fallback to after '='
    if (candidate.includes('=')) candidate = candidate.split('=')[1] || candidate;

    const { host: phost, port: pport } = parseHostPort(candidate);
    if (!phost || !pport) return { ok: false, errorCode: 'invalid_format', error: 'invalid proxy format' };

    // TCP connect first
    return await new Promise((resolve) => {
      const s = net.createConnection({ host: phost, port: pport }, () => {
        // attempt HTTP CONNECT to example.com:443 to verify tunnel
        try {
          const connectReq = `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n`;
          s.write(connectReq);
          let acc = '';
          const onData = (d: Buffer) => {
            acc += d.toString('utf8');
            // check for status line
            const m = acc.match(/^HTTP\/\d\.\d\s+(\d{3})/m);
            if (m) {
              const status = parseInt(m[1], 10);
              s.end();
              if (status >= 200 && status < 300) return resolve({ ok: true, protocol: 'http', host: phost, port: pport, httpStatus: status });
              return resolve({ ok: false, errorCode: 'http_tunnel_failed', error: `tunnel status ${status}`, httpStatus: status });
            }
            // simple safety: if headers exceed 8kb, bail
            if (acc.length > 8192) { s.end(); return resolve({ ok: false, errorCode: 'http_no_status', error: 'no http status in response' }); }
          };
          s.on('data', onData);
          s.on('error', (err) => { try { s.destroy(); } catch {} ; resolve({ ok: false, errorCode: 'connect_error', error: err?.message || String(err) }); });
          setTimeout(() => { try { s.destroy(); } catch {} ; resolve({ ok: false, errorCode: 'timeout', error: 'timeout' }); }, 7000);
        } catch (err:any) { try { s.destroy(); } catch {} ; resolve({ ok: false, errorCode: 'write_error', error: err?.message || String(err) }); }
      });
      s.on('error', (err) => resolve({ ok: false, errorCode: 'connect_error', error: err?.message || String(err) }));
    });
  } catch (e:any) {
    return { ok: false, errorCode: 'unknown', error: e?.message || String(e) };
  }
});

// Bookmarks IPC handlers are defined in src/main/ipc.ts to avoid duplicate registration

// === CLI / Custom Protocol ===
function createContainerWithName(name: string): Container {
  const id = randomUUID();
  const fp = {
    acceptLanguage: 'ja,en-US;q=0.8,en;q=0.7',
    locale: 'ja-JP',
    timezone: 'Asia/Tokyo',
    platform: 'Win32',
    hardwareConcurrency: [4,6,8,12][Math.floor(Math.random()*4)],
    deviceMemory: [4,6,8,12,16][Math.floor(Math.random()*5)],
    canvasNoise: true,
  } satisfies Fingerprint;
  const c: Container = {
    id,
    name,
    userDataDir: path.join(app.getPath('userData'), 'profiles', id),
    partition: `persist:container-${id}`,
    userAgent: undefined,
    locale: 'ja-JP',
    timezone: 'Asia/Tokyo',
    fingerprint: fp,
    proxy: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastSessionId: null
  };
  DB.upsertContainer(c);
  return c;
}

function handleArgv(argv: string[]) {
  try {
    const link = argv.find(a => a.startsWith('mycontainers://'));
    if (!link) return;
    const u = new URL(link);
    const name = u.searchParams.get('name') || u.hostname || '';
    const openUrl = u.searchParams.get('url') || undefined;
    if (!name) return;
    if (_pendingOpenNames.has(name)) {
      console.log('[main] handleArgv: duplicate open suppressed for', name);
      return;
    }
    _pendingOpenNames.add(name);
    setTimeout(() => _pendingOpenNames.delete(name), 1500);
    const c = DB.getContainerByName(name) || createContainerWithName(name);
    openContainerWindow(c, openUrl);
  } catch {}
}

// Windows: 二重起動時のプロトコル引数
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    handleArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
