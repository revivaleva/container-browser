import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
let keytar: any = null;
try { keytar = require('keytar'); } catch(e) { keytar = null; }

const SERVICE_NAME = 'container-browser-token';
const ACCOUNT_NAME = 'default';

const fallbackFile = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'container-browser', 'token.enc');

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getMasterKey() {
  // derive a local master key from machine id + app name; best-effort fallback
  const seed = (process.env.COMPUTERNAME || os.hostname() || 'local') + '::container-browser';
  return crypto.createHash('sha256').update(seed).digest();
}

export async function saveToken(token: string) {
  if (keytar) {
    try { await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, token); return true; } catch(e) { /* continue to fallback */ }
  }
  try {
    ensureDir(fallbackFile);
    const key = getMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const out = Buffer.concat([iv, tag, enc]);
    fs.writeFileSync(fallbackFile, out);
    return true;
  } catch (e) {
    return false;
  }
}

export async function getToken(): Promise<string | null> {
  if (keytar) {
    try { const t = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME); if (t) return t; } catch(e) { /* fallback */ }
  }
  try {
    if (!fs.existsSync(fallbackFile)) return null;
    const buf = fs.readFileSync(fallbackFile);
    const iv = buf.slice(0,12);
    const tag = buf.slice(12,28);
    const data = buf.slice(28);
    const key = getMasterKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString('utf8');
  } catch(e) {
    return null;
  }
}

export async function clearToken() {
  if (keytar) {
    try { await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME); } catch(e) {}
  }
  try { if (fs.existsSync(fallbackFile)) fs.unlinkSync(fallbackFile); } catch(e) {}
}


