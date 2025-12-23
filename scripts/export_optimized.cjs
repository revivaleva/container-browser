#!/usr/bin/env node
/**
 * 最適化されたエクスポートスクリプト（Terminalから実行可能）
 * 
 * キャッシュファイルを除外して、ログイン状態維持に必要なデータのみをエクスポートします。
 * 
 * 使用方法:
 *   node scripts/export_optimized.cjs [output_path]
 * 
 * 例:
 *   node scripts/export_optimized.cjs export.zip
 *   node scripts/export_optimized.cjs C:\backup\container-export.zip
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// archiverを動的に読み込む
let archiver;
try {
  archiver = require('archiver');
} catch (e) {
  console.error('エラー: archiverパッケージが必要です。');
  console.error('インストール: npm install archiver');
  process.exit(1);
}

// better-sqlite3を動的に読み込む
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('エラー: better-sqlite3パッケージが必要です。');
  console.error('インストール: npm install better-sqlite3');
  console.error('');
  console.error('注意: Electron用にビルドされている場合、通常のNode.jsでは動作しません。');
  console.error('その場合は、アプリ内のエクスポート機能を使用してください。');
  process.exit(1);
}

function getDefaultUserDataPath() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'container-browser');
}

function getDbPath() {
  const userDataPath = getDefaultUserDataPath();
  return path.join(userDataPath, 'data.db');
}

/**
 * partition文字列から実体ディレクトリ名を抽出
 * persist:container-${id} -> container-${id}
 */
function extractPartitionDirName(partition) {
  if (!partition || typeof partition !== 'string') return null;
  const m = partition.match(/^persist:(.+)$/);
  return m ? m[1] : null;
}

/**
 * エクスポートから除外するディレクトリ/ファイルパターン
 */
const EXCLUDE_PATTERNS = [
  '**/Cache/**',
  '**/Code Cache/**',
  '**/GPUCache/**',
  '**/Service Worker/**',
  '**/ServiceWorker/**',
  '**/Media Cache/**',
  '**/ShaderCache/**',
  '**/VideoDecodeStats/**',
  '**/SingletonLock',
  '**/LOCK',
  '**/lockfile',
  '**/*.tmp',
  '**/*.temp',
  '**/*.log',
  '**/History*',
  '**/Top Sites*',
  '**/Favicons*',
  '**/Current Session',
  '**/Current Tabs',
  '**/Last Session',
  '**/Last Tabs',
  '**/Preferences.bak',
  '**/Secure Preferences.bak',
];

/**
 * ファイル/ディレクトリが除外対象かどうかを判定
 */
function shouldExclude(filePath, basePath) {
  const relativePath = path.relative(basePath, filePath).replace(/\\/g, '/');
  const fileName = path.basename(filePath);
  
  for (const pattern of EXCLUDE_PATTERNS) {
    const regex = new RegExp(
      pattern
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\//g, '/')
    );
    
    if (regex.test(relativePath) || regex.test(fileName)) {
      return true;
    }
  }
  
  return false;
}

/**
 * ディレクトリを再帰的にアーカイブに追加（除外パターンを適用）
 */
function addDirectoryFiltered(archive, sourcePath, archivePath, basePath) {
  try {
    const entries = fs.readdirSync(sourcePath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(sourcePath, entry.name);
      const archiveEntryPath = path.join(archivePath, entry.name);
      
      // 除外チェック
      if (shouldExclude(fullPath, basePath)) {
        continue;
      }
      
      if (entry.isDirectory()) {
        // ディレクトリの場合は再帰的に処理
        addDirectoryFiltered(archive, fullPath, archiveEntryPath, basePath);
      } else {
        // ファイルの場合は追加
        archive.file(fullPath, { name: archiveEntryPath });
      }
    }
  } catch (e) {
    console.warn(`  [警告] ディレクトリ処理エラー ${sourcePath}:`, e.message);
  }
}

