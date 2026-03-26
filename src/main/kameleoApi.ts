import { net } from 'electron';

const KAMELEO_BASE_URL = 'http://localhost:5050';

export interface KameleoProfile {
  id: string;
  name: string;
  device: {
    baseProfileId: string;
    canvas: string;
    webgl: string;
    audio: string;
    fonts: string;
    geolocation: string;
    screen: string;
  };
  browser: {
    product: string;
    majorVersion: number;
    version: string;
  };
  proxy?: {
    type: string;
    host: string;
    port: number;
    username?: string;
    password?: string;
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
          reject(new Error(`Kameleo API error: ${res.statusCode} ${data}`));
        }
      });
    });

    req.on('error', (err) => {
        console.error(`[main] [kameleo] network error: ${err.message} for ${method} ${path}`);
        reject(err);
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

export const KameleoApi = {
  async listProfiles(): Promise<KameleoProfile[]> {
    return request<KameleoProfile[]>('GET', '/profiles');
  },

  async createProfile(options: { 
    name: string, 
    proxy?: { type: string, host: string, port: number, username?: string, password?: string },
    tags?: string[]
  }): Promise<KameleoProfile> {
    // 1. Fetch fingerprints (prefer Windows/Chrome Desktop)
    const fps = await request<any[]>('GET', '/fingerprints?limit=1&deviceType=desktop&os=windows&browser=chrome');
    const fingerprint = (Array.isArray(fps) ? fps[0] : null) || (fps as any).value?.[0];
    
    if (!fingerprint) {
      console.warn('[main] [kameleo] No specific fingerprints found, trying any desktop');
      const anyFps = await request<any[]>('GET', '/fingerprints?limit=1&deviceType=desktop');
      const anyFp = (Array.isArray(anyFps) ? anyFps[0] : null) || (anyFps as any).value?.[0];
      if (!anyFp) throw new Error('No desktop fingerprints found in Kameleo');
      return this.createProfileInternal(anyFp.id, options);
    }

    return this.createProfileInternal(fingerprint.id, options);
  },

  async createProfileInternal(fingerprintId: string, options: any): Promise<KameleoProfile> {
    const body = {
      fingerprintId,
      ...options,
      browser: {
        launcher: 'playwright'
      }
    };
    return request<KameleoProfile>('POST', '/profiles/new', body);
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

  async updateProfile(id: string, options: Partial<KameleoProfile>): Promise<KameleoProfile> {
      return request<KameleoProfile>('PATCH', `/profiles/${id}`, options);
  }
};
