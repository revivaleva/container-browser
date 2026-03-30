import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut, session, dialog, shell, net } from 'electron';






if (app) {
  app.on('will-finish-launching', () => {
    try {
      if (app.commandLine) {
        app.commandLine.appendSwitch('disable-renderer-backgrounding');
        app.commandLine.appendSwitch('disable-background-timer-throttling');
        app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
        // Limit global cache size to prevent disk bloat (100MB disk, 50MB media)
        app.commandLine.appendSwitch('disk-cache-size', '104857600');
        app.commandLine.appendSwitch('media-cache-size', '52428800');
      }
    } catch (e) { console.error('[main] Failed to set commandLine switches', e); }
  });
}




import { autoUpdater } from 'electron-updater';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { initDB, DB } from './db';
import { openContainerWindow, closeContainer, isContainerOpen, closeAllContainers, closeAllNonMainWindows, forceCloseAllNonMainWindows, cleanupOrphans, deleteContainerStorage, registerContainerIpcHandlers, syncKameleoProfiles } from './containerManager';

import { registerGeneralIpcHandlers } from './ipc';
import { loadConfig, getExportSettings, setExportSettings, getAuthApiBase, getAuthTimeoutMs, getAuthSettings, setAuthSettings, getGraphicsSettings, setGraphicsSettings } from './settings';
import { registerCustomProtocol } from './protocol';
import { randomUUID } from 'node:crypto';
import type { Container, Fingerprint } from '../shared/types';
import logger from '../shared/logger';
import { saveToken, getToken, clearToken, getOrCreateDeviceId } from './tokenStore';
import { proxyCredentialsByPartition, proxyCredentialsByHostPort } from './containerState';

// Log filtering disabled for debugging


// Proxy認証情報の管理 moved to containerState.ts

// グローバルな未処理例外ハンドラー: ERR_TUNNEL_CONNECTION_FAILED エラーを無視（エラーダイアログを表示しない）
process.on('uncaughtException', (error: Error) => {
  const errorMsg = error.message || String(error);
  if (errorMsg.includes('ERR_TUNNEL_CONNECTION_FAILED')) {
    // プロキシ接続エラーは診断機能の失敗であり、コンテナの動作に影響しないため無視
    return;
  }
  // その他のエラーは通常通り処理（ログ出力のみ、エラーダイアログは表示しない）
  console.error('[main] uncaughtException (non-fatal)', error);
});

process.on('unhandledRejection', (reason: any) => {
  const errorMsg = reason instanceof Error ? reason.message : String(reason);
  if (errorMsg.includes('ERR_TUNNEL_CONNECTION_FAILED')) {
    // プロキシ接続エラーは診断機能の失敗であり、コンテナの動作に影響しないため無視
    return;
  }
  // その他のエラーは通常通り処理（ログ出力のみ、エラーダイアログは表示しない）
  console.error('[main] unhandledRejection (non-fatal)', reason);
});

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
            if (parentTitle) try { devWin.setTitle(`Dev-${parentTitle}`); } catch { }
            // set a common icon if available
            try {
              const icoPath = path.join(app.getAppPath(), 'build-resources', 'Icon.ico');
              if (existsSync(icoPath)) devWin.setIcon(icoPath as any);
            } catch { }
          } catch { }
        }
      } catch { }
    }, 200);
  } catch { }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

let isQuitting = false;
// prevent duplicate container opens from rapid repeated handleArgv calls
const _pendingOpenNames = new Set<string>();

async function createMainWindow() {
  try {
    console.log('[DEBUG] process.versions', process.versions);
    console.log('[DEBUG] createMainWindow() started');
    const preloadPath = path.join(app.getAppPath(), 'out', 'preload', 'mainPreload.cjs');
    console.log('[DEBUG] Preload path:', preloadPath, 'exists=', existsSync(preloadPath));
    logger.debug('[main] main preload:', preloadPath, 'exists=', existsSync(preloadPath));

    console.log('[DEBUG] Creating BrowserWindow...');
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
      mainWindow?.on('close', (e) => {
        if (isQuitting) return;
        try {
          e.preventDefault();
          logger.info('[main] mainWindow close event triggered -> hiding to tray');
          try { if (closeAllContainers) closeAllContainers(); } catch (err) { console.error('[main] closeAllContainers error', err); }
          try { if (closeAllNonMainWindows) closeAllNonMainWindows(); } catch (err) { console.error('[main] closeAllNonMainWindows error', err); }
          try { mainWindow?.hide(); } catch (err) { console.error('[main] hide mainWindow error', err); }
          // ensure force destroy shortly after
          setTimeout(() => { try { if (forceCloseAllNonMainWindows) forceCloseAllNonMainWindows(); } catch (e) { } }, 250);
        } catch (e) { console.error('[main] error in mainWindow.close handler', e); }
      });
    } catch (e) { console.error('[main] failed to attach mainWindow close handler', e); }

    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl) {
      const maxAttempts = 40;
      let attempt = 0;
      const tryUrl = async (u: string) => {
        try {
          const parsed = new URL(u);
          const mod = parsed.protocol === 'https:' ? require('https') : require('http');
          return await new Promise((resolve) => {
            const req = mod.request({ method: 'HEAD', hostname: parsed.hostname, port: parsed.port, path: parsed.pathname || '/', timeout: 1000 }, (res: any) => {
              resolve(res.statusCode && res.statusCode >= 200 && res.statusCode < 500);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
          });
        } catch (e) { return false; }
      };

      const candidates = [devUrl];
      try {
        const parsed = new URL(devUrl);
        if (parsed.hostname === 'localhost') {
          candidates.push(`${parsed.protocol}//127.0.0.1:${parsed.port}${parsed.pathname || ''}`);
        }
      } catch (e) { }

      let loaded = false;
      while (attempt < maxAttempts && !loaded) {
        attempt++;
        for (const c of candidates) {
          if (await tryUrl(c).catch(() => false)) {
            if (mainWindow) {
              try {
                await mainWindow.loadURL(c);
                mainWindow.show();
                mainWindow.focus();
                loaded = true;
                break;
              } catch { }
            }
          }
        }
        if (!loaded) await new Promise(r => setTimeout(r, 250));
      }
      if (!loaded && mainWindow) {
        const url = new URL('file://' + path.join(app.getAppPath(), 'out', 'renderer', 'index.html'));
        await mainWindow.loadURL(url.toString());
      }
    } else if (mainWindow) {
      const url = new URL('file://' + path.join(app.getAppPath(), 'out', 'renderer', 'index.html'));
      await mainWindow.loadURL(url.toString());
    }

    // create tray icon and menu (robust lookup for packaged/app resources)
    try {
      const candidates = ['icon.ico', 'Icon.ico', 'icon.png', 'Icon.png'];
      let chosenPath: string | null = null;
      const bases = [path.join(app.getAppPath(), 'build-resources')];
      try { if (process && (process as any).resourcesPath) bases.push(path.join((process as any).resourcesPath, 'build-resources')); } catch { }
      for (const base of bases) {
        for (const n of candidates) {
          const p = path.join(base, n);
          try { if (existsSync(p)) { chosenPath = p; break; } } catch { }
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
            try { img = img.resize({ width: 16, height: 16 }); } catch { }
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
        { label: 'Show', click: () => { try { mainWindow?.show(); } catch { } } },
        { type: 'separator' },
        { label: 'Exit', click: () => { isQuitting = true; app.quit(); } }
      ]);
      try { tray?.setToolTip('Container Browser'); tray?.setContextMenu(contextMenu); tray?.on('double-click', () => { try { mainWindow?.show(); } catch { } }); } catch (e) { logger.error('[main] tray setup error', e); }
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
            { label: 'Check for updates (disabled)', enabled: false, click: () => { /* disabled */ } },
            { label: 'Show version', click: () => { try { dialog.showMessageBox({ message: `Version: ${app.getVersion()}` }); } catch (e) { logger.error('[menu] showVersion error', e); } } }
          ]
        }
      ];
      const appMenu = Menu.buildFromTemplate(appMenuTemplate as any);
      Menu.setApplicationMenu(appMenu);
      console.log('[DEBUG] Application menu set successfully');
    } catch (e) {
      console.error('[main] failed to set application menu', e);
      logger.error('[main] failed to set application menu', e);
    }

    console.log('[DEBUG] createMainWindow() completed successfully');

    // Register mainWindow with container manager to prevent accidental app quit
    try {
      const cm = await import('./containerManager');
      if (mainWindow && cm.setMainWindow) {
        cm.setMainWindow(mainWindow);
      }
    } catch (e) {
      logger.error('[main] failed to register mainWindow with containerManager', e);
    }
  } catch (error) {
    console.error('[FATAL] createMainWindow() failed:', error);
    logger.error('[FATAL] createMainWindow() failed:', error);
    throw error;
  }
}