/**
 * データベースデータをエクスポート
 */
function exportDatabaseData() {
  const dbPath = getDbPath();
  
  if (!fs.existsSync(dbPath)) {
    console.error('エラー: データベースファイルが見つかりません:', dbPath);
    return null;
  }
  
  try {
    const db = new Database(dbPath, { readonly: true });
    
    // データを取得
    const containers = db.prepare('SELECT * FROM containers ORDER BY createdAt DESC').all();
    const sessions = db.prepare('SELECT * FROM sessions ORDER BY containerId, startedAt DESC').all();
    const tabs = db.prepare('SELECT * FROM tabs ORDER BY containerId, sessionId, id ASC').all();
    const bookmarks = db.prepare('SELECT * FROM bookmarks ORDER BY sortOrder ASC, createdAt DESC').all();
    const sitePrefs = db.prepare('SELECT * FROM site_prefs ORDER BY containerId, origin').all();
    const credentials = db.prepare('SELECT * FROM credentials ORDER BY containerId, origin').all();
    
    db.close();
    
    // JSON形式でデータを準備
    const exportData = {
      version: '1.0',
      exportedAt: Date.now(),
      data: {
        containers: containers.map(c => ({
          ...c,
          proxy: c.proxy ? JSON.parse(c.proxy) : null,
          fingerprint: c.fingerprint ? JSON.parse(c.fingerprint) : undefined
        })),
        sessions,
        tabs,
        bookmarks,
        sitePrefs,
        credentials: credentials.map(c => ({
          containerId: c.containerId,
          origin: c.origin,
          username: c.username,
          keytarAccount: c.keytarAccount,
          // 注意: パスワードはkeytarから取得する必要があるため、ここでは含まれません
        }))
      },
      summary: {
        containers: containers.length,
        sessions: sessions.length,
        tabs: tabs.length,
        bookmarks: bookmarks.length,
        sitePrefs: sitePrefs.length,
        credentials: credentials.length
      }
    };
    
    console.log('✓ DBデータをエクスポートしました');
    console.log(`  - コンテナ: ${containers.length}件`);
    console.log(`  - セッション: ${sessions.length}件`);
    console.log(`  - タブ: ${tabs.length}件`);
    console.log(`  - ブックマーク: ${bookmarks.length}件`);
    console.log(`  - サイト設定: ${sitePrefs.length}件`);
    console.log(`  - 認証情報: ${credentials.length}件（パスワードは別途移行が必要）`);
    
    return exportData;
  } catch (e) {
    console.error('DBデータのエクスポートエラー:', e.message);
    if (e.message.includes('better-sqlite3')) {
      console.error('');
      console.error('better-sqlite3がElectron用にビルドされている可能性があります。');
      console.error('その場合は、アプリ内のエクスポート機能を使用してください。');
    }
    return null;
  }
}

/**
 * ZIPファイルを作成
 */
