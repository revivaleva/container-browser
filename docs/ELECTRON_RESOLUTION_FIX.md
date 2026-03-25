# Electron Module Resolution Fix (Electron 29+)

## Issue
In Electron 29.x with `electron-vite`, a common issue occurs where the main process incorrectly resolves the `electron` module as a string path (pointing to the `node_modules/electron/dist/electron.exe` binary) instead of the native Electron module object. This leads to runtime errors such as:
`TypeError: Cannot read properties of undefined (reading 'commandLine')`

## Fix Details
A custom Vite plugin is used in `electron.vite.config.ts` to transform the generated code. It replaces all instances of `require("electron")` with `eval("require")("electron")`. This forces the runtime to use the native Electron `require` mechanism, bypassing the standard Node module resolution.

### Configuration (`electron.vite.config.ts`)
```typescript
    plugins: [
      externalizeDepsPlugin(),
      {
        name: 'transform-electron-require',
        renderChunk(code) {
          // Replace require('electron') with eval("require")("electron") to force native module resolution
          return code.replace(/require\(['"]electron['"]\)/g, 'eval("require")("electron")');
        }
      }
    ],
```

## Mandatory Verification Procedure
Before every commit and after any changes to build settings or dependencies, the following steps **MUST** be performed:

1.  **Verification of Development Run**:
    - Run `npm run dev`.
    - Verify that the Electron app starts without any `TypeError` related to `electron` or `app`.
    - Ensure the main process initialization completes successfully (e.g., "Main window created successfully").

2.  **Verification of Production Build**:
    - Run `npm run build`.
    - Verify that the build completes without errors.
    - (Optional but recommended) Inspect `out/main/index.cjs` to confirm `eval("require")("electron")` is present.

3.  **Verification of Distribution**:
    - Run `npm run dist`.
    - Verify that the installer/package is generated successfully in the `dist` directory.

**NOTE**: Always ensure `ELECTRON_RUN_AS_NODE` is NOT set to `1` in your environment during these tests, as it can cause `require('electron')` to return the path string even with this fix.
