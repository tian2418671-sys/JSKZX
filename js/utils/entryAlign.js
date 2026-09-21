/**
 * 世界书词条「外连接对齐」（Full Outer Join）—— 纯函数工具
 *
 * 目的：把两本世界书词条的**不对称增删**表达成 only-a / only-b / both 三类，
 *       从而回答用户最关心的问题「到底删了哪个词条、加了哪个词条」。
 *
 * 为什么不用「拼接大字符串」：旧做法把两侧全部 content 拼成一条大文本再走句级 diff，
 *   不保留归属与顺序 → 只能看到「一大坨文本里某几句变红变绿」，无法回答「删了哪条」（DF-17）。
 *
 * 字段口径（取证自 useWorldbookExtras.js / useWorldbookEntries.js / App.vue）：
 *   - 独立世界书（库）：uid / key（数组） / keysecondary（数组） / comment / content
 *   - 角色卡内嵌：      uid / keys / secondary_keys / comment / content
 *   - **没有 `name` 字段**（`comment || name` 只是别处的兜底写法）
 *
 * ⚠️ 主键（keyOf）的三项硬约束，少一个就会退化或误配：
 *   ① 带侧标识：脏数据 key 必须带 side（anon:a:3 / anon:b:3）。
 *      两侧共用下标会让 A 侧脏数据与 B 侧**无关**脏数据配成 both，与"不参与配对"的目的正好相反。
 *   ② 一对一配对：B 侧桶用「key → 数组 + 已消费标记」。
 *      同书内重复 comment / 重复 key 集合现实存在；若用 Map + Set，两条 A 会配到同一条 B，
 *      且 B 侧那一条永远不会被渲染 → 两侧条数对不上，用户看到「漏了一条」。
 *   ③ 不认 uid 当主键：uid 逐条随机生成（同源复制保留，但经「导入词条到角色卡」这类字段转换会**重新生成**）
 *      → 拿 uid 当主键会把同一条词条判成「两侧各缺一条」。uid 只做同源加速（最后才用）。
 *
 * 已知取舍（非缺陷）：两侧都填了 comment 但同一词条**改了名**，会显示成「一条缺失 + 一条新增」——
 *   这在语义上确实是删 + 增，可接受且可解释，不为此加模糊匹配。
 */

/** 归一化：null / undefined → ''，去首尾空白 + 转小写（跨源比较要忽略大小写与空白差异） */
const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

/** 取词条触发词数组：兼容库形态 `key` 与卡内嵌形态 `keys`（含字符串逗号串） */
export function entryKeys(e) {
    if (!e || typeof e !== 'object') return [];
    const raw = Array.isArray(e.key) ? e.key : (Array.isArray(e.keys) ? e.keys : (e.key != null ? e.key : e.keys));
    if (Array.isArray(raw)) return raw.map(k => String(k == null ? '' : k)).filter(Boolean);
    if (typeof raw === 'string') return raw.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    return [];
}

/** 取词条次级触发词数组：兼容 `keysecondary` 与 `secondary_keys` */
export function entrySecondaryKeys(e) {
    if (!e || typeof e !== 'object') return [];
    const raw = Array.isArray(e.keysecondary) ? e.keysecondary
        : (Array.isArray(e.secondary_keys) ? e.secondary_keys
            : (e.keysecondary != null ? e.keysecondary : e.secondary_keys));
    if (Array.isArray(raw)) return raw.map(k => String(k == null ? '' : k)).filter(Boolean);
    if (typeof raw === 'string') return raw.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    return [];
}

/** 取词条显示名：comment 为主，name 只是兜底（世界书词条没有 name 字段） */
export function entryName(e) {
    if (!e || typeof e !== 'object') return '未命名条目';
    const label = String(e.comment == null ? '' : e.comment).trim() || String(e.name == null ? '' : e.name).trim();
    return label || '未命名条目';
}

/**
 * 对齐主键：三级回退（comment → key 指纹 → uid）
 * @param {any} e 词条
 * @param {'a'|'b'} side 侧标识（脏数据 key 必须带，见约束 ①）
 * @param {number} idx 位置下标（仅用于脏数据 key 的稳定性）
 * @returns {string} 稳定的对齐主键
 */
