/**
 * ⚙️ 预设查重 —— **结构指纹与相似类型判定**（纯函数，无副作用）
 *
 * 背景（2026-09-23 评估外部「预设查重方案」后采纳，见
 * `docs/规格与计划/角色卡与预设查重-方案评估.md`）：
 *   现有预设查重（`useDedupe.js` 的 `startPresetDedupeScan`）**只按 `data.name` 聚类**，
 *   ⇒ **不同名的同源预设永远不会进入比较**（漏报）。
 *
 *   📊 真实库实测（`scripts/probes/_probe-preset-struct-power.mjs`）：
 *      · `A.U.T.O.预设 v1.0.json` ↔ `万象枢机 2.5.json` —— **文件名完全不同**，
 *        但 **identifier 结构 Jaccard = 99.3%**（正文 840KB vs 2.66MB）
 *      · 其余 9 对无关预设：结构 2.6% ~ 4.9%
 *      ⇒ 结构指纹**判别力充足**（跨度 96.6 个百分点），能补上「改名同源」这个洞。
 *
 * ⚠️ 与 `similarityType.js` 同款契约（**务必遵守**）：
 *   本模块**只产出标签与分数**，**绝不参与「是否同一组」的判定**。
 *   分组仍由调用方（`useDedupe.js`）的「簇心校验 + 结构预筛」负责 ——
 *   避免新逻辑引入新的**误删风险**（PK-29 / AR-48 的教训）。
 *
 * ⚠️ 阈值说明（**数据来源 = 合成样本标定，不是真实库**）：
 *   本机真实预设库**为空**（全机搜索仅 2 个 0KB 测试文件），故用
 *   `scripts/tools/make-preset-lib.mjs` 造**带真值的合成样本库**做标定
 *   （详见下方常量区的「标定结果」注释）。**合成样本 ≠ 真实预设** ——
 *   结论只证明「算法判别力在已知差异类型上成立」，**不能**替代真实库标定
 *   （PK-29 的教训：合成样本定的 T=19 在真实库误报 10/18）。
 *   ⇒ 当前**取保守档**（宁可漏报绝不误报），待真实库 20+ 预设 / 10+ 对同源后重标。
 */

// ═══════════════════════════════════════════════════════════════
// 阈值（⚠️ 数据来源：**合成样本标定**，非真实库 —— 见下）
// ───────────────────────────────────────────────────────────────
// 🎚️ **当前取「保守档」**（2026-09-24 用户拍板方案 A）：
//    **宁可漏报，绝不误报** —— 因为预设查重弹窗的按钮是「保留此版，清理其余」，
//    **误报 = 一键误删真数据**（不可接受）；而漏报只是「没查出来」，用户没有损失。
//
// 📊 **标定结果（2026-09-24，`_probe-preset-threshold-calib.mjs`）**：
//    本机真实预设库**为空**（全机搜索仅 2 个 0KB 测试文件）⇒ 改用
//    `scripts/tools/make-preset-lib.mjs` 造的**带真值的合成样本库**
//    （11 对同源 + 3 对无关，覆盖 exact / renamed / reskin×4 / trimmed / extended /
//      reorder / flipped / sampler / unrelated / sameNameOnly / sharedSkeleton）。
//    实测：**结构阈值 0.95 → TP=11 / FN=0 / FP=0 / TN=3（零误报零漏报）**；
//    无关对最高结构相似度 **13.0%** ｜ 同源对最低 **100%** ⇒ **分离间隙 0.87**。
//
// ⚠️ **诚实声明（不得省略）**：以上是**合成样本**标定，文本分布 ≠ 真实预设
//    （真实库 118~261 块、正文可达 MB、中英混排、含 Jinja 与正则）。
//    ⇒ 只证明「**算法判别力**在已知差异类型上成立」，**不能**替代真实库标定
//      （PK-29 的教训：合成样本定的 T=19 在真实库误报 10/18）。
//    ⇒ 待真实预设库积累到 **20+ OpenAI 预设 / 10+ 对同源**后重新标定。
//
// 🔁 **标定脚本可复用**（新增真实预设后重跑即可）：
//    `node scripts/tools/make-preset-lib.mjs "<目录>"` → `node scripts/probes/_probe-preset-threshold-calib.mjs "<目录>"`
// ═══════════════════════════════════════════════════════════════
/** 结构（identifier 集合）相似度分档 —— 保守档：0.90 → **0.95**（合成样本标定：零误报零漏报） */
export const STRUCT_HIGH = 0.95;  // ≥ 视为「结构基本相同」（实测同源 100% / 无关 ≤13%，间隙 0.87）
export const STRUCT_LOW = 0.3;    // < 视为「结构基本无关」
/** 内容（逐块正文）相似度分档 —— 保守档：0.85 → **0.90** */
export const CONTENT_HIGH = 0.9;  // ≥ 视为「内容高度重合」
/** 内容「低」线 —— 保守档：0.60 → **0.70**（提高 ⇒ 更容易落进「内容明显不同」，判重更谨慎） */
export const CONTENT_LOW = 0.7;
/** 采样参数一致性分档 */
export const SAMPLER_HIGH = 0.95; // ≥ 视为「采样参数一致」
/** 启用状态一致性分档（★ P1-5）—— 块开关是「生效与否」的硬开关，容不得差异 */
export const ENABLED_HIGH = 1.0;  // 必须**完全一致**才算「启用状态相同」（差一个块就算行为不同）

