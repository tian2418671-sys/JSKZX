/**
 * 文本差异（用于「词条正文」对比着色）
 *
 * 为什么需要它：`DiffModal` 的词条对比区原先**直接输出纯文本**（`text-zinc-400`），
 * 没有任何行级着色 —— 正文一长、或只改了几个字，肉眼完全看不出差异。
 * 而通用分支用的 `computeTextDiffLines`（`useDedupe.js`）是「按标点切块 + 集合匹配」：
 *   · 不保留位置信息（同一句出现在别处就算「相同」）；
 *   · 两侧是**各自独立的滚动容器** → 行与行对不齐。
 *
 * 本模块输出「**行对齐的双列 diff**」：
 *   · 行级 LCS 对齐（先剥公共前缀/后缀行，再做中间段 LCS，规模可控）；
 *   · 变更块内的「删 + 增」按顺序**配成一对 `changed`**，而不是拆成两条独立记录；
 *   · 对 `changed` 行再做**行内 token 级高亮**（CJK 按单字、拉丁按整词），
 *     这样「一行里只改了几个字」也能精确定位；
 *   · 两侧行号一一对应，组件只需顺序渲染即可**天然对齐**。
 *
 * 性能保护（长正文不能卡死主线程）：
 *   · 行级 LCS 超过 `MAX_LCS_LINES` → 退化为「按位置逐行比对」并置 `truncated`；
 *   · 单行行内 LCS 的规模积超过 `MAX_INLINE_PRODUCT` → 该行整段标记，不做精细拆分；
 *   · 全篇行内精细比对有总预算 `MAX_INLINE_BUDGET`，超出后自动降级为整段标记。
 *
 * @typedef {{text: string, hl: boolean}} Seg    渲染片段（hl = 是否高亮）
 * @typedef {{text: string, no: number, segs: Seg[]}} SideRow  一侧的行内容
 * @typedef {{kind: 'same'|'removed'|'added'|'changed', a: SideRow|null, b: SideRow|null}} DiffRow
 */

const MAX_LCS_LINES = 1500;          // 行级 LCS 的最大行数（超出退化为按位置比对）
const MAX_INLINE_PRODUCT = 250000;   // 单行行内 LCS 的最大「长度积」（超出整段标记）
const MAX_INLINE_BUDGET = 3000000;   // 全篇行内精细比对的总预算（超出降级为整段标记）

/** 按换行拆行（统一 `\r\n` / `\r` → `\n`）；空文本返回空数组 */
export function splitDiffLines(text) {
    const s = text == null ? '' : String(text);
    if (!s) return [];
    return s.replace(/\r\n?/g, '\n').split('\n');
}

const isCjkCode = (c) => (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf);
const isWordCode = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;

/**
 * 行内分词：拉丁/数字按**整词**成 token，CJK 与标点按**单字符**成 token。
 * 为什么不用纯字符级：英文里改一个字母会把整个单词拆碎，高亮看起来像噪点；
 * 按词成 token 后 `system` → `systen` 会整词标红，更符合直觉。
 */
function tokenizeInline(s) {
    const toks = [];
    let i = 0;
    while (i < s.length) {
        if (isWordCode(s.charCodeAt(i))) {
            let j = i;
            while (j < s.length && isWordCode(s.charCodeAt(j))) j++;
            toks.push({ text: s.slice(i, j), start: i });
            i = j;
        } else {
            toks.push({ text: s[i], start: i });
            i++;
        }
    }
    return toks;
}

/** 把「未匹配的 token」聚成 `[start, end)` 区段；相邻区段间隔 ≤1 字符时合并，减少碎片 */
function tokenRuns(toks, matched) {
    const runs = [];
    let cur = null;
    for (let i = 0; i < toks.length; i++) {
        if (matched[i]) {
            if (cur) { runs.push(cur); cur = null; }
            continue;
        }
        const start = toks[i].start;
        const end = toks[i].start + toks[i].text.length;
        if (cur && start - cur[1] <= 1) cur[1] = end;     // 邻近变更合并
        else { if (cur) runs.push(cur); cur = [start, end]; }
    }
    if (cur) runs.push(cur);
    return runs;
}

