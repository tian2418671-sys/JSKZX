/**
 * 测卡消息分段渲染器（对齐「渲染方案.MD」第 3 节 Segmenter + 第 4 节安全 WebView）
 *
 * 方案按原生 Kotlin/Compose 编写（Markwon + WebView 池）。本项目在 Capacitor WebView 内，
 * 等价实现：
 *   - 文本段 → 现有 renderChatHtml（Markdown 子集 + DOMPurify 清洗）
 *   - HTML 段（```html 围栏 / <style>/<script> 完整模板）→ sandbox iframe（srcdoc，
 *     禁同源权限，对齐方案 configureSecure 的安全语义；项目已有 statusSrcdoc 先例）
 *   - 分段优先级：完整 HTML 文档模板 > ```html 围栏 > 普通文本
 *
 * 流式挂起检测（方案第 6 节 splitPending）：未闭合围栏/标签在流式期间不渲染，
 * 避免半截面板闪烁（本端非流式 API，保留该函数供后续接入）。
 */

/** ```html 围栏（语言标记可省略；大小写不敏感） */
const HTML_FENCE_RE = /```html\s*\n?([\s\S]*?)```/gi;
// 🚀 裸 ``` 围栏(无语言标记):酒馆部分卡的模板(如 JS-Slash-Runner 状态栏)输出
//    "```\n<head><script type=module>..." —— 内容像 HTML 时按面板渲染
const BARE_FENCE_RE = /```\s*\n?([\s\S]*?)```/gi;

/** 段类型：text=文本段 html=面板段 */

/**
 * 判断 HTML 段是否需要 iframe（含 <style>/<script> 的完整模板 → CSS/JS 全量生效）
 * 与 CardDetailView.statusNeedsIframe 同语义
 */
export function htmlNeedsIframe(html) {
    const t = String(html || '');
    return /<style[\s>]/i.test(t) || /<script[\s>]/i.test(t) || /<html[\s>]/i.test(t) || /^\s*<head[\s>]/i.test(t);
}

/** 围栏内容是否像 HTML 面板(裸围栏升级为 html 段的判定) */
function fenceLooksLikeHtml(content) {
    const t = String(content || '').trim();
    return /^<(html|head|body|style|script|div|table|section)[\s>]/i.test(t);
}

/**
 * 消息文本 → 分段数组 [{type:'text'|'html', content}]
 * 规则(两遍):
 *   ① ```html 围栏 → html 段(显式面板)
 *   ② 剩余文本里的裸 ``` 围栏:内容像 HTML(以 <head>/<style>/<script>/<div>… 开头) → html 段;
 *     否则保留围栏留在 text 段(由 Markdown 引擎按代码块渲染)
 * 空段自动剔除；全空返回单空文本段（模板渲染兜底）
 */
export function segmentMessage(text) {
    const src = String(text == null ? '' : text);
    if (!src.trim()) return [{ type: 'text', content: '' }];
    const out = [];
    let last = 0;
    HTML_FENCE_RE.lastIndex = 0;
    let m;
    while ((m = HTML_FENCE_RE.exec(src)) !== null) {
        const before = src.slice(last, m.index);
        pushTextSegments(out, before);
        const html = (m[1] || '').trim();
        if (html) out.push({ type: 'html', content: html });
        last = m.index + m[0].length;
    }
    pushTextSegments(out, src.slice(last));
    if (!out.length) out.push({ type: 'text', content: '' });
    return out;
}

/** 文本内容 → 追加 text/html 段(裸围栏内像 HTML 则升级为 html 段) */
function pushTextSegments(out, raw) {
    if (!raw) return;
    let last = 0;
    BARE_FENCE_RE.lastIndex = 0;
    let m;
    while ((m = BARE_FENCE_RE.exec(raw)) !== null) {
        const before = raw.slice(last, m.index).trim();
        if (before) out.push({ type: 'text', content: before });
        const inner = (m[1] || '').trim();
        if (inner) {
            out.push(fenceLooksLikeHtml(inner)
                ? { type: 'html', content: inner }
                : { type: 'text', content: '```\n' + inner + '\n```' });
        }
        last = m.index + m[0].length;
    }
    const tail = raw.slice(last).trim();
    if (tail) out.push({ type: 'text', content: tail });
}

/**
 * HTML 段 → iframe srcdoc 完整文档（对齐方案 ensureDocument：片段包壳，完整文档直用）
 * 注入变量桥（getVariables/getMessageVar）+ 高度上报桥（postMessage，
 * sandbox 无同源权限时的量高回写等价实现，方案第 4 节 onPageFinished 量高）
 * @param {string} html 面板 HTML（片段或完整文档）
 * @param {string} varsJson 变量树 JSON 字符串（注入 getVariables；须为 JSON 文本）
 * @param {string} panelId 面板唯一 id（高度上报配对用）
 */
