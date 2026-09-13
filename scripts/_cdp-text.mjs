/**
 * 现场只读探针：把「应用自己显示的东西」拉出来看（加载蒙版进度 / 卡片数 / 索引状态）
 *
 * 用途：大库加载「卡住」时不知道卡在哪一步——看 DOM 上的蒙版文案最快，
 * 它直接显示「解析中 12,345 / 22,276」这类进度。
 *
 * 用法：node scripts/_cdp-text.mjs [--port 9338]
 */
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const i = argv.indexOf('--port');
const PORT = (i >= 0 && argv[i + 1]) ? argv[i + 1] : (process.env.CDP_PORT || '9338');

const EXPR = `(() => {
    const d = window.__jskDiag || {};
    const mask = document.querySelector('#app') ? document.querySelector('#app').innerText : '';
    const lib = (typeof d.lib === 'function' && d.lib()) || null;
    const m = (typeof performance !== 'undefined' && performance.memory) ? performance.memory : null;
    return JSON.stringify({
        cards: lib ? lib.length : null,
        maskHead: String(mask || '').replace(/\\s+/g, ' ').slice(0, 240),
        heapUsedMB: m ? Math.round(m.usedJSHeapSize / 1048576) : null,
        heapLimitMB: m ? Math.round(m.jsHeapSizeLimit / 1048576) : null,
        idx: d.idx ? d.idx.stats() : null,
        slim: (typeof d.slim === 'function') ? d.slim() : null,
        mem: d.mem ? d.mem.stats : null,
        tokenCache: (d.tokenCache && typeof d.tokenCache.getStats === 'function') ? d.tokenCache.getStats() : null
    });
})()`;

const r = spawnSync('node', ['scripts/_cdp-eval.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, CDP_PORT: PORT, EXPR, GC: '0' },
    encoding: 'utf-8'
});
if (!r.stdout || !r.stdout.trim()) {
    console.log(JSON.stringify({ ok: false, error: 'no-cdp-response', port: PORT, stderr: (r.stderr || '').slice(0, 200) }));
    process.exit(0);
}
console.log(r.stdout.trim());
