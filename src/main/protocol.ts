import { app } from 'electron';
import path from 'node:path';

export function registerCustomProtocol() {
  const scheme = 'mycontainers';
  try {
    if (process.platform === 'win32') {
      if (process.defaultApp) {
        // 開発時: electron.exe と現在のエントリポイントを渡す
        app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1] ?? '')]);
      } else {
        app.setAsDefaultProtocolClient(scheme);
      }
    } else {
      app.setAsDefaultProtocolClient(scheme);
    }
  } catch {}
}
