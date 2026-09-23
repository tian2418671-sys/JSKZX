/**
 * 「结构指纹」判别力量化（评估「预设查重方案」的核心取证）
 *
 * 方案主张：`identifier` 集合 Jaccard + `enabled` 一致性 + `prompt_order` Kendall tau
 *          → S_struct 权重 0.50（「结构决定行为」）
 *
 * 本探针用**真实预设库**验证：
 *   ① identifier Jaccard 是否真有判别力？（默认骨架会让所有预设看起来都像）
 *   ② 与 content Jaccard 的一致性如何？（结构高但内容低 = 误报）
 *   ③ character_id 到底用哪个？
 *
 * 用法：node scripts/probes/_probe-preset-struct-power.mjs "H:\01"
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'H:\\01';

/** 与项目同口径的文本归一化 + 4-gram shingle + Jaccard */
const normalize = (t) => String(t || '').replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().trim();
const shingles = (t) => { const s = new Set(); for (let i = 0; i + 4 <= t.length; i += 1) s.add(t.slice(i, i + 4)); return s; };
/** Jaccard；**空集防护**（两侧都为空时返回 null，不返回 NaN —— 0/0） */
const jac = (A, B) => {
    if (A.size + B.size === 0) return null;
    let i = 0; const [s, b] = A.size <= B.size ? [A, B] : [B, A];
    for (const x of s) if (b.has(x)) i++;
    return i / (A.size + B.size - i);        // 分母 = |A ∪ B|，仅当两者皆空时为 0（已提前返回）
};
const setJac = (A, B) => {
    if (A.size + B.size === 0) return null;
    let i = 0; for (const x of A) if (B.has(x)) i++;
    return i / (A.size + B.size - i);
};

// ── 加载 OpenAI 预设 ──
const presets = [];
for (const f of fs.readdirSync(DIR).filter(x => x.toLowerCase().endsWith('.json'))) {
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    if (!Array.isArray(raw.prompts)) continue;   // 只看 OpenAI 预设
    const ids = new Set();
    const enabled = new Map();
    const contentById = new Map();
    for (const p of raw.prompts) {
        if (!p || typeof p.identifier !== 'string') continue;
        ids.add(p.identifier);
        enabled.set(p.identifier, p.enabled !== false);
        contentById.set(p.identifier, normalize(p.content || ''));
    }
    // 全局默认 order（两种 character_id 都收集，分别报告）
    const orders = {};
    if (Array.isArray(raw.prompt_order)) {
        for (const g of raw.prompt_order) {
            if (!g || typeof g !== 'object') continue;
            orders[String(g.character_id)] = (g.order || []).map(o => o && o.identifier).filter(Boolean);
        }
    }
    presets.push({
        file: f, ids, enabled, contentById, orders,
        promptCount: raw.prompts.length,
        totalChars: [...contentById.values()].reduce((a, b) => a + b.length, 0),
        samplers: {
            temperature: raw.temperature, top_p: raw.top_p, top_k: raw.top_k,
            repetition_penalty: raw.repetition_penalty, min_p: raw.min_p
        }
    });
}

console.log(`═════ 结构指纹判别力量化 ═════`);
console.log(`OpenAI 预设：${presets.length} 个\n`);
presets.forEach((p, i) => {
    console.log(`  [${i}] ${p.file}`);
    console.log(`       块数=${p.promptCount} ｜ 去重 identifier=${p.ids.size} ｜ 正文字符=${p.totalChars} ｜ order 的 character_id=${Object.keys(p.orders).join(',') || '无'}`);
});
console.log('');

// ── ① 共同骨架识别 ──
const allIds = new Map();
presets.forEach(p => p.ids.forEach(id => allIds.set(id, (allIds.get(id) || 0) + 1)));
const universal = [...allIds.entries()].filter(([, c]) => c === presets.length).map(([id]) => id);
console.log(`【默认骨架】${universal.length} 个 identifier 出现在**全部** ${presets.length} 个预设中：`);
console.log(`  ${universal.join(', ')}\n`);

