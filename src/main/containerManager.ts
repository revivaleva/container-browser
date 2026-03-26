import { app, BrowserWindow, session, net, ipcMain } from 'electron';
import type { BrowserWindow as BrowserWindowType, Session as SessionType, WebContents as WebContentsType } from 'electron';

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Container } from '../shared/types';
import { DB } from './db';
import fs, { existsSync } from 'node:fs';
import { OpenedContainer, openedById, proxyCredentialsByPartition, proxyCredentialsByHostPort } from './containerState';
import { KameleoApi } from './kameleoApi';
import { PlaywrightService } from './playwrightService';

// プロキシ関連ログのみを表示するモード（LOG_ONLY_PROXY=1）
const LOG_ONLY_PROXY = process.env.LOG_ONLY_PROXY === '1';

// ログがプロキシ関連かどうかを判定（containerManager用）
function isProxyRelatedLog(...args: any[]): boolean {
  if (!LOG_ONLY_PROXY) return true; // フィルタリングしない

  const firstArg = args[0];
  if (typeof firstArg === 'string') {
    const proxyPrefixes = [
      '[proxy-check]',
      '[x-net]',
      '[login]',
      'proxy',
      'Proxy',
      'PROXY',
      'setProxy',
      'set-proxy',
      'proxy-test',
      'proxy.test',
      'onboarding/task.json',
      'clearContainerStorageForX',
      'BANNED proxy'
    ];
    // [main]プレフィックスは除外（プロキシ関連でない限り）
    if (firstArg.includes('[main]')) {
      const allArgsForFirst = args.map(a => String(a)).join(' ');
      if (!/proxy|Proxy|PROXY|setProxy/i.test(allArgsForFirst)) {
        return false;
      }
    }
    return proxyPrefixes.some(prefix => firstArg.includes(prefix));
  }

  const allArgs = args.map(a => String(a)).join(' ');
  // [main]プレフィックスは除外（プロキシ関連でない限り）
  if (/\[main\]/i.test(allArgs) && !/proxy|Proxy|PROXY|setProxy/i.test(allArgs)) {
    return false;
  }
  return /\[proxy-check\]|\[x-net\]|\[login\]|proxy|Proxy|PROXY|setProxy|onboarding\/task\.json/i.test(allArgs);
}

// ログ出力のラッパー（プロキシ関連以外を抑制）
const proxyLog = {
  log: (...args: any[]) => {
    if (!LOG_ONLY_PROXY || isProxyRelatedLog(...args)) {
      console.log(...args);
    }
  },
  warn: (...args: any[]) => {
    if (!LOG_ONLY_PROXY || isProxyRelatedLog(...args)) {
      console.warn(...args);
    }
  },
  error: (...args: any[]) => {
    if (!LOG_ONLY_PROXY || isProxyRelatedLog(...args)) {
      console.error(...args);
    }
  }
};

// LOG_ONLY_PROXY=1時、console.log/warn/errorを上書きしてフィルタリング（直接consoleを使っている箇所も対象）
if (LOG_ONLY_PROXY) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = (...args: any[]) => {
    if (isProxyRelatedLog(...args)) {
      originalLog(...args);
    }
  };

  console.warn = (...args: any[]) => {
    if (isProxyRelatedLog(...args)) {
      originalWarn(...args);
    }
  };

  console.error = (...args: any[]) => {
    if (isProxyRelatedLog(...args)) {
      originalError(...args);
    }
  };
}

type OpenOpts = { restore?: boolean; singleTab?: boolean };

// State moved to containerState.ts
let isRestoringGlobal = false;
let mainWindowRef: BrowserWindowType | null = null;

// warmup状態管理（containerId -> {ok: boolean}）
// warmup失敗時はX系URLへの自動アクセスを完全ブロックするために使用
const warmupState = new Map<string, { ok: boolean }>();

// プロキシBAN機構（メモリ上で短期間）
// key: proxyServer (host:port), value: { bannedUntil: timestamp, reason: string }
const proxyBanMap = new Map<string, { bannedUntil: number; reason: string }>();
const PROXY_BAN_DURATION_MS = 30 * 60 * 1000; // 30分

// X関連URLの判定関数（診断ログ用）
function isXRelatedUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const hostname = u.hostname.toLowerCase();
    const pathname = u.pathname.toLowerCase();
    return hostname.includes('api.x.com') ||
      hostname.includes('x.com') && (
        pathname.includes('/i/api') ||
        pathname.includes('/i/flow') ||
        pathname.includes('/onboarding/task') ||
        pathname.includes('/guest/activate')
      );
  } catch {
    return false;
  }
}

// X系ドメインの判定関数（warmup用）
function isXUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const hostname = u.hostname.toLowerCase();
    return hostname.includes('x.com') ||
      hostname.includes('api.x.com') ||
      hostname.includes('twitter.com') ||
      hostname.includes('t.co') ||
      hostname.includes('twimg.com') ||
      hostname.includes('abs.twimg.com');
  } catch {
    return false;
  }
}

// SNS静的warmup用URLマッピング（拡張可能）
type WarmupMapping = {
  match: (url: string) => boolean;
  staticUrl: string;
  name: string;
};

const WARMUP_MAPPINGS: WarmupMapping[] = [
  {
    match: (url: string) => isXUrl(url),
    staticUrl: 'https://abs.twimg.com/favicons/twitter.3.ico',
    name: 'X (Twitter)'
  }
  // 将来的に他SNSを追加する場合はここに追加
  // {
  //   match: (url: string) => url.includes('example.com'),
  //   staticUrl: 'https://example.com/static/favicon.ico',
  //   name: 'Example SNS'
  // }
];

// startUrlに対応する静的warmup URLリストを取得（複数URL、優先順位付き）
function getWarmupStaticUrls(startUrl: string): string[] {
  if (!startUrl) return [];
  for (const mapping of WARMUP_MAPPINGS) {
    if (mapping.match(startUrl)) {
      // X系の場合: robots.txt/favicon.ico優先、abs.twimg.comは余裕があれば
      if (mapping.name === 'X (Twitter)') {
        return [
          'https://x.com/robots.txt',
          'https://x.com/favicon.ico',
          'https://abs.twimg.com/favicons/twitter.3.ico'
        ];
      }
      // 将来的に他SNSを追加する場合はここに追加
      return [mapping.staticUrl];
    }
  }
  return [];
}

// プロキシサーバーからhost:portを抽出するヘルパー
function extractProxyHostPort(proxyServer: string): string {
  if (!proxyServer) return '';
  // "http=host:port;https=host:port" -> "host:port"
  // "socks5=host:port" -> "host:port"
  // "host:port" -> "host:port"
  let hostPort = proxyServer;
  if (proxyServer.includes('=')) {
    const match = proxyServer.match(/(?:https?|socks5)=([^;]+)/i);
    if (match) hostPort = match[1].trim();
  } else if (proxyServer.includes('://')) {
    hostPort = proxyServer.replace(/^[^:]+:\/\//, '');
  }
  // 認証情報を除去
  hostPort = hostPort.replace(/^[^@]+@/, '');
  return hostPort.trim();
}

// プロキシBANチェック
function isProxyBanned(proxyServer: string): boolean {
  const hostPort = extractProxyHostPort(proxyServer);
  if (!hostPort) return false;
  const banInfo = proxyBanMap.get(hostPort);
  if (!banInfo) return false;
  if (Date.now() < banInfo.bannedUntil) {
    return true;
  }
  // 期限切れなら削除
  proxyBanMap.delete(hostPort);
  return false;
}

// プロキシをBAN
function banProxy(proxyServer: string, reason: string): void {
  const hostPort = extractProxyHostPort(proxyServer);
  if (!hostPort) return;
  proxyBanMap.set(hostPort, {
    bannedUntil: Date.now() + PROXY_BAN_DURATION_MS,
    reason
  });
  proxyLog.warn(`[proxy-check] BANNED proxy ${hostPort}: ${reason} (30分間)`);
}

// ナビゲーション完了を待機するヘルパー関数（startUrlロード時に使用）
function waitForNavigationComplete(wc: Electron.WebContents, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeoutId: NodeJS.Timeout | null = null;
    const startTime = Date.now();
    const onNavigate = () => {
      const currentUrl = wc.getURL();
      const elapsed = Date.now() - startTime;
      console.log('[main] waitForNavigationComplete: did-navigate', { elapsedMs: elapsed, url: currentUrl });

      // about:blankへの遷移は無視（loadURLの最初の遷移として発生する）
      if (currentUrl === 'about:blank') {
        console.log('[main] waitForNavigationComplete: ignoring about:blank, waiting for actual URL');
        return; // 次の遷移を待つ
      }

      cleanup();
      resolve();
    };
    const onFail = (_event: unknown, errorCode: number, errorDescription: string, _validatedURL: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      // about:blankへの失敗も無視（実際のURLへの遷移失敗のみエラーとする）
      if (_validatedURL === 'about:blank') {
        console.log('[main] waitForNavigationComplete: ignoring about:blank failure, waiting for actual URL');
        return;
      }
      cleanup();
      console.error('[main] waitForNavigationComplete: did-fail-load', { errorCode, errorDescription, validatedURL: _validatedURL });
      reject(new Error(errorDescription || `navigation failed (${errorCode})`));
    };
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      wc.removeListener('did-navigate', onNavigate);
      wc.removeListener('did-fail-load', onFail);
    };
    // did-navigateで通信成功を判定（早期レスポンス）
    console.log('[main] waitForNavigationComplete: waiting for navigation', { timeoutMs, currentUrl: wc.getURL() });
    wc.on('did-navigate', onNavigate);
    wc.on('did-fail-load', onFail);
    const effectiveTimeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 0;
    if (effectiveTimeout > 0) {
      timeoutId = setTimeout(() => {
        cleanup();
        console.error('[main] waitForNavigationComplete: timeout', { timeoutMs, currentUrl: wc.getURL() });
        reject(new Error('navigation timeout'));
      }, effectiveTimeout);
    }
  });
}

