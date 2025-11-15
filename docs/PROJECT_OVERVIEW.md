POST /internal/export-restored/close

Purpose
Close an opened container (BrowserWindow + BrowserView) and release resources. Idempotent: closing an already-closed container returns success with closed=false.

Request
- POST /internal/export-restored/close
- Body: JSON { "id": "<container-uuid>", "timeoutMs": 30000 } (timeoutMs optional)

Responses
- 200 { "ok": true, "closed": true, "message": "closed" } -- closed successfully
- 200 { "ok": true, "closed": false, "message": "not-open" } -- already closed / not open
- 400 { "ok": false, "error": "missing id" } -- bad request
- 404 { "ok": false, "error": "container not found" } -- unknown id
- 500 { "ok": false, "error": "internal" } -- internal failure

Behavior
- Validates container exists via `DB.getContainer(id)`.
- If open, calls `closeContainer(id)` and waits for `waitForContainerClosed(id, timeoutMs)`.
- Clears any internal export/exec locks for the id prior to closing.
- Logs `runId`, `closedBy` (if provided via `x-requested-by`) and timestamp for audit.
- Runs only on local binding (127.0.0.1) — do not expose publicly.

Examples
curl -X POST http://127.0.0.1:3001/internal/export-restored/close -H "Content-Type: application/json" -d '{"id":"489efb6c-7a56-4fc3-97c6-83a93971094e"}'


