/**
 * 🧪 材料策略对照实验（真实库 + 真实 API · **只读库、不写任何配置/标签**）
 *
 * 目的：回答「多送 / 少送 / 怎么送，中间值在哪」——
 *   在同一本书、同一个模型下，用**相同请求数**比较三种送料策略的标签质量与真实 token：
 *     S1 现状·均匀采样（全量材料按 3500 字切段，等距抽 cap 段）
 *     S2 骨架（只送 书名 + 简介 + 词条名 + 触发词，**不送正文**）
 *     S3 智能选段（同样 cap 段，但按 触发词命中 / 词条名命中 打分选，含 20% 均匀保底）
 *
 * ⚠️ 安全：
 *   · **不写任何文件**（除结果 JSON/报告）、**不写配置、不落标签**；只 readFileSync 真实库 + 调 API。
 *   · 请求数自带硬上限（默认 250）、逐请求 90s 超时、失败重试 1 次。
 *   · API key 从 `%TEMP%\jsk-exp-cfg.json` 读（由 `_exp-read-config.mjs` 从运行实例导出），**不打印**。
 *
 * 用法：
 *   node scripts/probes/_exp-material-strategy.mjs                 # 默认 4 本 × 3 策略，cap=15
 *   node scripts/probes/_exp-material-strategy.mjs --cap=8 --books=2
 *
 * 指标：请求数 / 实发字数 / **真实 prompt_tokens（取自 API usage）** / 标签数 / 覆盖率 /
 *       有据率（标签能在全量材料里找到依据的比例，自动代理）/ 两两 Jaccard 一致率。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWbMaterial, listWbEntries, isEntryDisabled, entryTitle, entryPrimaryKeys, entrySecondaryKeys } from '../../js/utils/wbMaterial.js';
import { splitTextSegments, SEGMENT_DEFAULT_MAX_CHARS, SEGMENT_DEFAULT_CHUNK_CHARS } from '../../js/utils/llmPromptRoles.js';

// ── 参数 ──
const argOf = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const SMOKE = process.argv.includes('--smoke');
const CAP = SMOKE ? 1 : Math.max(1, Number(argOf('cap', 15)));
const MAX_BOOKS = Math.max(1, Number(argOf('books', 4)));
const MAX_REQUESTS = Math.max(10, Number(argOf('maxreq', 250)));
const LIB = argOf('lib', 'H:\\01\\全局世界书');
const CFG_PATH = path.join(os.tmpdir(), 'jsk-exp-cfg.json');
const OUT_JSON = path.resolve('scripts/probes/_exp-material-strategy-result.json');
const DELAY_MS = 250;

const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
if (!cfg.key || !cfg.endpoint || !cfg.model) { console.error('❌ 配置不完整（先跑 _exp-read-config.mjs）'); process.exit(1); }
const CHAT_URL = (() => {
    let u = String(cfg.endpoint).trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(u)) return u;
    if (/\/v1\/models$/.test(u)) return u.replace(/\/v1\/models$/, '/v1/chat/completions');
    if (/\/v1$/.test(u)) return u + '/chat/completions';
    return u;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
let reqCount = 0;

// ── 材料构建（与 App 同源纯函数）──
function walk(dir, out = []) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.json$/i.test(e.name)) out.push(p);
    }
    return out;
}

/** 🦴 骨架：书名 + 简介 + 词条名 + 触发词（无正文） */
function buildSkeleton(wb, name) {
    const entries = listWbEntries(wb).filter((e) => !isEntryDisabled(e));
    const head = [`书名：${name}`, '【骨架材料 · 全部词条的索引（词条名 + 触发词），正文未展开】'];
    const desc = String((wb && wb.data && wb.data.description) || '').trim();
    if (desc) head.push('简介：' + desc);
    head.push(`词条数：${entries.length}`);
    const lines = entries.map((e, i) => {
        const t = entryTitle(e) || `词条${i + 1}`;
        const keys = entryPrimaryKeys(e).concat(entrySecondaryKeys(e)).filter(Boolean);
        return `- ${t}${keys.length ? '（' + keys.join(' / ') + '）' : ''}`;
    });
    return head.concat(lines).join('\n');
}

