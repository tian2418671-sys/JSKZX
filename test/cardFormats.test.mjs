/**
 * 📇 角色卡**文件格式能力表**守卫单测（DF-22 根治）
 *
 * ═══════════════════════════════════════════════════════════════
 * 🔴 要防的缺陷：「导入能进、扫描不进」
 * ───────────────────────────────────────────────────────────────
 * 病根是**同一件事（能处理哪些格式）在三处各写一份**：
 *   · `js/components/HeaderBar.vue` 的 `accept="…"`
 *   · `js/utils/cardLoader.js` 的注释与判断
 *   · `main.js` 的扫描白名单（**两处**）
 * ⇒ 只要有一处改、其余没改，就会出现「两个入口行为相反」。
 *
 * ✅ 根治：格式能力收敛到 `main/cardFormats.json`（**单一数据源**），
 *    CJS（`main.js`）与 ESM（渲染层）都直接读它 ⇒ 物理上不可能漂移。
 *
 * ⚠️ 本单测同时锁死**关键事实**：`file:saveCard` 只支持 `.json`/`.png`
 *    ⇒ 不可写回的格式（`.webp`/`.jpg`）**不得**出现在导入对话框里
 *    （否则用户以为能用，实际标签/编辑**静默不落盘**）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');

// ── 数据源（JSON —— CJS 与 ESM 都能直接读）──
const FORMATS = require('../main/cardFormats.json');
// ── CJS 封装（main.js 用的就是它）──
const cf = require('../main/cardFormats.js');

// ══════════════════════════════════════════════════════════════
// 数据源本身
// ══════════════════════════════════════════════════════════════
test('★ 格式表：三个能力维度都有定义，且格式都带前导点', () => {
    for (const key of ['scannable', 'savable', 'image']) {
        assert.ok(Array.isArray(FORMATS[key]) && FORMATS[key].length > 0, `${key} 必须是非空数组`);
        for (const e of FORMATS[key]) {
            assert.ok(e.startsWith('.') && e === e.toLowerCase(),
                `格式 \`${e}\` 必须是「前导点 + 全小写」形式（否则比对时会漏判）`);
        }
    }
});

test('★ 格式表：`savable` 必须是 `scannable` 的子集（能写必然能读）', () => {
    for (const e of FORMATS.savable) {
        assert.ok(FORMATS.scannable.includes(e),
            `\`${e}\` 可写回却不可扫描 —— 逻辑矛盾`);
    }
});

test('★ 格式表：`.jpg`/`.jpeg` **不在**任何能力列表里（DF-22 收敛）', () => {
    for (const jpg of ['.jpg', '.jpeg']) {
        assert.ok(!FORMATS.scannable.includes(jpg),
            `\`${jpg}\` 不得可扫描 —— 它**无法写回保存**，进了库就是「改标签不落盘」的陷阱`);
        assert.ok(!FORMATS.savable.includes(jpg), `\`${jpg}\` 本来就不可写`);
    }
});

// ══════════════════════════════════════════════════════════════
// CJS 封装行为
// ══════════════════════════════════════════════════════════════
test('★ isScannable / isSavable / isImageExt：大小写与前导点都要容错', () => {
    for (const v of ['.png', 'png', '.PNG', 'PNG', '  .png  ']) {
        assert.equal(cf.isScannable(v), true, `\`${v}\` 应判为可扫描`);
        assert.equal(cf.isSavable(v), true, `\`${v}\` 应判为可写`);
        assert.equal(cf.isImageExt(v), true, `\`${v}\` 应判为图片类`);
    }
    for (const v of ['.jpg', 'jpg', '.jpeg', '.gif', '.txt', '', null, undefined]) {
        assert.equal(cf.isScannable(v), false, `\`${v}\` 不得判为可扫描`);
        assert.equal(cf.isSavable(v), false, `\`${v}\` 不得判为可写`);
    }
});

test('★ `.webp`：可扫描 **且可保存**（保存时自动升级为 PNG —— DF-25 修复）', () => {
    assert.equal(cf.isScannable('.webp'), true, 'WebP 已在真实库流通，不能突然不认');
    assert.equal(cf.isSavable('.webp'), true,
        'WebP 必须可保存 —— DF-25 真修复：保存时升级为 PNG（与 SillyTavern 自身行为一致），'
        + '而不是「拒绝保存 + 提示用户自己转格式」（不能强迫用户适应）');
    assert.equal(cf.isImageExt('.webp'), true);
});

test('★ IMPORT_ACCEPT 由可扫描列表派生（不是手写）', () => {
    assert.equal(cf.IMPORT_ACCEPT, FORMATS.scannable.join(','));
    assert.ok(!cf.IMPORT_ACCEPT.includes('jpg'),
        'accept 不得含 jpg —— 声明了做不到的事（DF-22 的原始病根）');
});

// ══════════════════════════════════════════════════════════════
// ★ 真实源码守卫：三处入口必须与格式表同源（不得各写一份）
// ══════════════════════════════════════════════════════════════
test('★ 守卫：`main.js` 的扫描白名单必须走 `isScannable`（不得写死扩展名判断）', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf-8');
    assert.ok(src.includes("require('./main/cardFormats.js')"),
        'main.js 必须引用格式表（否则又会各写一份）');
    // 旧的写死判断必须已消除
    assert.ok(!/ext !== '\.png' && ext !== '\.webp' && ext !== '\.json'/.test(src),
        '⚠️ 旧的写死白名单仍在 —— 必须改成 isScannable(ext)，否则会与格式表漂移');
    assert.ok(src.includes('isScannable(ext)'), 'main.js 必须用 isScannable(ext) 判扫描白名单');
    // 两处都要改到（文件扫描 + 目录遍历）
    const hits = src.match(/isScannable\(ext\)/g) || [];
    assert.ok(hits.length >= 2, `扫描白名单有**两处**，实测只改了 ${hits.length} 处`);
});

test('★ 守卫：`HeaderBar.vue` 的 accept 必须绑定 `importAccept`（不得手写扩展名列表）', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'js/components/HeaderBar.vue'), 'utf-8');
    assert.ok(src.includes(':accept="importAccept"'),
        'HeaderBar 的 file input 必须绑定 importAccept（来自格式表）');
    assert.ok(!/accept="\.png,\.webp/.test(src),
        '⚠️ accept 里仍有手写的扩展名列表 —— 必须改为绑定 importAccept');
});

test('★ 守卫：渲染层通过 **JSON** 读格式表（不是读 CJS，避免 Vite 转换风险）', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'js/components/App.vue'), 'utf-8');
    assert.ok(src.includes("from '../../main/cardFormats.json'"),
        '渲染层必须 import JSON（原生支持）；读 `.js` 会走 CJS 转换，有兼容风险');
    assert.ok(!src.includes("from '../../main/cardFormats.js'"),
        '⚠️ 渲染层不得 import cardFormats.js（CJS）');
});

test('★ 守卫：`cardLoader.js` 不再声明支持 JPEG（注释与代码同口径）', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'js/utils/cardLoader.js'), 'utf-8');
    assert.ok(!/支持 V1\/V2\/V3 规范以及 PNG \/ WebP \/ JPEG \/ JSON/.test(src),
        '⚠️ 顶部注释仍声明支持 JPEG —— 与格式表矛盾');
    assert.ok(!/\.json \/ \.png \/ \.webp \/ \.jpeg \/ \.jpg/.test(src),
        '⚠️ `processFile` 的 jsdoc 仍列 .jpeg/.jpg —— 与格式表矛盾');
});

// ══════════════════════════════════════════════════════════════
// ★ 渲染层 ESM 封装（DF-25 用）
// ══════════════════════════════════════════════════════════════
test('★ 渲染层封装：数据源必须与 main 侧**同一份 JSON**（不得重写列表）', async () => {
    const esm = await import('../js/utils/cardFormats.js');
    assert.deepEqual([...esm.SCANNABLE_EXTS], [...FORMATS.scannable], '可扫描列表必须同源');
    assert.deepEqual([...esm.SAVABLE_EXTS], [...FORMATS.savable], '可写回列表必须同源');
    assert.equal(esm.IMPORT_ACCEPT, FORMATS.scannable.join(','));
    // 不得在渲染层另写一份列表
    const src = fs.readFileSync(path.join(repoRoot, 'js/utils/cardFormats.js'), 'utf-8');
    assert.ok(src.includes("from '../../main/cardFormats.json'"),
        '渲染层封装必须 import JSON（单一数据源）');
});

test('★ 渲染层封装：`isPathSavable` 按**路径**判定（库条目给的是 path）', async () => {
    const { isPathSavable } = await import('../js/utils/cardFormats.js');
    assert.equal(isPathSavable('D:\\lib\\a.png'), true);
    assert.equal(isPathSavable('D:\\lib\\a.PNG'), true);
    assert.equal(isPathSavable('D:\\lib\\a.json'), true);
    assert.equal(isPathSavable('D:\\lib\\a.webp'), true, 'WebP 可保存（升级为 PNG）');
    assert.equal(isPathSavable('D:\\lib\\a.jpg'), false, 'JPEG 不可保存（DF-22 已收敛）');
    assert.equal(isPathSavable('D:\\lib\\a.jpeg'), false);
    assert.equal(isPathSavable('D:\\lib\\noext'), false);
    assert.equal(isPathSavable(''), false);
    assert.equal(isPathSavable(null), false);
});

test('★ 渲染层封装：`unsavableReason` 给出**用户可读原因**（空串 = 可保存）', async () => {
    const { unsavableReason } = await import('../js/utils/cardFormats.js');
    assert.equal(unsavableReason('a.png'), '', '可保存 ⇒ 无原因');
    assert.equal(unsavableReason('a.json'), '');
    assert.equal(unsavableReason('a.webp'), '', 'WebP 可保存（升级）⇒ 不应报「不可保存」');
    assert.ok(unsavableReason('a.jpg').includes('JPEG'));
    assert.ok(unsavableReason('a.jpeg').includes('JPEG'));
    assert.ok(unsavableReason('a.xyz').length > 0, '未知格式也要给出原因');
});

// ══════════════════════════════════════════════════════════════
// ★ 守卫：DF-25 —— 写盘失败**不得静默**
// ══════════════════════════════════════════════════════════════
test('★ 守卫：DF-25 —— `useCardCrud.js` 的写盘调用必须判 `success` 并**告知失败**', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'js/composables/useCardCrud.js'), 'utf-8');
    assert.ok(src.includes('noteSaveFailure'),
        '必须有「写盘失败告知」通道（DF-25：不能只写 console.warn 就完事）');
    // 三处 saveCard 调用点都必须在失败分支调用它
    const saveCalls = src.match(/electronAPI\.saveCard\(/g) || [];
    const notes = src.match(/noteSaveFailure\(/g) || [];
    assert.ok(saveCalls.length >= 3, `预期 ≥3 处 saveCard 调用，实测 ${saveCalls.length}`);
    assert.ok(notes.length >= saveCalls.length,
        `每处 saveCard 都要有失败告知（调用 ${saveCalls.length} 处 ｜ 告知 ${notes.length} 处）`);
    // 不得只 warn 了事
    assert.ok(!/catch \(e\) \{\s*console\.warn\(`自动打标后台保存失败[^}]*\}\s*\}/
        .test(src.replace(/noteSaveFailure\([^)]*\);/g, '')),
        '⚠️ 仍有「只 console.warn 不告知」的静默失败路径');
});

test('★ 守卫：DF-25 —— 编辑器必须有**不可保存格式的横幅**（不等保存才发现）', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'js/components/EditorPanel.vue'), 'utf-8');
    assert.ok(src.includes('activeCardSavable') && src.includes('activeCardUnsavableReason'),
        '编辑器必须绑定「当前卡能否保存」状态');
    assert.ok(/v-if="!activeCardSavable/.test(src), '必须有 v-if 横幅');
});

test('★ 守卫：DF-25 —— 保存失败要给出**准确原因**（不得笼统「保存失败」）', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'js/components/App.vue'), 'utf-8');
    assert.ok(src.includes('unsavableReason(libItem.path)'),
        '`saveToLocalDisk` 失败时必须先查「是否格式不支持」，给出准确原因');
    assert.ok(src.includes('activeCardSavable') && src.includes('activeCardUnsavableReason'),
        'App.vue 必须把 DF-25 状态暴露给 ctx（供编辑器横幅用）');
});
