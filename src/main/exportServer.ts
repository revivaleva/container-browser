import http from 'node:http';
import { URL } from 'node:url';
import { promises as fsp, existsSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import { DB } from './db';
import { openContainerWindow, isContainerOpen, closeContainer, waitForContainerClosed, getActiveWebContents } from './containerManager';
import { getToken, getOrCreateDeviceId } from './tokenStore';
import { getAuthApiBase, getAuthTimeoutMs } from './settings';
import { session } from 'electron';
import type { WebContents } from 'electron';
import setCookieParser from 'set-cookie-parser';
import crypto, { randomUUID } from 'node:crypto';
import type { Container, Fingerprint, ProxyConfig } from '../shared/types';

const locks = new Set<string>();

function jsonResponse(res: http.ServerResponse, status: number, body: any) {
  const s = JSON.stringify(body);
  try {
    // 軽量ログ：ステータス・bodyの要点・文字長を出力（ログ失敗は無視）
    let bodySummary: any = undefined;
    if (body && typeof body === 'object') {
      bodySummary = { ok: (body as any).ok, error: (body as any).error };
    } else {
      bodySummary = body;
    }
    console.log('[exportServer] respond', { status, bodySummary, len: s.length });
  } catch (e) { /* ignore logging errors */ }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(s);
}

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let acc = '';
    req.on('data', (d) => acc += d.toString('utf8'));
    req.on('end', () => {
      try { if (!acc) return resolve({}); resolve(JSON.parse(acc)); } catch (e) { return reject(e); }
    });
    req.on('error', reject);
  });
}

function parseBodyRaw(req: http.IncomingMessage): Promise<{ raw: string; json: any }> {
  return new Promise((resolve, reject) => {
    let acc = '';
    req.on('data', (d) => acc += d.toString('utf8'));
    req.on('end', () => {
      try { if (!acc) return resolve({ raw: '', json: {} }); return resolve({ raw: acc, json: JSON.parse(acc) }); } catch (e) { return reject(e); }
    });
    req.on('error', reject);
  });
}

type NavigationWebContents = WebContents & {
  once(event: string, listener: (...args: unknown[]) => void): NavigationWebContents;
  removeListener(event: string, listener: (...args: unknown[]) => void): NavigationWebContents;
};

function waitForNavigationComplete(wc: WebContents, timeoutMs: number): Promise<void> {
  const raw = wc as NavigationWebContents;
  return new Promise((resolve, reject) => {
    let timeoutId: NodeJS.Timeout | null = null;
    const onNavigate = () => {
      cleanup();
      resolve();
    };
    const onFail = (_event: unknown, errorCode: number, errorDescription: string, _validatedURL: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      cleanup();
      reject(new Error(errorDescription || `navigation failed (${errorCode})`));
    };
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      raw.removeListener('did-navigate', onNavigate);
      raw.removeListener('did-fail-load', onFail);
    };
    // did-navigateで通信成功を判定（早期レスポンス）
    raw.once('did-navigate', onNavigate);
    raw.once('did-fail-load', onFail);
    const effectiveTimeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 0;
    if (effectiveTimeout > 0) {
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('navigation timeout'));
      }, effectiveTimeout);
    }
  });
}

function determineProfilePath(container: any): string | null {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (container.userDataDir && existsSync(container.userDataDir)) return container.userDataDir;
  const m = String(container.partition || '').match(/^persist:(.+)$/);
  if (m) {
    const p = path.join(appdata, 'container-browser', 'Partitions', m[1]);
    if (existsSync(p)) return p;
  }
  return null;
}

