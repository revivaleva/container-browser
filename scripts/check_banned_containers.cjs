#!/usr/bin/env node
/**
 * Bannedグループのコンテナを確認するスクリプト
 */

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

function getDbPath() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'container-browser', 'data.db');
}

function main() {
  const dbPath = getDbPath();
  
  if (!require('fs').existsSync(dbPath)) {
    console.error('データベースファイルが見つかりません:', dbPath);
    process.exit(1);
  }
  
  try {
    const db = new Database(dbPath, { readonly: true });
    
    // 全コンテナを取得
    const allContainers = db.prepare('SELECT id, name, note, status FROM containers ORDER BY createdAt DESC').all();
    
    // Bannedグループのコンテナを検索（名前またはnoteに"Banned"が含まれる）
    const bannedContainers = allContainers.filter(c => {
      const name = (c.name || '').toLowerCase();
      const note = (c.note || '').toLowerCase();
      return name.includes('banned') || note.includes('banned');
    });
    
    console.log('='.repeat(60));
    console.log('コンテナ統計');
    console.log('='.repeat(60));
    console.log(`全コンテナ数: ${allContainers.length}件`);
    console.log(`Bannedグループ: ${bannedContainers.length}件`);
    console.log(`エクスポート対象（Banned除外後）: ${allContainers.length - bannedContainers.length}件`);
    console.log('');
    
    if (bannedContainers.length > 0) {
      console.log('Bannedグループのコンテナ:');
      console.log('-'.repeat(60));
      bannedContainers.forEach((c, i) => {
        console.log(`${i + 1}. ${c.name} (ID: ${c.id})`);
        if (c.note) console.log(`   Note: ${c.note}`);
        if (c.status) console.log(`   Status: ${c.status}`);
      });
    } else {
      console.log('Bannedグループのコンテナは見つかりませんでした。');
      console.log('（名前またはnoteに"Banned"が含まれるコンテナを検索しています）');
    }
    
    db.close();
  } catch (e) {
    console.error('エラー:', e.message);
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

module.exports = { getDbPath };

