#!/usr/bin/env node
/**
 * Get container info by name
 */

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

function getDbPath() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'container-browser', 'data.db');
}

function main() {
  const containerName = process.argv[2];
  
  if (!containerName) {
    console.error('Usage: node get_container_info.cjs <container-name>');
    process.exit(1);
  }
  
  const dbPath = getDbPath();
  
  if (!require('fs').existsSync(dbPath)) {
    console.error('ERROR: Database not found:', dbPath);
    process.exit(1);
  }
  
  try {
    const db = new Database(dbPath, { readonly: true });
    
    const container = db.prepare('SELECT * FROM containers WHERE name = ?').get(containerName);
    
    if (!container) {
      console.error('ERROR: Container not found:', containerName);
      process.exit(1);
    }
    
    console.log(JSON.stringify(container));
    
    db.close();
  } catch (e) {
    console.error('ERROR:', e.message);
    if (e.message.includes('better-sqlite3')) {
      console.error('');
      console.error('better-sqlite3がElectron用にビルドされている可能性があります。');
      console.error('その場合は、アプリ内から確認してください。');
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