// Hidden BrowserWindowを使ってwarmupする（webContents経路でloginイベントが確実に発火する）
// BrowserViewではなくBrowserWindow(show:false)を使用することで、より安定したwarmupを実現
// warmup用のhidden BrowserWindowでURLをロードし、イベント駆動で成功/失敗を判定する
async function warmupLoad(win: BrowserWindowType, url: string, timeoutMs: number): Promise<{ ok: boolean; ttfb?: number; error?: string; errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean }> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let resolved = false;
    let lastRejectError: string | undefined; // loadURLのrejectエラーを保存

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        const ttfb = Date.now() - startTime;
        cleanup();
        proxyLog.error(`[proxy-warmup] warmupLoad timeout for ${url}`, {
          url,
          timeoutMs,
          ttfb,
          lastRejectError
        });
        resolve({
          ok: false,
          error: lastRejectError ? `timeout (loadURL rejected: ${lastRejectError})` : 'timeout',
          ttfb: timeoutMs
        });
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      win.webContents.removeAllListeners('did-finish-load');
      win.webContents.removeAllListeners('did-fail-load');
      win.webContents.removeAllListeners('did-fail-provisional-load');
      win.webContents.removeAllListeners('certificate-error');
      win.webContents.removeAllListeners('render-process-gone');
    };

    const onSuccess = () => {
      if (!resolved) {
        resolved = true;
        const ttfb = Date.now() - startTime;
        cleanup();
        proxyLog.log(`[proxy-warmup] warmupLoad SUCCESS for ${url}`, {
          url,
          ttfb,
          timeoutMs
        });
        resolve({ ok: true, ttfb });
      }
    };

    const onFailure = (errorCode: number | undefined, errorDescription: string | undefined, error: string, validatedURL?: string, isMainFrame?: boolean) => {
      if (!resolved) {
        resolved = true;
        const ttfb = Date.now() - startTime;
        cleanup();
        proxyLog.error(`[proxy-warmup] warmupLoad FAILED for ${url}`, {
          url,
          error,
          errorCode,
          errorDescription,
          validatedURL,
          isMainFrame,
          ttfb,
          timeoutMs,
          lastRejectError
        });
        resolve({ ok: false, error, errorCode, errorDescription, validatedURL, isMainFrame, ttfb });
      }
    };

    // did-finish-load: 成功（validatedURL一致で判定）
    win.webContents.once('did-finish-load', (event, finishedUrl) => {
      // URLの一致判定を緩和（リダイレクト対応）
      if (finishedUrl === url || finishedUrl.startsWith(url.split('?')[0]) || url.startsWith(finishedUrl.split('?')[0])) {
        onSuccess();
      }
    });

    // did-fail-provisional-load: 失敗（プロビジョナル読み込み失敗）- 最優先で捕捉
    win.webContents.once('did-fail-provisional-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (validatedURL === url || validatedURL?.startsWith(url.split('?')[0]) || url.startsWith(validatedURL?.split('?')[0] || '')) {
        onFailure(errorCode, errorDescription, `did-fail-provisional-load: ${errorDescription} (code: ${errorCode})`, validatedURL, isMainFrame);
      }
    });

    // did-fail-load: 失敗（メインリソースの読み込み失敗）
    win.webContents.once('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (validatedURL === url || validatedURL?.startsWith(url.split('?')[0]) || url.startsWith(validatedURL?.split('?')[0] || '')) {
        onFailure(errorCode, errorDescription, `did-fail-load: ${errorDescription} (code: ${errorCode})`, validatedURL, isMainFrame);
      }
    });

    // certificate-error: 証明書エラー
    win.webContents.once('certificate-error', (event, url2, error, certificate, callback) => {
      if (url2 === url || url2?.startsWith(url.split('?')[0]) || url.startsWith(url2?.split('?')[0] || '')) {
        // 証明書エラーは拒否（warmup失敗として扱う）
        event.preventDefault();
        callback(false);
        onFailure(-107, `certificate-error: ${error}`, `certificate-error: ${error}`, url2);
      }
    });

    // render-process-gone: プロセスクラッシュ
    win.webContents.once('render-process-gone', (event, details) => {
      onFailure(undefined, details.reason, `render-process-gone: ${details.reason}`);
    });

    // URLをロード（awaitしない、イベントで判定）
    try {
      win.webContents.loadURL(url).catch((e) => {
        // loadURLのrejectは保存するだけ（イベントで判定するため）
        lastRejectError = e instanceof Error ? e.message : String(e);
        proxyLog.warn(`[proxy-warmup] loadURL rejected for ${url} (will wait for events)`, {
          url,
          error: lastRejectError
        });
        // イベントを待つ（did-fail-provisional-load等が発火するまで待機）
      });
    } catch (e) {
      // loadURLのexceptionも保存するだけ
      lastRejectError = e instanceof Error ? e.message : String(e);
      proxyLog.warn(`[proxy-warmup] loadURL exception for ${url} (will wait for events)`, {
        url,
        error: lastRejectError
      });
    }
  });
}