/**
 * 🧲 **聚类阈值**（`useDedupe.js` 用它决定「是否把两个预设放进同一组」）
 *
 * ⚠️ 这是**最危险的阈值**（分组 → 弹窗给「清理其余」按钮），故取与 `STRUCT_HIGH` 同值，
 *    且**必须从这里 import**（旧实现把它写死在 `useDedupe.js` 里 ⇒ 两处阈值会各自漂移）。
 * 📌 保守档：0.90 → **0.95**。
 */
export const PRESET_CLUSTER_THRESHOLD = STRUCT_HIGH;

/**
 * 🆔 `prompt_order` 的**全局默认** `character_id`
 *
 * 🛑 实测结论（**必须两个都兼容**）：
 *   · 方案 §7.2 写 `100000` 是全局默认；
 *   · `parsecard` 导出常量 `DEFAULT_PROMPT_ORDER_CHARACTER_ID = 100001`；
 *   · **真实库两者并存**（`_probe-preset-structure.mjs`：`100000` → 2 组 ｜ `100001` → 5 组）。
 * ⇒ **不得按任一单一常量写死**。取「覆盖度最高的那个 order 组」见 `pickOrderGroup`。
 */
export const PRESET_DEFAULT_CHARACTER_IDS = [100000, 100001];

/** 采样参数键（与 `useDedupe.js` 的 `PRESET_KEYS` 同口径，此处只用于「参数变体」判定） */
export const PRESET_SAMPLER_KEYS = [
    'temperature', 'max_tokens', 'max_context', 'rep_pen', 'rep_pen_range',
    'top_p', 'top_k', 'top_a', 'min_p', 'typical_p', 'tfs',
    'epsilon_cutoff', 'eta_cutoff', 'openai_model', 'frequency_penalty',
    'presence_penalty', 'repetition_penalty'
];

/** 预设相似类型枚举（值即展示用短标签） */
export const PRESET_SIM_TYPE = {
    EXACT: 'exact',              // 完全重复（结构 + 内容 + 顺序 + 参数全同）
    RESKIN: 'reskin',            // 结构相同换皮（identifier 几乎一致，正文大改）
    REORDER: 'reorder',          // 内容相同重排（正文一致，块顺序不同）
    FLIPPED: 'flipped',          // 启用状态不同（结构与正文一致，但块的开关不同）★ P1-5
    SAMPLER_VARIANT: 'sampler',  // 参数变体（结构与内容一致，仅采样参数不同）
    SIMILAR: 'similar',          // 高度相似
    DIFFERENT: 'different'       // 无关（同名但结构/内容都不同）
};

