import { app, BrowserWindow, BrowserView, ipcMain, session, net } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Container } from '../shared/types';
import { DB } from './db';
import { existsSync } from 'node:fs';
import { proxyCredentialsByPartition, proxyCredentialsByHostPort } from './index';

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

type OpenedContainer = { win: BrowserWindow; views: BrowserView[]; activeIndex: number; sessionId: string };
const openedById = new Map<string, OpenedContainer>();
let isRestoringGlobal = false;
let mainWindowRef: BrowserWindow | null = null;

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
async function warmupLoad(win: BrowserWindow, url: string, timeoutMs: number): Promise<{ ok: boolean; ttfb?: number; error?: string; errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean }> {
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
  let warmupWin: BrowserWindow | null = null;
  
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
            try { request.abort(); } catch {}
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
            response.on('data', () => {});
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
            } catch (e) {}
            
            const fallbackResult = await warmupLoad(fallbackWin, testUrl.url, FALLBACK_LOADURL_TIMEOUT_MS);
            
            try {
              fallbackWin.destroy();
            } catch (e) {}
            
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
        const testWin = new BrowserWindow({
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
          testWin.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
          (testWin.webContents as any)._containerId = containerId;
        } catch (e) {}
        
        const loadUrlResult = await warmupLoad(testWin, nonSnsUrls[0].url, 8000);
        proxyLog.log(`[proxy-warmup] loadURL warmup (auxiliary) result`, {
          containerId,
          proxy: hostPort,
          url: nonSnsUrls[0].url,
          ok: loadUrlResult.ok,
          ttfb: loadUrlResult.ttfb,
          error: loadUrlResult.error
        });
        
        try {
          testWin.destroy();
        } catch (e) {}
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
            try { request.abort(); } catch {}
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
            response.on('data', () => {});
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
          try { request.abort(); } catch {}
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
          response.on('data', () => {});
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
          try { request.abort(); } catch {}
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
              try { request.abort(); } catch {}
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
            try { request.abort(); } catch {}
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
            response.on('data', () => {});
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
        try { request.abort(); } catch {}
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
        } catch {}
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
  } catch {}
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
      try { existing.win.focus(); } catch {}
      if (startUrl) {
        // if existing window has no visible webContents URL (just created), load into existing view instead of creating duplicate window
        const activeView = existing.views[existing.activeIndex] || existing.views[0];
        const currentUrl = activeView ? (activeView.webContents.getURL?.() || '') : '';
        if (!currentUrl || currentUrl === 'about:blank') {
          try { activeView.webContents.loadURL(startUrl); } catch { try { createTab(container.id, startUrl); } catch {} }
        } else {
          try { createTab(container.id, startUrl); } catch {}
        }
      }
      return existing.win;
    }
  } catch {}
  const part = container.partition;
  const ses = session.fromPartition(part, { cache: true });
  // プロファイルは 'persist:<name>' の partition により分離される。
  // キャッシュ保存先の明示セットは不要（Electron が userData/Partitions 配下に保存）。

  // プロキシ
  if (container.proxy?.server) {
    // プロキシBANチェック
    if (isProxyBanned(container.proxy.server)) {
      const banInfo = proxyBanMap.get(extractProxyHostPort(container.proxy.server));
      proxyLog.error(`[proxy-check] Container ${container.id} uses BANNED proxy: ${banInfo?.reason || 'unknown'}`);
      // BANされていても続行（ユーザーに警告のみ）
    }

    // Store credentials for use in onBeforeSendHeaders (案B)
    const proxyUsername = container.proxy.username;
    const proxyPassword = container.proxy.password;
    
    // Normalize proxy server format for Electron
    // Electron expects format like "http=host:port;https=host:port" or "socks5=host:port" or just "host:port"
    // NOTE: Electron's setProxy does NOT support embedded credentials in URL format
    // We must use plain host:port and rely on the login event for authentication
    let proxyRules = container.proxy.server;
    const originalProxyServer = proxyRules;
    
    // Check if proxy is SOCKS5
    const isSocks5 = /socks5/i.test(proxyRules);
    
    // Extract host:port from proxyRules if it contains = or ://
    let hostPort = proxyRules;
    if (proxyRules.includes('=')) {
      // Extract from http=host:port or https=host:port or socks5=host:port
      const match = proxyRules.match(/(?:https?|socks5)=([^;]+)/i);
      if (match) {
        hostPort = match[1].trim();
        // Remove any embedded credentials (username:password@host:port -> host:port)
        hostPort = hostPort.replace(/^[^@]+@/, '');
      }
    } else if (proxyRules.includes('://')) {
      // Extract from http://host:port or socks5://host:port
      hostPort = proxyRules.replace(/^[^:]+:\/\//, '');
      // Remove any embedded credentials
      hostPort = hostPort.replace(/^[^@]+@/, '');
    } else {
      // Already in host:port format, but may contain embedded credentials
      hostPort = proxyRules.replace(/^[^@]+@/, '');
    }
    
    // Build proxy rules: preserve SOCKS5, otherwise use http/https
    if (isSocks5) {
      proxyRules = `socks5=${hostPort}`;
    } else if (!proxyRules.includes('=') && !proxyRules.includes('://')) {
      proxyRules = `http=${hostPort};https=${hostPort}`;
    } else {
      // Rebuild proxy rules with clean host:port
      proxyRules = `http=${hostPort};https=${hostPort}`;
    }
    
    
    try {
      // 既存のプロキシ接続をクリア（接続プール対策）
      try {
        ses.closeAllConnections();
        proxyLog.log(`[proxy-warmup] Closed all existing connections for container ${container.id}`);
      } catch (e) {
        // closeAllConnectionsのエラーは無視
      }
      
      // Proxy認証情報をpartition -> credentials Mapに登録（app.on('login')で使用）
      // また、host:portキーでも登録（warmup前に確実に登録して、warmup中にloginイベントが発火した際に引けるようにする）
      if (container.proxy?.username && container.proxy?.password) {
        proxyCredentialsByPartition.set(part, {
          username: container.proxy.username,
          password: container.proxy.password
        });
        
        // host:portキーでも登録（warmup中にloginイベントが発火した際に確実に引けるように最優先で登録）
        if (container.proxy.server) {
          const hostPort = extractProxyHostPort(container.proxy.server);
          if (hostPort) {
            proxyCredentialsByHostPort.set(hostPort, {
              username: container.proxy.username,
              password: container.proxy.password
            });
            proxyLog.log(`[proxy-warmup] Registered proxy credentials for host:port lookup (before warmup)`, {
              containerId: container.id,
              hostPort,
              partition: part
            });
          }
        }
      }
      
      // proxyBypassRulesを設定してローカル通信をバイパス
      await ses.setProxy({ 
        proxyRules,
        proxyBypassRules: 'localhost,127.0.0.1,<local>'
      });
      
      // forceReloadProxyConfig() を呼び出してプロキシ設定を強制リロード
      try {
        await ses.forceReloadProxyConfig();
        proxyLog.log(`[proxy-warmup] forceReloadProxyConfig completed for container ${container.id}`);
      } catch (e) {
        // forceReloadProxyConfigのエラーは無視（未実装の場合もある）
      }

      // Proxy Healthcheck（DEBUG_PROXY_CHECK=1 の時だけ実行）
      const DEBUG_PROXY_CHECK = process.env.DEBUG_PROXY_CHECK === '1';
      if (DEBUG_PROXY_CHECK && container.proxy?.server) {
        (ses as any).__proxyHealthcheckPending = true;
        (ses as any).__proxyHealthcheckContainerId = container.id;
        (ses as any).__proxyHealthcheckProxyServer = container.proxy.server;
      }
      
      // 出口IP情報を取得（1回だけ、プロキシ認証完了後に実行）
      // webRequest.onCompleted で最初の成功したリクエストを検知してから実行
    } catch (e) {
      // ses.setProxy失敗などは従来通りログのみ（warmup失敗は上記でフラグ管理しているためthrowしない）
      console.error('[main] failed to set proxy for container', container.id, e);
    }
  } else {
    await ses.setProxy({ mode: 'system' });
  }

  // Proxy認証情報の登録は既にwarmup前に完了している（重複登録を避ける）

  // Accept-Language を上書き + Proxy-Authorization ヘッダーを追加（段階的に撤去予定）
  // webRequest ハンドラの多重登録を防ぐ
  if (!(ses as any).__hooksInstalled) {
    (ses as any).__hooksInstalled = true;
    
    try {
      const acceptLang = container.fingerprint?.acceptLanguage || 'ja,en-US;q=0.8,en;q=0.7';
      // Proxy-Authorization ヘッダー注入はデフォルトOFF（フラグで切替可能）
      const ENABLE_PROXY_AUTH_HEADER_INJECTION = false;
      
      ses.webRequest.onBeforeSendHeaders((details, cb) => {
        const headers = { ...details.requestHeaders, 'Accept-Language': acceptLang } as any;

        // zstd互換性オプション: DISABLE_ZSTD=1 のときだけ zstd を削除（切り分け用）
        const DISABLE_ZSTD = process.env.DISABLE_ZSTD === '1';
        if (DISABLE_ZSTD && headers['Accept-Encoding']) {
          const acceptEncoding = headers['Accept-Encoding'];
          if (typeof acceptEncoding === 'string' && acceptEncoding.includes('zstd')) {
            // zstd を削除（gzip, deflate, br のみに）
            headers['Accept-Encoding'] = acceptEncoding
              .split(',')
              .map((enc: string) => enc.trim())
              .filter((enc: string) => !enc.toLowerCase().includes('zstd'))
              .join(', ');
          }
        }

        // Proxy-Authorization ヘッダー注入（デフォルトOFF、段階的に撤去予定）
        if (ENABLE_PROXY_AUTH_HEADER_INJECTION
            && (details.url.startsWith('http://') || details.url.startsWith('https://')) 
            && !details.url.startsWith('http://localhost') 
            && !details.url.startsWith('https://localhost')
            && container.proxy?.username 
            && container.proxy?.password) {
          const token = Buffer.from(`${container.proxy.username}:${container.proxy.password}`).toString('base64');
          headers['Proxy-Authorization'] = `Basic ${token}`;
          console.log('[main] added Proxy-Authorization header (injection mode)', {
            url: details.url,
            containerId: container.id,
            hasToken: !!token
          });
        }
      
        // X関連URLの診断ログ: 400エラーが発生する可能性のあるリクエストの詳細ログ
        if (isXRelatedUrl(details.url)) {
          const requestHeaders = details.requestHeaders || {};
          const importantHeaders = {
            'authorization': requestHeaders['authorization'] || requestHeaders['Authorization'],
            'content-type': requestHeaders['content-type'] || requestHeaders['Content-Type'],
            'x-twitter-auth-type': requestHeaders['x-twitter-auth-type'] || requestHeaders['X-Twitter-Auth-Type'],
            'x-twitter-client-language': requestHeaders['x-twitter-client-language'] || requestHeaders['X-Twitter-Client-Language'],
            'x-csrf-token': requestHeaders['x-csrf-token'] || requestHeaders['X-Csrf-Token'],
            'cookie': requestHeaders['cookie'] || requestHeaders['Cookie'] ? '[REDACTED]' : undefined
          };
          // 400エラーが発生する可能性のあるリクエストのみ詳細ログ
          if (details.url.includes('onboarding/task.json') && details.method === 'POST') {
            proxyLog.log('[x-net] beforeSendHeaders (onboarding/task.json POST)', {
              url: details.url,
              method: details.method,
              headers: importantHeaders,
              webContentsId: details.webContentsId ?? null,
              containerId: container.id
            });
          }
        }
      
        cb({ requestHeaders: headers });
      });
      ses.webRequest.onHeadersReceived((details, cb) => {
        cb({});
      });
      // X関連URLの診断ログ: onBeforeRequest
      // onboarding/task.json の400エラー時にレスポンスボディを取得するため filterResponseData を有効化
      ses.webRequest.onBeforeRequest((details, cb) => {
        // warmup失敗時はX系URLへのアクセスを完全ブロック
        const state = warmupState.get(container.id);
        if (state && !state.ok && isXUrl(details.url)) {
          proxyLog.warn(`[warmup-guard] Blocking X URL access (warmup failed): ${details.url}`, {
            containerId: container.id,
            url: details.url,
            method: details.method
          });
          cb({ cancel: true });
          return;
        }
        
        if (isXRelatedUrl(details.url)) {
          // onboarding/task.json のPOSTリクエストのみ詳細ログ（OPTIONSやその他のリクエストは除外）
          if (details.url.includes('onboarding/task.json') && details.method === 'POST') {
            const webContentsId = details.webContentsId ?? null;
            proxyLog.log('[x-net] beforeRequest', {
              url: details.url,
              method: details.method,
              webContentsId,
              containerId: container.id
            });
            // 400エラーのレスポンスボディを取得
            cb({ filterResponseData: true });
            return;
          }
        }
        cb({});
      });
      
      // X関連URLの診断ログ: onCompleted
      // 出口IP情報取得: プロキシ認証完了後の最初の成功したリクエストを検知
      ses.webRequest.onCompleted((details) => {
        // 最初の成功したリクエスト（statusCode 200）を検知してから出口IP情報を取得
        if (container.proxy?.server && !(ses as any).__egressProbed && 
            details.statusCode === 200 && 
            !details.url.startsWith('chrome-extension://') && 
            !details.url.startsWith('devtools://') && 
            !details.url.startsWith('http://localhost') &&
            !details.url.startsWith('ws://localhost')) {
          (ses as any).__egressProbed = true;
          
          // Proxy Healthcheck（DEBUG_PROXY_CHECK=1 の時だけ実行）
          // warmup成功時のみ実行（warmup失敗時は実行しない）
          if ((ses as any).__proxyHealthcheckPending && 
              (ses as any).__proxyHealthcheckContainerId && 
              (ses as any).__proxyHealthcheckProxyServer) {
            const healthCheckContainerId = (ses as any).__proxyHealthcheckContainerId;
            const healthCheckProxyServer = (ses as any).__proxyHealthcheckProxyServer;
            
            // warmupStateをチェック（warmup失敗時は実行しない）
            const state = warmupState.get(healthCheckContainerId);
            if (state && !state.ok) {
              proxyLog.log(`[proxy-check] Skipping healthcheck (warmup failed) for container ${healthCheckContainerId}`);
              (ses as any).__proxyHealthcheckPending = false;
            } else {
              (ses as any).__proxyHealthcheckPending = false;
              
              setTimeout(async () => {
                try {
                  const healthCheck = await checkProxyHealth(ses, healthCheckContainerId, healthCheckProxyServer);
                  // 重大な問題がある場合はプロキシをBAN
                  if (!healthCheck.ok && healthCheck.issues.length > 0) {
                    const criticalIssues = healthCheck.issues.filter((i: string) => 
                      i.includes('ヘッダー漏れ') || i.includes('出口IPが不安定')
                    );
                    if (criticalIssues.length > 0) {
                      banProxy(healthCheckProxyServer, criticalIssues.join('; '));
                    }
                  }
                } catch (e) {
                  // Healthcheckのエラーは無視（診断機能の失敗はコンテナの動作に影響しない）
                }
              }, 1000);
            }
          }
          
          // プロキシ認証が完了したことを確認できたので、出口IP情報を取得
          // エラーが発生しても静かに失敗（エラーダイアログを表示しない）
          const attemptProbe = async (retryCount = 0): Promise<void> => {
            try {
              await probeEgressNetwork(ses, container.id, container.proxy!.server);
            } catch (e: any) {
              const errorMsg = e instanceof Error ? e.message : String(e);
              // ERR_TUNNEL_CONNECTION_FAILED の場合はリトライ（最大3回、5秒間隔）
              if (errorMsg.includes('ERR_TUNNEL_CONNECTION_FAILED') && retryCount < 3) {
                setTimeout(() => {
                  attemptProbe(retryCount + 1).catch(() => {
                    // リトライ時のエラーも静かに無視（未処理の例外を防ぐ）
                  });
                }, 5000);
              }
              // その他のエラーも静かに無視（診断機能の失敗はコンテナの動作に影響しない）
            }
          };
          // 少し待ってから実行（プロキシ認証が確実に完了する時間を確保）
          setTimeout(() => {
            attemptProbe(0).catch(() => {
              // 未処理の例外を防ぐ（エラーダイアログを表示しない）
            });
          }, 1000);
        }
        
        // X関連URLの診断ログ処理
        if (isXRelatedUrl(details.url)) {
          const webContentsId = details.webContentsId ?? null;
          const responseHeaders = details.responseHeaders ? {
            'content-type': details.responseHeaders['content-type'] || details.responseHeaders['Content-Type'],
            'x-response-time': details.responseHeaders['x-response-time'] || details.responseHeaders['X-Response-Time'],
            'x-rate-limit': details.responseHeaders['x-rate-limit'] || details.responseHeaders['X-Rate-Limit'],
            'x-rate-limit-remaining': details.responseHeaders['x-rate-limit-remaining'] || details.responseHeaders['X-Rate-Limit-Remaining']
          } : null;
          
            // エラーの場合は警告ログ + レスポンスボディからエラー情報を抽出 + 回復策を提案
            // 400エラーのみ詳細ログ、それ以外のエラーは簡易ログ
            if (details.statusCode >= 400) {
              if (details.statusCode === 400 && details.url.includes('onboarding/task.json')) {
            let errorInfo: any = null;
            try {
              // filterResponseData が有効な場合、responseBody が details に含まれる
              const responseBody = (details as any).responseBody;
              if (responseBody) {
                let bodyText = '';
                if (Array.isArray(responseBody.data)) {
                  // responseBody.data は Buffer の配列
                  const buffers = responseBody.data.map((b: any) => Buffer.isBuffer(b) ? b : Buffer.from(b));
                  bodyText = Buffer.concat(buffers).toString('utf8');
                } else if (typeof responseBody === 'string') {
                  bodyText = responseBody;
                } else if (Buffer.isBuffer(responseBody)) {
                  bodyText = responseBody.toString('utf8');
                }
                
                if (bodyText) {
                  const bodyJson = JSON.parse(bodyText);
                  // errors/message/code のみ抽出（PIIを避ける）
                  if (bodyJson.errors && Array.isArray(bodyJson.errors)) {
                    errorInfo = {
                      errors: bodyJson.errors.map((err: any) => ({
                        message: err.message,
                        code: err.code
                      }))
                    };
                  } else if (bodyJson.message) {
                    errorInfo = {
                      message: bodyJson.message,
                      code: bodyJson.code
                    };
                  }
                }
              }
            } catch (e) {
              // パースエラーは無視（ログには出さない）
            }
            
                proxyLog.error('[x-net] completed (400 ERROR)', {
                  url: details.url,
                  method: details.method,
                  statusCode: details.statusCode,
                  fromCache: details.fromCache,
                  responseHeaders: details.responseHeaders ? {
                    'content-type': responseHeaders?.['content-type'],
                    'x-response-time': responseHeaders?.['x-response-time'],
                    'x-rate-limit-remaining': responseHeaders?.['x-rate-limit-remaining'],
                    'all-keys': Object.keys(details.responseHeaders)
                  } : null,
                  errorInfo,
                  webContentsId,
                  containerId: container.id
                });

                // プロキシをBANして回復策を提案
                if (container.proxy?.server) {
                  const proxyHostPort = extractProxyHostPort(container.proxy.server);
                  banProxy(container.proxy.server, `Xログイン失敗 (onboarding/task.json 400)`);
                  proxyLog.error(`[x-net] Proxy ${proxyHostPort} has been BANNED due to X login failure. Consider:`, {
                    suggestion1: 'Clear storage for x.com domain and retry',
                    suggestion2: 'Switch to a different proxy',
                    suggestion3: 'Check proxy healthcheck logs (DEBUG_PROXY_CHECK=1)',
                    containerId: container.id
                  });
                }
              } else {
                // 400以外のエラーは簡易ログ
                proxyLog.error('[x-net] completed (ERROR)', {
                  url: details.url,
                  method: details.method,
                  statusCode: details.statusCode,
                  containerId: container.id
                });
              }
            } else {
              // 200成功はログ出力しない（エラーのみ表示）
              // onboarding/task.jsonのPOSTリクエストの200成功のみ簡易ログ（OPTIONSは除外）
              if (details.url.includes('onboarding/task.json') && 
                  details.statusCode === 200 && 
                  details.method === 'POST') {
                proxyLog.log('[x-net] completed (SUCCESS)', {
                  url: details.url,
                  method: details.method,
                  statusCode: details.statusCode,
                  containerId: container.id
                });
              }
            }
        }
      });
      
      // X関連URLの診断ログ: onErrorOccurred
      ses.webRequest.onErrorOccurred((details) => {
        if (isXRelatedUrl(details.url)) {
          const webContentsId = details.webContentsId ?? null;
          proxyLog.error('[x-net] failed', {
            url: details.url,
            method: details.method,
            error: details.error,
            webContentsId,
            containerId: container.id
          });
        } else if (details.url && !details.url.startsWith('chrome-extension://') && !details.url.startsWith('devtools://')) {
          console.error('[main] webRequest onErrorOccurred', {
            url: details.url,
            error: details.error,
            containerId: container.id,
            hasProxy: !!container.proxy?.server
          });
        }
      });
    } catch (e) {
      console.error('[main] error setting up webRequest hooks', e);
    }
  }

  const shellPreloadPath = path.join(app.getAppPath(), 'out', 'preload', 'mainPreload.cjs');
  console.log('[main] shell preload:', shellPreloadPath, 'exists=', existsSync(shellPreloadPath));

  const w = container.fingerprint?.viewportWidth || 1280;
  const h = container.fingerprint?.viewportHeight || 800;
  const win = new BrowserWindow({
    width: w,
    height: h + BAR_HEIGHT, // アドレスバー分
    webPreferences: {
      partition: part,
      contextIsolation: true,
      nodeIntegration: false,
      preload: shellPreloadPath,
      backgroundThrottling: false // バックグラウンドでも読み込みを継続
    }
  });
  
  // WebRTC非プロキシUDP禁止を確実に適用（BrowserWindow生成直後、loadURLより前）
  try {
    win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    console.log('[main] setWebRTCIPHandlingPolicy applied for container', container.id);
  } catch (e) {
    console.error('[main] failed to setWebRTCIPHandlingPolicy', e);
  }
  
  // Set containerId on shell window's webContents for app.on('login') handler
  try {
    (win.webContents as any)._containerId = container.id;
  } catch (e) {
    console.error('[main] failed to set containerId on shell webContents', e);
  }
  
  // GPU診断ログ（DEBUG_GPU=1 の時のみ）
  if (process.env.DEBUG_GPU === '1') {
    try {
      console.log('[gpu] container created', {
        containerId: container.id,
        webContentsId: win.webContents.id,
        partition: part
      });
    } catch (e) {
      // ログ取得エラーは無視
    }
  }
  
  // set window icon if available
  try {
    const ico = path.join(app.getAppPath(), 'build-resources', 'Icon.ico');
    if (existsSync(ico)) win.setIcon(ico as any);
  } catch (e) { console.error('[main] set container window icon error', e); }
  // mark this window as a container shell so main can detect and close it reliably
  try { (win as any).__isContainerShell = true; (win as any).__containerId = container.id; } catch {}
  // Set containerId on shell window's webContents for app.on('login') handler
  try {
    (win.webContents as any)._containerId = container.id;
  } catch (e) {
    console.error('[main] failed to set containerId on shell webContents', e);
  }
  // hide menu bar for the container shell window (remove File/Edit menus)
  try { win.removeMenu(); win.setAutoHideMenuBar(true); } catch {}

  // 開発時デバッグ: DevTools の自動オープンを無効化。
  // 開発中は F12 押下で開くように renderer -> preload -> main で toggle を提供する。

  // セッションIDを新規採番（この起動単位）
  const sessionId = randomUUID();
  // Read previous lastSessionId from DB before we update it for the new session
  let prevLastSessionId: string | null = null;
  try { const curCont = DB.getContainer(container.id); if (curCont) prevLastSessionId = curCont.lastSessionId ?? null; } catch (e) { console.error('[main] failed to read prevLastSessionId', e); }
  DB.recordSession(sessionId, container.id, Date.now());

  // UA固定（必要に応じて）
  if (container.userAgent) win.webContents.userAgent = container.userAgent;

  // NOTE: Avoid recording navigations triggered by the shell window itself
  // (e.g. containerShell.html or dev server). Record tabs only from BrowserView
  // navigations below. Still keep light logging for debugging.
  win.webContents.on('did-navigate', (_e, url) => {
    try { console.log('[main] shell did-navigate (ignored for tabs) url=', url); } catch {}
  });
  win.webContents.on('page-title-updated', (_e, title) => {
    try { console.log('[main] shell title-updated (ignored for tabs) title=', title); } catch {}
  });
  win.webContents.on('page-favicon-updated', (_e, favs) => {
    try { console.log('[main] shell favicon-updated (ignored for tabs) favs=', favs); } catch {}
  });

  win.on('closed', () => DB.closeSession(sessionId, Date.now()));

  // ページへコンテキスト（containerId/sessionId/fingerprint/currentUrl/tabs）を通知
  const sendCtx = () => {
    try {
      const entry = openedById.get(container.id);
      const containerRecord = DB.getContainer(container.id) || { name: undefined };
      const containerName = containerRecord.name ?? container.name ?? '';
      const tabs = entry ? entry.views.map(v => ({ url: v.webContents.getURL(), title: v.webContents.getTitle?.() })) : [];
      const activeIndex = entry ? entry.activeIndex : 0;
      const activeView = entry ? (entry.views[activeIndex] || entry.views[0]) : null;
      const currentUrl = activeView ? activeView.webContents.getURL() : undefined;
      console.log('[main] sendCtx', { containerId: container.id, sessionId, currentUrl, tabsLength: tabs.length, activeIndex, containerName });
      try { win.setTitle(containerName || 'コンテナシェル'); } catch {}
      win.webContents.send('container.context', { containerId: container.id, sessionId, fingerprint: container.fingerprint, currentUrl, tabs, activeIndex, containerName });
    } catch {}
  };
  win.webContents.on('did-finish-load', sendCtx);

  // BrowserView を作成（実ページ）
  const viewPreloadPath = path.join(app.getAppPath(), 'out', 'preload', 'containerPreload.cjs');
  const createView = (u: string) => {
    const v = new BrowserView({ webPreferences: { partition: part, contextIsolation: true, nodeIntegration: false, preload: viewPreloadPath, backgroundThrottling: false } });
    
    // WebRTC非プロキシUDP禁止を確実に適用
    try {
      v.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    } catch (e) {
      console.error('[main] failed to setWebRTCIPHandlingPolicy on view', e);
    }
    
    // Set containerId on view's webContents for app.on('login') handler
    try {
      (v.webContents as any)._containerId = container.id;
    } catch (e) {
      console.error('[main] failed to set containerId on view webContents', e);
    }
    
    // GPU診断ログ（DEBUG_GPU=1 の時のみ、BrowserView作成時）
    if (process.env.DEBUG_GPU === '1') {
      try {
        console.log('[gpu] browserView created', {
          containerId: container.id,
          webContentsId: v.webContents.id,
          partition: part
        });
      } catch (e) {
        // ログ取得エラーは無視
      }
    }
    
    const layoutView = () => {
      const [w, h] = win.getContentSize();
      const bar = BAR_HEIGHT;
      v.setBounds({ x: 0, y: bar, width: w, height: Math.max(0, h - bar) });
    };
    win.on('resize', layoutView);
    layoutView();
    const scale = container.fingerprint?.deviceScaleFactor || 1.0;
    try { v.webContents.setZoomFactor(scale); } catch {}

    // Forward navigation/title/favicon events from the BrowserView to the shell window
    try {
      v.webContents.on('did-navigate', (_e, url) => {
        try {
          const entry = openedById.get(container.id);
          const tabIndex = entry ? entry.views.indexOf(v) : (v as any).__tabIndex ?? null;
          console.log('[main] view did-navigate url=', url, 'containerId=', container.id, 'sessionId=', sessionId, 'tabIndex=', tabIndex, 'isRestoring=', isRestoringGlobal);
          if (!isRestoringGlobal) {
            DB.addOrUpdateTab({ containerId: container.id, sessionId, url, tabIndex, updatedAt: Date.now() });
          }
        } catch (e) { console.error('[main] DB.addOrUpdateTab error', e); }
        try {
          const entry = openedById.get(container.id);
          if (entry) {
            const tabs = entry.views.map(vv => ({ url: vv.webContents.getURL(), title: vv.webContents.getTitle?.() }));
            win.webContents.send('container.context', { containerId: container.id, sessionId, fingerprint: container.fingerprint, currentUrl: url, tabs });
          }
        } catch (e) { console.error('[main] sendCtx from view did-navigate error', e); }
      });
      v.webContents.on('did-finish-load', () => {
        try {
          const entry = openedById.get(container.id);
          const tabIndex = entry ? entry.views.indexOf(v) : (v as any).__tabIndex ?? null;
          const url = v.webContents.getURL();
          console.log('[main] view did-finish-load url=', url, 'containerId=', container.id, 'sessionId=', sessionId, 'tabIndex=', tabIndex);
        } catch (e) { console.error('[main] did-finish-load handler error', e); }
      });
      v.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
        try {
          const entry = openedById.get(container.id);
          const tabIndex = entry ? entry.views.indexOf(v) : (v as any).__tabIndex ?? null;
          const isXUrl = isXRelatedUrl(validatedURL);
          const logData = {
            url: validatedURL,
            errorCode,
            errorDescription,
            isMainFrame,
            containerId: container.id,
            sessionId,
            tabIndex,
            webContentsId: v.webContents.id,
            proxy: container.proxy ? { server: container.proxy.server, hasUsername: !!container.proxy.username, hasPassword: !!container.proxy.password } : null
          };
          if (isXUrl) {
            proxyLog.error('[x-net] did-fail-load', logData);
          } else {
            console.error('[main] view did-fail-load', logData);
          }
        } catch (e) { console.error('[main] did-fail-load handler error', e); }
      });
      // render-process-gone イベント（X関連URLの場合のみログ）
      v.webContents.on('render-process-gone', (_e, details) => {
        try {
          const entry = openedById.get(container.id);
          const tabIndex = entry ? entry.views.indexOf(v) : (v as any).__tabIndex ?? null;
          const currentUrl = v.webContents.getURL();
          const isXUrl = isXRelatedUrl(currentUrl);
          if (isXUrl) {
            proxyLog.error('[x-net] render-process-gone', {
              url: currentUrl,
              reason: details.reason,
              exitCode: details.exitCode,
              containerId: container.id,
              sessionId,
              tabIndex,
              webContentsId: v.webContents.id
            });
          }
        } catch (e) { console.error('[main] render-process-gone handler error', e); }
      });
      v.webContents.on('page-title-updated', (_e, title) => {
        try {
          const entry = openedById.get(container.id);
          const tabIndex = entry ? entry.views.indexOf(v) : (v as any).__tabIndex ?? null;
          console.log('[main] view title-updated title=', title, 'containerId=', container.id, 'sessionId=', sessionId, 'tabIndex=', tabIndex);
          DB.addOrUpdateTab({ containerId: container.id, sessionId, url: v.webContents.getURL(), tabIndex, title, updatedAt: Date.now() });
        } catch (e) { console.error('[main] DB.addOrUpdateTab title error', e); }
        try {
          const entry = openedById.get(container.id);
          if (entry) {
            const tabs = entry.views.map(vv => ({ url: vv.webContents.getURL(), title: vv.webContents.getTitle?.() }));
            win.webContents.send('container.context', { containerId: container.id, sessionId, fingerprint: container.fingerprint, currentUrl: v.webContents.getURL(), tabs });
          }
        } catch (e) { console.error('[main] sendCtx from view title-updated error', e); }
      });
      v.webContents.on('page-favicon-updated', (_e, favs) => {
        try {
          const entry = openedById.get(container.id);
          const tabIndex = entry ? entry.views.indexOf(v) : (v as any).__tabIndex ?? null;
          console.log('[main] view favicon-updated fav=', favs && favs[0], 'containerId=', container.id, 'sessionId=', sessionId, 'tabIndex=', tabIndex);
          DB.addOrUpdateTab({ containerId: container.id, sessionId, url: v.webContents.getURL(), tabIndex, favicon: favs[0], updatedAt: Date.now() });
        } catch (e) { console.error('[main] DB.addOrUpdateTab favicon error', e); }
        try {
          const entry = openedById.get(container.id);
          if (entry) {
            const tabs = entry.views.map(vv => ({ url: vv.webContents.getURL(), title: vv.webContents.getTitle?.() }));
            win.webContents.send('container.context', { containerId: container.id, sessionId, fingerprint: container.fingerprint, currentUrl: v.webContents.getURL(), tabs });
          }
        } catch (e) { console.error('[main] sendCtx from view favicon-updated error', e); }
      });
      // When DevTools is opened/closed for this view, update the tab title/icon to make it clear
      try {
        v.webContents.on('devtools-opened', () => {
          try {
            const entry = openedById.get(container.id);
            const tabIndex = entry ? entry.views.indexOf(v) : (v as any).__tabIndex ?? 0;
            const containerRecord = DB.getContainer(container.id) || { name: undefined };
            const containerName = containerRecord.name ?? container.name ?? '';
            DB.addOrUpdateTab({ containerId: container.id, sessionId, url: v.webContents.getURL(), tabIndex, title: `Dev-${containerName}`, favicon: '/favicon.ico', scrollY: 0, updatedAt: Date.now() });
            const ctx = getContextForWindow(win);
            if (ctx) win.webContents.send('container.context', ctx);
            try { win.webContents.send('container.devtoolsChanged', { containerId: container.id, tabIndex, isOpen: true, containerName }); } catch (e) { /* ignore */ }
          } catch (e) { console.error('[main] devtools-opened handler error', e); }
        });
        v.webContents.on('devtools-closed', () => {
          try {
            const entry = openedById.get(container.id);
            const tabIndex = entry ? entry.views.indexOf(v) : (v as any).__tabIndex ?? 0;
            // restore title from page when devtools closed
            const title = v.webContents.getTitle?.() ?? null;
            DB.addOrUpdateTab({ containerId: container.id, sessionId, url: v.webContents.getURL(), tabIndex, title, favicon: null, scrollY: 0, updatedAt: Date.now() });
            const ctx = getContextForWindow(win);
            if (ctx) win.webContents.send('container.context', ctx);
            try { win.webContents.send('container.devtoolsChanged', { containerId: container.id, tabIndex, isOpen: false, containerName: containerRecord.name ?? container.name ?? '' }); } catch (e) { /* ignore */ }
          } catch (e) { console.error('[main] devtools-closed handler error', e); }
        });
      } catch (e) { /* ignore if devtools events unsupported */ }
    } catch (e) { console.error('[main] createView attach handlers error', e); }

    if (u) v.webContents.loadURL(u).catch(()=>{});
    // initialize tabIndex placeholder - will be assigned when view is added to entry.views
    try { (v as any).__tabIndex = null; } catch {}
    return v;
  };

  // Always create firstView with about:blank to avoid loading URL before proxy/fingerprint setup
  const firstView = createView('about:blank');
  win.setBrowserView(firstView);
  const entry: OpenedContainer = { win, views: [firstView], activeIndex: 0, sessionId };
  openedById.set(container.id, entry);
  // 初期タブ情報をシェルに送る
  try { console.log('[main] initial sendCtx for', container.id); sendCtx(); } catch {}
  // Ensure there are at least three BrowserViews so renderer tab indices match,
  // unless singleTab option requested.
  try {
    if (!opts.singleTab) {
      while (entry.views.length < 3) {
        const vNew = createView('about:blank');
        entry.views.push(vNew);
      }
    }
    // assign tabIndex values according to array index
    entry.views.forEach((vv, i) => { try { (vv as any).__tabIndex = i; } catch {} });
    // do not set additional views as visible; keep firstView shown
    // send updated context so renderer sees at least three tabs
    try {
      const ctx = getContextForWindow(win);
      if (ctx) win.webContents.send('container.context', ctx);
    } catch {}
  } catch (e) { console.error('[main] ensure three views error', e); }
  win.on('closed', () => { openedById.delete(container.id); DB.closeSession(sessionId, Date.now()); });

  // startUrlをロード
  if (startUrl) {
    try { 
      // ナビゲーション完了を待機する（API呼び出し時にURLが正しく返るようにするため）
      const navPromise = waitForNavigationComplete(firstView.webContents, 30000); // 30秒タイムアウト
      await firstView.webContents.loadURL(startUrl);
      await navPromise;
      console.log('[main] startUrl navigation completed', { containerId: container.id, startUrl, finalUrl: firstView.webContents.getURL() });
    } catch (e) { 
      console.error('[main] load startUrl error', e, { containerId: container.id, startUrl, currentUrl: firstView.webContents.getURL() }); 
    }
  }

  // 復元ロジック（2タブのみ復元）
  const shouldRestore = opts.restore ?? true;
  let restoreUrls: string[] = [];
  if (!startUrl && shouldRestore && prevLastSessionId) {
    try {
      console.log('[main] attempting restore from prevLastSessionId=', prevLastSessionId);
      const prevTabs = DB.tabsOfSession(prevLastSessionId) || [];
      // Filter out shell/renderer URLs (containerShell.html, file://, dev server) and keep only http(s) URLs
      const candidates = (prevTabs || [])
        .map((t:any) => (t && t.url) ? String(t.url) : '')
        .filter((u:string) => !!u && /^https?:\/\//i.test(u));
      if (candidates.length > 0) {
        restoreUrls = candidates.slice(0, 3);
        // attempt to ensure at least the first two are different when possible
        if (restoreUrls.length >= 2 && restoreUrls[0] === restoreUrls[1]) {
          const altCandidates = (prevTabs || []).map((t:any)=> (t && t.url) ? String(t.url) : '').filter((u:string)=> !!u && /^https?:\/\//i.test(u));
          const alt = altCandidates.find((u:string) => u !== restoreUrls[0]);
          if (alt) restoreUrls[1] = alt;
        }
      }
    } catch (e) { console.error('[main] restore tabs error', e); }
  }
  const firstTarget = startUrl || (restoreUrls[0] ?? 'about:blank');
  const secondTarget = restoreUrls[1] ?? 'about:blank';
  const thirdTarget = restoreUrls[2] ?? 'about:blank';

  // シェルUI（簡易アドレスバー付き）
  // During development, prefer the renderer dev server so UI changes are hot-reloaded.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  const shellHtml = devUrl ? `${devUrl.replace(/\/\/$/, '')}/containerShell.html` : new URL('file://' + path.join(app.getAppPath(), 'out', 'renderer', 'containerShell.html')).toString();
  await win.loadURL(shellHtml);
  // load restored URLs into the two views (firstView and second view if present).
  // If singleTab option is set, only load the first target.
  // Skip restore if startUrl is explicitly provided (to avoid double navigation)
  if (restoreUrls.length > 0 && !startUrl) {
    try {
      isRestoringGlobal = true;
      console.log('[main] starting restore load: firstTarget=', firstTarget, 'secondTarget=', secondTarget);
      // ensure tabIndex assignment
      entry.views.forEach((vv, i) => { try { (vv as any).__tabIndex = i; } catch {} });
      // load sequentially and wait finish
      try { await firstView.webContents.loadURL(firstTarget); } catch (e) { console.error('[main] load firstTarget error', e); }
      if (!opts.singleTab) {
        if (entry.views[1]) {
          try { await entry.views[1].webContents.loadURL(secondTarget); } catch (e) { console.error('[main] load secondTarget error', e); }
        }
        if (entry.views[2]) {
          try { await entry.views[2].webContents.loadURL(thirdTarget); } catch (e) { console.error('[main] load thirdTarget error', e); }
        }
      }
      // after loads, write canonical entries into DB with tabIndex
      try {
        const ctxTabs = entry.views.map((vv:any, i:number) => ({ url: vv.webContents.getURL(), tabIndex: i, title: vv.webContents.getTitle?.(), favicon: vv.webContents.getURL && undefined }));
        console.log('[main] restore finished, writing canonical tabs to DB:', ctxTabs);
        for (const t of ctxTabs) {
          try { DB.addOrUpdateTab({ containerId: container.id, sessionId, url: t.url, tabIndex: t.tabIndex, title: t.title ?? null, favicon: null, scrollY: 0, updatedAt: Date.now() }); } catch (e) { console.error('[main] addOrUpdateTab restore write error', e); }
        }
      } catch (e) { console.error('[main] restore db write error', e); }
    } finally { isRestoringGlobal = false; }
  }
  win.show();

  return win;
}

export function closeAllContainers() {
  try {
    console.log('[main] closeAllContainers: closing', openedById.size, 'containers');
    for (const entry of openedById.values()) {
      try { entry.win.close(); } catch {}
    }
    openedById.clear();
  } catch {}
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
          try { w.close(); } catch {}
        }
      } catch (e) { console.error('[main] closeAllNonMainWindows error', e); }
    }
  } catch {}
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
          try { w.destroy(); } catch {}
        }
      } catch {}
    }
  } catch {}
}