// Hidden BrowserWindowを使ったwarmup実行（BrowserViewではなくBrowserWindowを使用）
// webContents経路でloginイベントが確実に発火するため、net.requestの「偽陰性」を回避できる
// BrowserWindow(show:false)を使用することで、より安定したwarmupを実現
async function runWarmupViaHiddenView(options: {
  ses: Electron.Session;
  partition: string;
  startUrl?: string;
  proxyServer: string;
  containerId: string;
}): Promise<{ ok: boolean; error?: string; details?: any }> {
  const { ses, partition, startUrl, proxyServer, containerId } = options;
  const hostPort = extractProxyHostPort(proxyServer);
  let warmupWin: BrowserWindowType | null = null;

  try {
    // warmup用のhidden BrowserWindowを作成（show: false で表示しない）
    const viewPreloadPath = path.join(app.getAppPath(), 'out', 'preload', 'containerPreload.cjs');
    warmupWin = new BrowserWindow({
      show: false, // 表示しない
      webPreferences: {
        partition: partition,
        contextIsolation: true,
        nodeIntegration: false,
        preload: viewPreloadPath,
        backgroundThrottling: false
      }
    });

    // WebRTC非プロキシUDP禁止を適用（本番と同じ設定）
    try {
      warmupWin.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    } catch (e) {
      // エラーは無視
    }

    // Set containerId for app.on('login') handler
    try {
      (warmupWin.webContents as any)._containerId = containerId;
    } catch (e) {
      // エラーは無視
    }

    proxyLog.log(`[proxy-warmup] Starting nonSNS warmup for container ${containerId}`, {
      containerId,
      proxy: hostPort,
      partition
    });

    // (1) nonSNS warmup: net.requestベースで主判定（HTTP/HTTPS）
    // テスト先URLを見直し（google/favicon維持、cman.jp追加、cloudflare/msftconnecttestは任意）
    const nonSnsUrls = [
      { url: 'https://www.google.com/favicon.ico', scheme: 'HTTPS (TLS)', name: 'google-favicon', required: true },
      { url: 'https://www.cman.jp/network/support/go_access.cgi', scheme: 'HTTPS (TLS)', name: 'cman', required: true },
      { url: 'https://example.com/', scheme: 'HTTPS (fallback)', name: 'example', required: true },
      { url: 'https://www.cloudflare.com/favicon.ico', scheme: 'HTTPS (TLS)', name: 'cloudflare-favicon', required: false },
      { url: 'https://www.msftconnecttest.com/connecttest.txt', scheme: 'HTTPS (TLS)', name: 'msftconnecttest', required: false }
    ];
    const NET_REQUEST_TIMEOUT_MS = 12000; // 12秒（回線が細い前提で少し長めに）
    const FALLBACK_LOADURL_TIMEOUT_MS = 15000; // フォールバック用: 15秒

    proxyLog.log(`[proxy-warmup] Starting nonSNS warmup via net.request for container ${containerId}`, {
      containerId,
      proxy: hostPort,
      testUrls: nonSnsUrls.map(u => ({ url: u.url, scheme: u.scheme, required: u.required })),
      timeoutMs: NET_REQUEST_TIMEOUT_MS
    });

    let nonSnsSuccess = false;
    let nonSnsLastError: string | undefined;
    let nonSnsLastErrorType: string | undefined;

    // 必須URLから試す
    const requiredUrls = nonSnsUrls.filter(u => u.required);
    const optionalUrls = nonSnsUrls.filter(u => !u.required);
    const orderedUrls = [...requiredUrls, ...optionalUrls];

    for (const testUrl of orderedUrls) {
      const startTime = Date.now();

      // resolveProxyを実行してプロキシ設定を確認
      try {
        const resolvedProxy = await ses.resolveProxy(testUrl.url);
        proxyLog.log(`[proxy-warmup] resolveProxy result for ${testUrl.url}`, {
          containerId,
          proxy: hostPort,
          url: testUrl.url,
          resolvedProxy
        });
        // DIRECT混入があれば警告
        if (resolvedProxy && resolvedProxy.includes('DIRECT') && !resolvedProxy.includes('PROXY')) {
          proxyLog.warn(`[proxy-warmup] WARNING: resolveProxy returned DIRECT (proxy may not be set)`, {
            containerId,
            proxy: hostPort,
            url: testUrl.url,
            resolvedProxy
          });
        }
      } catch (e) {
        proxyLog.warn(`[proxy-warmup] resolveProxy failed (continuing anyway)`, {
          containerId,
          proxy: hostPort,
          url: testUrl.url,
          error: e instanceof Error ? e.message : String(e)
        });
      }

      proxyLog.log(`[proxy-warmup] Testing ${testUrl.scheme} via net.request: ${testUrl.url}`, {
        containerId,
        proxy: hostPort,
        url: testUrl.url,
        scheme: testUrl.scheme
      });

      try {
        const response = await new Promise<{ statusCode: number; elapsedMs: number }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            try { request.abort(); } catch { }
            reject(new Error('timeout'));
          }, NET_REQUEST_TIMEOUT_MS);

          const request = net.request({
            method: 'GET',
            url: testUrl.url,
            session: ses
          });

          request.on('response', (response) => {
            const elapsedMs = Date.now() - startTime;
            // レスポンスボディは読み飛ばす
            response.on('data', () => { });
            response.on('end', () => {
              clearTimeout(timeout);
              resolve({
                statusCode: response.statusCode,
                elapsedMs
              });
            });
            response.on('error', (error) => {
              clearTimeout(timeout);
              reject(error);
            });
          });

          request.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });

          request.end();
        });

        const elapsedMs = Date.now() - startTime;
        const errorType = response.statusCode >= 400 ? 'http_error' : undefined;

        // 判定条件: statusCodeが200〜399
        if (response.statusCode >= 200 && response.statusCode < 400) {
          nonSnsSuccess = true;
          proxyLog.log(`[proxy-warmup] net.request result`, {
            url: testUrl.url,
            statusCode: response.statusCode,
            errorType: errorType || 'none',
            elapsedMs,
            containerId,
            proxy: hostPort,
            scheme: testUrl.scheme
          });
          break; // 1つでも成功すればOK
        } else {
          // 407の場合は認証情報が登録されているかも記録
          const logData: any = {
            url: testUrl.url,
            statusCode: response.statusCode,
            errorType: errorType || 'none',
            elapsedMs,
            containerId,
            proxy: hostPort,
            scheme: testUrl.scheme
          };
          if (response.statusCode === 407) {
            // 認証情報が登録されているかを確認（loginイベントが発火する前提条件）
            const hasCredentials = proxyCredentialsByHostPort.has(hostPort);
            logData.hasCredentials = hasCredentials;
          }
          proxyLog.warn(`[proxy-warmup] net.request result`, logData);

          nonSnsLastError = `Unexpected status ${response.statusCode}`;
          nonSnsLastErrorType = errorType || 'http_error';
        }
      } catch (e: any) {
        const elapsedMs = Date.now() - startTime;
        const errorMsg = e instanceof Error ? e.message : String(e);
        const errorType = errorMsg.includes('ERR_TUNNEL') ? 'ERR_TUNNEL_CONNECTION_FAILED' :
          errorMsg.includes('timeout') ? 'timeout' :
            errorMsg.includes('407') ? 'proxy_authentication_required' : 'unknown';

        const logData: any = {
          url: testUrl.url,
          statusCode: undefined,
          errorType,
          elapsedMs,
          containerId,
          proxy: hostPort,
          scheme: testUrl.scheme,
          error: errorMsg
        };
        // 407エラーの場合は認証情報が登録されているかも記録
        if (errorType === 'proxy_authentication_required' || errorMsg.includes('407')) {
          const hasCredentials = proxyCredentialsByHostPort.has(hostPort);
          logData.hasCredentials = hasCredentials;
        }
        proxyLog.warn(`[proxy-warmup] net.request result`, logData);

        nonSnsLastError = errorMsg;
        nonSnsLastErrorType = errorType;

        // ERR_TUNNEL_CONNECTION_FAILEDの場合のみフォールバック（loadURL warmup）
        if (errorType === 'ERR_TUNNEL_CONNECTION_FAILED') {
          proxyLog.log(`[proxy-warmup] ERR_TUNNEL_CONNECTION_FAILED -> trying fallback loadURL warmup for ${testUrl.url}`, {
            containerId,
            proxy: hostPort,
            url: testUrl.url,
            scheme: testUrl.scheme
          });

          try {
            const fallbackWin = new BrowserWindow({
              show: false,
              webPreferences: {
                partition: partition,
                contextIsolation: true,
                nodeIntegration: false,
                preload: viewPreloadPath,
                backgroundThrottling: false
              }
            });

            try {
              fallbackWin.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
              (fallbackWin.webContents as any)._containerId = containerId;
            } catch (e) { }

            const fallbackResult = await warmupLoad(fallbackWin, testUrl.url, FALLBACK_LOADURL_TIMEOUT_MS);

            try {
              fallbackWin.destroy();
            } catch (e) { }

            if (fallbackResult.ok) {
              nonSnsSuccess = true;
              proxyLog.log(`[proxy-warmup] Fallback loadURL warmup SUCCESS for ${testUrl.url}`, {
                containerId,
                proxy: hostPort,
                url: testUrl.url,
                scheme: testUrl.scheme,
                ttfb: fallbackResult.ttfb
              });
              break; // フォールバック成功で終了
            } else {
              proxyLog.warn(`[proxy-warmup] Fallback loadURL warmup FAILED for ${testUrl.url}`, {
                containerId,
                proxy: hostPort,
                url: testUrl.url,
                scheme: testUrl.scheme,
                error: fallbackResult.error,
                errorCode: fallbackResult.errorCode
              });
            }
          } catch (fallbackE) {
            proxyLog.warn(`[proxy-warmup] Fallback loadURL warmup exception (continuing)`, {
              containerId,
              proxy: hostPort,
              url: testUrl.url,
              scheme: testUrl.scheme,
              error: fallbackE instanceof Error ? fallbackE.message : String(fallbackE)
            });
          }
        }
      }
    }

    // net.requestが成功した場合のみ、補助としてloadURL warmupを試す（DEBUG_WARMUP_AUX=1 のときだけ）
    const DEBUG_WARMUP_AUX = process.env.DEBUG_WARMUP_AUX === '1';
    if (nonSnsSuccess && DEBUG_WARMUP_AUX) {
      proxyLog.log(`[proxy-warmup] net.request SUCCESS -> optionally testing loadURL warmup for comparison (DEBUG_WARMUP_AUX=1)`, {
        containerId,
        proxy: hostPort
      });

      // 補助warmup: loadURL（任意、失敗してもwarmup全体の合否には影響しない）
      try {
        const authWindow = new BrowserWindow({
          show: false,
          webPreferences: {
            partition: partition,
            contextIsolation: true,
            nodeIntegration: false,
            preload: viewPreloadPath,
            backgroundThrottling: false
          }
        });

        try {
          authWindow.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
          (authWindow.webContents as any)._containerId = containerId;
        } catch (e) { }

        const loadUrlResult = await warmupLoad(authWindow, nonSnsUrls[0].url, 8000);
        proxyLog.log(`[proxy-warmup] loadURL warmup (auxiliary) result`, {
          containerId,
          proxy: hostPort,
          url: nonSnsUrls[0].url,
          ok: loadUrlResult.ok,
          ttfb: loadUrlResult.ttfb,
          error: loadUrlResult.error
        });

        try {
          authWindow.destroy();
        } catch (e) { }
      } catch (e) {
        // 補助warmupの失敗は無視
        proxyLog.warn(`[proxy-warmup] loadURL warmup (auxiliary) failed (ignored)`, {
          containerId,
          proxy: hostPort,
          error: e instanceof Error ? e.message : String(e)
        });
      }
    }

    if (!nonSnsSuccess) {
      proxyLog.error(`[proxy-warmup] nonSNS warmup FAILED via net.request: All required test URLs failed`, {
        containerId,
        proxy: hostPort,
        lastError: nonSnsLastError,
        lastErrorType: nonSnsLastErrorType,
        testedUrls: orderedUrls.map(u => ({ url: u.url, required: u.required }))
      });
      return {
        ok: false,
        error: `nonSNS warmup failed: ${nonSnsLastError || 'All required test URLs failed'}`,
        details: {
          errorType: nonSnsLastErrorType,
          lastError: nonSnsLastError
        }
      };
    }

    // nonSNS warmup成功後にネットワークメタ情報を取得（ベストエフォート）
    let networkMetadata: NetworkMetadata | null = null;
    try {
      networkMetadata = await getNetworkMetadata(ses, containerId, proxyServer);
    } catch (e) {
      // ネットワークメタ取得失敗はwarmup判定に影響しない（warnログに留める）
      proxyLog.warn(`[proxy-net] Failed to get network metadata (continuing anyway)`, {
        containerId,
        proxy: hostPort,
        error: e instanceof Error ? e.message : String(e)
      });
    }

    // (2) SNS static warmupは削除（プロキシ確認はnonSNS warmupのみで十分）

    proxyLog.log(`[proxy-warmup] Warmup OK via hidden view -> ready to load startUrl`, {
      containerId,
      proxy: hostPort,
      startUrl
    });

    return { ok: true };

  } catch (e: any) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    proxyLog.error(`[proxy-warmup] runWarmupViaHiddenView ERROR`, {
      containerId,
      proxy: hostPort,
      error: errorMsg
    });
    return { ok: false, error: errorMsg };
  } finally {
    // warmupWinを必ずcleanup
    if (warmupWin) {
      try {
        warmupWin.destroy();
      } catch (e) {
        // エラーは無視
      }
      warmupWin = null;
      proxyLog.log(`[proxy-warmup] Cleaned up hidden warmup window for container ${containerId}`, {
        containerId
      });
    }
  }
}

