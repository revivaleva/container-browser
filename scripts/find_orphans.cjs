const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const appData = process.env.APPDATA;
const userDataDir = path.join(appData, 'container-browser');
const dbPath = path.join(userDataDir, 'data.db');
const partitionsDir = path.join(userDataDir, 'Partitions');

const db = new Database(dbPath, { readonly: true });
const containers = db.prepare('SELECT partition FROM containers').all();
const activePartitions = new Set(containers.map(c => c.partition.replace('persist:', '')));

db.close();

if (!fs.existsSync(partitionsDir)) {
    console.log('Partitions directory not found.');
    process.exit(0);
}

const folders = fs.readdirSync(partitionsDir);
let orphanCount = 0;
let orphanSize = 0;

console.log('--- Orphan Partitions Check ---');
folders.forEach(folder => {
    if (!activePartitions.has(folder) && folder.startsWith('container-')) {
        orphanCount++;
        const fullPath = path.join(partitionsDir, folder);
        try {
            // Simple size check (not recursive for speed)
            const stats = fs.statSync(fullPath);
            console.log(`Orphan: ${folder}`);
        } catch (e) { }
    }
});

console.log(`\nTotal Orphans: ${orphanCount}`);
console.log('Use clear_all_container_cache.ps1 to clean up folders, or a custom script for orphans.');
