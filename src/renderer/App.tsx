import React, { useEffect, useMemo, useState } from 'react';

type Container = any;

declare global {
  interface Window {
    exportAPI?: {
      getSettings: () => Promise<any>;
      saveSettings: (payload: any) => Promise<any>;
      getStatus: () => Promise<any>;
      onStatus: (cb: (payload: any) => void) => () => void;
      onOpenSettings?: (cb: () => void) => () => void;
    };
    containersAPI: {
      list: () => Promise<Container[]>;
      create: (payload: any) => Promise<Container>;
      open: (payload: { id: string; url?: string }) => Promise<boolean>;
      update: (payload: any) => Promise<Container>;
      delete: (payload: { id: string }) => Promise<boolean>;
      openByName: (payload: { name: string; url?: string }) => Promise<boolean>;
    };
    prefsAPI: {
      get: (payload: { containerId: string; origin: string }) => Promise<any>;
      set: (payload: { containerId: string; origin: string; autoFill: 0|1; autoSaveForms: 0|1 }) => Promise<boolean>;
    };
    authAPI?: {
      validateToken: (opts?: any) => Promise<any>;
      useQuota?: (count?: number) => Promise<any>;
      getSettings?: () => Promise<any>;
      saveSettings?: (payload: any) => Promise<any>;
    };
    appAPI?: {
      getToken: () => Promise<any>;
      saveToken: (token: string) => Promise<any>;
      clearToken: () => Promise<any>;
      getVersion: () => Promise<string>;
      checkForUpdates: () => Promise<any>;
      exit: () => Promise<any>;
    };
    deviceAPI?: {
      getDeviceId: () => Promise<any>;
    };
  }
}

