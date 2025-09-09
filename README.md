# Container Browser (Electron + TypeScript) — v2
- **Restore last session tabs**: opens each previous tab as its own window (simple baseline; you can later replace with BrowserViews for true tabs).
- **Per-origin auto-fill ON/OFF UI**: Site preferences (autoFill/autoSaveForms) can be set in the main UI; `autoFill` governs whether credentials are auto-filled in container windows.

## Dev
```bash
npm i   # or pnpm i
# Rebuild native deps for Electron
npx electron-rebuild -f -w better-sqlite3 -w keytar
npm run dev
```
On Windows you may need VS Build Tools + Python:
```bash
npm config set msvs_version 2022 --global
```

## Notes
- Credentials are stored via **keytar** (OS keychain). Database only stores a reference key.
- Site preferences default to **off** (no auto-fill) until you enable them per origin.
