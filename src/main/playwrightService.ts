import { chromium, BrowserContext, Page } from 'playwright-core';

const KAMELEO_PLAYWRIGHT_BASE = 'ws://localhost:5050/playwright';

export class PlaywrightService {
    private static contexts = new Map<string, BrowserContext>();

    static async connect(profileId: string): Promise<BrowserContext> {
        if (this.contexts.has(profileId)) {
            const ctx = this.contexts.get(profileId)!;
            // Verify if context is still alive
            try {
                await ctx.pages()[0]?.url();
                return ctx;
            } catch (e) {
                this.contexts.delete(profileId);
            }
        }

        const browser = await chromium.connectOverCDP(`${KAMELEO_PLAYWRIGHT_BASE}/${profileId}`);
        const contexts = browser.contexts();
        if (contexts.length === 0) {
            throw new Error(`No contexts found for profile ${profileId}`);
        }
        const context = contexts[0];
        this.contexts.set(profileId, context);

        browser.on('disconnected', () => {
            this.contexts.delete(profileId);
        });

        return context;
    }

    static async getPage(profileId: string): Promise<Page> {
        const context = await this.connect(profileId);
        let pages = context.pages();
        if (pages.length === 0) {
            return await context.newPage();
        }
        // chrome:// / about: の内部ページを除いた最後のページを返す
        const realPages = pages.filter(p => {
            const url = p.url();
            return !url.startsWith('chrome://') && !url.startsWith('about:') && url !== '';
        });
        return realPages[realPages.length - 1] ?? pages[pages.length - 1];
    }

    static async disconnect(profileId: string) {
        const context = this.contexts.get(profileId);
        if (context) {
            try {
                // Wrap close in a timeout to prevent indefinite hangs
                await Promise.race([
                    context.browser()?.close(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Playwright disconnect timeout')), 5000))
                ]);
            } catch (e) {
                console.warn(`[PlaywrightService] Disconnect error/timeout for ${profileId}:`, e);
            } finally {
                this.contexts.delete(profileId);
            }
        }
    }
}