export function getContextForWindow(win: BrowserWindow) {
  for (const [containerId, entry] of openedById.entries()) {
    if (entry.win === win) {
      const containerRecord = DB.getContainer(containerId) || { name: undefined };
      const containerName = containerRecord.name ?? '';
      // helper: treat devtools pages as Dev tabs
      const isDevtoolsUrl = (u: string) => {
        if (!u) return false;
        try {
          // common indicators for devtools pages
          return u.startsWith('devtools://') || u.includes('chrome-devtools') || u.includes('devtools') || u.includes('about:blank') && u.includes('devtools');
        } catch { return false; }
      };
      const tabs = entry.views.map(v => {
        const url = v.webContents.getURL();
        let title = v.webContents.getTitle?.() ?? null;
        let favicon: string | null = null;
        try {
          // If this view currently has DevTools opened, force Dev-<containerName>
          if (typeof v.webContents.isDevToolsOpened === 'function' && v.webContents.isDevToolsOpened()) {
            title = `Dev-${containerName}`;
            favicon = '/favicon.ico';
            return { url, title, favicon };
          }
        } catch {}
        if (isDevtoolsUrl(String(url))) {
          title = `Dev-${containerName}`;
          // use common favicon served by renderer (dev server provides /favicon.ico)
          favicon = '/favicon.ico';
        }
        return { url, title, favicon };
      });
      const activeView = entry.views[entry.activeIndex] || entry.views[0];
      const currentUrl = activeView ? activeView.webContents.getURL() : undefined;
      try { entry.win.setTitle(containerName || 'コンテナシェル'); } catch {}
      return { containerId, sessionId: entry.sessionId, fingerprint: containerRecord.fingerprint, currentUrl, tabs, containerName };
    }
  }
  return null;
}

