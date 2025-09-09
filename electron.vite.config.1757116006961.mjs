// electron.vite.config.ts
import { defineConfig } from "electron-vite";
import { resolve } from "node:path";
var __electron_vite_injected_dirname = "/mnt/c/Users/revival/projects/container-browser";
var electron_vite_config_default = defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__electron_vite_injected_dirname, "src/main/index.ts"),
        // ★ 追加：ネイティブモジュールは必ず external 扱いに
        external: ["better-sqlite3", "keytar"]
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          mainPreload: resolve(__electron_vite_injected_dirname, "src/preload/mainPreload.ts"),
          containerPreload: resolve(__electron_vite_injected_dirname, "src/preload/containerPreload.ts")
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs"
        }
      }
    }
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/renderer/index.html"),
          containerShell: resolve(__electron_vite_injected_dirname, "src/renderer/containerShell.html")
        }
      }
    }
  }
});
export {
  electron_vite_config_default as default
};
