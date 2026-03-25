import type { BrowserWindow as BrowserWindowType, BrowserView as BrowserViewType } from 'electron';

export type OpenedContainer = {
    win: BrowserWindowType;
    views: BrowserViewType[];
    activeIndex: number;
    sessionId: string
};

// Container window state
export const openedById = new Map<string, OpenedContainer>();

// Proxy credentials state (moved from index.ts to break circularity)
export const proxyCredentialsByPartition = new Map<string, { username: string; password: string }>();
export const proxyCredentialsByHostPort = new Map<string, { username: string; password: string }>();
