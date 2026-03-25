import electron from 'electron';
console.log('Keys in electron:', Object.keys(electron));
console.log('BrowserView:', (electron as any).BrowserView);
process.exit(0);
