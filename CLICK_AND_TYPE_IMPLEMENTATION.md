# Click & KeyInput Implementation

## 概要

`/internal/exec` API に 2 つの新しいコマンドを追加しました：

1. **`click`** - CSS セレクタまたは XPath で要素を指定し、DOM `click()` を実行
2. **`clickAndType`** - `click` の後、Electron `sendInputEvent()` でランダムな英字キーを入力

---

## 実装仕様

### コマンド: `click`

指定した要素に対して `focus()` と `click()` を実行します。

**リクエスト例:**

```json
{
  "contextId": "container-id",
  "command": "click",
  "selector": "button.submit",
  "options": {
    "waitForSelector": "form",
    "screenshot": false
  }
}
```

**パラメータ:**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `contextId` | string | コンテナID（必須） |
| `command` | string | `"click"` |
| `selector` | string | CSS セレクタまたは `xpath:` で始まる XPath（必須） |
| `options.waitForSelector` | string | 実行前に待機するセレクタ（オプション） |
| `options.timeoutMs` | number | タイムアウト（デフォルト: 30000ms） |

**レスポンス例:**

```json
{
  "ok": true,
  "command": "click",
  "navigationOccurred": false,
  "url": "https://example.com",
  "title": "Example Page",
  "elapsedMs": 45
}
```

---

### コマンド: `clickAndType`

1. `click` と同じ方法で要素にフォーカスしてクリック
2. **50ms 待機** して、要素がフォーカス状態に落ち着くのを待つ
3. **Electron `sendInputEvent()` でキー入力を注入** (keyDown → char → keyUp)
4. **ランダムな英字キー** (A-Z) を1文字入力

**リクエスト例:**

```json
{
  "contextId": "container-id",
  "command": "clickAndType",
  "selector": "input#search",
  "options": {
    "screenshot": false
  }
}
```

**パラメータ:**

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `contextId` | string | コンテナID（必須） |
| `command` | string | `"clickAndType"` |
| `selector` | string | CSS セレクタまたは `xpath:` で始まる XPath（必須） |
| `options.*` | object | 他のオプション（`click` と同様） |

**レスポンス例:**

```json
{
  "ok": true,
  "command": "clickAndType",
  "navigationOccurred": false,
  "url": "https://example.com",
  "title": "Example Page",
  "elapsedMs": 150
}
```

---

## 実装の詳細

### コード位置

`src/main/exportServer.ts` の `/internal/exec` エンドポイント内に実装

### フロー

```
┌─────────────────────────────────────────────────────────────┐
│ command === 'click' || command === 'clickAndType'             │
└─────────────────────────────────────────────────────────────┘
                            ↓
              ┌──────────────────────────┐
              │ Step 1: DOM Click        │
              │ executeJavaScript()で:   │
              │ 1. querySelector or     │
              │    document.evaluate    │
              │ 2. el.focus()           │
              │ 3. el.click()           │
              └──────────────────────────┘
                            ↓
              ┌──────────────────────────┐
              │ clickAndType の場合       │
              │ Step 2: Wait 50ms        │
              └──────────────────────────┘
                            ↓
              ┌──────────────────────────┐
              │ Step 3: sendInputEvent   │
              │ ランダムな英字キー:       │
              │ 1. keyDown               │
              │ 2. char                  │
              │ 3. keyUp                 │
              └──────────────────────────┘
```

### XPath サポート

セレクタが `xpath:` で始まる場合、XPath として解析：

```javascript
// CSS セレクタ
selector: "input[type='text']"

// XPath
selector: "xpath://input[@type='text']"
```

---

## エラーハンドリング

| 状況 | ステータス | レスポンス |
|------|---------|-----------|
| セレクタが指定されていない | 400 | `{ ok: false, error: 'missing selector' }` |
| セレクタがページに見つからない | 404 | `{ ok: false, error: 'selector not found' }` |
| その他のエラー | 500 | `{ ok: false, error: '...' }` |

---

## 技術的詳細

### DOM Click の実装

```javascript
// CSS セレクタの場合
const el = document.querySelector(selector);
if (!el) throw new Error('selector not found');
el.focus();
el.click();

// XPath の場合
const node = document.evaluate(xpath, document, null, 
  XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
if (!node) throw new Error('selector not found');
node.focus();
node.click();
```

### sendInputEvent() でのキー入力

```javascript
// ランダムな英字キー (A-Z) を生成
const randomChar = String.fromCharCode(65 + Math.floor(Math.random() * 26));
const charLower = randomChar.toLowerCase();

// 3つのイベントを順序正しく送信
wc.sendInputEvent({ type: 'keyDown', keyCode: randomChar });
wc.sendInputEvent({ type: 'char', keyCode: charLower });
wc.sendInputEvent({ type: 'keyUp', keyCode: randomChar });
```

---

## テスト方法

`test_click_and_type.js` スクリプトを使用：

```bash
# click コマンドのテスト
node test_click_and_type.js container-123 "input[type='text']" click

# clickAndType コマンドのテスト
node test_click_and_type.js container-123 "input[type='text']" clickAndType

# デフォルト (clickAndType)
node test_click_and_type.js container-123 "button.submit"
```

**前提条件:**

1. コンテナがすでに開かれている、または自動的に開かれる
2. エクスポート サーバが `http://localhost:3001` で動作中（またはカスタムポート）

---

## 既存 API との互換性

- 既存の `type`、`eval`、`navigate` コマンドは変更なし
- 後方互換性を完全に保持

---

## 今後の改善案

1. **キーコード指定** - `clickAndType` に `keyCode` パラメータを追加してカスタムキーを指定可能に
2. **複数キー入力** - 複数文字の入力をサポート
3. **遅延制御** - クリック後の待機時間をカスタマイズ可能に

---

## 参考

- Electron WebContents API: https://www.electronjs.org/docs/api/web-contents#contentssendinputeventinput
- MDN HTMLElement.focus(): https://developer.mozilla.org/ja/docs/Web/API/HTMLElement/focus
- MDN HTMLElement.click(): https://developer.mozilla.org/ja/docs/Web/API/HTMLElement/click


