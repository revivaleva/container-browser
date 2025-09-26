declare global {
  interface Window {
    containerShellAPI: {
      onContext: (cb: (ctx: any) => void) => () => void;
      navigate: (payload: { containerId: string; url: string }) => Promise<boolean>;
    }
  }
}

let containerId: string | undefined;
let currentTabs: any[] = [];

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
      const bm1 = document.getElementById('bm-1');
      const bm2 = document.getElementById('bm-2');
      // filter to global bookmarks (no containerId) with valid URL
      const globals = (bms || []).filter((b:any) => (!b.containerId || b.containerId === '') && b.url).slice(0, 2);
      if (!globals || globals.length === 0) {
        if (bmRow) bmRow.style.display = 'none';
        return;
      }
      if (bmRow) bmRow.style.display = 'flex';
      if (bm1) {
        const first = globals[0];
        bm1.textContent = first && first.title ? first.title : (first && first.url ? first.url : 'Bookmark');
        bm1.onclick = async () => {
          try {
            if (!containerId) return;
            const url = first && first.url ? first.url : undefined;
            if (!url) return;
            if (!currentTabs || currentTabs.length === 0) {
              await (window as any).tabsAPI.createTab({ containerId, url });
            } else {
              const activeIndex = (window as any).__activeIndex ?? 0;
              try { await (window as any).tabsAPI.switchTab({ containerId, index: activeIndex }); } catch {}
              await (window as any).containerShellAPI.navigate({ containerId, url });
            }
          } catch (e) { console.error(e); }
        };
      }
      if (bm2) {
        const second = globals[1];
        if (!second) { bm2.style.display = 'none'; }
        else {
          bm2.style.display = '';
          bm2.textContent = second && second.title ? second.title : second.url;
          bm2.onclick = async () => {
            try {
              if (!containerId) return;
              const url = second && second.url ? second.url : undefined;
              if (!url) return;
              if (!currentTabs || currentTabs.length === 0) {
                await (window as any).tabsAPI.createTab({ containerId, url });
              } else {
                const activeIndex = (window as any).__activeIndex ?? 0;
                try { await (window as any).tabsAPI.switchTab({ containerId, index: activeIndex }); } catch {}
                await (window as any).containerShellAPI.navigate({ containerId, url });
              }
            } catch (e) { console.error(e); }
          };
        }
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

  // F12 -> toggle DevTools via preload API
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'F12') {
      try { (window as any).devtoolsAPI.toggle(); } catch (e) { console.error('devtools toggle error', e); }
    }
  });

  function renderTabs(tabs: any[], currentUrl?: string) {
    tabsBar.innerHTML = '';
    // render tabs exactly as reported by main; do not invent dummies here
    const effectiveTabs = (tabs && tabs.length > 0) ? tabs.slice() : [];
    currentTabs = effectiveTabs;
    // Ensure at least two tabs are shown in the UI even if main reports fewer
    if (effectiveTabs.length === 0) {
      effectiveTabs.push({ url: 'about:blank', title: '' });
      effectiveTabs.push({ url: 'about:blank', title: '' });
    } else if (effectiveTabs.length === 1) {
      effectiveTabs.push({ url: 'about:blank', title: '' });
    }
    // Ensure at least two tabs are shown in the UI even if main reports fewer
    if (effectiveTabs.length === 0) {
      effectiveTabs.push({ url: 'about:blank', title: '' });
      effectiveTabs.push({ url: 'about:blank', title: '' });
    } else if (effectiveTabs.length === 1) {
      effectiveTabs.push({ url: 'about:blank', title: '' });
    }
    effectiveTabs.forEach((t:any, idx:number)=>{
      const wrap = document.createElement('div'); wrap.className = 'tab-wrap';
      const btn = document.createElement('button'); btn.className = 'tab-btn';
      const label = (t.title && t.title.length > 0) ? t.title : (t.url || 'tab');
      const span = document.createElement('span');
      span.textContent = label;
      span.style.display = 'inline-block';
      span.style.maxWidth = '360px';
      span.style.overflow = 'hidden';
      span.style.textOverflow = 'ellipsis';
      span.style.whiteSpace = 'nowrap';
      btn.appendChild(span);
      btn.title = label;
      // Use activeIndex provided by main process as the single source of truth
      const activeIndex = (window as any).__activeIndex ?? 0;
      if (activeIndex === idx) btn.classList.add('tab-active');
      btn.addEventListener('click', async ()=>{
        try {
          console.log('[shell] tab click idx=', idx, 'containerId=', containerId);
          try { (document.getElementById('url') as HTMLInputElement).value = t.url || ''; } catch {}
          await (window as any).tabsAPI.switchTab({ containerId, index: idx });
          // update currentTabs active index locally so bookmark handlers target correct tab
          (window as any).__activeIndex = idx;
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
  window.containerShellAPI.onContext((ctx) => {
    containerId = ctx?.containerId;
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
      // store activeIndex for fallback
      (window as any).__activeIndex = ctx.activeIndex ?? 0;
      renderTabs(ctx.tabs, ctx?.currentUrl);
    } } catch (e) { console.error('[shell] onContext renderTabs error', e); }
    try { setupBookmarks(); } catch (e) { console.error('[shell] setupBookmarks error', e); }
  });
});


