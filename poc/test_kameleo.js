const { chromium } = require('playwright-core');

const KAMELEO_API = 'http://localhost:5050';

async function run() {
  try {
    // 1. Get Fingerprints
    console.log('Fetching fingerprints...');
    const fpsResponse = await fetch(`${KAMELEO_API}/fingerprints`);
    const fps = await fpsResponse.json();
    console.log('Fingerprints response:', JSON.stringify(fps).slice(0, 200));
    
    // The response might be the array itself or { value: [] }
    const fpsArray = Array.isArray(fps) ? fps : (fps.value || []);
    
    if (fpsArray.length === 0) {
        throw new Error('No fingerprints found');
    }

    // Attempt to find a Windows/Chrome fingerprint
    const fingerprint = fpsArray.find(f => 
      f.os && f.os.family === 'windows' && 
      f.browser && f.browser.family === 'chrome'
    ) || fpsArray[0];
    
    console.log(`Using fingerprint: ${fingerprint.id} (${fingerprint.os ? fingerprint.os.family : 'unknown'} ${fingerprint.browser ? fingerprint.browser.family : 'unknown'})`);

    // 2. Create Profile
    console.log('Creating profile...');
    const createResponse = await fetch(`${KAMELEO_API}/profiles/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fingerprintId: fingerprint.id,
        name: 'Kameleo-PoC',
        browser: {
          launcher: 'playwright'
        }
      })
    });
    
    if (!createResponse.ok) {
      throw new Error(`Profile creation failed: ${createResponse.status} ${await createResponse.text()}`);
    }
    
    const profile = await createResponse.json();
    const profileId = profile.id || profile.guid; // Check which one is correct
    console.log(`Profile created: ${profileId}`);

    // 3. Start Profile
    console.log('Starting profile...');
    const startResponse = await fetch(`${KAMELEO_API}/profiles/${profileId}/start`, {
      method: 'POST'
    });
    
    if (!startResponse.ok) {
      throw new Error(`Profile start failed: ${startResponse.status} ${await startResponse.text()}`);
    }
    
    // 4. Connect Playwright
    const wsUrl = `ws://localhost:5050/playwright/${profileId}`;
    console.log(`Connecting Playwright to ${wsUrl}...`);
    const browser = await chromium.connectOverCDP(wsUrl);
    
    console.log('Fetching contexts...');
    const contexts = browser.contexts();
    const context = contexts[0] || await browser.newContext();
    console.log('Context obtained.');
    
    console.log('Creating new page...');
    const page = await context.newPage();
    console.log('Page created.');

    // 5. Navigate and Interact
    console.log('Navigating to example.com...');
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    console.log('Navigate Success.');
    
    console.log('Checking for heading...');
    const title = await page.title();
    console.log('Title:', title);
    
    // Simple click & type verification
    console.log('Clicking body...');
    await page.click('body');
    console.log('Click Success.');

    // 6. Manual Intervention Simulation
    console.log('Waiting for 5 seconds (Manual Intervention Simulation)...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 7. Cleanup
    console.log('Stopping profile...');
    await browser.close();
    await fetch(`${KAMELEO_API}/profiles/${profileId}/stop`, { method: 'POST' });
    console.log('Done.');

  } catch (err) {
    console.error('PoC Failed:', err);
  }
}

run();