export function createTab(containerId: string, url: string) {
  console.log('[main] createTab request', { containerId, url, openedByIdSize: openedById.size });
  const entry = openedById.get(containerId);
  if (!entry) {
    console.warn('[main] createTab called but no opened entry for containerId=', containerId);
    console.warn('[main] openedById keys=', Array.from(openedById.keys()));
    return false;
  }
  const { win } = entry;
  const viewPreloadPath = path.join(app.getAppPath(), 'out', 'preload', 'containerPreload.cjs');
  const v = new BrowserView({ webPreferences: { partition: entry.win.webContents.getWebPreferences().partition as any, contextIsolation: true, nodeIntegration: false, preload: viewPreloadPath, backgroundThrottling: false } });
  
  // WebRTC非プロキシUDP禁止を確実に適用
  try {
    v.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  } catch (e) {
    console.error('[main] failed to setWebRTCIPHandlingPolicy on createTab view', e);
  }
  
  // Set containerId on view's webContents for app.on('login') handler
  try {
    (v.webContents as any)._containerId = containerId;
  } catch (e) {
    console.error('[main] failed to set containerId on createTab view webContents', e);
  }
  
  const layoutView = () => {
    const [w, h] = win.getContentSize();
    const bar = BAR_HEIGHT; // use global BAR_HEIGHT so views align with shell UI
    v.setBounds({ x: 0, y: bar, width: w, height: Math.max(0, h - bar) });
  };
  win.on('resize', layoutView);
  layoutView();
  v.webContents.loadURL(url || 'about:blank').catch(()=>{});
  // record tab in DB under current session
  try { DB.addOrUpdateTab({ containerId, sessionId: entry.sessionId, url: url || 'about:blank', title: null, favicon: null, scrollY: 0, updatedAt: Date.now() }); } catch {}
  entry.views.push(v);
  entry.activeIndex = entry.views.length - 1;
  win.setBrowserView(v);
  try { entry.win.focus(); try { v.webContents.focus(); } catch {} } catch {}
  // タブ変更をシェルへ通知
  try {
    const tabs = entry.views.map(v => ({ url: v.webContents.getURL(), title: v.webContents.getTitle?.() }));
    console.log('[main] createTab sendCtx', { containerId, sessionId: entry.sessionId, url: v.webContents.getURL(), tabsLength: tabs.length });
    win.webContents.send('container.context', { containerId, sessionId: entry.sessionId, fingerprint: container.fingerprint, currentUrl: v.webContents.getURL(), tabs });
  } catch {}
  return true;
}

