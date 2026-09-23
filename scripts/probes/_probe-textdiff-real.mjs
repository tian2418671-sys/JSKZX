/**
 * 差异算法（js/utils/textDiff.js）在**真实大世界书**上的正确性与性能验证
 *
 * 用法：
 *   node scripts/probes/_probe-textdiff-real.mjs
 *
 * 为什么单独做：差异着色是本次新提交（9fcf09c）的核心，而其「行级对齐 + 行内高亮」
 *   完全跑在**渲染主线程**上。既要证明它在真实规模下**正确**，也要证明它**不卡死**、
 *   且**不会因超预算降级而错乱**（代码里有三层预算 MAX_LCS_LINES / MAX_INLINE_PRODUCT /
 *   MAX_INLINE_BUDGET，但预算够不够必须用真实数据实测）。
 *
 * 本探针不依赖 Electron / CDP —— 纯 Node 直接 import 被测模块，
 *   与浏览器里跑的是**同一份源码**（ESM，无打包差异）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { diffContentForDisplay, splitDiffLines } from '../../js/utils/textDiff.js';

const L = 'D:/TkDmGzq/_wb500';
const A_FILE = '炎孕-异世界工口学院物语-威力加强版 世界书.json';

const readWb = (f) => {
    const d = JSON.parse(fs.readFileSync(path.join(L, f), 'utf8'));
    return Array.isArray(d.entries) ? d.entries : Object.values(d.entries);
};

const base = readWb(A_FILE);
const vA = readWb('炎孕-改写A.json');
const vB = readWb('炎孕-改写B.json');
const vC = readWb('炎孕-改写C.json');
const vD = readWb('炎孕-改写D.json');

console.log(`基准 ${base.length} 词条 ｜ 改写A ${vA.length} ｜ B ${vB.length} ｜ C ${vC.length} ｜ D ${vD.length}`);

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };
const info = (n, d = '') => console.log(`ℹ️  ${n}${d ? '  → ' + d : ''}`);

const hlCount = (rows) => {
    let n = 0;
    for (const r of rows) for (const side of [r.a, r.b]) if (side && side.segs) for (const s of side.segs) if (s.hl) n++;
    return n;
};

// ── ① 改写A：词条 0 正文**尾部追加一段**（真实长正文 2984 字符）──
console.log('\n───── ① 改写A：词条 0 尾部追加（真实 2984 字符）─────');
const t0 = performance.now();
const rA = diffContentForDisplay(base[0].content, vA[0].content);
const msA = performance.now() - t0;
info(`耗时 ${msA.toFixed(1)}ms`, `行数 ${rA.rows.length}，${JSON.stringify(rA.stats)}，行内高亮段 ${hlCount(rA.rows)}`);
// ⚠️ 断言不要写窄：「尾部追加」的正确语义是 **added**（新增行），不是 changed。
//    若把「没有 changed」判为失败，就会误报（v1 踩过）。
check('尾部追加 → 报为 added（不是 changed）', rA.stats.added > 0 && rA.stats.removed === 0, JSON.stringify(rA.stats));
check('未误报为 changed', rA.stats.changed === 0, `changed=${rA.stats.changed}`);
check('未触发降级（truncated=false）', rA.stats.truncated === false);
check('耗时可控（<200ms）', msA < 200, `${msA.toFixed(1)}ms`);

// ── ①b ★ 真正「修改已有行」：中段某行替换 → 必须报 changed + 行内高亮 ──
console.log('\n───── ①b ★ 中段改行（真正 changed + 行内高亮）─────');
{
    const a0 = base[0].content;
    const lines = a0.split('\n');
    const mid = Math.floor(lines.length / 2);
    const before = lines[mid];
    lines[mid] = before + '（本行中段被改写）';
    const t = performance.now();
    const r = diffContentForDisplay(a0, lines.join('\n'));
    const ms = performance.now() - t;
    info(`耗时 ${ms.toFixed(1)}ms`, `行数 ${r.rows.length}，${JSON.stringify(r.stats)}，行内高亮段 ${hlCount(r.rows)}`);
    check('中段改行 → 报为 changed', r.stats.changed > 0, `changed=${r.stats.changed}`);
    check('中段改行 → 行内精确高亮生效', hlCount(r.rows) > 0, `${hlCount(r.rows)} 段`);
    check('中段改行 → 未大面积假阳性（仅 1 处改动）',
        r.stats.changed + r.stats.added + r.stats.removed <= 3,
        `changed=${r.stats.changed} added=${r.stats.added} removed=${r.stats.removed}`);
}

// ── ② 改写B：新增 2 词条 ──
console.log('\n───── ② 改写B：新增词条 ─────');
const newOnes = vB.filter(e => e.uid >= 900000);
info('新增词条数', String(newOnes.length));
const rB = diffContentForDisplay('', newOnes[0].content);
check('空 → 新内容 全部标为 added', rB.stats.added > 0 && rB.stats.removed === 0, JSON.stringify(rB.stats));
check('新增词条数 = 2', newOnes.length === 2, String(newOnes.length));

// ── ③ 改写C：删掉 3 词条 ──
console.log('\n───── ③ 改写C：删除词条（下标 3/4/5）─────');
info('被删词条', base.slice(3, 6).map(e => e.comment).join(' / '));
check('基准 397 条 → 改写C 394 条', base.length === 397 && vC.length === 394, `${base.length} → ${vC.length}`);
const rC = diffContentForDisplay(base[3].content, '');
check('内容 → 空 全部标为 removed', rC.stats.removed > 0 && rC.stats.added === 0, JSON.stringify(rC.stats));

// ── ④ 改写D：key 追加 + 中段插入行 + 删一行 ──
console.log('\n───── ④ 改写D：词条 5 改 key + 中段插删行 ─────');
info('key 变化', `${JSON.stringify(base[5].key)} → ${JSON.stringify(vD[5].key)}`);
check('key 确实多了「压力测试触发词」', Array.isArray(vD[5].key) && vD[5].key.includes('压力测试触发词'));
const t1 = performance.now();
const rD = diffContentForDisplay(base[5].content, vD[5].content);
const msD = performance.now() - t1;
info(`耗时 ${msD.toFixed(1)}ms`, `行数 ${rD.rows.length}，${JSON.stringify(rD.stats)}，行内高亮段 ${hlCount(rD.rows)}`);
// ⚠️ 改写D 是「中段插一行 + 删一行」→ 正确语义是 **added + removed**（不是 changed）。
//    断言应为「增删合计命中 1 处改动」，而不是要求出现 changed。
check('中段插删行 → 报为 added + removed', rD.stats.added + rD.stats.removed > 0,
    `added=${rD.stats.added} removed=${rD.stats.removed}`);
check('中段插删行 → 未大面积假阳性（增删合计 ≤ 3）', rD.stats.added + rD.stats.removed + rD.stats.changed <= 3,
    `added=${rD.stats.added} removed=${rD.stats.removed} changed=${rD.stats.changed}`);
check('耗时可控（<200ms）', msD < 200, `${msD.toFixed(1)}ms`);

// ── ⑤ 相同文本：假阳性检查 ──
console.log('\n───── ⑤ 相同文本（假阳性检查）─────');
const rSame = diffContentForDisplay(base[0].content, base[0].content);
check('相同文本 → 全 same，无任何变更',
    rSame.stats.same === rSame.rows.length && rSame.stats.changed + rSame.stats.added + rSame.stats.removed === 0,
    JSON.stringify(rSame.stats));
check('相同文本 → 零行内高亮', hlCount(rSame.rows) === 0, `${hlCount(rSame.rows)} 段`);

// ── ⑥ 全篇拼接（UI 的「词条正文总集比对」就是这么做的）──
console.log('\n───── ⑥ 全篇拼接比对（单点改动）─────');
const fullA = base.map(e => e.content || '').join('\n');
const fullA2 = vA.map(e => e.content || '').join('\n');
const fullC = vC.map(e => e.content || '').join('\n');
const fullLines = splitDiffLines(fullA).length;
info('全篇规模', `${(fullA.length / 1048576).toFixed(2)}M 字符，${fullLines} 行（MAX_LCS_LINES=1500）`);
const t2 = performance.now();
const rFull = diffContentForDisplay(fullA, fullA2);
const msFull = performance.now() - t2;
info(`「仅 1 条改动」全篇耗时 ${(msFull / 1000).toFixed(2)}s`, `行数 ${rFull.rows.length}，truncated=${rFull.stats.truncated}，${JSON.stringify(rFull.stats)}`);
const t3 = performance.now();
const rFullC = diffContentForDisplay(fullA, fullC);
const msFullC = performance.now() - t3;
info(`「删 3 条」全篇耗时 ${(msFullC / 1000).toFixed(2)}s`, `truncated=${rFullC.stats.truncated}，${JSON.stringify(rFullC.stats)}`);
check('全篇比对不卡死（<10s）', msFull < 10000, `${(msFull / 1000).toFixed(2)}s`);
check('全篇比对未丢行', rFull.rows.length >= fullLines, `${rFull.rows.length} vs ${fullLines}`);

// ── ⑦ ★ 分散改动：首尾各改一处 → 撑爆 LCS 预算，检查是否错乱 ──
console.log('\n───── ⑦ ★ 分散改动（首尾各改一处）—— LCS 预算边界 ─────');
const spread = base.map(e => ({ ...e }));
spread[0] = { ...spread[0], content: spread[0].content + '\n【首部改动】' };
spread[base.length - 1] = { ...spread[base.length - 1], content: spread[base.length - 1].content + '\n【尾部改动】' };
const fullSpread = spread.map(e => e.content || '').join('\n');
const t4 = performance.now();
const rSpread = diffContentForDisplay(fullA, fullSpread);
const msSpread = performance.now() - t4;
info(`耗时 ${(msSpread / 1000).toFixed(2)}s`, `行数 ${rSpread.rows.length}，truncated=${rSpread.stats.truncated}`);
info('统计', JSON.stringify(rSpread.stats));
// 真实改动量：2 行新增（首尾各 1 行）。若报出的变更行远超此数 → 降级导致假阳性/错乱
const noise = rSpread.stats.changed + rSpread.stats.added + rSpread.stats.removed;
info(`实际改动 2 行，算法报出变更/增删 ${noise} 行`, `放大倍数 ≈ ${(noise / 2).toFixed(0)}×`);
check('全篇规模确实超过 LCS 预算（>=1500 行）', fullLines >= 1500, `${fullLines} 行`);
check('分散改动触发降级（truncated=true，符合设计）', rSpread.stats.truncated === true);
check('★ 降级后无大面积假阳性（变更行 < 全篇行数 1%）', noise < fullLines * 0.01,
    `报出 ${noise} 行 / 全篇 ${fullLines} 行 = ${(noise / fullLines * 100).toFixed(2)}%`);

const pass = results.filter(r => r.ok).length;
console.log(`\n═════ 差异算法真实数据验证：${pass}/${results.length} 通过 ═════`);
console.log(`耗时：单条正文 A=${msA.toFixed(1)}ms ｜ D=${msD.toFixed(1)}ms ｜ 全篇(1处)=${(msFull / 1000).toFixed(2)}s ｜ 全篇(分散2处)=${(msSpread / 1000).toFixed(2)}s`);
process.exit(pass === results.length ? 0 : 1);
