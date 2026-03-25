const Database = require('better-sqlite3');
const path = require('path');
const appData = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Application Support' : process.env.HOME + "/.config");
const dbPath = path.join(appData, 'container-browser', 'data.db');

const db = new Database(dbPath, { readonly: true });
const count = db.prepare('SELECT COUNT(*) as count FROM containers').get().count;
console.log(`Total containers: ${count}`);

const largeContainers = db.prepare('SELECT id, name, LENGTH(proxy) as proxyLen FROM containers ORDER BY proxyLen DESC LIMIT 10').all();
console.log('Top 10 containers by proxy config length:');
console.table(largeContainers);

db.close();