export function keyOf(e, side = 'a', idx = 0) {
    if (!e || typeof e !== 'object') return `anon:${side}:${idx}`;   // 脏数据不参与配对（带侧标识）
    const label = norm(e.comment || e.name);
    if (label) return 'c:' + label;                                   // ① 词条名（最稳，跨源可用）
    const fp = norm(entryKeys(e).join('|'));
    if (fp) return 'k:' + fp;                                         // ② 触发词指纹
    return e.uid ? 'u:' + e.uid : `anon:${side}:${idx}`;              // ③ 最后才用 uid
}

/**
 * 组级词条对齐：Full Outer Join
 * @param {Array} listA 左侧（推荐保留版）词条数组
 * @param {Array} listB 右侧（对比版）词条数组
 * @returns {Array<{side:'both'|'only-a'|'only-b', a:object|null, b:object|null, key:string}>}
 */
export function alignEntryLists(listA = [], listB = []) {
    const arrA = Array.isArray(listA) ? listA : [];
    const arrB = Array.isArray(listB) ? listB : [];

    // B 侧建桶：key → [{ entry, used }]（约束 ②：一对一配对）
    const buckets = new Map();
    arrB.forEach((e, i) => {
        const k = keyOf(e, 'b', i);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push({ entry: e, used: false });
    });

    const pairs = [];
    // Pass 1：以 A 侧（推荐保留版）为主，能配上就 both，配不上就 only-a
    arrA.forEach((a, i) => {
        const k = keyOf(a, 'a', i);
        const bucket = buckets.get(k);
        const free = bucket ? bucket.find(x => !x.used) : null;
        if (free) {
            free.used = true;
            pairs.push({ side: 'both', a, b: free.entry, key: k });
        } else {
            pairs.push({ side: 'only-a', a, b: null, key: k });
        }
    });
    // Pass 2：收集 B 侧独有（新增）—— 只取未被消费的，保证一对一
    arrB.forEach((b, i) => {
        const k = keyOf(b, 'b', i);
        const bucket = buckets.get(k);
        if (!bucket) return;
        const free = bucket.find(x => !x.used);
        if (free) {
            free.used = true;
            pairs.push({ side: 'only-b', a: null, b, key: k });
        }
    });

    return pairs;
}

/**
 * 单项安全清洗：把一对词条（任一侧可为 null）整理成模板可直接渲染的载荷
 * 防空指针 / 字段类型不匹配 / 脏数据
 * @param {object|null} entryA
 * @param {object|null} entryB
 * @returns {{name:string, contentA:string, contentB:string, keysA:string[], keysB:string[], secondaryA:string[], secondaryB:string[], changed:boolean}}
 */
export function prepareDiffPayload(entryA, entryB) {
    const pick = (e) => {
        if (!e || typeof e !== 'object') {
            return { name: '未命名条目', content: '', keys: [], secondary: [] };
        }
        return {
            name: entryName(e),
            content: String(e.content == null ? '' : e.content),   // 强制字符串（防 null / 数字 / 对象）
            keys: entryKeys(e),
            secondary: entrySecondaryKeys(e)
        };
    };
    const A = pick(entryA);
    const B = pick(entryB);
    return {
        name: A.name !== '未命名条目' ? A.name : B.name,   // 显示名优先取有名字的那一侧
        contentA: A.content,
        contentB: B.content,
        keysA: A.keys,
        keysB: B.keys,
        secondaryA: A.secondary,
        secondaryB: B.secondary,
        changed: A.content !== B.content || A.keys.join('|') !== B.keys.join('|')
    };
}

/**
 * 对齐结果统计（用于界面摘要）
 * @param {Array} pairs alignEntryLists 的返回值
 */
export function summarizeAlignment(pairs = []) {
    const out = { both: 0, onlyA: 0, onlyB: 0, changed: 0 };
    for (const p of (Array.isArray(pairs) ? pairs : [])) {
        if (!p || !p.side) continue;
        if (p.side === 'both') {
            out.both++;
            if (prepareDiffPayload(p.a, p.b).changed) out.changed++;
        } else if (p.side === 'only-a') out.onlyA++;
        else if (p.side === 'only-b') out.onlyB++;
    }
    return out;
}

/**
 * 全形态 entries 归一化：兼容数组与对象字典（V2 老格式 {"0":{...}}）
 * 与 main.js 的 isValidWorldbook 同口径 —— 判定"是不是世界书"前先过这里（DF-19）
 * @param {any} entries
 * @returns {Array}
 */
export function normalizeEntries(entries) {
    if (Array.isArray(entries)) return entries;
    if (entries && typeof entries === 'object') return Object.values(entries);
    return [];
}
