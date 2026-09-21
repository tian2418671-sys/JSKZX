/**
 * DF-18 扫描闸门分级 + 缓存自愈 单测
 *
 * ⚠️ 与 main.js 的分级常量与判定逻辑**保持同步**；
 *    main.js 因 require('electron') 无法被 node --test 直接加载，故此处内联等价实现
 *    （与 test/snapshotFilter.test.mjs 同款做法 —— 修改 main.js 时须同步此处）。
 *
 * 背景（见 docs/规格与计划/查重扫描与检索-最终方案.md §2.5）：
 *   旧写法 `if (st.size > 5 * 1024 * 1024) return;` 是**静默丢弃**：
 *   无日志、无 UI、不进统计 → 用户只看到「这本大书不见了」。
 *   且 512KB 头部预检未命中会写 `cache = { valid: false }` → **误杀被永久固化**，修了逻辑也不自愈。
 *
 * 本测试断言：
 *   1. 分级阈值正确（≤5MB 内联 / 5~50MB 解析 / >50MB 只回元数据）
 *   2. 旧的 5MB 硬丢弃行为已不存在（10~30MB 的书必须能进结果）
 *   3. `valid: null`（未判定）不参与「跳过」，只有 `valid: false` 才跳过
 *   4. 缓存版本不符时整体失效（让旧误杀自愈）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ===== 与 main.js 保持同步的分级常量 =====
const SCAN_INLINE_MAX_BYTES = 5 * 1024 * 1024;   // 5MB：内联 data 上限
const SCAN_PARSE_MAX_BYTES  = 50 * 1024 * 1024;  // 50MB：仍解析的上限
const SCAN_CACHE_VERSION = 2;

const MB = 1024 * 1024;

/** 与 main.js 等价的分级判定：返回该文件应走的处理档 */
function classifyBySize(size) {
    if (size > SCAN_PARSE_MAX_BYTES) return 'metadata-only';   // >50MB：不 parse，只回元数据
    if (size > SCAN_INLINE_MAX_BYTES) return 'heavy-parse';    // 5~50MB：低并发解析
    return 'normal';                                          // ≤5MB：常规 32 并发 + 内联 data
}

/** 与 main.js 等价的「是否按缓存跳过」判定 */
function shouldSkipByCache(cached, mtime) {
    // 只认「明确否定」：valid === false 且 mtime 未变才跳过
    // valid === null（未判定/待重试）**不跳过**
    return !!(cached && cached.mtime === mtime && cached.valid === false);
}

/** 与 main.js 等价的缓存版本校验 + 分支补齐（顺序与 main.js 一致：先版本判定，再补齐） */
function loadCacheEquivalent(raw) {
    let cache = null;
    if (raw && typeof raw === 'object' && raw.__v === SCAN_CACHE_VERSION) cache = raw;
    if (!cache || typeof cache !== 'object') cache = {};
    cache.__v = SCAN_CACHE_VERSION;
    if (!cache.worldbook || typeof cache.worldbook !== 'object') cache.worldbook = {};
    if (!cache.preset || typeof cache.preset !== 'object') cache.preset = {};
    return cache;
}

// ───────────────────────── 分级阈值 ─────────────────────────

test('分级：≤5MB 走常规档（内联 data，行为与旧版一致）', () => {
    assert.equal(classifyBySize(0), 'normal');
    assert.equal(classifyBySize(1 * MB), 'normal');
    assert.equal(classifyBySize(4.9 * MB), 'normal');
    assert.equal(classifyBySize(SCAN_INLINE_MAX_BYTES), 'normal', '恰好 5MB 仍算常规');
});

test('分级：5~50MB 走低并发解析档', () => {
    assert.equal(classifyBySize(5 * MB + 1), 'heavy-parse');
    assert.equal(classifyBySize(10 * MB), 'heavy-parse');
    assert.equal(classifyBySize(30 * MB), 'heavy-parse');
    assert.equal(classifyBySize(SCAN_PARSE_MAX_BYTES), 'heavy-parse', '恰好 50MB 仍解析');
});

test('分级：>50MB 只回元数据（不 parse）', () => {
    assert.equal(classifyBySize(50 * MB + 1), 'metadata-only');
    assert.equal(classifyBySize(100 * MB), 'metadata-only');
    assert.equal(classifyBySize(500 * MB), 'metadata-only');
});

test('旧行为已废除：10~30MB 的世界书不再被丢弃', () => {
    // 旧代码：st.size > 5MB → return（静默丢弃）。现在这些必须能进结果。
    for (const size of [6 * MB, 10 * MB, 20 * MB, 30 * MB, 45 * MB]) {
        const cls = classifyBySize(size);
        assert.notEqual(cls, 'normal', `${size / MB}MB 不应走常规档（需要低并发保护）`);
        assert.notEqual(cls, 'metadata-only', `${size / MB}MB 应被解析并入库，不能被丢弃`);
        assert.equal(cls, 'heavy-parse');
    }
});

