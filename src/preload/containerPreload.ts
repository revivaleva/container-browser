import { contextBridge, ipcRenderer } from 'electron';

let CONTEXT: { containerId?: string; sessionId?: string; fingerprint?: any } = {};

ipcRenderer.on('container.context', (_e, ctx) => {
  CONTEXT = ctx || {};
  tryApplyFingerprint();
});

function guessLoginSelectors() {
  const pass = document.querySelector('input[type="password"]') as HTMLInputElement | null;
  if (!pass) return null;
  const candidates = Array.from(document.querySelectorAll('input[type="text"],input[type="email"]')) as HTMLInputElement[];
  const user = candidates.find(i => /user|mail|login|id|account/i.test(i.name || i.id || '')) || candidates[0];
  return { user, pass };
}

async function tryAutoFill() {
  try {
    const origin = location.origin;
    const containerId = CONTEXT.containerId;
    if (!containerId) return;

    // check site prefs first
    const pref = await ipcRenderer.invoke('prefs.get', { containerId, origin });
    if (!pref || pref.autoFill !== 1) return;

    const cred = await ipcRenderer.invoke('vault.getCredential', { containerId, origin });
    if (!cred) return;
    const sel = guessLoginSelectors();
    if (!sel) return;
    if (sel.user) sel.user.value = cred.username;
    sel.pass.value = cred.password;
  } catch {}
}

window.addEventListener('DOMContentLoaded', () => {
  tryAutoFill();
  tryApplyFingerprint();
});

contextBridge.exposeInMainWorld('containerPageAPI', {
  saveCredential: (containerId: string, username: string, password: string) => {
    const origin = location.origin;
    return ipcRenderer.invoke('vault.saveCredential', { containerId, origin, username, password });
  }
});

function defineReadonly(obj: any, key: string, value: any) {
  try {
    Object.defineProperty(obj, key, { get: () => value, configurable: true });
  } catch {}
}