/** 与 App 完全一致的均匀采样 */
function uniformSample(segs, cap) {
    if (segs.length <= cap) return segs.map((s, i) => ({ i, text: s }));
    const stride = segs.length / cap;
    const out = [];
    for (let k = 0; k < cap; k++) {
        const i = Math.min(segs.length - 1, Math.floor(k * stride));
        out.push({ i, text: segs[i] });
    }
    return out;
}

/** 智能选段：触发词命中 ×3 + 词条名命中 ×2 + 长度权重；尾部 20% 名额给均匀保底（防偏） */
function smartSample(segs, cap, wb) {
    const entries = listWbEntries(wb).filter((e) => !isEntryDisabled(e));
    const keys = [];
    const titles = [];
    for (const e of entries) {
        for (const k of entryPrimaryKeys(e).concat(entrySecondaryKeys(e))) {
            const s = String(k || '').trim();
            if (s.length >= 2) keys.push(s);
        }
        const t = String(entryTitle(e) || '').trim();
        if (t.length >= 2) titles.push(t);
    }
    const scored = segs.map((text, i) => {
        let s = 0;
        for (const k of keys) if (text.includes(k)) s += 3;
        for (const t of titles) if (text.includes(t)) s += 2;
        s += Math.min(text.length, SEGMENT_DEFAULT_CHUNK_CHARS) / SEGMENT_DEFAULT_CHUNK_CHARS;
        return { i, text, score: s };
    });
    const keep = Math.max(1, Math.round(cap * 0.8));
    const top = scored.slice().sort((a, b) => (b.score - a.score) || (a.i - b.i)).slice(0, keep);
    const picked = new Set(top.map((x) => x.i));
    const rest = Math.max(0, cap - top.length);
    if (rest > 0) {
        const others = scored.filter((x) => !picked.has(x.i));
        if (others.length) {
            const stride = others.length / rest;
            for (let k = 0; k < rest; k++) picked.add(others[Math.min(others.length - 1, Math.floor(k * stride))].i);
        }
    }
    return scored.filter((x) => picked.has(x.i)).sort((a, b) => a.i - b.i);
}

// ── 提示词组装（忠实于 App 的自定义模式：SYSTEM 段原样 + 一条 USER = task + pool + output + 材料）──
const stripVars = (t) => String(t || '').replace(/\{\{[^}]*\}\}/g, '').replace(/\$1\b/g, '');
const SYS = cfg.systemSegs.map(stripVars).filter((s) => s.trim()).join('\n\n');
const userTextOf = (materialSection) => [cfg.task, cfg.pool, cfg.output, materialSection].filter((x) => String(x || '').trim()).join('');