// --- Module-scope Helpers & Settings ---

// Create a separate Settings window that loads the renderer with ?settings=1
function createSettingsWindow() {
  try {
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    // In dev mode the renderer dev server root is provided in devUrl.
    // Use the root (or index) and append ?settings=1 so the renderer shows the Settings-only UI.
    let url: string;
    if (devUrl) {
      url = `${devUrl.slice(-1) === '/' ? devUrl : devUrl + '/'}/?settings=1`;
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
    win.loadURL(url).catch(() => { });
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

// Consume quota from token via auth API
async function callAuthUse(token: string, deviceId: string, count: number = 1): Promise<{ ok: boolean; data?: any; status?: number; body?: any; error?: string }> {
  const MAX_RETRIES = 3;
  const BASE_URL = getAuthApiBase();
  const timeoutMs = getAuthTimeoutMs();

  const doFetch = async () => {
    const ac = new AbortController();
    const id = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await (global as any).fetch(
        (BASE_URL.replace(/\/$/, '')) + '/auth/use',
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: deviceId, count }),
          signal: ac.signal
        }
      );
      clearTimeout(id);
      const j = await res.json().catch(() => null);
      return { res, j };
    } catch (err: any) {
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
        if (res.status >= 400 && res.status < 500) {
          return { ok: false, status: res.status, body: j };
        }
        if (res.status >= 500) throw new Error(`server ${res.status}`);
      }
      const data = j && j.data ? j.data : j;
      return { ok: true, data };
    } catch (err: any) {
      logger.warn('[auth] use attempt failed', attempt, err?.message || String(err));
      if (attempt >= MAX_RETRIES) {
        logger.error('[auth] use: exhausted retries', err);
        return { ok: false, error: err?.message || String(err) };
      }
      const backoff = 200 * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
}


// Module-scope interactive update check used by menus/tray
async function checkForUpdatesInteractive() {
  try {
    const current = app.getVersion();
    const res = await autoUpdater.checkForUpdates();
    const remote = (res && (res as any).updateInfo && (res as any).updateInfo.version) ? (res as any).updateInfo.version : null;
    if (remote && remote !== current) {
      try { await dialog.showMessageBox({ message: `更新があります: ${remote}。ダウンロードを開始します。` }); } catch { }
    } else {
      try { await dialog.showMessageBox({ message: `既に最新バージョンです（${current}）。` }); } catch { }
    }
    return res;
  } catch (e: any) {
    logger.error('[update] interactive check failed', e);
    try { await dialog.showMessageBox({ type: 'error', message: `更新確認に失敗しました: ${e?.message || String(e)}` }); } catch { }
  }
}

// グラフィクス/HWアクセラレーション設定（Xログイン問題の切り分け用）

// 環境変数 > 設定ファイル > デフォルト の優先順位
// 設定変更後はアプリ再起動が必要。
const graphicsSettings = getGraphicsSettings();
const GRAPHICS_MODE = process.env.GRAPHICS_MODE || graphicsSettings.graphicsMode || 'auto';
const ANGLE_MODE = process.env.ANGLE_MODE || graphicsSettings.angleMode || 'default';
const DISABLE_HTTP2 = process.env.DISABLE_HTTP2 === '1' || graphicsSettings.disableHttp2 === true;
const DISABLE_QUIC = process.env.DISABLE_QUIC === '1' || graphicsSettings.disableQuic === true;
const DEBUG_GPU = process.env.DEBUG_GPU === '1' || graphicsSettings.debugGpu === true;

if (app) {
  if (GRAPHICS_MODE === 'disable') {
    app.disableHardwareAcceleration();
    if (DEBUG_GPU) console.log('[gpu] Hardware acceleration disabled via GRAPHICS_MODE=disable');
  }
  if (ANGLE_MODE !== 'default') {
    app.commandLine.appendSwitch('use-angle', ANGLE_MODE);
    if (DEBUG_GPU) console.log('[gpu] ANGLE backend set to:', ANGLE_MODE);
  }
  if (DISABLE_HTTP2) {
    app.commandLine.appendSwitch('disable-http2');
    if (DEBUG_GPU) console.log('[gpu] HTTP/2 disabled via DISABLE_HTTP2=1');
  }
  if (DISABLE_QUIC) {
    app.commandLine.appendSwitch('disable-quic');
    if (DEBUG_GPU) console.log('[net] quic', { disableQuic: true });
  }
}