export function switchTab(containerId: string, index: number) {
  const entry = openedById.get(containerId);
  if (!entry) return false;
  if (index < 0 || index >= entry.views.length) return false;
  const v = entry.views[index];
  entry.activeIndex = index;
  try { entry.win.setBrowserView(v); try { entry.win.focus(); v.webContents.focus(); } catch {} } catch {}
  try {
    // send updated context to shell
    const ctx = getContextForWindow(entry.win);
    if (ctx) entry.win.webContents.send('container.context', ctx);
  } catch {}
  return true;
}

export function closeTab(containerId: string, index: number) {
  const entry = openedById.get(containerId);
  if (!entry) return false;
  console.log('[main] closeTab request', { containerId, index, viewsBefore: entry.views.length });
  if (index < 0 || index >= entry.views.length) return false;
  // log current view urls
  try {
    const urlsBefore = entry.views.map(vv => { try { return vv.webContents.getURL(); } catch { return '<err>'; } });
    console.log('[main] views before close', urlsBefore);
  } catch {}
  // If this is the only view, create a new blank view first so renderer always has a view
  if (entry.views.length === 1) {
    try {
      const container = DB.getContainer(containerId);
      const viewPreloadPath = path.join(app.getAppPath(), 'out', 'preload', 'containerPreload.cjs');
      const vNew = new BrowserView({ webPreferences: { partition: entry.win.webContents.getWebPreferences().partition as any, contextIsolation: true, nodeIntegration: false, preload: viewPreloadPath, backgroundThrottling: false } });
      // WebRTC非プロキシUDP禁止を確実に適用
      try {
        vNew.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      } catch (e) {
        console.error('[main] failed to setWebRTCIPHandlingPolicy on closeTab new view', e);
      }
      const layoutViewNew = () => {
        try {
          const [w, h] = entry.win.getContentSize();
          const bar = BAR_HEIGHT;
          vNew.setBounds({ x: 0, y: bar, width: w, height: Math.max(0, h - bar) });
        } catch {}
      };
      entry.win.on('resize', layoutViewNew);
      layoutViewNew();
      try { vNew.webContents.setZoomFactor(container?.fingerprint?.deviceScaleFactor || 1.0); } catch {}
      vNew.webContents.loadURL('about:blank').catch(()=>{});
      entry.views.push(vNew);
      // set the new view visible before removing the old one
      try { entry.win.setBrowserView(vNew); } catch {}
    } catch (e) { console.error('[main] error creating blank view before close', e); }
  }

  const v = entry.views[index];
  try {
    // switch to another view if possible
    const otherIndex = (index === 0) ? 1 : 0;
    if (entry.views.length > 1 && entry.views[otherIndex]) {
      try { entry.win.setBrowserView(entry.views[otherIndex]); } catch {}
    }
    console.log('[main] removing view at index', index);
    try { entry.win.removeBrowserView(v); } catch (e) { console.error('[main] removeBrowserView error', e); }
    try { v.webContents.destroy(); } catch (e) { console.error('[main] destroy view error', e); }
  } catch (e) { console.error('[main] error removing view', e); }
  entry.views.splice(index, 1);
  if (entry.activeIndex >= entry.views.length) entry.activeIndex = Math.max(0, entry.views.length - 1);
  // prefer to set a valid view if available
  if (entry.views.length > 0) {
    try { entry.win.setBrowserView(entry.views[entry.activeIndex]); } catch {}
  } else {
    try { entry.win.setBrowserView(null as any); } catch {}
  }
  try {
    const urlsAfter = entry.views.map(vv => { try { return vv.webContents.getURL(); } catch { return '<err>'; } });
    console.log('[main] views after close', urlsAfter);
  } catch {}
  // If all tabs closed, create a new blank tab to avoid empty view
  if (entry.views.length === 0) {
    try {
      const container = DB.getContainer(containerId);
      // create a new BrowserView similar to createTab
      const viewPreloadPath = path.join(app.getAppPath(), 'out', 'preload', 'containerPreload.cjs');
      const v2 = new BrowserView({ webPreferences: { partition: entry.win.webContents.getWebPreferences().partition as any, contextIsolation: true, nodeIntegration: false, preload: viewPreloadPath, backgroundThrottling: false } });
      // WebRTC非プロキシUDP禁止を確実に適用
      try {
        v2.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      } catch (e) {
        console.error('[main] failed to setWebRTCIPHandlingPolicy on closeTab blank view', e);
      }
      const layoutView2 = () => {
        try {
          const [w, h] = entry.win.getContentSize();
          const bar = BAR_HEIGHT;
          v2.setBounds({ x: 0, y: bar, width: w, height: Math.max(0, h - bar) });
        } catch {}
      };
      entry.win.on('resize', layoutView2);
      layoutView2();
      try { v2.webContents.setZoomFactor(container?.fingerprint?.deviceScaleFactor || 1.0); } catch {}
      v2.webContents.loadURL('about:blank').catch(()=>{});
      entry.views.push(v2);
      entry.activeIndex = 0;
      entry.win.setBrowserView(v2);
      const ctx = getContextForWindow(entry.win);
      if (ctx) entry.win.webContents.send('container.context', ctx);
    } catch (e) { console.error('[main] error creating blank tab after close', e); }
  }
  else {
    // send updated context when there are still views
    try {
      const ctx = getContextForWindow(entry.win);
      if (ctx) entry.win.webContents.send('container.context', ctx);
    } catch {}
  }
  return true;
}

