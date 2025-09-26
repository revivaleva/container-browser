export type ProxyConfig = { server: string; username?: string; password?: string };

export type Fingerprint = {
  acceptLanguage: string; // e.g. 'ja,en-US;q=0.8,en;q=0.7'
  locale: string;         // e.g. 'ja-JP'
  timezone: string;       // e.g. 'Asia/Tokyo'
  platform?: string;      // e.g. 'Win32'
  hardwareConcurrency?: number; // e.g. 4, 8
  deviceMemory?: number;        // in GB (approx)
  webglVendor?: string;
  webglRenderer?: string;
  canvasNoise?: boolean;
  // Screen/Viewport
  screenWidth?: number;   // e.g. 2560
  screenHeight?: number;  // e.g. 1440
  colorDepth?: number;    // e.g. 24
  viewportWidth?: number; // window viewport width
  viewportHeight?: number; // window viewport height
  maxTouchPoints?: number; // e.g. 0 or 1
  deviceScaleFactor?: number; // zoom 1.0 = 100%
  // Networking / privacy
  fakeIp?: string;        // override local IP seen by WebRTC candidates
  // Navigator features
  cookieEnabled?: boolean;
  connectionType?: string; // '4g'|'3g'|'wifi' etc (string to keep simple)
  batteryLevel?: number;   // 0..1
  batteryCharging?: boolean;
};

export type Container = {
  id: string;
  name: string;
  note?: string;
  userDataDir: string;      // プロファイル保存先
  partition: string;        // 'persist:container-<id>'
  userAgent?: string;
  locale?: string;          // 互換: 旧フィールド
  timezone?: string;        // 互換: 旧フィールド
  fingerprint?: Fingerprint; // 新: 指紋設定
  proxy?: ProxyConfig | null;
  createdAt: number;
  updatedAt: number;
  lastSessionId?: string | null;
};

export type CredentialRow = {
  containerId: string;
  origin: string;     // https://example.com
  username: string;
  keytarAccount: string; // key: `${containerId}|${origin}|${username}`
  updatedAt: number;
};

export type SitePref = {
  containerId: string;
  origin: string;
  autoFill: 0|1;
  autoSaveForms: 0|1;
};

export type TabEntry = {
  id?: number;
  containerId: string;
  sessionId: string;
  url: string;
  tabIndex?: number;
  title?: string;
  favicon?: string;
  scrollY?: number;
  updatedAt: number;
};