// 非SNS warmup: プロキシトンネル確立・認証が通ることを確認（SNSフローを踏まない）
// HTTP(非TLS)とHTTPSの両方を試して「CONNECT不可」か「全部死ぬ」かを判定する
// 【非推奨】net.requestベースのwarmup（偽陰性が発生する可能性があるため）
// 推奨: runWarmupViaHiddenView を使用すること
async function nonSnsWarmup(ses: Electron.Session, containerId: string, proxyServer: string): Promise<{ ok: boolean; retryCount: number; finalTtfb?: number; error?: string }> {
  const MAX_RETRIES = 3; // 各URLで3回リトライ
  const TIMEOUT_MS = 3000;
  const hostPort = extractProxyHostPort(proxyServer);

  // HTTP(非TLS)とHTTPSの両方を試す
  const testUrls = [
    { url: 'http://httpbin.org/ip', scheme: 'HTTP (non-TLS)', name: 'httpbin-ip' },
    { url: 'https://ifconfig.co/ip', scheme: 'HTTPS (TLS)', name: 'ifconfig-ip' }
  ];

  proxyLog.log(`[proxy-warmup] Starting nonSnsWarmup for container ${containerId}, proxy ${hostPort}`, {
    containerId,
    testUrls: testUrls.map(u => ({ url: u.url, scheme: u.scheme }))
  });

  // 各URLを順番に試す（HTTP→HTTPSの順）
  for (const testUrl of testUrls) {
    proxyLog.log(`[proxy-warmup] Testing ${testUrl.scheme}: ${testUrl.url}`, {
      containerId,
      proxy: hostPort,
      url: testUrl.url,
      scheme: testUrl.scheme
    });

    let lastError: string | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const startTime = Date.now();
        const response = await new Promise<{ statusCode: number; ttfb: number }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            try { request.abort(); } catch { }
            reject(new Error('timeout'));
          }, TIMEOUT_MS);

          const request = net.request({
            method: 'GET',
            url: testUrl.url,
            session: ses
          });

          request.on('response', (response) => {
            const ttfb = Date.now() - startTime;
            // レスポンスボディは読み飛ばす
            response.on('data', () => { });
            response.on('end', () => {
              clearTimeout(timeout);
              resolve({
                statusCode: response.statusCode,
                ttfb
              });
            });
            response.on('error', (error) => {
              clearTimeout(timeout);
              reject(error);
            });
          });

          request.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });

          request.end();
        });

        if (response.statusCode === 200) {
          proxyLog.log(`[proxy-warmup] ${testUrl.scheme} SUCCESS (attempt ${attempt + 1}/${MAX_RETRIES}, TTFB: ${response.ttfb}ms)`, {
            proxy: hostPort,
            containerId,
            url: testUrl.url,
            scheme: testUrl.scheme,
            statusCode: response.statusCode,
            ttfb: response.ttfb
          });
          // 1つでも成功すればOK
          return { ok: true, retryCount: attempt + 1, finalTtfb: response.ttfb };
        } else {
          const errorMsg = `Unexpected status ${response.statusCode}`;
          lastError = errorMsg;
          proxyLog.warn(`[proxy-warmup] ${testUrl.scheme} attempt ${attempt + 1}/${MAX_RETRIES} failed: ${errorMsg}`, {
            proxy: hostPort,
            containerId,
            url: testUrl.url,
            scheme: testUrl.scheme,
            statusCode: response.statusCode
          });
          // 200以外でもリトライ
          if (attempt < MAX_RETRIES - 1) {
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      } catch (e: any) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        lastError = errorMsg;
        const errorType = errorMsg.includes('ERR_TUNNEL') ? 'ERR_TUNNEL_CONNECTION_FAILED' :
          errorMsg.includes('timeout') ? 'timeout' : 'unknown';
        proxyLog.warn(`[proxy-warmup] ${testUrl.scheme} attempt ${attempt + 1}/${MAX_RETRIES} failed: ${errorMsg}`, {
          proxy: hostPort,
          containerId,
          url: testUrl.url,
          scheme: testUrl.scheme,
          errorType,
          error: errorMsg
        });

        // 最後の試行でない場合はリトライ（少し待機）
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    // このURLで失敗した場合は次のURLを試す（ログに記録）
    proxyLog.warn(`[proxy-warmup] ${testUrl.scheme} FAILED after ${MAX_RETRIES} attempts`, {
      proxy: hostPort,
      containerId,
      url: testUrl.url,
      scheme: testUrl.scheme,
      lastError
    });
  }

  // 全てのURLで失敗
  proxyLog.error(`[proxy-warmup] nonSnsWarmup FAILED: All test URLs failed (HTTP and HTTPS)`, {
    proxy: hostPort,
    containerId,
    testedUrls: testUrls.map(u => u.url)
  });
  return { ok: false, retryCount: MAX_RETRIES, error: 'All test URLs failed (HTTP and HTTPS)' };
}

// SNS静的 warmup: 対象SNSのCDN/TLS経路の到達性を確認（ログインフローは踏まない）
async function snsStaticWarmup(ses: Electron.Session, containerId: string, proxyServer: string, staticUrl: string): Promise<{ ok: boolean; retryCount: number; finalTtfb?: number; error?: string }> {
  const MAX_RETRIES = 2;
  const TIMEOUT_MS = 5000;
  const hostPort = extractProxyHostPort(proxyServer);

  proxyLog.log(`[proxy-warmup] Starting snsStaticWarmup for container ${containerId}, proxy ${hostPort}`, {
    url: staticUrl,
    containerId
  });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const startTime = Date.now();
      const response = await new Promise<{ statusCode: number; ttfb: number }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          try { request.abort(); } catch { }
          reject(new Error('timeout'));
        }, TIMEOUT_MS);

        const request = net.request({
          method: 'GET',
          url: staticUrl,
          session: ses
        });

        request.on('response', (response) => {
          const ttfb = Date.now() - startTime;
          // レスポンスボディは読み飛ばす
          response.on('data', () => { });
          response.on('end', () => {
            clearTimeout(timeout);
            resolve({
              statusCode: response.statusCode,
              ttfb
            });
          });
          response.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });

        request.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });

        request.end();
      });

      if (response.statusCode === 200) {
        proxyLog.log(`[proxy-warmup] snsStaticWarmup SUCCESS (attempt ${attempt + 1}/${MAX_RETRIES}, TTFB: ${response.ttfb}ms)`, {
          proxy: hostPort,
          containerId,
          url: staticUrl
        });
        return { ok: true, retryCount: attempt + 1, finalTtfb: response.ttfb };
      } else {
        const errorMsg = `Unexpected status ${response.statusCode}`;
        proxyLog.warn(`[proxy-warmup] snsStaticWarmup attempt ${attempt + 1}/${MAX_RETRIES} failed: ${errorMsg}`, {
          proxy: hostPort,
          containerId,
          url: staticUrl,
          statusCode: response.statusCode
        });
        // 200以外でもリトライ
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, 1000));
        } else {
          return { ok: false, retryCount: MAX_RETRIES, error: errorMsg };
        }
      }
    } catch (e: any) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      const errorType = errorMsg.includes('ERR_TUNNEL') ? 'ERR_TUNNEL_CONNECTION_FAILED' :
        errorMsg.includes('timeout') ? 'timeout' : 'unknown';
      proxyLog.warn(`[proxy-warmup] snsStaticWarmup attempt ${attempt + 1}/${MAX_RETRIES} failed: ${errorMsg}`, {
        proxy: hostPort,
        containerId,
        url: staticUrl,
        errorType
      });

      // 最後の試行でない場合はリトライ（少し待機）
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, 1000));
      } else {
        return { ok: false, retryCount: MAX_RETRIES, error: errorMsg };
      }
    }
  }

  proxyLog.error(`[proxy-warmup] snsStaticWarmup FAILED after ${MAX_RETRIES} attempts`, {
    proxy: hostPort,
    containerId,
    url: staticUrl
  });
  return { ok: false, retryCount: MAX_RETRIES, error: 'Max retries exceeded' };
}

