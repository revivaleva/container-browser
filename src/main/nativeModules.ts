import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import logger from '../shared/logger';

const DEFAULT_BASE = 'https://updates.threadsbooster.jp/native-modules/';

async function ensureDir(dir: string) {
  return fs.promises.mkdir(dir, { recursive: true });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest, { flags: 'w' });
    logger.info('[nativeModules] download start', url, '->', dest);
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        logger.info('[nativeModules] download finished', dest);
        resolve();
      });
    });
    req.on('error', (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

export async function ensureNativeModules(): Promise<void> {
  try {
    const base = process.env.NATIVE_MODULES_URL || DEFAULT_BASE;
    const targetDir = path.join(app.isPackaged ? process.resourcesPath : app.getPath('userData'), 'native-modules');
    await ensureDir(targetDir);

    // list of candidate native filenames to ensure; adjust as needed
    const candidates = [
      'better_sqlite3.node',
      'keytar.node',
      'sharp-win32-x64.node'
    ];

    for (const name of candidates) {
      const dest = path.join(targetDir, name);
      if (fs.existsSync(dest)) {
        logger.info('[nativeModules] exists', dest);
        continue;
      }
      const url = (base.endsWith('/') ? base : base + '/') + name;
      try {
        await downloadFile(url, dest);
      } catch (e) {
        logger.warn('[nativeModules] failed to download', url, e?.message ?? e);
      }
    }
  } catch (e) {
    logger.error('[nativeModules] ensure failed', e);
  }
}