export function buildHtmlSrcdoc(html, varsJson, panelId) {
    const body = String(html || '');
    // 🔧 修复双重序列化:varsJson 已是 JSON 文本,直接内联为 JS 表达式(getVariables 必须返回对象)。
    //   另防变量/面板内容里的 </script 破出桥接脚本标签。
    const varsLiteral = String(varsJson || '{"stat_data":{}}')
        .replace(/<\/(script)/gi, '<\\/$1');
    const pid = String(panelId || '');
    // 🚀 高度上报增强:load 多次重测 + MutationObserver 持续监听(SPA 模板 mount 后高度才稳定)
    const bridge = '<script>window.getVariables=function(){try{return ' + varsLiteral +
        ';}catch(e){return {stat_data:{}};}};' +
        'window.getMessageVar=function(p){var v=window.getVariables();var c=v;' +
        'try{p.split(".").forEach(function(s){c=(c==null)?undefined:c[s];});}catch(e){c=undefined;}' +
        'return c;};' +
        'function __rh(){try{var h=Math.max(document.body?document.body.scrollHeight:0,' +
        'document.documentElement?document.documentElement.scrollHeight:0);' +
        'if(h>0)parent.postMessage({type:"jsx-panel-height",id:' + JSON.stringify(pid) + ',h:h},"*");}catch(e){}}' +
        'window.addEventListener("load",function(){__rh();setTimeout(__rh,200);setTimeout(__rh,800);setTimeout(__rh,2000);});' +
        'setTimeout(__rh,100);setTimeout(__rh,600);' +
        'if(window.MutationObserver){new MutationObserver(function(){__rh();}).observe(' +
        'document.documentElement||document.body,{childList:true,subtree:true,attributes:true});}' +
        '<\/script>';
    // 完整文档/准完整文档(head/body 片段,如 JS-Slash-Runner 状态栏的 webpack SPA 模板) → 原位注入桥
    if (/<html[\s>]/i.test(body)) {
        if (/<\/head>/i.test(body)) return body.replace(/<\/head>/i, bridge + '</head>');
        if (/<body[^>]*>/i.test(body)) return body.replace(/<body[^>]*>/i, (mm) => mm + bridge);
        return bridge + body;
    }
    if (/<head[\s>]/i.test(body) || /<body[\s>]/i.test(body)) {
        // 🚀 准完整文档:补 <html> 包裹,head/body 各归其位(不能整段塞进 body——head 失效/body 嵌套)
        let doc = '<!DOCTYPE html><html>';
        if (/<head[\s>]/i.test(body)) {
            const hi = body.search(/<head[\s>]/i);
            const he = body.search(/<\/head>/i);
            const pre = body.slice(0, hi);
            doc += '<head>' + body.slice(hi + body.slice(hi).match(/<head[^>]*>/i)[0].length, he >= 0 ? he : body.length);
            doc += bridge + '</head>';
            const rest = he >= 0 ? body.slice(he + 7) : '';
            if (/<body[\s>]/i.test(rest)) {
                doc += rest.replace(/<body[^>]*>/i, (mm) => mm + '');
            } else {
                doc += '<body>' + rest + '</body>';
            }
            doc += '</html>';
            if (pre.trim()) doc = pre + doc;
            return doc;
        }
        return '<!DOCTYPE html><html><head><meta charset="utf-8">' + bridge + '</head>' + body + '</html>';
    }
    return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<style>html,body{margin:0;padding:0;background:transparent;}</style>' +
        bridge + '</head><body>' + body + '</body></html>';
}

/**
 * 🚀 分段升级（对齐酒馆 messageFormatting:正则输出的完整 HTML 模板无 ```html 围栏,直接渲染）
 * text 段内容若为完整 HTML 模板(含 <style>/<script>/<html> 结构) → 升级为 html 段走 sandbox iframe,
 * 否则落入 sanitizeStatusHtml 白名单时 <style>/<script> 会被剥除,面板全部失效。
 * @param {Array} segments segmentMessage 的输出
 * @returns {Array} 升级后的分段
 */
export function promoteHtmlSegments(segments) {
    return (segments || []).map((seg) => {
        if (seg && seg.type === 'text' && htmlNeedsIframe(seg.content)) {
            return { type: 'html', content: seg.content };
        }
        return seg;
    });
}

/**
 * 流式挂起检测（方案第 6 节 splitPending）：
 * 返回 [可渲染部分, 挂起部分]——未闭合 ```html 围栏进入挂起，等写完再渲染
 */
export function splitPending(buffer) {
    const src = String(buffer == null ? '' : buffer);
    const openFence = src.toLowerCase().lastIndexOf('```html');
    if (openFence === -1) return [src, ''];
    const after = src.slice(openFence + 7);
    if (/```/.test(after)) return [src, '']; // 已闭合
    return [src.slice(0, openFence), src.slice(openFence)];
}
