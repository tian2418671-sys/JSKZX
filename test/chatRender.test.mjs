/**
 * 测卡分段渲染器回归（useChatRender）
 * 覆盖：``` 围栏（含裸围栏）识别 / 文本段与面板段切分 / 准完整文档补壳与预置注入位置 /
 *       桥接 API 与沙箱兜底是否都在文档里。
 * 背景：CT-13（状态栏空白）、CT-14（``` 包裹的卡）都与这些函数直接相关，钉死在测试里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    segmentMessage, buildHtmlSrcdoc, promoteHtmlSegments, splitPending, htmlNeedsIframe, loaderUrlOf
} from '../js/composables/chat/useChatRender.js';

// ═══════════════════════════════════════════════════════════════
// 🌐 CT-04（2026-09-23）：外链界面（loader）段
// ───────────────────────────────────────────────────────────────
// 📖 病根：测卡区此前只处理 `html` 段，卡里用 `$('body').load('URL')` 的界面**完全不显示**，
//    而卡编辑器预览面板（`useStatusbarPreview.classifyTemplate`）**早就有**该能力 → 两边口径不一致。
// 📌 口径要求：与 `useStatusbarPreview` 的 loader 分支**一致**（宽松匹配 + 仅 http/https）。
// ═══════════════════════════════════════════════════════════════

test('CT-04：$("body").load(URL) → loader 段（卡编辑器预览早已支持，测卡区补齐）', () => {
    const segs = segmentMessage("<body><script>$('body').load('https://example.com/gui.html')</script></body>");
    assert.equal(segs.length, 1);
    assert.equal(segs[0].type, 'loader');
    assert.equal(segs[0].url, 'https://example.com/gui.html');
});

test('CT-04：<iframe src="URL"> 直链 → loader 段', () => {
    const segs = segmentMessage('<iframe src="https://example.com/ui" width="100%"></iframe>');
    assert.equal(segs.length, 1);
    assert.equal(segs[0].type, 'loader');
    assert.equal(segs[0].url, 'https://example.com/ui');
});

test('CT-04：```html 围栏里是 loader → loader 段（不是 html 段）', () => {
    const segs = segmentMessage('```html\n<body><script>$(\'body\').load("https://a.b/c")\n</script></body>\n```');
    assert.equal(segs.length, 1);
    assert.equal(segs[0].type, 'loader');
    assert.equal(segs[0].url, 'https://a.b/c');
});

test('CT-04：宽松匹配（单引号 / 空格 / 换行 / 无 <body> 包裹）', () => {
    assert.equal(loaderUrlOf("$('body').load('https://x.y/z')"), 'https://x.y/z');
    assert.equal(loaderUrlOf('$(  "body"  )  .  load  (  "https://x.y/z" )'), 'https://x.y/z');
    assert.equal(loaderUrlOf("$('body')\n  .load('https://x.y/z')"), 'https://x.y/z');
});

test('CT-04：非 http(s) 协议一律拒绝（防卡内容诱导加载内部协议）', () => {
    assert.equal(loaderUrlOf("$('body').load('app://evil/index.html')"), null);
    assert.equal(loaderUrlOf("$('body').load('file:///C:/Windows/System32/calc.exe')"), null);
    assert.equal(loaderUrlOf('<iframe src="javascript:alert(1)"></iframe>'), null);
    assert.equal(loaderUrlOf('<iframe src="/relative/path"></iframe>'), null);
});

test('CT-04：普通 HTML 段不受影响（不被误判为 loader）', () => {
    const segs = segmentMessage('```html\n<div id="app"><style>.a{}</style></div>\n```');
    assert.equal(segs[0].type, 'html');
    assert.equal(segs[0].url, undefined);
});

test('CT-04：promoteHtmlSegments 也能把「无围栏的 loader 文本」升级为 loader 段', () => {
    const up = promoteHtmlSegments([{ type: 'text', content: "<script>$('body').load('https://q.w/e')</script>" }]);
    assert.equal(up[0].type, 'loader');
    assert.equal(up[0].url, 'https://q.w/e');
});

test('CT-04：普通纯文本不得被升级（保持 text 段）', () => {
    const up = promoteHtmlSegments([{ type: 'text', content: '这是一段普通的对话文字，没有任何界面。' }]);
    assert.equal(up[0].type, 'text');
    assert.equal(up[0].url, undefined);
});

test('```html 围栏 → html 段；普通文本 → text 段', () => {
    const segs = segmentMessage('开场文字\n\n```html\n<div id="app"></div>\n<script>1</script>\n```\n\n结尾');
    assert.equal(segs.length, 3);
    assert.equal(segs[0].type, 'text');
    assert.equal(segs[1].type, 'html');
    assert.ok(segs[1].content.includes('<div id="app">'));
    assert.equal(segs[2].type, 'text');
});

test('裸 ``` 围栏里是 HTML 内容 → 同样升级为 html 段（CT-14 提到的卡）', () => {
    const segs = segmentMessage('```\n<head><style>a{}</style></head><body><script>2</script></body>\n```');
    assert.equal(segs.length, 1);
    assert.equal(segs[0].type, 'html');
});

test('裸围栏里是「完整文档」（<!DOCTYPE html> 开头，CRLF 换行）→ html 段且不带围栏（CT-16）', () => {
    // 实测卡「魔法少女是不会败北恶堕的吧！」开场白就是这个形状：
    // ``` + CRLF + <!DOCTYPE html> … </html> + CRLF + ```
    const raw = '```\r\n<!DOCTYPE html>\r\n<html lang="zh-CN">\r\n<head><meta charset="UTF-8"></head>\r\n<body><div id="app"></div></body>\r\n</html>\r\n```';
    const segs = segmentMessage(raw);
    assert.equal(segs.length, 1, '应只产生 1 段');
    assert.equal(segs[0].type, 'html', '完整文档应判为 html 段');
    assert.ok(!segs[0].content.includes('```'), '面板内容不得含围栏标记');
    assert.ok(segs[0].content.startsWith('<!DOCTYPE html>'), '应以 doctype 开头');
});

test('同上但 LF 换行 + 小写 doctype → 同样识别为 html 段', () => {
    const raw = '```\n<!doctype html>\n<html>\n<head><title>t</title></head><body><span>x</span></body>\n</html>\n```';
    const segs = segmentMessage(raw);
    assert.equal(segs[0].type, 'html');
    assert.ok(!segs[0].content.includes('```'));
});

test('裸 ``` 围栏里是普通代码 → 保持文本（不误判成面板）', () => {
    const segs = segmentMessage('```\nconst a = 1;\nconsole.log(a);\n```');
    assert.equal(segs[0].type, 'text');
    assert.ok(segs[0].content.includes('const a = 1;'));
});

test('htmlNeedsIframe 判据（决定要不要走沙箱 iframe）', () => {
    assert.equal(htmlNeedsIframe('<div>x</div><script></script>'), true);
    assert.equal(htmlNeedsIframe('<head><meta charset="utf-8"></head><body></body>'), true);
    assert.equal(htmlNeedsIframe('<div>x</div><style>a{color:red}</style>'), true);
    assert.equal(htmlNeedsIframe('<div>x</div>'), false);
});

test('未闭合围栏 → splitPending 先挂起，不渲染半截面板', () => {
    const [ready, pending] = splitPending('正文\n```html\n<div id="app">');
    assert.equal(ready, '正文\n');
    assert.ok(pending.startsWith('```html'));
    const [r2, p2] = splitPending('正文\n```html\n<div/>\n```');
    assert.equal(p2, '');
    assert.ok(r2.includes('<div/>'));
});

test('promoteHtmlSegments：文本里的完整模板升级为 iframe 段', () => {
    const out = promoteHtmlSegments([{ type: 'text', content: '<html><body><script>3</script></body></html>' }]);
    assert.equal(out[0].type, 'html');
});

test('buildHtmlSrcdoc：准完整文档（无 doctype）补壳后，预置插在 <head> 开头', () => {
    const doc = buildHtmlSrcdoc('<head><script>window.mark=1;</script></head><body>hi</body>', '{"stat_data":{}}', 'seg1_0', '<script src="app://index.html/vendor/chat-host.js"></script>');
    const headAt = doc.indexOf('<head>');
    const vendorAt = doc.indexOf('chat-host.js');
    const tplAt = doc.indexOf('window.mark=1');
    assert.ok(headAt >= 0 && vendorAt > headAt, '预置应在 head 内');
    assert.ok(vendorAt < tplAt, '预置必须早于模板自带脚本');
});

test('buildHtmlSrcdoc：注入 JSR 侧桥接 API 与沙箱兜底', () => {
    const doc = buildHtmlSrcdoc('<body>x</body>', '{"stat_data":{"a":1}}', 'seg2_1', '', { messageId: 7 });
    for (const api of ['getVariables', 'getMessageVar', 'getCurrentMessageId', 'updateVariablesWith', 'replaceVariables', 'errorCatched']) {
        assert.ok(doc.includes(api), `缺桥接 API: ${api}`);
    }
    assert.ok(doc.includes('return 7;'), 'getCurrentMessageId 应返回注入的消息序号');
    assert.ok(doc.includes('localStorage'), '应带 localStorage 内存兜底（沙箱下原生会抛 SecurityError）');
});

test('buildHtmlSrcdoc：变量 JSON 里的 </script 不会破出桥接脚本', () => {
    const doc = buildHtmlSrcdoc('<body>x</body>', '{"stat_data":{"t":"</script><img src=x>"}}', 'seg3_0');
    assert.ok(!doc.includes('</script><img'), '变量内容须转义');
});

test('buildHtmlSrcdoc：4 种文档形状都必须带上 vendor（CT-19 回归锁）', () => {
    // CT-19：`buildHtmlSrcdoc` 分 4 种形状补壳，以前只有前两种拼了 vendorTags，
    // 「仅 <body>」「纯片段/<`</head>`>」两个回退分支把 jQuery/Vue 全局整段丢掉 →
    // 卡内面板顶层 `$`/`Vue` 直接 ReferenceError（测卡区面板空白）。
    // 这张参数化表就是防「修了主路径、漏了回退分支」再次发生。
    const vendor = '<script src="app://index.html/vendor/chat-host.js"></script>';
    const shapes = {
        '完整文档': '<html><head></head><body>x</body></html>',
        '准完整（<head>…<body>）': '<head><script>1</script></head><body>x</body>',
        '仅 <body>（实测 MC_lite 卡形状）': '</head>\n<body>\n<script>$("body").load("u")</script>\n</body>\n',
        '纯片段（<div>）': '<div id="a">hi</div>'
    };
    for (const [name, html] of Object.entries(shapes)) {
        const doc = buildHtmlSrcdoc(html, '{}', 'seg_0', vendor);
        assert.ok(doc.includes('vendor/chat-host.js'), `${name}：缺 vendor 全局库`);
        assert.ok(doc.includes('getVariables'), `${name}：缺桥接 API`);
        // vendor 必须在模板自带脚本之前（模板顶层就引用 $ / Vue）
        if (doc.includes('$("body")')) {
            assert.ok(doc.indexOf('vendor/chat-host.js') < doc.indexOf('$("body")'), `${name}：vendor 应早于模板脚本`);
        }
    }
});

test('buildHtmlSrcdoc：vendor 为空串时不得凭空插入脚本标签', () => {
    const doc = buildHtmlSrcdoc('<div>hi</div>', '{}', 'seg_0', '');
    assert.ok(!doc.includes('chat-host'), '空 vendor 不应产生引用');
    assert.ok(doc.includes('getVariables'), '桥接仍然要在');
});
