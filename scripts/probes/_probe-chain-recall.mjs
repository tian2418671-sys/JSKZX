/**
 * 链式误聚与召回风险 —— 合成场景验证（离线，纯 Node）
 *
 * 目的：验证「簇心校验」在**合法链**下会不会漏报（修 A 坑引入 B 坑）。
 *
 * 场景：
 *   · 合法链：A(100%) ← B(85%) ← C(85%)，但 A~C 仅 70%（B 是共同祖先）
 *     期望：A、B、C 都该被提示（用户视角「都是同一本的版本」）
 *   · 恶性链（应切断）：X、Y 无关，Y~Z 无关，但 X~Y、Y~Z 距离恰好都在阈值内
 *     期望：X 与 Z **不能**同组
 *
 * 用法：node scripts/probes/_probe-chain-recall.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'H:\\01\\全局世界书';
const SIMHASH_N = 4, SIMHASH_STEP = 4, T = 16, CONTENT_SIM = 0.85;

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
const shingles = (t) => { const s = new Set(); for (let i = 0; i + 4 <= t.length; i++) s.add(t.slice(i, i + 4)); return s; };
const jac = (A, B) => { let i = 0; const [s, b] = A.size <= B.size ? [A, B] : [B, A]; for (const x of s) if (b.has(x)) i++; return i / (A.size + B.size - i); };

// 取一本真实书作为语料源
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
let base = null;
for (const f of files) {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
        let e = raw && raw.entries;
        if (e && !Array.isArray(e) && typeof e === 'object') e = Object.values(e);
        if (!Array.isArray(e)) continue;
        const norm = e.map(x => { const k = Array.isArray(x.key) ? x.key.join(',') : (x.key || ''); return `${k} ${x.content || ''}`; })
            .join('\n').replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().trim();
        if (norm.length > 20000 && norm.length < 100000) { base = { name: f, text: norm }; break; }
    } catch { /* skip */ }
}
if (!base) { console.log('未找到合适语料'); process.exit(0); }
console.log(`═════ 链式误聚与召回风险验证 ═════`);
console.log(`语料源：『${base.name}』（${base.text.length} 字）\n`);

// 另一本无关书作为「污染源」
let other = null;
for (const f of files) {
    if (f === base.name) continue;
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
        let e = raw && raw.entries;
        if (e && !Array.isArray(e) && typeof e === 'object') e = Object.values(e);
        if (!Array.isArray(e)) continue;
        const norm = e.map(x => { const k = Array.isArray(x.key) ? x.key.join(',') : (x.key || ''); return `${k} ${x.content || ''}`; })
            .join('\n').replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().trim();
        if (norm.length > 20000 && norm.length < 100000 && jac(shingles(norm), shingles(base.text)) < 0.2) { other = { name: f, text: norm }; break; }
    } catch { /* skip */ }
}

/** 造混合文本：把 A 的 top-p 比例块替换为 B 的块 */
function mix(A, B, p, seed0 = 7) {
    let seed = seed0;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const K = 40, ca = Math.floor(A.length / K), cb = Math.floor(B.length / K);
    const parts = [];
    for (let i = 0; i < K; i++) parts.push(rnd() < p ? B.slice((i % K) * cb, (i % K + 1) * cb) : A.slice(i * ca, (i + 1) * ca));
    return parts.join('');
}

const A = base.text;
const B = other ? other.text : mix(A, A.split('').reverse().join(''), 1);
// 合法链：B 与 A 有 85% 相同；C 与 B 有 85% 相同（但 C 与 A 只有 ~70%）
const tA = A;
const tB = mix(A, B, 0.15, 11);
const tC = mix(tB, B, 0.15, 23);

const items = [
    { n: 'A(原始)', t: tA },
    { n: 'B(85%似A)', t: tB },
    { n: 'C(85%似B)', t: tC },
    { n: 'D(无关)', t: B }
].map(x => ({ ...x, sig: simhashOf(x.t), sh: shingles(x.t) }));

console.log('【样本距离矩阵】');
console.log('        ' + items.map(x => x.n.padEnd(12)).join(''));
for (let i = 0; i < items.length; i++) {
    const row = [];
    for (let j = 0; j < items.length; j++) {
        if (i === j) { row.push('—'.padEnd(12)); continue; }
        const d = ham(items[i].sig, items[j].sig);
        const jj = jac(items[i].sh, items[j].sh);
        row.push(`d${d}/j${(jj * 100).toFixed(0)}%`.padEnd(12));
    }
    console.log(items[i].n.padEnd(8) + row.join(''));
}
console.log('');

// 三种算法
function run(mode) {
    const p = items.map((_, i) => i);
    const rep = items.map((_, i) => i);
    const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
    for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
        const ra = find(a), rb = find(b);
        if (mode !== 'naive' && ra === rb) continue;
        if (ham(items[a].sig, items[b].sig) > T) continue;
        if (mode === 'naive') { if (ra !== rb) p[rb] = ra; continue; }
        // centroid：与双方簇心都要过
        if (ham(items[rep[ra]].sig, items[b].sig) > T) continue;
        if (ham(items[rep[rb]].sig, items[a].sig) > T) continue;
        const newRep = items[rep[ra]].t.length >= items[rep[rb]].t.length ? rep[ra] : rep[rb];
        p[rb] = ra; rep[ra] = newRep;
    }
    const m = new Map();
    items.forEach((_, i) => { const r = find(i); if (!m.has(r)) m.set(r, []); m.get(r).push(i); });
    return [...m.values()].filter(g => g.length >= 2).map(g => g.map(i => items[i].n));
}
console.log('【朴素并查集（现状 T=16）】', JSON.stringify(run('naive')));
console.log('【簇心校验（新算法 T=16）】', JSON.stringify(run('centroid')));
console.log('');
console.log('期望：A/B/C 三者相关（B 是共同祖先）应尽量同组；D 必须独立。');
console.log('⚠️ 若簇心校验把 C 单独拆出 → 说明有召回损失（需权衡）。');
