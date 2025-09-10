import { app, BrowserWindow, BrowserView, ipcMain, session } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Container } from '../shared/types';
import { DB } from './db';
import { existsSync } from 'node:fs';

type OpenOpts = { restore?: boolean };

type OpenedContainer = { win: BrowserWindow; views: BrowserView[]; activeIndex: number; sessionId: string };
const openedById = new Map<string, OpenedContainer>();
let isRestoringGlobal = false;

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
    await ses.setProxy({ proxyRules: container.proxy.server });
    ses.on('login', (_e, _w, _d, cb) => {
      if (container.proxy?.username) cb(container.proxy.username, container.proxy.password ?? '');
    });
  } else {
    await ses.setProxy({ mode: 'system' });
  }

  // Accept-Language を上書き
  try {
    const acceptLang = container.fingerprint?.acceptLanguage || 'ja,en-US;q=0.8,en;q=0.7';
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const headers = { ...details.requestHeaders, 'Accept-Language': acceptLang } as any;
      cb({ requestHeaders: headers });
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
      preload: shellPreloadPath
    }
  });
  // set window icon if available
  try {
    const ico = path.join(app.getAppPath(), 'build-resources', 'Icon.ico');
    if (existsSync(ico)) win.setIcon(ico as any);
  } catch (e) { console.error('[main] set container window icon error', e); }
  // mark this window as a container shell so main can detect and close it reliably
  try { (win as any).__isContainerShell = true; (win as any).__containerId = container.id; } catch {}
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
      const tabs = entry ? entry.views.map(v => ({ url: v.webContents.getURL(), title: v.webContents.getTitle?.() })) : [];
      const activeIndex = entry ? entry.activeIndex : 0;
      const activeView = entry ? (entry.views[activeIndex] || entry.views[0]) : null;
      const currentUrl = activeView ? activeView.webContents.getURL() : undefined;
      console.log('[main] sendCtx', { containerId: container.id, sessionId, currentUrl, tabsLength: tabs.length, activeIndex });
      win.webContents.send('container.context', { containerId: container.id, sessionId, fingerprint: container.fingerprint, currentUrl, tabs, activeIndex });
    } catch {}
  };
  win.webContents.on('did-finish-load', sendCtx);

  // BrowserView を作成（実ページ）
  const viewPreloadPath = path.join(app.getAppPath(), 'out', 'preload', 'containerPreload.cjs');
  const createView = (u: string) => {
    const v = new BrowserView({ webPreferences: { partition: part, contextIsolation: true, nodeIntegration: false, preload: viewPreloadPath } });
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
  // Ensure there are at least two BrowserViews so renderer tab indices match
  try {
    if (entry.views.length < 2) {
      const v2 = createView('about:blank');
      entry.views.push(v2);
      // assign tabIndex values according to array index
      entry.views.forEach((vv, i) => { try { (vv as any).__tabIndex = i; } catch {} });
      // do not set v2 as visible; keep firstView shown
      // send updated context so renderer sees two tabs
      try {
        const ctx = getContextForWindow(win);
        if (ctx) win.webContents.send('container.context', ctx);
      } catch {}
    }
  } catch (e) { console.error('[main] ensure two views error', e); }
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
        restoreUrls = candidates.slice(0, 2);
        // if both chosen urls are identical, try to pick a different second candidate from prevTabs
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

  // シェルUI（簡易アドレスバー付き）
  // During development, prefer the renderer dev server so UI changes are hot-reloaded.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  const shellHtml = devUrl ? `${devUrl.replace(/\/\/$/, '')}/containerShell.html` : new URL('file://' + path.join(app.getAppPath(), 'out', 'renderer', 'containerShell.html')).toString();
  await win.loadURL(shellHtml);
  // load restored URLs into the two views (firstView and second view if present)
  if (restoreUrls.length > 0) {
    try {
      isRestoringGlobal = true;
      console.log('[main] starting restore load: firstTarget=', firstTarget, 'secondTarget=', secondTarget);
      // ensure tabIndex assignment
      entry.views.forEach((vv, i) => { try { (vv as any).__tabIndex = i; } catch {} });
      // load sequentially and wait finish
      try { await firstView.webContents.loadURL(firstTarget); } catch (e) { console.error('[main] load firstTarget error', e); }
      if (entry.views[1]) {
        try { await entry.views[1].webContents.loadURL(secondTarget); } catch (e) { console.error('[main] load secondTarget error', e); }
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
      const tabs = entry.views.map(v => ({ url: v.webContents.getURL(), title: v.webContents.getTitle?.() }));
      const activeView = entry.views[entry.activeIndex] || entry.views[0];
      const currentUrl = activeView ? activeView.webContents.getURL() : undefined;
      return { containerId, sessionId: entry.sessionId, fingerprint: (DB.getContainer(containerId) || {}).fingerprint, currentUrl, tabs };
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
  const v = new BrowserView({ webPreferences: { partition: entry.win.webContents.getWebPreferences().partition as any, contextIsolation: true, nodeIntegration: false, preload: viewPreloadPath } });
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
      const viewPreloadPath = path.join(app.getAppPath(), 'out', 'preload', 'containerPreload.cjs');
      const vNew = new BrowserView({ webPreferences: { partition: entry.win.webContents.getWebPreferences().partition as any, contextIsolation: true, nodeIntegration: false, preload: viewPreloadPath } });
      const layoutViewNew = () => {
        try {
          const [w, h] = entry.win.getContentSize();
          const bar = BAR_HEIGHT;
          vNew.setBounds({ x: 0, y: bar, width: w, height: Math.max(0, h - bar) });
        } catch {}
      };
      entry.win.on('resize', layoutViewNew);
      layoutViewNew();
      try { vNew.webContents.setZoomFactor(container.fingerprint?.deviceScaleFactor || 1.0); } catch {}
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
      // create a new BrowserView similar to createTab
      const viewPreloadPath = path.join(app.getAppPath(), 'out', 'preload', 'containerPreload.cjs');
      const v2 = new BrowserView({ webPreferences: { partition: entry.win.webContents.getWebPreferences().partition as any, contextIsolation: true, nodeIntegration: false, preload: viewPreloadPath } });
      const layoutView2 = () => {
        try {
          const [w, h] = entry.win.getContentSize();
          const bar = BAR_HEIGHT;
          v2.setBounds({ x: 0, y: bar, width: w, height: Math.max(0, h - bar) });
        } catch {}
      };
      entry.win.on('resize', layoutView2);
      layoutView2();
      try { v2.webContents.setZoomFactor(container.fingerprint?.deviceScaleFactor || 1.0); } catch {}
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

ipcMain.handle('tabs.goBack', (_e, { containerId }) => goBack(containerId));
ipcMain.handle('tabs.goForward', (_e, { containerId }) => goForward(containerId));
