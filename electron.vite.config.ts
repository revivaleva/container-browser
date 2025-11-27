import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        // ★ 追加：ネイティブモジュールは必ず external 扱いに
        external: ['better-sqlite3', 'keytar'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          mainPreload: resolve(__dirname, 'src/preload/mainPreload.ts'),
          containerPreload: resolve(__dirname, 'src/preload/containerPreload.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    vite: {
      server: {
        port: 5173,
        open: false,
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          containerShell: resolve(__dirname, 'src/renderer/containerShell.html'),
        },
      },
    },
  },
});