// WebRTC非プロキシUDP禁止を全てのBrowserWindow/BrowserViewに適用（window.open/popup対策）
if (app) {
  app.on('browser-window-created', (_event, win) => {
    try {
      if (win && win.webContents) {
        win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
        console.log('[main] setWebRTCIPHandlingPolicy applied via browser-window-created');
      }
    } catch (e) {
      console.error('[main] failed to setWebRTCIPHandlingPolicy in browser-window-created', e);
    }
  });
}


// Register global login handler for proxy authentication (唯一の正)
// process全体で1回だけ登録され、partition -> credentials Mapから認証情報を取得
// This must be registered before app.whenReady() to catch all login events
if (app && !(global as any)._appLoginHandlerRegistered) {
  (global as any)._appLoginHandlerRegistered = true;
  console.log('[DEBUG] Registering app.on(login). app type:', typeof app, 'has on:', typeof app?.on);
  app.on('login', (event, webContents, request, authInfo, callback) => {


    // プロキシ以外の認証はスルー（詳細ログは出さない）
    if (!authInfo.isProxy) {
      return;
    }

    // プロキシ認証の場合のみ処理
    event.preventDefault();

    // 詳細ログ: warmup中に認証イベントが発火しているかを確認
    const loginLogData: any = {
      isProxy: authInfo.isProxy,
      host: authInfo.host,
      port: authInfo.port,
      scheme: authInfo.scheme,
      webContentsId: webContents?.id ?? null,
      requestUrl: request?.url ?? null
    };

    // webContentsからpartitionを取得し、Mapから認証情報を取得
    try {
      let partition: string | undefined;
      let creds: { username: string; password: string } | undefined;

      // 方法0（最優先）: host:portキーでlookup（warmup中も確実に動作）
      if (authInfo.host && authInfo.port) {
        const hostPort = `${authInfo.host}:${authInfo.port}`;
        loginLogData.hostPortLookup = hostPort;
        creds = proxyCredentialsByHostPort.get(hostPort);
        if (creds) {
          loginLogData.credentialsSource = 'hostPort';
        }
      }

      // 方法1: webContents._containerId から逆引き（フォールバック）
      if (!creds) {
        const containerId: string | undefined = webContents ? (webContents as any)._containerId : undefined;
        if (containerId) {
          loginLogData.containerId = containerId;
          try {
            const container = DB.getContainer(containerId);
            if (container && container.partition) {
              partition = container.partition;
              loginLogData.partition = partition;
              creds = proxyCredentialsByPartition.get(partition);
              if (creds) {
                loginLogData.credentialsSource = 'partition';
              }
            }
          } catch (e) {
            loginLogData.getContainerError = e instanceof Error ? e.message : String(e);
          }
        }
      }

      // 方法2: getWebPreferences() が利用可能な場合（フォールバック）
      if (!creds && webContents) {
        try {
          // @ts-ignore
          partition = typeof webContents.getWebPreferences === 'function' ? webContents.getWebPreferences()?.partition : undefined;
          if (partition) {
            loginLogData.partition = partition;
            creds = proxyCredentialsByPartition.get(partition);
            if (creds) {
              loginLogData.credentialsSource = 'partition';
            }
          }
        } catch (e) {
          // getWebPreferences() がエラーを投げる場合もあるので無視
        }
      }

      // 方法3: webContents.session から取得（フォールバック）
      if (!creds && webContents?.session) {
        const sessionPartition = (webContents.session as any).partition;
        if (typeof sessionPartition === 'string') {
          partition = sessionPartition;
          loginLogData.partition = partition;
          creds = proxyCredentialsByPartition.get(partition);
          if (creds) {
            loginLogData.credentialsSource = 'partition';
          }
        }
      }

      // 認証情報が見つかった場合
      if (creds) {
        loginLogData.credentialsProvided = true;
        loginLogData.hasUsername = !!creds.username;
        loginLogData.hasPassword = !!creds.password;
        // パスワードはログに出力しない（マスク）
        // warmup中のlogin発火を可視化するため、詳細ログを出力
        console.log('[login] Proxy authentication - credentials provided', {
          requestUrl: loginLogData.requestUrl,
          host: loginLogData.host,
          port: loginLogData.port,
          credentialsSource: loginLogData.credentialsSource,
          credentialsProvided: true,
          hasUsername: loginLogData.hasUsername,
          hasPassword: loginLogData.hasPassword,
          webContentsId: loginLogData.webContentsId,
          containerId: loginLogData.containerId
        });
        callback(creds.username, creds.password);
        return;
      }

      // 認証情報が見つからなかった場合
      loginLogData.credentialsProvided = false;
      loginLogData.availablePartitions = Array.from(proxyCredentialsByPartition.keys());
      loginLogData.availableHostPorts = Array.from(proxyCredentialsByHostPort.keys());
      // warmup中のlogin発火を可視化するため、詳細ログを出力
      console.warn('[login] Proxy authentication - NO credentials found', {
        requestUrl: loginLogData.requestUrl,
        host: loginLogData.host,
        port: loginLogData.port,
        credentialsSource: loginLogData.credentialsSource || 'none',
        credentialsProvided: false,
        webContentsId: loginLogData.webContentsId,
        containerId: loginLogData.containerId,
        availablePartitions: loginLogData.availablePartitions.length,
        availableHostPorts: loginLogData.availableHostPorts.length
      });

    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error('[login] Proxy authentication - ERROR getting credentials', {
        ...loginLogData,
        error: errorMsg
      });
    }
  });
}

async function createContainerWithName(name: string): Promise<Container> {
  let kameleoProfileId: string;
  let kameleoEnv: any;
  try {
    const { KameleoApi } = await import('./kameleoApi');
    const p = await KameleoApi.createProfile({
      name: name,
      tags: ['container-browser'],
      deviceType: 'desktop',
      os: 'windows',
      browser: 'chrome',
      storage: 'cloud',
      language: 'ja-JP'
    });
    kameleoProfileId = p.id;
    kameleoEnv = {
      deviceType: p.device?.deviceType,
      os: p.device?.platform,
      browser: p.device?.browser
    };
  } catch (e) {
    throw new Error('Kameleo profile creation failed: ' + (e as any).message);
  }

  const id = kameleoProfileId; // Use Kameleo ID as local ID
  const c: Container = {
    id,
    name,
    userDataDir: path.join(app.getPath('userData'), 'profiles', id),
    partition: `persist:container-${id}`,
    userAgent: undefined,
    locale: 'ja-JP',
    timezone: 'Asia/Tokyo',
    proxy: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastSessionId: null,
    kameleoProfileId,
    profileMode: 'attached',
    kameleoEnv
  };
  DB.upsertContainer(c);
  return c;
}

