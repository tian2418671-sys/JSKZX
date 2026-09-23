/**
 * 测卡消息分段渲染器（对齐「渲染方案.MD」第 3 节 Segmenter + 第 4 节安全 WebView）
 *
 * 方案按原生 Kotlin/Compose 编写（Markwon + WebView 池）。本项目在 Capacitor WebView 内，
 * 等价实现：
 *   - 文本段 → 现有 renderChatHtml（Markdown 子集 + DOMPurify 清洗）
 *   - HTML 段（```html 围栏 / <style>/<script> 完整模板）→ sandbox iframe（srcdoc，
 *     禁同源权限，对齐方案 configureSecure 的安全语义；项目已有 statusSrcdoc 先例）
 *   - 🌐 **外链段（loader）**：`$('body').load('URL')` / `<iframe src="URL">` 直链界面 →
 *     直接 `iframe src=URL`（sandbox，不带 srcdoc）
 *   - 分段优先级：完整 HTML 文档模板 > ```html 围栏 > 普通文本
 *
 * 流式挂起检测（方案第 6 节 splitPending）：未闭合围栏/标签在流式期间不渲染，
 * 避免半截面板闪烁（本端非流式 API，保留该函数供后续接入）。
 *
 * 🔧 CT-04（2026-09-23）：补 **loader 段**。此前只处理 `html` 段（`htmlNeedsIframe`），
 *    卡里用 `$('body').load('URL')` 的界面在**测卡区完全不显示** ——
 *    而卡编辑器预览面板（`useStatusbarPreview.classifyTemplate`）**早就有**该能力，
 *    两边口径不一致。现对齐：分类器口径与 `useStatusbarPreview` 保持一致（宽松匹配）。
 */

/** ```html 围栏（语言标记可省略；大小写不敏感） */
const HTML_FENCE_RE = /```html\s*\n?([\s\S]*?)```/gi;
// 🚀 裸 ``` 围栏(无语言标记):酒馆部分卡的模板(如 JS-Slash-Runner 状态栏)输出
//    "```\n<head><script type=module>..." —— 内容像 HTML 时按面板渲染
const BARE_FENCE_RE = /```\s*\n?([\s\S]*?)```/gi;

/**
 * 🌐 外链界面（loader）URL 提取 —— 与 `useStatusbarPreview.classifyTemplate` 的 loader 分支**同口径**
 *   · `$('body').load('URL')`（宽松：单双引号 / 空格 / 换行 / 不要求 <body> 包裹）
 *   · `<iframe src="URL">` / `<script src="URL">` 直链
 *   ⚠️ 只认 `http(s)://` 绝对地址（防 `app://` 等内部协议被卡内容诱导加载）
 * @param {string} text
 * @returns {string|null} URL 或 null
 */
