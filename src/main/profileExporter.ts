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
 * プロファイルフォルダをZIP圧縮（profiles + Partitions を含む）
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

      // profiles/${containerId} を追加
      const profilePath = path.join(profilesDir, containerId);
      if (fs.existsSync(profilePath)) {
        try {
          archive.directory(profilePath, `profiles/${containerId}`);
          hasProfile = true;
        } catch (e) {
          console.warn(`[profileExporter] Failed to add profile ${containerId}:`, e);
        }
      }

      // Partitions/container-${containerId} を追加
      const partitionDirName = extractPartitionDirName(container.partition);
      if (partitionDirName) {
        const partitionPath = path.join(partitionsDir, partitionDirName);
        if (fs.existsSync(partitionPath)) {
          try {
            archive.directory(partitionPath, `Partitions/${partitionDirName}`);
            hasPartition = true;
            console.log(`[profileExporter] Added partition ${partitionDirName} for container ${containerId}`);
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