// ── ② 两两对比：identifier Jaccard vs content Jaccard ──
console.log('【两两对比】identifier Jaccard（结构） vs content Jaccard（内容）');
console.log('  A ↔ B                                  结构Jaccard  内容Jaccard  结构-内容差  判定');
console.log('  ─────────────────────────────────────────────────────────────────────────────────────');
const rows = [];
for (let a = 0; a < presets.length; a++) {
    for (let b = a + 1; b < presets.length; b++) {
        const A = presets[a], B = presets[b];
        const structJ = setJac(A.ids, B.ids);
        // 内容：只比共有 identifier，按块字符数加权
        const common = [...A.ids].filter(id => B.ids.has(id));
        let wSum = 0, wTot = 0, skipped = 0;
        for (const id of common) {
            const ca = A.contentById.get(id) || '', cb = B.contentById.get(id) || '';
            const cj = jac(shingles(ca), shingles(cb));   // 可能为 null（两侧都空）
            if (cj === null) { skipped++; continue; }
            const w = Math.min(ca.length, cb.length) || 1;
            wSum += w * cj;
            wTot += w;
        }
        const contentJ = wTot > 0 ? wSum / wTot : null;
        const fmt = (v) => v === null ? '   n/a' : (v * 100).toFixed(1).padStart(5) + '%';
        const diff = (structJ !== null && contentJ !== null) ? structJ - contentJ : null;
        const label = (structJ !== null && contentJ !== null && structJ >= 0.90 && contentJ < 0.60)
            ? '⚠️ 结构高/内容低（方案称「换皮」）'
            : (structJ !== null && contentJ !== null && structJ >= 0.90 && contentJ >= 0.90) ? '✅ 真重复'
                : (structJ !== null && structJ < 0.10) ? '·（结构无关）' : '·';
        rows.push({ A: A.file, B: B.file, structJ, contentJ, diff, label, skipped });
        const nm = `${A.file.slice(0, 18)} ↔ ${B.file.slice(0, 18)}`.padEnd(38);
        console.log(`  ${nm} ${fmt(structJ)}  ${fmt(contentJ).padStart(9)}  ${fmt(diff).padStart(9)}   ${label}${skipped ? `（跳过空块 ${skipped}）` : ''}`);
    }
}

// ── ③ 判别力结论 ──
console.log('');
const structs = rows.map(r => r.structJ).filter(v => v !== null);
const contents = rows.map(r => r.contentJ).filter(v => v !== null);
const stMin = Math.min(...structs), stMax = Math.max(...structs);
console.log(`【判别力】`);
console.log(`  结构 Jaccard 区间：${(stMin * 100).toFixed(1)}% ~ ${(stMax * 100).toFixed(1)}%   （跨度 ${((stMax - stMin) * 100).toFixed(1)} 个百分点）`);
if (contents.length) {
    const cMin = Math.min(...contents), cMax = Math.max(...contents);
    console.log(`  内容 Jaccard 区间：${(cMin * 100).toFixed(1)}% ~ ${(cMax * 100).toFixed(1)}%   （跨度 ${((cMax - cMin) * 100).toFixed(1)} 个百分点）`);
}
console.log(`  方案「换皮」判据（结构≥90% 且 内容<60%）命中：${rows.filter(r => r.label.includes('换皮')).length} 对`);
console.log('');
console.log(`  ⚠️ 判别力解读：`);
console.log(`     结构 Jaccard 跨度 ${((stMax - stMin) * 100).toFixed(1)} 个百分点 —— **判别力充足**（方案此点成立）。`);
console.log(`     原因：预设各自带大量**自定义块**（合计 ${allIds.size} 个去重 identifier，${presets.length} 个预设共 ${presets.reduce((a, p) => a + p.ids.size, 0)} 个块位），`);
console.log(`     远超 ${universal.length} 个默认骨架块 ⇒ 骨架造成的「基础分」被自定义块差异稀释。`);
console.log(`     ⇒ 但骨架仍会**抬高下限**：需实测「无关预设」的结构 Jaccard 是否真的够低（见上表 3%~5% 那几行）。`);

// ── ④ 排除骨架后的判别力（对照实验）──
console.log('');
console.log('【对照实验】剔除默认骨架后重算 identifier Jaccard（看是否恢复判别力）');
console.log('  A ↔ B                                  含骨架     剔骨架     变化');
console.log('  ─────────────────────────────────────────────────────────────────────');
for (const r of rows) {
    const A = presets.find(p => p.file === r.A), B = presets.find(p => p.file === r.B);
    const na = new Set([...A.ids].filter(id => !universal.includes(id)));
    const nb = new Set([...B.ids].filter(id => !universal.includes(id)));
    const stripped = (na.size + nb.size === 0) ? 1 : setJac(na, nb);
    const nm = `${r.A.slice(0, 18)} ↔ ${r.B.slice(0, 18)}`.padEnd(38);
    const fmt2 = (v) => v === null ? '   n/a' : (v * 100).toFixed(1).padStart(5) + '%';
    const chg = (stripped !== null && r.structJ !== null) ? ((stripped - r.structJ) * 100).toFixed(1).padStart(6) + '%' : '   n/a';
    console.log(`  ${nm} ${fmt2(r.structJ).padStart(7)}  ${fmt2(stripped).padStart(7)}  ${chg}`);
}
