/**
 * 🎨 打标弹窗「深色主题覆盖」静态审计（2026-10-03 新增）
 *
 * 干什么：扫 `js/components/AITagModal.vue` 里所有**浅色意图**的工具类，逐个到 `css/style.css` 的
 *   `[data-theme="dark"]` / `[data-theme="slate"]` 两块里查有没有对应重映射 —— 没有的就是
 *   「深色下会浅底贴深底 / 深字压深底」的隐患。
 *
 * 判据（浅色意图）：
 *   · `bg-*-50/100/200`、`bg-white`、`bg-white/50`（浅底；**含透明度变体**）—— 深色下会变成亮块
 *   · `text-*-600..900`（深字）—— 深色下不可读
 *   · `border-*-200/300`（浅边）
 *
 * 用法：node scripts/probes/_probe-tagmodal-theme-audit.mjs
 *   ⚠️ 已知 3 条白名单（不算问题）：
 *      · `selection:bg-blue-200`（文本选中高亮本就该浅）
 *      · `bg-teal-50/60` / `text-teal-600|700` 系列（由专用类 `.jsk-wb-block` 覆盖，见 style.css 末尾）
 *   ⇒ **新增浅色类后先跑这个**，再去 `_probe-tagmodal-theme-measure.mjs` 实测对比度。
 *
 * 历史：2026-10-03 首次运行报 20 处漏映射（slate 与 teal 整族、`bg-indigo-50/60` 等）；补齐后 0 处。
 *   同日用户第二次反馈「空态框深色下是亮灰药丸」= `bg-white/50` 漏映射 —— 本探针因此扩展到支持
 *   white/black 这类**无号色阶**与**带透明度变体**（原版只认 `-数字`，正是它漏掉 `bg-white/50` 的原因）。
 */
import fs from 'node:fs';

const modal = fs.readFileSync('js/components/AITagModal.vue', 'utf8');
const css = fs.readFileSync('css/style.css', 'utf8');

// 切出 dark / slate 两个主题块
function blockOf(theme) {
    const re = new RegExp(`\\[data-theme="${theme}"\\][\\s\\S]*?(?=\\[data-theme="|$)`, 'g');
    return (css.match(re) || []).join('\n');
}
const themed = blockOf('dark') + '\n' + blockOf('slate');

// 类名模式：`家族-色阶` 或 无家族的 `white|black`，末尾可带 /透明度
const FAMILIES = 'gray|slate|zinc|indigo|teal|rose|amber|emerald|purple|blue|sky|cyan|green|red|orange|yellow|pink|fuchsia|violet|lime|stone|neutral';
const SHADE = '(?:[0-9]{2,3}|white|black)';
const CORE = `(?:(?:${FAMILIES})-${SHADE}|white|black)`;
const CLS_BODY = `(?:bg|text|border)-${CORE}(?:\\/[0-9]{2,3})?`;
// ⚠️ CSS 里的类名会**转义斜杠**（写成 `.bg-indigo-50\/60`）⇒ 扫 CSS 时斜杠前要有可选反斜杠，
//    否则「明明补过」的项会被误报为未覆盖（本探针第一版就踩了这个，误报 5 处）。
const CLS_BODY_CSS = `(?:bg|text|border)-${CORE}(?:\\\\?\\/[0-9]{2,3})?`;

// 已覆盖集合（统一去掉反斜杠再比）
const covered = new Set();
for (const m of themed.matchAll(new RegExp(`\\.(${CLS_BODY_CSS})`, 'g'))) {
    covered.add(m[1].replace(/\\/g, ''));
}

// 收集弹窗里用到的工具类（cls -> 首次出现行号）
const used = new Map();
modal.split(/\r?\n/).forEach((ln, i) => {
    for (const m of ln.matchAll(new RegExp(`\\b(${CLS_BODY})\\b`, 'g'))) {
        if (!used.has(m[1])) used.set(m[1], i + 1);
    }
});

/** 该组合是否「浅色意图」（会在深色主题下出问题） */
function isLightIntent(cls) {
    // 无家族形式：bg-white / bg-white\/50 是浅底；bg-black 是深底（正常）
    const wb = cls.match(/^(bg|text|border)-(white|black)(?:\/[0-9]{2,3})?$/);
    if (wb) return wb[2] === 'white' && wb[1] === 'bg';
    const m = cls.match(/^(bg|text|border)-([a-z]+)-([0-9]{2,3}|white|black)/);
    if (!m) return false;
    const [, kind, color, shade] = m;
    if (color === 'white') return kind === 'bg';
    if (color === 'black') return false;
    const s = Number(shade);
    if (!Number.isFinite(s)) return false;
    if (kind === 'bg') return s <= 200;            // 浅底
    if (kind === 'text') return s >= 600 && s <= 900; // 深字（深底上不可读）
    if (kind === 'border') return s <= 300;        // 浅边
    return false;
}

/**
 * 白名单：这些「浅色意图」类**不需要**主题覆盖，逐条说明原因（不写原因的白名单等于掩盖问题）。
 */
const WHITELIST = {
    'bg-blue-200': '进度条轨道：位于**恒为深色**的弹窗头部（bg-gray-900 不随主题变）⇒ 浅色轨道三主题都对',
    'bg-white/25': '徽标底色：叠在**固定色** active 导航项（bg-indigo-600）上 ⇒ 不随主题变化',
    'bg-teal-50/60': '世界书专用 System 块：由专用类 .jsk-wb-block 在 style.css 末尾按主题覆盖',
    'text-teal-600/70': '同上（.jsk-wb-block 覆盖）',
    'text-teal-700/70': '同上（.jsk-wb-block 覆盖）'
};

const bad = [];
const whitelisted = [];
for (const [cls, line] of used) {
    if (!isLightIntent(cls)) continue;
    if (covered.has(cls)) continue;
    if (WHITELIST[cls]) { whitelisted.push({ cls, line }); continue; }
    bad.push({ cls, line });
}
console.log(`弹窗用到的工具类：${used.size} 个；其中「浅色意图」${[...used.keys()].filter(isLightIntent).length} 个`);
console.log(`✅ 白名单（有明确原因，无需覆盖）：${whitelisted.length} 个`);
for (const b of whitelisted.sort((a, c) => a.line - c.line)) console.log(`     L${String(b.line).padStart(4)}  ${b.cls} —— ${WHITELIST[b.cls]}`);
console.log(`⚠️ 未覆盖且不在白名单（会在 dark/slate 下出问题）：${bad.length} 个`);
for (const b of bad.sort((a, c) => a.line - c.line)) console.log(`  L${String(b.line).padStart(4)}  ${b.cls}`);
process.exit(bad.length === 0 ? 0 : 1);
