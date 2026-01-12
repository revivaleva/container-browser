// プロキシ関連ログのみを表示するモード（LOG_ONLY_PROXY=1）
const LOG_ONLY_PROXY = process.env.LOG_ONLY_PROXY === '1';

// ログがプロキシ関連かどうかを判定
function isProxyRelatedLog(...args: any[]): boolean {
  if (!LOG_ONLY_PROXY) return true; // フィルタリングしない
  
  // 最初の引数が文字列で、プロキシ関連のプレフィックスを含むかチェック
  const firstArg = args[0];
  if (typeof firstArg === 'string') {
    // プロキシ関連のログプレフィックス
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
    const allArgsForFirst = args.map(a => String(a)).join(' ');
    if (firstArg.includes('[main]') && !/proxy|Proxy|PROXY|setProxy/i.test(allArgsForFirst)) {
      return false;
    }
    return proxyPrefixes.some(prefix => firstArg.includes(prefix));
  }
  
  // 引数の中にプロキシ関連の文字列が含まれるかチェック
  const allArgs = args.map(a => String(a)).join(' ');
  
  // [main]プレフィックスは除外（プロキシ関連でない限り）
  if (/\[main\]/i.test(allArgs) && !/proxy|Proxy|PROXY|setProxy/i.test(allArgs)) {
    return false;
  }
  
  return /\[proxy-check\]|\[x-net\]|\[login\]|proxy|Proxy|PROXY|setProxy|onboarding\/task\.json/i.test(allArgs);
}

export const debug = (...args: any[]) => {
  if (process.env.DEBUG_LOG === '1') {
    if (LOG_ONLY_PROXY && !isProxyRelatedLog(...args)) {
      return; // プロキシ関連以外のログを抑制
    }
    // keep as debug to avoid noise in normal runs
    // eslint-disable-next-line no-console
    console.debug(...args);
  }
};

export const info = (...args: any[]) => {
  if (LOG_ONLY_PROXY && !isProxyRelatedLog(...args)) {
    return; // プロキシ関連以外のログを抑制
  }
  // eslint-disable-next-line no-console
  console.log(...args);
};

export const warn = (...args: any[]) => {
  if (LOG_ONLY_PROXY && !isProxyRelatedLog(...args)) {
    return; // プロキシ関連以外のログを抑制
  }
  // eslint-disable-next-line no-console
  console.warn(...args);
};

export const error = (...args: any[]) => {
  if (LOG_ONLY_PROXY && !isProxyRelatedLog(...args)) {
    return; // プロキシ関連以外のログを抑制
  }
  // eslint-disable-next-line no-console
  console.error(...args);
};

export default { debug, info, warn, error };