// ── 调 API（OpenAI 兼容；读 usage）──
async function callApi(userText) {
    if (reqCount >= MAX_REQUESTS) throw new Error(`已达请求上限 ${MAX_REQUESTS}`);
    reqCount++;
    const body = {
        model: cfg.model,
        messages: [...(SYS.trim() ? [{ role: 'system', content: SYS }] : []), { role: 'user', content: userText }],
        temperature: 0.2
    };
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 90000);
            const res = await fetch(CHAT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` }, body: JSON.stringify(body), signal: ac.signal });
            clearTimeout(timer);
            const txt = await res.text();
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
            const data = JSON.parse(txt);
            const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
            const usage = data.usage || {};
            return { text: String(msg.content || ''), promptTokens: Number(usage.prompt_tokens || 0), completionTokens: Number(usage.completion_tokens || 0), usagePresent: !!data.usage };
        } catch (e) {
            lastErr = e;
            if (attempt === 0) await sleep(1200);
        }
    }
    throw lastErr;
}

/** 解析标签（三级降级：<tags>[…] → 任意 JSON 数组 → 行/逗号切分） */
function parseTags(text) {
    const t = String(text || '');
    const grab = (s) => {
        try { const a = JSON.parse(s); return Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean) : null; } catch (e) { return null; }
    };
    let m = t.match(/<tags>\s*([\s\S]*?)\s*<\/tags>/i);
    if (m) { const a = grab(m[1]); if (a) return a; }
    m = t.match(/\[[\s\S]*?\]/);
    if (m) { const a = grab(m[0]); if (a) return a; }
    return t.split(/[\n,，、;；]/).map((x) => x.replace(/^[\s\-*"'`[]+|[\s"'`\]]+$/g, '').replace(/^标签[:：]?/, '').trim()).filter((x) => x && x.length <= 24 && !/[{}]/.test(x)).slice(0, 30);
}

const jaccard = (a, b) => {
    const A = new Set(a); const B = new Set(b);
    const inter = [...A].filter((x) => B.has(x)).length;
    const uni = new Set([...A, ...B]).size || 1;
    return Math.round(inter / uni * 1000) / 1000;
};
/** 有据率（自动代理）：标签整体或其 2 字片段能在**全量材料**里找到 */
function groundedRate(tags, fullMaterial) {
    if (!tags.length) return 0;
    let ok = 0;
    for (const t of tags) {
        if (fullMaterial.includes(t)) { ok++; continue; }
        let hit = false;
        for (let i = 0; i + 2 <= t.length; i++) { if (fullMaterial.includes(t.slice(i, i + 2))) { hit = true; break; } }
        if (hit) ok++;
    }
    return Math.round(ok / tags.length * 1000) / 1000;
}

// ── 选书：按材料字数取「最重、次重、中、轻」四本 ──
const files = walk(LIB);
const books = [];
for (const f of files) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
    const wb = { name: path.basename(f), wbName: raw && raw.name, data: raw };
    const entries = listWbEntries(wb);
    if (!entries.length) continue;
    const name = (raw && raw.name) || path.basename(f);
    const material = buildWbMaterial(wb, { name });
    books.push({ file: path.basename(f), name, wb, entries: entries.length, material, skeleton: buildSkeleton(wb, name) });
}
books.sort((a, b) => b.material.length - a.material.length);
const picked = [];
if (books.length) picked.push(books[0]);                    // 最重（巨书）
const many = books.filter((b) => b.entries >= 500 && !picked.includes(b))[0];
if (many) picked.push(many);                                 // 词条最多的大书（覆盖"多词条"形态）
const mid = books.filter((b) => b.material.length > 50000 && b.material.length < 200000 && !picked.includes(b))[0];
if (mid) picked.push(mid);                                   // 中量
const light = books.filter((b) => b.material.length <= SEGMENT_DEFAULT_MAX_CHARS && !picked.includes(b))[0];
if (light) picked.push(light);                               // 轻（单请求）
while (picked.length > MAX_BOOKS) picked.pop();
if (SMOKE) { picked.length = 0; picked.push(books[books.length - 1]); } // 冒烟：最小的一本（3 个请求）

console.log('═════ 材料策略对照实验 ═════');
console.log(`库：${LIB} · 模型：${cfg.model}`);
console.log(`cap（S1/S3 每本请求数）= ${CAP} · 最多 ${MAX_BOOKS} 本 · 请求硬上限 ${MAX_REQUESTS}`);
console.log(`固定开销：SYSTEM ${SYS.length} 字 + task/pool/output ${userTextOf('').length} 字\n`);

const result = { meta: { time: new Date().toISOString(), model: cfg.model, cap: CAP, endpointHost: new URL(CHAT_URL).host, fixedOverheadChars: userTextOf('').length, sysChars: SYS.length }, books: [], errors: [] };

