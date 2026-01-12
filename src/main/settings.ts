import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app } from 'electron';

type ExportConfig = {
  enabled: boolean;
  port: number;
};

type AuthConfig = {
  apiBase?: string;  // License Token API endpoint
  timeoutMs?: number;
};

type GraphicsConfig = {
  graphicsMode?: 'auto' | 'disable';  // HWアクセラレーション ON/OFF
  angleMode?: 'default' | 'd3d11' | 'gl' | 'warp';  // ANGLEバックエンド
  disableHttp2?: boolean;  // HTTP/2無効化
  disableQuic?: boolean;  // HTTP/3（QUIC）無効化
  debugGpu?: boolean;  // GPU診断ログ
};

type AppConfig = {
  exportServer?: ExportConfig;
  auth?: AuthConfig;
  graphics?: GraphicsConfig;
};

const DEFAULT: AppConfig = { 
  exportServer: { enabled: false, port: 3001 },
  auth: {
    apiBase: 'https://2y8hntw0r3.execute-api.ap-northeast-1.amazonaws.com/prod',
    timeoutMs: 5000
  },
  graphics: {
    graphicsMode: 'auto',
    angleMode: 'default',
    disableHttp2: false,
    disableQuic: false,
    debugGpu: false
  }
};

export function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

export function loadConfig(): AppConfig {
  try {
    const p = configPath();
    if (!fs.existsSync(p)) return DEFAULT;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw) return DEFAULT;
    const j = JSON.parse(raw);
    return Object.assign({}, DEFAULT, j || {});
  } catch (e) {
    return DEFAULT;
  }
}

export function saveConfig(cfg: AppConfig) {
  try {
    const p = configPath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[settings] saveConfig error', e);
    return false;
  }
}

export function getExportSettings(): ExportConfig {
  const c = loadConfig();
  return c.exportServer || DEFAULT.exportServer!;
}

export function setExportSettings(s: Partial<ExportConfig>) {
  const cur = loadConfig();
  const next: AppConfig = Object.assign({}, cur, { exportServer: Object.assign({}, cur.exportServer || DEFAULT.exportServer, s) });
  return saveConfig(next);
}

export function getAuthSettings(): AuthConfig {
  const c = loadConfig();
  return c.auth || DEFAULT.auth!;
}

export function setAuthSettings(s: Partial<AuthConfig>) {
  const cur = loadConfig();
  const next: AppConfig = Object.assign({}, cur, { auth: Object.assign({}, cur.auth || DEFAULT.auth, s) });
  return saveConfig(next);
}

export function getAuthApiBase(): string {
  // Priority: environment variable > config file > default
  return process.env.AUTH_API_BASE || getAuthSettings().apiBase || DEFAULT.auth?.apiBase || 'https://2y8hntw0r3.execute-api.ap-northeast-1.amazonaws.com/prod';
}

export function getAuthTimeoutMs(): number {
  return Number(process.env.AUTH_API_TIMEOUT_MS || getAuthSettings().timeoutMs || DEFAULT.auth?.timeoutMs || 5000);
}

export function getGraphicsSettings(): GraphicsConfig {
  const c = loadConfig();
  return c.graphics || DEFAULT.graphics!;
}

export function setGraphicsSettings(s: Partial<GraphicsConfig>) {
  const cur = loadConfig();
  const next: AppConfig = Object.assign({}, cur, { graphics: Object.assign({}, cur.graphics || DEFAULT.graphics, s) });
  return saveConfig(next);
}


