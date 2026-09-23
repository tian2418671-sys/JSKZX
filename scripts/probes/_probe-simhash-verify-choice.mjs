/**
 * 修法选型：simhash 预筛后，用哪种复核最准且内存安全？（离线，纯 Node）
 *
 * 候选复核手段：
 *   A. 真实 4-gram Jaccard —— 最准，但需要正文（与「算完即丢」的内存优化冲突）
 *   B. **MinHash（96 维）+ estimateSimilarity** —— 只需 96 个 int/本，内存安全，项目已有实现
 *   C. simhash 换 step=1（不采样）—— 检验退化是否由采样引起
 *
 * 判据：对每个候选对，比较三种复核与「真实 Jaccard ≥ 0.85」的一致性。
 *
 * 用法：node scripts/probes/_probe-simhash-verify-choice.mjs [目录]
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'H:\\01\\全局世界书';
const T_SIMHASH = 19;      // 预筛阈值（宽松）
const T_JACCARD = 0.85;    // 真重复判据

const N4 = 4;
function simhashOf(text, step) {
    const v = new Int32Array(64);
    for (let i = 0; i + N4 <= text.length; i += step) {
        let lo = 0x811c9dc5 >>> 0, hi = 0x01000193 >>> 0;
        for (let k = 0; k < N4; k++) {
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

// ── 项目现有 MinHash 实现（逐字复刻 useDedupe.js）──
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
    items.push({
        name: f.replace(/\.json$/i, ''), len: norm.length, sh,
        sig4: simhashOf(norm, 4), sig1: simhashOf(norm, 1), mh: minhashOf(sh)
    });
}
console.log(`═════ 修法选型 · ${DIR} ═════`);
console.log(`参与：${items.length} 本\n`);

// 候选对：simhash(step=4) ≤ 19（即当前实现会判为重复的）
const cand = [];
for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
    if (ham(items[a].sig4, items[b].sig4) <= T_SIMHASH) cand.push({ a, b });
}
console.log(`【候选对】当前实现（simhash step=4, T=19）判为重复的：${cand.length} 对\n`);
console.log('  真值Jaccard  simhash(step4)  simhash(step1)  MinHash估计   MinHash复核判定  真实判定');
console.log('  ──────────────────────────────────────────────────────────────────────────────────────────');
let mhTP = 0, mhFP = 0, mhFN = 0, s1TP = 0, s1FP = 0, s1FN = 0;
for (const p of cand) {
    const A = items[p.a], B = items[p.b];
    const trueJ = jac(A.sh, B.sh);
    const d4 = ham(A.sig4, B.sig4);
    const d1 = ham(A.sig1, B.sig1);
    const mh = estSim(A.mh, B.mh);
    const truth = trueJ >= T_JACCARD;
    const mhVerdict = mh >= T_JACCARD;
    const s1Verdict = d1 <= 12;   // 试探：step=1 是否可用更紧阈值
    if (truth && mhVerdict) mhTP++; if (!truth && mhVerdict) mhFP++; if (truth && !mhVerdict) mhFN++;
    if (truth && s1Verdict) s1TP++; if (!truth && s1Verdict) s1FP++; if (truth && !s1Verdict) s1FN++;
    console.log(`  ${(trueJ * 100).toFixed(1).padStart(9)}%  ${String(d4).padStart(12)}  ${String(d1).padStart(13)}  ${(mh * 100).toFixed(1).padStart(10)}%  ${(mhVerdict ? '✅保留' : '❌剔除').padEnd(14)} ${truth ? '✅真重复' : '❌误判'}`);
    console.log(`           『${A.name}』 ↔ 『${B.name}』`);
}
console.log('');
console.log(`【MinHash 复核】TP=${mhTP} FP=${mhFP} FN=${mhFN}  →  ${mhFP === 0 && mhFN === 0 ? '✅ 零误报零漏报' : '⚠️ 有误差'}`);
console.log(`【simhash step=1 + T=12】TP=${s1TP} FP=${s1FP} FN=${s1FN}  →  ${s1FP === 0 && s1FN === 0 ? '✅ 零误报零漏报' : '⚠️ 有误差'}`);

// 全库尺度：MinHash 复核会漏报多少真重复（不受 simhash 预筛限制）
let totalTrue = 0, missedByPrefilter = 0;
for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
    if (jac(items[a].sh, items[b].sh) >= T_JACCARD) {
        totalTrue++;
        if (ham(items[a].sig4, items[b].sig4) > T_SIMHASH) missedByPrefilter++;
    }
}
console.log(`\n【预筛完整性】全库真重复 ${totalTrue} 对，其中被 simhash(T=19) 预筛漏掉 ${missedByPrefilter} 对  →  ${missedByPrefilter === 0 ? '✅ 预筛无漏（复核可兜住）' : '❌ 预筛会漏真重复'}`);