// Proxy Healthcheck（DEBUG_PROXY_CHECK=1 の時だけ実行）
async function checkProxyHealth(ses: Electron.Session, containerId: string, proxyServer: string): Promise<{ ok: boolean; issues: string[] }> {
  const DEBUG_PROXY_CHECK = process.env.DEBUG_PROXY_CHECK === '1';
  if (!DEBUG_PROXY_CHECK) {
    return { ok: true, issues: [] };
  }

  const issues: string[] = [];
  const hostPort = extractProxyHostPort(proxyServer);

  proxyLog.log(`[proxy-check] Starting healthcheck for container ${containerId}, proxy ${hostPort}`);

  try {
    // 1) httpbin.org/headers でヘッダー漏れチェック
    try {
      const headersUrl = 'https://httpbin.org/headers';
      const startTime = Date.now();
      const headersResponse = await new Promise<{ headers: Record<string, string>; statusCode: number; ttfb: number }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          try { request.abort(); } catch { }
          reject(new Error('headers check timeout'));
        }, 10000);

        const request = net.request({
          method: 'GET',
          url: headersUrl,
          session: ses
        });

        request.on('response', (response) => {
          const ttfb = Date.now() - startTime;
          let body = '';
          response.on('data', (chunk) => {
            body += chunk.toString();
          });
          response.on('end', () => {
            clearTimeout(timeout);
            try {
              const data = JSON.parse(body);
              resolve({
                headers: data.headers || {},
                statusCode: response.statusCode,
                ttfb
              });
            } catch (e) {
              reject(new Error(`Failed to parse headers response: ${e}`));
            }
          });
          response.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });

        request.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });

        request.end();
      });

      // 漏れヘッダーをチェック
      const leakedHeaders: string[] = [];
      const checkHeaders = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'true-client-ip', 'via', 'x-forwarded-proto', 'x-forwarded-host'];
      for (const h of checkHeaders) {
        if (headersResponse.headers[h] || headersResponse.headers[h.toLowerCase()] ||
          headersResponse.headers[h.toUpperCase()]) {
          leakedHeaders.push(h);
        }
      }

      if (leakedHeaders.length > 0) {
        const issue = `ヘッダー漏れ検出: ${leakedHeaders.join(', ')}`;
        issues.push(issue);
        console.warn(`[proxy-check] ${issue}`, {
          proxy: hostPort,
          containerId,
          leakedHeaders: leakedHeaders.map(h => {
            const val = headersResponse.headers[h] || headersResponse.headers[h.toLowerCase()] || headersResponse.headers[h.toUpperCase()];
            // 機密情報はマスク（IPアドレスの最初の3オクテットまで表示）
            if (typeof val === 'string' && /^\d+\.\d+\.\d+\.\d+/.test(val)) {
              const parts = val.split('.');
              return `${h}=${parts[0]}.${parts[1]}.${parts[2]}.***`;
            }
            return `${h}=[REDACTED]`;
          })
        });
      } else {
        proxyLog.log(`[proxy-check] ヘッダー漏れなし (TTFB: ${headersResponse.ttfb}ms)`);
      }
    } catch (e: any) {
      const issue = `httpbin.org/headers チェック失敗: ${e?.message || String(e)}`;
      issues.push(issue);
      proxyLog.warn(`[proxy-check] ${issue}`, { proxy: hostPort, containerId });
    }

    // 2) ipinfo.io/json を2-3回叩いて出口IP安定性チェック
    try {
      const ipinfoUrl = 'https://ipinfo.io/json';
      const ips: string[] = [];

      for (let i = 0; i < 3; i++) {
        try {
          const ipResponse = await new Promise<{ ip?: string }>((resolve, reject) => {
            const timeout = setTimeout(() => {
              try { request.abort(); } catch { }
              reject(new Error('ipinfo check timeout'));
            }, 8000);

            const request = net.request({
              method: 'GET',
              url: ipinfoUrl,
              session: ses
            });

            request.on('response', (response) => {
              let body = '';
              response.on('data', (chunk) => {
                body += chunk.toString();
              });
              response.on('end', () => {
                clearTimeout(timeout);
                try {
                  const data = JSON.parse(body);
                  resolve({ ip: data.ip });
                } catch (e) {
                  reject(new Error(`Failed to parse ipinfo response: ${e}`));
                }
              });
              response.on('error', (error) => {
                clearTimeout(timeout);
                reject(error);
              });
            });

            request.on('error', (error) => {
              clearTimeout(timeout);
              reject(error);
            });

            request.end();
          });

          if (ipResponse.ip) {
            ips.push(ipResponse.ip);
          }

          // 2回目以降は少し待機
          if (i < 2) {
            await new Promise(r => setTimeout(r, 1000));
          }
        } catch (e: any) {
          proxyLog.warn(`[proxy-check] ipinfo.io check ${i + 1}/3 failed:`, e?.message || String(e));
        }
      }

      // IPの一意性をチェック
      const uniqueIps = new Set(ips);
      if (uniqueIps.size > 1) {
        const issue = `出口IPが不安定: ${Array.from(uniqueIps).join(', ')}`;
        issues.push(issue);
        proxyLog.warn(`[proxy-check] ${issue}`, { proxy: hostPort, containerId });
      } else if (ips.length > 0) {
        // IPの最初の3オクテットまで表示
        const ipParts = ips[0].split('.');
        const maskedIp = ipParts.length === 4 ? `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}.***` : '[REDACTED]';
        proxyLog.log(`[proxy-check] 出口IP安定: ${maskedIp} (${ips.length}回チェック)`);
      }
    } catch (e: any) {
      const issue = `ipinfo.io チェック失敗: ${e?.message || String(e)}`;
      issues.push(issue);
      proxyLog.warn(`[proxy-check] ${issue}`, { proxy: hostPort, containerId });
    }

    // 3) x.com と abs.twimg.com のTTFB計測
    const xUrls = [
      { url: 'https://x.com/', name: 'x.com' },
      { url: 'https://abs.twimg.com/favicons/twitter.3.ico', name: 'abs.twimg.com' }
    ];

    for (const { url, name } of xUrls) {
      try {
        const startTime = Date.now();
        const xResponse = await new Promise<{ statusCode: number; ttfb: number }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            try { request.abort(); } catch { }
            reject(new Error(`${name} timeout`));
          }, 15000);

          const request = net.request({
            method: 'GET',
            url: url,
            session: ses
          });

          request.on('response', (response) => {
            const ttfb = Date.now() - startTime;
            // レスポンスボディは読み飛ばす
            response.on('data', () => { });
            response.on('end', () => {
              clearTimeout(timeout);
              resolve({
                statusCode: response.statusCode,
                ttfb
              });
            });
            response.on('error', (error) => {
              clearTimeout(timeout);
              reject(error);
            });
          });

          request.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });

          request.end();
        });

        if (xResponse.ttfb > 10000) {
          const issue = `${name} TTFBが極端に悪い: ${xResponse.ttfb}ms`;
          issues.push(issue);
          proxyLog.warn(`[proxy-check] ${issue}`, { proxy: hostPort, containerId, statusCode: xResponse.statusCode });
        } else {
          proxyLog.log(`[proxy-check] ${name} TTFB: ${xResponse.ttfb}ms (status: ${xResponse.statusCode})`);
        }
      } catch (e: any) {
        const issue = `${name} TTFB計測失敗: ${e?.message || String(e)}`;
        issues.push(issue);
        proxyLog.warn(`[proxy-check] ${issue}`, { proxy: hostPort, containerId });
      }
    }

    const ok = issues.length === 0;
    if (ok) {
      proxyLog.log(`[proxy-check] Healthcheck PASSED for proxy ${hostPort}`);
    } else {
      proxyLog.error(`[proxy-check] Healthcheck FAILED for proxy ${hostPort}:`, issues);
    }

    return { ok, issues };
  } catch (e: any) {
    const issue = `Healthcheck全体失敗: ${e?.message || String(e)}`;
    proxyLog.error(`[proxy-check] ${issue}`, { proxy: hostPort, containerId });
    return { ok: false, issues: [issue] };
  }
}

// ネットワークメタ情報を取得（ipwho.is からASN/org/isp/domain情報を取得）
// エラーが発生した場合は静かに失敗（エラーダイアログを表示しない、warmup判定には影響しない）
async function getNetworkMetadata(ses: Electron.Session, containerId: string, proxyServer: string): Promise<{
  ip?: string;
  asn?: number;
  org?: string;
  isp?: string;
  domain?: string;
} | null> {
  try {
    const timeoutMs = 5000;
    // ipwho.is を優先使用（タイムアウトしにくい）
    const ipwhoisUrl = 'https://ipwho.is/';

    const request = net.request({
      method: 'GET',
      url: ipwhoisUrl,
      session: ses
    });

    const responsePromise = new Promise<{
      ip?: string;
      connection?: {
        asn?: number;
        org?: string;
        isp?: string;
        domain?: string;
      };
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        try { request.abort(); } catch { }
        reject(new Error('getNetworkMetadata timeout'));
      }, timeoutMs);

      request.on('response', (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk.toString();
        });
        response.on('end', () => {
          clearTimeout(timeout);
          try {
            const data = JSON.parse(body);
            resolve({
              ip: data.ip,
              connection: data.connection
            });
          } catch (e) {
            reject(new Error(`Failed to parse ipwho.is response: ${e}`));
          }
        });
        response.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      request.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    request.end();
    const ipwhoisData = await responsePromise;

    if (!ipwhoisData.ip) {
      proxyLog.warn(`[proxy-net] ipwho.is returned no IP`, { containerId });
      return null;
    }

    const metadata = {
      ip: ipwhoisData.ip,
      asn: ipwhoisData.connection?.asn,
      org: ipwhoisData.connection?.org,
      isp: ipwhoisData.connection?.isp,
      domain: ipwhoisData.connection?.domain
    };

    proxyLog.log(`[proxy-net] egress (ipwhois)`, {
      containerId,
      ip: metadata.ip,
      asn: metadata.asn,
      org: metadata.org,
      isp: metadata.isp,
      domain: metadata.domain
    });

    return metadata;
  } catch (e) {
    // エラーを再スローせず、静かに失敗（warmup判定には影響しない）
    const errorMsg = e instanceof Error ? e.message : String(e);
    proxyLog.warn(`[proxy-net] Failed to get network metadata from ipwho.is`, {
      containerId,
      error: errorMsg
    });
    return null;
  }
}

// SNSネットワークポリシー評価（将来SNS追加に備えて拡張可能な構造）
type NetworkMetadata = {
  ip?: string;
  asn?: number;
  org?: string;
  isp?: string;
  domain?: string;
};

type NetworkPolicyDecision = {
  ok: boolean;
  level: 'allow' | 'warn' | 'block';
  reason: string;
  asn?: number;
  org?: string;
};