async function handleArgv(argv: string[]) {
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
    const c = DB.getContainerByName(name) || await createContainerWithName(name);
    openContainerWindow(c, openUrl);
  } catch { }
}

if (app && !(global as any)._appReadyRegistered) {
  (global as any)._appReadyRegistered = true;
  app.whenReady().then(async () => {


    // Register container IPC handlers after app is ready to avoid module initialization issues
    registerContainerIpcHandlers();
    registerGeneralIpcHandlers();
    registerMainIpcHandlers();

    // --- データベース初期化 ---
    console.log('[DEBUG] Initializing database...');
    initDB();
    console.log('[DEBUG] Database initialized');

    // 起動時に不要なフォルダ（削除済みコンテナの残りカスや古いバックアップ）をクリーンアップ
    cleanupOrphans().catch(err => console.error('[main] cleanupOrphans failed', err));

    // 起動時にKameleoプロファイルを強制同期
    syncKameleoProfiles().then(res => {
      console.log('[main] Startup Kameleo sync result:', res);
    }).catch(err => {
      console.error('[main] Startup Kameleo sync failed', err);
    });

    // 連続稼働時、24時間ごとに自動削除を実行するように設定
    setInterval(() => {
      console.log('[main] Running scheduled daily orphan cleanup...');
      cleanupOrphans().catch(err => console.error('[main] Scheduled cleanupOrphans failed', err));
    }, 24 * 60 * 60 * 1000); // 24時間間隔

    // --- UserAgent のクリーニング (Stealth 対策) ---
    // Electron や container-browser 固有の文字列が含まれると bot 判定されるため除去
    if (app.userAgentFallback) {
      app.userAgentFallback = app.userAgentFallback
        .replace(/container-browser(-for-kameleo)?\/[0-9\.]+ /g, '')
        .replace(/Electron\/[0-9\.]+ /g, '');
    } else {
      app.userAgentFallback = session.defaultSession.getUserAgent()
        .replace(/container-browser(-for-kameleo)?\/[0-9\.]+ /g, '')
        .replace(/Electron\/[0-9\.]+ /g, '');
    }

    try {
      console.log('[DEBUG] App ready event triggered');
      logger.info('[DEBUG] App ready event triggered (Cleaned UA: ' + app.userAgentFallback + ')');

      // GPU診断ログ（DEBUG_GPU=1 の時のみ詳細に出力）
      if (DEBUG_GPU) {
        try {
          console.log('[gpu] settings', {
            GRAPHICS_MODE,
            ANGLE_MODE,
            DISABLE_HTTP2,
            DISABLE_QUIC,
            DEBUG_GPU: true
          });

          const featureStatus = app.getGPUFeatureStatus();
          console.log('[gpu] featureStatus', JSON.stringify(featureStatus, null, 2));

          const gpuInfo: any = await app.getGPUInfo('basic');
          // 必要最小限の項目だけ抽出（大きなオブジェクトなので）
          const gpuInfoSummary = {
            vendorId: gpuInfo.auxAttributes?.vendorId,
            deviceId: gpuInfo.auxAttributes?.deviceId,
            vendorString: gpuInfo.auxAttributes?.vendorString,
            deviceString: gpuInfo.auxAttributes?.deviceString,
            driverVersion: gpuInfo.auxAttributes?.driverVersion,
            driverDate: gpuInfo.auxAttributes?.driverDate,
            glVersion: gpuInfo.auxAttributes?.glVersion,
            glVendor: gpuInfo.auxAttributes?.glRenderer,
            glRenderer: gpuInfo.auxAttributes?.glRenderer
          };
          console.log('[gpu] gpuInfo.basic (summary)', JSON.stringify(gpuInfoSummary, null, 2));
        } catch (e) {
          console.error('[gpu] failed to get GPU info', e);
        }
      }



      console.log('[DEBUG] Registering custom protocol...');
      registerCustomProtocol();
      console.log('[DEBUG] Custom protocol registered');

      // Setup auto-updater (will check for updates once app is ready)
      // アップデート機能を一時的に無効化（サーバー問題回避）
      const ENABLE_AUTO_UPDATE = false;

      if (ENABLE_AUTO_UPDATE) {
        try {
          console.log('[DEBUG] Setting up auto-updater...');
          autoUpdater.autoDownload = true;
          autoUpdater.autoInstallOnAppQuit = false; // 手動でインストールタイミングを制御
          autoUpdater.on('checking-for-update', () => logger.info('[auto-updater] checking for update'));
          autoUpdater.on('update-available', (info) => console.log('[auto-updater] update available', info));
          autoUpdater.on('update-not-available', (info) => console.log('[auto-updater] update not available', info));
          autoUpdater.on('update-available', (info) => logger.info('[auto-updater] update available', info));
          autoUpdater.on('update-not-available', (info) => logger.info('[auto-updater] update not available', info));
          autoUpdater.on('error', (err) => {
            logger.error('[auto-updater] error', err);
            console.log('[auto-updater] Update check failed:', err.message);
            // ネットワークエラーやサーバーエラーの場合は静かに失敗
            if (err.message && (
              err.message.includes('403') ||
              err.message.includes('Forbidden') ||
              err.message.includes('ENOTFOUND') ||
              err.message.includes('net::ERR_')
            )) {
              console.log('[auto-updater] Network/server error detected, skipping update check');
            }
          });
          autoUpdater.on('download-progress', (progress) => logger.info('[auto-updater] progress', progress));
          autoUpdater.on('update-downloaded', (info) => {
            logger.info('[auto-updater] update downloaded', info);
            console.log('[auto-updater] Update downloaded, preparing to install...');

            // 適切なプロセス終了処理を実行してからインストール
            setTimeout(async () => {
              try {
                console.log('[auto-updater] Starting graceful shutdown for update...');

                // 1. すべてのコンテナウィンドウを閉じる
                try {
                  console.log('[auto-updater] Closing all containers...');
                  if (closeAllContainers) closeAllContainers();
                  await new Promise(resolve => setTimeout(resolve, 500));
                } catch (e) {
                  console.error('[auto-updater] Error closing containers:', e);
                }

                // 2. すべての非メインウィンドウを強制終了
                try {
                  console.log('[auto-updater] Force closing all non-main windows...');
                  if (forceCloseAllNonMainWindows) forceCloseAllNonMainWindows();
                  await new Promise(resolve => setTimeout(resolve, 300));
                } catch (e) {
                  console.error('[auto-updater] Error force closing windows:', e);
                }

                // 3. メインウィンドウを閉じる
                try {
                  console.log('[auto-updater] Closing main window...');
                  if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.removeAllListeners();
                    mainWindow.destroy();
                  }
                } catch (e) {
                  console.error('[auto-updater] Error closing main window:', e);
                }

                // 4. トレイアイコンを削除
                try {
                  if (tray && !tray.isDestroyed()) {
                    tray.destroy();
                  }
                } catch (e) {
                  console.error('[auto-updater] Error destroying tray:', e);
                }

                // 5. グローバルショートカットを解除
                try {
                  globalShortcut.unregisterAll();
                } catch (e) {
                  console.error('[auto-updater] Error unregistering shortcuts:', e);
                }

                // 6. 終了フラグを設定
                isQuitting = true;

                console.log('[auto-updater] Graceful shutdown completed, installing update...');

                // 7. アップデートをインストール
                autoUpdater.quitAndInstall(false, true);

              } catch (e) {
                console.error('[auto-updater] quitAndInstall error', e);
                // フォールバック: 強制終了
                setTimeout(() => process.exit(0), 1000);
              }
            }, 2000);
          });
          // trigger check
          setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch (e) { logger.error('[auto-updater] check error', e); } }, 3000);
          console.log('[DEBUG] Auto-updater setup complete');
        } catch (e) {
          console.error('[auto-updater] setup error', e);
          logger.error('[auto-updater] setup error', e);
        }
      } else {
        console.log('[DEBUG] Auto-updater disabled (standalone mode)');
        logger.info('[DEBUG] Auto-updater disabled (standalone mode)');
      }

      console.log('[DEBUG] Creating main window...');
      await createMainWindow();
      console.log('[DEBUG] Main window created successfully');
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
            try { mainWindow?.webContents.send('export.server.status', { running: true, port: Number(portToUse), error: null }); } catch { }
          } else {
            try { mainWindow?.webContents.send('export.server.status', { running: false, port: Number(portToUse), error: null }); } catch { }
          }
        } catch (e: any) {
          logger.error('[main] failed to start export server', e);
          try { mainWindow?.webContents.send('export.server.status', { running: false, port: Number(portToUse), error: String(e?.message || e) }); } catch { }
        }
      } catch (e) {
        console.error('[main] failed to start export server', e);
        logger.error('[main] failed to start export server', e);
      }

      console.log('[DEBUG] App initialization completed successfully');
      logger.info('[DEBUG] App initialization completed successfully');

    } catch (error) {
      console.error('[FATAL] App initialization failed:', error);
      logger.error('[FATAL] App initialization failed:', error);
      // アプリ初期化失敗時は終了
      process.exit(1);
    }

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
            try { mainWindow.hide(); } catch { }
          }
        }
      } catch (e) { console.error('[main] second-instance window focus/hide error', e); }
    } catch (e) { console.error('[main] second-instance handleArgv error', e); }
  });





  app.on('window-all-closed', () => {
    // Protection: Don't quit if mainWindow still exists (e.g., after container close)
    // Only quit when all windows including mainWindow are actually closed
    try {
      const allWindows = BrowserWindow.getAllWindows();
      const hasMainWindow = allWindows.some((w: any) => w === mainWindow && !w.isDestroyed());
      if (hasMainWindow) {
        console.log('[main] window-all-closed: mainWindow still exists, skipping app.quit()');
        return;
      }
    } catch (e) {
      console.error('[main] window-all-closed: error checking mainWindow', e);
    }

    // Close all opened container windows when main window is closed, then quit.
    try { if (closeAllContainers) closeAllContainers(); } catch { }
    try { if (closeAllNonMainWindows) closeAllNonMainWindows(); } catch { }
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
    try { if (forceCloseAllNonMainWindows) forceCloseAllNonMainWindows(); } catch (e) { console.error('[main] will-quit force close error', e); }
  });



  // Bookmarks IPC handlers are defined in src/main/ipc.ts to avoid duplicate registration

  // === CLI / Custom Protocol ===


  // Windows: 二重起動時のプロトコル引数
  // シングルインスタンスロックを有効化して別プロセス起動を抑止する
  const ENABLE_SINGLE_INSTANCE = true;

  // デバッグ情報をログファイルに出力
  if (app && !(global as any)._envCheckDone) {
    (global as any)._envCheckDone = true;
    try {
      const debugInfo = {
        ENABLE_SINGLE_INSTANCE,
        NODE_ENV: process.env.NODE_ENV,
        ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL,
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        timestamp: new Date().toISOString()
      };
      logger.info('[DEBUG] Environment check:', debugInfo);
      console.log('[DEBUG] Environment check:', JSON.stringify(debugInfo, null, 2));
    } catch (e) {
      console.log('[DEBUG] Failed to log environment info:', e);
    }
  }


  let gotLock = true;

  if (ENABLE_SINGLE_INSTANCE) {
    gotLock = app.requestSingleInstanceLock();
    logger.info('[DEBUG] Single instance lock result:', gotLock);
    console.log('[DEBUG] Single instance lock result:', gotLock);

    if (!gotLock) {
      const msg = '[DEBUG] Single instance lock failed, quitting...';
      logger.error(msg);
      console.log(msg);
      app.quit();
      process.exit(1);
    } else {
      const msg = '[DEBUG] Single instance lock acquired successfully';
      logger.info(msg);
      console.log(msg);
    }
  } else {
    const msg = '[DEBUG] Single instance lock disabled';
    logger.info(msg);
    console.log(msg);
  }

  app.on('second-instance', (_event, argv) => {
    handleArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}


export function registerMainIpcHandlers() {

  if ((global as any)._mainIpcRegistered) {
    console.log('[main] registerMainIpcHandlers: already registered (global hint), skipping.');
    return;
  }
  (global as any)._mainIpcRegistered = true;





  // --- App Actions ---
  ipcMain.handle('app.getVersion', () => {
    try { return app.getVersion(); } catch { return 'unknown'; }
  });
  ipcMain.handle('app.openSettings', () => {
    try { createSettingsWindow(); return { ok: true }; } catch (e: any) { logger.error('[ipc] app.openSettings error', e); return { ok: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('app.checkForUpdates', async () => {
    return { ok: false, error: 'Auto-update disabled in this version' };
  });
  ipcMain.handle('app.exit', () => {
    try { isQuitting = true; app.quit(); return { ok: true }; } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });

  // --- Auth/Token Actions ---
  ipcMain.handle('auth.saveToken', async (_e, { token }) => {
    try { const ok = await saveToken(token); return { ok }; } catch (e: any) { logger.error('[auth] saveToken error', e); return { ok: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('auth.getToken', async () => {
    try { const t = await getToken(); return { ok: true, token: t }; } catch (e: any) { logger.error('[auth] getToken error', e); return { ok: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('auth.clearToken', async () => {
    try { await clearToken(); return { ok: true }; } catch (e: any) { logger.error('[auth] clearToken error', e); return { ok: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('auth.getDeviceId', async () => {
    try {
      const id = getOrCreateDeviceId();
      return { ok: true, deviceId: id };
    } catch (e: any) {
      logger.error('[auth] getDeviceId error', e);
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle('auth.validateToken', async (_e, { token }: { token?: string }) => {
    const MAX_RETRIES = 3;
    const BASE_URL = getAuthApiBase();
    const timeoutMs = getAuthTimeoutMs();
    try {
      const t = token || await getToken();
      if (!t) return { ok: false, code: 'NO_TOKEN' };
      const deviceId = getOrCreateDeviceId();
      const url = (BASE_URL.replace(/\/$/, '')) + '/auth/validate';
      const containerCount = DB.listContainers().length;
      const doFetch = async () => {
        const ac = new AbortController();
        const id = setTimeout(() => ac.abort(), timeoutMs);
        try {
          const res = await (global as any).fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              device_id: deviceId,
              device_info: { name: app.getName(), hostname: app.getName() },
              current_container_count: containerCount
            }),
            signal: ac.signal
          });
          clearTimeout(id);
          const j = await res.json().catch(() => null);
          return { res, j };
        } catch (err: any) { clearTimeout(id); throw err; }
      };
      let attempt = 0;
      while (true) {
        try {
          attempt++;
          const { res, j } = await doFetch();
          if (!res.ok) {
            if (res.status >= 400 && res.status < 500) return { ok: false, status: res.status, body: j };
            if (res.status >= 500) throw new Error(`server ${res.status}`);
          }
          const data = j && j.data ? j.data : j;
          return { ok: true, data };
        } catch (err: any) {
          if (attempt >= MAX_RETRIES) return { ok: false, error: err?.message || String(err) };
          const backoff = 200 * Math.pow(2, attempt - 1);
          await new Promise(r => setTimeout(r, backoff));
        }
      }
    } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
  });
  ipcMain.handle('auth.heartbeat', async (_e, { token }: { token?: string }) => {
    const MAX_RETRIES = 3;
    const BASE_URL = getAuthApiBase();
    const timeoutMs = getAuthTimeoutMs();
    try {
      const t = token || await getToken();
      if (!t) return { ok: false, code: 'NO_TOKEN' };
      const deviceId = getOrCreateDeviceId();
      const url = (BASE_URL.replace(/\/$/, '')) + '/auth/heartbeat';
      const containerCount = DB.listContainers().length;
      const doFetch = async () => {
        const ac = new AbortController();
        const id = setTimeout(() => ac.abort(), timeoutMs);
        try {
          const res = await (global as any).fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: deviceId, current_container_count: containerCount }),
            signal: ac.signal
          });
          clearTimeout(id);
          const j = await res.json().catch(() => null);
          return { res, j };
        } catch (err: any) { clearTimeout(id); throw err; }
      };
      let attempt = 0;
      while (true) {
        try {
          attempt++;
          const { res, j } = await doFetch();
          if (!res.ok) {
            if (res.status >= 400 && res.status < 500) return { ok: false, status: res.status, body: j };
            if (res.status >= 500) throw new Error(`server ${res.status}`);
          }
          const data = j && j.data ? j.data : j;
          return { ok: true, data };
        } catch (err: any) {
          if (attempt >= MAX_RETRIES) return { ok: false, error: err?.message || String(err) };
          const backoff = 200 * Math.pow(2, attempt - 1);
          await new Promise(r => setTimeout(r, backoff));
        }
      }
    } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
  });
  ipcMain.handle('auth.getSettings', async () => {
    try { return { ok: true, data: getAuthSettings() }; } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('auth.saveSettings', async (_e, { apiBase }: { apiBase?: string }) => {
    try {
      if (apiBase) {
        try { new URL(apiBase); } catch { return { ok: false, error: 'Invalid URL format' }; }
        setAuthSettings({ apiBase });
      }
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });

  // --- Container Actions ---
  ipcMain.handle('containers.list', async () => {
    try {
      await syncKameleoProfiles();
    } catch (e) {
      console.warn('[main] Auto-sync failing on list', e);
    }
    return DB.listContainers();
  });
  ipcMain.handle('containers.get', (_e, { id }: { id: string }) => {
    const c = DB.getContainer(id);
    if (!c) throw new Error('container not found');
    return c;
  });
  ipcMain.handle('containers.getByName', (_e, { name }: { name: string }) => {
    const c = DB.getContainerByName(name);
    if (!c) throw new Error('container not found');
    return c;
  });
  ipcMain.handle('containers.create', async (_e, { name, ua, locale, timezone, proxy }) => {
    try {
      const token = await getToken();
      if (token) {
        const deviceId = getOrCreateDeviceId();
        const useResp = await callAuthUse(token, deviceId, 1);
        if (!useResp.ok) throw new Error(useResp.status === 409 ? 'Quota exceeded' : 'Auth failed');
      }
    } catch (err: any) { throw err; }

    // Create actual Kameleo Profile immediately
    let kameleoProfileId: string;
    let kameleoEnv: any;
    try {
      const { KameleoApi } = await import('./kameleoApi');
      const profiles = await KameleoApi.listProfiles();
      const existingProfile = profiles.find(p => p.name === name);

      if (existingProfile) {
        console.log(`[main] [kameleo] Using existing profile found by name: ${name} (${existingProfile.id})`);
        kameleoProfileId = existingProfile.id;
        kameleoEnv = {
          deviceType: (existingProfile as any).device?.deviceType || 'desktop',
          os: (existingProfile as any).device?.platform || 'windows',
          browser: (existingProfile as any).device?.browser || 'chrome'
        };
      } else {
        let proxyOptions = undefined;
        if (proxy && typeof proxy === 'object' && proxy.server) {
          const hostPort = proxy.server.replace(/^[^:]+:\/\//, '').replace(/^[^@]+@/, '');
          const [host, port] = hostPort.split(':');
          proxyOptions = {
            value: proxy.server.startsWith('socks5') ? 'socks5' : 'http',
            extra: {
              host,
              port: parseInt(port) || 80,
              id: proxy.username,
              secret: proxy.password
            }
          };
        }

        const p = await KameleoApi.createProfile({
          name: name,
          tags: ['container-browser'],
          deviceType: 'desktop',
          os: 'windows',
          browser: 'chrome',
          storage: 'cloud',
          language: 'ja-JP',
          proxy: proxyOptions
        });
        kameleoProfileId = p.id;
        kameleoEnv = {
          deviceType: p.device?.deviceType,
          os: p.device?.platform,
          browser: p.device?.browser
        };
        console.log(`[main] [kameleo] New profile created: ${kameleoProfileId}`);
      }
    } catch (e) {
      console.error('[main] [kameleo] Failed to create profile during container creation', e);
      throw new Error('Kameleo profile creation failed: ' + (e as any).message);
    }

    const id = kameleoProfileId; // Use Kameleo ID as local ID
    const c: Container = {
      id,
      name,
      userDataDir: path.join(app.getPath('userData'), 'profiles', id),
      partition: `persist:container-${id}`,
      userAgent: ua || undefined,
      locale: locale || 'ja-JP',
      timezone: timezone || 'Asia/Tokyo',
      proxy: proxy || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      kameleoProfileId,
      profileMode: 'attached',
      kameleoEnv
    };

    DB.upsertContainer(c);
    return c;
  });

  ipcMain.handle('containers.open', async (_e, { id, url }) => {
    const c = DB.getContainer(id);
    if (!c) throw new Error('container not found');
    return !!(await openContainerWindow(c, url));
  });
  ipcMain.handle('containers.openByName', async (_e, { name, url }) => {
    const c = DB.getContainerByName(name) || await createContainerWithName(name);
    return !!(await openContainerWindow(c, url));
  });
  ipcMain.handle('containers.delete', async (_e, { id }) => {
    const c = DB.getContainer(id);
    if (!c) return false;
    try {
      const ses = session.fromPartition(c.partition, { cache: true });
      await ses.clearStorageData({});
    } catch { }

    // Also delete Kameleo Profile if it is managed
    if (c.kameleoProfileId && c.profileMode === 'managed') {
      try {
        const { KameleoApi } = await import('./kameleoApi');
        await KameleoApi.deleteProfile(c.kameleoProfileId);
        console.log(`[main] [kameleo] Deleted profile: ${c.kameleoProfileId}`);
      } catch (e) {
        console.error(`[main] [kameleo] Failed to delete profile: ${c.kameleoProfileId}`, e);
      }
    }

    await deleteContainerStorage(id);
    DB.asyncDeleteContainer(id);
    return true;
  });
  ipcMain.handle('containers.close', async (_e, { id }: { id: string }) => {
    const c = DB.getContainer(id);
    if (!c || !c.kameleoProfileId) return { ok: false, error: 'profile not found' };
    try {
      // If the container window is open, use closeContainer to close shell + stop Kameleo
      if (isContainerOpen(id)) {
        console.log(`[main] [ipc] Closing open container ${id}`);
        await closeContainer(id);
      } else {
        // Just stop the profile if no shell window is open
        console.log(`[main] [ipc] Stopping Kameleo profile ${c.kameleoProfileId} (no shell open)`);
        const { KameleoApi } = await import('./kameleoApi');
        await KameleoApi.stopProfile(c.kameleoProfileId);
      }

      // Update status in local DB
      try {
        const { KameleoApi } = await import('./kameleoApi');
        const p = await KameleoApi.getProfile(c.kameleoProfileId!);
        if (p) {
          DB.upsertContainer({
            ...c,
            status: (p.status === 'started' || p.status === 'running' ? '稼働中' : '停止') as any
          });
        }
      } catch (e) {
        // ignore status update error
      }

      return { ok: true };
    } catch (err: any) {
      console.error(`[main] [ipc] Error closing container ${id}:`, err);
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('containers.update', async (_e, payload: Partial<Container> & { id: string, kameleoTags?: string[] }) => {
    const cur = DB.getContainer(payload.id);
    if (!cur) throw new Error('container not found');

    const next: Container = { ...cur, ...payload, updatedAt: Date.now() } as Container;

    // Handle proxy conversion if updated
    if ((payload as any).proxy !== undefined) {
      next.proxy = (payload as any).proxy;
    }

    // Update Kameleo Profile if linked
    if (cur.kameleoProfileId) {
      try {
        const { KameleoApi } = await import('./kameleoApi');
        const updateOptions: any = {};
        if (payload.name) updateOptions.name = payload.name;
        if (payload.kameleoTags) updateOptions.tags = payload.kameleoTags;

        if (next.proxy) {
          const s = next.proxy.server || '';
          const match = s.match(/^(?:(http|socks5|socks4):\/\/)?([^:]+):(\d+)$/i);
          if (match) {
            updateOptions.proxy = {
              type: (match[1] || 'http').toLowerCase(),
              host: match[2],
              port: parseInt(match[3]),
              username: next.proxy.username,
              password: next.proxy.password
            };
          }
        } else if (payload.proxy === null) {
          updateOptions.proxy = null;
        }

        if (Object.keys(updateOptions).length > 0) {
          console.log(`[main] [kameleo] Updating profile ${cur.kameleoProfileId} for container ${cur.id}`, updateOptions);
          await KameleoApi.updateProfile(cur.kameleoProfileId, updateOptions);

          // Update cached metadata
          if (payload.name) next.kameleoProfileMetadata = { ...next.kameleoProfileMetadata, name: payload.name } as any;
          if (payload.kameleoTags) next.kameleoProfileMetadata = { ...next.kameleoProfileMetadata, tags: payload.kameleoTags } as any;
        }
      } catch (err) {
        console.error('[main] [kameleo] Failed to sync update to Kameleo', err);
        // We still update local DB even if Kameleo sync fails, but we might want to throw?
        // Let's just log for now to avoid blocking local edits.
      }
    }

    DB.upsertContainer(next);
    return next;
  });

  ipcMain.handle('containers.clearCache', async (_e, { id }: { id: string }) => {
    const c = DB.getContainer(id);
    if (!c) return { ok: false, error: 'container not found' };
    try {
      const ses = session.fromPartition(c.partition);
      await ses.clearCache();
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });

  ipcMain.handle('containers.clearAllData', async (_e, { id }: { id: string }) => {
    const c = DB.getContainer(id);
    if (!c) return { ok: false, error: 'container not found' };
    try {
      const ses = session.fromPartition(c.partition);
      await ses.clearStorageData({
        storages: ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'],
        quotas: ['persistent', 'temporary', 'syncable']
      });
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });

  ipcMain.handle('containers.setNote', (_e, { id, note }) => {

    const cur = DB.getContainer(id);
    if (!cur) throw new Error('container not found');
    DB.upsertContainer({ ...cur, note });
    return { ok: true };
  });
  ipcMain.handle('containers.syncKameleo', async () => {
    return await syncKameleoProfiles();
  });

  // --- Tab Actions (Moved to containerManager.ts) ---


  // --- Export Server Actions ---
  ipcMain.handle('export.getSettings', () => {
    try { return { ok: true, settings: getExportSettings() }; } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('export.saveSettings', async (_e, payload: any) => {
    try {
      const ok = setExportSettings(payload || {});
      try {
        const cfg = loadConfig();
        const s = cfg.exportServer || getExportSettings();
        if (s && s.enabled) {
          const es = await import('./exportServer');
          const port = Number(s.port || 3001);
          es.startExportServer(port);
          try { mainWindow?.webContents.send('export.server.status', { running: true, port, error: null }); } catch { }
        } else {
          try { mainWindow?.webContents.send('export.server.status', { running: false, port: Number(s?.port || 3001), error: null }); } catch { }
        }
      } catch (e) { }
      return { ok };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('export.getConfigPath', () => {
    try { return { ok: true, path: require('./settings').configPath() }; } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('export.getStatus', () => {
    try {
      const envPort2 = process.env.CONTAINER_EXPORT_PORT ? Number(process.env.CONTAINER_EXPORT_PORT) : null;
      const cur = loadConfig();
      const s = cur.exportServer || getExportSettings();
      const running = !!envPort2 || !!s.enabled;
      const port = envPort2 || Number(s.port || 3001);
      return { ok: true, running, port };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });

  // --- Graphics Actions ---
  ipcMain.handle('graphics.getSettings', () => {
    try { return { ok: true, data: getGraphicsSettings() }; } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('graphics.saveSettings', async (_e, updates: any) => {
    try { return { ok: setGraphicsSettings(updates) }; } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });

  // --- Migration Actions ---
  ipcMain.handle('migration.updatePaths', async (_e, { oldBasePath, newBasePath }: { oldBasePath: string; newBasePath: string }) => {
    try { return { ok: true, updatedCount: DB.updateContainerPaths(oldBasePath, newBasePath) }; } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });
  ipcMain.handle('migration.getUserDataPath', () => {
    try { return { ok: true, path: app.getPath('userData') }; } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });

  // --- DevTools Actions ---
  ipcMain.handle('devtools.toggle', (_e) => {
    try {
      const all = BrowserWindow.getAllWindows();
      for (const w of all) {
        if (w.webContents && w.webContents.isDevToolsOpened && w.webContents.isDevToolsOpened()) w.webContents.closeDevTools();
        else w.webContents.openDevTools({ mode: 'detach' });
      }
      return true;
    } catch (e) { return false; }
  });
  ipcMain.handle('devtools.toggleView', (_e) => {
    try {
      const fw = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      if (fw && fw.webContents) {
        if (typeof fw.webContents.isDevToolsOpened === 'function' && fw.webContents.isDevToolsOpened()) fw.webContents.closeDevTools();
        else fw.webContents.openDevTools({ mode: 'detach' });
        return true;
      }
      return false;
    } catch (e) { return false; }
  });

  // --- Proxy Test ---
  ipcMain.handle('proxy.test', async (_e, { proxy }) => {
    try {
      if (!proxy || !proxy.server) return { ok: false, errorCode: 'no_proxy', error: 'no proxy' };
      const server = String(proxy.server).trim();
      const username = proxy.username ? String(proxy.username) : undefined;
      const password = proxy.password ? String(proxy.password) : undefined;
      const net = await import('node:net');
      const parseHostPort = (s: string) => {
        let t = s.replace(/^\s+|\s+$/g, '').replace(/^[a-z0-9]+=/i, '').replace(/^.*:\/\//, '');
        const parts = t.split(':');
        return { host: parts[0] || '', port: parseInt(parts[1] || '0') };
      };
      if (/^socks5/i.test(server)) {
        const { host, port } = parseHostPort(server);
        return await new Promise((resolve) => {
          const sock = net.createConnection({ host, port }, async () => {
            try {
              sock.write(Buffer.from([0x05, 0x01, 0x00]));
              sock.once('data', (d: Buffer) => {
                const m = d[1];
                if (m !== 0x00) { sock.destroy(); return resolve({ ok: false, error: 'socks5 auth required' }); }
                sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 1, 1, 1]), Buffer.alloc(2)]));
                sock.once('data', (resp) => { sock.end(); resolve({ ok: resp[1] === 0x00 }); });
              });
            } catch (err) { sock.destroy(); resolve({ ok: false, error: String(err) }); }
          });
          sock.on('error', (err) => resolve({ ok: false, error: err.message }));
          setTimeout(() => { sock.destroy(); resolve({ ok: false, error: 'timeout' }); }, 5000);
        });
      }
      const { host: phost, port: pport } = parseHostPort(server);
      return await new Promise((resolve) => {
        const s = net.createConnection({ host: phost, port: pport }, () => {
          let connectReq = `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n`;
          if (username && password) connectReq += `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}\r\n`;
          connectReq += `\r\n`;
          s.write(connectReq);
          s.on('data', (d) => { s.end(); resolve({ ok: d.toString().includes('200') }); });
          s.on('error', (err) => { s.destroy(); resolve({ ok: false, error: err.message }); });
        });
        s.on('error', (err) => resolve({ ok: false, error: err.message }));
        setTimeout(() => { s.destroy(); resolve({ ok: false, error: 'timeout' }); }, 5000);
      });
    } catch (e: any) { return { ok: false, error: e.message }; }
  });

  // --- Misc ---
  ipcMain.on('renderer.log', (_e: any, msg: any) => { logger.info('[renderer]', msg); });
  app.on('activate', async () => { if (BrowserWindow.getAllWindows().length === 0) await createMainWindow(); });
}

