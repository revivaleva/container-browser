import { contextBridge, ipcRenderer } from 'electron';
import logger from '../shared/logger';

contextBridge.exposeInMainWorld('containersAPI', {
  list: () => ipcRenderer.invoke('containers.list'),
  setNote: (payload: { id: string; note: string | null }) => ipcRenderer.invoke('containers.setNote', payload),
  create: (payload: any) => ipcRenderer.invoke('containers.create', payload),
  open: (payload: any) => ipcRenderer.invoke('containers.open', payload),
  openByName: (payload: any) => ipcRenderer.invoke('containers.openByName', payload),
  delete: (payload: any) => ipcRenderer.invoke('containers.delete', payload),
  update: (payload: any) => ipcRenderer.invoke('containers.update', payload),
  saveCredential: (payload: any) => ipcRenderer.invoke('vault.saveCredential', payload)
});

// (containerShellAPI is defined below together with tabsAPI; do not duplicate exposeInMainWorld)

contextBridge.exposeInMainWorld('proxyAPI', {
  test: (payload: any) => ipcRenderer.invoke('proxy.test', payload),
});
contextBridge.exposeInMainWorld('bookmarksAPI', {
  list: () => ipcRenderer.invoke('bookmarks.list'),
  add: (payload: any) => ipcRenderer.invoke('bookmarks.add', payload),
  delete: (payload: any) => ipcRenderer.invoke('bookmarks.delete', payload),
  reorder: (payload: { ids: string[] }) => ipcRenderer.invoke('bookmarks.reorder', payload),
});

contextBridge.exposeInMainWorld('prefsAPI', {
  get: (payload: { containerId: string; origin: string }) => ipcRenderer.invoke('prefs.get', payload),
  set: (payload: { containerId: string; origin: string; autoFill: 0|1; autoSaveForms: 0|1 }) => ipcRenderer.invoke('prefs.set', payload),
});

// Shell 用: コンテナコンテキスト受信とナビゲーション
const __ctxListeners = new Set<(ctx: any) => void>();
ipcRenderer.on('container.context', (_e, ctx) => {
  for (const cb of __ctxListeners) {
    try { cb(ctx); } catch {}
  }
});
// DevTools change notification listeners
const __devtoolsListeners = new Set<(payload: any) => void>();
ipcRenderer.on('container.devtoolsChanged', (_e, payload) => {
  for (const cb of __devtoolsListeners) {
    try { cb(payload); } catch {}
  }
});
contextBridge.exposeInMainWorld('containerShellAPI', {
  onContext: (cb: (ctx: any) => void) => { __ctxListeners.add(cb); return () => __ctxListeners.delete(cb); },
  navigate: (payload: { containerId: string; url: string }) => ipcRenderer.invoke('container.navigate', payload),
  onDevtoolsChange: (cb: (payload: any) => void) => { __devtoolsListeners.add(cb); return () => __devtoolsListeners.delete(cb); }
});
contextBridge.exposeInMainWorld('tabsAPI', {
  navigate: (payload: { containerId: string; url: string }) => ipcRenderer.invoke('tabs.navigate', payload),
  goBack: (payload: { containerId: string }) => ipcRenderer.invoke('tabs.goBack', payload),
  goForward: (payload: { containerId: string }) => ipcRenderer.invoke('tabs.goForward', payload),
  createTab: (payload: { containerId: string; url: string }) => ipcRenderer.invoke('tabs.create', payload),
  switchTab: (payload: { containerId: string; index: number }) => ipcRenderer.invoke('tabs.switch', payload),
  closeTab: (payload: { containerId: string; index: number }) => ipcRenderer.invoke('tabs.close', payload),
});

// forward renderer console messages to main for easier debugging
ipcRenderer.on('forward-log', (_e, msg) => {
  try { logger.debug('[preload-forward]', msg); } catch {}
});

// DevTools control for renderer: toggle DevTools when requested (e.g. F12)
contextBridge.exposeInMainWorld('devtoolsAPI', {
  toggle: () => ipcRenderer.invoke('devtools.toggle'),
  toggleView: () => ipcRenderer.invoke('devtools.toggleView')
});

contextBridge.exposeInMainWorld('appAPI', {
  getVersion: () => ipcRenderer.invoke('app.getVersion'),
  checkForUpdates: () => ipcRenderer.invoke('app.checkForUpdates'),
  exit: () => ipcRenderer.invoke('app.exit'),
  saveToken: (token: string) => ipcRenderer.invoke('auth.saveToken', { token }),
  getToken: () => ipcRenderer.invoke('auth.getToken'),
  clearToken: () => ipcRenderer.invoke('auth.clearToken')
});
contextBridge.exposeInMainWorld('deviceAPI', {
  getDeviceId: () => ipcRenderer.invoke('auth.getDeviceId')
});
// expose validation helper and quota consumption
contextBridge.exposeInMainWorld('authAPI', {
  validateToken: (opts?: any) => ipcRenderer.invoke('auth.validateToken', opts || {}),
  heartbeat: (opts?: any) => ipcRenderer.invoke('auth.heartbeat', opts || {}),
  useQuota: (count?: number) => ipcRenderer.invoke('auth.use', { count: count || 1 }),
  getSettings: () => ipcRenderer.invoke('auth.getSettings'),
  saveSettings: (payload: any) => ipcRenderer.invoke('auth.saveSettings', payload)
});

// Export server settings/status API
contextBridge.exposeInMainWorld('exportAPI', {
  getSettings: () => ipcRenderer.invoke('export.getSettings'),
  saveSettings: (payload: any) => ipcRenderer.invoke('export.saveSettings', payload),
  getStatus: () => ipcRenderer.invoke('export.getStatus'),
  onStatus: (cb: (payload: any) => void) => {
    const listener = (_e: any, payload: any) => { try { cb(payload); } catch {} };
    ipcRenderer.on('export.server.status', listener);
    return () => { try { ipcRenderer.removeListener('export.server.status', listener); } catch {} };
  }
  ,
  onOpenSettings: (cb: () => void) => {
    const listener = () => { try { cb(); } catch {} };
    ipcRenderer.on('open-settings', listener);
    return () => { try { ipcRenderer.removeListener('open-settings', listener); } catch {} };
  }
});

// Debug: allow renderer to forward arbitrary log messages to the main process (will appear in terminal)
contextBridge.exposeInMainWorld('debugAPI', {
  log: (msg: any) => { try { ipcRenderer.send('renderer.log', msg); } catch { } }
});