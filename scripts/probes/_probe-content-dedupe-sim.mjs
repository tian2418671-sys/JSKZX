/**
 * 修法算法仿真：簇心校验 + MinHash 复核（离线，纯 Node）
 *
 * 目的：在**改生产代码之前**先用真实库验证算法，避免「改完再测」的返工与假绿。
 *
 * 对比三种算法在真实库上的表现（真值 = 真实 4-gram Jaccard ≥ 0.85）：
 *   ① 现状：simhash T=19 + 朴素 Union-Find
 *   ② 只收紧阈值：simhash T=16 + 朴素 Union-Find
 *   ③ 新算法：simhash T=16 预筛 + **MinHash 复核** + **簇心校验**（防链式误聚）
 *
 * 用法：node scripts/probes/_probe-content-dedupe-sim.mjs [目录]
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'H:\\01\\全局世界书';
const SIMHASH_N = 4, SIMHASH_STEP = 4;
const T_OLD = 19, T_NEW = 16;
const CONTENT_SIM = 0.85;   // MinHash 复核阈值（与应用既有 THRESHOLD 同口径）

function simhashOf(text) {
    const v = new Int32Array(64);
    for (let i = 0; i + SIMHASH_N <= text.length; i += SIMHASH_STEP) {
        let lo = 0x811c9dc5 >>> 0, hi = 0x01000193 >>> 0;
        for (let k = 0; k < SIMHASH_N; k++) {
            const c = text.charCodeAt(i + k);
            lo = Math.imul(lo ^ c, 0x01000193) >>> 0;
            hi = Math.imul(hi ^ c, 0x01000193) >>> 0;
        }
        for (let b = 0; b < 32; b++) { v[b] += ((lo >>> b) & 1) ? 1 : -1; v[b + 32] += ((hi >>> b) & 1) ? 1 : -1; }
    }
    let a = 0, b2 = 0;
    for (let b = 0; b < 32; b++) { if (v[b] > 0) a |= (1 << b); if (v[b + 32] > 0) b2 |= (1 << b); }
    return [a >>> 0, b2 >>> 0];
}
const ham = (a, b) => { let x = (a[0] ^ b[0]) >>> 0, y = (a[1] ^ b[1]) >>> 0, c = 0; while (x) { c += x & 1; x >>>= 1; } while (y) { c += y & 1; y >>>= 1; } return c; };
const normalize = (t) => String(t || '').replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().trim();
const contentTextOf = (e) => e.map(x => { if (!x || typeof x !== 'object') return ''; const k = Array.isArray(x.key) ? x.key.join(',') : (x.key || ''); return `${k} ${x.content || ''}`; }).join('\n');
const shingles = (t) => { const s = new Set(); for (let i = 0; i + 4 <= t.length; i++) s.add(t.slice(i, i + 4)); return s; };
const jac = (A, B) => { let i = 0; const [s, b] = A.size <= B.size ? [A, B] : [B, A]; for (const x of s) if (b.has(x)) i++; return i / (A.size + B.size - i); };

const MINHASH_HASHES = 96;
const seeds = (() => { const s = []; let x = 0x9e3779b9; for (let i = 0; i < MINHASH_HASHES; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s.push(x); } return s; })();
const hashString = (str, seed) => { let h = seed >>> 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; return h; };
const minhashOf = (sh) => { const sig = new Array(MINHASH_HASHES).fill(0x7fffffff); sh.forEach(x => { for (let i = 0; i < MINHASH_HASHES; i++) { const h = hashString(x, seeds[i]); if (h < sig[i]) sig[i] = h; } }); return sig; };
const estSim = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) if (a[i] === b[i]) s++; return s / a.length; };

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
const items = [];
for (const f of files) {
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
    let e = raw && raw.entries;
    if (e && !Array.isArray(e) && typeof e === 'object') e = Object.values(e);
    if (!Array.isArray(e)) continue;
    const norm = normalize(contentTextOf(e));
    if (norm.length < 20) continue;
    const sh = shingles(norm);
    items.push({ name: f.replace(/\.json$/i, ''), len: norm.length, sh, sig: simhashOf(norm), mh: minhashOf(sh) });
}

// ── 真值：Jaccard ≥ 0.85 的对 ──
const truth = new Set();
for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
    if (jac(items[a].sh, items[b].sh) >= CONTENT_SIM) truth.add(`${a}:${b}`);
}

/** 朴素 Union-Find（现状） */
function clusterNaive(T, useMh) {
    const p = items.map((_, i) => i);
    const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
    for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
        if (ham(items[a].sig, items[b].sig) > T) continue;
        if (useMh && estSim(items[a].mh, items[b].mh) < CONTENT_SIM) continue;
        const ra = find(a), rb = find(b); if (ra !== rb) p[rb] = ra;
    }
    return groupsOf(find);
}
/** 簇心校验 Union-Find（新算法）：合并前要求与双方**簇心**都在阈值内 */
function clusterCentroid(T, useMh) {
    const p = items.map((_, i) => i);
    const rep = items.map((_, i) => i);           // 簇心（用正文最长者）
    const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
    const gate = (x, y) => {
        if (ham(items[x].sig, items[y].sig) > T) return false;
        if (useMh && estSim(items[x].mh, items[y].mh) < CONTENT_SIM) return false;
        return true;
    };
    for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
        const ra = find(a), rb = find(b);
        if (ra === rb) continue;
        // 与双方簇心都要通过（防链式：A~B~C 但 A~C 远）
        if (!gate(rep[ra], b) || !gate(rep[rb], a)) continue;
        // 合并；新簇心取正文更长者
        const newRep = items[rep[ra]].len >= items[rep[rb]].len ? rep[ra] : rep[rb];
        p[rb] = ra; rep[ra] = newRep;
    }
    return groupsOf(find);
}
function groupsOf(find) {
    const m = new Map();
    items.forEach((_, i) => { const r = find(i); if (!m.has(r)) m.set(r, []); m.get(r).push(i); });
    return [...m.values()].filter(g => g.length >= 2);
}
/** 评估：组内两两是否都为真重复 */
function evaluate(label, groups) {
    let pairs = 0, bad = 0;
    const badList = [];
    for (const g of groups) {
        for (let x = 0; x < g.length; x++) for (let y = x + 1; y < g.length; y++) {
            pairs++;
            const k = g[x] < g[y] ? `${g[x]}:${g[y]}` : `${g[y]}:${g[x]}`;
            if (!truth.has(k)) { bad++; badList.push(`『${items[g[x]].name}』↔『${items[g[y]].name}』 (真实Jaccard ${(jac(items[g[x]].sh, items[g[y]].sh) * 100).toFixed(1)}%)`); }
        }
    }
    // 召回：真值对里有多少被分到同组
    let recalled = 0;
    for (const k of truth) { const [a, b] = k.split(':').map(Number); if (findOf(groups, a) === findOf(groups, b)) recalled++; }
    const verdict = bad === 0 && recalled === truth.size ? '✅ 零误报零漏报' : `${bad > 0 ? `❌ 误报 ${bad}` : ''}${recalled < truth.size ? ` ⚠️ 漏报 ${truth.size - recalled}` : ''}`;
    console.log(`\n───── ${label} ─────`);
    console.log(`  组数 ${groups.length} ｜ 组内对数 ${pairs} ｜ 真值对 ${truth.size} ｜ 召回 ${recalled}`);
    console.log(`  误报（组内非真重复）：${bad}`);
    badList.slice(0, 6).forEach(s => console.log(`    ❌ ${s}`));
    console.log(`  ⇒ ${verdict}`);
}
function findOf(groups, i) { for (let g = 0; g < groups.length; g++) if (groups[g].includes(i)) return g; return -1; }

console.log(`═════ 修法算法仿真 · ${DIR} ═════`);
console.log(`参与：${items.length} 本 ｜ 真值（Jaccard ≥ ${CONTENT_SIM}）：${truth.size} 对`);
evaluate('① 现状：simhash T=19 + 朴素并查集', clusterNaive(T_OLD, false));
evaluate('② 只收紧阈值：simhash T=16 + 朴素并查集', clusterNaive(T_NEW, false));
evaluate('③ 阈值16 + MinHash复核 + 朴素并查集', clusterNaive(T_NEW, true));
evaluate('④ 新算法：T=16 + MinHash复核 + 簇心校验', clusterCentroid(T_NEW, true));
