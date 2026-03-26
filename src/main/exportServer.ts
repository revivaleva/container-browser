import http from 'node:http';
import { URL } from 'node:url';
import { promises as fsp, existsSync, cpSync, rmSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import process from 'node:process';
const { app } = createRequire(import.meta.url)('electron');
import { DB } from './db';
import { openContainerWindow, isContainerOpen, closeContainer, waitForContainerClosed } from './containerManager';
import { getToken, getOrCreateDeviceId } from './tokenStore';
import { openedById } from './containerState';
import { getAuthApiBase, getAuthTimeoutMs } from './settings';
import setCookieParser from 'set-cookie-parser';
import crypto, { randomUUID } from 'node:crypto';
import type { Container, Fingerprint, ProxyConfig } from '../shared/types';
import { KameleoApi } from './kameleoApi';
import logger from '../shared/logger';

type MediaSelectorRule = { selector: string; type: 'image' | 'video' };
type MediaUrlItem = { url: string; type: 'image' | 'video'; selector: string };

const MAX_MEDIA_FILES = 100;
const MAX_MEDIA_FILE_SIZE = 500 * 1024 * 1024; // 500MB

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

function healthResponse(res: http.ServerResponse) {
  jsonResponse(res, 200, { ok: true, status: 'healthy', version: app.getVersion() });
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


async function waitForNavigationComplete(page: any, timeoutMs: number): Promise<void> {
  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (e) {
    console.warn('[exportServer] navigation timeout or error', e);
    // Continue anyway if timeout, as the page might have loaded partially
  }
}

function getPlaywrightPage(containerId: string) {
  const entry = openedById.get(containerId);
  return entry ? entry.playwrightPage : null;
}

function generateBezierPath(start: { x: number; y: number }, end: { x: number; y: number }, steps: number) {
  const points = [];
  // Use random control points for curve
  const ctrl1 = {
    x: start.x + (end.x - start.x) * Math.random(),
    y: start.y + (end.y - start.y) * 0.2
  };
  const ctrl2 = {
    x: start.x + (end.x - start.x) * 0.8,
    y: start.y + (end.y - start.y) * Math.random()
  };

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.pow(1 - t, 3) * start.x +
      3 * Math.pow(1 - t, 2) * t * ctrl1.x +
      3 * (1 - t) * Math.pow(t, 2) * ctrl2.x +
      Math.pow(t, 3) * end.x;
    const y = Math.pow(1 - t, 3) * start.y +
      3 * Math.pow(1 - t, 2) * t * ctrl1.y +
      3 * (1 - t) * Math.pow(t, 2) * ctrl2.y +
      Math.pow(t, 3) * end.y;
    points.push({ x: Math.round(x), y: Math.round(y) });
  }
  return points;
}


function determineProfilePath(container: any): string | null {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (container.userDataDir && existsSync(container.userDataDir)) return container.userDataDir;
  const m = String(container.partition || '').match(/^persist:(.+)$/);
  if (m) {
    const p = path.join(appdata, 'container-browser-for-kameleo', 'Partitions', m[1]);
    if (existsSync(p)) return p;
  }
  return null;
}

function isValidFolderName(name: string): boolean {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  return !trimmed.includes('..') && !/[\\/]/.test(trimmed);
}

function isHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getFileExtension(url: string, type: 'image' | 'video'): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const ext = pathname.split('.').pop()?.toLowerCase();
    if (ext && /^[a-z0-9]{2,5}$/.test(ext)) {
      return ext;
    }
  } catch { /* ignore */ }
  return type === 'video' ? 'mp4' : 'jpg';
}

function getMediaType(filepath: string): string {
  const ext = path.extname(filepath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime'
  };
  return mimeMap[ext] || 'application/octet-stream';
}

function getFileSize(filepath: string): number {
  try {
    const st = statSync(filepath);
    return st.size;
  } catch {
    return 0;
  }
}

