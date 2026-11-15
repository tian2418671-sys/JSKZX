/**
 * 未知 JS 资源兜底桩的门禁
 *
 * 场景（真实案例：Cosmos Vision）：
 *   插件 dist/index.js 里写
 *       import {...} from '../../../../../script.js'
 *       import '../../../../../lib/jszip.min.js'
 *   从 dist/ 向上五层指向酒馆 public/，预览环境没有这些文件。
 *   若返回 404，浏览器整个模块图加载失败，但报错只指向入口：
 *       Failed to fetch dynamically imported module: .../dist/index.js
 *   —— 完全看不出真正缺的是哪个子依赖。
 *
 * 因此 app:// 协议对读不到的 .js/.mjs 返回「万能桩模块」。
 * 本测试确保该桩本身语法合法（若它语法错，问题会再次变成不可定位）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(join(here, '../main.js'), 'utf-8');

function extractStubSource() {
    const start = mainSrc.indexOf('function buildUnknownJsStub(');
    assert.ok(start >= 0, '未找到 buildUnknownJsStub');
    const retIdx = mainSrc.indexOf('return `', start);
    const endIdx = mainSrc.indexOf('\n`;', retIdx);
    assert.ok(retIdx >= 0 && endIdx > retIdx, '未找到桩模板字符串边界');
    return mainSrc.slice(retIdx + 8, endIdx);
}

test('未知 JS 兜底桩本身就是合法 ESM（否则问题会再次不可定位）', () => {
    const src = extractStubSource();
    const tmp = join(os.tmpdir(), `jsk-stub-check-${Date.now()}.mjs`);
    writeFileSync(tmp, src, 'utf-8');
    try {
        execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    } catch (e) {
        assert.fail(`兜底桩 ESM 语法错误:\n${String(e.stderr || e.message).split('\n').slice(0, 8).join('\n')}`);
    } finally {
        try { unlinkSync(tmp); } catch { /* 忽略 */ }
    }
});

test('兜底桩必须导出插件最常 import 的酒馆 API', () => {
    const src = extractStubSource();
    const required = [
        'getContext', 'getRequestHeaders', 'eventSource', 'event_types', 'eventTypes',
        'chat', 'characters', 'chat_metadata', 'saveSettingsDebounced', 'uuidv4',
        'getTokenCountAsync', 'proxies', 'SlashCommandParser', 'ARGUMENT_TYPE',
    ];
    // 检查 export { ... } 块里是否包含
    const exportBlock = src.match(/export\s*\{([\s\S]*?)\}/);
    assert.ok(exportBlock, '未找到 export { } 块');
    const names = exportBlock[1].split(',').map((x) => x.trim()).filter(Boolean);
    for (const n of required) {
        assert.ok(names.includes(n), `兜底桩缺少导出 ${n}`);
    }
});

test('app:// 协议对读不到的 .js/.mjs 必须返回桩而非 404', () => {
    assert.match(
        mainSrc,
        /if \(extJs === '\.js' \|\| extJs === '\.mjs'\)/,
        'app:// 协议应在 js/mjs 读取失败时返回兜底桩',
    );
    assert.match(
        mainSrc,
        /buildUnknownJsStub\(url\.pathname\)/,
        '读取失败分支应调用 buildUnknownJsStub',
    );
});