test('分级边界严格（不留旧 5MB 硬闸门）', () => {
    // 关键回归：旧代码在 5MB 处直接 return，导致 5MB 以上的文件全部消失
    const justOver5 = 5 * MB + 1;
    assert.notEqual(classifyBySize(justOver5), null, '略超 5MB 不得被判为丢弃');
    assert.ok(['heavy-parse', 'metadata-only'].includes(classifyBySize(justOver5)));
});

// ───────────────────────── 缓存自愈 ─────────────────────────

test('缓存跳过：只认 valid === false（明确否定）', () => {
    const mt = 1000;
    assert.equal(shouldSkipByCache({ mtime: mt, valid: false }, mt), true, '明确否定 + mtime 未变 → 跳过');
    assert.equal(shouldSkipByCache({ mtime: mt, valid: true }, mt), false, '有效文件不得被跳过');
});

test('缓存跳过：valid === null（未判定）不得跳过 —— 这是误杀自愈的关键', () => {
    const mt = 1000;
    // 旧代码把「头部预检未命中」写成 valid:false → 误杀永久固化；
    // 现在写 valid:null → 下次仍会重试，修好逻辑后能自愈。
    assert.equal(shouldSkipByCache({ mtime: mt, valid: null }, mt), false, '未判定状态必须重试（否则误杀不自愈）');
    assert.equal(shouldSkipByCache({ mtime: mt, valid: undefined }, mt), false, 'undefined 同样不跳过');
});

test('缓存跳过：mtime 变化时不跳过（文件被改过要重扫）', () => {
    assert.equal(shouldSkipByCache({ mtime: 1000, valid: false }, 2000), false, 'mtime 变了必须重扫');
});

test('缓存跳过：无缓存记录时不跳过', () => {
    assert.equal(shouldSkipByCache(undefined, 1000), false);
    assert.equal(shouldSkipByCache(null, 1000), false);
});

test('缓存版本不符 → 整体失效（旧误杀判定自愈）', () => {
    // 旧版本缓存（无 __v 或版本号不同）必须被丢弃
    const oldNoVersion = { worldbook: { 'a.json': { mtime: 1, valid: false } } };
    const oldVersion = { __v: 1, worldbook: { 'a.json': { mtime: 1, valid: false } } };

    const loaded1 = loadCacheEquivalent(oldNoVersion);
    assert.equal(loaded1.__v, SCAN_CACHE_VERSION, '无版本号的旧缓存应被丢弃重建');
    assert.deepEqual(loaded1.worldbook, {}, '旧缓存内容必须清空（否则误杀固化）');

    const loaded2 = loadCacheEquivalent(oldVersion);
    assert.equal(loaded2.__v, SCAN_CACHE_VERSION);
    assert.deepEqual(loaded2.worldbook, {}, '旧版本号缓存同样清空');
});

test('缓存版本相符 → 保留内容（不误清）', () => {
    const cur = { __v: SCAN_CACHE_VERSION, worldbook: { 'a.json': { mtime: 1, valid: true } }, preset: {} };
    const loaded = loadCacheEquivalent(cur);
    assert.deepEqual(loaded.worldbook, { 'a.json': { mtime: 1, valid: true } }, '同版本缓存应保留');
    assert.equal(loaded.__v, SCAN_CACHE_VERSION);
});

test('缓存结构补齐：缺失 worldbook / preset 分支时自动初始化', () => {
    const loaded = loadCacheEquivalent({ __v: SCAN_CACHE_VERSION });
    assert.ok(loaded.worldbook && typeof loaded.worldbook === 'object', 'worldbook 分支必须存在');
    assert.ok(loaded.preset && typeof loaded.preset === 'object', 'preset 分支必须存在');
});

// ───────────────────────── 元数据完整性 ─────────────────────────

test('扫描结果必须带 size / mtime / entryCount（供界面显示与懒加载判断）', () => {
    // 与 main.js results.push 的字段口径保持同步
    const mkResult = (size, entryCount, dataLoaded) => ({
        path: 'E:/wb/x.json', name: 'x.json',
        size, mtime: 123456, entryCount,
        heavy: size > SCAN_INLINE_MAX_BYTES,
        dataLoaded, data: dataLoaded ? { entries: [] } : null
    });

    const normal = mkResult(1 * MB, 42, true);
    assert.equal(normal.heavy, false);
    assert.equal(normal.entryCount, 42);

    const big = mkResult(80 * MB, null, false);
    assert.equal(big.heavy, true, '>5MB 应标记 heavy');
    assert.equal(big.dataLoaded, false, '>50MB 不加载 data');
    assert.equal(big.data, null, '>50MB data 应为 null（按需 readText 懒加载）');
    assert.equal(big.size, 80 * MB, '必须带 size（界面显示体积）');
});
