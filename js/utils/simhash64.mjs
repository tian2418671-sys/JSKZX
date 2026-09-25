/**
 * 🧬 64 位 simhash —— **权威实现（v4 §12 单源化）**
 *
 * ═══════════════════════════════════════════════════════════════
 * 📌 来源与约束
 * ─────────────────────────────────────────────────────────────
 * · 本文件的 `computeSimhash64` 与 `simhashInputOf` **函数体逐字搬移自 `main.js`**
 *   （2026-09-25 前的权威实现；口径：char 4-gram + 采样 step=4 + 双 32 位 Math.imul）。
 * · 世界书 L1 落盘值由此口径产出；**任何改动都会让已落盘的 `simhash` 失去可比性**
 *   ⇒ 行为由 `test/simhashParity.test.mjs` 的 golden vectors 锁定（改动即测试挂）。
 * · 渲染层（Vite）与测试（node --test）均 import 本文件；主进程接线方式见 v4 §12。
 *
 * ⚠️ 输入归一化（`simhashInputOf`）与渲染层 `extractContentText`（世界书分支）同口径：
 *    `"${keys} ${content}"` 逐条拼接 → `\s+`→空格 → 非字母数字→空格 → 小写 → trim。
 *    改这里必须同步评估「落盘值 vs 运行时值」的一致性影响。
 */

export const SIMHASH_N = 4;
export const SIMHASH_STEP = 4;

/** 🧬 64 位 simhash（number 双 32 位） */
export function computeSimhash64(text) {
  const v = new Int32Array(64);
  const len = text.length;
  const n = SIMHASH_N, step = SIMHASH_STEP;
  for (let i = 0; i + n <= len; i += step) {
    let lo = 0x811c9dc5 >>> 0, hi = 0x01000193 >>> 0;
    for (let k = 0; k < n; k++) {
      const c = text.charCodeAt(i + k);
      lo = Math.imul(lo ^ c, 0x01000193) >>> 0;
      hi = Math.imul(hi ^ c, 0x01000193) >>> 0;
    }
    for (let b = 0; b < 32; b++) {
      v[b] += ((lo >>> b) & 1) ? 1 : -1;
      v[b + 32] += ((hi >>> b) & 1) ? 1 : -1;
    }
  }
  let outLo = 0, outHi = 0;
  for (let b = 0; b < 32; b++) {
    if (v[b] > 0) outLo |= (1 << b);
    if (v[b + 32] > 0) outHi |= (1 << b);
  }
  return [outLo >>> 0, outHi >>> 0];
}

/**
 * 🧬 从 entries 构造 simhash 的**输入文本**（与渲染层同口径）。
 * ⚠️ 口径对齐见文件头注释。
 */
export function simhashInputOf(entries) {
  return entries.map(e => {
    if (!e || typeof e !== 'object') return '';
    const keys = Array.isArray(e.key) ? e.key.join(',') : (e.key || '');
    return `${keys} ${e.content || ''}`;
  }).join('\n')
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .trim();
}

/** 64 位汉明距离（输入为 `[lo, hi]` 双 32 位数组；任一缺失返回 64） */
export function hammingDistance64(a, b) {
  if (!a || !b || a.length < 2 || b.length < 2) return 64;
  let v1 = (a[0] ^ b[0]) >>> 0;
  let v2 = (a[1] ^ b[1]) >>> 0;
  let c = 0;
  while (v1) { v1 &= v1 - 1; c++; }
  while (v2) { v2 &= v2 - 1; c++; }
  return c;
}
