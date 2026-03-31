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
import { openContainerWindow, isContainerOpen, closeContainer, waitForContainerClosed, clearContainerCache } from './containerManager';
import { getToken, getOrCreateDeviceId } from './tokenStore';
import { openedById } from './containerState';
import { getAuthApiBase, getAuthTimeoutMs, getTwoCaptchaApiKey } from './settings';
import setCookieParser from 'set-cookie-parser';
import crypto, { randomUUID } from 'node:crypto';
import type { Container, Fingerprint, ProxyConfig } from '../shared/types';
import { KameleoApi } from './kameleoApi';
import { PlaywrightService } from './playwrightService';
import logger from '../shared/logger';

type MediaSelectorRule = { selector: string; type: 'image' | 'video' };
type MediaUrlItem = { url: string; type: 'image' | 'video'; selector: string };

const MAX_MEDIA_FILES = 100;
const MAX_MEDIA_FILE_SIZE = 500 * 1024 * 1024; // 500MB

const locks = new Set<string>();

function jsonResponse(res: http.ServerResponse, status: number, body: any) {
  const s = JSON.stringify(body);
  try {
    // 霆ｽ驥上Ο繧ｰ・壹せ繝・・繧ｿ繧ｹ繝ｻbody縺ｮ隕∫せ繝ｻ譁・ｭ鈴聞繧貞・蜉幢ｼ医Ο繧ｰ螟ｱ謨励・辟｡隕厄ｼ・
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

async function getPlaywrightPage(containerId: string) {
  const entry = openedById.get(containerId);
  if (!entry) return null;
  try {
    // 毎回コンテキストから最新のアクティブページを取得する（固定参照だと別タブになる場合があるため）
    return await PlaywrightService.getPage(entry.kameleoProfileId);
  } catch {
    return entry.playwrightPage;
  }
}

async function solveCaptcha(page: any, options: any): Promise<{ ok: boolean; token?: string; type?: string; action?: string; diagnostics?: any; error?: string; errorDetail?: any }> {
  const apiKey = getTwoCaptchaApiKey();
  if (!apiKey) return { ok: false, error: '2Captcha API key is not configured' };

  const timeoutMs = Number(options.timeoutMs || 90000);
  const pollingMs = Number(options.pollingMs || 5000);
  const includePostState = options.includePostState !== false;

  // 1. Detection & Parameter Extraction
  let info: any;
  try {
    info = await page.evaluate(() => {
      const result: any = { type: null, sitekey: null, action: null, pkey: null, surl: null, blob: null, enterprise: false };

      // Try reCAPTCHA
      const recaptchaEl = document.querySelector('.g-recaptcha, [data-sitekey], [src*="google.com/recaptcha"], [src*="recaptcha.net/recaptcha"]');
      if (recaptchaEl) {
        result.type = 'recaptcha';
        result.sitekey = recaptchaEl.getAttribute('data-sitekey') ||
                         new URL((recaptchaEl as HTMLScriptElement).src || location.href).searchParams.get('k');
        if ((recaptchaEl as HTMLScriptElement).src && ((recaptchaEl as HTMLScriptElement).src.includes('enterprise.js') || (recaptchaEl as HTMLScriptElement).src.includes('/enterprise'))) {
          result.enterprise = true;
          result.type = 'recaptcha_enterprise';
        }
      }

      // Try FunCaptcha
      const funEl = document.querySelector('[data-pkey], [src*="arkoselabs.com"], #fc-token');
      if (funEl) {
        const rawSrc = funEl && typeof funEl.getAttribute === 'function'
          ? (funEl.getAttribute('src') || '')
          : '';
        let pathPkey = null;
        let originSurl = null;
        try {
          const u = new URL(rawSrc || location.href, location.href);
          const pathMatch = u.pathname.match(/\/([0-9A-F-]{20,})\//i);
          pathPkey = u.searchParams.get('pk') || (pathMatch ? pathMatch[1] : null);
          originSurl = u.origin || null;
        } catch {}
        result.type = 'funcaptcha';
        result.pkey = funEl.getAttribute('data-pkey') ||
                      (document.querySelector('#fc-token') as HTMLInputElement)?.value?.match(/pk=([^&]+)/)?.[1] ||
                      pathPkey;
        result.surl = (document.querySelector('#fc-token') as HTMLInputElement)?.value?.match(/surl=([^&]+)/)?.[1] ||
                      originSurl ||
                      'https://client-api.arkoselabs.com';
      }

      return result;
    });
  } catch (e: any) {
    return { ok: false, error: 'Failed to extract captcha info', errorDetail: e.message };
  }

  const type = options.type !== 'auto' ? options.type : info.type;
  const sitekey = options.sitekey || info.sitekey || info.pkey;
  const pageUrl = options.url || page.url();
  const action = options.action || info.action;
  const surl = options.surl || info.surl;
  const blob = options.blob || info.blob;

  console.log('[exportServer] solveCaptcha input', {
    type,
    pageUrl,
    hasSitekey: !!sitekey,
    hasAction: !!action,
    hasSurl: !!surl,
    hasBlob: !!blob,
    blobLength: blob ? String(blob).length : 0
  });

  if (!sitekey) return { ok: false, error: 'Captcha sitekey/publickey not found' };

  // 2. Request to 2Captcha
  let method = 'userrecaptcha';
  const params: any = {
    key: apiKey,
    method: method,
    pageurl: pageUrl,
    googlekey: sitekey,
    json: 1
  };

  if (type === 'funcaptcha') {
    params.method = 'funcaptcha';
    params.publickey = sitekey;
    params.surl = surl;
    if (blob) params['data[blob]'] = blob;
    delete params.googlekey;
  } else if (type === 'recaptcha_enterprise' || info.enterprise) {
    params.enterprise = 1;
  }

  if (action) params.action = action;

  try {
    const requestParamsForLog = { ...params, key: apiKey ? `***${apiKey.slice(-4)}` : '' };
    console.log('[exportServer] 2Captcha in.php request', requestParamsForLog);
    const inResp = await fetch('https://2captcha.com/in.php', {
      method: 'POST',
      body: new URLSearchParams(params)
    });
    const inResult: any = await inResp.json();
    console.log('[exportServer] 2Captcha in.php response', inResult);
    if (inResult.status !== 1) {
      return { ok: false, error: '2Captcha request failed', errorDetail: inResult };
    }

    const requestId = inResult.request;

    // 3. Polling for result
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, pollingMs));
      const resResp = await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${requestId}&json=1`);
      const resResult: any = await resResp.json();
      console.log('[exportServer] 2Captcha res.php response', resResult);

      if (resResult.status === 1) {
        const token = resResult.request;

        // 4. Injection
        let injectionScript = '';
        if (type.includes('recaptcha')) {
          injectionScript = `
            (function(token, callbackName) {
              const el = document.getElementById('g-recaptcha-response') || document.querySelector('[name="g-recaptcha-response"]');
              if (el) {
                el.value = token;
                el.innerHTML = token;
              }
              
              const findAndRunCallback = () => {
                if (callbackName && typeof window[callbackName] === 'function') {
                  window[callbackName](token);
                  return 'manual';
                }
                const dataCb = document.querySelector('[data-callback]')?.getAttribute('data-callback');
                if (dataCb && typeof window[dataCb] === 'function') {
                  window[dataCb](token);
                  return 'data-callback';
                }
                if (typeof ___grecaptcha_cfg !== 'undefined' && ___grecaptcha_cfg.clients) {
                  for (const client of Object.values(___grecaptcha_cfg.clients)) {
                    for (const v of Object.values(client)) {
                      if (v && typeof v === 'object' && typeof v.callback === 'function') {
                        v.callback(token);
                        return '___grecaptcha_cfg';
                      }
                    }
                  }
                }
                return 'none';
              };
              return findAndRunCallback();
            })(${JSON.stringify(token)}, ${JSON.stringify(options.callbackName)});
          `;
        } else if (type === 'funcaptcha') {
          injectionScript = `
            (async function(token) {
              const setNativeValue = (el, value) => {
                if (!el) return false;
                const proto = el.tagName === 'TEXTAREA'
                  ? window.HTMLTextAreaElement.prototype
                  : window.HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) setter.call(el, value);
                else el.value = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              };

              const tokenTargets = [
                document.getElementById('fc-token'),
                document.querySelector('#fc-token'),
                document.querySelector('input[name="fc-token"]'),
                document.querySelector('input[name="verification_string"]'),
                document.querySelector('input[name="captcha_response"]'),
                document.querySelector('input[name="arkoseToken"]'),
                document.querySelector('textarea[name="fc-token"]')
              ].filter(Boolean);

              let tokenTargetCount = 0;
              for (const el of tokenTargets) {
                if (setNativeValue(el, token)) tokenTargetCount += 1;
              }
              
              // Define shadow-piercing helper
              const findInShadows = (selector, root = document) => {
                const el = root.querySelector(selector);
                if (el) return el;
                const shadows = Array.from(root.querySelectorAll('*')).filter(n => !!n.shadowRoot);
                for (const s of shadows) {
                  const found = findInShadows(selector, s.shadowRoot);
                  if (found) return found;
                }
                return null;
              };

              const clickCandidate = (el) => {
                if (!el) return false;
                try {
                  el.click();
                  return true;
                } catch {}
                return false;
              };

              // Try to click Verify / Continue / submit controls after injection
              const verifyCandidates = [
                findInShadows('button#home_children_button'),
                findInShadows('button[data-theme]'),
                document.querySelector('button#home_children_button'),
                document.querySelector('input[type="submit"]'),
                Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]')).find(el => {
                  const text = ((el.innerText || el.value || el.getAttribute('aria-label') || '') + '').trim();
                  return /Verify|確認|Continue|続行|Start|始める|Unlock|ロック解除/i.test(text);
                })
              ].filter(Boolean);

              let clickedVerify = false;
              for (const candidate of verifyCandidates) {
                if (clickCandidate(candidate)) {
                  clickedVerify = true;
                  break;
                }
              }
              
              // Handle X (Twitter) specific arkoseCallback
              if (typeof window.arkoseCallback === 'function') {
                window.arkoseCallback(token);
                console.log('[exportServer] Called window.arkoseCallback');
                return JSON.stringify({ path: 'window.arkoseCallback', tokenTargetCount, clickedVerify });
              }
              
              const tryObjectCallbacks = (obj, path, depth = 0, seen = new WeakSet()) => {
                if (!obj || (typeof obj !== 'object' && typeof obj !== 'function') || seen.has(obj) || depth > 4) return null;
                seen.add(obj);
                for (const [key, value] of Object.entries(obj)) {
                  const nextPath = path ? path + '.' + key : key;
                  if (typeof value === 'function' && /(arkose|captcha|token|verify|complete|success|callback)/i.test(key)) {
                    try {
                      value(token);
                      return nextPath;
                    } catch {}
                  }
                  const nested = tryObjectCallbacks(value, nextPath, depth + 1, seen);
                  if (nested) return nested;
                }
                return null;
              };

              const callbackPath = tryObjectCallbacks(window, 'window');
              if (callbackPath) {
                return JSON.stringify({ path: callbackPath, tokenTargetCount, clickedVerify });
              }

              const activeForm = tokenTargets.map(el => el.form).find(Boolean);
              if (activeForm) {
                try { activeForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); } catch {}
              }

              return JSON.stringify({ path: 'funcaptcha-injected', tokenTargetCount, clickedVerify });
            })(${JSON.stringify(token)});
          `;
        }

        const actionTaken = await page.evaluate(injectionScript);
        console.log('[exportServer] captcha injection action', { type, actionTaken });

        // Wait for screen transition (optional but helpful for "confirm human")
        if (type === 'funcaptcha') {
          console.log('[exportServer] Waiting 5s for Arkose transition...');
          await new Promise(r => setTimeout(r, 5000));
        }

        let diagnostics: any = undefined;
        if (includePostState) {
          try {
            diagnostics = await page.evaluate(() => {
              const text = document.body ? document.body.innerText.slice(0, 400) : '';
              const inputs = Array.from(document.querySelectorAll('input, textarea')).map((el: any) => {
                const value = typeof el.value === 'string' ? el.value : '';
                return {
                  tag: el.tagName,
                  id: el.id || null,
                  name: el.getAttribute('name') || null,
                  type: el.getAttribute('type') || null,
                  hidden: !!(el.type === 'hidden' || el.getAttribute('type') === 'hidden'),
                  valueLength: value.length,
                  valuePreview: value ? value.slice(0, 80) : ''
                };
              });
              const buttons = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]')).map((el: any) => ({
                tag: el.tagName,
                id: el.id || null,
                type: el.getAttribute('type') || null,
                text: String(el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 120),
                disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true')
              }));
              const iframes = Array.from(document.querySelectorAll('iframe')).map((el: any) => ({
                id: el.id || null,
                title: el.getAttribute('title') || null,
                src: String(el.getAttribute('src') || '').slice(0, 200)
              }));
              const forms = Array.from(document.querySelectorAll('form')).map((form: any, index: number) => ({
                index,
                action: form.getAttribute('action') || null,
                method: form.getAttribute('method') || null,
                inputNames: Array.from(form.querySelectorAll('input,textarea')).map((el: any) => el.getAttribute('name') || el.id || el.tagName).slice(0, 20)
              }));
              return {
                url: location.href,
                text,
                inputs,
                buttons,
                iframes,
                forms,
                globals: {
                  hasArkoseCallback: typeof (window as any).arkoseCallback === 'function',
                  hasArkose: !!(window as any).arkose,
                  windowKeysSample: Object.keys(window).filter(k => /(arkose|captcha|verify|challenge)/i.test(k)).slice(0, 30)
                }
              };
            });
            console.log('[exportServer] captcha post-state', {
              url: diagnostics?.url,
              text: diagnostics?.text,
              inputCount: diagnostics?.inputs?.length || 0,
              buttonCount: diagnostics?.buttons?.length || 0,
              iframeCount: diagnostics?.iframes?.length || 0
            });
          } catch (diagErr: any) {
            diagnostics = { error: String(diagErr?.message || diagErr) };
            console.log('[exportServer] captcha post-state error', diagnostics);
          }
        }

        return { ok: true, token, type, action: actionTaken, diagnostics };
      }

      if (resResult.request !== 'CAPCHA_NOT_READY' && resResult.status === 0) {
        return { ok: false, error: '2Captcha solving error', errorDetail: resResult };
      }
    }

    return { ok: false, error: 'Timeout waiting for 2Captcha solution' };
  } catch (e: any) {
    return { ok: false, error: 'Internal error during captcha solve', errorDetail: e.message };
  }
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
              const page = await getPlaywrightPage(id);
              if (page) {
                const cookiesToSet = parsed.map((pc: any) => ({
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
                injectedCookieNames = parsed.map((p: any) => p.name);
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

      // 1. Native Cookie Injection (Electron session level)
      if (req.method === 'POST' && u.pathname === '/internal/cookies/set_native') {
        try {
          const body = await parseBody(req);
          const id = body.contextId;
          const cookies = body.cookies || [];
          if (!id || !Array.isArray(cookies)) return jsonResponse(res, 400, { ok: false, error: 'missing contextId or cookies array' });

          const c = DB.getContainer(id);
          if (!c) return jsonResponse(res, 404, { ok: false, error: 'container not found' });

          const part = c.partition || `persist:container-${id}`;
          const ses = (await import('electron')).session.fromPartition(part);

          console.log(`[exportServer] [native-cookies] Starting injection for contextId: ${id}, partition: ${part}`);

          for (const pc of (cookies as any[])) {
            const domain = pc.domain || '.x.com';
            // Electron cookies.set needs a URL. If not provided, derive from domain
            const url = pc.url || (domain.startsWith('.') ? `https://www${domain}` : `https://${domain}`);

            try {
              await ses.cookies.set({
                url,
                name: pc.name,
                value: pc.value,
                domain: pc.domain,
                path: pc.path || '/',
                secure: !!pc.secure,
                httpOnly: !!pc.httpOnly,
                sameSite: (pc.sameSite === 'Strict' ? 'strict' : pc.sameSite === 'None' ? 'no_restriction' : 'lax') as any,
                expirationDate: pc.expirationDate || (pc.expires ? new Date(pc.expires).getTime() / 1000 : undefined)
              });
            } catch (ce) {
              console.error(`[exportServer] [native-cookies] Failed to set cookie ${pc.name}:`, ce);
            }
          }
          console.log(`[exportServer] [native-cookies] Successfully processed ${cookies.length} cookies into partition ${part}`);
          return jsonResponse(res, 200, { ok: true, message: `Processed ${cookies.length} cookies natively` });
        } catch (err: any) {
          return jsonResponse(res, 500, { ok: false, error: String(err?.message || err) });
        }
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
            // get playwright page (毎回コンテキストから最新ページを取得)
            const page = await getPlaywrightPage(contextId);
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
            } else if (command === 'setCookie') {
              const { name, value, domain, path, secure, httpOnly, sameSite, expires } = body;
              if (!name || !value) return jsonResponse(res, 400, { ok: false, error: 'missing name or value' });
              const cookie = {
                name,
                value,
                domain: domain || '.x.com',
                path: path || '/',
                secure: !!secure,
                httpOnly: !!httpOnly,
                sameSite: (sameSite === 'Strict' ? 'Strict' : sameSite === 'None' ? 'None' : 'Lax') as any,
                expires: expires ? Number(expires) : undefined
              };
              await page.context().addCookies([cookie]);
              return jsonResponse(res, 200, { ok: true });
            } else if (command === 'getCookies' || command === 'get_cookies') {
              const urls = body.urls || ['https://x.com'];
              const cookies = await page.context().cookies(urls);
              return jsonResponse(res, 200, { ok: true, result: cookies });
            } else if (command === 'solve_captcha') {
              const solveResult = await solveCaptcha(page, options);
              if (solveResult.ok) {
                return jsonResponse(res, 200, solveResult);
              } else {
                return jsonResponse(res, 500, solveResult);
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
            } else if (command === 'cloudflareClick') {
              // Cloudflare Turnstile チェックボックス向け人間的クリック
              // - クリック目標X: iframe 左端から 1/10〜1/3 の間でランダム
              // - クリック目標Y: iframe 縦幅の中央 1/3（上1/3〜下2/3）の間でランダム
              // - ベジェ曲線 + ease-in-out 速度変化 + 微小ジッターで移動
              // - mousedown → ランダム遅延 → mouseup で自然なクリック
              const cfSteps = Math.max(20, Number(options.steps || 35));
              const cfJitter = Number(options.jitter ?? 2);

              // iframe 自動検出: 明示セレクタ優先、なければ複数パターンで最大5秒リトライ
              const cfCandidates: string[] = [
                ...(body.selector ? [body.selector] : []),
                'iframe[id^="cf-chl-widget"]',
                '#AOzYg6 iframe',
                'iframe[src*="challenges.cloudflare.com"]',
                'iframe[src*="turnstile"]',
                'iframe[title*="Cloudflare"]',
                'iframe[title*="cloudflare"]',
              ];
              let cfElement: any = null;
              let cfBox: any = null;
              for (let retry = 0; retry < 10; retry++) {
                for (const sel of cfCandidates) {
                  const psel = sel.startsWith('xpath:') ? `xpath=${sel.slice(6)}` : sel;
                  const el = await page.$(psel).catch(() => null);
                  if (el) {
                    const box = await el.boundingBox().catch(() => null);
                    if (box && box.width > 0 && box.height > 0) {
                      cfElement = el; cfBox = box; break;
                    }
                  }
                }
                if (cfElement) break;
                await new Promise(r => setTimeout(r, 500));
              }
              // iframeが見つからない場合は #AOzYg6 div（Turnstileコンテナ）を直接使う
              if (!cfElement || !cfBox) {
                for (let retry = 0; retry < 10; retry++) {
                  const el = await page.$('#AOzYg6').catch(() => null);
                  if (el) {
                    const box = await el.boundingBox().catch(() => null);
                    if (box && box.width > 0 && box.height > 0) {
                      cfElement = el; cfBox = box; break;
                    }
                  }
                  await new Promise(r => setTimeout(r, 500));
                }
              }
              if (!cfElement || !cfBox) return jsonResponse(res, 404, { ok: false, error: 'cloudflareClick: element not found' });

              // クリック目標座標
              // iframeの場合: X は左端から 1/10〜1/3（チェックボックスエリア）
              // #AOzYg6 divの場合: X は左端から 2〜6%（チェックボックスは左端付近）
              const isWide = cfBox.width > 200; // divは幅広、iframeは小さい
              const cfTargetX = isWide
                ? cfBox.x + cfBox.width  * (0.02 + Math.random() * 0.04)  // 2〜6%: チェックボックス位置
                : cfBox.x + cfBox.width  * (0.1  + Math.random() * (1/3 - 0.1));
              const cfTargetY = cfBox.y + cfBox.height * (1/3 + Math.random() * (1/3));

              // 開始座標: ビューポートサイズを取得して画面内のランダムな点から開始
              const cfViewport = page.viewportSize() || { width: 1280, height: 800 };
              const cfStartX = cfViewport.width  * (0.1 + Math.random() * 0.5);
              const cfStartY = cfViewport.height * (0.5 + Math.random() * 0.4);

              // ベジェ曲線パスを生成（既存関数を使用）
              const cfPath = generateBezierPath(
                { x: cfStartX, y: cfStartY },
                { x: cfTargetX, y: cfTargetY },
                cfSteps
              );

              // 開始位置へワープ（最初の1点だけ即時移動）
              await page.mouse.move(cfPath[0].x, cfPath[0].y);

              // ease-in-out でパスを辿る（各ステップ間の待機時間を変化させる）
              for (let i = 1; i < cfPath.length; i++) {
                const t = i / (cfPath.length - 1);
                // ease-in-out: 0→1 の中間が最速、両端が遅い
                const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
                const stepDelay = Math.round(3 + (1 - ease) * 14); // 3ms〜17ms

                // 微小ジッター（人間の手ブレ）
                const jx = cfPath[i].x + (Math.random() * 2 - 1) * cfJitter;
                const jy = cfPath[i].y + (Math.random() * 2 - 1) * cfJitter;
                await page.mouse.move(jx, jy);
                await new Promise(r => setTimeout(r, stepDelay));
              }

              // 目標座標へ正確に移動（最終点のジッターを補正）
              await page.mouse.move(cfTargetX, cfTargetY);
              await new Promise(r => setTimeout(r, 40 + Math.random() * 60)); // クリック前の微停止

              // mousedown → ランダム押下時間 → mouseup
              await page.mouse.down();
              await new Promise(r => setTimeout(r, 80 + Math.random() * 80)); // 80〜160ms
              await page.mouse.up();

              // クリック後の待機（DOM 更新・遷移確認）
              await new Promise(r => setTimeout(r, 400 + Math.random() * 400)); // 400〜800ms

              return jsonResponse(res, 200, { ok: true, clickX: Math.round(cfTargetX), clickY: Math.round(cfTargetY) });
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
            console.error(`[exportServer] [/internal/exec] [ERROR] command=${command} id=${contextId}`, e);
            return jsonResponse(res, 500, { ok: false, error: msg });
          } finally { locks.delete(contextId); }
        } catch (e: any) {
          console.error(`[exportServer] [/internal/exec] [FATAL]`, e);
          return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
        }
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

          // Validation: Check if profile exists in Kameleo
          try {
            const profiles = await KameleoApi.listProfiles();
            const p = profiles.find(x => x.id === profileId);
            if (!p) {
              return jsonResponse(res, 404, { ok: false, error: `Kameleo profile ${profileId} not found.` });
            }

            c.kameleoProfileId = profileId;
            c.profileMode = 'attached';
            c.updatedAt = Date.now();
            c.kameleoProfileMetadata = {
              name: p.name,
              isCloud: p.isCloud,
              tags: p.tags,
              status: p.status
            };

            DB.upsertContainer(c);
            return jsonResponse(res, 200, { ok: true, container: c, profileStatus: p.status });
          } catch (me: any) {
            return jsonResponse(res, 500, { ok: false, error: `Failed to validate Kameleo profile: ${me.message}` });
          }
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
          c.profileMode = 'managed'; // Reset to managed
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

      // Set proxy for container endpoint (繝励Ο繧ｭ繧ｷ螟画峩蟆ら畑API)
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

      // Clear container cache (HTTP cache + ServiceWorker cache / CacheStorage)
      if (req.method === 'POST' && u.pathname === '/internal/containers/cache/clear') {
        try {
          const body = await parseBody(req);
          const id = String(body && body.id || '');
          if (!id) return jsonResponse(res, 400, { ok: false, error: 'missing id' });
          const c = DB.getContainer(id);
          if (!c) return jsonResponse(res, 404, { ok: false, error: 'container not found' });
          const ok = clearContainerCache(id);
          if (!ok) return jsonResponse(res, 500, { ok: false, error: 'cache clear failed' });
          return jsonResponse(res, 200, { ok: true, message: 'cache cleared' });
        } catch (e: any) {
          return jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
        }
      }

      // Activate (focus/restore/bring-to-front) container window
      if (req.method === 'POST' && u.pathname === '/internal/containers/activate') {
        try {
          const body = await parseBody(req);
          const id = String(body && body.id || '');
          if (!id) return jsonResponse(res, 400, { ok: false, error: 'missing id' });
          const entry = openedById.get(id);
          if (!entry) return jsonResponse(res, 200, { ok: false, activated: false, error: 'not-open' });
          // Kameleoモードではコンテナシェルは非表示のまま維持する
          // show()/restore() は呼ばない（コンテナシェルウィンドウが出てしまうため）
          return jsonResponse(res, 200, { ok: true, activated: true, message: 'focused' });
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
            const ok = await closeContainer(id);
            if (!ok) {
              console.error('[exportServer] closeContainer returned false for', id);
              return jsonResponse(res, 500, { ok: false, error: 'failed-to-close' });
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


