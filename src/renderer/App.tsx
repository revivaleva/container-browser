import React, { useEffect, useMemo, useState } from 'react';

type Container = any;

declare global {
  interface Window {
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
  const [modalNote, setModalNote] = useState<string>('');
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

  // site prefs
  const [selectedContainerId, setSelectedContainerId] = useState<string>('');
  const [origin, setOrigin] = useState('https://example.com');
  const [autoFill, setAutoFill] = useState<boolean>(false);
  const [autoSaveForms, setAutoSaveForms] = useState<boolean>(false);
  const selected = useMemo(()=> list.find((c:any)=> c.id === selectedContainerId), [list, selectedContainerId]);

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

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui', display: 'grid', gap: 16 }}>
      <h1>コンテナブラウザー</h1>

      <section style={{ padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
        <h3>コンテナ作成</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={name} onChange={e=>setName(e.target.value)} placeholder="名前" />
          <button onClick={async ()=>{ await window.containersAPI.create({ name }); await refresh(); }}>作成</button>
        </div>
      </section>

      {/* 集中編集セクションは廃止しました。各コンテナ行の「設定」ボタンから編集してください。 */}

      <section style={{ padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
        <h3>ブックマーク</h3>
        <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:8 }}>
          <div style={{ flex:1, display:'flex', gap:8, alignItems:'center' }}>
            <select style={{ flex:1 }} value={selectedBookmarkId ?? ''} onChange={e=> setSelectedBookmarkId(e.target.value || null)}>
              <option value="">-- ブックマークを選択 --</option>
              {bookmarks.map((b:any)=> (
                <option key={b.id} value={b.id}>{b.title} ({b.url})</option>
              ))}
            </select>
            
          </div>
          <div style={{ flex:1 }}>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <div style={{ flex:1, display:'flex', gap:8, alignItems:'center', overflow:'auto' }}>
                {/* ブックマークバー（クリックで選択） */}
                {bookmarks.map((b:any)=> (
                  <button key={b.id}
                    style={{ whiteSpace:'nowrap', background: selectedBookmarkId === b.id ? '#eef' : undefined }}
                    onClick={()=> setSelectedBookmarkId(b.id)}>{b.title}</button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <h3>コンテナ一覧</h3>
        {list.length === 0 && <p>コンテナがありません。</p>}
        <ul>
          {list.map((c:any)=> (
            <li key={c.id} style={{ padding: 8, borderBottom: '1px solid #eee' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{ minWidth: 160 }}>
                  <label><strong>{c.name}</strong></label>
                  <div style={{ color:'#666', fontSize:12 }}>{c.note ?? ''}</div>
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
                    setModalProxyServer(c.proxy?.server ?? '');
                    setModalProxyUsername(c.proxy?.username ?? '');
                    setModalProxyPassword(c.proxy?.password ?? '');
                    setModalNote(c.note ?? '');
                  }}>設定</button>
                  <button style={{ marginLeft: 'auto', color: 'crimson' }} onClick={async ()=>{
                    if (!confirm(`コンテナ「${c.name}」を削除しますか？この操作は元に戻せません。`)) return;
                    await window.containersAPI.delete({ id: c.id });
                    await refresh();
                  }}>削除</button>
                </div>
              </div>
              <small>ID: {c.id}</small>

              {openSettingsId === c.id && (
                <div style={{ marginTop: 8, padding: 12, border: '1px solid #ddd', borderRadius: 6, background: '#fff' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <strong>設定（{c.name}）</strong>
                    <button onClick={()=> setOpenSettingsId(null)}>閉じる</button>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:8, marginTop:8 }}>
                    <label>コンテナ名</label>
                    <input value={modalContainerName} onChange={e=>setModalContainerName(e.target.value)} />
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
                        const proxy = { server: modalProxyServer };
                        const res = await (window as any).proxyAPI.test({ proxy });
                        alert(res.ok ? '接続成功' : `接続失敗: ${res.error}`);
                      }}>テスト</button>
                    </div>
                    <label>プロキシサーバー</label>
                    <input value={modalProxyServer} onChange={e=>setModalProxyServer(e.target.value)} placeholder="host:port" />
                    <label>プロキシ ユーザー名</label>
                    <input value={modalProxyUsername} onChange={e=>setModalProxyUsername(e.target.value)} />
                    <label>プロキシ パスワード</label>
                    <input value={modalProxyPassword} onChange={e=>setModalProxyPassword(e.target.value)} type="password" />
                    <label>メモ</label>
                    <textarea value={modalNote} onChange={e=>setModalNote(e.target.value)} style={{ width: '100%', minHeight: 80 }} />
                  </div>
                  <div style={{ marginTop:10, display:'flex', gap:8 }}>
                    <button onClick={async ()=>{
                      // save fingerprint and close
                      const proxy = modalProxyServer ? { server: modalProxyServer, username: modalProxyUsername || undefined, password: modalProxyPassword || undefined } : null;
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
                      await window.containersAPI.update({ id: c.id, name: modalContainerName, fingerprint }, proxy ? { proxy } : undefined as any);
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