// X向けネットワークポリシー評価
function evaluateXNetworkPolicy(netMeta: NetworkMetadata | null): NetworkPolicyDecision {
  // ネットワークメタが取得できない場合はallow（判定を落とさない）
  if (!netMeta || !netMeta.asn) {
    return {
      ok: true,
      level: 'allow',
      reason: 'Network metadata not available',
      asn: netMeta?.asn,
      org: netMeta?.org
    };
  }

  const BLOCK_X_ON_DATACENTER = process.env.BLOCK_X_ON_DATACENTER === '1'; // default: 0 (OFF)
  const WARN_X_ON_TRANSIT_ORG = process.env.WARN_X_ON_TRANSIT_ORG !== '0'; // default: 1 (ON)

  const asn = netMeta.asn;
  const org = (netMeta.org || '').toLowerCase();
  const domain = (netMeta.domain || '').toLowerCase();
  const isp = (netMeta.isp || '').toLowerCase();

  // block: 主要クラウド/データセンター系（BLOCK_X_ON_DATACENTER=1 のときだけ）
  if (BLOCK_X_ON_DATACENTER) {
    // AWS ASN 16509
    if (asn === 16509) {
      return {
        ok: false,
        level: 'block',
        reason: `Datacenter detected (AWS ASN ${asn}, org: ${netMeta.org || 'unknown'}, domain: ${netMeta.domain || 'unknown'})`,
        asn,
        org: netMeta.org
      };
    }

    // org/domainで判定（AWS, Azure, GCP等の主要クラウド）
    if (org.includes('amazon data services') || org.includes('amazon.com') || domain.includes('amazon.com')) {
      return {
        ok: false,
        level: 'block',
        reason: `Datacenter detected (ASN ${asn}, org: ${netMeta.org || 'unknown'}, domain: ${netMeta.domain || 'unknown'})`,
        asn,
        org: netMeta.org
      };
    }
    if (org.includes('microsoft') || domain.includes('microsoft.com') || domain.includes('azure.com')) {
      return {
        ok: false,
        level: 'block',
        reason: `Datacenter detected (ASN ${asn}, org: ${netMeta.org || 'unknown'}, domain: ${netMeta.domain || 'unknown'})`,
        asn,
        org: netMeta.org
      };
    }
    if (org.includes('google') || domain.includes('google.com') || domain.includes('gcp.com')) {
      return {
        ok: false,
        level: 'block',
        reason: `Datacenter detected (ASN ${asn}, org: ${netMeta.org || 'unknown'}, domain: ${netMeta.domain || 'unknown'})`,
        asn,
        org: netMeta.org
      };
    }
    if (org.includes('digitalocean') || domain.includes('digitalocean.com')) {
      return {
        ok: false,
        level: 'block',
        reason: `Datacenter detected (ASN ${asn}, org: ${netMeta.org || 'unknown'}, domain: ${netMeta.domain || 'unknown'})`,
        asn,
        org: netMeta.org
      };
    }
    if (org.includes('ovh') || domain.includes('ovh.com')) {
      return {
        ok: false,
        level: 'block',
        reason: `Datacenter detected (ASN ${asn}, org: ${netMeta.org || 'unknown'}, domain: ${netMeta.domain || 'unknown'})`,
        asn,
        org: netMeta.org
      };
    }
  } else {
    // BLOCK_X_ON_DATACENTER=0 の場合、DC検出時はwarnログを出す（blockしない）
    const isDatacenter = (asn === 16509) ||
      (org.includes('amazon data services') || org.includes('amazon.com') || domain.includes('amazon.com')) ||
      (org.includes('microsoft') || domain.includes('microsoft.com') || domain.includes('azure.com')) ||
      (org.includes('google') || domain.includes('google.com') || domain.includes('gcp.com')) ||
      (org.includes('digitalocean') || domain.includes('digitalocean.com')) ||
      (org.includes('ovh') || domain.includes('ovh.com'));
    if (isDatacenter) {
      proxyLog.warn(`[net-policy] WARN Datacenter detected (BLOCK_X_ON_DATACENTER=0, allowing)`, {
        asn,
        org: netMeta.org,
        domain: netMeta.domain
      });
      // blockしない（warn ログのみ）
    }
  }

  // warn: 不安定になりがちなトランジット系（同じASNでもorgで判定）
  if (WARN_X_ON_TRANSIT_ORG) {
    if (org.includes('pacnet')) {
      return {
        ok: true,
        level: 'warn',
        reason: `Transit provider detected (ASN ${asn}, org: ${netMeta.org || 'unknown'}) - may be unstable for X`,
        asn,
        org: netMeta.org
      };
    }
  }

  // allow: その他（Ping Broadband Japan等はここ）
  return {
    ok: true,
    level: 'allow',
    reason: `Network looks acceptable (ASN ${asn}, org: ${netMeta.org || 'unknown'})`,
    asn,
    org: netMeta.org
  };
}

// SNSネットワークポリシー評価（拡張可能な構造）
function evaluateNetworkPolicy(startUrl: string, netMeta: NetworkMetadata | null): NetworkPolicyDecision | null {
  if (!startUrl) return null;

  // X向けポリシー
  if (isXUrl(startUrl)) {
    return evaluateXNetworkPolicy(netMeta);
  }

  // 将来的に他SNSを追加する場合はここに追加
  // if (isInstagramUrl(startUrl)) {
  //   return evaluateInstagramNetworkPolicy(netMeta);
  // }

  return null;
}

// 出口IP情報を取得（ipinfo.io からASN情報も抽出）
// エラーが発生した場合は静かに失敗（エラーダイアログを表示しない）
async function probeEgressNetwork(ses: Electron.Session, containerId: string, proxyServer: string): Promise<void> {
  try {
    const timeoutMs = 5000;
    const ipinfoUrl = 'https://ipinfo.io/json';

    const request = net.request({
      method: 'GET',
      url: ipinfoUrl,
      session: ses
    });

    const responsePromise = new Promise<{ ip?: string; country?: string; org?: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        try {
          request.abort();
        } catch { }
        reject(new Error('probeEgressNetwork timeout'));
      }, timeoutMs);

      request.on('response', (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk.toString();
        });
        response.on('end', () => {
          clearTimeout(timeout);
          try {
            const data = JSON.parse(body);
            resolve({
              ip: data.ip,
              country: data.country,
              org: data.org
            });
          } catch (e) {
            reject(new Error(`Failed to parse ipinfo response: ${e}`));
          }
        });
        response.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      request.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    request.end();
    const ipinfo = await responsePromise;

    if (!ipinfo.ip) {
      return;
    }

    // ipinfo.io の org フィールドからASNを抽出（例: "AS4637 Telstra Global" -> ASN: "4637", orgName: "Telstra Global"）
    let asnInfo: { asn?: string; prefix?: string; name?: string } = {};
    if (ipinfo.org) {
      const asnMatch = ipinfo.org.match(/^AS(\d+)/i);
      if (asnMatch) {
        const extractedAsn = asnMatch[1];
        const extractedOrgName = ipinfo.org.replace(/^AS\d+\s*/, '').trim() || undefined;
        asnInfo = {
          asn: extractedAsn,
          prefix: undefined,
          name: extractedOrgName
        };
      }
    }

    // TODO: DBに保存する場合はここで実装
    // DB.updateContainerEgressInfo(containerId, { ip: ipinfo.ip, country: ipinfo.country, org: ipinfo.org, asn: asnInfo.asn, prefix: asnInfo.prefix });

  } catch (e) {
    // エラーを再スローせず、静かに失敗（エラーダイアログを表示しない）
    // この関数は診断機能であり、失敗してもコンテナの動作に影響しない
    return;
  }
}

// Register main window reference to prevent accidental app quit when closing containers
export function setMainWindow(win: BrowserWindow) {
  mainWindowRef = win;
  // Clear ref when window is destroyed
  try {
    win.on('closed', () => {
      if (mainWindowRef === win) mainWindowRef = null;
    });
  } catch { }
}

// --- helpers for external control (export API) ---
export function isContainerOpen(containerId: string) {
  return openedById.has(containerId);
}

export function closeContainer(containerId: string) {
  const entry = openedById.get(containerId);
  if (!entry || !entry.win) return false;
  try {
    entry.win.close();
    return true;
  } catch (e) {
    console.error('[main] closeContainer error', e);
    return false;
  }
}

