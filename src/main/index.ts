import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron';
import { autoUpdater } from 'electron-updater';
import { initAutoUpdate, checkForUpdatesManually } from './autoUpdate';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { initDB, DB } from './db';
import { openContainerWindow, closeAllContainers, closeAllNonMainWindows, forceCloseAllNonMainWindows } from './containerManager';
import './ipc';
import { registerCustomProtocol } from './protocol';
import { randomUUID } from 'node:crypto';
import type { Container, Fingerprint } from '../shared/types';
import logger from '../shared/logger';

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
  // 表示タイトルにアプリ名とバージョンを付与
  try {
    const title = `${app.getName()} v${app.getVersion()}`;
    try { mainWindow.setTitle(title); } catch {}
    logger.info('[main] window title set to', title);
  } catch (e) { logger.error('[main] failed to set window title version', e); }
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
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show', click: () => { try { mainWindow?.show(); } catch {} } },
      { label: 'Exit', click: () => { isQuitting = true; app.quit(); } }
    ]);
    try { tray.setToolTip('Container Browser'); tray.setContextMenu(contextMenu); tray.on('double-click', () => { try { mainWindow?.show(); } catch {} }); } catch (e) { logger.error('[main] tray setup error', e); }
  } catch (e) { logger.error('[main] failed to create tray', e); }
}

app.whenReady().then(async () => {
  initDB();
  registerCustomProtocol();
  // ensure native modules downloaded before creating windows
  try {
    const nm = await import('./nativeModules');
    void nm.ensureNativeModules();
  } catch (e) { logger.warn('[main] ensureNativeModules failed', e); }
  // Setup auto-updater via dedicated module (will check for updates once app is ready)
  try {
    // initialize our auto-update wiring after mainWindow is created
    // (initAutoUpdate will return early in dev / if already wired)
  } catch (e) { console.error('[auto-updater] setup error', e); }
  await createMainWindow();
  // initialize auto-update with the created mainWindow
  try { if (mainWindow) initAutoUpdate(mainWindow); } catch (e) { console.error('[auto-updater] init error', e); }
  // Ensure application menu includes a Help -> Check for Updates entry
  try {
    const menuTemplate: any[] = [
      { label: 'File', submenu: [{ role: 'quit', label: '終了' }] },
      { label: 'View', submenu: [{ role: 'reload', label: '再読み込み' }, { role: 'toggleDevTools', label: '開発者ツール' }] },
      { label: 'Help', submenu: [
        {
          label: 'アップデートを確認…',
          click: async (_menuItem, browserWindow) => {
            try {
              const win = (browserWindow ?? mainWindow) as BrowserWindow | null;
              if (!win) return;
              await checkForUpdatesManually(win);
            } catch (e) { console.error('[menu] check-for-updates click error', e); }
          }
        }
      ] }
    ];
    const appMenu = Menu.buildFromTemplate(menuTemplate as any);
    Menu.setApplicationMenu(appMenu);
  } catch (e) { console.error('[main] set application menu error', e); }

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
import { ipcMain } from 'electron';
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

// IPC handler to trigger manual update check from renderer
ipcMain.handle('app/check-for-updates', async () => {
  try {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
    if (!win) return;
    await checkForUpdatesManually(win);
  } catch (e) { console.error('[ipc] check-for-updates error', e); }
});

ipcMain.handle('app/get-name', async () => {
  try { return app.getName(); } catch { return 'Container Browser'; }
});
ipcMain.handle('app/get-version', async () => {
  try { return app.getVersion(); } catch { return '0.0.0'; }
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
  try {
    if (!proxy || !proxy.server) return { ok: false, error: 'no proxy' };
    // simple TCP connect test to host:port
    const [hostPart, portPart] = (proxy.server.replace(/^https?:\/\//, '')).split(':');
    const port = parseInt(portPart || '0');
    if (!hostPart || !port) return { ok: false, error: 'invalid proxy format' };
    const net = await import('node:net');
    await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: hostPart, port }, () => { s.end(); resolve(void 0); });
      s.on('error', (err) => { reject(err); });
      setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, 5000);
    });
    return { ok: true };
  } catch (e:any) {
    return { ok: false, error: e?.message || String(e) };
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