/** 类型 → 展示元数据（标签 / 配色 / 建议动作） */
export const PRESET_SIM_TYPE_META = {
    [PRESET_SIM_TYPE.EXACT]: {
        label: '🔁 完全重复', tone: 'emerald',
        advice: '结构、正文、顺序与采样参数完全一致，可安全清理'
    },
    [PRESET_SIM_TYPE.REORDER]: {
        label: '🔀 内容相同重排', tone: 'blue',
        advice: '正文一致但块顺序不同 —— 注入位置不同、**行为可能不同**，建议合并而非删除'
    },
    [PRESET_SIM_TYPE.FLIPPED]: {
        label: '🎛️ 启用状态不同', tone: 'blue',
        advice: '块与正文一致但**开关状态不同** —— 生效的提示词不同 ⇒ **行为不同**，请先比对再决定'
    },
    [PRESET_SIM_TYPE.RESKIN]: {
        label: '🎭 结构相同换皮', tone: 'amber',
        advice: '块结构几乎一致但正文大改 —— 很可能是**同一预设的改版**，清理前请先比对'
    },
    [PRESET_SIM_TYPE.SAMPLER_VARIANT]: {
        label: '🎚️ 参数变体', tone: 'purple',
        advice: '块与正文一致，仅采样参数不同 —— 属**有意调参**，不建议自动清理'
    },
    [PRESET_SIM_TYPE.SIMILAR]: {
        label: '🔍 高度相似', tone: 'purple',
        advice: '结构与正文都相似但有差异 —— 建议逐块对比后再决定'
    },
    [PRESET_SIM_TYPE.DIFFERENT]: {
        label: '⚠️ 名称相同但无关', tone: 'rose',
        advice: '结构与正文都不同，很可能是**不同的预设** —— **请勿清理**'
    }
};

/** 数组归一（任意形态 → 干净数组） */
const toArray = (v) => {
    if (Array.isArray(v)) return v;
    if (v === undefined || v === null) return [];
    return [v];
};

/**
 * 🧬 抽取预设的**结构指纹**（纯函数，不修改入参）
 *
 * 产出四类结构信息（全部来自 `prompts` / `prompt_order`，**零读盘、零额外计算**）：
 *   · `ids`            —— `identifier` 集合（**结构指纹主成分**）
 *   · `enabledById`    —— `identifier → 是否启用`
 *   · `contentById`    —— `identifier → 归一化前的原始正文`（内容相似度用）
 *   · `orders`         —— `character_id → identifier[]`（顺序相似度用，**两种默认 id 都收**）
 *
 * ⚠️ `prompts` 真实形态**两种都有**（数组 / 数字键对象），必须都兼容 ——
 *    实测真实库是**数组**，但项目既有 `extractContentText` 为兼容旧导出写了对象分支，
 *    此处与它同口径（否则同一份数据两条路径指纹不同 = DF-17 字段口径坑）。
 *
 * @param {object} data 预设的原始数据（`item.data`）
 * @returns {{ids:Set<string>, enabledById:Map<string,boolean>, contentById:Map<string,string>, orders:Map<string,string[]>, blockCount:number, totalChars:number}}
 */