export function waitForContainerClosed(containerId: string, timeoutMs = 60000) {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (!openedById.has(containerId)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitForContainerClosed timeout'));
      setTimeout(check, 200);
    };
    check();
  });
}


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
      try { existing.win.focus(); } catch { }
      if (startUrl) {
        // if existing window is open, navigate via Playwright
        const currentUrl = existing.playwrightPage ? existing.playwrightPage.url() : '';
        if (!currentUrl || currentUrl === 'about:blank') {
          try { await existing.playwrightPage.goto(startUrl); } catch { }
        } else {
          // If already has a URL, we could create a new tab if supported, but for PoC we just navigate
          try { await existing.playwrightPage.goto(startUrl); } catch { }
        }
      }
      return existing.win;
    }
  } catch { }
  // --- Kameleo Integration Start ---
  let kameleoProfileId = container.kameleoProfileId || '';
  let startedByThisProcess = false;
  try {
    const profiles = await KameleoApi.listProfiles();
    let profile: any = null;

    if (kameleoProfileId) {
      profile = profiles.find(p => p.id === kameleoProfileId);
    }

    if (!profile && container.profileMode !== 'attached') {
      const profileName = `container-browser-${container.id}`;
      profile = profiles.find(p => p.name === profileName);
    }

    if (!profile) {
      if (container.profileMode === 'attached') {
        throw new Error(`Attached profile ${kameleoProfileId} not found in Kameleo.`);
      }
      console.log(`[main] [kameleo] Creating new profile for container ${container.id} with env:`, container.kameleoEnv);
      profile = await KameleoApi.createProfile({
        name: `container-browser-${container.id}`,
        tags: ['container-browser'],
        deviceType: container.kameleoEnv?.deviceType,
        os: container.kameleoEnv?.os,
        browser: container.kameleoEnv?.browser,
      });
      // Save the new ID to DB
      container.kameleoProfileId = profile.id;
      container.profileMode = 'managed';
      DB.upsertContainer(container);
    }
    kameleoProfileId = profile.id;

    // Proxy Update Policy: Only if managed + stopped (avoid side effects for shared/cloud attached profiles)
    if (container.proxy && profile.status === 'stopped' && container.profileMode === 'managed') {
      const hostPort = extractProxyHostPort(container.proxy.server);
      const [host, port] = hostPort.split(':');
      const updateOptions = {
        proxy: {
          type: container.proxy.server.startsWith('socks5') ? 'socks5' : 'http',
          host,
          port: parseInt(port) || 80,
          username: container.proxy.username,
          password: container.proxy.password
        }
      };
      try {
        await KameleoApi.updateProfile(kameleoProfileId, updateOptions);
      } catch (err) {
        console.warn(`[main] [kameleo] Profile proxy update failed: ${err}`);
      }
    }

    if (profile.status === 'stopped') {
      console.log(`[main] [kameleo] Starting profile ${kameleoProfileId} for container ${container.id}`);
      await KameleoApi.startProfile(kameleoProfileId);
      startedByThisProcess = true;
    } else {
      console.log(`[main] [kameleo] Profile ${kameleoProfileId} is already ${profile.status}, skipping start call`);
    }
  } catch (e) {
    console.error(`[main] [kameleo] Failed to manage profile for container ${container.id}`, e);
    throw e;
  }
  // --- Kameleo Integration End ---

  // --- Playwright Integration Start ---
  let playwrightPage: any;
  try {
    console.log(`[main] [playwright] Connecting to Kameleo profile ${kameleoProfileId}`);
    playwrightPage = await PlaywrightService.getPage(kameleoProfileId);
    console.log(`[main] [playwright] Connected to page of profile ${kameleoProfileId}`);
  } catch (e) {
    console.error(`[main] [playwright] Failed to connect to Kameleo profile ${kameleoProfileId}`, e);
    throw e;
  }
  // --- Playwright Integration End ---

  const shellPreloadPath = path.join(app.getAppPath(), 'out', 'preload', 'mainPreload.cjs');
  const w = container.fingerprint?.viewportWidth || 1280;
  const h = container.fingerprint?.viewportHeight || 800;

  // The Electron window now serves only as a "Shell" (control bar, etc.)
  // We don't use the container's partition here because actual browsing happens in Kameleo
  const win = new BrowserWindow({
    width: w,
    height: h + BAR_HEIGHT,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: shellPreloadPath,
    }
  });

  // mark this window as a container shell
  (win as any).__isContainerShell = true;
  (win as any).__containerId = container.id;

  try { win.removeMenu(); win.setAutoHideMenuBar(true); } catch { }

  const sessionId = randomUUID();
  DB.recordSession(sessionId, container.id, Date.now());

  win.on('closed', async () => {
    DB.closeSession(sessionId, Date.now());
    openedById.delete(container.id);
    try {
      await PlaywrightService.disconnect(kameleoProfileId);
      
      // Auto-stop policy: managed は常にストップ、attached はこのプロセスで開始した場合のみストップ
      const shouldStop = container.profileMode === 'managed' || startedByThisProcess;
      if (shouldStop) {
        console.log(`[main] [kameleo] Auto-stopping profile ${kameleoProfileId} (Mode: ${container.profileMode}, Started: ${startedByThisProcess})`);
        await KameleoApi.stopProfile(kameleoProfileId);
      } else {
        console.log(`[main] [kameleo] Keeping profile ${kameleoProfileId} running (Mode: ${container.profileMode}, Started: ${startedByThisProcess})`);
      }
    } catch (e) {
      console.error(`[main] [kameleo] Error during window close cleanup for profile ${kameleoProfileId}`, e);
    }
  });

  // Register in openedById
  openedById.set(container.id, {
    id: container.id,
    sessionId,
    win,
    kameleoProfileId,
    playwrightPage,
    startedByThisProcess
  } as any);

  // Proxy Playwright events to Electron Shell
  playwrightPage.on('framenavigated', (frame: any) => {
    if (frame === playwrightPage.mainFrame()) {
        const url = playwrightPage.url();
        win.webContents.send('container.context', {
            containerId: container.id,
            sessionId,
            currentUrl: url,
            tabs: [{ url, title: 'Loading...' }],
            activeIndex: 0
        });
    }
  });

  playwrightPage.on('load', async () => {
    try {
      const title = await playwrightPage.title();
      const url = playwrightPage.url();
      win.webContents.send('container.context', {
          containerId: container.id,
          sessionId,
          currentUrl: url,
          tabs: [{ url, title }],
          activeIndex: 0
      });
      DB.addOrUpdateTab({ containerId: container.id, sessionId, url, tabIndex: 0, updatedAt: Date.now() });
    } catch { }
  });

  playwrightPage.on('domcontentloaded', async () => {
    try {
      const title = await playwrightPage.title();
      win.webContents.send('container.context', {
          containerId: container.id,
          sessionId,
          currentUrl: playwrightPage.url(),
          tabs: [{ url: playwrightPage.url(), title }],
          activeIndex: 0
      });
    } catch { }
  });

  const sendCtx = async () => {
    try {
      const url = playwrightPage.url();
      const title = await playwrightPage.title();
      win.webContents.send('container.context', {
        containerId: container.id,
        sessionId,
        currentUrl: url,
        tabs: [{ url, title }],
        activeIndex: 0,
        containerName: container.name || ''
      });
    } catch { }
  };
  win.webContents.on('did-finish-load', sendCtx);
  // hide menu bar for the container shell window (remove File/Edit menus)
  try { win.removeMenu(); win.setAutoHideMenuBar(true); } catch { }



  // Load Shell UI
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  const shellHtml = devUrl
    ? `${devUrl.replace(/\/\/$/, '')}/containerShell.html`
    : new URL('file://' + path.join(app.getAppPath(), 'out', 'renderer', 'containerShell.html')).toString();

  await win.loadURL(shellHtml);
  win.show();

  // Load startUrl via Playwright if provided
  if (startUrl) {
    try {
      console.log(`[main] [playwright] Navigating to ${startUrl}`);
      await playwrightPage.goto(startUrl, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      console.error(`[main] [playwright] Failed to navigate to ${startUrl}`, e);
    }
  }

  return win;
}

export function closeAllContainers() {
  try {
    console.log('[main] closeAllContainers: closing', openedById.size, 'containers');
    for (const entry of openedById.values()) {
      try { entry.win.close(); } catch { }
    }
    openedById.clear();
  } catch { }
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
          try { w.close(); } catch { }
        }
      } catch (e) { console.error('[main] closeAllNonMainWindows error', e); }
    }
  } catch { }
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
          try { w.destroy(); } catch { }
        }
      } catch { }
    }
  } catch { }
}

export async function getContextForWindow(win: BrowserWindow) {
  for (const [containerId, entry] of openedById.entries()) {
    if (entry.win === win) {
      const containerRecord = DB.getContainer(containerId) || { name: undefined };
      const containerName = containerRecord.name ?? '';
      const url = entry.playwrightPage.url();
      let title = await entry.playwrightPage.title().catch(() => '(Kameleo Browser)');
      
      const tabs = [{ url, title }];
      const currentUrl = url;
      try { entry.win.setTitle(containerName || 'コンテナシェル'); } catch { }
      return { containerId, sessionId: entry.sessionId, fingerprint: containerRecord.fingerprint, currentUrl, tabs, containerName, activeIndex: 0 };
    }
  }
  return null;
}

export async function createTab(containerId: string, url: string) {
  const entry = openedById.get(containerId);
  if (!entry) return false;
  try {
    await entry.playwrightPage.goto(url || 'about:blank');
    return true;
  } catch {
    return false;
  }
}

export function switchTab(containerId: string, index: number) {
  // Kameleo backend only supports single tab per shell for now
  return true;
}

export function closeTab(containerId: string, index: number) {
  // Kameleo backend only supports single tab per shell for now
  return true;
}

export function listTabs(sessionId: string) {
  return DB.tabsOfSession(sessionId);
}

export async function navigateContainer(containerId: string, url: string) {
  const item = openedById.get(containerId);
  if (!item) return false;
  try {
    await item.playwrightPage.goto(url);
    return true;
  } catch {
    return false;
  }
}

export function registerContainerIpcHandlers() {
  const ipc = ipcMain;
  if (!ipc) return;
  ipc.handle('container.navigate', (_e, { containerId, url }) => navigateContainer(containerId, url));
  ipc.handle('tabs.navigate', (_e, { containerId, url }) => navigateContainer(containerId, url));
  ipc.handle('tabs.goBack', (_e: any, { containerId }: { containerId: string }) => goBack(containerId));
  ipc.handle('tabs.goForward', (_e: any, { containerId }: { containerId: string }) => goForward(containerId));
  ipc.handle('tabs.create', (_e: any, { containerId, url }: { containerId: string, url: string }) => createTab(containerId, url));
  ipc.handle('tabs.switch', (_e: any, { containerId, index }: { containerId: string, index: number }) => switchTab(containerId, index));
  ipc.handle('tabs.close', (_e: any, { containerId, index }: { containerId: string, index: number }) => closeTab(containerId, index));
}

export async function goBack(containerId: string) {
  const it = openedById.get(containerId);
  if (!it) return false;
  try {
    await it.playwrightPage.goBack();
    return true;
  } catch {
    return false;
  }
}

