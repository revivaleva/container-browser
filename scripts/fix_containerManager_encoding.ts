/**
 * 目的: containerManager.ts の文字化けによるコメント+コード行結合を修正する
 * 使用期限: 2026-03-09 (一回限り実行後はnotes/に移動)
 *
 * 問題: UTF-8ファイルの日本語コメントの末尾に改行が失われ、
 * コメント行とコード行が同一行に結合されてしまっている箇所がある。
 * 例: "// ...日本語...const LOG_ONLY_PROXY = ..."
 * をそれぞれの行に分割する。
 */

import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('src/main/containerManager.ts');
const content = fs.readFileSync(filePath, 'utf8');

// コメント行に続いてコードが来ているパターンを修正
// "// ...anything... (const|let|var|function|if|return|export) ..." を分割
// ただし、コメント内の一般的なコードキーワードはスキップしない
const lines = content.split(/\r?\n/);
const fixedLines: string[] = [];
let fixCount = 0;

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // コメント行(//で始まる or スペース後に//)かどうか確認
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//')) {
        // コード断片がコメントに続いてないか確認
        // パターン: "// ...コメント本文... " + "const/let/var/function/if/export/return/ipcMain" など
        // TypeScriptのトップレベル or 関数スコープのキーワードが続く場合
        const codeKeywords = [
            /(?:\s+)(const\s+\w+\s*=)/,
            /(?:\s+)(let\s+\w+\s*=?)/,
            /(?:\s+)(var\s+\w+\s*=?)/,
            /(?:\s+)(function\s+\w+)/,
            /(?:\s+)(export\s+(?:function|const|class|default))/,
            /(?:\s+)(async\s+function\s+\w+)/,
            /(?:\s+)(class\s+\w+)/,
            /(?:\s+)(if\s*\()/,
            /(?:\s+)(ipcMain_\.handle)/,
        ];

        let splitHappened = false;
        for (const kw of codeKeywords) {
            const match = line.match(kw);
            if (match && match.index !== undefined) {
                const commentPart = line.slice(0, match.index);
                const codePart = line.slice(match.index).trimStart();
                console.log(`[fix] Line ${i + 1}: splitting at "${codePart.slice(0, 50)}..."`);
                fixedLines.push(commentPart);
                fixedLines.push(codePart);
                fixCount++;
                splitHappened = true;
                break;
            }
        }

        if (!splitHappened) {
            fixedLines.push(line);
        }
    } else {
        fixedLines.push(line);
    }
}

if (fixCount > 0) {
    const fixed = fixedLines.join('\n');
    fs.writeFileSync(filePath, fixed, 'utf8');
    console.log(`[fix] Done. Fixed ${fixCount} line(s) in ${filePath}`);
} else {
    console.log('[fix] No issues found.');
}