export function loaderUrlOf(text) {
    const t = String(text || '');
    const load = t.match(/\$\(\s*['"]body['"]\s*\)\s*\.\s*load\s*\(\s*['"]([^'"]+)['"]/i);
    if (load && /^https?:\/\//i.test(load[1].trim())) return load[1].trim();
    const iframe = t.match(/<iframe[^>]+src\s*=\s*['"]([^'"]+)['"][^>]*>/i);
    if (iframe && /^https?:\/\//i.test(iframe[1].trim())) return iframe[1].trim();
    const script = t.match(/<script[^>]+src\s*=\s*['"]([^'"]+)['"][^>]*>/i);
    if (script && /^https?:\/\//i.test(script[1].trim())) return script[1].trim();
    return null;
}

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
    // 标签开头（含 `<!DOCTYPE html>`——实测卡把**完整文档**整段放进裸围栏时就是这种开头；
    // 旧白名单只列了 <html/<head/<div…，漏了 doctype → 被判成普通文本并**把围栏原样带回**，
    // 随后又被 promoteHtmlSegments 升级成 iframe 段 → 面板顶部/底部各露出一行 ``` ）
    return /^<(!doctype\s+html|html|head|body|style|script|div|table|section)[\s>]/i.test(t);
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
        if (html) out.push(loaderUrlOf(html)
            ? { type: 'loader', url: loaderUrlOf(html), content: html }
            : { type: 'html', content: html });
        last = m.index + m[0].length;
    }
    pushTextSegments(out, src.slice(last));
    if (!out.length) out.push({ type: 'text', content: '' });
    return out;
}

/** 文本内容 → 追加 text/html/loader 段（裸围栏内像 HTML 则升级；loader 优先） */
function pushTextSegments(out, raw) {
    if (!raw) return;
    let last = 0;
    BARE_FENCE_RE.lastIndex = 0;
    let m;
    while ((m = BARE_FENCE_RE.exec(raw)) !== null) {
        const before = raw.slice(last, m.index).trim();
        if (before) pushPlain(out, before);
        const inner = (m[1] || '').trim();
        if (inner) {
            const lu = loaderUrlOf(inner);
            if (lu) out.push({ type: 'loader', url: lu, content: inner });
            else out.push(fenceLooksLikeHtml(inner)
                ? { type: 'html', content: inner }
                : { type: 'text', content: '```\n' + inner + '\n```' });
        }
        last = m.index + m[0].length;
    }
    const tail = raw.slice(last).trim();
    if (tail) pushPlain(out, tail);
}

/** 非围栏文本：整体是 loader 则出 loader 段，否则出文本段 */
function pushPlain(out, text) {
    if (!text) return;
    const lu = loaderUrlOf(text);
    if (lu) { out.push({ type: 'loader', url: lu, content: text }); return; }
    out.push({ type: 'text', content: text });
}

/**
 * HTML 段 → iframe srcdoc 完整文档（对齐方案 ensureDocument：片段包壳，完整文档直用）
 * 注入第三方库（Vue/jQuery/lodash，见 useChatVendor）+ 变量桥（getVariables/getMessageVar）
 * + 高度上报桥（postMessage，sandbox 无同源权限时的量高回写等价实现，方案第 4 节 onPageFinished 量高）
 *
 * ⚠️ 注入位置必须在 `<head>` **开头**：卡内状态栏是 webpack SPA，其 bundle 是模块脚本，
 *    模块脚本默认 defer（解析完才执行），但同一份文档里若有**普通**内联脚本，就会抢在预置库前跑。
 * @param {string} html 面板 HTML（片段或完整文档）
 * @param {string} varsJson 变量树 JSON 字符串（注入 getVariables；须为 JSON 文本）
 * @param {string} panelId 面板唯一 id（高度上报配对用）
 * @param {string} [vendorTagsRaw] 第三方库 `<script src>` 片段（空串则不加）
 * @param {object} [opts] 附加参数：`{ messageId }` → getCurrentMessageId() 返回值
 */
export function buildHtmlSrcdoc(html, varsJson, panelId, vendorTagsRaw, opts) {
    const body = String(html || '');
    // 🔧 修复双重序列化:varsJson 已是 JSON 文本,直接内联为 JS 表达式(getVariables 必须返回对象)。
    //   另防变量/面板内容里的 </script 破出桥接脚本标签。
    const varsLiteral = String(varsJson || '{"stat_data":{}}')
        .replace(/<\/(script)/gi, '<\\/$1');
    const pid = String(panelId || '');
    const msgId = Number(opts && opts.messageId) || 0;
    // 🚀 高度上报增强:load 多次重测 + MutationObserver 持续监听(SPA 模板 mount 后高度才稳定)
    const bridge = '<script>window.getVariables=function(){try{return ' + varsLiteral +
        ';}catch(e){return {stat_data:{}};}};' +
        'window.getMessageVar=function(p){var v=window.getVariables();var c=v;' +
        'try{p.split(".").forEach(function(s){c=(c==null)?undefined:c[s];});}catch(e){c=undefined;}' +
        'return c;};' +
        // 🧩 酒馆助手 iframe API（对齐本地预览 preview-frame.html 的 mock 集合）：
        //    · getCurrentMessageId —— 状态栏用来分辨自己属于哪一层消息
        //    · updateVariablesWith —— 模板改完变量后由它接管；沙箱里没有酒馆变量后端，
        //      仅在 iframe 本地快照上生效（与预览帧一致：不写回宿主，避免表单/数据源脱钩）
        'window.getCurrentMessageId=function(){return ' + msgId + ';};' +
        'window.errorCatched=function(f){return f;};' +
        'window.updateVariablesWith=function(fn,opt){try{var v=window.getVariables(opt);' +
        'if(typeof fn==="function")fn(v);return v;}catch(e){' +
        'try{console.warn("[chat-seg] updateVariablesWith 失败:",e&&e.message);}catch(_){}}' +
        'return window.getVariables(opt);};' +
        'window.replaceVariables=function(vars){try{var cur=window.getVariables();' +
        'Object.keys(cur).forEach(function(k){delete cur[k];});Object.assign(cur,vars||{});}catch(e){}' +
        'return Promise.resolve();};' +
        // 🧩 sandbox 无同源权限时访问 localStorage/sessionStorage 会抛 SecurityError（卡内状态栏
        //    模板常拿它存状态），给一层内存实现兜底 —— 保住 sandbox 不放 allow-same-origin
        'function __mkStore(){var m={};return{getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null;},' +
        'setItem:function(k,v){m[String(k)]=String(v);},removeItem:function(k){delete m[String(k)];},' +
        'clear:function(){m={};},key:function(i){return Object.keys(m)[i]||null;},get length(){return Object.keys(m).length;}};}' +
        'function __fixStore(n){try{window[n].getItem("__probe");}catch(e){try{Object.defineProperty(window,n,{configurable:true,value:__mkStore()});}catch(e2){}}}' +
        'try{__fixStore("localStorage");__fixStore("sessionStorage");}catch(e){}' +
        'function __rh(){try{var h=Math.max(document.body?document.body.scrollHeight:0,' +
        'document.documentElement?document.documentElement.scrollHeight:0);' +
        'if(h>0)parent.postMessage({type:"jsx-panel-height",id:' + JSON.stringify(pid) + ',h:h},"*");}catch(e){}}' +
        'window.addEventListener("load",function(){__rh();setTimeout(__rh,200);setTimeout(__rh,800);setTimeout(__rh,2000);});' +
        'setTimeout(__rh,100);setTimeout(__rh,600);' +
        // 🪟 窗口回前台时父层会 ping 一下重新量高：后台标签/窗口的定时器会被节流，
        //    光靠上面的几次定时可能一直量不到，面板就会停在默认 60px
        'window.addEventListener("message",function(e){var d=e&&e.data;if(d&&d.type==="jsx-panel-height-request"){__rh();}});' +
        'if(window.MutationObserver){new MutationObserver(function(){__rh();}).observe(' +
        'document.documentElement||document.body,{childList:true,subtree:true,attributes:true});}' +
        '<\/script>';
    const prelude = bridge;
    const vendorTags = String(vendorTagsRaw || '');
    // 完整文档/准完整文档(head/body 片段,如 JS-Slash-Runner 状态栏的 webpack SPA 模板) → 原位注入桥
    if (/<html[\s>]/i.test(body)) {
        if (/<\/head>/i.test(body)) return injectIntoHead(body, vendorTags + prelude);
        if (/<body[^>]*>/i.test(body)) return body.replace(/<body[^>]*>/i, (mm) => mm + vendorTags + prelude);
        return vendorTags + prelude + body;
    }
    if (/<head[\s>]/i.test(body) || /<body[\s>]/i.test(body)) {
        // 🚀 准完整文档:补 <html> 包裹,head/body 各归其位(不能整段塞进 body——head 失效/body 嵌套)
        let doc = '<!DOCTYPE html><html>';
        if (/<head[\s>]/i.test(body)) {
            const hi = body.search(/<head[\s>]/i);
            const he = body.search(/<\/head>/i);
            const pre = body.slice(0, hi);
            doc += '<head>' + body.slice(hi + body.slice(hi).match(/<head[^>]*>/i)[0].length, he >= 0 ? he : body.length);
            doc += '</head>';
            const rest = he >= 0 ? body.slice(he + 7) : '';
            if (/<body[\s>]/i.test(rest)) {
                doc += rest.replace(/<body[^>]*>/i, (mm) => mm + '');
            } else {
                doc += '<body>' + rest + '</body>';
            }
            doc += '</html>';
            if (pre.trim()) doc = pre + doc;
            // 模板自带 <head>：预置插到 head 开头（charset 已在模板或下面的合成分支里）
            return injectIntoHead(doc, (vendorTags || '') + prelude);
        }
        // ⚠️ CT-19：这两个回退分支以前只拼 META_TAGS + prelude，
        //    把 vendorTags（jQuery/Vue/lodash/zod 全局）整段丢了 ——
        //    卡内状态栏模板顶层直接引用 `$`/`Vue` → ReferenceError → 面板空白。
        //    多分支生成同一类文档时，「公共注入」必须每个分支都带上（已用参数化单测锁住 4 种形状）。
        return injectIntoHead('<!DOCTYPE html><html><head></head>' + body + '</html>', META_TAGS + vendorTags + prelude);
    }
    return injectIntoHead('<!DOCTYPE html><html><head></head><body>' + body + '</body></html>', META_TAGS + vendorTags + prelude);
}

// 合成文档的基础 meta（放在预置前，保证 charset 声明仍在文档最前）
const META_TAGS = '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>html,body{margin:0;padding:0;background:transparent;}</style>';

/** 把预置内容插到 `<head>` 开头（无 head 则先补一个）；保证早于模板自带脚本执行 */
function injectIntoHead(doc, snippet) {
    if (!snippet) return doc;
    const head = doc.match(/<head[^>]*>/i);
    if (head) {
        const at = head.index + head[0].length;
        return doc.slice(0, at) + snippet + doc.slice(at);
    }
    const html = doc.match(/<html[^>]*>/i);
    if (html) {
        const at = html.index + html[0].length;
        return doc.slice(0, at) + '<head>' + snippet + '</head>' + doc.slice(at);
    }
    return snippet + doc;
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
        if (!seg) return seg;
        // 🌐 CT-04：文本段里藏着外链界面（正则替换产出的 loader，无围栏）→ 升级为 loader 段
        if (seg.type === 'text') {
            const lu = loaderUrlOf(seg.content);
            if (lu) return { type: 'loader', url: lu, content: seg.content };
            if (htmlNeedsIframe(seg.content)) return { type: 'html', content: seg.content };
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