export async function goForward(containerId: string) {
  const it = openedById.get(containerId);
  if (!it) return false;
  try {
    await it.playwrightPage.goForward();
    return true;
  } catch {
    return false;
  }
}

export function getActiveWebContents(containerId: string) {
  // Return null because actual browsing happens in external browser
  return null;
}

// Clear cache for a container (HTTP cache only, preserves cookies and session data)
export function clearContainerCache(containerId: string) {
  try {
    if (!containerId) {
      console.error('[main] clearContainerCache: containerId is missing');
      return false;
    }

    const container = DB.getContainer(containerId);
    if (!container) {
      console.error('[main] clearContainerCache: container not found', containerId);
      return false;
    }

    const part = container.partition;
    if (!part) {
      console.error('[main] clearContainerCache: container has no partition', containerId);
      return false;
    }

    const ses = session.fromPartition(part, { cache: true });
    ses.clearCache((error) => {
      if (error) {
        console.error('[main] clearContainerCache: failed to clear cache', error);
      } else {
        console.log('[main] clearContainerCache: cache cleared for container', containerId);
      }
    });

    return true;
  } catch (e) {
    console.error('[main] clearContainerCache error', e);
    return false;
  }
}

// Clear cache on container close (preserves cookies and session data)
// Clears: HTTP cache, ServiceWorker cache, CacheStorage
// Preserves: cookies, localStorage, IndexedDB
export async function clearContainerCacheOnClose(containerId: string): Promise<void> {
  try {
    if (!containerId) {
      console.warn('[main] clearContainerCacheOnClose: containerId is missing');
      return;
    }

    const container = DB.getContainer(containerId);
    if (!container) {
      console.warn('[main] clearContainerCacheOnClose: container not found', containerId);
      return;
    }

    const part = container.partition;
    if (!part) {
      console.warn('[main] clearContainerCacheOnClose: container has no partition', containerId);
      return;
    }

    const ses = session.fromPartition(part, { cache: true });

    // Clear HTTP cache
    await new Promise<void>((resolve) => {
      ses.clearCache((error) => {
        if (error) {
          console.warn('[main] clearContainerCacheOnClose: failed to clear HTTP cache', error);
        } else {
          console.log('[main] clearContainerCacheOnClose: HTTP cache cleared for container', containerId);
        }
        resolve();
      });
    });

    // Clear ServiceWorker cache and CacheStorage (preserving cookies)
    try {
      await ses.clearStorageData({
        storages: ['serviceworkers', 'cachestorage']
      });
      console.log('[main] clearContainerCacheOnClose: ServiceWorker and CacheStorage cleared for container', containerId);
    } catch (e) {
      console.warn('[main] clearContainerCacheOnClose: failed to clear ServiceWorker/CacheStorage', e);
    }

  } catch (e) {
    // エラーはログのみ（コンテナの閉じる処理をブロックしない）
    console.warn('[main] clearContainerCacheOnClose error', e);
  }
}

// Clear storage for X domains (cookies, localStorage, etc.) for recovery from 400 errors
export async function clearContainerStorageForX(containerId: string): Promise<boolean> {
  try {
    if (!containerId) {
      console.error('[main] clearContainerStorageForX: containerId is missing');
      return false;
    }

    const container = DB.getContainer(containerId);
    if (!container) {
      console.error('[main] clearContainerStorageForX: container not found', containerId);
      return false;
    }

    const part = container.partition;
    if (!part) {
      console.error('[main] clearContainerStorageForX: container has no partition', containerId);
      return false;
    }

    const ses = session.fromPartition(part, { cache: true });

    // X関連ドメインのリスト
    const xDomains = [
      'x.com',
      'twitter.com',
      'api.x.com',
      'abs.twimg.com',
      'twimg.com'
    ];

    // 各ドメインのstorageをクリア
    for (const domain of xDomains) {
      try {
        await ses.clearStorageData({
          origin: `https://${domain}`,
          storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage']
        });
        console.log(`[main] clearContainerStorageForX: cleared storage for ${domain}`);
      } catch (e) {
        console.warn(`[main] clearContainerStorageForX: failed to clear storage for ${domain}:`, e);
      }
    }

    console.log('[main] clearContainerStorageForX: storage cleared for X domains', containerId);
    return true;
  } catch (e) {
    console.error('[main] clearContainerStorageForX error', e);
    return false;
  }
}

// Clear all storage data (cookies, localStorage, IndexedDB, etc.) for a container
export async function clearContainerAllData(containerId: string): Promise<boolean> {
  try {
    if (!containerId) {
      console.error('[main] clearContainerAllData: containerId is missing');
      return false;
    }

    const container = DB.getContainer(containerId);
    if (!container) {
      console.error('[main] clearContainerAllData: container not found', containerId);
      return false;
    }

    const part = container.partition;
    if (!part) {
      console.error('[main] clearContainerAllData: container has no partition', containerId);
      return false;
    }

    const ses = session.fromPartition(part, { cache: true });

    // Clear all storage data (cookies, localStorage, IndexedDB, etc.) from all origins
    await ses.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage', 'filesystem']
    });

    // Also clear HTTP cache
    await new Promise<void>((resolve, reject) => {
      ses.clearCache((error) => {
        if (error) {
          console.warn('[main] clearContainerAllData: failed to clear cache', error);
        } else {
          console.log('[main] clearContainerAllData: cache cleared');
        }
        resolve();
      });
    });

    console.log('[main] clearContainerAllData: all data cleared for container', containerId);
    return true;
  } catch (e) {
    console.error('[main] clearContainerAllData error', e);
    return false;
  }
}

// handled in registerContainerIpcHandlers

/**
 * Physically delete storage folders for a container.
 * This should be called after the container is removed from the database
 * or during a cleanup of orphaned folders.
 */
export async function deleteContainerStorage(containerId: string) {
  try {
    const userDataPath = app.getPath('userData');
    const partitionDirName = `container-${containerId}`;

    const partitionPath = path.join(userDataPath, 'Partitions', partitionDirName);
    const profilePath = path.join(userDataPath, 'profiles', containerId);

    // Delete partition folder
    if (fs.existsSync(partitionPath)) {
      try {
        fs.rmSync(partitionPath, { recursive: true, force: true });
        console.log(`[main] Deleted partition folder: ${partitionPath}`);
      } catch (e) {
        console.warn(`[main] Failed to delete partition folder (likely in use): ${partitionPath}`);
      }
    }

    // Delete profile folder
    if (fs.existsSync(profilePath)) {
      try {
        fs.rmSync(profilePath, { recursive: true, force: true });
        console.log(`[main] Deleted profile folder: ${profilePath}`);
      } catch (e) {
        console.warn(`[main] Failed to delete profile folder (likely in use): ${profilePath}`);
      }
    }

    // Delete any backup folders
    const partitionsParent = path.join(userDataPath, 'Partitions');
    if (fs.existsSync(partitionsParent)) {
      const folders = fs.readdirSync(partitionsParent);
      for (const folder of folders) {
        if (folder.startsWith(`${partitionDirName}.backup.`)) {
          const backupPath = path.join(partitionsParent, folder);
          try {
            fs.rmSync(backupPath, { recursive: true, force: true });
            console.log(`[main] Deleted orphan backup partition: ${backupPath}`);
          } catch (e) { /* ignore */ }
        }
      }
    }
  } catch (e) {
    console.error(`[main] Error during deleteContainerStorage for ${containerId}`, e);
  }
}

/**
 * Scans Partitions and profiles directories for folders that don't match any container in the DB.
 * This helps prevent disk space accumulation from incomplete deletions or migration artifacts.
 */
export async function cleanupOrphans() {
  try {
    console.log('[main] Starting orphan folder cleanup...');
    const containers = DB.listContainers();
    const activeIds = new Set(containers.map(c => c.id));
    const userDataPath = app.getPath('userData');

    // 1. Cleanup Partitions
    const partitionsDir = path.join(userDataPath, 'Partitions');
    if (fs.existsSync(partitionsDir)) {
      const folders = fs.readdirSync(partitionsDir);
      for (const folder of folders) {
        if (!folder.startsWith('container-')) continue;

        // Extract ID (handling both container-ID and container-ID.backup.TIMESTAMP)
        const idMatch = folder.match(/^container-([0-9a-f-]{36})/i);
        if (idMatch) {
          const id = idMatch[1];
          if (!activeIds.has(id)) {
            const target = path.join(partitionsDir, folder);
            console.log(`[main] Found orphan partition folder: ${folder}. Deleting...`);
            try {
              fs.rmSync(target, { recursive: true, force: true });
            } catch (e) {
              console.warn(`[main] Could not delete orphan partition ${folder} (maybe in use)`);
            }
          }
        }
      }
    }

    // 2. Cleanup profiles
    const profilesDir = path.join(userDataPath, 'profiles');
    if (fs.existsSync(profilesDir)) {
      const folders = fs.readdirSync(profilesDir);
      for (const folder of folders) {
        // profile folders are just the UUID
        if (/^[0-9a-f-]{36}$/i.test(folder)) {
          if (!activeIds.has(folder)) {
            const target = path.join(profilesDir, folder);
            console.log(`[main] Found orphan profile folder: ${folder}. Deleting...`);
            try {
              fs.rmSync(target, { recursive: true, force: true });
            } catch (e) {
              console.warn(`[main] Could not delete orphan profile ${folder}`);
            }
          }
        }
      }
    }
    console.log('[main] Orphan cleanup finished.');
  } catch (e) {
    console.error('[main] Error during cleanupOrphans', e);
  }
}
