/**
 * 真实预设库结构勘查（为评估「预设查重方案」提供事实依据）
 *
 * 回答：
 *   · 预设类型分布（OpenAI / TextCompletion / Context / Instruct ...）
 *   · prompt_order 的 character_id 实际取值（方案说 100000，parsecard 常量是 100001 —— 以真实库为准）
 *   · prompts[] 的 identifier 分布与块数分布（决定「结构指纹」是否可行）
 *   · 采样参数字段名与 null 占比（决定「采样参数向量」是否可行）
 *   · keys 字段形态（判断预设里是否真无 keys）
 *
 * 用法：node scripts/probes/_probe-preset-structure.mjs "H:\01"
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'H:\\01';

const files = fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.json'));
console.log(`═════ 预设库结构勘查：${DIR} ═════`);
console.log(`目录内 .json：${files.length} 个\n`);

const typeCount = {};
const charIdCount = {};
const promptCounts = [];
const idFreq = new Map();
const samplerNull = {};
const samplerSeen = {};
let openAi = [], other = [], invalid = [];

const SAMPLERS = ['temperature', 'top_p', 'top_k', 'repetition_penalty', 'rep_pen', 'min_p',
    'top_a', 'frequency_penalty', 'presence_penalty', 'max_tokens', 'max_context', 'openai_max_tokens'];

for (const f of files) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); }
    catch { invalid.push(f); continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { invalid.push(f); continue; }

    // 类型判定（按结构特征，不按文件名）
    const hasPrompts = Array.isArray(raw.prompts);
    const hasOrder = Array.isArray(raw.prompt_order);
    const hasInstruct = !!(raw.instruct && typeof raw.instruct === 'object');
    const hasContext = !!(raw.context && typeof raw.context === 'object');
    const hasStoryString = typeof raw.story_string === 'string';

    let type;
    if (hasPrompts || hasOrder) type = 'OpenAI(ChatCompletion)';
    else if (hasInstruct) type = 'TextCompletion(instruct)';
    else if (hasContext || hasStoryString) type = 'ContextTemplate';
    else if (typeof raw.name === 'string' && (raw.apiType || raw.jailbreak || raw.openAIKey)) type = '疑似破限/API配置';
    else type = '其他';
    typeCount[type] = (typeCount[type] || 0) + 1;

    if (type === 'OpenAI(ChatCompletion)') {
        openAi.push(f);
        promptCounts.push(hasPrompts ? raw.prompts.length : 0);
        // identifier 频次
        if (hasPrompts) {
            for (const p of raw.prompts) {
                if (p && typeof p.identifier === 'string') idFreq.set(p.identifier, (idFreq.get(p.identifier) || 0) + 1);
            }
        }
        // prompt_order 的 character_id
        if (hasOrder) {
            for (const g of raw.prompt_order) {
                if (!g || typeof g !== 'object') continue;
                const cid = String(g.character_id);
                charIdCount[cid] = (charIdCount[cid] || 0) + 1;
            }
        }
        // 采样参数
        for (const k of SAMPLERS) {
            if (k in raw) {
                samplerSeen[k] = (samplerSeen[k] || 0) + 1;
                if (raw[k] === null) samplerNull[k] = (samplerNull[k] || 0) + 1;
            }
        }
    } else {
        other.push({ f, type, keys: Object.keys(raw).slice(0, 8).join(',') });
    }
}

console.log('【类型分布】');
for (const [t, c] of Object.entries(typeCount).sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(26)} ${c}`);
console.log(`  （解析失败/非对象：${invalid.length}）`);

console.log('\n【prompt_order 的 character_id 实际取值】（方案写 100000，parsecard 常量 100001）');
const charIdEntries = Object.entries(charIdCount).sort((a, b) => b[1] - a[1]);
if (!charIdEntries.length) console.log('  （无 prompt_order）');
for (const [cid, c] of charIdEntries) console.log(`  character_id=${cid}  → ${c} 组`);

console.log(`\n【OpenAI 预设的块数分布】（共 ${openAi.length} 个）`);
if (promptCounts.length) {
    const s = [...promptCounts].sort((a, b) => a - b);
    const st = (p) => s[Math.floor(s.length * p)];
    console.log(`  min=${s[0]}  p25=${st(.25)}  p50=${st(.5)}  p75=${st(.75)}  p90=${st(.9)}  max=${s[s.length - 1]}`);
    console.log(`  ⚠️ 方案称「60+ 模块的 mega-preset」—— 实测最大值 ${s[s.length - 1]}`);
}

console.log('\n【identifier 频次 Top 20】（决定「结构指纹 Jaccard」的判别力）');
const topIds = [...idFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
for (const [id, c] of topIds) {
    const pct = (c / openAi.length * 100).toFixed(0);
    console.log(`  ${String(c).padStart(4)} 个预设含 ${id.padEnd(34)} (${pct}%)`);
}
console.log(`  identifier 去重总数：${idFreq.size}`);

console.log('\n【采样参数出现率 / null 占比】（决定「采样参数向量」可行性）');
for (const k of SAMPLERS) {
    const seen = samplerSeen[k] || 0;
    if (!seen) continue;
    const nul = samplerNull[k] || 0;
    console.log(`  ${k.padEnd(22)} 出现 ${String(seen).padStart(3)}/${openAi.length} ｜ null ${nul}`);
}

console.log('\n【非 OpenAI 类型样本（最多 8 个）】');
other.slice(0, 8).forEach(o => console.log(`  ${o.type.padEnd(24)} ${o.f}`));
if (other.length > 8) console.log(`  …共 ${other.length} 个`);