function createZip(outputPath, exportData) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    let profileCount = 0;
    let partitionCount = 0;
    let profileErrorCount = 0;
    let partitionErrorCount = 0;
    
    output.on('close', () => {
      resolve({
        fileSize: archive.pointer(),
        profileCount,
        partitionCount,
        profileErrorCount,
        partitionErrorCount
      });
    });
    
    archive.on('error', (err) => {
      reject(err);
    });
    
    archive.pipe(output);
    
    // data.jsonを追加
    const dataJson = JSON.stringify(exportData, null, 2);
    archive.append(dataJson, { name: 'data.json' });
    
    // プロファイルとPartitionsを追加
    const userDataPath = getDefaultUserDataPath();
    const profilesDir = path.join(userDataPath, 'profiles');
    const partitionsDir = path.join(userDataPath, 'Partitions');
    
    if (!exportData || !exportData.data || !exportData.data.containers) {
      console.warn('警告: コンテナデータが見つかりません');
      archive.finalize();
      return;
    }
    
    for (const container of exportData.data.containers) {
      // profiles/${container.id} を追加（フィルタリング適用）
      const profilePath = path.join(profilesDir, container.id);
      if (fs.existsSync(profilePath)) {
        try {
          addDirectoryFiltered(archive, profilePath, `profiles/${container.id}`, profilePath);
          profileCount++;
          console.log(`  ✓ プロファイル追加: ${container.id}`);
        } catch (e) {
          console.warn(`  ✗ プロファイル追加失敗 ${container.id}:`, e.message);
          profileErrorCount++;
        }
      }
      
      // Partitions/container-${container.id} を追加（フィルタリング適用）
      const partitionDirName = extractPartitionDirName(container.partition);
      if (partitionDirName) {
        const partitionPath = path.join(partitionsDir, partitionDirName);
        if (fs.existsSync(partitionPath)) {
          try {
            addDirectoryFiltered(archive, partitionPath, `Partitions/${partitionDirName}`, partitionPath);
            partitionCount++;
            console.log(`  ✓ Partition追加: ${partitionDirName}`);
          } catch (e) {
            console.warn(`  ✗ Partition追加失敗 ${partitionDirName}:`, e.message);
            partitionErrorCount++;
          }
        }
      }
    }
    
    archive.finalize();
  });
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
最適化されたエクスポートスクリプト

使用方法:
  node scripts/export_optimized.cjs <出力ファイルパス>

説明:
  - データベースデータ（コンテナ、セッション、タブ等）をエクスポート
  - プロファイルとPartitionsディレクトリをエクスポート
  - キャッシュファイル（Cache, Code Cache等）を除外してサイズを削減
  - ログイン状態維持に必要なデータ（Cookies, LocalStorage, IndexedDB）は含まれる

例:
  node scripts/export_optimized.cjs export.zip
  node scripts/export_optimized.cjs C:\\backup\\container-export-$(Get-Date -Format 'yyyyMMdd').zip

注意:
  - 認証情報（パスワード）はWindows Credential Managerに保存されているため、
    別途アプリ内の移行機能を使用してインポートしてください。
`);
    process.exit(0);
  }
  
  const outputPath = path.resolve(args[0]);
  
  console.log('='.repeat(60));
  console.log('最適化されたエクスポートを開始します');
  console.log('='.repeat(60));
  console.log(`出力ファイル: ${outputPath}`);
  console.log('');
  
  // DBデータをエクスポート
  console.log('データベースデータをエクスポート中...');
  const exportData = exportDatabaseData();
  if (!exportData) {
    console.error('エラー: DBデータのエクスポートに失敗しました');
    process.exit(1);
  }
  
  // ZIPファイルを作成
  console.log('');
  console.log('プロファイルとPartitionsをエクスポート中...');
  console.log('（キャッシュファイルは除外されます）');
  console.log('');
  
  createZip(outputPath, exportData)
    .then((result) => {
      console.log('');
      console.log('='.repeat(60));
      console.log('✓ エクスポート完了！');
      console.log('='.repeat(60));
      console.log(`ファイル: ${outputPath}`);
      console.log(`サイズ: ${(result.fileSize / 1024 / 1024).toFixed(2)} MB`);
      console.log(`プロファイル: ${result.profileCount}件`);
      console.log(`Partitions: ${result.partitionCount}件`);
      if (result.profileErrorCount > 0 || result.partitionErrorCount > 0) {
        console.log(`エラー: プロファイル ${result.profileErrorCount}件, Partitions ${result.partitionErrorCount}件`);
      }
      console.log('');
      console.log('【注意】');
      console.log('認証情報（パスワード）はWindows Credential Managerに保存されているため、');
      console.log('別途アプリ内の移行機能を使用してインポートしてください。');
    })
    .catch((err) => {
      console.error('エクスポートエラー:', err.message);
      process.exit(1);
    });
}

if (require.main === module) {
  main();
}

module.exports = { getDefaultUserDataPath, getDbPath };