async function downloadFile(
  url: string,
  destFolder: string,
  index: number,
  type: 'image' | 'video',
  timeoutMs: number
): Promise<{ success: boolean; filename: string; error?: string }> {
  try {
    const ext = getFileExtension(url, type);
    const filename = `media_${index}.${ext}`;
    const filepath = path.join(destFolder, filename);
    const controller = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, { signal: controller });
    if (!response.ok) {
      return { success: false, filename, error: `HTTP ${response.status}` };
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const len = Number(contentLength);
      if (!Number.isNaN(len) && len > MAX_MEDIA_FILE_SIZE) {
        return { success: false, filename, error: 'file too large' };
      }
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_MEDIA_FILE_SIZE) {
      return { success: false, filename, error: 'file too large' };
    }
    await fsp.writeFile(filepath, buffer);
    return { success: true, filename };
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.toLowerCase().includes('abort')) {
      return { success: false, filename: `media_${index}`, error: 'timeout' };
    }
    return { success: false, filename: `media_${index}`, error: msg };
  }
}

async function downloadAndSaveMedia(
  urls: MediaUrlItem[],
  destFolder: string,
  folderName: string,
  timeoutMs: number
): Promise<{
  ok: boolean;
  folder_path: string;
  files: Array<{
    index: number;
    type: string;
    filename: string;
    local_path: string | null;
    file_size?: number;
    media_type?: string;
    success: boolean;
    error_message?: string;
  }>;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    paths_comma_separated: string;
    total_bytes: number;
  };
  error_detail?: { message: string; code?: string };
}> {
  const fullPath = path.resolve(destFolder, folderName);
  try {
    mkdirSync(fullPath, { recursive: true });
  } catch (err: any) {
    return {
      ok: false,
      folder_path: fullPath,
      files: [],
      summary: { total: 0, succeeded: 0, failed: 0, paths_comma_separated: '', total_bytes: 0 },
      error_detail: { message: String(err?.message || 'Failed to create directory'), code: err?.code },
    };
  }

  const files: Array<{
    index: number;
    type: string;
    filename: string;
    local_path: string | null;
    file_size?: number;
    media_type?: string;
    success: boolean;
    error_message?: string;
  }> = [];
  const successPaths: string[] = [];
  let succeeded = 0;
  let failed = 0;
  let totalBytes = 0;

  for (let index = 0; index < urls.length; index++) {
    const item = urls[index];
    const result = await downloadFile(item.url, fullPath, index, item.type, timeoutMs);
    if (result.success) {
      const fullFilePath = path.join(fullPath, result.filename);
      const fileSize = getFileSize(fullFilePath);
      const mediaType = getMediaType(fullFilePath);
      totalBytes += fileSize;
      files.push({
        index,
        type: item.type,
        filename: result.filename,
        local_path: fullFilePath,
        file_size: fileSize,
        media_type: mediaType,
        success: true,
      });
      successPaths.push(fullFilePath);
      succeeded += 1;
    } else {
      files.push({
        index,
        type: item.type,
        filename: result.filename,
        local_path: null,
        success: false,
        error_message: result.error,
      });
      failed += 1;
    }
  }

  return {
    ok: failed === 0,
    folder_path: fullPath,
    files,
    summary: {
      total: urls.length,
      succeeded,
      failed,
      paths_comma_separated: successPaths.join(','),
      total_bytes: totalBytes,
    },
  };
}

