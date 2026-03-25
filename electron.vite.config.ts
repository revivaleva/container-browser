import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      {
        name: 'transform-electron-require',
        renderChunk(code) {
          return code.replace(/require\(['"]electron['"]\)/g, 'eval("require")("electron")');
        }
      }
    ],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        external: ['electron', 'better-sqlite3', 'keytar', /^node:/],
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
    ssr: {
      external: ['electron', 'better-sqlite3', 'keytar'],
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
    server: {
      port: 5173,
      open: false,
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
