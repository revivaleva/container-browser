import http from 'node:http';
import { URL } from 'node:url';
import { promises as fsp, existsSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DB } from './db';
import { openContainerWindow, isContainerOpen, closeContainer, waitForContainerClosed, getActiveWebContents } from './containerManager';
import { getToken } from './tokenStore';
import { session } from 'electron';
import setCookieParser from 'set-cookie-parser';
import crypto from 'node:crypto';

const locks = new Set<string>();

function jsonResponse(res: http.ServerResponse, status: number, body: any) {
  const s = JSON.stringify(body);
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
          if (!c) throw new Error('container not found');
          // ensure opened and restored
          if (!isContainerOpen(id)) {
            await openContainerWindow(c, undefined, { restore: true });
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
            const BASE_URL = process.env.AUTH_API_BASE || 'https://2y8hntw0r3.execute-api.ap-northeast-1.amazonaws.com/prod';
            const url = (BASE_URL.replace(/\/$/, '')) + '/auth/validate';
            const ac = new AbortController();
            const timeoutMs = 20000; // auth call timeout (part of overall 60s)
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

          if (locks.has(contextId)) return jsonResponse(res, 409, { ok: false, error: 'context busy' });
          locks.add(contextId);
          const tstart = Date.now();
          try {
            // resolve container
            const c = DB.getContainer(contextId);
            if (!c) throw new Error('container not found');
            // ensure container open
            if (!isContainerOpen(contextId)) {
              await openContainerWindow(c, undefined, { restore: true });
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
            if (command === 'navigate') {
              const url = String(body.url || '');
              if (!url) return jsonResponse(res, 400, { ok: false, error: 'missing url' });
              try {
                await wc.loadURL(url);
                if (options.waitForSelector) {
                  const ok = await waitForSelector(options.waitForSelector, timeoutMs);
                  if (!ok) return jsonResponse(res, 504, { ok: false, error: 'timeout waiting for selector' });
                }
                navigationOccurred = true;
              } catch (e:any) { return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) }); }
            } else if (command === 'click' || command === 'type' || command === 'eval') {
              const selector = body.selector;
              if ((command === 'click' || command === 'type') && !selector) return jsonResponse(res, 400, { ok: false, error: 'missing selector' });
              if (options.waitForSelector) {
                const ok = await waitForSelector(options.waitForSelector, timeoutMs);
                if (!ok) return jsonResponse(res, 504, { ok: false, error: 'timeout waiting for selector' });
              }
              try {
                if (command === 'click') {
                  let script: string;
                  if (typeof selector === 'string' && selector.startsWith('xpath:')) {
                    const xp = selector.slice(6);
                    script = `(function(){const node = document.evaluate(${JSON.stringify(xp)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; if(!node) throw new Error('selector not found'); node.click(); return true;})()`;
                  } else {
                    script = `(function(sel){const el=document.querySelector(sel); if(!el) throw new Error('selector not found'); el.click(); return true;})(${JSON.stringify(selector)});`;
                  }
                  await wc.executeJavaScript(script, true);
                } else if (command === 'type') {
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
                  const expr = String(body.eval || '');
                  if (!expr) return jsonResponse(res, 400, { ok: false, error: 'missing eval' });
                  const rval = await wc.executeJavaScript(`(function(){return (${expr});})()`, true);
                  const elapsed = Date.now() - tstart;
                  return jsonResponse(res, 200, { ok: true, command, result: rval, elapsedMs: elapsed });
                }
              } catch (e:any) {
                const msg = String(e?.message || e);
                if (msg.includes('selector not found')) return jsonResponse(res, 404, { ok: false, error: 'selector not found' });
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
                const full = await wc.executeJavaScript('document.documentElement.outerHTML', true);
                if (options.returnHtml === 'trim') html = String(full).slice(0, 32 * 1024);
                else html = String(full);
              } catch {}
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
            return jsonResponse(res, 200, { ok: true, command, navigationOccurred, url: urlNow, title, html, screenshotPath: shotPath, cookies, elapsedMs: elapsed });
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

      jsonResponse(res, 404, { ok: false, error: 'not found' });
    } catch (e:any) {
      jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
    }
  });
  srv.listen(port, '127.0.0.1');
  console.log('[exportServer] listening on 127.0.0.1:' + port);
  return srv;
}