export function startExportServer(port = Number(process.env.CONTAINER_EXPORT_PORT) || 3001) {
  const srv = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url || '', `http://${req.headers.host || '127.0.0.1'}`);
      if (req.method === 'POST' && u.pathname === '/internal/export-restored') {
        const body = await parseBody(req);
        const id = String(body && body.id || '');
        const forceCopy = !!body.forceCopy;
        const ensureAuth = body.ensureAuth === undefined ? true : !!body.ensureAuth;
        const returnToken = !!body.returnToken;
        const TOTAL_TIMEOUT_MS = Number(body.timeoutMs) || 60000; // total timeout default 60s
        if (!id) return jsonResponse(res, 400, { ok: false, error: 'missing id' });
        if (locks.has(id)) return jsonResponse(res, 409, { ok: false, error: 'export in progress' });
        locks.add(id);
        const startAll = Date.now();
        try {
          const c = DB.getContainer(id);
          if (!c) return jsonResponse(res, 404, { ok: false, error: 'container not found' });
          // ensure opened and restored (open via API should be single-tab)
          if (!isContainerOpen(id)) {
            await openContainerWindow(c, undefined, { restore: true, singleTab: true });
          }

          // auth injection (optional - default true)
          let injectedCookieNames: string[] = [];
          let returnedToken: string | null = null;
          if (ensureAuth) {
            // check overall timeout
            if (Date.now() - startAll > TOTAL_TIMEOUT_MS) throw new Error('timeout during export');
            // obtain token
            const token = await getToken();
            if (!token) throw new Error('no token available for ensureAuth');
            if (returnToken) returnedToken = token;
            
            // call auth.validate
            const BASE_URL = getAuthApiBase();
            const url = (BASE_URL.replace(/\/$/, '')) + '/auth/validate';
            const ac = new AbortController();
            const timeoutMs = Math.max(20000, getAuthTimeoutMs() * 2); // auth call timeout (part of overall 60s)
            const idt = setTimeout(() => ac.abort(), timeoutMs);
            let resp;
            try {
              resp = await (global as any).fetch(url, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_id: `export-${Date.now()}`, device_info: { name: 'container-browser', hostname: require('os').hostname() } }),
                signal: ac.signal
              });
            } finally { clearTimeout(idt); }
            if (!resp || !resp.ok) throw new Error('auth.validate failed');

            // parse set-cookie headers
            let rawCookies: string[] = [];
            try {
              const raw = (resp.headers as any).raw && (resp.headers as any).raw()['set-cookie'];
              if (raw && Array.isArray(raw)) rawCookies = raw;
              else {
                const s = resp.headers.get && resp.headers.get('set-cookie');
                if (s) rawCookies = [s];
              }
            } catch (e) { rawCookies = []; }

            const parsed = rawCookies.length ? setCookieParser.parse(rawCookies) : [];
            if (parsed.length === 0) {
              // no cookies; proceed but mark authInjected false
            } else {
              // get Electron session from partition and inject cookies
              try {
                const ses = session.fromPartition(c.partition);
                for (const pc of parsed) {
                  const domain = pc.domain ? pc.domain.replace(/^\./, '') : null;
                  const cookieObj: any = {
                    url: domain ? `https://${domain}` : `https://${pc.domain || 'localhost'}`,
                    name: pc.name,
                    value: pc.value,
                    path: pc.path || '/',
                    secure: !!pc.secure,
                    httpOnly: !!pc.httpOnly,
                    sameSite: (pc.sameSite === 'Strict' ? 'strict' : pc.sameSite === 'None' ? 'no_restriction' : 'lax')
                  };
                  // expires -> expirationDate (seconds)
                  if (pc.expires) {
                    const exp = new Date(pc.expires).getTime();
                    if (!isNaN(exp)) cookieObj.expirationDate = Math.floor(exp / 1000);
                  }
                  // inject
                  try { await ses.cookies.set(cookieObj); injectedCookieNames.push(pc.name); } catch (e) { console.error('[exportServer] cookie set error', e); throw e; }
                }
              } catch (e) { console.error('[exportServer] cookie injection error', e); throw e; }
            }
          }

          // NOTE: Profile copy/return has been disabled. The export API no longer returns
          // a filesystem copy of the profile for external use. If you need an authenticated
          // session to be available externally, use the remote exec API (/internal/exec)
          // or the ensureAuth flow which injects cookies into the running session.
          return jsonResponse(res, 200, { ok: true, lastSessionId: c.lastSessionId ?? null, authInjected: ensureAuth, token: returnedToken ?? null, cookieNames: injectedCookieNames.length ? injectedCookieNames : null, message: 'profile copy disabled' });
        } catch (err:any) {
          const msg = String(err?.message || err);
          if (msg && msg.toLowerCase().includes('timeout')) return jsonResponse(res, 504, { ok: false, error: 'timeout during export' });
          return jsonResponse(res, 500, { ok: false, error: msg });
        } finally { locks.delete(id); }
      }
      // remote exec endpoint: DOM operations / click / type / navigate / eval
      if (req.method === 'POST' && u.pathname === '/internal/exec') {
        try {
          const raw = await parseBodyRaw(req);
          const body = raw.json || {};
          // optional HMAC check
          const secret = process.env.REMOTE_EXEC_HMAC;
          if (secret) {
            const sig = req.headers['x-remote-hmac'] as string | undefined;
            const mac = crypto.createHmac('sha256', secret).update(raw.raw).digest('hex');
            if (!sig || sig !== mac) return jsonResponse(res, 401, { ok: false, error: 'hmac mismatch' });
          }
          const contextId = String(body.contextId || '');
          const command = String(body.command || '');
          const options = body.options || {};
          const timeoutMs = Number(options.timeoutMs || 30000);
          if (!contextId || !command) return jsonResponse(res, 400, { ok: false, error: 'missing contextId or command' });

          console.log('[exportServer] exec request', { contextId, command, url: body.url, selector: body.selector, evalId: body.exprId, options });
          if (locks.has(contextId)) return jsonResponse(res, 409, { ok: false, error: 'context busy' });
          locks.add(contextId);
          const tstart = Date.now();
          try {
          // resolve container
          const c = DB.getContainer(contextId);
          if (!c) throw new Error('container not found');
          // ensure container open (when opened via API prefer single-tab)
          if (!isContainerOpen(contextId)) {
            await openContainerWindow(c, undefined, { restore: true, singleTab: true });
          }
            // get active webContents
            const wc = getActiveWebContents(contextId);
            if (!wc) return jsonResponse(res, 404, { ok: false, error: 'no active webContents' });

            // helper: wait for selector
            const waitForSelector = async (selector: string, ms: number) => {
              // support xpath: prefix
              if (typeof selector === 'string' && selector.startsWith('xpath:')) {
                const xp = selector.slice(6);
                const poll = `(function(xp){return new Promise((resolve)=>{const t0=Date.now();(function p(){try{const n=document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; if(n) return resolve(true);}catch{}if(Date.now()-t0> ${ms}) return resolve(false);setTimeout(p,200);})();})})(${JSON.stringify(xp)});`;
                try { const ok = await wc.executeJavaScript(poll, true); return !!ok; } catch { return false; }
              }
              const poll = `(function(sel){return new Promise((resolve)=>{const t0=Date.now();(function p(){try{const el=document.querySelector(sel);if(el) return resolve(true);}catch{}if(Date.now()-t0> ${ms}) return resolve(false);setTimeout(p,200);})();})})(${JSON.stringify(selector)});`;
              try { const ok = await wc.executeJavaScript(poll, true); return !!ok; } catch { return false; }
            };

            let navigationOccurred = false;
            let evalResult: any = undefined;
            if (command === 'navigate') {
              const url = String(body.url || '');
              if (!url) return jsonResponse(res, 400, { ok: false, error: 'missing url' });
              try {
                const navTimeoutMs = Number(options.navigationTimeoutMs ?? timeoutMs);
                // 先にナビゲーション完了待機をセットしてから loadURL を呼ぶ（did-navigate を見逃さないため）
                const navPromise = waitForNavigationComplete(wc, navTimeoutMs);
                await wc.loadURL(url);
                await navPromise;
                if (options.waitForSelector) {
                  const ok = await waitForSelector(options.waitForSelector, timeoutMs);
                  if (!ok) return jsonResponse(res, 504, { ok: false, error: 'timeout waiting for selector' });
                }
                navigationOccurred = true;
              } catch (e:any) { return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) }); }
            } else if (command === 'type' || command === 'eval') {
              const selector = body.selector;
              if (command === 'type' && !selector) return jsonResponse(res, 400, { ok: false, error: 'missing selector' });
              if (options.waitForSelector) {
                const ok = await waitForSelector(options.waitForSelector, timeoutMs);
                if (!ok) return jsonResponse(res, 504, { ok: false, error: 'timeout waiting for selector' });
              }
              try {
                if (command === 'type') {
                  const text = String(body.text || '');
                  let script: string;
                  if (typeof selector === 'string' && selector.startsWith('xpath:')) {
                    const xp = selector.slice(6);
                    script = `(function(txt){const node = document.evaluate(${JSON.stringify(xp)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; if(!node) throw new Error('selector not found'); node.focus(); node.value = txt; node.dispatchEvent(new Event('input',{bubbles:true})); return true;})(${JSON.stringify(text)});`;
                  } else {
                    script = `(function(sel, txt){const el=document.querySelector(sel); if(!el) throw new Error('selector not found'); el.focus(); el.value = txt; el.dispatchEvent(new Event('input',{bubbles:true})); return true;})(${JSON.stringify(selector)}, ${JSON.stringify(text)});`;
                  }
                  await wc.executeJavaScript(script, true);
                } else if (command === 'eval') {
                  const rawEval = body.eval;
                  if (rawEval === undefined || rawEval === null) return jsonResponse(res, 400, { ok: false, error: 'missing eval' });
                  // Support client sending JSON-stringified expr; try parse but fall back to raw string
                  let exprStr: string = rawEval as any;
                  if (typeof rawEval === 'string') {
                    try { const parsed = JSON.parse(rawEval); if (typeof parsed === 'string') exprStr = parsed; } catch {}
                  } else {
                    exprStr = String(rawEval);
                  }
                  // Execute the expression directly (no template wrapping) and capture runtime/syntax errors with details
                  try {
                    evalResult = await wc.executeJavaScript(exprStr, true);
                  } catch (e:any) {
                    const message = String(e?.message || e);
                    const stack = String(e?.stack || '');
                    const stackShort = stack.split('\\n').slice(0,5).join('\\n');
                    // try to extract line/column from stack (format: <anonymous>:line:column)
                    let line: number | null = null;
                    let column: number | null = null;
                    const m = stack.match(/:(\\d+):(\\d+)/);
                    if (m) { line = Number(m[1]); column = Number(m[2]); }
                    // snippet: extract corresponding line from expr if available
                    let snippet: string | null = null;
                    try {
                      if (line !== null) {
                        const lines = exprStr.split(/\\r?\\n/);
                        const idx = Math.max(0, line - 1);
                        snippet = (lines[idx] || '').trim().slice(0, 200);
                      } else {
                        snippet = String(exprStr).slice(0, 200);
                      }
                    } catch {}
                    const context = String(exprStr).slice(-80);
                    const errorDetail: any = { message, stack: stackShort, line, column, snippet, context, exprId: body.exprId || null, sourceSnippet: body.sourceSnippet || null };
                    return jsonResponse(res, 500, { ok: false, error: message, errorDetail });
                  }
                  // do not return here; allow post-collection collection (html/cookies/screenshot) to run and include evalResult
                }
              } catch (e:any) {
                const msg = String(e?.message || e);
                if (msg.includes('selector not found')) return jsonResponse(res, 404, { ok: false, error: 'selector not found' });
                return jsonResponse(res, 500, { ok: false, error: msg });
              }
            } else if (command === 'setFileInput') {
              // ファイル入力を設定するコマンド
              const selector = body.selector;
              const fileUrl = body.fileUrl;
              const fileName = body.fileName || 'file.jpg';
              const fileType = body.fileType || 'image/jpeg';

              if (!selector) return jsonResponse(res, 400, { ok: false, error: 'missing selector' });
              if (!fileUrl) return jsonResponse(res, 400, { ok: false, error: 'missing fileUrl' });

              if (options.waitForSelector) {
                const ok = await waitForSelector(options.waitForSelector, timeoutMs);
                if (!ok) return jsonResponse(res, 504, { ok: false, error: 'timeout waiting for selector' });
              }

              try {
                // 1. Google Drive URLを実際の画像URLに変換
                let actualFileUrl = fileUrl;
                if (fileUrl.includes('drive.google.com/file/d/')) {
                  const match = fileUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
                  if (match && match[1]) {
                    actualFileUrl = `https://drive.google.com/uc?export=view&id=${match[1]}`;
                  }
                }

                // 2. URLからファイルを取得（Node.js側で実行）
                let response: Response;
                try {
                  response = await (global as any).fetch(actualFileUrl);
                } catch (fetchError: any) {
                  return jsonResponse(res, 500, { 
                    ok: false, 
                    error: `Failed to fetch file: ${String(fetchError?.message || fetchError)}` 
                  });
                }

                if (!response.ok) {
                  return jsonResponse(res, 500, { 
                    ok: false, 
                    error: `Failed to fetch file: HTTP ${response.status}` 
                  });
                }

                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                const base64Data = buffer.toString('base64');

                // 3. ElectronのwebContentsでファイル入力を設定
                const script = `
                  (function(sel, base64Data, name, type) {
                    try {
                      const input = document.querySelector(sel);
                      if (!input) throw new Error('selector not found');
                      if (input.type !== 'file') throw new Error('element is not a file input');
                      
                      // Base64データをBlobに変換
                      const byteCharacters = atob(base64Data);
                      const byteNumbers = new Array(byteCharacters.length);
                      for (let i = 0; i < byteCharacters.length; i++) {
                        byteNumbers[i] = byteCharacters.charCodeAt(i);
                      }
                      const byteArray = new Uint8Array(byteNumbers);
                      const blob = new Blob([byteArray], { type: type });
                      const file = new File([blob], name, { type: type });
                      
                      // DataTransferを使用してファイルを設定
                      try {
                        const dataTransfer = new DataTransfer();
                        dataTransfer.items.add(file);
                        input.files = dataTransfer.files;
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        return { success: true, selector: sel, fileName: name, fileType: type };
                      } catch (dtError) {
                        // DataTransferが失敗した場合、直接filesを設定する方法を試す
                        // 注意: これはブラウザのセキュリティ制約により動作しない可能性が高い
                        throw new Error('DataTransfer failed: ' + String(dtError?.message || dtError));
                      }
                    } catch (e) {
                      throw new Error(String(e?.message || e));
                    }
                  })(${JSON.stringify(selector)}, ${JSON.stringify(base64Data)}, ${JSON.stringify(fileName)}, ${JSON.stringify(fileType)});
                `;

                try {
                  const result = await wc.executeJavaScript(script, true);
                  if (result && (result as any).success) {
                    return jsonResponse(res, 200, { 
                      ok: true, 
                      result: {
                        success: true,
                        selector,
                        fileName,
                        fileType
                      }
                    });
                  } else {
                    return jsonResponse(res, 500, { 
                      ok: false, 
                      error: 'Failed to set file input: unexpected result' 
                    });
                  }
                } catch (jsError: any) {
                  const msg = String(jsError?.message || jsError);
                  if (msg.includes('selector not found')) {
                    return jsonResponse(res, 404, { ok: false, error: 'selector not found' });
                  }
                  if (msg.includes('not a file input')) {
                    return jsonResponse(res, 400, { ok: false, error: 'element is not a file input' });
                  }
                  if (msg.includes('DataTransfer failed')) {
                    // セキュリティ制約により失敗した場合の詳細なエラーメッセージ
                    return jsonResponse(res, 500, { 
                      ok: false, 
                      error: 'Failed to set file input: browser security restrictions prevent programmatic file input setting. This is expected behavior in browsers.' 
                    });
                  }
                  return jsonResponse(res, 500, { ok: false, error: `Failed to set file input: ${msg}` });
                }
              } catch (e: any) {
                const msg = String(e?.message || e);
                if (msg.includes('Failed to fetch')) {
                  return jsonResponse(res, 500, { ok: false, error: `Failed to fetch file: ${msg}` });
                }
                return jsonResponse(res, 500, { ok: false, error: msg });
              }
            } else {
              return jsonResponse(res, 400, { ok: false, error: 'unsupported command' });
            }

            // post-collection
            const urlNow = wc.getURL ? wc.getURL() : null;
            let title = null;
            try { title = wc.getTitle ? wc.getTitle() : null; } catch {}
            let html: string | null = null;
            if (options.returnHtml && options.returnHtml !== 'none') {
              try {
                // in-page sanitizer: clone DOM, remove styles/scripts/comments, strip inline styles and data: URLs
                const isTrim = (options.returnHtml === 'trim');
                const maxLen = isTrim ? (64 * 1024) : 0;
                
                // HTML取得にタイムアウト機構を追加
                const htmlTimeoutMs = 10000; // 10秒タイムアウト
                const htmlPromise = wc.executeJavaScript(`(function(maxLen,isTrim){
  try {
    const doc = document.documentElement.cloneNode(true);
    // remove style/link/script/noscript
    doc.querySelectorAll('style, link[rel="stylesheet"], script, noscript').forEach(n => n.remove());
    // remove comments
    try {
      const walker = document.createTreeWalker(doc, NodeFilter.SHOW_COMMENT, null, false);
      const comments = [];
      while (walker.nextNode()) comments.push(walker.currentNode);
      comments.forEach(c => c.parentNode && c.parentNode.removeChild(c));
    } catch(e) {}
    // strip inline styles
    doc.querySelectorAll('[style]').forEach(el => el.removeAttribute('style'));
    // remove data: URLs from src/href to avoid huge base64 blobs
    doc.querySelectorAll('[src],[href]').forEach(el => {
      try {
        const a = el.getAttribute('src') || el.getAttribute('href');
        if (typeof a === 'string' && a.startsWith('data:')) {
          if (el.hasAttribute('src')) el.setAttribute('src','');
          if (el.hasAttribute('href')) el.setAttribute('href','');
        }
      } catch(e) {}
    });
    // remove some meta selectors likely irrelevant
    const removeSelectors = ['meta[http-equiv]','meta[name=\"google-site-verification\"]','meta[name=\"robots\"]'];
    removeSelectors.forEach(s => { try { doc.querySelectorAll(s).forEach(n => n.remove()); } catch(e) {} });
    // remove class attributes from all elements without deleting elements themselves
    try { doc.querySelectorAll('[class]').forEach((el) => { try { el.removeAttribute('class'); } catch(e) {} }); } catch(e) {}
    // If trim mode requested, return only body innerHTML (to focus on content)
    let out = '';
    try {
      if (isTrim) {
        const b = doc.querySelector('body');
        out = b ? (b.innerHTML || '') : (doc.outerHTML || '');
      } else {
        out = doc.outerHTML || '';
      }
    } catch(e) { out = doc.outerHTML || ''; }
    if (typeof maxLen === 'number' && maxLen > 0) out = out.slice(0, maxLen);
    return out;
  } catch(e) { return null; }
})(${maxLen}, ${isTrim})`, true);

                const timeoutPromise = new Promise((_, reject) => {
                  setTimeout(() => reject(new Error('HTML fetch timeout')), htmlTimeoutMs);
                });

                const full = await Promise.race([htmlPromise, timeoutPromise]);
                html = full ? String(full) : null;
                const htmlLen = html ? html.length : 0;
                console.log('[exportServer] html len', htmlLen, 'contextId=', contextId);
              } catch (e:any) {
                console.error('[exportServer] html fetch error', e?.message || e);
                // HTML取得失敗時もレスポンスを継続
              }
            }
            // cookies
            let cookies: any[] | null = null;
            if (options.returnCookies) {
              try { const ses = session.fromPartition(c.partition); cookies = await ses.cookies.get({}); } catch {}
            }
            // screenshot
            let shotPath: string | null = null;
            if (options.screenshot) {
              try {
                const img = await wc.capturePage();
                const buf = img.toPNG();
                const shotsDir = path.join(process.cwd(), 'shots');
                if (!existsSync(shotsDir)) mkdirSync(shotsDir, { recursive: true });
                const fname = `exec-${contextId}-${Date.now()}.png`;
                const fp = path.join(shotsDir, fname);
                await fsp.writeFile(fp, buf);
                shotPath = fp;
              } catch (e) { console.error('[exportServer] screenshot error', e); }
            }

            const elapsed = Date.now() - tstart;
            const out: any = { ok: true, command, navigationOccurred, url: urlNow, title, html, screenshotPath: shotPath, cookies, elapsedMs: elapsed };
            if (typeof evalResult !== 'undefined') out.result = evalResult;
            return jsonResponse(res, 200, out);
          } catch (e:any) {
            const msg = String(e?.message || e);
            if (msg && msg.toLowerCase().includes('timeout')) return jsonResponse(res, 504, { ok: false, error: 'timeout' });
            return jsonResponse(res, 500, { ok: false, error: msg });
          } finally { locks.delete(contextId); }
        } catch (e:any) { return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) }); }
      }

      if ((req.method === 'DELETE' || req.method === 'POST') && u.pathname === '/internal/export-restored/delete') {
        // accept JSON body with path or query ?path=
        let body = {} as any;
        try { body = await parseBody(req); } catch {}
        const p = body.path || u.searchParams.get('path');
        if (!p) return jsonResponse(res, 400, { ok: false, error: 'missing path' });
        try { rmSync(String(p), { recursive: true, force: true }); return jsonResponse(res, 200, { ok: true }); } catch (e:any) { return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) }); }
      }

      // Create container endpoint
      if (req.method === 'POST' && u.pathname === '/internal/containers/create') {
        try {
          const body = await parseBody(req);
          const name = String(body && body.name || '').trim();
          const proxy: ProxyConfig | null = body.proxy ? {
            server: String(body.proxy.server || ''),
            username: body.proxy.username ? String(body.proxy.username) : undefined,
            password: body.proxy.password ? String(body.proxy.password) : undefined
          } : null;

          if (!name) return jsonResponse(res, 400, { ok: false, error: 'missing name' });
          if (proxy && !proxy.server) return jsonResponse(res, 400, { ok: false, error: 'proxy.server is required when proxy is provided' });

          const id = randomUUID();

          // Consume quota from token before creating container (only if token exists)
          try {
            const token = await getToken();
            
            // If no token, skip quota check and allow creation
            if (token) {
              const deviceId = getOrCreateDeviceId();
              const BASE_URL = getAuthApiBase();
              const timeoutMs = getAuthTimeoutMs();
              
              const ac = new AbortController();
              const idt = setTimeout(() => ac.abort(), timeoutMs);
              try {
                const useResp = await (global as any).fetch(
                  (BASE_URL.replace(/\/$/, '')) + '/auth/use',
                  {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ device_id: deviceId, count: 1 }),
                    signal: ac.signal
                  }
                );
                clearTimeout(idt);
                if (!useResp.ok) {
                  const errorCode = useResp.status === 409 ? 'QUOTA_EXCEEDED' : 'AUTH_FAILED';
                  const errorMsg = useResp.status === 409 ? 'Quota exceeded' : 'Failed to consume quota';
                  return jsonResponse(res, useResp.status === 409 ? 409 : 401, { ok: false, error: errorMsg, errorCode });
                }
              } catch (err: any) {
                clearTimeout(idt);
                if (err.name === 'AbortError') {
                  return jsonResponse(res, 504, { ok: false, error: 'auth timeout' });
                }
                throw err;
              }
            }
          } catch (err: any) {
            const msg = String(err?.message || err);
            return jsonResponse(res, 500, { ok: false, error: msg });
          }

          // Create container with fingerprint
          const fp: Fingerprint = {
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
            userAgent: undefined,
            locale: 'ja-JP',
            timezone: 'Asia/Tokyo',
            fingerprint: fp,
            proxy: proxy,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastSessionId: null
          };
          DB.upsertContainer(c);

          // Open the container window
          try {
            await openContainerWindow(c, undefined, { restore: true, singleTab: true });
          } catch (openErr: any) {
            console.error('[exportServer] failed to open container window', openErr);
            // Continue even if opening fails - container is created
          }

          return jsonResponse(res, 200, { ok: true, container: c });
        } catch (e:any) {
          return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
        }
      }

      // Set proxy for container endpoint (プロキシ変更専用API)
      if (req.method === 'POST' && u.pathname === '/internal/containers/set-proxy') {
        try {
          const body = await parseBody(req);
          const name = String(body && body.name || '').trim();
          const id = String(body && body.id || '').trim();
          
          if (!name && !id) return jsonResponse(res, 400, { ok: false, error: 'missing name or id' });
          
          // Find container by name or id
          const container = id ? DB.getContainer(id) : DB.getContainerByName(name);
          if (!container) {
            return jsonResponse(res, 404, { ok: false, error: 'container not found' });
          }

          // Parse proxy config
          const proxy: ProxyConfig | null = body.proxy ? {
            server: String(body.proxy.server || ''),
            username: body.proxy.username ? String(body.proxy.username) : undefined,
            password: body.proxy.password ? String(body.proxy.password) : undefined
          } : (body.proxy === null ? null : undefined);

          if (proxy && !proxy.server) {
            return jsonResponse(res, 400, { ok: false, error: 'proxy.server is required when proxy is provided' });
          }

          // Update container with proxy only
          const updated: Container = {
            ...container,
            proxy: proxy !== undefined ? proxy : container.proxy,
            updatedAt: Date.now(),
          };
          
          DB.upsertContainer(updated);
          console.log('[exportServer] set proxy for container', { containerId: container.id, containerName: container.name, hasProxy: !!proxy });

          return jsonResponse(res, 200, { ok: true, container: updated });
        } catch (e:any) {
          return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
        }
      }

      // Update container endpoint
      if (req.method === 'POST' && u.pathname === '/internal/containers/update') {
        try {
          const body = await parseBody(req);
          const name = String(body && body.name || '').trim();
          const id = String(body && body.id || '').trim();
          
          if (!name && !id) return jsonResponse(res, 400, { ok: false, error: 'missing name or id' });
          
          // Find container by name or id
          const container = id ? DB.getContainer(id) : DB.getContainerByName(name);
          if (!container) {
            return jsonResponse(res, 404, { ok: false, error: 'container not found' });
          }

          // Parse proxy config if provided (for backward compatibility, but prefer set-proxy endpoint)
          const proxy: ProxyConfig | null = body.proxy ? {
            server: String(body.proxy.server || ''),
            username: body.proxy.username ? String(body.proxy.username) : undefined,
            password: body.proxy.password ? String(body.proxy.password) : undefined
          } : (body.proxy === null ? null : undefined);

          // Update container
          const updated: Container = {
            ...container,
            ...(body.name ? { name: String(body.name).trim() } : {}),
            ...(proxy !== undefined ? { proxy } : {}),
            updatedAt: Date.now(),
          };
          
          DB.upsertContainer(updated);

          return jsonResponse(res, 200, { ok: true, container: updated });
        } catch (e:any) {
          return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
        }
      }

      // Close container endpoint: idempotent
      if (req.method === 'POST' && u.pathname === '/internal/export-restored/close') {
        try {
          const body = await parseBody(req);
          const id = String(body && body.id || '');
          if (!id) return jsonResponse(res, 400, { ok: false, error: 'missing id' });
          const c = DB.getContainer(id);
          if (!c) return jsonResponse(res, 404, { ok: false, error: 'container not found' });

          // clear any active locks for this context to avoid deadlocks from long-running ops
          try { locks.delete(id); } catch {}

          // If not open, return idempotent response
          if (!isContainerOpen(id)) return jsonResponse(res, 200, { ok: true, closed: false, message: 'not-open' });

          const runId = (crypto && (crypto as any).randomUUID) ? (crypto as any).randomUUID() : `${Date.now()}-${Math.floor(Math.random()*1000000)}`;
          const closedBy = req.headers['x-requested-by'] || null;
          console.log('[exportServer] close requested', { id, runId, closedBy, time: new Date().toISOString() });

          // attempt close
          try {
            const ok = closeContainer(id);
            if (!ok) {
              console.error('[exportServer] closeContainer returned false for', id);
              return jsonResponse(res, 500, { ok: false, error: 'internal' });
            }
            // wait for container to be fully removed
            try {
              const timeoutMs = Number(body && body.timeoutMs) || 30000;
              await waitForContainerClosed(id, timeoutMs);
            } catch (e:any) {
              console.error('[exportServer] waitForContainerClosed error', e);
              return jsonResponse(res, 500, { ok: false, error: 'internal' });
            }
            console.log('[exportServer] close completed', { id, runId, time: new Date().toISOString() });
            return jsonResponse(res, 200, { ok: true, closed: true, message: 'closed' });
          } catch (e:any) {
            console.error('[exportServer] close error', e);
            return jsonResponse(res, 500, { ok: false, error: 'internal' });
          }
        } catch (e:any) {
          return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
        }
      }

      jsonResponse(res, 404, { ok: false, error: 'not found' });
    } catch (e:any) {
      jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
    }
  });
  srv.listen(port, '127.0.0.1');
  console.log('[exportServer] listening on 127.0.0.1:' + port);
  return srv;
}