function tryApplyFingerprint() {
  const fp = CONTEXT.fingerprint;
  if (!fp) return;
  try {
    if (fp.platform) defineReadonly(navigator, 'platform', fp.platform);
    if (fp.hardwareConcurrency) defineReadonly(navigator, 'hardwareConcurrency', fp.hardwareConcurrency);
    if (fp.deviceMemory) defineReadonly(navigator as any, 'deviceMemory', fp.deviceMemory);
    if (fp.locale) {
      defineReadonly(navigator, 'language', fp.locale);
      defineReadonly(navigator, 'languages', [fp.locale, 'ja']);
    }
    if (typeof fp.maxTouchPoints === 'number') defineReadonly(navigator, 'maxTouchPoints', fp.maxTouchPoints);
    if (typeof fp.cookieEnabled === 'boolean') defineReadonly(navigator, 'cookieEnabled', fp.cookieEnabled);

    // Network Information (簡易)
    if (fp.connectionType) {
      const conn = { effectiveType: fp.connectionType, downlink: 10 } as any;
      // @ts-ignore
      if ((navigator as any).connection) {
        try { Object.assign((navigator as any).connection, conn); } catch {}
      } else {
        defineReadonly(navigator as any, 'connection', conn);
      }
    }
    // Intl
    if (fp.timezone) {
      const orig = Intl.DateTimeFormat.prototype.resolvedOptions;
      Intl.DateTimeFormat.prototype.resolvedOptions = function(this: any) {
        const o = orig.apply(this);
        return { ...o, timeZone: fp.timezone, locale: fp.locale || o.locale } as any;
      } as any;
    }
    // Screen
    if (fp.colorDepth) defineReadonly(screen, 'colorDepth', fp.colorDepth);
    if (fp.screenWidth) defineReadonly(screen, 'width', fp.screenWidth);
    if (fp.screenHeight) defineReadonly(screen, 'height', fp.screenHeight);
    if (fp.viewportWidth) defineReadonly(window, 'innerWidth', fp.viewportWidth);
    if (fp.viewportHeight) defineReadonly(window, 'innerHeight', fp.viewportHeight);
    if (fp.deviceScaleFactor) defineReadonly(window, 'devicePixelRatio', fp.deviceScaleFactor);

    // Canvas ノイズ（軽量版）
    if (fp.canvasNoise) {
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function(...args: any[]) {
        const ctx = (this.getContext('2d') as any);
        if (ctx && ctx.getImageData) {
          try {
            const { width, height } = this as any;
            const id = ctx.getImageData(0, 0, Math.min(8,width||8), Math.min(8,height||8));
            for (let i = 0; i < id.data.length; i+=4) id.data[i] ^= 1; // 微小変更
            ctx.putImageData(id, 0, 0);
          } catch {}
        }
        return origToDataURL.apply(this, args as any);
      } as any;
    }

    // WebGL Vendor/Renderer を偽装
    if (fp.webglVendor || fp.webglRenderer) {
      const patch = (proto: any) => {
        const origGetParameter = proto.getParameter;
        proto.getParameter = function(param: number) {
          const UNMASKED_VENDOR_WEBGL = 0x9245; // ext.UNMASKED_VENDOR_WEBGL
          const UNMASKED_RENDERER_WEBGL = 0x9246; // ext.UNMASKED_RENDERER_WEBGL
          if (fp.webglVendor && param === UNMASKED_VENDOR_WEBGL) return fp.webglVendor;
          if (fp.webglRenderer && param === UNMASKED_RENDERER_WEBGL) return fp.webglRenderer;
          return origGetParameter.call(this, param);
        };
      };
      try { patch(WebGLRenderingContext.prototype as any); } catch {}
      try { patch(WebGL2RenderingContext.prototype as any); } catch {}
    }

    // Battery API（簡易）
    if (fp.batteryLevel !== undefined || fp.batteryCharging !== undefined) {
      (navigator as any).getBattery = async () => ({
        charging: !!fp.batteryCharging,
        chargingTime: fp.batteryCharging ? 0 : Infinity,
        dischargingTime: fp.batteryCharging ? Infinity : 60*60,
        level: typeof fp.batteryLevel === 'number' ? Math.max(0, Math.min(1, fp.batteryLevel)) : 1,
        onchargingchange: null,
        onlevelchange: null,
        onchargingtimechange: null,
        ondischargingtimechange: null,
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return true; },
      });
    }

    // WebRTC IP masking: replace local IPs in SDP and ICE candidates with fakeIp
    if (fp.fakeIp) {
      try {
        const RTCP = (window as any).RTCPeerConnection || (window as any).webkitRTCPeerConnection;
        if (RTCP) {
          const origCreateOffer = RTCP.prototype.createOffer;
          if (origCreateOffer) {
            RTCP.prototype.createOffer = function(...args: any[]) {
              return origCreateOffer.apply(this, args).then((offer: any) => {
                if (offer && offer.sdp && typeof offer.sdp === 'string') {
                  offer.sdp = offer.sdp.replace(/(\d{1,3}(?:\.\d{1,3}){3})/g, fp.fakeIp);
                }
                return offer;
              });
            };
          }

          const origCreateAnswer = RTCP.prototype.createAnswer;
          if (origCreateAnswer) {
            RTCP.prototype.createAnswer = function(...args: any[]) {
              return origCreateAnswer.apply(this, args).then((ans: any) => {
                if (ans && ans.sdp && typeof ans.sdp === 'string') {
                  ans.sdp = ans.sdp.replace(/(\d{1,3}(?:\.\d{1,3}){3})/g, fp.fakeIp);
                }
                return ans;
              });
            };
          }

          const origSetLocal = RTCP.prototype.setLocalDescription;
          if (origSetLocal) {
            RTCP.prototype.setLocalDescription = function(desc: any, ...rest: any[]) {
              try {
                if (desc && desc.sdp && typeof desc.sdp === 'string') {
                  desc.sdp = desc.sdp.replace(/(\d{1,3}(?:\.\d{1,3}){3})/g, fp.fakeIp);
                }
              } catch {}
              return origSetLocal.apply(this, [desc, ...rest]);
            };
          }

          const origAddEvent = RTCP.prototype.addEventListener;
          if (origAddEvent) {
            RTCP.prototype.addEventListener = function(type: string, listener: any, ...rest: any[]) {
              if (type === 'icecandidate' && typeof listener === 'function') {
                const wrapped = function(ev: any) {
                  try {
                    if (ev && ev.candidate && ev.candidate.candidate && typeof ev.candidate.candidate === 'string') {
                      ev.candidate.candidate = ev.candidate.candidate.replace(/(\d{1,3}(?:\.\d{1,3}){3})/g, fp.fakeIp);
                    }
                  } catch {}
                  return listener.call(this, ev);
                };
                return origAddEvent.apply(this, [type, wrapped, ...rest]);
              }
              return origAddEvent.apply(this, [type, listener, ...rest]);
            };
          }
        }
      } catch {}
    }
  } catch {}
}
