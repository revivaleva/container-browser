import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app } from 'electron';

type ExportConfig = {
  enabled: boolean;
  port: number;
};

type AppConfig = {
  exportServer?: ExportConfig;
};

const DEFAULT: AppConfig = { exportServer: { enabled: false, port: 3001 } };

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