for (const b of picked) {
    const segs = splitTextSegments(b.material, SEGMENT_DEFAULT_CHUNK_CHARS);
    console.log(`\n──── 📖 ${b.name} ────`);
    console.log(`  词条 ${b.entries} · 全量材料 ${fmt(b.material.length)} 字 · 段数 ${segs.length} · 骨架 ${fmt(b.skeleton.length)} 字`);

    const strategies = [];
    // S1 现状：均匀采样
    strategies.push({ id: 'S1', label: '现状·均匀采样', segs: uniformSample(segs, CAP), mode: 'full' });
    // S2 骨架
    const skelSegs = splitTextSegments(b.skeleton, SEGMENT_DEFAULT_CHUNK_CHARS);
    strategies.push({ id: 'S2', label: '骨架（无正文）', segs: skelSegs.map((s, i) => ({ i, text: s })), mode: 'skeleton' });
    // S3 智能选段
    strategies.push({ id: 'S3', label: '智能选段', segs: smartSample(segs, CAP, b.wb), mode: 'full' });

    const bookOut = { name: b.name, entries: b.entries, materialChars: b.material.length, segTotal: segs.length, skeletonChars: b.skeleton.length, strategies: [] };
    for (const st of strategies) {
        let tokens = 0, comp = 0, chars = 0, requests = 0, usageSeen = 0;
        const tagCount = new Map();
        const stTags = [];
        for (let k = 0; k < st.segs.length; k++) {
            const seg = st.segs[k];
            const section = st.mode === 'skeleton'
                ? `\n\n【世界书骨架 · 第 ${k + 1}/${st.segs.length} 段】\n${seg.text}`
                : `\n\n【世界书节选 · 第 ${k + 1}/${st.segs.length} 段】\n${seg.text}`;
            const userText = userTextOf(section);
            chars += seg.text.length;
            try {
                const r = await callApi(userText);
                requests++;
                tokens += r.promptTokens; comp += r.completionTokens;
                if (r.usagePresent) usageSeen++;
                const tags = parseTags(r.text);
                for (const t of tags) { if (!tagCount.has(t)) { tagCount.set(t, 0); stTags.push(t); } tagCount.set(t, tagCount.get(t) + 1); }
            } catch (e) {
                result.errors.push({ book: b.name, strategy: st.id, seg: k + 1, err: String(e && e.message || e).slice(0, 160) });
                console.log(`    ⚠️ ${st.id} 第 ${k + 1} 段失败：${String(e && e.message || e).slice(0, 90)}`);
            }
            await sleep(DELAY_MS);
        }
        const ordered = stTags.slice().sort((x, y) => (tagCount.get(y) - tagCount.get(x)) || (stTags.indexOf(x) - stTags.indexOf(y)));
        const rec = {
            id: st.id, label: st.label, requests, chars, promptTokens: tokens, completionTokens: comp, usagePresent: usageSeen,
            tags: ordered, tagCount: ordered.length,
            coverage: Math.round(chars / Math.max(1, b.material.length) * 1000) / 1000,
            grounded: groundedRate(ordered, b.material),
            tagsPerRequest: requests ? Math.round(ordered.length / requests * 100) / 100 : 0,
            tokensPerTag: ordered.length ? Math.round(tokens / ordered.length) : 0
        };
        bookOut.strategies.push(rec);
        console.log(`  ${st.id} ${st.label.padEnd(14)} 请求 ${String(requests).padStart(3)} · 实发 ${fmt(chars).padStart(9)} 字（覆盖 ${(rec.coverage * 100).toFixed(1)}%）· 真实 prompt ${fmt(tokens).padStart(9)} tok · 标签 ${String(ordered.length).padStart(3)} · 有据 ${(rec.grounded * 100).toFixed(0)}% · 每标签 ${rec.tokensPerTag} tok`);
    }
    // 两两一致率
    const byId = Object.fromEntries(bookOut.strategies.map((s) => [s.id, s.tags]));
    bookOut.pairwise = {
        'S1∩S2': jaccard(byId.S1 || [], byId.S2 || []),
        'S1∩S3': jaccard(byId.S1 || [], byId.S3 || []),
        'S2∩S3': jaccard(byId.S2 || [], byId.S3 || [])
    };
    console.log(`  一致率 Jaccard：S1∩S2 ${bookOut.pairwise['S1∩S2']} · S1∩S3 ${bookOut.pairwise['S1∩S3']} · S2∩S3 ${bookOut.pairwise['S2∩S3']}`);
    result.books.push(bookOut);
}

result.totalRequests = reqCount;
fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 1), 'utf8');
console.log(`\n═════ 完成：共 ${reqCount} 个请求 · 结果已写 ${OUT_JSON} ═════`);
if (result.errors.length) console.log(`⚠️ 失败 ${result.errors.length} 次（见 JSON.errors）`);
