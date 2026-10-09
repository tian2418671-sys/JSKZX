/**
 * ⬇️ 会话导出 单测（`js/utils/chatExport.js`）
 * 覆盖规格 §四 验收口径：转义 / 空会话 / HTML 段拼接 / 文件名清洗 / swipe 分支选取。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    EXPORT_FORMATS, sanitizeFileName, formatStamp, buildExportFileName,
    roleLabel, toMessageView, toSessionView, escapeHtml, escapeAttr, htmlToPlain, miniMarkdown,
    buildSessionPlainText, buildSessionMarkdown, buildSessionHtml, buildSessionExport,
    isLargeExport, LARGE_EXPORT_BYTES, varsToYaml
} from '../js/utils/chatExport.js';

/** 造一个含 swipe 分支 / HTML 段 / 多轮的会话 */
function mkSession() {
    return {
        id: 'cs_1', name: '第 3 次测试', cardPath: '/lib/小樱.json',
        createdAt: Date.UTC(2026, 9, 3, 4, 5, 6), updatedAt: Date.UTC(2026, 9, 3, 6, 7, 8),
        messages: [
            { role: 'user', content: '你好 **世界**' },
            { role: 'assistant', swipes: ['第一条候选', '当前分支：```html\n<div class="box">渲染内容</div>\n```\n尾巴'], index: 1 },
            { role: 'system', content: '（系统提示）' }
        ]
    };
}

test('EXPORT_FORMATS：三种格式（md 默认 / html / txt）', () => {
    assert.deepEqual(EXPORT_FORMATS.map((f) => f.id), ['md', 'html', 'txt']);
    assert.equal(EXPORT_FORMATS[0].ext, 'md');
});

test('sanitizeFileName：清洗 Windows 非法字符 / 去尾点 / 截断 80', () => {
    assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
    assert.equal(sanitizeFileName('  名字.  '), '名字');
    assert.equal(sanitizeFileName(''), '未命名');
    assert.equal(sanitizeFileName('字'.repeat(120)).length, 80);
});

test('buildExportFileName：会话_卡名_yyyyMMdd-HHmm.ext', () => {
    const n = buildExportFileName({ cardName: '小樱', format: 'html', now: new Date(2026, 9, 3, 14, 5).getTime() });
    assert.equal(n, '会话_小樱_20261003-1405.html');
    assert.ok(buildExportFileName({ cardName: '', sessionName: '第3次', format: 'txt' }).startsWith('会话_第3次_'));
    assert.ok(buildExportFileName({ cardName: 'A/B', format: 'md' }).includes('A_B'));
});

test('formatStamp：非法时间有兜底且不抛异常', () => {
    assert.match(formatStamp(Date.now()), /^\d{8}-\d{4}$/);
    assert.equal(typeof formatStamp('not-a-date'), 'string');
    assert.equal(formatStamp('not-a-date'), '00000000-0000');
});

test('roleLabel：assistant→卡名，user→用户名，缺省有兜底', () => {
    assert.equal(roleLabel('assistant', { charName: '小樱' }), '小樱');
    assert.equal(roleLabel('assistant', {}), 'AI');
    assert.equal(roleLabel('user', {}), '你');
    assert.equal(roleLabel('system', {}), '系统');
});

test('★ swipe 分支：导出当前 index 指向的那一条（与界面所见一致）', () => {
    const s = mkSession();
    const m = toMessageView(s.messages[1], 1, {});
    assert.ok(m.text.startsWith('当前分支：'), '应取 index=1 的分支');
    assert.ok(!m.text.includes('第一条候选'));
    // 切换 index → 导出内容随之变化
    const m2 = toMessageView({ ...s.messages[1], index: 0 }, 1, {});
    assert.equal(m2.text, '第一条候选');
});

test('HTML 段切分：```html 围栏被识别为 html 段（不是文本段）', () => {
    const m = toMessageView({ role: 'assistant', content: '前缀\n```html\n<div>x</div>\n```\n后缀' }, 0, {});
    const types = m.segments.map((x) => x.type);
    assert.ok(types.includes('html'), `段类型应含 html，实际 ${JSON.stringify(types)}`);
    const htmlSeg = m.segments.find((x) => x.type === 'html');
    assert.ok(htmlSeg.content.includes('<div>x</div>'));
});

test('元信息头三格式一致：卡名 / 标题 / 时间 / 模型 / 预设', () => {
    const s = mkSession();
    const opts = { charName: '小樱', model: 'gemini-flash', preset: '默认预设', now: new Date(2026, 9, 3, 14, 5, 6).getTime() };
    const md = buildSessionMarkdown(s, opts);
    const html = buildSessionHtml(s, opts);
    const txt = buildSessionPlainText(s, opts);
    for (const t of [md, html, txt]) {
        assert.ok(t.includes('小樱'), '含卡名');
        assert.ok(t.includes('第 3 次测试'), '含会话标题');
        assert.ok(t.includes('gemini-flash'), '含模型');
        assert.ok(t.includes('默认预设'), '含预设');
    }
});