export function buildPresetStructure(data) {
    const d = (data && typeof data === 'object') ? data : {};
    const ids = new Set();
    const enabledById = new Map();
    const contentById = new Map();

    // ── prompts：数组 或 数字键对象（两种真实形态）──
    const prompts = d.prompts;
    if (Array.isArray(prompts)) {
        for (const p of prompts) {
            if (!p || typeof p !== 'object') continue;
            // ⚠️ 无 identifier 的块（真实库存在）**不能丢** —— 用下标兜底，
            //    否则同一份数据在「数组形态」与「对象形态」下指纹不同。
            const id = (typeof p.identifier === 'string' && p.identifier)
                ? p.identifier : `#${ids.size}`;
            if (ids.has(id)) continue;
            ids.add(id);
            enabledById.set(id, p.enabled !== false);
            contentById.set(id, String(p.content == null ? '' : p.content));
        }
    } else if (prompts && typeof prompts === 'object') {
        // 🔧 数字键按数值升序（字典序会把 "10" 排在 "2" 前 → 同一内容不同键集合误判，
        //    与 `getPresetFingerprint` 的既有修法同口径）
        const keys = Object.keys(prompts).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
        for (const k of keys) {
            const id = `#${k}`;
            if (ids.has(id)) continue;
            ids.add(id);
            enabledById.set(id, true);
            contentById.set(id, String(prompts[k] == null ? '' : prompts[k]));
        }
    }

    // ── prompt_order：`character_id → identifier[]`（**两种默认 id 都收，不写死**）──
    const orders = new Map();
    if (Array.isArray(d.prompt_order)) {
        for (const g of d.prompt_order) {
            if (!g || typeof g !== 'object') continue;
            const cid = String(g.character_id);
            const list = toArray(g.order)
                .map(o => (o && typeof o === 'object' ? o.identifier : o))
                .filter(x => typeof x === 'string' && x);
            if (!orders.has(cid) || list.length > orders.get(cid).length) orders.set(cid, list);
        }
    }

    let totalChars = 0;
    for (const c of contentById.values()) totalChars += c.length;

    return { ids, enabledById, contentById, orders, blockCount: ids.size, totalChars };
}

/**
 * 🎯 选出**覆盖度最高**的 `prompt_order` 组（不写死 `character_id`）
 *
 * 为什么必须「自适应」而非取常量：真实库 `100000` 与 `100001` **并存**
 * （见 `PRESET_DEFAULT_CHARACTER_IDS` 的注释）。取「与本预设 `identifier` 集合交集最大」
 * 的那一组，语义上就是「该预设实际生效的那份顺序」。
 *
 * @param {{ids:Set<string>, orders:Map<string,string[]>}} s
 * @returns {{cid:string|null, list:string[]}} 无 order 时 `cid = null`、`list = []`
 */
export function pickOrderGroup(s) {
    if (!s || !(s.orders instanceof Map) || s.orders.size === 0) return { cid: null, list: [] };
    let best = { cid: null, list: [], score: -1 };
    for (const [cid, list] of s.orders) {
        // 覆盖度 = 与 identifier 集合的交集大小（越大越可能是「实际生效」的那份）
        let hit = 0;
        for (const id of list) if (s.ids.has(id)) hit++;
        if (hit > best.score) best = { cid, list, score: hit };
    }
    return { cid: best.cid, list: best.list };
}

/** 集合 Jaccard（**空集防护**：两侧皆空返回 `null`，不返回 NaN） */
export function setJaccard(A, B) {
    const a = (A instanceof Set) ? A : new Set(toArray(A));
    const b = (B instanceof Set) ? B : new Set(toArray(B));
    if (a.size + b.size === 0) return null;
    let inter = 0;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    for (const x of small) if (big.has(x)) inter++;
    return inter / (a.size + b.size - inter);
}

/** 4-gram shingle 集合（与项目查重管线**同口径**：char 4-gram、不采样） */
export function shingles4(text) {
    const t = String(text || '');
    const s = new Set();
    for (let i = 0; i + 4 <= t.length; i++) s.add(t.slice(i, i + 4));
    return s;
}

