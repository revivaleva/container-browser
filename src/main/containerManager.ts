import { app, BrowserWindow, BrowserView, ipcMain, session } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Container } from '../shared/types';
import { DB } from './db';
import { existsSync } from 'node:fs';

type OpenOpts = { restore?: boolean; singleTab?: boolean };

type OpenedContainer = { win: BrowserWindow; views: BrowserView[]; activeIndex: number; sessionId: string };
const openedById = new Map<string, OpenedContainer>();
let isRestoringGlobal = false;
let mainWindowRef: BrowserWindow | null = null;

// Register main window reference to prevent accidental app quit when closing containers
export function setMainWindow(win: BrowserWindow) {
  mainWindowRef = win;
  // Clear ref when window is destroyed
  try {
    win.on('closed', () => {
      if (mainWindowRef === win) mainWindowRef = null;
    });
  } catch {}
}

// --- helpers for external control (export API) ---
export function isContainerOpen(containerId: string) {
  return openedById.has(containerId);
}

export function closeContainer(containerId: string) {
  const entry = openedById.get(containerId);
  if (!entry || !entry.win) return false;
  try {
    entry.win.close();
    return true;
  } catch (e) {
    console.error('[main] closeContainer error', e);
    return false;
  }
}

export function waitForContainerClosed(containerId: string, timeoutMs = 60000) {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (!openedById.has(containerId)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitForContainerClosed timeout'));
      setTimeout(check, 200);
    };
    check();
  });
}


// Global top bar height used by layout calculations so main and createTab stay consistent
// Must match the renderer `body { padding-top }` so BrowserView content does not overlap the shell UI
// revert BAR_HEIGHT to match renderer padding-top
// set BAR_HEIGHT to match renderer padding-top
// set BAR_HEIGHT to match renderer padding-top
export const BAR_HEIGHT = 150;