export function listTabs(sessionId: string) {
  return DB.tabsOfSession(sessionId);
}

export function navigateContainer(containerId: string, url: string) {
  const item = openedById.get(containerId);
  if (!item) return false;
  const view = item.views[item.activeIndex] || item.views[0];
  try { view.webContents.loadURL(url); } catch { return false; }
  return true;
}

ipcMain.handle('container.navigate', (_e, { containerId, url }) => navigateContainer(containerId, url));

export function goBack(containerId: string) {
  const it = openedById.get(containerId);
  if (!it) return false;
  try {
    const view = it.views[it.activeIndex] || it.views[0];
    if (view.webContents.canGoBack()) { view.webContents.goBack(); return true; }
  } catch {}
  return false;
}

export function goForward(containerId: string) {
  const it = openedById.get(containerId);
  if (!it) return false;
  try {
    const view = it.views[it.activeIndex] || it.views[0];
    if (view.webContents.canGoForward()) { view.webContents.goForward(); return true; }
  } catch {}
  return false;
}

// Return the active BrowserView.webContents for a given containerId, or null if not open
export function getActiveWebContents(containerId: string) {
  try {
    const entry = openedById.get(containerId);
    if (!entry) return null;
    const view = entry.views[entry.activeIndex] || entry.views[0];
    return view ? view.webContents : null;
  } catch (e) { return null; }
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

ipcMain.handle('tabs.goBack', (_e, { containerId }) => goBack(containerId));
ipcMain.handle('tabs.goForward', (_e, { containerId }) => goForward(containerId));
