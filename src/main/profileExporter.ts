import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import archiver from 'archiver';
import extractZip from 'extract-zip';
import { DB } from './db';
import type { Container } from '../shared/types';

/**
 * partition文字列から実体ディレクトリ名を抽出
 * persist:container-${id} -> container-${id}
 */
function extractPartitionDirName(partition: string): string | null {
  if (!partition || typeof partition !== 'string') return null;
  const m = partition.match(/^persist:(.+)$/);
  return m ? m[1] : null;
}

/**
 * エクスポートから除外するディレクトリ/ファイルパターン
 * ログイン状態維持に不要なキャッシュや一時ファイルを除外
 */
const EXCLUDE_PATTERNS = [
  // キャッシュディレクトリ（巨大なファイルが含まれる可能性）
  '**/Cache/**',
  '**/Code Cache/**',
  '**/GPUCache/**',
  '**/Service Worker/**',
  '**/ServiceWorker/**',
  '**/Media Cache/**',
  '**/ShaderCache/**',
  '**/VideoDecodeStats/**',
  
  // 一時ファイル・ロックファイル
  '**/SingletonLock',
  '**/LOCK',
  '**/lockfile',
  '**/*.tmp',
  '**/*.temp',
  '**/*.log',
  
  // ダウンロード履歴（通常は不要）
  '**/History*',
  '**/Top Sites*',
  '**/Favicons*',
  
  // その他の不要なファイル
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
function shouldExclude(filePath: string, basePath: string): boolean {
  const relativePath = path.relative(basePath, filePath).replace(/\\/g, '/');
  const fileName = path.basename(filePath);
  
  for (const pattern of EXCLUDE_PATTERNS) {
    // シンプルなパターンマッチング（glob風）
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
function addDirectoryFiltered(
  archive: archiver.Archiver,
  sourcePath: string,
  archivePath: string,
  basePath: string
): void {
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
    console.warn(`[profileExporter] Failed to process directory ${sourcePath}:`, e);
  }
}

/**
 * プロファイルフォルダをZIP圧縮（profiles + Partitions を含む、キャッシュ等を除外）
 */
export async function zipProfiles(containerIds: string[], outputPath: string): Promise<{ success: number; error: number; totalSize: number }> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    let successCount = 0;
    let errorCount = 0;
    let totalSize = 0;

    output.on('close', () => {
      resolve({ success: successCount, error: errorCount, totalSize: archive.pointer() });
    });

    archive.on('error', (err) => {
      reject(err);
    });

    archive.pipe(output);

    const userDataPath = app.getPath('userData');
    const profilesDir = path.join(userDataPath, 'profiles');
    const partitionsDir = path.join(userDataPath, 'Partitions');

    // 各コンテナのプロファイルとPartitionsを追加
    for (const containerId of containerIds) {
      const container = DB.getContainer(containerId);
      if (!container) {
        console.warn(`[profileExporter] Container not found: ${containerId}`);
        errorCount++;
        continue;
      }

      let hasProfile = false;
      let hasPartition = false;

      // profiles/${containerId} を追加（フィルタリング適用）
      const profilePath = path.join(profilesDir, containerId);
      if (fs.existsSync(profilePath)) {
        try {
          addDirectoryFiltered(archive, profilePath, `profiles/${containerId}`, profilePath);
          hasProfile = true;
          console.log(`[profileExporter] Added profile ${containerId} (with exclusions)`);
        } catch (e) {
          console.warn(`[profileExporter] Failed to add profile ${containerId}:`, e);
        }
      }

      // Partitions/container-${containerId} を追加（フィルタリング適用）
      const partitionDirName = extractPartitionDirName(container.partition);
      if (partitionDirName) {
        const partitionPath = path.join(partitionsDir, partitionDirName);
        if (fs.existsSync(partitionPath)) {
          try {
            addDirectoryFiltered(archive, partitionPath, `Partitions/${partitionDirName}`, partitionPath);
            hasPartition = true;
            console.log(`[profileExporter] Added partition ${partitionDirName} for container ${containerId} (with exclusions)`);
          } catch (e) {
            console.warn(`[profileExporter] Failed to add partition ${partitionDirName}:`, e);
          }
        } else {
          console.warn(`[profileExporter] Partition not found: ${partitionPath}`);
        }
      } else {
        console.warn(`[profileExporter] Invalid partition format: ${container.partition}`);
      }

      if (hasProfile || hasPartition) {
        successCount++;
      } else {
        errorCount++;
      }
    }

    archive.finalize();
  });
}

/**
 * ZIPファイルからプロファイルを展開
 */
export async function extractProfiles(zipPath: string, targetDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    extractZip(zipPath, { dir: targetDir }, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * 全コンテナのプロファイルをZIP圧縮
 */
export async function zipAllProfiles(outputPath: string): Promise<{ success: number; error: number; totalSize: number }> {
  const containers = DB.listContainers();
  const containerIds = containers.map(c => c.id);
  return zipProfiles(containerIds, outputPath);
}