export async function openContainerWindow(container: Container, startUrl?: string, opts: OpenOpts = {}) {
  // If a window for this container already exists, focus it and optionally navigate
  try {
    const existing = openedById.get(container.id);
    if (existing) {
      try { existing.win.focus(); } catch {}
      if (startUrl) {
        // if existing window has no visible webContents URL (just created), load into existing view instead of creating duplicate window
        const activeView = existing.views[existing.activeIndex] || existing.views[0];
        const currentUrl = activeView ? (activeView.webContents.getURL?.() || '') : '';
        if (!currentUrl || currentUrl === 'about:blank') {
          try { activeView.webContents.loadURL(startUrl); } catch { try { createTab(container.id, startUrl); } catch {} }
        } else {
          try { createTab(container.id, startUrl); } catch {}
        }
      }
      return existing.win;
    }
  } catch {}
  const part = container.partition;
  const ses = session.fromPartition(part, { cache: true });
  // プロファイルは 'persist:<name>' の partition により分離される。
  // キャッシュ保存先の明示セットは不要（Electron が userData/Partitions 配下に保存）。

  // プロキシ
  if (container.proxy?.server) {
    // Store credentials for use in onBeforeSendHeaders (案B)
    const proxyUsername = container.proxy.username;
    const proxyPassword = container.proxy.password;
    
    // Normalize proxy server format for Electron
    // Electron expects format like "http=host:port;https=host:port" or just "host:port"
    // NOTE: Electron's setProxy does NOT support embedded credentials in URL format
    // We must use plain host:port and rely on the login event for authentication
    let proxyRules = container.proxy.server;
    
    // Extract host:port from proxyRules if it contains = or ://
    let hostPort = proxyRules;
    if (proxyRules.includes('=')) {
      // Extract from http=host:port or https=host:port
      const match = proxyRules.match(/(?:https?|socks5)=([^;]+)/i);
      if (match) {
        hostPort = match[1].trim();
        // Remove any embedded credentials (username:password@host:port -> host:port)
        hostPort = hostPort.replace(/^[^@]+@/, '');
      }
    } else if (proxyRules.includes('://')) {
      // Extract from http://host:port or socks5://host:port
      hostPort = proxyRules.replace(/^[^:]+:\/\//, '');
      // Remove any embedded credentials
      hostPort = hostPort.replace(/^[^@]+@/, '');
    } else {
      // Already in host:port format, but may contain embedded credentials
      hostPort = proxyRules.replace(/^[^@]+@/, '');
    }
    
    // Use plain host:port format (no embedded credentials)
    // Authentication will be handled via login event
    if (!proxyRules.includes('=') && !proxyRules.includes('://')) {
      proxyRules = `http=${hostPort};https=${hostPort}`;
      console.log('[main] normalized proxy format', { original: container.proxy.server, normalized: proxyRules, hostPort });
    } else {
      // Rebuild proxy rules with clean host:port
      proxyRules = `http=${hostPort};https=${hostPort}`;
      console.log('[main] cleaned proxy format', { original: container.proxy.server, normalized: proxyRules, hostPort });
    }
    
    console.log('[main] setting proxy for container', container.id, { 
      server: container.proxy.server, 
      normalized: proxyRules,
      hasUsername: !!proxyUsername, 
      hasPassword: !!proxyPassword 
    });
    
    try {
      // 案C: proxyBypassRulesを設定してローカル通信をバイパス
      await ses.setProxy({ 
        proxyRules,
        proxyBypassRules: 'localhost,127.0.0.1,<local>'
      });
      console.log('[main] proxy set successfully for container', container.id, { 
        proxyRules,
        proxyBypassRules: 'localhost,127.0.0.1,<local>'
      });
      
      // Verify proxy is actually set by checking the session's proxy configuration
      try {
        const proxyConfig = await ses.resolveProxy('https://www.google.com');
        console.log('[main] resolved proxy for test URL', { 
          containerId: container.id,
          resolvedProxy: proxyConfig,
          expectedProxy: proxyRules
        });
      } catch (e) {
        console.warn('[main] failed to resolve proxy for verification', e);
      }
    } catch (e) {
      console.error('[main] failed to set proxy for container', container.id, e);
    }
  } else {
    console.log('[main] no proxy configured for container', container.id, 'using system proxy');
    await ses.setProxy({ mode: 'system' });
  }

  // Accept-Language を上書き + Proxy-Authorization ヘッダーを追加（案B）
  try {
    const acceptLang = container.fingerprint?.acceptLanguage || 'ja,en-US;q=0.8,en;q=0.7';
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const headers = { ...details.requestHeaders, 'Accept-Language': acceptLang } as any;
      
      // 案B: Proxy-Authorization ヘッダーを強制付与
      // HTTP/HTTPS リクエストのみ処理（ローカルやchrome-extensionはスキップ）
      if ((details.url.startsWith('http://') || details.url.startsWith('https://')) 
          && !details.url.startsWith('http://localhost') 
          && !details.url.startsWith('https://localhost')
          && container.proxy?.username 
          && container.proxy?.password) {
        const token = Buffer.from(`${container.proxy.username}:${container.proxy.password}`).toString('base64');
        headers['Proxy-Authorization'] = `Basic ${token}`;
        console.log('[main] added Proxy-Authorization header', {
          url: details.url,
          containerId: container.id,
          hasToken: !!token
        });
      }
      
      // Log first few requests to debug proxy usage
      if (details.url && !details.url.startsWith('chrome-extension://') && !details.url.startsWith('devtools://') && !details.url.startsWith('http://localhost')) {
        const isFirstRequest = !(ses as any).__requestCount;
        (ses as any).__requestCount = ((ses as any).__requestCount || 0) + 1;
        if (isFirstRequest || (ses as any).__requestCount <= 5) {
          // Check if request is going through proxy by examining the request
          const proxyInfo = container.proxy?.server ? {
            proxyServer: container.proxy.server,
            hasCredentials: !!(container.proxy.username && container.proxy.password),
            hasProxyAuthHeader: !!headers['Proxy-Authorization']
          } : null;
          console.log('[main] webRequest onBeforeSendHeaders', {
            url: details.url,
            method: details.method,
            containerId: container.id,
            hasProxy: !!container.proxy?.server,
            proxyInfo,
            requestCount: (ses as any).__requestCount
          });
        }
      }
      cb({ requestHeaders: headers });
    });
    // Detect 407 Proxy Authentication Required and log it
    // Note: We cannot modify Proxy-Authorization header directly via webRequest API
    // The login event should handle this, but if it doesn't fire, we log the 407 for debugging
    ses.webRequest.onHeadersReceived((details, cb) => {
      if (details.statusCode === 407 && container.proxy?.username) {
        console.log('[main] received 407 Proxy Authentication Required', {
          url: details.url,
          containerId: container.id,
          statusCode: details.statusCode,
          responseHeaders: details.responseHeaders,
          proxyAuthenticate: details.responseHeaders?.['proxy-authenticate'] || details.responseHeaders?.['Proxy-Authenticate']
        });
        console.warn('[main] WARNING: 407 received but login event may not have fired. This indicates a potential Electron bug or configuration issue.');
      }
      cb({});
    });
    // Log request errors
    ses.webRequest.onErrorOccurred((details) => {
      if (details.url && !details.url.startsWith('chrome-extension://') && !details.url.startsWith('devtools://')) {
        console.error('[main] webRequest onErrorOccurred', {
          url: details.url,
          error: details.error,
          containerId: container.id,
          hasProxy: !!container.proxy?.server
        });
      }
    });
  } catch {}

  const shellPreloadPath = path.join(app.getAppPath(), 'out', 'preload', 'mainPreload.cjs');
  console.log('[main] shell preload:', shellPreloadPath, 'exists=', existsSync(shellPreloadPath));

  const w = container.fingerprint?.viewportWidth || 1280;
  const h = container.fingerprint?.viewportHeight || 800;
  const win = new BrowserWindow({
    width: w,
    height: h + BAR_HEIGHT, // アドレスバー分
    webPreferences: {
      partition: part,
      contextIsolation: true,
      nodeIntegration: false,
      preload: shellPreloadPath,
      backgroundThrottling: false // バックグラウンドでも読み込みを継続
    }
  });
  
  // Set containerId on shell window's webContents for app.on('login') handler
  try {
    (win.webContents as any)._containerId = container.id;
  } catch (e) {
    console.error('[main] failed to set containerId on shell webContents', e);
  }
  // set window icon if available
  try {
    const ico = path.join(app.getAppPath(), 'build-resources', 'Icon.ico');
    if (existsSync(ico)) win.setIcon(ico as any);
  } catch (e) { console.error('[main] set container window icon error', e); }
  // mark this window as a container shell so main can detect and close it reliably
  try { (win as any).__isContainerShell = true; (win as any).__containerId = container.id; } catch {}
  // Set containerId on shell window's webContents for app.on('login') handler
  try {
    (win.webContents as any)._containerId = container.id;
  } catch (e) {
    console.error('[main] failed to set containerId on shell webContents', e);
  }
  // hide menu bar for the container shell window (remove File/Edit menus)
  try { win.removeMenu(); win.setAutoHideMenuBar(true); } catch {}

  // 開発時デバッグ: DevTools の自動オープンを無効化。
  // 開発中は F12 押下で開くように renderer -> preload -> main で toggle を提供する。

  // セッションIDを新規採番（この起動単位）
  const sessionId = randomUUID();
  // Read previous lastSessionId from DB before we update it for the new session
  let prevLastSessionId: string | null = null;
  try { const curCont = DB.getContainer(container.id); if (curCont) prevLastSessionId = curCont.lastSessionId ?? null; } catch (e) { console.error('[main] failed to read prevLastSessionId', e); }
  DB.recordSession(sessionId, container.id, Date.now());

  // UA固定（必要に応じて）
  if (container.userAgent) win.webContents.userAgent = container.userAgent;

  // NOTE: Avoid recording navigations triggered by the shell window itself
  // (e.g. containerShell.html or dev server). Record tabs only from BrowserView
  // navigations below. Still keep light logging for debugging.
  win.webContents.on('did-navigate', (_e, url) => {
    try { console.log('[main] shell did-navigate (ignored for tabs) url=', url); } catch {}
  });
  win.webContents.on('page-title-updated', (_e, title) => {
    try { console.log('[main] shell title-updated (ignored for tabs) title=', title); } catch {}
  });
  win.webContents.on('page-favicon-updated', (_e, favs) => {
    try { console.log('[main] shell favicon-updated (ignored for tabs) favs=', favs); } catch {}
  });

  win.on('closed', () => DB.closeSession(sessionId, Date.now()));

  // ページへコンテキスト（containerId/sessionId/fingerprint/currentUrl/tabs）を通知
  const sendCtx = () => {
    try {
      const entry = openedById.get(container.id);
      const containerRecord = DB.getContainer(container.id) || { name: undefined };
      const containerName = containerRecord.name ?? container.name ?? '';
      const tabs = entry ? entry.views.map(v => ({ url: v.webContents.getURL(), title: v.webContents.getTitle?.() })) : [];
      const activeIndex = entry ? entry.activeIndex : 0;
      const activeView = entry ? (entry.views[activeIndex] || entry.views[0]) : null;
      const currentUrl = activeView ? activeView.webContents.getURL() : undefined;
      console.log('[main] sendCtx', { containerId: container.id, sessionId, currentUrl, tabsLength: tabs.length, activeIndex, containerName });
      try { win.setTitle(containerName || 'コンテナシェル'); } catch {}
      win.webContents.send('container.context', { containerId: container.id, sessionId, fingerprint: container.fingerprint, currentUrl, tabs, activeIndex, containerName });
    } catch {}
  };
  win.webContents.on('did-finish-load', sendCtx);

  // BrowserView を作成（実ページ）
  const viewPreloadPath = path.join(app.getAppPath(), 'out', 'preload', 'containerPreload.cjs');
  const createView = (u: string) => {
    const v = new BrowserView({ webPreferences: { partition: part, contextIsolation: true, nodeIntegration: false, preload: viewPreloadPath, backgroundThrottling: false } });
    
    // Set containerId on view's webContents for app.on('login') handler
    try {
      (v.webContents as any)._containerId = container.id;
    } catch (e) {
      console.error('[main] failed to set containerId on view webContents', e);
    }
    
    const layoutView = () => {
      const [w, h] = win.getContentSize();
      const bar = BAR_HEIGHT;
      v.setBounds({ x: 0, y: bar, width: w, height: Math.max(0, h - bar) });
    };
    win.on('resize', layoutView);
    layoutView();
    const scale = container.fingerprint?.deviceScaleFactor || 1.0;
    try { v.webContents.setZoomFactor(scale); } catch {}

    // Forward navigation/title/favicon events from the BrowserView to the shell window
    try {
      v.webContents.on('did-navigate', (_e, url) => {
        try {
          const entry = openedById.get(container.id);
          const tabIndex = entry ? entry.views.indexOf(v) : (v as any).__tabIndex ?? null;
          console.log('[main] view did-navigate url=', url, 'containerId=', container.id, 'sessionId=', sessionId, 'tabIndex=', tabIndex, 'isRestoring=', isRestoringGlobal);
          if (!isRestoringGlobal) {
            DB.addOrUpdateTab({ containerId: container.id, sessionId, url, tabIndex, updatedAt: Date.now() });
          }
        } catch (e) { console.error('[main] DB.addOrUpdateTab error', e); }
        try {
          const entry = openedById.get(container.id);
          if (entry) {
            const tabs = entry.views.map(vv => ({ url: vv.webContents.getURL(), title: vv.webContents.getTitle?.() }));
            win.webContents.send('container.context', { containerId: container.id, sessionId, fingerprint: container.fingerprint, currentUrl: url, tabs });
          }
        } catch (e) { console.error('[main] sendCtx from view did-navigate error', e); }
      });
      v.webContents.on('did-finish-load', () => {
        try {
          const entry = openedById.get(container.id);
          const tabIndex = entry ? entry.views.indexOf(v) : (v as any).__tabIndex ?? null;
          const url = v.webContents.getURL();
          console.log('[main] view did-finish-load url=', url, 'containerId=', container.id, 'sessionId=', sessionId, 'tabIndex=', tabIndex);
        } catch (e) { console.error('[main] did-finish-load handler error', e); }
      });
      v.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
        try {
          const entry = openedById.get(container.id);
          const tabIndex = entry ? entry.views.indexOf(v) : (v as any).__tabIndex ?? null;
          console.error('[main] view did-fail-load', {
            url: validatedURL,
            errorCode,
            errorDescription,
            isMainFrame,
            containerId: container.id,
            sessionId,
            tabIndex,
            proxy: container.proxy ? { server: container.proxy.server, hasUsername: !!container.proxy.username, hasPassword: !!container.proxy.password } : null
          });
        } catch (e) { console.error('[main] did-fail-load handler error', e); }
      });
      v.webContents.on('page-title-updated', (_e, title) => {
        try {
          const entry = openedById.get(container.id);
          const tabIndex = entry ? entry.views.indexOf(v) : (v as any).__tabIndex ?? null;
          console.log('[main] view title-updated title=', title, 'containerId=', container.id, 'sessionId=', sessionId, 'tabIndex=', tabIndex);
          DB.addOrUpdateTab({ containerId: container.id, sessionId, url: v.webContents.getURL(), tabIndex, title, updatedAt: Date.now() });
        } catch (e) { console.error('[main] DB.addOrUpdateTab title error', e); }
        try {
          const entry = openedById.get(container.id);
          if (entry) {
            const tabs = entry.views.map(vv => ({ url: vv.webContents.getURL(), title: vv.webContents.getTitle?.() }));
            win.webContents.send('container.context', { containerId: container.id, sessionId, fingerprint: container.fingerprint, currentUrl: v.webContents.getURL(), tabs });
          }
        } catch (e) { console.error('[main] sendCtx from view title-updated error', e); }
      });
      v.webContents.on('page-favicon-updated', (_e, favs) => {
        try {
          const entry = openedById.get(container.id);
          const tabIndex = entry ? entry.views.indexOf(v) : (v as any).__tabIndex ?? null;
          console.log('[main] view favicon-updated fav=', favs && favs[0], 'containerId=', container.id, 'sessionId=', sessionId, 'tabIndex=', tabIndex);
          DB.addOrUpdateTab({ containerId: container.id, sessionId, url: v.webContents.getURL(), tabIndex, favicon: favs[0], updatedAt: Date.now() });
        } catch (e) { console.error('[main] DB.addOrUpdateTab favicon error', e); }
        try {
          const entry = openedById.get(container.id);
          if (entry) {
            const tabs = entry.views.map(vv => ({ url: vv.webContents.getURL(), title: vv.webContents.getTitle?.() }));
            win.webContents.send('container.context', { containerId: container.id, sessionId, fingerprint: container.fingerprint, currentUrl: v.webContents.getURL(), tabs });
          }
        } catch (e) { console.error('[main] sendCtx from view favicon-updated error', e); }
      });
      // When DevTools is opened/closed for this view, update the tab title/icon to make it clear
      try {
        v.webContents.on('devtools-opened', () => {
          try {
            const entry = openedById.get(container.id);
            const tabIndex = entry ? entry.views.indexOf(v) : (v as any).__tabIndex ?? 0;
            const containerRecord = DB.getContainer(container.id) || { name: undefined };
            const containerName = containerRecord.name ?? container.name ?? '';
            DB.addOrUpdateTab({ containerId: container.id, sessionId, url: v.webContents.getURL(), tabIndex, title: `Dev-${containerName}`, favicon: '/favicon.ico', scrollY: 0, updatedAt: Date.now() });
            const ctx = getContextForWindow(win);
            if (ctx) win.webContents.send('container.context', ctx);
            try { win.webContents.send('container.devtoolsChanged', { containerId: container.id, tabIndex, isOpen: true, containerName }); } catch (e) { /* ignore */ }
          } catch (e) { console.error('[main] devtools-opened handler error', e); }
        });
        v.webContents.on('devtools-closed', () => {
          try {
            const entry = openedById.get(container.id);
            const tabIndex = entry ? entry.views.indexOf(v) : (v as any).__tabIndex ?? 0;
            // restore title from page when devtools closed
            const title = v.webContents.getTitle?.() ?? null;
            DB.addOrUpdateTab({ containerId: container.id, sessionId, url: v.webContents.getURL(), tabIndex, title, favicon: null, scrollY: 0, updatedAt: Date.now() });
            const ctx = getContextForWindow(win);
            if (ctx) win.webContents.send('container.context', ctx);
            try { win.webContents.send('container.devtoolsChanged', { containerId: container.id, tabIndex, isOpen: false, containerName: containerRecord.name ?? container.name ?? '' }); } catch (e) { /* ignore */ }
          } catch (e) { console.error('[main] devtools-closed handler error', e); }
        });
      } catch (e) { /* ignore if devtools events unsupported */ }
    } catch (e) { console.error('[main] createView attach handlers error', e); }

    if (u) v.webContents.loadURL(u).catch(()=>{});
    // initialize tabIndex placeholder - will be assigned when view is added to entry.views
    try { (v as any).__tabIndex = null; } catch {}
    return v;
  };

  const firstView = createView(startUrl || 'about:blank');
  win.setBrowserView(firstView);
  const entry: OpenedContainer = { win, views: [firstView], activeIndex: 0, sessionId };
  openedById.set(container.id, entry);
  // 初期タブ情報をシェルに送る
  try { console.log('[main] initial sendCtx for', container.id); sendCtx(); } catch {}
  // Ensure there are at least three BrowserViews so renderer tab indices match,
  // unless singleTab option requested.
  try {
    if (!opts.singleTab) {
      while (entry.views.length < 3) {
        const vNew = createView('about:blank');
        entry.views.push(vNew);
      }
    }
    // assign tabIndex values according to array index
    entry.views.forEach((vv, i) => { try { (vv as any).__tabIndex = i; } catch {} });
    // do not set additional views as visible; keep firstView shown
    // send updated context so renderer sees at least three tabs
    try {
      const ctx = getContextForWindow(win);
      if (ctx) win.webContents.send('container.context', ctx);
    } catch {}
  } catch (e) { console.error('[main] ensure three views error', e); }
  win.on('closed', () => { openedById.delete(container.id); DB.closeSession(sessionId, Date.now()); });

  // 復元ロジック（2タブのみ復元）
  const shouldRestore = opts.restore ?? true;
  let restoreUrls: string[] = [];
  if (!startUrl && shouldRestore && prevLastSessionId) {
    try {
      console.log('[main] attempting restore from prevLastSessionId=', prevLastSessionId);
      const prevTabs = DB.tabsOfSession(prevLastSessionId) || [];
      // Filter out shell/renderer URLs (containerShell.html, file://, dev server) and keep only http(s) URLs
      const candidates = (prevTabs || [])
        .map((t:any) => (t && t.url) ? String(t.url) : '')
        .filter((u:string) => !!u && /^https?:\/\//i.test(u));
      if (candidates.length > 0) {
        restoreUrls = candidates.slice(0, 3);
        // attempt to ensure at least the first two are different when possible
        if (restoreUrls.length >= 2 && restoreUrls[0] === restoreUrls[1]) {
          const altCandidates = (prevTabs || []).map((t:any)=> (t && t.url) ? String(t.url) : '').filter((u:string)=> !!u && /^https?:\/\//i.test(u));
          const alt = altCandidates.find((u:string) => u !== restoreUrls[0]);
          if (alt) restoreUrls[1] = alt;
        }
      }
    } catch (e) { console.error('[main] restore tabs error', e); }
  }
  const firstTarget = startUrl || (restoreUrls[0] ?? 'about:blank');
  const secondTarget = restoreUrls[1] ?? 'about:blank';
  const thirdTarget = restoreUrls[2] ?? 'about:blank';

  // シェルUI（簡易アドレスバー付き）
  // During development, prefer the renderer dev server so UI changes are hot-reloaded.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  const shellHtml = devUrl ? `${devUrl.replace(/\/\/$/, '')}/containerShell.html` : new URL('file://' + path.join(app.getAppPath(), 'out', 'renderer', 'containerShell.html')).toString();
  await win.loadURL(shellHtml);
  // load restored URLs into the two views (firstView and second view if present).
  // If singleTab option is set, only load the first target.
  if (restoreUrls.length > 0) {
    try {
      isRestoringGlobal = true;
      console.log('[main] starting restore load: firstTarget=', firstTarget, 'secondTarget=', secondTarget);
      // ensure tabIndex assignment
      entry.views.forEach((vv, i) => { try { (vv as any).__tabIndex = i; } catch {} });
      // load sequentially and wait finish
      try { await firstView.webContents.loadURL(firstTarget); } catch (e) { console.error('[main] load firstTarget error', e); }
      if (!opts.singleTab) {
        if (entry.views[1]) {
          try { await entry.views[1].webContents.loadURL(secondTarget); } catch (e) { console.error('[main] load secondTarget error', e); }
        }
        if (entry.views[2]) {
          try { await entry.views[2].webContents.loadURL(thirdTarget); } catch (e) { console.error('[main] load thirdTarget error', e); }
        }
      }
      // after loads, write canonical entries into DB with tabIndex
      try {
        const ctxTabs = entry.views.map((vv:any, i:number) => ({ url: vv.webContents.getURL(), tabIndex: i, title: vv.webContents.getTitle?.(), favicon: vv.webContents.getURL && undefined }));
        console.log('[main] restore finished, writing canonical tabs to DB:', ctxTabs);
        for (const t of ctxTabs) {
          try { DB.addOrUpdateTab({ containerId: container.id, sessionId, url: t.url, tabIndex: t.tabIndex, title: t.title ?? null, favicon: null, scrollY: 0, updatedAt: Date.now() }); } catch (e) { console.error('[main] addOrUpdateTab restore write error', e); }
        }
      } catch (e) { console.error('[main] restore db write error', e); }
    } finally { isRestoringGlobal = false; }
  }
  win.show();

  return win;
}

export function closeAllContainers() {
  try {
    console.log('[main] closeAllContainers: closing', openedById.size, 'containers');
    for (const entry of openedById.values()) {
      try { entry.win.close(); } catch {}
    }
    openedById.clear();
  } catch {}
}

export function closeAllNonMainWindows() {
  try {
    const all = BrowserWindow.getAllWindows();
    console.log('[main] closeAllNonMainWindows: total windows=', all.length);
    for (const w of all) {
      try {
        // prefer explicit flag
        const isShell = !!((w as any).__isContainerShell);
        const url = (w.webContents && typeof w.webContents.getURL === 'function') ? (w.webContents.getURL() || '') : '';
        const looksLikeShell = url.includes('containerShell.html') || url.includes('/containerShell.html');
        if (isShell || looksLikeShell) {
          console.log('[main] closeAllNonMainWindows: closing window url=', url, 'isShellFlag=', isShell);
          try { w.close(); } catch {}
        }
      } catch (e) { console.error('[main] closeAllNonMainWindows error', e); }
    }
  } catch {}
}

export function forceCloseAllNonMainWindows() {
  try {
    const all = BrowserWindow.getAllWindows();
    for (const w of all) {
      try {
        const isShell = !!((w as any).__isContainerShell);
        const url = (w.webContents && typeof w.webContents.getURL === 'function') ? (w.webContents.getURL() || '') : '';
        const looksLikeShell = url.includes('containerShell.html') || url.includes('/containerShell.html');
        if (isShell || looksLikeShell) {
          try { w.destroy(); } catch {}
        }
      } catch {}
    }
  } catch {}
}

export function getContextForWindow(win: BrowserWindow) {
  for (const [containerId, entry] of openedById.entries()) {
    if (entry.win === win) {
      const containerRecord = DB.getContainer(containerId) || { name: undefined };
      const containerName = containerRecord.name ?? '';
      // helper: treat devtools pages as Dev tabs
      const isDevtoolsUrl = (u: string) => {
        if (!u) return false;
        try {
          // common indicators for devtools pages
          return u.startsWith('devtools://') || u.includes('chrome-devtools') || u.includes('devtools') || u.includes('about:blank') && u.includes('devtools');
        } catch { return false; }
      };
      const tabs = entry.views.map(v => {
        const url = v.webContents.getURL();
        let title = v.webContents.getTitle?.() ?? null;
        let favicon: string | null = null;
        try {
          // If this view currently has DevTools opened, force Dev-<containerName>
          if (typeof v.webContents.isDevToolsOpened === 'function' && v.webContents.isDevToolsOpened()) {
            title = `Dev-${containerName}`;
            favicon = '/favicon.ico';
            return { url, title, favicon };
          }
        } catch {}
        if (isDevtoolsUrl(String(url))) {
          title = `Dev-${containerName}`;
          // use common favicon served by renderer (dev server provides /favicon.ico)
          favicon = '/favicon.ico';
        }
        return { url, title, favicon };
      });
      const activeView = entry.views[entry.activeIndex] || entry.views[0];
      const currentUrl = activeView ? activeView.webContents.getURL() : undefined;
      try { entry.win.setTitle(containerName || 'コンテナシェル'); } catch {}
      return { containerId, sessionId: entry.sessionId, fingerprint: containerRecord.fingerprint, currentUrl, tabs, containerName };
    }
  }
  return null;
}

export function createTab(containerId: string, url: string) {
  console.log('[main] createTab request', { containerId, url, openedByIdSize: openedById.size });
  const entry = openedById.get(containerId);
  if (!entry) {
    console.warn('[main] createTab called but no opened entry for containerId=', containerId);
    console.warn('[main] openedById keys=', Array.from(openedById.keys()));
    return false;
  }
  const { win } = entry;
  const viewPreloadPath = path.join(app.getAppPath(), 'out', 'preload', 'containerPreload.cjs');
  const v = new BrowserView({ webPreferences: { partition: entry.win.webContents.getWebPreferences().partition as any, contextIsolation: true, nodeIntegration: false, preload: viewPreloadPath, backgroundThrottling: false } });
  
  // Set containerId on view's webContents for app.on('login') handler
  try {
    (v.webContents as any)._containerId = containerId;
  } catch (e) {
    console.error('[main] failed to set containerId on createTab view webContents', e);
  }
  
  const layoutView = () => {
    const [w, h] = win.getContentSize();
    const bar = BAR_HEIGHT; // use global BAR_HEIGHT so views align with shell UI
    v.setBounds({ x: 0, y: bar, width: w, height: Math.max(0, h - bar) });
  };
  win.on('resize', layoutView);
  layoutView();
  v.webContents.loadURL(url || 'about:blank').catch(()=>{});
  // record tab in DB under current session
  try { DB.addOrUpdateTab({ containerId, sessionId: entry.sessionId, url: url || 'about:blank', title: null, favicon: null, scrollY: 0, updatedAt: Date.now() }); } catch {}
  entry.views.push(v);
  entry.activeIndex = entry.views.length - 1;
  win.setBrowserView(v);
  try { entry.win.focus(); try { v.webContents.focus(); } catch {} } catch {}
  // タブ変更をシェルへ通知
  try {
    const tabs = entry.views.map(v => ({ url: v.webContents.getURL(), title: v.webContents.getTitle?.() }));
    console.log('[main] createTab sendCtx', { containerId, sessionId: entry.sessionId, url: v.webContents.getURL(), tabsLength: tabs.length });
    win.webContents.send('container.context', { containerId, sessionId: entry.sessionId, fingerprint: container.fingerprint, currentUrl: v.webContents.getURL(), tabs });
  } catch {}
  return true;
}

export function switchTab(containerId: string, index: number) {
  const entry = openedById.get(containerId);
  if (!entry) return false;
  if (index < 0 || index >= entry.views.length) return false;
  const v = entry.views[index];
  entry.activeIndex = index;
  try { entry.win.setBrowserView(v); try { entry.win.focus(); v.webContents.focus(); } catch {} } catch {}
  try {
    // send updated context to shell
    const ctx = getContextForWindow(entry.win);
    if (ctx) entry.win.webContents.send('container.context', ctx);
  } catch {}
  return true;
}

export function closeTab(containerId: string, index: number) {
  const entry = openedById.get(containerId);
  if (!entry) return false;
  console.log('[main] closeTab request', { containerId, index, viewsBefore: entry.views.length });
  if (index < 0 || index >= entry.views.length) return false;
  // log current view urls
  try {
    const urlsBefore = entry.views.map(vv => { try { return vv.webContents.getURL(); } catch { return '<err>'; } });
    console.log('[main] views before close', urlsBefore);
  } catch {}
  // If this is the only view, create a new blank view first so renderer always has a view
  if (entry.views.length === 1) {
    try {
      const container = DB.getContainer(containerId);
      const viewPreloadPath = path.join(app.getAppPath(), 'out', 'preload', 'containerPreload.cjs');
      const vNew = new BrowserView({ webPreferences: { partition: entry.win.webContents.getWebPreferences().partition as any, contextIsolation: true, nodeIntegration: false, preload: viewPreloadPath, backgroundThrottling: false } });
      const layoutViewNew = () => {
        try {
          const [w, h] = entry.win.getContentSize();
          const bar = BAR_HEIGHT;
          vNew.setBounds({ x: 0, y: bar, width: w, height: Math.max(0, h - bar) });
        } catch {}
      };
      entry.win.on('resize', layoutViewNew);
      layoutViewNew();
      try { vNew.webContents.setZoomFactor(container?.fingerprint?.deviceScaleFactor || 1.0); } catch {}
      vNew.webContents.loadURL('about:blank').catch(()=>{});
      entry.views.push(vNew);
      // set the new view visible before removing the old one
      try { entry.win.setBrowserView(vNew); } catch {}
    } catch (e) { console.error('[main] error creating blank view before close', e); }
  }

  const v = entry.views[index];
  try {
    // switch to another view if possible
    const otherIndex = (index === 0) ? 1 : 0;
    if (entry.views.length > 1 && entry.views[otherIndex]) {
      try { entry.win.setBrowserView(entry.views[otherIndex]); } catch {}
    }
    console.log('[main] removing view at index', index);
    try { entry.win.removeBrowserView(v); } catch (e) { console.error('[main] removeBrowserView error', e); }
    try { v.webContents.destroy(); } catch (e) { console.error('[main] destroy view error', e); }
  } catch (e) { console.error('[main] error removing view', e); }
  entry.views.splice(index, 1);
  if (entry.activeIndex >= entry.views.length) entry.activeIndex = Math.max(0, entry.views.length - 1);
  // prefer to set a valid view if available
  if (entry.views.length > 0) {
    try { entry.win.setBrowserView(entry.views[entry.activeIndex]); } catch {}
  } else {
    try { entry.win.setBrowserView(null as any); } catch {}
  }
  try {
    const urlsAfter = entry.views.map(vv => { try { return vv.webContents.getURL(); } catch { return '<err>'; } });
    console.log('[main] views after close', urlsAfter);
  } catch {}
  // If all tabs closed, create a new blank tab to avoid empty view
  if (entry.views.length === 0) {
    try {
      const container = DB.getContainer(containerId);
      // create a new BrowserView similar to createTab
      const viewPreloadPath = path.join(app.getAppPath(), 'out', 'preload', 'containerPreload.cjs');
      const v2 = new BrowserView({ webPreferences: { partition: entry.win.webContents.getWebPreferences().partition as any, contextIsolation: true, nodeIntegration: false, preload: viewPreloadPath, backgroundThrottling: false } });
      const layoutView2 = () => {
        try {
          const [w, h] = entry.win.getContentSize();
          const bar = BAR_HEIGHT;
          v2.setBounds({ x: 0, y: bar, width: w, height: Math.max(0, h - bar) });
        } catch {}
      };
      entry.win.on('resize', layoutView2);
      layoutView2();
      try { v2.webContents.setZoomFactor(container?.fingerprint?.deviceScaleFactor || 1.0); } catch {}
      v2.webContents.loadURL('about:blank').catch(()=>{});
      entry.views.push(v2);
      entry.activeIndex = 0;
      entry.win.setBrowserView(v2);
      const ctx = getContextForWindow(entry.win);
      if (ctx) entry.win.webContents.send('container.context', ctx);
    } catch (e) { console.error('[main] error creating blank tab after close', e); }
  }
  else {
    // send updated context when there are still views
    try {
      const ctx = getContextForWindow(entry.win);
      if (ctx) entry.win.webContents.send('container.context', ctx);
    } catch {}
  }
  return true;
}

export function listTabs(sessionId: string) {
  return DB.tabsOfSession(sessionId);
}

export function navigateContainer(containerId: string, url: string) {
  const item = openedById.get(containerId);
  if (!item) return false;
  const view = item.views[item.activeIndex] || item.views[0];
  try { view.webContents.loadURL(url); } catch { return false; }
  return true;
}

ipcMain.handle('container.navigate', (_e, { containerId, url }) => navigateContainer(containerId, url));

export function goBack(containerId: string) {
  const it = openedById.get(containerId);
  if (!it) return false;
  try {
    const view = it.views[it.activeIndex] || it.views[0];
    if (view.webContents.canGoBack()) { view.webContents.goBack(); return true; }
  } catch {}
  return false;
}

export function goForward(containerId: string) {
  const it = openedById.get(containerId);
  if (!it) return false;
  try {
    const view = it.views[it.activeIndex] || it.views[0];
    if (view.webContents.canGoForward()) { view.webContents.goForward(); return true; }
  } catch {}
  return false;
}

// Return the active BrowserView.webContents for a given containerId, or null if not open
export function getActiveWebContents(containerId: string) {
  try {
    const entry = openedById.get(containerId);
    if (!entry) return null;
    const view = entry.views[entry.activeIndex] || entry.views[0];
    return view ? view.webContents : null;
  } catch (e) { return null; }
}

ipcMain.handle('tabs.goBack', (_e, { containerId }) => goBack(containerId));
ipcMain.handle('tabs.goForward', (_e, { containerId }) => goForward(containerId));