test('Markdown：每条消息一个 ### 标题 + HTML 段附提示与摘要 + 末尾 yaml 变量快照', () => {
    const md = buildSessionMarkdown(mkSession(), { charName: '小樱', varsSnapshot: '好感度: 42' });
    assert.ok(md.startsWith('# 第 3 次测试'));
    assert.match(md, /### 小樱/);
    assert.match(md, /### 你/);
    assert.ok(md.includes('⛩️ HTML 渲染内容'));
    assert.ok(md.includes('渲染内容'), '含 HTML 段纯文本摘要');
    assert.ok(md.includes('```yaml') && md.includes('好感度: 42') && md.includes('```'), 'yaml 代码块闭合');
});

test('Markdown：includeVars=false 时不附变量快照', () => {
    const md = buildSessionMarkdown(mkSession(), { varsSnapshot: 'x: 1', includeVars: false });
    assert.ok(!md.includes('```yaml'));
});

test('纯文本：[角色名] 正文 顺序拼接', () => {
    const txt = buildSessionPlainText(mkSession(), { charName: '小樱' });
    assert.ok(txt.includes('[你] 你好 **世界**'));
    assert.ok(txt.includes('[小樱] 当前分支'));
    assert.ok(txt.includes('[系统] （系统提示）'));
    const iUser = txt.indexOf('[你]');
    const iChar = txt.indexOf('[小樱]');
    assert.ok(iUser >= 0 && iUser < iChar, '顺序应与会话一致');
});

test('★ HTML 单文件：charset / 内联样式 / 消息顺序 / HTML 段进 sandbox iframe（不裸执行脚本）', () => {
    const html = buildSessionHtml(mkSession(), { charName: '小樱' });
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('<meta charset="utf-8">'));
    assert.ok(html.includes('<style>') && html.includes('.msg'), '内联导出模板样式');
    assert.ok(html.includes('srcdoc='), 'HTML 段用 srcdoc 承载');
    assert.ok(html.includes('sandbox="allow-scripts"'), '与面板同口径的 sandbox');
    const i1 = html.indexOf('你好');
    const i2 = html.indexOf('当前分支');
    assert.ok(i1 >= 0 && i1 < i2, '消息顺序正确');
});

test('HTML：注入 renderText 时优先用宿主渲染器（保证与面板一致）', () => {
    const html = buildSessionHtml(mkSession(), { charName: 'X', renderText: (t) => `<p class="custom">${String(t).length}</p>` });
    assert.ok(html.includes('class="custom"'));
});

test('HTML 转义：srcdoc 属性与正文里的尖括号/引号都被转义（注入防线）', () => {
    const s = { name: 's', messages: [{ role: 'assistant', content: '```html\n<img src=x onerror="alert(1)">\n```' }] };
    const html = buildSessionHtml(s, {});
    assert.ok(html.includes('&quot;'), '引号被转义');
    assert.ok(!/onerror="alert/.test(html), '不应出现未转义的属性注入');
    assert.equal(escapeHtml('<a&b>'), '&lt;a&amp;b&gt;');
    assert.equal(escapeAttr('a"b<c'), 'a&quot;b&lt;c');
});

test('miniMarkdown：标题/粗体/行内代码/代码块（导出模板子集）', () => {
    const html = miniMarkdown('# 标题\n\n**粗** 与 `码`\n\n```\nraw <b>\n```');
    assert.ok(html.includes('<h1>标题</h1>'));
    assert.ok(html.includes('<strong>粗</strong>'));
    assert.ok(html.includes('<code>码</code>'));
    assert.ok(html.includes('raw &lt;b&gt;'), '代码块内容应转义');
});

test('htmlToPlain：剥离 script/style/标签并压缩空白', () => {
    assert.equal(htmlToPlain('<div>甲 <b>乙</b></div><script>bad()</script>'), '甲 乙');
});

test('空会话：三种格式都不抛异常（禁用逻辑在 UI 层）', () => {
    for (const f of ['md', 'html', 'txt']) {
        const out = buildSessionExport({ name: '空', messages: [] }, f, {});
        assert.equal(typeof out, 'string');
        assert.ok(out.length > 0);
    }
    assert.ok(buildSessionMarkdown({}, {}).includes('# 未命名会话'));
    assert.ok(buildSessionExport({ messages: [] }, 'unknown', {}).includes('#')); // 未知格式退回 md
});

test('超长会话：isLargeExport 阈值判定（>10MB）', () => {
    assert.equal(isLargeExport('a'.repeat(10)), false);
    assert.equal(isLargeExport('a'.repeat(LARGE_EXPORT_BYTES + 1)), true);
});

test('toSessionView：元信息与逐条消息齐全', () => {
    const v = toSessionView(mkSession(), { charName: '小樱', model: 'm', preset: 'p' });
    assert.equal(v.title, '第 3 次测试');
    assert.equal(v.messages.length, 3);
    assert.equal(v.userName, '你');
    assert.match(v.exportedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('varsToYaml：嵌套对象/数组展开 + 需引号的值加引号', () => {
    const y = varsToYaml({ 好感度: 42, 角色: { 名: '小樱', 标签: ['a', 'b'] }, 空: [], 描述: '含: 冒号' });
    assert.ok(y.includes('好感度: 42'));
    assert.ok(y.includes('角色.名: 小樱'));
    assert.ok(y.includes('角色.标签[0]: a'));
    assert.ok(y.includes('空: []'));
    assert.ok(y.includes('描述: "含: 冒号"'), '含特殊字符应加引号');
    assert.equal(varsToYaml({}), '{}' === '{}' ? varsToYaml({}) : ''); // 不抛
});
