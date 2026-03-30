import { net } from 'electron';

const KAMELEO_BASE_URL = 'http://localhost:5050';

export interface KameleoProfile {
  id: string;
  name: string;
  tags: string[];
  status: string; // 'running' | 'stopped'
  persistence: string; // 'local' | 'cloud'
  isCloud: boolean;
  device: {
    baseProfileId: string;
    platform: string;
    browser: string;
    deviceType: string;
  };
  proxy?: {
    value: string;
    extra: {
      host: string;
      port: number;
      id?: string;
      secret?: string;
    };
  };
}

async function request<T>(method: string, path: string, body?: any): Promise<T> {
  console.log(`[main] [kameleo] request: ${method} ${path}`);
  return new Promise((resolve, reject) => {
    const req = net.request({
      method,
      url: `${KAMELEO_BASE_URL}${path}`,
    });
    req.setHeader('Content-Type', 'application/json');

    req.on('response', (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(data ? JSON.parse(data) : ({} as T));
          } catch (e) {
            resolve({} as T);
          }
        } else {
          console.error(`[main] [kameleo] error response: ${res.statusCode} ${data} for ${method} ${path}`);
          const errorMsg = data ? ` (${data})` : '';
          reject(new Error(`Kameleo API error: ${res.statusCode}${errorMsg}`));
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[main] [kameleo] network error: ${err.message} for ${method} ${path}`);
      reject(err);
    });

    // Add timeout to prevent indefinite hangs
    const timeout = setTimeout(() => {
      try {
        req.abort();
        reject(new Error(`Kameleo API timeout: ${method} ${path} exceeded 10000ms`));
      } catch { }
    }, 10000);

    req.on('close', () => clearTimeout(timeout));

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

export const KameleoApi = {
  async listProfiles(): Promise<KameleoProfile[]> {
    const profiles = await request<any[]>('GET', '/profiles');
    if (!Array.isArray(profiles)) return [];
    return profiles.map(p => ({
      ...p,
      isCloud: p.storage === 'cloud'
    }));
  },

  async getStatus(): Promise<any> {
    return request<any>('GET', '/status');
  },

  async createProfile(options: {
    name: string,
    deviceType?: string,
    os?: string,
    browser?: string,
    proxy?: { value: string, extra: { host: string, port: number, id?: string, secret?: string } },
    tags?: string[],
    storage?: 'local' | 'cloud',
    language?: string,
    allowFallback?: boolean
  }): Promise<KameleoProfile> {

    const deviceType = options.deviceType || 'desktop';
    const os = options.os || 'windows';
    const browser = options.browser || 'chrome';

    // 1. Fetch fingerprints
    const query = `limit=1&deviceType=${deviceType}&os=${os}&browserProduct=${browser}`;
    const fps = await request<any[]>('GET', `/fingerprints?${query}`);
    const fingerprint = (Array.isArray(fps) ? fps[0] : null) || (fps as any).value?.[0];

    if (!fingerprint) {
      if (options.allowFallback) {
        console.warn(`[main] [kameleo] No specific fingerprints found for ${query}, trying any desktop fallback`);
        const anyFps = await request<any[]>('GET', '/fingerprints?limit=1&deviceType=desktop');
        const anyFp = (Array.isArray(anyFps) ? anyFps[0] : null) || (anyFps as any).value?.[0];
        if (!anyFp) throw new Error('No desktop fingerprints found in Kameleo even with fallback');
        return this.createProfileInternal(anyFp.id, options);
      } else {
        throw new Error(`No matching fingerprints found for: ${query}. Fallback disabled.`);
      }
    }

    return this.createProfileInternal(fingerprint.id, options);
  },

  async createProfileInternal(fingerprintId: string, options: any): Promise<KameleoProfile> {
    const pVal = options.persistence || options.storage || 'cloud';
    const body: any = {
      fingerprintId,
      name: options.name,
      proxy: options.proxy,
      tags: options.tags || [],
      storage: pVal, // storage: 'cloud' or 'local'
      browser: {
        launcher: 'playwright'
      }
    };

    // If language is specified, override browser settings
    if (options.language) {
      body.browser.webgl = body.browser.webgl || {};
      body.browser.webgl.webglMetadata = 'mask'; // Ensure masking is on if we touch browser
      body.language = options.language;
    }

    console.log(`[main] [kameleo] POST /profiles/new body:`, JSON.stringify(body, null, 2));
    const result = await request<KameleoProfile>('POST', '/profiles/new', body);

    // Check if result returned successfully and normalize status if it's an object
    if (result && result.id) {
      console.log(`[main] [kameleo] Profile created: ${result.id}`);
    } else {
      console.error(`[main] [kameleo] Profile creation failed? Result:`, JSON.stringify(result));
    }
    return result;
  },

  async startProfile(id: string): Promise<void> {
    await request('POST', `/profiles/${id}/start`);
  },

  async stopProfile(id: string): Promise<void> {
    await request('POST', `/profiles/${id}/stop`);
  },

  async deleteProfile(id: string): Promise<void> {
    await request('DELETE', `/profiles/${id}`);
  },

  async getProfile(id: string): Promise<KameleoProfile> {
    return request<KameleoProfile>('GET', `/profiles/${id}`);
  },

  async updateProfile(id: string, options: any): Promise<KameleoProfile> {

    return request<KameleoProfile>('PATCH', `/profiles/${id}`, options);
  }
};
