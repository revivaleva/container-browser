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
    return pages[0];
  }

  static async disconnect(profileId: string) {
      const context = this.contexts.get(profileId);
      if (context) {
          await context.browser()?.close();
          this.contexts.delete(profileId);
      }
  }
}
