export {};
declare global {
  interface Window {
    containerShellAPI: {
      onContext: (cb: (ctx: any) => void) => () => void;
      onDevtoolsChange?: (cb: (payload: any) => void) => () => void;
      navigate: (payload: { containerId: string; url: string }) => Promise<boolean>;
    }
  }
}

let containerId: string | undefined;
let currentTabs: any[] = [];
let lastLocalActiveSet = 0;

document.addEventListener('DOMContentLoaded', () => {
  const urlInput = document.getElementById('url') as HTMLInputElement;
  const goBtn = document.getElementById('go') as HTMLButtonElement;
  const backBtn = document.createElement('button'); backBtn.className = 'nav-btn'; backBtn.textContent = '<';
  const fwdBtn = document.createElement('button'); fwdBtn.className = 'nav-btn'; fwdBtn.textContent = '>';
  const bar = document.getElementById('bar')!;
  const controls = document.getElementById('controls');
  if (controls && urlInput && controls.contains(urlInput)) {
    controls.insertBefore(backBtn, urlInput);
    controls.insertBefore(fwdBtn, urlInput);
  } else {
    // fallback: insert at the start of bar
    if (bar.firstChild) { bar.insertBefore(backBtn, bar.firstChild); bar.insertBefore(fwdBtn, bar.firstChild); }
    else { bar.appendChild(backBtn); bar.appendChild(fwdBtn); }
  }

  // URL 入力: Enter 時にナビゲート。スキームが無ければ Google 検索にフォールバック
  if (urlInput) {
    urlInput.addEventListener('keydown', async (ev) => {
      if (ev.key === 'Enter') {
        try {
          const raw = (urlInput.value || '').trim();
          if (!raw) return;
          let target = raw;
          try {
            // if parseable as URL with protocol, use as-is
            const maybe = new URL(raw);
            if (!maybe.protocol || maybe.protocol.length === 0) throw new Error('no-proto');
            target = raw;
          } catch {
            // if missing protocol but looks like hostname (example.com), add https://
            if (/^[a-z0-9\-]+\.[a-z]{2,}/i.test(raw)) target = 'https://' + raw;
            else target = 'https://www.google.com/search?q=' + encodeURIComponent(raw);
          }
          if (!containerId) return;
          // if there are no tabs, create one; otherwise navigate active tab
          if (!currentTabs || currentTabs.length === 0) {
            await (window as any).tabsAPI.createTab({ containerId, url: target });
          } else {
            await (window as any).containerShellAPI.navigate({ containerId, url: target });
          }
        } catch (e) { console.error('[shell] url enter error', e); }
      }
    });
  }

  // Bookmarks: clicking a bookmark opens a new tab with its URL
  async function setupBookmarks() {
    try {
      const bmApi = (window as any).bookmarksAPI;
      let bms: any[] | null = null;
      if (bmApi && bmApi.list) {
        try { bms = await bmApi.list(); } catch (e) { console.error('[shell] bookmarksAPI.list error', e); }
      }
      const bmRow = document.getElementById('bookmark-row');
      // filter to global bookmarks (no containerId) with valid URL
      const globals = (bms || []).filter((b:any) => (!b.containerId || b.containerId === '') && b.url);
      if (!globals || globals.length === 0) {
        if (bmRow) bmRow.style.display = 'none';
        return;
      }
      if (bmRow) {
        bmRow.style.display = 'flex';
        // clear existing buttons
        bmRow.innerHTML = '';
        // create a button for each global bookmark (no fixed limit)
        globals.forEach((bk:any, i:number) => {
          try {
            const btn = document.createElement('button');
            btn.className = 'bookmark-btn';
            btn.style.padding = '6px 10px';
            btn.style.borderRadius = '6px';
            btn.style.border = '1px solid #d6a500';
            btn.style.background = '#fff8e1';
            btn.textContent = bk && bk.title ? bk.title : (bk && bk.url ? bk.url : 'Bookmark');
            btn.onclick = async () => {
              try {
                if (!containerId) return;
                const url = bk && bk.url ? bk.url : undefined;
                if (!url) return;
                if (!currentTabs || currentTabs.length === 0) {
                  await (window as any).tabsAPI.createTab({ containerId, url });
                } else {
                  // Ensure main process activeIndex matches renderer before navigating
                  const idx = (window as any).__activeIndex ?? 0;
                  try { await (window as any).tabsAPI.switchTab({ containerId, index: idx }); } catch (e) { /* ignore */ }
                  (window as any).__activeIndex = idx;
                  lastLocalActiveSet = Date.now();
                  // Update DOM active class for snappy UI
                  try {
                    const allBtns = document.querySelectorAll('#tabs .tab-btn');
                    allBtns.forEach((b:any, i:number) => {
                      if (i === idx) b.classList.add('tab-active'); else b.classList.remove('tab-active');
                    });
                  } catch (e) { /* ignore */ }
                  await (window as any).containerShellAPI.navigate({ containerId, url });
                }
              } catch (e) { console.error(e); }
            };
            bmRow.appendChild(btn);
          } catch (e) { console.error('[shell] create bookmark btn error', e); }
        });
      }
    } catch (e) { console.error('[shell] setupBookmarks error', e); }
  }

  backBtn.addEventListener('click', async () => {
    if (!containerId) return;
    await (window as any).tabsAPI.goBack({ containerId });
  });
  fwdBtn.addEventListener('click', async () => {
    if (!containerId) return;
    await (window as any).tabsAPI.goForward({ containerId });
  });
  // tab bar: use the static #tabs element declared in HTML
  const tabsBar = document.getElementById('tabs') as HTMLElement;

  // F12/F11 -> toggle DevTools via preload API
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'F12' || ev.key === 'F11') {
      try {
        // Prefer toggling the focused view's DevTools when available
        try { (window as any).devtoolsAPI.toggleView(); } catch (e) { /* fallback below */ }
        try { (window as any).devtoolsAPI.toggle(); } catch (e) { /* ignore */ }
      } catch (e) { console.error('devtools toggle error', e); }
    }
  });

  function renderTabs(tabs: any[], currentUrl?: string) {
    tabsBar.innerHTML = '';
    // render tabs exactly as reported by main; do not invent dummies here
    const effectiveTabs = (tabs && tabs.length > 0) ? tabs.slice() : [];
    currentTabs = effectiveTabs;
    // Ensure at least three tabs are shown in the UI even if main reports fewer
    if (effectiveTabs.length === 0) {
      effectiveTabs.push({ url: 'about:blank', title: '' });
      effectiveTabs.push({ url: 'about:blank', title: '' });
      effectiveTabs.push({ url: 'about:blank', title: '' });
    } else if (effectiveTabs.length === 1) {
      effectiveTabs.push({ url: 'about:blank', title: '' });
      effectiveTabs.push({ url: 'about:blank', title: '' });
    } else if (effectiveTabs.length === 2) {
      // If only two reported, add a blank third slot
      effectiveTabs.push({ url: 'about:blank', title: '' });
    }
    effectiveTabs.forEach((t:any, idx:number)=>{
      const wrap = document.createElement('div'); wrap.className = 'tab-wrap';
      const btn = document.createElement('button'); btn.className = 'tab-btn';
      // Prefer tab title, fall back to container name + index when no title/url present
      const containerName = (window as any).__containerName ?? '';
      const titleFromMain = t.title && t.title.length > 0 ? t.title : null;
      const urlFromMain = t.url || '';
      const looksLikeDev = (titleFromMain && /devtools/i.test(titleFromMain)) || /devtools:|devtools\/|chrome-devtools/i.test(urlFromMain) || (titleFromMain && titleFromMain.startsWith('Dev-'));
      const label = looksLikeDev ? (`Dev-${containerName}`) : (titleFromMain || urlFromMain || ((containerName ? (containerName + ' ') : '') + 'Tab ' + (idx+1)));
      const span = document.createElement('span');
      span.textContent = label;
      span.style.display = 'inline-block';
      span.style.maxWidth = '360px';
      span.style.overflow = 'hidden';
      span.style.textOverflow = 'ellipsis';
      span.style.whiteSpace = 'nowrap';
      // If this tab looks like a DevTools tab, prepend a common icon
      if (looksLikeDev) {
        try {
          const ico = document.createElement('img');
          // use renderer-served favicon; adjust path if you want a packaged asset
          ico.src = '/favicon.ico';
          ico.style.width = '16px';
          ico.style.height = '16px';
          ico.style.marginRight = '8px';
          ico.style.verticalAlign = 'middle';
          btn.appendChild(ico);
        } catch (e) { /* ignore */ }
      }
      btn.appendChild(span);
      btn.title = label;
      // Use activeIndex provided by main process as the single source of truth
      const activeIndex = (window as any).__activeIndex ?? 0;
      if (activeIndex === idx) btn.classList.add('tab-active');
      btn.addEventListener('click', async ()=>{
        try {
          console.log('[shell] tab click idx=', idx, 'containerId=', containerId);
          try { (document.getElementById('url') as HTMLInputElement).value = t.url || ''; } catch {}
          try {
            const tabsAPI = (window as any).tabsAPI;
            if (!tabsAPI || typeof tabsAPI.switchTab !== 'function') {
              console.error('[shell] tabsAPI.switchTab not available');
            } else {
              await tabsAPI.switchTab({ containerId, index: idx });
            }
          } catch (e) { console.error('[shell] switchTab error', e); }
          // update currentTabs active index locally so bookmark handlers target correct tab
          (window as any).__activeIndex = idx;
          lastLocalActiveSet = Date.now();
          // update DOM active class immediately for snappy UI
          try {
            const allBtns = tabsBar.querySelectorAll('.tab-btn');
            allBtns.forEach((b:any, i:number) => {
              if (i === idx) b.classList.add('tab-active'); else b.classList.remove('tab-active');
            });
          } catch (e) { console.error('[shell] update active class error', e); }
        } catch (e) { console.error('[shell] tab click error', e); }
      });
      // close button
      const close = document.createElement('button'); close.className = 'tab-close'; close.textContent = 'x';
      close.addEventListener('click', async (ev)=>{
        try {
          ev.stopPropagation();
          console.log('[shell] tab close requested idx=', idx, 'containerId=', containerId, 'currentTabsLen=', (currentTabs||[]).length, 'currentTabs=', (currentTabs||[]).map(t=>t.url||t.title));
          // prevent closing the last tab from renderer side to avoid leaving no views
          if (!currentTabs || currentTabs.length <= 1) {
            console.log('[shell] prevent closing last tab from renderer -> letting main handle blank tab creation');
            // Do not call createTab from renderer -- main will ensure at least one view remains.
            return;
          }
          if (!containerId) return;
          const ok = await (window as any).tabsAPI.closeTab({ containerId, index: idx });
          console.log('[shell] tab close ipc returned ok=', ok);
          // Do NOT perform optimistic UI removal here. The main process will send an updated
          // `container.context` (tabs) which will trigger renderTabs with the canonical state.
          // Optimistic updates caused a race where renderer-filtered tabs were computed from
          // an already-updated currentTabs, leading to both tabs disappearing.
        } catch (e) { console.error('[shell] tab close error', e); }
      });
      wrap.appendChild(btn); wrap.appendChild(close); tabsBar.appendChild(wrap);
    });
    // Always show bookmarks
    try {
      const bmRow = document.getElementById('bookmark-row');
      if (bmRow) bmRow.style.display = 'flex';
      // ensure url input shows currentUrl for active tab, but filter out shell/dev URLs
      try {
        if (currentUrl && document.getElementById('url')) {
          let accept = false;
          try {
            const u = new URL(currentUrl);
            if (/^https?:$/i.test(u.protocol) && u.hostname !== 'localhost' && !u.pathname.includes('containerShell.html')) accept = true;
          } catch {}
          if (accept) (document.getElementById('url') as HTMLInputElement).value = currentUrl;
        }
      } catch (e) { console.error('[shell] set url error', e); }
    } catch (e) { console.error('[shell] renderTabs error', e); }
  }

  async function refreshTabs() {
    try {
      // fetch tabs via IPC (fall back to no-op)
      // tabs rendering will be driven by main sending container.context with tabs
    } catch {}
  }

  // update url input when main process sends context updates including current URL and tabs
  window.containerShellAPI.onContext((ctx: any) => {
    containerId = ctx?.containerId;
    // containerName available from main
    try { (window as any).__containerName = ctx?.containerName ?? ((window as any).__containerName ?? ''); } catch {}
    try {
      const cur = ctx?.currentUrl;
      if (cur) {
        let accept = false;
        try {
          const u = new URL(cur);
          if (/^https?:$/i.test(u.protocol) && u.hostname !== 'localhost' && !u.pathname.includes('containerShell.html')) accept = true;
        } catch {}
        if (accept) try { (document.getElementById('url') as HTMLInputElement).value = cur; } catch {}
      }
    } catch (e) { console.error('[shell] onContext url set error', e); }
    try { if (ctx?.tabs) {
      // Prefer local recent interactions: if renderer initiated a local navigation recently, avoid overriding activeIndex
      const now = Date.now();
      const age = now - (lastLocalActiveSet || 0);
      const thresholdMs = 1200; // ignore main activeIndex updates within this ms after local action
      if (age > thresholdMs) {
        (window as any).__activeIndex = ctx.activeIndex ?? ((window as any).__activeIndex ?? 0);
      }
      renderTabs(ctx.tabs, ctx?.currentUrl);
    } } catch (e) { console.error('[shell] onContext renderTabs error', e); }
    try { setupBookmarks(); } catch (e) { console.error('[shell] setupBookmarks error', e); }
  });

  // Listen for devtools open/close notifications from main and update tabs UI
  try {
    if ((window as any).containerShellAPI && typeof (window as any).containerShellAPI.onDevtoolsChange === 'function') {
      (window as any).containerShellAPI.onDevtoolsChange((p: any) => {
        try {
          if (!p || !p.containerId || p.containerId !== containerId) return;
          const idx = (p.tabIndex ?? 0);
          const name = p.containerName ?? ((window as any).__containerName ?? '');
          // Ensure currentTabs has slot
          if (!currentTabs) currentTabs = [];
          if (!currentTabs[idx]) currentTabs[idx] = { url: '', title: '' };
          if (p.isOpen) {
            currentTabs[idx].title = `Dev-${name}`;
            try { currentTabs[idx].favicon = '/favicon.ico'; } catch {}
          } else {
            // restore to URL-based title (main will send context shortly, but do a best-effort)
            currentTabs[idx].title = currentTabs[idx].url || '';
            try { currentTabs[idx].favicon = null; } catch {}
          }
          try { renderTabs(currentTabs); } catch (e) { console.error('[shell] renderTabs after devtools change error', e); }
        } catch (e) { console.error('[shell] onDevtoolsChange handler error', e); }
      });
    }
  } catch (e) { /* ignore */ }
});