export default function App() {
  const [list, setList] = useState<Container[]>([]);
  const [name, setName] = useState('新しいコンテナ');
  const [url, setUrl] = useState('https://www.google.com');
  // per-container URL inputs removed; bookmarks are global
  const [bookmarks, setBookmarks] = useState<any[]>([]);
  const [selectedBookmarkId, setSelectedBookmarkId] = useState<string | null>(null);
  const [addBookmarkGlobal, setAddBookmarkGlobal] = useState<boolean>(true);
  const [openSettingsId, setOpenSettingsId] = useState<string | null>(null);
  const [modalLocale, setModalLocale] = useState<string>('ja-JP');
  const [modalAcceptLang, setModalAcceptLang] = useState<string>('ja,en-US;q=0.8,en;q=0.7');
  const [modalTimezone, setModalTimezone] = useState<string>('Asia/Tokyo');
  const [modalContainerName, setModalContainerName] = useState<string>('');
  const [modalProxyServer, setModalProxyServer] = useState<string>('');
  const [modalProxyUsername, setModalProxyUsername] = useState<string>('');
  const [modalProxyPassword, setModalProxyPassword] = useState<string>('');
  const [modalProxyType, setModalProxyType] = useState<'http' | 'socks5'>('http');
  const [modalNote, setModalNote] = useState<string>('');
  const [modalStatus, setModalStatus] = useState<string>('未使用');
  const [fpLocale, setFpLocale] = useState('ja-JP');
  const [fpAcceptLang, setFpAcceptLang] = useState('ja,en-US;q=0.8,en;q=0.7');
  const [fpTimezone, setFpTimezone] = useState('Asia/Tokyo');
  const [fpCores, setFpCores] = useState<number>(8);
  const [fpRam, setFpRam] = useState<number>(8);
  const [fpViewportW, setFpViewportW] = useState<number>(1280);
  const [fpViewportH, setFpViewportH] = useState<number>(800);
  const [fpColorDepth, setFpColorDepth] = useState<number>(24);
  const [fpMaxTouch, setFpMaxTouch] = useState<number>(0);
  const [fpConn, setFpConn] = useState<string>('4g');
  const [fpFakeIp, setFpFakeIp] = useState<boolean>(false);
  const [fpCookie, setFpCookie] = useState<boolean>(true);
  const [fpWebglVendor, setFpWebglVendor] = useState<string>('Google Inc.');
  const [fpWebglRenderer, setFpWebglRenderer] = useState<string>('ANGLE (NVIDIA)');
  const [modalSiteOrigin, setModalSiteOrigin] = useState<string>('');
  const [modalSiteAutoFill, setModalSiteAutoFill] = useState<boolean>(false);
  const [modalSiteAutoSave, setModalSiteAutoSave] = useState<boolean>(false);

  const [containerUrls, setContainerUrls] = useState<Record<string,string>>({});
  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
  const [editBmTitle, setEditBmTitle] = useState<string>('');
  const [editBmUrl, setEditBmUrl] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // site prefs
  const [selectedContainerId, setSelectedContainerId] = useState<string>('');
  const [origin, setOrigin] = useState('https://example.com');
  const [autoFill, setAutoFill] = useState<boolean>(false);
  const [autoSaveForms, setAutoSaveForms] = useState<boolean>(false);
  const selected = useMemo(()=> list.find((c:any)=> c.id === selectedContainerId), [list, selectedContainerId]);
  
  // 検索でフィルタリングされたコンテナ一覧
  const filteredList = useMemo(() => {
    if (!searchQuery.trim()) return list;
    const query = searchQuery.toLowerCase().trim();
    return list.filter((c: any) => c.name?.toLowerCase().includes(query));
  }, [list, searchQuery]);

  async function refresh() {
    const l = await window.containersAPI.list();
    setList(l);
    if (!selectedContainerId && l[0]) setSelectedContainerId(l[0].id);
    const sel = l.find((x:any)=> x.id === (selectedContainerId || (l[0]?.id)));
    if (sel?.fingerprint) {
      setFpLocale(sel.fingerprint.locale || 'ja-JP');
      setFpAcceptLang(sel.fingerprint.acceptLanguage || 'ja,en-US;q=0.8,en;q=0.7');
      setFpTimezone(sel.fingerprint.timezone || 'Asia/Tokyo');
      setFpCores(sel.fingerprint.hardwareConcurrency || 8);
      setFpRam(sel.fingerprint.deviceMemory || 8);
      setFpViewportW(sel.fingerprint.viewportWidth || 1280);
      setFpViewportH(sel.fingerprint.viewportHeight || 800);
      setFpColorDepth(sel.fingerprint.colorDepth || 24);
      setFpMaxTouch(sel.fingerprint.maxTouchPoints || 0);
      setFpConn(sel.fingerprint.connectionType || '4g');
      setFpCookie(sel.fingerprint.cookieEnabled ?? true);
      setFpWebglVendor(sel.fingerprint.webglVendor || '');
      setFpWebglRenderer(sel.fingerprint.webglRenderer || '');
    }
    // load bookmarks for global selector
    try {
      const b = await (window as any).bookmarksAPI.list();
      setBookmarks(b || []);
      (window as any).bookmarksList = b || [];
      if (!selectedBookmarkId && (b || [])[0]) setSelectedBookmarkId(b[0].id);
    } catch {}
  }

  async function loadPref() {
    if (!selectedContainerId || !origin) return;
    const pref = await window.prefsAPI.get({ containerId: selectedContainerId, origin });
    setAutoFill(!!pref?.autoFill);
    setAutoSaveForms(!!pref?.autoSaveForms);
  }

  // helper: normalize proxy input according to selected type
  function normalizeProxyString(type: 'http' | 'socks5', server: string) {
    if (!server) return '';
    const s = server.trim();
    if (type === 'socks5') {
      if (/^socks5:\/\//i.test(s)) return s;
      return `socks5://${s.replace(/^socks5:\/\//i, '')}`;
    }
    // http type: if user provided rule-like string, keep as-is
    if (s.includes('=') || /^http(s)?:\/\//i.test(s)) return s;
    return `http=${s};https=${s}`;
  }

  function detectProxyType(server: string) {
    if (!server) return 'http';
    if (/^socks5:\/\//i.test(server) || /^socks5=/i.test(server)) return 'socks5';
    return 'http';
  }

  function extractHostPort(server: string) {
    if (!server) return '';
    let s = server.trim();

    // If input contains key=value pairs like "http=host:port;https=host:port",
    // parse them robustly (handles spaces and different separators).
    if (s.includes('=')) {
      const pairs = s.split(/[;,]+/).map(p => p.trim()).filter(Boolean);
      // prefer https then http then socks5
      const prefer = ['https', 'http', 'socks5'];
      for (const key of prefer) {
        for (const p of pairs) {
          const m = p.match(new RegExp('^\s*' + key + '\s*=\s*(.+)$', 'i'));
          if (m && m[1]) return m[1].trim();
        }
      }
      // fallback: take the RHS of the first pair
      const first = pairs[0].split('=')[1];
      if (first) return first.trim();
    }

    // remove common URI schemes
    s = s.replace(/^socks5:\/\//i, '');
    s = s.replace(/^http:\/\//i, '');
    s = s.replace(/^https:\/\//i, '');

    // if still contains an equals sign like 'socks5=host:port', handle it
    if (s.includes('=')) {
      const parts = s.split('=');
      return (parts[1] || parts[0] || '').trim();
    }

    return s;
  }

  // Save current modal settings (used by top/bottom save buttons)
  async function saveCurrentSettings() {
    if (!openSettingsId) return;
    const id = openSettingsId;
    const proxy = modalProxyServer ? { server: normalizeProxyString(modalProxyType, modalProxyServer), username: modalProxyUsername || undefined, password: modalProxyPassword || undefined } : null;
    const fingerprint: any = {
      locale: modalLocale,
      acceptLanguage: modalAcceptLang,
      timezone: modalTimezone,
      hardwareConcurrency: fpCores,
      deviceMemory: fpRam,
      viewportWidth: fpViewportW,
      viewportHeight: fpViewportH,
      colorDepth: fpColorDepth,
      maxTouchPoints: fpMaxTouch,
      connectionType: fpConn,
      cookieEnabled: fpCookie,
      webglVendor: fpWebglVendor || undefined,
      webglRenderer: fpWebglRenderer || undefined,
    };
    if (!proxy) fingerprint.fakeIp = fpFakeIp;
    const payload = proxy ? { id, name: modalContainerName, note: modalNote || undefined, status: modalStatus, fingerprint, proxy } : { id, name: modalContainerName, note: modalNote || undefined, status: modalStatus, fingerprint };
    await window.containersAPI.update(payload);
    await refresh();
    setOpenSettingsId(null);
  }

  // Helper: check remaining quota before allowing new container creation
  async function canCreateContainer(): Promise<{ ok: boolean; message?: string }> {
    try {
      // Check if token is set
      const tokenResp = await (window as any).appAPI?.getToken?.();
      const hasToken = !!(tokenResp?.ok && tokenResp?.token);
      
      if (!hasToken) {
        // No token - allow creation without restrictions
        return { ok: true };
      }
      
      // Token exists - check quota
      const validateResp = await (window as any).authAPI.validateToken();
      if (!validateResp || !validateResp.ok) {
        // Token validation failed - still allow creation
        console.warn('[containers] token validation failed, but allowing creation');
        return { ok: true };
      }
      
      if (!validateResp.data || typeof validateResp.data.remaining_quota !== 'number') {
        // Can't determine quota - allow creation
        return { ok: true };
      }
      
      const remaining = validateResp.data.remaining_quota;
      const current = list.length;
      if (current >= remaining) {
        return { ok: false, message: `同時作成数が上限に達しています（現在: ${current}個、上限: ${remaining}個）` };
      }
      return { ok: true };
    } catch (e) {
      // Error checking quota - allow creation anyway
      console.warn('[containers] quota check error, allowing creation:', e);
      return { ok: true };
    }
  }

  // Helper: Setup heartbeat timer based on session_expires_at
  function setupHeartbeatTimer() {
    const expiryStr = localStorage.getItem('session_expires_at');
    if (!expiryStr) return;
    
    const expiryTime = parseInt(expiryStr) * 1000; // Convert to ms
    const now = Date.now();
    const timeUntilExpiry = expiryTime - now;
    const bufferTime = 5 * 60 * 1000; // 5 minutes before expiry
    
    // Cancel existing timer
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    
    // Schedule heartbeat 5 minutes before expiry
    const nextHeartbeatTime = timeUntilExpiry - bufferTime;
    if (nextHeartbeatTime > 0) {
      const timer = setTimeout(() => {
        performHeartbeat();
      }, Math.max(nextHeartbeatTime, 0));
      setHeartbeatTimer(timer);
      console.log('[heartbeat] scheduled in', nextHeartbeatTime / 1000, 'seconds');
    } else {
      // Already expired or about to expire, perform heartbeat now
      performHeartbeat();
    }
  }

  // Helper: Perform heartbeat to extend session
  async function performHeartbeat() {
    try {
      console.log('[heartbeat] executing');
      const validateResp = await (window as any).authAPI?.heartbeat?.();
      if (validateResp?.ok && validateResp?.data) {
        const newSessionExpiry = validateResp.data.session_expires_at;
        localStorage.setItem('session_expires_at', newSessionExpiry.toString());
        console.log('[heartbeat] success, session extended until', new Date(newSessionExpiry * 1000).toLocaleString('ja-JP'));
        // Schedule next heartbeat
        setupHeartbeatTimer();
      } else {
        console.warn('[heartbeat] failed', validateResp?.body?.code || validateResp?.error);
        if (validateResp?.body?.code === 'BOUND_TO_OTHER') {
          alert('別のPCでこのトークンが使用されています。再度ログインしてください。');
          await (window as any).appAPI?.clearToken?.();
          setTokenInfo({ hasToken: false });
        }
      }
    } catch (e: any) {
      console.error('[heartbeat] error', e);
    }
  }

  // Helper: Check if session has expired
  function checkSessionExpiry() {
    const expiryStr = localStorage.getItem('session_expires_at');
    if (!expiryStr) return false;
    
    const expiryTime = parseInt(expiryStr);
    const now = Math.floor(Date.now() / 1000);
    
    if (now > expiryTime) {
      console.warn('[session] expired, re-authenticating');
      performHeartbeat(); // Attempt to re-authenticate
      return true;
    }
    return false;
  }

  // Helper: fetch token info (status and quota)
  async function fetchTokenInfo() {
    try {
      const tokenResp = await (window as any).appAPI?.getToken?.();
      const hasToken = !!(tokenResp?.ok && tokenResp?.token);
      
      if (!hasToken) {
        // No token set - allow to work without restrictions
        setTokenInfo({ hasToken: false });
        localStorage.removeItem('session_expires_at');
        localStorage.removeItem('remaining_quota');
        console.log('[auth] no token set, working without quota restrictions');
        return;
      }

      // Token exists - validate it
      const validateResp = await (window as any).authAPI?.validateToken?.();
      if (validateResp?.ok && validateResp?.data) {
        // Save to localStorage
        localStorage.setItem('session_expires_at', validateResp.data.session_expires_at.toString());
        localStorage.setItem('remaining_quota', validateResp.data.remaining_quota.toString());
        
        setTokenInfo({
          hasToken: true,
          remaining_quota: validateResp.data.remaining_quota,
          bound: validateResp.data.bound,
          session_expires_at: validateResp.data.session_expires_at,
          expires_at: validateResp.data.expires_at
        });
        
        // Setup heartbeat timer
        setupHeartbeatTimer();
      } else {
        // Token validation failed - but still allow usage
        console.warn('[auth] token validation failed, but allowing to work');
        setTokenInfo({
          hasToken: true,
          error: validateResp?.status ? `検証失敗 (${validateResp.status})` : '検証失敗'
        });
      }
    } catch (e: any) {
      console.warn('[auth] token check error, allowing to work anyway', e?.message);
      setTokenInfo({ hasToken: false });
    }
  }

  // Helper: authenticate with token
  async function handleAuthenticate() {
    if (!tokenInput.trim()) {
      alert('トークンを入力してください');
      return;
    }
    setIsAuthenticating(true);
    try {
      // Save token
      const saveResp = await (window as any).appAPI?.saveToken?.(tokenInput.trim());
      if (!saveResp?.ok) {
        alert('トークンの保存に失敗しました');
        setIsAuthenticating(false);
        return;
      }
      
      // Get device ID
      const deviceResp = await (window as any).deviceAPI?.getDeviceId?.();
      if (deviceResp?.ok && deviceResp?.deviceId) {
        localStorage.setItem('deviceId', deviceResp.deviceId);
      }
      
      // Validate token
      const validateResp = await (window as any).authAPI?.validateToken?.();
      if (validateResp?.ok && validateResp?.data) {
        // Save to localStorage
        localStorage.setItem('session_expires_at', validateResp.data.session_expires_at.toString());
        localStorage.setItem('remaining_quota', validateResp.data.remaining_quota.toString());
        
        setTokenInfo({
          hasToken: true,
          remaining_quota: validateResp.data.remaining_quota,
          bound: validateResp.data.bound,
          session_expires_at: validateResp.data.session_expires_at,
          expires_at: validateResp.data.expires_at
        });
        setTokenInput('');
        alert('トークンを設定しました');
        
        // Setup heartbeat timer
        setupHeartbeatTimer();
      } else {
        alert('トークンの検証に失敗しました: ' + (validateResp?.error || '不明なエラー'));
        await (window as any).appAPI?.clearToken?.();
        localStorage.removeItem('session_expires_at');
        localStorage.removeItem('remaining_quota');
        setTokenInfo({ hasToken: false, error: '検証失敗' });
      }
    } catch (e: any) {
      alert('エラー: ' + (e?.message || '不明'));
    } finally {
      setIsAuthenticating(false);
    }
  }

  // Helper: clear token
  async function handleClearToken() {
    const ok = window.confirm('トークンを削除してもよろしいですか？');
    if (!ok) return;
    try {
      await (window as any).appAPI?.clearToken?.();
      setTokenInfo({ hasToken: false });
      setTokenInput('');
      alert('トークンを削除しました');
    } catch (e: any) {
      alert('削除に失敗しました: ' + (e?.message || '不明'));
    }
  }

  useEffect(() => { refresh(); }, []);
  useEffect(() => { loadPref(); }, [selectedContainerId, origin]);

  const localeOptions = ['ja-JP','en-US','en-GB'];
  const acceptLangOptions = ['ja,en-US;q=0.8,en;q=0.7','ja-JP,ja;q=0.9,en-US;q=0.8'];
  const timezoneOptions = ['Asia/Tokyo','Asia/Shanghai','Asia/Hong_Kong'];
  const coresOptions = [2,4,6,8,12];
  const ramOptions = [2,4,6,8,16,32];
  const viewportOptions = [{w:1280,h:800},{w:1920,h:1080},{w:375,h:812},{w:360,h:800}];
  const colorDepthOptions = [24,30,32];
  const connOptions = ['wifi','4g','3g','2g','ethernet'];
  const [bookmarkSettingsOpen, setBookmarkSettingsOpen] = useState<boolean>(true);
  const [appVersion, setAppVersion] = useState<string>('');
  const [exportEnabled, setExportEnabled] = useState<boolean>(false);
  const [exportPort, setExportPort] = useState<number>(3001);
  const [exportStatus, setExportStatus] = useState<{ running: boolean; port: number; error?: string } | null>(null);
  const [openAsSettingsSignal, setOpenAsSettingsSignal] = useState<boolean>(false);
  const [tokenInfo, setTokenInfo] = useState<{ hasToken: boolean; remaining_quota?: number; bound?: boolean; session_expires_at?: number; expires_at?: number; error?: string } | null>(null);
  const [tokenInput, setTokenInput] = useState<string>('');
  const [isAuthenticating, setIsAuthenticating] = useState<boolean>(false);
  const [apiBaseInput, setApiBaseInput] = useState<string>('');
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [heartbeatTimer, setHeartbeatTimer] = useState<NodeJS.Timeout | null>(null);

  useEffect(() => { refresh(); }, []);
  useEffect(() => { loadPref(); }, [selectedContainerId, origin]);
  useEffect(() => {
    (async () => {
      try {
        const v = await (window as any).appAPI.getVersion();
        setAppVersion(v || '');
      } catch (e) { /* ignore */ }
    })();
    // load saved token if any and validate; if missing/invalid, show token prompt
    (async () => {
      try {
        const saved = await (window as any).appAPI.getToken();
        const deviceResp = await (window as any).deviceAPI.getDeviceId();
        const deviceId = deviceResp && deviceResp.deviceId ? deviceResp.deviceId : '';
        if (saved && saved.token) {
          try {
            const res = await (window as any).ipcRenderer?.invoke ? window.api?.validateToken?.(saved.token) : null;
          } catch (e) {
            // show token prompt on error
            setTimeout(()=> setOpenSettingsId('tokenPrompt'), 500);
          }
        } else {
          setTimeout(()=> setOpenSettingsId('tokenPrompt'), 500);
        }
      } catch (e) { setTimeout(()=> setOpenSettingsId('tokenPrompt'), 500); }
    })();
    // load token info and check session expiry (optional - doesn't block if missing)
    (async () => {
      try {
        // Check if session has expired
        if (checkSessionExpiry()) {
          console.log('[init] session expired, heartbeat triggered');
        } else {
          await fetchTokenInfo();
          // Setup heartbeat timer
          setupHeartbeatTimer();
        }
      } catch (e) {
        console.log('[init] token check skipped, working without token');
      }
    })();
    // load export settings/status
    (async () => {
      try {
        const s = await window.exportAPI?.getSettings();
        if (s && s.settings) {
          setExportEnabled(!!s.settings.enabled);
          setExportPort(Number(s.settings.port || 3001));
        }
      } catch {}
      try {
        const st = await window.exportAPI?.getStatus();
        if (st && st.ok) setExportStatus({ running: !!st.running, port: Number(st.port || 3001), error: st.error || undefined });
      } catch {}
    })();
    // subscribe to status events
    const unsub = window.exportAPI?.onStatus?.((p:any)=>{
      try { setExportStatus({ running: !!p.running, port: Number(p.port || 3001), error: p.error || undefined }); } catch {}
    });
    // subscribe to explicit open-settings signal from main (used when query param may not be preserved)
    const unsub2 = window.exportAPI?.onOpenSettings?.(() => {
      try { setOpenAsSettingsSignal(true); } catch {}
    });
    return () => { 
      try { if (unsub) unsub(); } catch {} 
      try { if (heartbeatTimer) clearTimeout(heartbeatTimer); } catch {}
    };
  }, [heartbeatTimer]);

  // If this renderer was opened as a Settings window (main process adds ?settings=1),
  // render the Settings-only UI and skip the main dashboard.
  const isSettingsWindow = (() => {
    try { const u = new URL(window.location.href); return u.searchParams.get('settings') === '1' || openAsSettingsSignal; } catch { return !!openAsSettingsSignal; }
  })();

  const SettingsOnly = () => (
    <div style={{ padding: 16, fontFamily: 'system-ui', display: 'grid', gap: 16 }}>
      <h1>設定</h1>
      
      {/* Advanced API Settings (Troubleshooting only) */}
      <section style={{ padding: 12, border: '1px solid #ddd', borderRadius: 8, backgroundColor: '#f9f9f9' }}>
        <h3 
          style={{ 
            cursor: 'pointer', 
            display: 'flex', 
            alignItems: 'center', 
            gap: 8,
            fontSize: 12,
            color: '#666',
            margin: 0
          }} 
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? '▼' : '▶'} トラブルシューティング
        </h3>
        {showAdvanced && (
          <div style={{ marginTop: 12, padding: 12, backgroundColor: '#fff', borderRadius: 4, border: '1px solid #ddd' }}>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 11, fontWeight: 'bold', color: '#666' }}>認証APIベースURL（カスタム設定用）</label>
              <input 
                type="text"
                value={apiBaseInput}
                onChange={e => setApiBaseInput(e.target.value)}
                placeholder="https://xxx.execute-api.ap-northeast-1.amazonaws.com/prod"
                style={{ width: '100%', padding: 8, border: '1px solid #ddd', borderRadius: 4, boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 11 }}
              />
              <div style={{ fontSize: 10, color: '#999', marginTop: 4 }}>
                デフォルト: https://2y8hntw0r3.execute-api.ap-northeast-1.amazonaws.com/prod
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button 
                onClick={async () => {
                  try {
                    const resp = await (window as any).authAPI?.getSettings?.();
                    if (resp?.ok && resp?.data?.apiBase) {
                      setApiBaseInput(resp.data.apiBase);
                      alert('現在の設定を読み込みました');
                    }
                  } catch (e: any) {
                    alert('読み込みに失敗: ' + (e?.message || '不明'));
                  }
                }}
                style={{ padding: '4px 8px', fontSize: 11 }}
              >
                読み込み
              </button>
              <button 
                onClick={async () => {
                  if (!apiBaseInput.trim()) {
                    alert('URLを入力してください');
                    return;
                  }
                  try {
                    const resp = await (window as any).authAPI?.saveSettings?.({ apiBase: apiBaseInput.trim() });
                    if (resp?.ok) {
                      alert('設定を保存しました');
                    } else {
                      alert('保存に失敗: ' + (resp?.error || '不明'));
                    }
                  } catch (e: any) {
                    alert('保存に失敗: ' + (e?.message || '不明'));
                  }
                }}
                style={{ padding: '4px 8px', fontSize: 11, backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}
              >
                保存
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Token Authentication Section */}
      <section style={{ padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
        <h3>トークン認証</h3>
        {tokenInfo?.hasToken && !tokenInfo?.error ? (
          <div style={{ padding: 12, backgroundColor: '#d4edda', border: '1px solid #c3e6cb', borderRadius: 4, marginBottom: 12 }}>
            <div style={{ color: '#155724', marginBottom: 8 }}>
              <strong>✓ トークンが設定されています</strong>
            </div>
            <div style={{ fontSize: 12, color: '#155724', marginBottom: 8 }}>
              トークン: {`${tokenInfo?.remaining_quota ? '●'.repeat(8) : ''}` || 'トークンID不明'}
            </div>
            <button 
              onClick={handleClearToken}
              style={{ padding: '6px 12px', backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
            >
              トークンを削除
            </button>
          </div>
        ) : (
          <div style={{ padding: 12, backgroundColor: '#f8d7da', border: '1px solid #f5c6cb', borderRadius: 4, marginBottom: 12 }}>
            <div style={{ color: '#721c24', marginBottom: 8 }}>
              <strong>⚠️ トークンが設定されていません</strong>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 12, fontWeight: 'bold' }}>トークンを入力</label>
            <input 
              type="password"
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              placeholder="トークンを貼り付けてください"
              style={{ width: '100%', padding: 8, border: '1px solid #ddd', borderRadius: 4, boxSizing: 'border-box' }}
              disabled={isAuthenticating}
            />
          </div>
          <button 
            onClick={handleAuthenticate}
            disabled={isAuthenticating || !tokenInput.trim()}
            style={{ 
              padding: '8px 16px', 
              backgroundColor: '#0275d8', 
              color: 'white', 
              border: 'none', 
              borderRadius: 4, 
              cursor: isAuthenticating ? 'not-allowed' : 'pointer',
              opacity: isAuthenticating || !tokenInput.trim() ? 0.6 : 1
            }}
          >
            {isAuthenticating ? '認証中...' : '認証'}
          </button>
        </div>
      </section>

      {/* License Info Section */}
      <section style={{ padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
        <h3>ライセンス情報</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <button onClick={fetchTokenInfo} style={{ padding: '6px 12px', fontSize: 12 }}>
            情報更新
          </button>
        </div>
        {tokenInfo ? (
          <div style={{ padding: 12, backgroundColor: '#f5f5f5', borderRadius: 4, fontSize: 14 }}>
            {!tokenInfo.hasToken ? (
              <div style={{ color: '#666' }}>
                トークン未設定
              </div>
            ) : tokenInfo.error ? (
              <div style={{ color: '#d9534f' }}>
                <strong>エラー:</strong> {tokenInfo.error}
              </div>
            ) : (
              <div>
                <div style={{ marginBottom: 12, padding: 12, backgroundColor: '#ffffff', borderRadius: 4, border: '1px solid #e0e0e0' }}>
                  <div style={{ marginBottom: 8 }}>
                    <strong>同時作成可能数:</strong><br />
                    <span style={{ fontSize: 20, fontWeight: 'bold', color: '#0275d8' }}>
                      {tokenInfo.remaining_quota !== undefined ? tokenInfo.remaining_quota : '不明'}
                    </span>
                    <span style={{ fontSize: 12, color: '#666', marginLeft: 8 }}>
                      現在 {list.length} 個使用中
                    </span>
                  </div>
                </div>
                
                <div style={{ marginBottom: 8, fontSize: 13 }}>
                  <strong>トークン状態:</strong> <span style={{ color: '#5cb85c' }}>✓ 有効</span>
                </div>
                <div style={{ marginBottom: 8, fontSize: 13 }}>
                  <strong>バインド状態:</strong> <span style={{ color: tokenInfo.bound ? '#5cb85c' : '#d9534f' }}>
                    {tokenInfo.bound ? '✓ 有効' : '✗ 未バインド'}
                  </span>
                </div>
                {tokenInfo.session_expires_at && (
                  <div style={{ marginBottom: 8, fontSize: 12, color: '#666' }}>
                    <strong>セッション有効期限:</strong><br />
                    {new Date(tokenInfo.session_expires_at * 1000).toLocaleString('ja-JP')}
                  </div>
                )}
                {tokenInfo.expires_at && (
                  <div style={{ fontSize: 12, color: '#666' }}>
                    <strong>トークン有効期限:</strong><br />
                    {new Date(tokenInfo.expires_at * 1000).toLocaleString('ja-JP')}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div style={{ padding: 12, backgroundColor: '#f5f5f5', borderRadius: 4, color: '#666' }}>
            「情報更新」ボタンをクリックして情報を取得してください
          </div>
        )}
      </section>

      <section style={{ padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
        <h3>Export Server 設定</h3>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <label style={{ display:'flex', gap:8, alignItems:'center' }}>
            <input type="checkbox" checked={exportEnabled} onChange={e=>setExportEnabled(e.target.checked)} /> Export Server を有効にする
          </label>
          <label style={{ display:'flex', gap:8, alignItems:'center', marginLeft: 8 }}>
            ポート:
            <input type="number" value={exportPort} onChange={e=>setExportPort(parseInt(e.target.value||'0')||0)} style={{ width: 100 }} />
          </label>
          <button onClick={async ()=>{
            const ok = await window.exportAPI?.saveSettings?.({ enabled: exportEnabled, port: Number(exportPort) });
            if (ok && ok.ok) alert('設定を保存しました（次回起動で反映されます）');
            else alert('保存に失敗しました');
          }}>保存</button>
          <button onClick={async ()=>{
            try {
              const st = await window.exportAPI?.getStatus();
              if (st && st.ok) setExportStatus({ running: !!st.running, port: Number(st.port || 3001), error: st.error || undefined });
              alert('ステータスを更新しました');
            } catch { alert('ステータス取得に失敗しました'); }
          }}>ステータス更新</button>
        </div>
        <div style={{ marginTop:8 }}>
          {exportStatus ? (
            <div style={{ color: exportStatus.running ? 'green' : 'orange' }}>
              {exportStatus.running ? `Export API 実行中: 127.0.0.1:${exportStatus.port}` : `Export API 停止中（設定ポート: ${exportPort}）`}
              {exportStatus.error ? ` — エラー: ${exportStatus.error}` : ''}
            </div>
          ) : <div style={{ color:'#666' }}>ステータス情報がありません</div>}
        </div>
      </section>
    </div>
  );

  // Render settings-only when opened as settings window, otherwise render main dashboard
  return isSettingsWindow ? <SettingsOnly /> : (
    <div style={{ padding: 16, fontFamily: 'system-ui', display: 'grid', gap: 16 }}>

      {/* Info when token not set */}
      {(!tokenInfo || !tokenInfo.hasToken) && (
        <div style={{ padding: 12, backgroundColor: '#e7f3ff', border: '1px solid #b3d9ff', borderRadius: 8, color: '#004085' }}>
          <strong>ℹ️ トークンが設定されていません</strong><br />
          トークンなしで利用可能です。制限なくコンテナを作成できます。<br />
          <span style={{ fontSize: 12, color: '#666' }}>トークンを設定して制限管理を有効にする場合は、設定画面で入力してください。</span>
        </div>
      )}

      {/* Container Usage Status */}
      {tokenInfo?.hasToken && !tokenInfo?.error && (
        <div style={{ padding: 12, backgroundColor: '#e8f4f8', border: '1px solid #87ceeb', borderRadius: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ marginBottom: 8 }}>
                <strong>コンテナ使用状況</strong>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, fontSize: 13 }}>
                <div>
                  <div style={{ color: '#666', fontSize: 11 }}>作成可能</div>
                  <div style={{ fontSize: 18, fontWeight: 'bold', color: '#0275d8' }}>
                    {tokenInfo.remaining_quota !== undefined ? tokenInfo.remaining_quota : '?'}
                  </div>
                </div>
                <div>
                  <div style={{ color: '#666', fontSize: 11 }}>使用中</div>
                  <div style={{ fontSize: 18, fontWeight: 'bold', color: '#ffc107' }}>
                    {list.length}
                  </div>
                </div>
                <div>
                  <div style={{ color: '#666', fontSize: 11 }}>残可能</div>
                  <div style={{ fontSize: 18, fontWeight: 'bold', color: '#28a745' }}>
                    {tokenInfo.remaining_quota !== undefined ? Math.max(0, tokenInfo.remaining_quota - list.length) : '?'}
                  </div>
                </div>
              </div>
            </div>
            <button 
              onClick={fetchTokenInfo}
              style={{ padding: '8px 12px', fontSize: 12, height: 'fit-content' }}
            >
              更新
            </button>
          </div>
        </div>
      )}

      <section style={{ padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
        <h3>コンテナ作成</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={name} onChange={e=>setName(e.target.value)} placeholder="名前" />
          <button onClick={async ()=>{ 
              const check = await canCreateContainer();
              if(!check.ok) return alert(check.message || '同時作成数が上限に達しています');
              try {
                await window.containersAPI.create({ name }); 
                await refresh();
              } catch (e: any) {
                const errMsg = e?.message || String(e);
                if (errMsg.includes('QUOTA_EXCEEDED') || errMsg.includes('Quota exceeded')) {
                  alert('割り当ての消費に失敗しました。別のデバイスで既に使用されている可能性があります。');
                } else {
                  alert('コンテナ作成に失敗しました: ' + errMsg);
                }
              }
            }}>作成</button>
        </div>
      </section>

      {/* 集中編集セクションは廃止しました。各コンテナ行の「設定」ボタンから編集してください。 */}

      <section style={{ padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
        <h3>ブックマーク</h3>
        <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:8 }}>
          <div style={{ flex:1, display:'flex', gap:8, alignItems:'center', overflow:'auto' }}>
            {/* ブックマークバー（クリックで選択） */}
            {bookmarks.map((b:any)=> (
              <button key={b.id}
                style={{ whiteSpace:'nowrap', background: selectedBookmarkId === b.id ? '#eef' : undefined }}
                onClick={()=> setSelectedBookmarkId(b.id)}>{b.title}</button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>コンテナ一覧</h3>
          <button onClick={refresh} style={{ padding: '4px 12px', fontSize: 14, cursor: 'pointer' }} title="コンテナ一覧を更新">🔄 更新</button>
        </div>
        <div style={{ marginBottom: 8 }}>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="コンテナ名で検索..."
            style={{ width: '100%', padding: '6px 12px', border: '1px solid #ddd', borderRadius: 4, fontSize: 14, boxSizing: 'border-box' }}
          />
        </div>
        {filteredList.length === 0 && <p>{searchQuery ? '検索結果がありません。' : 'コンテナがありません。'}</p>}
        <ul>
          {filteredList.map((c:any)=> (
            <li key={c.id} style={{ padding: 8, borderBottom: '1px solid #eee' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <div style={{ minWidth: 160, cursor: 'pointer' }} onClick={()=>{ const raw = c.proxy?.server ?? ''; setOpenSettingsId(c.id); setModalContainerName(c.name || ''); setModalNote(c.note || ''); setModalStatus(c.status ?? '未使用'); setModalLocale(c.fingerprint?.locale ?? 'ja-JP'); setModalAcceptLang(c.fingerprint?.acceptLanguage ?? 'ja,en-US;q=0.8,en;q=0.7'); setModalTimezone(c.fingerprint?.timezone ?? 'Asia/Tokyo'); setFpCores(c.fingerprint?.hardwareConcurrency ?? 4); setFpRam(c.fingerprint?.deviceMemory ?? 4); setFpViewportW(c.fingerprint?.viewportWidth ?? 1280); setFpViewportH(c.fingerprint?.viewportHeight ?? 800); setFpColorDepth(c.fingerprint?.colorDepth ?? 24); setFpMaxTouch(c.fingerprint?.maxTouchPoints ?? 0); setFpConn(c.fingerprint?.connectionType ?? '4g'); setFpCookie(c.fingerprint?.cookieEnabled ?? true); setFpWebglVendor(c.fingerprint?.webglVendor ?? ''); setFpWebglRenderer(c.fingerprint?.webglRenderer ?? ''); setFpFakeIp(!!c.fingerprint?.fakeIp); setModalProxyType(detectProxyType(raw)); setModalProxyServer(extractHostPort(raw)); setModalProxyUsername(c.proxy?.username ?? ''); setModalProxyPassword(c.proxy?.password ?? ''); }}>
                  <label><strong>{c.name}</strong></label>
                  <div style={{ marginTop: 4, width: 'fit-content', padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 'bold', color: 'white', backgroundColor: c.status === '稼働中' ? '#28a745' : c.status === '停止' ? '#dc3545' : '#6c757d' }}>
                    {c.status ?? '未使用'}
                  </div>
                  <small style={{ display: 'block', marginTop: 4 }}>ID: {c.id}</small>
                  {c.createdAt && (
                    <small style={{ display: 'block', marginTop: 4, color: '#666' }}>
                      作成日時: {new Date(c.createdAt).toLocaleString('ja-JP')}
                    </small>
                  )}
                </div>
                {/* per-container URL input removed */}
                <div style={{ display:'flex', gap:8, marginLeft: 'auto' }}>
                  <button onClick={async ()=>{
                    const bm = bookmarks.find((x:any)=> x.id === selectedBookmarkId);
                    const urlToOpen = bm?.url;
                    await window.containersAPI.open({ id: c.id, url: urlToOpen });
                  }}>開く</button>
                  <button title="前回の状態で開きます" onClick={()=> window.containersAPI.open({ id: c.id })}>復元</button>
                    <button style={{ marginLeft: 8 }} onClick={()=>{
                    const raw = c.proxy?.server ?? '';
                    setOpenSettingsId(c.id);
                    setModalContainerName(c.name || '');
                    setModalLocale(c.fingerprint?.locale ?? 'ja-JP');
                    setModalAcceptLang(c.fingerprint?.acceptLanguage ?? 'ja,en-US;q=0.8,en;q=0.7');
                    setModalTimezone(c.fingerprint?.timezone ?? 'Asia/Tokyo');
                    setFpCores(c.fingerprint?.hardwareConcurrency ?? 4);
                    setFpRam(c.fingerprint?.deviceMemory ?? 4);
                    setFpViewportW(c.fingerprint?.viewportWidth ?? 1280);
                    setFpViewportH(c.fingerprint?.viewportHeight ?? 800);
                    setFpColorDepth(c.fingerprint?.colorDepth ?? 24);
                    setFpMaxTouch(c.fingerprint?.maxTouchPoints ?? 0);
                    setFpConn(c.fingerprint?.connectionType ?? '4g');
                    setFpCookie(c.fingerprint?.cookieEnabled ?? true);
                    setFpWebglVendor(c.fingerprint?.webglVendor ?? '');
                    setFpWebglRenderer(c.fingerprint?.webglRenderer ?? '');
                    setFpFakeIp(!!c.fingerprint?.fakeIp);
                    setModalProxyType(detectProxyType(raw));
                    setModalProxyServer(extractHostPort(raw));
                    setModalProxyUsername(c.proxy?.username ?? '');
                    setModalProxyPassword(c.proxy?.password ?? '');
                    setModalNote(c.note ?? '');
                    setModalStatus(c.status ?? '未使用');
                  }}>設定</button>
                  <button style={{ marginLeft: 'auto', color: 'crimson' }} onClick={async ()=>{
                    if (!confirm(`コンテナ「${c.name}」を削除しますか？この操作は元に戻せません。`)) return;
                    await window.containersAPI.delete({ id: c.id });
                    await refresh();
                  }}>削除</button>
                </div>
              </div>

              {openSettingsId === c.id && (
                <div style={{ marginTop: 8, padding: 12, border: '1px solid #ddd', borderRadius: 6, background: '#fff' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <strong>設定（{c.name}）</strong>
                    <div>
                      <button style={{ marginRight: 8 }} onClick={saveCurrentSettings}>保存</button>
                      <button onClick={()=> setOpenSettingsId(null)}>閉じる</button>
                    </div>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:8, marginTop:8 }}>
                    <label>コンテナ名</label>
                    <input value={modalContainerName} onChange={e=>setModalContainerName(e.target.value)} />
                    <label>ステータス</label>
                    <select value={modalStatus} onChange={e=>setModalStatus(e.target.value)}>
                      <option value="未使用">未使用</option>
                      <option value="稼働中">稼働中</option>
                      <option value="停止">停止</option>
                    </select>
                    <label>メモ</label>
                    <textarea value={modalNote} onChange={e=>setModalNote(e.target.value)} style={{ width: '100%', minHeight: 80 }} />
                    <label>ロケール</label>
                    <input value={modalLocale} onChange={e=>setModalLocale(e.target.value)} />
                    <label>Accept-Language</label>
                    <input value={modalAcceptLang} onChange={e=>setModalAcceptLang(e.target.value)} />
                    <label>タイムゾーン</label>
                    <input value={modalTimezone} onChange={e=>setModalTimezone(e.target.value)} />
                    <label>CPU コア数</label>
                    <input type="number" min={1} max={32} value={fpCores} onChange={e=>setFpCores(parseInt(e.target.value||'0')||0)} />
                    <label>RAM(GB)</label>
                    <input type="number" min={1} max={64} value={fpRam} onChange={e=>setFpRam(parseInt(e.target.value||'0')||0)} />
                    <label>表示サイズ（幅 x 高）</label>
                    <div style={{ display:'flex', gap:6 }}>
                      <input type="number" value={fpViewportW} onChange={e=>setFpViewportW(parseInt(e.target.value||'0')||0)} />
                      <input type="number" value={fpViewportH} onChange={e=>setFpViewportH(parseInt(e.target.value||'0')||0)} />
                    </div>
                    <label>色の深さ</label>
                    <input type="number" min={8} max={48} value={fpColorDepth} onChange={e=>setFpColorDepth(parseInt(e.target.value||'0')||0)} />
                    <label>タッチポイント</label>
                    <input type="number" min={0} max={10} value={fpMaxTouch} onChange={e=>setFpMaxTouch(parseInt(e.target.value||'0')||0)} />
                    <label>回線種別</label>
                    <select value={fpConn} onChange={e=>setFpConn(e.target.value)}>
                      {connOptions.map(c=> <option key={c} value={c}>{c}</option>)}
                    </select>
                    <label>Cookie 有効</label>
                    <input type="checkbox" checked={fpCookie} onChange={e=>setFpCookie(e.target.checked)} />
                    <label>IP 偽装</label>
                    <input type="checkbox" checked={fpFakeIp} onChange={e=>setFpFakeIp(e.target.checked)} disabled={!!modalProxyServer} />
                    <label>WebGL Vendor</label>
                    <input value={fpWebglVendor} onChange={e=>setFpWebglVendor(e.target.value)} />
                    <label>WebGL Renderer</label>
                    <input value={fpWebglRenderer} onChange={e=>setFpWebglRenderer(e.target.value)} />
                    <label>起動URL</label>
                    <input value={containerUrls[c.id] ?? ''} onChange={e=> setContainerUrls(prev=> ({ ...prev, [c.id]: e.target.value }))} />
                    <label>サイト設定（Origin）</label>
                    <input value={modalSiteOrigin} onChange={e=>setModalSiteOrigin(e.target.value)} placeholder="https://example.com" />
                    <label>自動入力</label>
                    <input type="checkbox" checked={modalSiteAutoFill} onChange={e=>setModalSiteAutoFill(e.target.checked)} />
                    <label>フォーム自動保存</label>
                    <input type="checkbox" checked={modalSiteAutoSave} onChange={e=>setModalSiteAutoSave(e.target.checked)} />
                    <label>プロキシ接続テスト</label>
                    <div style={{ display:'flex', gap:8 }}>
                      <button onClick={async ()=>{
                        const proxy = { 
                          server: normalizeProxyString(modalProxyType, modalProxyServer),
                          username: modalProxyUsername || undefined,
                          password: modalProxyPassword || undefined
                        };
                        console.log('[renderer] proxy.test ->', proxy);
                        const res = await (window as any).proxyAPI.test({ proxy });
                        console.log('[renderer] proxy.test result ->', res);
                        alert(res.ok ? '接続成功' : `接続失敗: ${res.errorCode ?? res.error}`);
                      }}>テスト</button>
                    </div>
                    <label>トークン</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input id="tokenInput" placeholder="トークンを入力" style={{ flex:1 }} />
                      <button onClick={async ()=>{
                        const t = (document.getElementById('tokenInput') as HTMLInputElement).value.trim();
                        if(!t) return alert('トークンを入力してください');
                        const res = await (window as any).appAPI.saveToken(t);
                        if(res && res.ok) alert('トークンを保存しました'); else alert('保存に失敗しました');
                      }}>保存</button>
                      <button onClick={async ()=>{
                        const res = await (window as any).appAPI.getToken();
                        alert(res && res.token ? '保存済みトークンあり' : '保存トークンなし');
                      }}>確認</button>
                    </div>
                    <label>プロキシ種類</label>
                    <select value={modalProxyType} onChange={e=> setModalProxyType(e.target.value as any)}>
                      <option value="http">HTTP</option>
                      <option value="socks5">SOCKS5</option>
                    </select>
                    <label>プロキシサーバー</label>
                    <input value={modalProxyServer} onChange={e=>setModalProxyServer(e.target.value)} placeholder="host:port" />
                    <label>プロキシ ユーザー名</label>
                    <input value={modalProxyUsername} onChange={e=>setModalProxyUsername(e.target.value)} />
                    <label>プロキシ パスワード</label>
                    <input value={modalProxyPassword} onChange={e=>setModalProxyPassword(e.target.value)} type="password" />
                    
                  </div>
                  <div style={{ marginTop:10, display:'flex', gap:8 }}>
                    <button onClick={async ()=>{
                      // save fingerprint and close
                      const proxy = modalProxyServer ? { server: normalizeProxyString(modalProxyType, modalProxyServer), username: modalProxyUsername || undefined, password: modalProxyPassword || undefined } : null;
                      const fingerprint: any = {
                        locale: modalLocale,
                        acceptLanguage: modalAcceptLang,
                        timezone: modalTimezone,
                        hardwareConcurrency: fpCores,
                        deviceMemory: fpRam,
                        viewportWidth: fpViewportW,
                        viewportHeight: fpViewportH,
                        colorDepth: fpColorDepth,
                        maxTouchPoints: fpMaxTouch,
                        connectionType: fpConn,
                        cookieEnabled: fpCookie,
                        webglVendor: fpWebglVendor || undefined,
                        webglRenderer: fpWebglRenderer || undefined,
                      };
                      if (!proxy) fingerprint.fakeIp = fpFakeIp;
                      const payload2 = proxy ? { id: c.id, name: modalContainerName, fingerprint, proxy } : { id: c.id, name: modalContainerName, fingerprint };
                      await window.containersAPI.update(payload2);
                      // save note separately to ensure DB column is updated via dedicated IPC
                      await (window as any).containersAPI.setNote({ id: c.id, note: modalNote === '' ? null : modalNote });
                      // reflect url state (in-memory)
                      await refresh();
                      setOpenSettingsId(null);
                    }}>保存</button>
                    <button onClick={async ()=>{
                      // reset fingerprint and update UI
                      const seed: any = {
                        acceptLanguage: 'ja,en-US;q=0.8,en;q=0.7', locale: 'ja-JP', timezone:'Asia/Tokyo', platform:'Win32',
                        hardwareConcurrency: [4,6,8,12][Math.floor(Math.random()*4)], deviceMemory: [4,6,8,12][Math.floor(Math.random()*4)],
                        canvasNoise: true,
                      };
                      await window.containersAPI.update({ id: c.id, fingerprint: seed });
                      // reflect into modal inputs
                      setModalLocale(seed.locale);
                      setModalAcceptLang(seed.acceptLanguage);
                      setModalTimezone(seed.timezone);
                      setFpCores(seed.hardwareConcurrency);
                      setFpRam(seed.deviceMemory);
                      setFpViewportW(seed.viewportWidth ?? fpViewportW);
                      setFpViewportH(seed.viewportHeight ?? fpViewportH);
                      setFpColorDepth(seed.colorDepth ?? fpColorDepth);
                      setFpMaxTouch(seed.maxTouchPoints ?? fpMaxTouch);
                      setFpConn(seed.connectionType ?? fpConn);
                      setFpCookie(seed.cookieEnabled ?? fpCookie);
                      setFpWebglVendor(seed.webglVendor ?? fpWebglVendor);
                      setFpWebglRenderer(seed.webglRenderer ?? fpWebglRenderer);
                      await refresh();
                    }}>リセット</button>
                    <button onClick={()=> setOpenSettingsId(null)}>閉じる</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section style={{ padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <h3 style={{ margin:0 }}>ブックマーク設定</h3>
          <button onClick={()=> setBookmarkSettingsOpen(prev=>!prev)}>{bookmarkSettingsOpen ? '閉じる' : '開く'}</button>
        </div>
        {bookmarkSettingsOpen && (
        <div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <input id="bmTitle" placeholder="タイトル" style={{ flex:1 }} />
          <input id="bmUrl" placeholder="https://example.com" style={{ flex:2 }} />
          <button onClick={async ()=>{
            const title = (document.getElementById('bmTitle') as HTMLInputElement).value.trim();
            const url = (document.getElementById('bmUrl') as HTMLInputElement).value.trim();
            if (!title || !url) return alert('タイトル/URLを指定してください');
            const id = crypto.randomUUID();
            await (window as any).bookmarksAPI.add({ id, containerId: '', title, url });
            alert('Bookmark added');
            await refresh();
          }}>追加</button>
        </div>
        <ul style={{ marginTop:8 }}>
          {bookmarks.map((b:any, idx:number)=> (
            <li key={b.id} style={{ display:'flex', gap:8, alignItems:'center' }}>
              <div style={{ flex:1, display:'flex', gap:8, alignItems:'center' }}>
                <span style={{ cursor:'grab' }}>::</span>
                <div>
                  {editingBookmarkId === b.id ? (
                    <div style={{ display:'flex', gap:8 }}>
                      <input value={editBmTitle} onChange={e=>setEditBmTitle(e.target.value)} />
                      <input value={editBmUrl} onChange={e=>setEditBmUrl(e.target.value)} />
                      <button onClick={async ()=>{
                        if (!editBmTitle || !editBmUrl) return alert('タイトル/URLを指定してください');
                        await (window as any).bookmarksAPI.delete({ id: b.id });
                        await (window as any).bookmarksAPI.add({ id: b.id, containerId: '', title: editBmTitle, url: editBmUrl });
                        setEditingBookmarkId(null);
                        await refresh();
                      }}>保存</button>
                      <button onClick={()=> setEditingBookmarkId(null)}>キャンセル</button>
                    </div>
                  ) : (
                    <div>{b.title} <small style={{ color:'#666' }}>({b.url})</small></div>
                  )}
                </div>
              </div>
              <div style={{ display:'flex', gap:8 }}>
                {/* ブックマーク設定内の開くボタンは不要になったため削除 */}
                <button onClick={async ()=>{ await (window as any).bookmarksAPI.delete({ id: b.id }); await refresh(); }}>削除</button>
                <button onClick={()=>{
                  setEditingBookmarkId(b.id);
                  setEditBmTitle(b.title);
                  setEditBmUrl(b.url);
                }}>編集</button>
                <button onClick={async ()=>{
                  // move up
                  if (idx === 0) return;
                  const ids = bookmarks.map((x:any)=> x.id);
                  const tmp = ids[idx-1]; ids[idx-1] = ids[idx]; ids[idx] = tmp;
                  await (window as any).bookmarksAPI.reorder({ ids });
                  await refresh();
                }}>↑</button>
                <button onClick={async ()=>{
                  // move down
                  if (idx === bookmarks.length-1) return;
                  const ids = bookmarks.map((x:any)=> x.id);
                  const tmp = ids[idx+1]; ids[idx+1] = ids[idx]; ids[idx] = tmp;
                  await (window as any).bookmarksAPI.reorder({ ids });
                  await refresh();
                }}>↓</button>
              </div>
            </li>
          ))}
        </ul>
        </div>
        )}
      </section>

      {/* グローバルなサイト設定は廃止しました。サイト設定は各コンテナの「設定」内で行ってください。 */}
    </div>
  );
}