export function startExportServer(port = Number(process.env.CONTAINER_EXPORT_PORT) || 3001) {
  const srv = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const u = new URL(req.url || '', `http://${req.headers.host || '127.0.0.1'}`);
      if (u.pathname === '/health') return healthResponse(res);
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
          // ensure opened and restored
          if (!isContainerOpen(id)) {
            await openContainerWindow(c, undefined, { singleTab: true });
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
            const timeoutMs = Math.max(20000, getAuthTimeoutMs() * 2); 
            const idt = setTimeout(() => ac.abort(), timeoutMs);
            let resp;
            try {
              resp = await fetch(url, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_id: `export-${Date.now()}`, device_info: { name: 'container-browser-for-kameleo', hostname: os.hostname() } }),
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
                const s = resp.headers.get('set-cookie');
                if (s) rawCookies = [s];
              }
            } catch (e) { rawCookies = []; }

            const parsed = rawCookies.length ? setCookieParser.parse(rawCookies) : [];
            if (parsed.length > 0) {
              const page = getPlaywrightPage(id);
              if (page) {
                const cookiesToSet = parsed.map(pc => ({
                  name: pc.name,
                  value: pc.value,
                  domain: pc.domain || 'localhost',
                  path: pc.path || '/',
                  expires: pc.expires ? new Date(pc.expires).getTime() / 1000 : undefined,
                  secure: !!pc.secure,
                  httpOnly: !!pc.httpOnly,
                  sameSite: (pc.sameSite === 'Strict' ? 'Strict' : pc.sameSite === 'None' ? 'None' : 'Lax') as any
                }));
                await page.context().addCookies(cookiesToSet);
                injectedCookieNames = parsed.map(p => p.name);
              }
            }
          }

          return jsonResponse(res, 200, { ok: true, lastSessionId: c.lastSessionId ?? null, authInjected: ensureAuth, token: returnedToken ?? null, cookieNames: injectedCookieNames.length ? injectedCookieNames : null, message: 'profile copy disabled' });
        } catch (err: any) {
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
            // ensure container open
            let navigationAlreadyDone = false;
            if (!isContainerOpen(contextId)) {
              if (command === 'navigate') {
                const url = String(body.url || '');
                if (!url) return jsonResponse(res, 400, { ok: false, error: 'missing url' });
                await openContainerWindow(c, url, { singleTab: true });
                navigationAlreadyDone = true;
              } else {
                await openContainerWindow(c, undefined, { singleTab: true });
              }
            }
            // get playwright page
            const page = getPlaywrightPage(contextId);
            if (!page) return jsonResponse(res, 404, { ok: false, error: 'no active playwright page' });

            // helper: wait for selector (Playwright style)
            const waitForSelector = async (selector: string, ms: number) => {
              try {
                if (selector.startsWith('xpath:')) {
                  await page.waitForSelector(`xpath=${selector.slice(6)}`, { timeout: ms });
                } else {
                  await page.waitForSelector(selector, { timeout: ms });
                }
                return true;
              } catch {
                return false;
              }
            };

            let navigationOccurred = false;
            let evalResult: any = undefined;
            if (command === 'save_media') {
              const selector = body.selector;
              const mediaType = body.mediaType || 'image'; // 'image' or 'pdf'
              const outputDir = path.join(process.cwd(), 'media');
              if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
              const fileName = `media-${contextId}-${Date.now()}.${mediaType === 'pdf' ? 'pdf' : 'png'}`;
              const fp = path.join(outputDir, fileName);

              try {
                if (mediaType === 'pdf') {
                  await page.pdf({ path: fp, format: 'A4' });
                } else {
                  if (selector) {
                    const pSelector = selector.startsWith('xpath:') ? `xpath=${selector.slice(6)}` : selector;
                    const element = await page.$(pSelector);
                    if (!element) return jsonResponse(res, 404, { ok: false, error: 'selector not found' });
                    await element.screenshot({ path: fp });
                  } else {
                    await page.screenshot({ path: fp, fullPage: true });
                  }
                }
                return jsonResponse(res, 200, { ok: true, path: fp, fileName });
              } catch (e: any) {
                return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
              }
            } else if (command === 'navigate') {
              const url = String(body.url || '');
              if (!url) return jsonResponse(res, 400, { ok: false, error: 'missing url' });
              if (navigationAlreadyDone) {
                navigationOccurred = true;
              } else {
                try {
                  const navTimeoutMs = Number(options.navigationTimeoutMs ?? timeoutMs);
                  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
                  if (options.waitForSelector) {
                    const ok = await waitForSelector(options.waitForSelector, timeoutMs);
                    if (!ok) return jsonResponse(res, 504, { ok: false, error: 'timeout waiting for selector' });
                  }
                  navigationOccurred = true;
                } catch (e: any) { return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) }); }
              }
            } else if (command === 'click' || command === 'clickAndType') {
              const selector = body.selector;
              if (!selector) return jsonResponse(res, 400, { ok: false, error: 'missing selector' });
              if (options.waitForSelector) {
                const ok = await waitForSelector(options.waitForSelector, timeoutMs);
                if (!ok) return jsonResponse(res, 504, { ok: false, error: 'timeout waiting for selector' });
              }
              try {
                const pSelector = selector.startsWith('xpath:') ? `xpath=${selector.slice(6)}` : selector;
                await page.click(pSelector, { timeout: timeoutMs });
                
                if (command === 'clickAndType') {
                   const text = String(body.text || '');
                   await page.fill(pSelector, text, { timeout: timeoutMs });
                }
              } catch (e: any) {
                const msg = String(e?.message || e);
                if (msg.includes('selector not found')) return jsonResponse(res, 404, { ok: false, error: 'selector not found' });
                return jsonResponse(res, 500, { ok: false, error: msg });
              }
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
                  const pSelector = selector.startsWith('xpath:') ? `xpath=${selector.slice(6)}` : selector;
                  await page.fill(pSelector, text, { timeout: timeoutMs });
                } else if (command === 'eval') {
                  const rawEval = body.eval;
                  if (rawEval === undefined || rawEval === null) return jsonResponse(res, 400, { ok: false, error: 'missing eval' });
                  let exprStr: string = rawEval as any;
                  if (typeof rawEval === 'string') {
                    try { const parsed = JSON.parse(rawEval); if (typeof parsed === 'string') exprStr = parsed; } catch { }
                  } else {
                    exprStr = String(rawEval);
                  }
                  try {
                    evalResult = await page.evaluate(exprStr);
                  } catch (e: any) {
                    const message = String(e?.message || e);
                    return jsonResponse(res, 500, { ok: false, error: message });
                  }
                }
              } catch (e: any) {
                const msg = String(e?.message || e);
                if (msg.includes('selector not found')) return jsonResponse(res, 404, { ok: false, error: 'selector not found' });
                return jsonResponse(res, 500, { ok: false, error: msg });
              }
            } else if (command === 'setFileInput') {
              const selector = body.selector;
              const fileUrl = body.fileUrl;
              const fileName = body.fileName || 'file.jpg';
              if (!selector || !fileUrl) return jsonResponse(res, 400, { ok: false, error: 'missing selector or fileUrl' });
              try {
                const resp = await fetch(fileUrl);
                const buffer = Buffer.from(await resp.arrayBuffer());
                const filePath = path.join(os.tmpdir(), fileName);
                await fsp.writeFile(filePath, buffer);
                const pSelector = selector.startsWith('xpath:') ? `xpath=${selector.slice(6)}` : selector;
                await page.setInputFiles(pSelector, filePath);
                return jsonResponse(res, 200, { ok: true });
              } catch (e: any) { return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) }); }
            } else if (command === 'getElementRect') {
              const selector = body.selector;
              if (!selector) return jsonResponse(res, 400, { ok: false, error: 'missing selector' });
              try {
                const pSelector = selector.startsWith('xpath:') ? `xpath=${selector.slice(6)}` : selector;
                const rect = await page.evaluate((sel: string) => {
                  const el = document.querySelector(sel);
                  if (!el) return null;
                  const r = el.getBoundingClientRect();
                  return { x: r.left, y: r.top, width: r.width, height: r.height };
                }, pSelector);
                if (!rect) return jsonResponse(res, 404, { ok: false, error: 'selector not found' });
                return jsonResponse(res, 200, { ok: true, rect });
              } catch (e: any) { return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) }); }
            } else if (command === 'mouseMove') {
              const x = Number(body.x), y = Number(body.y);
              if (isNaN(x) || isNaN(y)) return jsonResponse(res, 400, { ok: false, error: 'invalid x or y' });
              await page.mouse.move(x, y, { steps: Number(options.steps || 1) });
              return jsonResponse(res, 200, { ok: true });
            } else if (command === 'mouseClick') {
              const x = Number(body.x), y = Number(body.y);
              if (isNaN(x) || isNaN(y)) return jsonResponse(res, 400, { ok: false, error: 'invalid x or y' });
              await page.mouse.click(x, y, { delay: Number(options.delayMs || 100) });
              return jsonResponse(res, 200, { ok: true });
            } else if (command === 'humanClick') {
              const selector = body.selector;
              if (!selector) return jsonResponse(res, 400, { ok: false, error: 'missing selector' });
              const pSelector = selector.startsWith('xpath:') ? `xpath=${selector.slice(6)}` : selector;
              await page.click(pSelector, { timeout: timeoutMs });
              return jsonResponse(res, 200, { ok: true });
            } else if (command === 'status' || command === 'refresh' || command === 'current_url') {
              // No-op
            } else {
              return jsonResponse(res, 400, { ok: false, error: 'unsupported command' });
            }

            // post-collection
            const urlNow = page.url();
            let title = '';
            try { title = await page.title(); } catch { }
            let html: string | null = null;
            if (options.returnHtml && options.returnHtml !== 'none') {
              try {
                html = await page.content();
                if (options.returnHtml === 'trim' && html) html = html.slice(0, 64 * 1024);
              } catch { }
            }
            // cookies
            let cookies: any[] | null = null;
            if (options.returnCookies) {
              try { cookies = await page.context().cookies(); } catch { }
            }
            // screenshot
            let shotPath: string | null = null;
            if (options.screenshot) {
              try {
                const shotsDir = path.join(process.cwd(), 'shots');
                if (!existsSync(shotsDir)) mkdirSync(shotsDir, { recursive: true });
                const fp = path.join(shotsDir, `exec-${contextId}-${Date.now()}.png`);
                await page.screenshot({ path: fp });
                shotPath = fp;
              } catch { }
            }

            const elapsed = Date.now() - tstart;
            const out: any = { ok: true, command, navigationOccurred, url: urlNow, title, html, screenshotPath: shotPath, cookies, elapsedMs: elapsed };
            if (typeof evalResult !== 'undefined') out.result = evalResult;
            return jsonResponse(res, 200, out);
          } catch (e: any) {
            const msg = String(e?.message || e);
            if (msg.toLowerCase().includes('container not found')) return jsonResponse(res, 404, { ok: false, error: 'Context not found' });
            if (msg && msg.toLowerCase().includes('timeout')) return jsonResponse(res, 504, { ok: false, error: 'timeout' });
            return jsonResponse(res, 500, { ok: false, error: msg });
          } finally { locks.delete(contextId); }
        } catch (e: any) { return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) }); }
      }

      // List active containers endpoint
      if (req.method === 'GET' && u.pathname === '/internal/containers/active') {
        try {
          const activeIds = Array.from(openedById.keys());
          return jsonResponse(res, 200, { ok: true, activeIds });
        } catch (e: any) {
          return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
        }
      }

      // List containers endpoint
      if (req.method === 'GET' && (u.pathname === '/internal/containers/list' || u.pathname === '/internal/containers')) {
        try {
          const list = DB.listContainers();
          return jsonResponse(res, 200, { ok: true, containers: list });
        } catch (e: any) {
          return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
        }
      }


      if ((req.method === 'DELETE' || req.method === 'POST') && u.pathname === '/internal/export-restored/delete') {
        // accept JSON body with path or query ?path=
        let body = {} as any;
        try { body = await parseBody(req); } catch { }
        const p = body.path || u.searchParams.get('path');
        if (!p) return jsonResponse(res, 400, { ok: false, error: 'missing path' });
        try { rmSync(String(p), { recursive: true, force: true }); return jsonResponse(res, 200, { ok: true }); } catch (e: any) { return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) }); }
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
                const useResp = await (globalThis as any).fetch(
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

          // Realistic GPU rendering strings to spoof SwiftShader
          const gpus = [
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' }
          ];
          const gpu = gpus[Math.floor(Math.random() * gpus.length)];

          // Create container with fingerprint
          const fp: Fingerprint = {
            acceptLanguage: 'ja,en-US;q=0.8,en;q=0.7',
            locale: 'ja-JP',
            timezone: 'Asia/Tokyo',
            platform: 'Win32',
            hardwareConcurrency: [4, 6, 8, 12][Math.floor(Math.random() * 4)],
            deviceMemory: [4, 6, 8, 12, 16][Math.floor(Math.random() * 5)],
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
            webglVendor: gpu.vendor,
            webglRenderer: gpu.renderer,
          };
          const blockImages = !!body.blockImages;
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
            blockImages: blockImages,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastSessionId: null,
            kameleoEnv: body.environment || {} // { deviceType, os, browser }
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
        } catch (e: any) {
          return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
        }
      }

      // Kameleo Status
      if (req.method === 'GET' && u.pathname === '/internal/kameleo/status') {
        try {
          const status = await KameleoApi.getStatus();
          return jsonResponse(res, 200, { ok: true, status });
        } catch (e: any) {
          return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
        }
      }

      // List Kameleo Profiles
      if (req.method === 'GET' && u.pathname === '/internal/kameleo/profiles') {
        try {
          const profiles = await KameleoApi.listProfiles();
          return jsonResponse(res, 200, { ok: true, profiles });
        } catch (e: any) {
          return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
        }
      }

      // Attach Kameleo Profile
      if (req.method === 'POST' && u.pathname.match(/\/internal\/containers\/([^/]+)\/attach/)) {
        const match = u.pathname.match(/\/internal\/containers\/([^/]+)\/attach/);
        const id = match![1];
        try {
          const body = await parseBody(req);
          const profileId = body.profileId;
          if (!profileId) return jsonResponse(res, 400, { ok: false, error: 'missing profileId' });

          const c = DB.getContainer(id);
          if (!c) return jsonResponse(res, 404, { ok: false, error: 'container not found' });

          c.kameleoProfileId = profileId;
          c.isKameleoAttached = true;
          c.updatedAt = Date.now();

          // Fetch metadata for UI/Cache
          try {
            const profiles = await KameleoApi.listProfiles();
            const p = profiles.find(x => x.id === profileId);
            if (p) {
              c.kameleoProfileMetadata = {
                name: p.name,
                isCloud: p.isCloud,
                tags: p.tags,
                status: p.status
              };
            }
          } catch (me: any) {
             console.warn('[exportServer] failed to fetch profile metadata for attach', me);
          }

          DB.upsertContainer(c);
          return jsonResponse(res, 200, { ok: true, container: c });
        } catch (e: any) {
          return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
        }
      }

      // Detach Kameleo Profile
      if (req.method === 'POST' && u.pathname.match(/\/internal\/containers\/([^/]+)\/detach/)) {
        const match = u.pathname.match(/\/internal\/containers\/([^/]+)\/detach/);
        const id = match![1];
        try {
          const c = DB.getContainer(id);
          if (!c) return jsonResponse(res, 404, { ok: false, error: 'container not found' });

          c.kameleoProfileId = undefined;
          c.isKameleoAttached = false;
          c.kameleoProfileMetadata = undefined;
          c.updatedAt = Date.now();

          DB.upsertContainer(c);
          return jsonResponse(res, 200, { ok: true, container: c });
        } catch (e: any) {
          return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
        }
      }

      // Delete container endpoint
      if (req.method === 'POST' && u.pathname === '/internal/containers/delete') {
        try {
          const body = await parseBody(req);
          const id = String(body && body.id || '').trim();
          if (!id) return jsonResponse(res, 400, { ok: false, error: 'missing id' });

          const container = DB.getContainer(id);
          if (!container) return jsonResponse(res, 404, { ok: false, error: 'container not found' });

          if (isContainerOpen(id)) {
            try {
              // Try to gently close it first
              const { closeContainer } = await import('./containerManager');
              closeContainer(id);
            } catch (e: any) {
              console.error('[exportServer] close error during delete', e);
            }
          }

          DB.asyncDeleteContainer(id);
          const p = path.join(app.getPath('userData'), 'profiles', id);
          try { rmSync(p, { recursive: true, force: true }); } catch { }

          return jsonResponse(res, 200, { ok: true, deletedId: id });
        } catch (e: any) {
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
          const proxy: ProxyConfig | null | undefined = body.proxy ? {
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
        } catch (e: any) {
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
          const proxy: ProxyConfig | null | undefined = body.proxy ? {
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
        } catch (e: any) {
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
          try { locks.delete(id); } catch { }

          // If not open, return idempotent response
          if (!isContainerOpen(id)) return jsonResponse(res, 200, { ok: true, closed: false, message: 'not-open' });

          const runId = (crypto && (crypto as any).randomUUID) ? (crypto as any).randomUUID() : `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
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
            } catch (e: any) {
              console.error('[exportServer] waitForContainerClosed error', e);
              return jsonResponse(res, 500, { ok: false, error: 'internal' });
            }
            console.log('[exportServer] close completed', { id, runId, time: new Date().toISOString() });
            return jsonResponse(res, 200, { ok: true, closed: true, message: 'closed' });
          } catch (e: any) {
            console.error('[exportServer] close error', e);
            return jsonResponse(res, 500, { ok: false, error: 'internal' });
          }
        } catch (e: any) {
          return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
        }
      }

      jsonResponse(res, 404, { ok: false, error: 'not found' });
    } catch (e: any) {
      jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
    }
  });
  srv.listen(port, '127.0.0.1');
  console.log('[exportServer] listening on 127.0.0.1:' + port);
  return srv;
}