/** token 级 LCS，返回两侧「未匹配区段」；规模超限返回 null（由调用方整段标记） */
function inlineMarks(midA, midB) {
    const ta = tokenizeInline(midA);
    const tb = tokenizeInline(midB);
    const n = ta.length;
    const m = tb.length;
    if (!n || !m) return null;
    if (n * m > MAX_INLINE_PRODUCT) return null;
    const W = m + 1;
    const dp = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
        const at = ta[i].text;
        for (let j = m - 1; j >= 0; j--) {
            dp[i * W + j] = at === tb[j].text
                ? dp[(i + 1) * W + (j + 1)] + 1
                : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
        }
    }
    const okA = new Uint8Array(n);
    const okB = new Uint8Array(m);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (ta[i].text === tb[j].text) { okA[i] = 1; okB[j] = 1; i++; j++; }
        else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) i++;
        else j++;
    }
    return { marksA: tokenRuns(ta, okA), marksB: tokenRuns(tb, okB) };
}

/** 把「行内区段」切成渲染片段（`hl:true` 的段由组件加高亮底色） */
function buildSegs(text, marks) {
    if (!marks || !marks.length) return [{ text, hl: false }];
    const segs = [];
    let pos = 0;
    for (const [start, end] of marks) {
        if (start > pos) segs.push({ text: text.slice(pos, start), hl: false });
        if (end > start) segs.push({ text: text.slice(start, end), hl: true });
        pos = end;
    }
    if (pos < text.length) segs.push({ text: text.slice(pos), hl: false });
    return segs;
}

function mkSide(text, no, marks) {
    return { text, no, segs: buildSegs(text, marks) };
}

/**
 * 单行差异：先剥公共前缀/后缀，再对中间段做 token 级 LCS。
 * 剥前后缀是关键优化 —— 大部分「小改动」的中间段很短，LCS 规模因此很小。
 */
function diffOneLine(lineA, lineB, budget) {
    const a = lineA;
    const b = lineB;
    if (a === b) return { marksA: [], marksB: [] };
    if (!a) return { marksA: [], marksB: [[0, b.length]] };
    if (!b) return { marksA: [[0, a.length]], marksB: [] };

    const maxPre = Math.min(a.length, b.length);
    let pre = 0;
    while (pre < maxPre && a[pre] === b[pre]) pre++;
    const maxSuf = Math.min(a.length, b.length) - pre;
    let suf = 0;
    while (suf < maxSuf && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

    const midA = a.slice(pre, a.length - suf);
    const midB = b.slice(pre, b.length - suf);
    const spanA = [pre, a.length - suf];
    const spanB = [pre, b.length - suf];
    const coarse = () => ({
        marksA: midA.length ? [spanA] : [],
        marksB: midB.length ? [spanB] : []
    });
    if (!midA.length || !midB.length) return coarse();

    const cost = midA.length * midB.length;
    if (cost > MAX_INLINE_PRODUCT || budget.left < cost) return coarse();
    budget.left -= cost;

    const fine = inlineMarks(midA, midB);
    if (!fine) return coarse();
    const shift = (runs) => runs.map(([s0, e0]) => [s0 + pre, e0 + pre]);
    // ⚠️ 关键：**空 marks 表示「这一侧没有变更」，不能再回退成「整段标记」**。
    //    反例：`你好世界` vs `你好，世界！` —— 左版原样保留，只是右版插入了标点。
    //    若此时把左版整段标红，用户会以为「左版改了」，属误报（且是最容易被投诉的那类错）。
    //    （「LCS 完全失败」的情形已由上面的 `coarse()` 分支处理，不会走到这里。）
    return { marksA: shift(fine.marksA), marksB: shift(fine.marksB) };
}

/** 行级 LCS（带回溯）。仅在规模受控时调用 */
function lcsOps(a, b) {
    const n = a.length;
    const m = b.length;
    if (!n) return b.map((_, j) => ({ type: 'ins', aIdx: -1, bIdx: j }));
    if (!m) return a.map((_, i) => ({ type: 'del', aIdx: i, bIdx: -1 }));
    const W = m + 1;
    const dp = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
        const ai = a[i];
        for (let j = m - 1; j >= 0; j--) {
            dp[i * W + j] = ai === b[j]
                ? dp[(i + 1) * W + (j + 1)] + 1
                : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
        }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push({ type: 'same', aIdx: i, bIdx: j }); i++; j++; }
        else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) { ops.push({ type: 'del', aIdx: i, bIdx: -1 }); i++; }
        else { ops.push({ type: 'ins', aIdx: -1, bIdx: j }); j++; }
    }
    while (i < n) ops.push({ type: 'del', aIdx: i++, bIdx: -1 });
    while (j < m) ops.push({ type: 'ins', aIdx: -1, bIdx: j++ });
    return ops;
}