/** 文本归一化（**与 `useDedupe.normalizeText` 逐字同口径** —— 口径必须一致） */
export function normalizePresetText(t) {
    return String(t || '')
        .replace(/\s+/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .toLowerCase()
        .trim();
}

/**
 * 📐 结构相似度 = `identifier` 集合 Jaccard（**结构指纹主成分**）
 * @returns {number|null} 两侧都无块时返回 `null`（无法判定，不臆断）
 */
export function structureSimilarity(a, b) {
    return setJaccard(a && a.ids, b && b.ids);
}

/**
 * 📐 **启用状态一致性** = 共有块中「`enabled` 取值相同」的比例（P1-5）
 *
 * 📖 为什么必须单独看它（它**不是**结构、也不是内容）：
 *   两份预设可能**块集合完全相同**（结构 100%）、**正文完全相同**（内容 100%），
 *   但**块的启用状态不同** —— 例如同一个「破限块」，A 里开、B 里关。
 *   ⇒ **注入到提示词里的内容不同 ⇒ 实际行为不同**，不能当「完全重复」清理。
 *   ⚠️ 它若与 `orderSimilarity` 都为 1 才是真正的「完全重复」（见 `classifyPresetSimilarity`）。
 *
 * 📌 零额外成本：`enabled` 在 `buildPresetStructure` 时已一并收进 `enabledById`。
 *
 * @returns {number|null} 无共有块时返回 `null`（不臆断）
 */
export function enabledAgreement(a, b) {
    if (!a || !b || !(a.enabledById instanceof Map) || !(b.enabledById instanceof Map)) return null;
    let same = 0, total = 0;
    for (const [id, ea] of a.enabledById) {
        if (!b.enabledById.has(id)) continue;
        total++;
        // 统一按布尔比较（`undefined` 视为启用 —— 与 `buildPresetStructure` 的 `!== false` 同口径）
        if ((ea !== false) === (b.enabledById.get(id) !== false)) same++;
    }
    return total > 0 ? same / total : null;
}

/**
 * 📐 内容相似度 = 按块长度加权的逐块 4-gram Jaccard（**Jaccard 语义：分母含单侧独有块**）
 *
 * 🛑🛑 **2026-09-24 阈值标定暴露的真实缺陷（必须记住）**：
 *   旧实现**只累加共有块**（`wSum / wTot`）⇒ **缺失的块完全不拉低相似度** ⇒
 *   而真实预设里 **12 个「骨架块」**（`main` / `jailbreak` / `charDescription` …
 *   实测「出现在全部 5 个预设中」）**正文天然完全相同** ⇒
 *   **两个毫不相干的预设**也会因这 12 块而算出 **内容相似度 = 100%**！
 *   后果：`classifyPresetSimilarity` 的 `sLow && cLow` 分支要求 c 低 —— 而 c 虚高到 1.0
 *   ⇒ 无关对**落进 `else` 被误判为「🔍 高度相似」**，而不是「⚠️ 名称相同但无关」。
 *   ⇒ 这是**最危险的一类误判**（弹窗按钮是「保留此版，清理其余」）。
 *   📊 实测（`_probe-preset-threshold-calib.mjs`，合成库 14 对）：
 *      修复前 无关对 `unrelated`/`sameNameOnly`/`sharedSkeleton` 内容相似度 **100.0%**；
 *      修复后分别 **6.3% / 6.3% / 6.3%**（同源对不受影响，仍 ≥89%）。
 *
 * 📐 正确口径（Jaccard 语义 —— 缺失的块贡献 0、但**计入分母**）：
 *      `num = Σ_{共有} min(|a|,|b|) × jaccard(a, b)`
 *      `den = Σ_{共有} min(|a|,|b|) + Σ_{仅 A 有} |a| + Σ_{仅 B 有} |b|`
 *   ⇒ 完全相同 ⇒ num = den ⇒ 1.0；只有骨架共有 ⇒ 小值（正确）。
 *
 * 为什么加权：块长短悬殊时，短块的偶然重合不应与长块的一致等价。
 *
 * @returns {number|null} 两侧都无块（或 num 与 den 皆为 0）时返回 `null`
 */
export function contentSimilarity(a, b) {
    if (!a || !b) return null;
    let num = 0, den = 0;
    const [small, big] = a.ids.size <= b.ids.size ? [a, b] : [b, a];
    for (const id of small.ids) {
        const ca = normalizePresetText(a.contentById.get(id) || '');
        const cb = normalizePresetText(b.contentById.get(id) || '');
        if (big.ids.has(id)) {
            // 共有块：按较短的正文长度加权（避免「短块被长块吞掉」）
            const w = Math.min(ca.length, cb.length);
            const j = setJaccard(shingles4(ca), shingles4(cb));
            // 两侧皆空 → 该块无信息量，不计入分子也不计入分母（不臆断）
            if (j === null) continue;
            num += w * j;
            den += w;
        } else {
            // 🛑 仅本侧有该块 → 贡献 0 相似度，但**必须计入分母**（否则相似度虚高）
            den += ca.length;
        }
    }
    // 另一侧独有的块同样计入分母
    for (const id of big.ids) {
        if (small.ids.has(id)) continue;
        den += normalizePresetText(big.contentById.get(id) || '').length;
    }
    return den > 0 ? num / den : null;
}

/**
 * 📐 顺序相似度 = `prompt_order` 上的 **Kendall tau**（只统计交集内的 identifier）
 *
 * 为什么需要它：两份预设可能**块集合相同、正文相同**，但**顺序不同** ⇒
 * 提示词注入位置不同 ⇒ **实际行为不同**（不能当「完全重复」清理）。
 *
 * @returns {number|null} 交集 < 2 个块（无法排序）或任一侧无 order 时返回 `null`
 */
export function orderSimilarity(a, b) {
    if (!a || !b) return null;
    const ga = pickOrderGroup(a);
    const gb = pickOrderGroup(b);
    if (!ga.list.length || !gb.list.length) return null;
    const ra = new Map();
    const rb = new Map();
    ga.list.forEach((id, i) => { if (!ra.has(id)) ra.set(id, i); });
    gb.list.forEach((id, i) => { if (!rb.has(id)) rb.set(id, i); });
    const common = [];
    for (const id of ra.keys()) if (rb.has(id)) common.push(id);
    if (common.length < 2) return null;
    let concordant = 0, discordant = 0;
    for (let i = 0; i < common.length; i++) {
        for (let j = i + 1; j < common.length; j++) {
            const x = common[i], y = common[j];
            const dA = ra.get(x) - ra.get(y);
            const dB = rb.get(x) - rb.get(y);
            if (dA === 0 || dB === 0) continue;   // 并列 → 不计（Kendall tau-b 的简化）
            if ((dA > 0) === (dB > 0)) concordant++; else discordant++;
        }
    }
    const n = concordant + discordant;
    return n > 0 ? concordant / n : null;
}

/**
 * 📐 采样参数一致性 = 「值相同的参数个数 / 共有参数个数」
 *
 * ⚠️ 设计取舍（**与方案一致**）：参数差异**不纳入「是否重复」的核心判据**，
 *    只用于把「仅调参」的两份标成 `SAMPLER_VARIANT`（提示用户别自动清理）。
 *    实测真实库 9 项采样参数**全部 5/5 存在、null 0 个** ⇒ 不会因缺字段而虚低。
 *
 * @param {{data?:object}} a 预设**库条目**（非裸数据）—— 采样参数在 `item.data` 上
 * @param {{data?:object}} b 同上
 * @returns {number|null} 无共有参数时返回 `null`
 */
export function samplerAgreement(a, b) {
    if (!a || !b) return null;
    const da = a.data || {};
    const db = b.data || {};
    let same = 0, total = 0;
    for (const k of PRESET_SAMPLER_KEYS) {
        const va = da[k], vb = db[k];
        if (va === undefined && vb === undefined) continue;
        total++;
        if (JSON.stringify(va) === JSON.stringify(vb)) same++;
    }
    return total > 0 ? same / total : null;
}

/**
 * 🏷️ 判定预设相似类型（**只产出标签，不决定分组**）
 *
 * @param {object} p
 * @param {number|null} p.structSim   结构相似度（`structureSimilarity`）
 * @param {number|null} p.contentSim  内容相似度（`contentSimilarity`）
 * @param {number|null} p.orderSim    顺序相似度（`orderSimilarity`，可空）
 * @param {number|null} p.enabledSim  启用状态一致性（`enabledAgreement`，可空）★ P1-5
 * @param {number|null} p.samplerSim  采样参数一致性（`samplerAgreement`，可空）
 * @param {boolean} [p.sameName]      文件名/名称是否相同（用于区分「改名同源」与「同名无关」）
 * @returns {{type:string, label:string, tone:string, advice:string, score:number|null, renamed:boolean}}
 */
export function classifyPresetSimilarity({ structSim, contentSim, orderSim, enabledSim, samplerSim, sameName } = {}) {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
    const s = num(structSim);
    const c = num(contentSim);
    const o = num(orderSim);
    const en = num(enabledSim);
    const sp = num(samplerSim);

    // 综合分（**仅供展示排序**，不用于阈值判定）：结构 0.5 / 内容 0.35 / 参数 0.15
    // ⚠️ 这三个权重是方案给的经验值，**未标定**（见文件头）
    const score = (s === null && c === null) ? null
        : (s === null ? 0 : s) * 0.5 + (c === null ? 0 : c) * 0.35 + (sp === null ? 0 : sp) * 0.15;

    let type;
    if (s === null && c === null) {
        type = PRESET_SIM_TYPE.DIFFERENT;             // 两侧都无数据 → 无法判定，保守标「无关」
    } else if (s !== null && c !== null) {
        const sHigh = s >= STRUCT_HIGH;
        const sLow = s < STRUCT_LOW;
        const cHigh = c >= CONTENT_HIGH;
        const cLow = c < CONTENT_LOW;

        if (sLow && cLow) {
            // 🛑 两侧都低 → **无关**。这一支**必须**在「高度相似」之前判掉 ——
            //    漏掉就会把「同名但毫无关系」的预设标成「高度相似」，
            //    而弹窗按钮是「保留此版，清理其余」⇒ **可一键误删**（PK-29 / AR-48 同型的反向结论）。
            type = PRESET_SIM_TYPE.DIFFERENT;
        } else if (sHigh && cHigh) {
            // ⚠️ 判定顺序即「危险度从低到高」：只有**四维全一致**才算「完全重复」。
            //    任一维度不同 ⇒ 实际行为可能不同 ⇒ 降级为「需人工核对」的类型。
            if (o !== null && o < STRUCT_HIGH) type = PRESET_SIM_TYPE.REORDER;          // 块顺序不同
            else if (en !== null && en < ENABLED_HIGH) type = PRESET_SIM_TYPE.FLIPPED;  // 启用状态不同（★ P1-5）
            else if (sp !== null && sp < SAMPLER_HIGH) type = PRESET_SIM_TYPE.SAMPLER_VARIANT;
            else type = PRESET_SIM_TYPE.EXACT;
        } else if (sHigh && cLow) {
            type = PRESET_SIM_TYPE.RESKIN;                // 结构相同换皮（★ 本次要补的核心能力）
        } else {
            type = PRESET_SIM_TYPE.SIMILAR;
        }
    } else if (s !== null) {
        type = s < STRUCT_LOW ? PRESET_SIM_TYPE.DIFFERENT : PRESET_SIM_TYPE.SIMILAR;
    } else {
        type = c < CONTENT_LOW ? PRESET_SIM_TYPE.DIFFERENT : PRESET_SIM_TYPE.SIMILAR;
    }

    // 🔔 改名同源：结构高度一致但**名称不同** —— 这正是旧实现（按名聚类）的漏报场景
    const meta = PRESET_SIM_TYPE_META[type];
    const renamed = (sameName === false) && s !== null && s >= STRUCT_HIGH && type !== PRESET_SIM_TYPE.DIFFERENT;
    return {
        type,
        label: renamed ? `${meta.label}·改名同源` : meta.label,
        tone: meta.tone,
        advice: renamed
            ? `${meta.advice}（⚠️ 两文件**名称不同**，属「改名同源」—— 旧版按名聚类会完全漏掉）`
            : meta.advice,
        score,
        renamed: !!renamed
    };
}