/** 超长文本的降级策略：按位置逐行比对（O(n)，保证两侧仍严格对齐） */
function positionalOps(a, b) {
    const ops = [];
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (i < a.length && i < b.length) {
            if (a[i] === b[i]) ops.push({ type: 'same', aIdx: i, bIdx: i });
            else {
                ops.push({ type: 'del', aIdx: i, bIdx: -1 });
                ops.push({ type: 'ins', aIdx: -1, bIdx: i });
            }
        } else if (i < a.length) ops.push({ type: 'del', aIdx: i, bIdx: -1 });
        else ops.push({ type: 'ins', aIdx: -1, bIdx: i });
    }
    return ops;
}

/** 把 ops 转成「行对齐」的输出行；变更块内的删/增按顺序配对为 `changed` */
function appendRows(rows, ops, midA, midB, offA, offB, budget, stats) {
    let i = 0;
    while (i < ops.length) {
        if (ops[i].type === 'same') {
            const o = ops[i];
            rows.push({
                kind: 'same',
                a: mkSide(midA[o.aIdx], offA + o.aIdx + 1),
                b: mkSide(midB[o.bIdx], offB + o.bIdx + 1)
            });
            stats.same++;
            i++;
            continue;
        }
        // 收集连续的「删 / 增」块
        const dels = [];
        const inss = [];
        while (i < ops.length && ops[i].type !== 'same') {
            if (ops[i].type === 'del') dels.push(ops[i].aIdx);
            else inss.push(ops[i].bIdx);
            i++;
        }
        const pairN = Math.min(dels.length, inss.length);
        for (let k = 0; k < pairN; k++) {
            const ai = dels[k];
            const bi = inss[k];
            const { marksA, marksB } = diffOneLine(midA[ai], midB[bi], budget);
            rows.push({
                kind: 'changed',
                a: mkSide(midA[ai], offA + ai + 1, marksA),
                b: mkSide(midB[bi], offB + bi + 1, marksB)
            });
            stats.changed++;
        }
        for (let k = pairN; k < dels.length; k++) {
            rows.push({ kind: 'removed', a: mkSide(midA[dels[k]], offA + dels[k] + 1), b: null });
            stats.removed++;
        }
        for (let k = pairN; k < inss.length; k++) {
            rows.push({ kind: 'added', a: null, b: mkSide(midB[inss[k]], offB + inss[k] + 1) });
            stats.added++;
        }
    }
}

/**
 * 主入口：生成「行对齐」的差异行。
 *
 * @param {string} textA 左版（推荐保留版）文本
 * @param {string} textB 右版（对比版）文本
 * @returns {{rows: DiffRow[], stats: {same:number, removed:number, added:number, changed:number, aLines:number, bLines:number, truncated:boolean}}}
 *   `rows` 已按「左行 / 右行一一对应」排好，组件顺序渲染即可天然对齐；
 *   某侧缺失时该侧为 `null`（渲染成占位空格，保持另一侧的行不错位）。
 */
export function diffContentForDisplay(textA = '', textB = '') {
    const A = splitDiffLines(textA);
    const B = splitDiffLines(textB);
    const rows = [];
    const stats = { same: 0, removed: 0, added: 0, changed: 0, aLines: A.length, bLines: B.length, truncated: false };
    if (!A.length && !B.length) return { rows, stats };

    // ① 公共前缀行（逐行相等）
    let p = 0;
    while (p < A.length && p < B.length && A[p] === B[p]) p++;
    // ② 公共后缀行（不与前缀重叠）
    let s = 0;
    while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;

    const pushSame = (ai, bi) => {
        rows.push({
            kind: 'same',
            a: mkSide(A[ai], ai + 1),
            b: mkSide(B[bi], bi + 1)
        });
        stats.same++;
    };
    for (let k = 0; k < p; k++) pushSame(k, k);

    // ③ 中间段：LCS（规模受控，超限降级）
    const midA = A.slice(p, A.length - s);
    const midB = B.slice(p, B.length - s);
    let midOps;
    if (midA.length > MAX_LCS_LINES || midB.length > MAX_LCS_LINES) {
        stats.truncated = true;
        midOps = positionalOps(midA, midB);
    } else {
        midOps = lcsOps(midA, midB);
    }
    appendRows(rows, midOps, midA, midB, p, p, { left: MAX_INLINE_BUDGET }, stats);

    // ④ 公共后缀行
    for (let k = 0; k < s; k++) pushSame(A.length - s + k, B.length - s + k);

    return { rows, stats };
}
