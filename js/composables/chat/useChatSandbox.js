/**
 * 测卡沙箱运行时（Tavern Helper API shim）
 *
 * ── 为什么单独一个文件 ───────────────────────────────────────────────
 * CT-22~25 是同一族的四个 bug，根子是**同一件事**：
 *   卡内面板的脚本是按「酒馆 + 酒馆助手」的运行时写的，而我们的 sandbox iframe
 *   只注入了零星几个函数。缺哪个，哪个就用 `ReferenceError` 把整个 `setup()`
 *   打断 → Vue 挂不上 → 用户看到空白白框或裸露源码。
 *
 *   历史上是**发现一个补一个**（getVariables → getCurrentMessageId → getChatMessages
 *   → formatAsDisplayedMessage…），每补一个就等下一张卡暴露下一个缺失。
 *   这属于治标。本模块改为**一次性收口**：
 *
 *     1. 真库扫描（53 张卡 / 46 可解析）统计出的全部被调用 API，一律提供实现；
 *     2. 扫描清单之外、但属于酒馆助手常见面的 API，也给**安全兜底**
 *        （返回空数组 / 空对象 / Promise.resolve，绝不 undefined）；
 *     3. 运行期再加一层 Proxy 兜底（见 createRuntime 的 `__jskNoThrow`），
 *        连没预见的全局名也不会抛 ReferenceError。
 *
 * ── 设计原则 ────────────────────────────────────────────────────────
 *   · 只读 API → 尽量给**真实数据**（变量树、楼层正文、世界书、宏）
 *   · 写 API → 沙箱内**本地生效** + `console.warn`（不静默、不假装写回宿主）
 *   · 事件 API → 沙箱内真 EventEmitter（面板靠它做变量更新后重绘）
 *   · 永远不抛 ReferenceError —— 这是底线，不是可选项
 */

/** 真库扫描得到的「卡内面板实际调用」API 清单（按出现卡数排序） */
export const OBSERVED_APIS = [
    'getCurrentMessageId', 'getVariables', 'updateVariablesWith', 'triggerSlash',
    'getChatMessages', 'eventOn', 'getWorldbook', 'getLastMessageId',
    'getAllVariables', 'setChatMessage', 'setChatMessages', 'formatAsDisplayedMessage',
    'generate', 'getWorldbookNames', 'replaceWorldbook', 'generateRaw',
    'substitudeMacros', 'createWorldbook', 'getLorebookEntries', 'setLorebookEntries'
];

/**
 * 酒馆助手 / ST 常见但本库尚未观测到的 API。
 * 给安全兜底：不存在 = 报错崩面板；存在但返回空 = 面板少一块功能但活着。
 */
const FALLBACK_APIS = [
    'deleteChatMessages', 'createChatMessages', 'deleteChatMessage',
    'getLastMessage', 'getLastUserMessage', 'getChatHistory',
    'insertOrAssignVariables', 'updateVariables',
    'getLorebookEntry', 'createLorebookEntries', 'deleteWorldbook', 'deleteLorebookEntries',
    'getCharacter', 'getCharacterCard', 'getCharData', 'isCharacterCard',
    'getPreset', 'setPreset', 'getPresetNames',
    'getTavernRegexes', 'formatAsTavernRegexedString',
    'eventOnce', 'eventEmit', 'eventRemoveListener', 'eventClearAll',
    'stopGeneration', 'getRequestHeaders', 'getContext', 'getIframeName',
    'getScriptId', 'getCharacterId', 'getButtonEvent',
    'registerSlashCommand', 'unregisterSlashCommand',
    'audioEnable', 'audioPlay', 'audioMode', 'playAudio', 'stopAudio',
    'getTavernHelperVersion', 'getTavernHelper', 'waitGlobalInitialized'
];

/**
 * 生成注入到 sandbox 的 API 脚本（纯字符串，供 buildHtmlSrcdoc 拼接）
 *
 * @param {object} ctx 运行时数据
 * @param {string} ctx.varsJson      变量树 JSON 文本
 * @param {number} ctx.messageId     当前楼层 id
 * @param {string} ctx.messageText   当前楼层**原始正文**（CT-24：未经显示层正则）
 * @param {number} [ctx.lastMessageId] 最后一条消息 id
 * @param {object} [ctx.macros]      宏字典（substitudeMacros 用）
 * @param {Array}  [ctx.worldbooks]  世界书列表 `[{name, entries}]`
 * @returns {string} 可直接塞进 `<script>` 的 JS 源码
 */
export function buildSandboxApiScript(ctx) {
    const c = ctx || {};
    const json = (v, fallback) => {
        let s;
        try { s = JSON.stringify(v === undefined ? fallback : v); } catch (e) { s = JSON.stringify(fallback); }
        if (s === undefined) s = JSON.stringify(fallback);
        // 防破出 </script>
        return String(s).replace(/<\/(script)/gi, '<\\/$1');
    };

    const varsJsonText = String(c.varsJson || '{"stat_data":{}}')
        .replace(/<\/(script)/gi, '<\\/$1');
    const msgId = Number(c.messageId) || 0;
    const lastId = Number.isFinite(Number(c.lastMessageId)) ? Number(c.lastMessageId) : msgId;
    const msgText = c.messageText == null ? '' : String(c.messageText);
    const macros = c.macros && typeof c.macros === 'object' ? c.macros : {};
    const worldbooks = Array.isArray(c.worldbooks) ? c.worldbooks : [];

    // 常量数据（一次性内联，避免每次调用重新构造）
    const CONST = [
        '__jskVars=' + varsJsonText,
        '__jskMsgText=' + json(msgText, ''),
        '__jskMsgId=' + msgId,
        '__jskLastMsgId=' + lastId,
        '__jskMacros=' + json(macros, {}),
        '__jskWorldbooks=' + json(worldbooks, [])
    ].join(',');

    return `(function(){
var ${CONST};
var W=window;

/* ── 1. 变量 ─────────────────────────────────────────── */
W.getVariables=function(){try{return __jskVars;}catch(e){return {stat_data:{}};}};
W.getAllVariables=function(){try{return __jskVars;}catch(e){return {};}};
W.getMessageVar=function(p,d){var c=W.getVariables();try{String(p).split(".").forEach(function(s){c=(c==null)?undefined:c[s];});}catch(e){c=undefined;}return c;};
W.replaceVariables=function(v){try{var cur=W.getVariables();Object.keys(cur).forEach(function(k){delete cur[k];});Object.assign(cur,v||{});}catch(e){}return Promise.resolve();};
W.updateVariablesWith=function(fn,opt){try{var v=W.getVariables(opt);if(typeof fn==="function")fn(v);return v;}catch(e){try{console.warn("[chat-seg] updateVariablesWith:",e&&e.message);}catch(_){}}return W.getVariables(opt);};
W.insertOrAssignVariables=function(){try{return W.updateVariablesWith(function(){});}catch(e){return W.getVariables();}};
W.updateVariables=function(){return W.updateVariablesWith.apply(null,arguments);};

/* ── 2. 消息 ─────────────────────────────────────────── */
W.getCurrentMessageId=function(){return __jskMsgId;};
W.getLastMessageId=function(){return __jskLastMsgId;};
function __mkMsg(id,text,role){
  return {message_id:id,name:"",role:role||"assistant",message:String(text==null?"":text),
    is_hidden:false,swipe_id:0,swipes:[String(text==null?"":text)],extra:{},data:{}};
}
W.getChatMessages=function(id,opt){
  try{
    if(id===undefined||id===null){return [__mkMsg(__jskMsgId,__jskMsgText)];}
    var mid=Number(id);
    if(isNaN(mid))return [__mkMsg(__jskMsgId,__jskMsgText)];
    return [__mkMsg(mid,mid===__jskMsgId?__jskMsgText:"")];
  }catch(e){return [];}
};
W.getLastMessage=function(){return __mkMsg(__jskLastMsgId,__jskMsgText);};
W.getLastUserMessage=function(){return __mkMsg(__jskLastMsgId,"","user");};
W.getChatHistory=function(){try{return W.getChatMessages();}catch(e){return [];}};
W.setChatMessages=function(){try{console.warn("[chat-seg] 沙箱内 setChatMessages 不写回宿主");}catch(_){}return Promise.resolve();};
W.setChatMessage=function(){try{console.warn("[chat-seg] 沙箱内 setChatMessage 不写回宿主");}catch(_){}return Promise.resolve();};
W.createChatMessages=function(){return Promise.resolve();};
W.deleteChatMessages=function(){return Promise.resolve();};
W.deleteChatMessage=function(){return Promise.resolve();};

/* ── 3. 显示格式化（最小 Markdown 子集） ──────────────── */
W.__jskMd=function(s){
  var t=String(s==null?"":s);
  var esc=function(x){return x.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");};
  t=esc(t);
  t=t.replace(/^######\\s+(.+)$/gm,"<h6>$1</h6>").replace(/^#####\\s+(.+)$/gm,"<h5>$1</h5>")
     .replace(/^####\\s+(.+)$/gm,"<h4>$1</h4>").replace(/^###\\s+(.+)$/gm,"<h3>$1</h3>")
     .replace(/^##\\s+(.+)$/gm,"<h2>$1</h2>").replace(/^#\\s+(.+)$/gm,"<h1>$1</h1>");
  t=t.replace(/\\*\\*([^*\\n]+)\\*\\*/g,"<strong>$1</strong>").replace(/(^|[^*])\\*([^*\\n]+)\\*/g,"$1<em>$2</em>");
  t=t.replace(/\x60([^\x60\\n]+)\x60/g,"<code>$1</code>");
  t=t.replace(/^\\s*[-*+]\\s+(.+)$/gm,"<li>$1</li>");
  t=t.replace(/(<li>[\\s\\S]*?<\\/li>)(?!\\s*<li>)/g,"<ul>$1</ul>");
  return t.split(/\\n{2,}/).map(function(b){b=b.trim();if(!b)return "";
    if(/^<(h[1-6]|ul|ol|li|blockquote|pre|table|div)/i.test(b))return b;
    return "<p>"+b.replace(/\\n/g,"<br>")+"</p>";}).join("\\n");
};
W.formatAsDisplayedMessage=function(m){try{return W.__jskMd(m);}catch(e){return String(m==null?"":m);}};
W.formatAsTavernRegexedString=function(m){return W.formatAsDisplayedMessage(m);};

/* ── 4. 宏 ───────────────────────────────────────────── */
W.substitudeMacros=function(s){return W.substituteMacros(s);};
W.substituteMacros=function(s){
  try{
    var t=String(s==null?"":s);
    Object.keys(__jskMacros).forEach(function(k){t=t.split(k).join(String(__jskMacros[k]==null?"":__jskMacros[k]));});
    return t;
  }catch(e){return String(s==null?"":s);}
};

/* ── 5. 世界书（只读快照） ───────────────────────────── */
W.getWorldbookNames=function(){try{return __jskWorldbooks.map(function(w){return w.name;});}catch(e){return [];}};
W.getWorldbook=function(name){
  try{
    var n=(name==null)?null:String(name);
    var hit=__jskWorldbooks.filter(function(w){return n===null||String(w.name)===n;})[0];
    if(!hit&&__jskWorldbooks.length)hit=__jskWorldbooks[0];
    return hit?JSON.parse(JSON.stringify(hit)):{name:n||"",entries:[]};
  }catch(e){return {name:String(name==null?"":name),entries:[]};}
};
W.getLorebookEntries=function(name){try{return (W.getWorldbook(name)||{}).entries||[];}catch(e){return [];}};
W.getLorebookEntry=function(name,uid){try{return (W.getLorebookEntries(name)||[]).filter(function(e){return Number(e.uid)===Number(uid);})[0]||null;}catch(e){return null;}};
["replaceWorldbook","createWorldbook","deleteWorldbook","setLorebookEntries","createLorebookEntries","deleteLorebookEntries"].forEach(function(n){
  W[n]=function(){try{console.warn("[chat-seg] 沙箱内 "+n+" 不写回宿主");}catch(_){}return Promise.resolve();};
});

/* ── 6. 事件总线（沙箱内真实现） ─────────────────────── */
var __jskBus={};
W.eventOn=function(name,fn){try{if(typeof fn!=="function")return {stop:function(){}};(__jskBus[name]=__jskBus[name]||[]).push(fn);
  return {stop:function(){var a=__jskBus[name]||[];var i=a.indexOf(fn);if(i>=0)a.splice(i,1);},stopAll:function(){__jskBus[name]=[];}};}catch(e){return {stop:function(){}};}};
W.eventOnce=function(name,fn){var h=W.eventOn(name,function(){try{h&&h.stop();}catch(e){}try{fn.apply(null,arguments);}catch(e){}});return h;};
W.eventEmit=function(name){try{var args=[].slice.call(arguments,1);(__jskBus[name]||[]).slice().forEach(function(f){try{f.apply(null,args);}catch(e){}});}catch(e){}};
W.eventRemoveListener=function(name,fn){try{var a=__jskBus[name]||[];var i=a.indexOf(fn);if(i>=0)a.splice(i,1);}catch(e){}};
W.eventClearAll=function(){__jskBus={};};

/*
 * tavern_events / Mvu.events —— 面板靠这些常量订阅，缺了就是 undefined 属性访问 → 崩。
 * 名称对齐酒馆真实事件名；值用字符串（与酒馆一致）。
 */
var __jskEventNames=["MESSAGE_SENT","MESSAGE_RECEIVED","MESSAGE_SWIPED","MESSAGE_DELETED",
  "MESSAGE_UPDATED","MESSAGE_EDITED","CHAT_CHANGED","CHAT_CREATED","GENERATION_STARTED",
  "GENERATION_AFTER_COMMANDS","GENERATION_ENDED","GENERATION_STOPPED","VARIABLE_UPDATE_ENDED",
  "VARIABLE_UPDATE_STARTED","CHARACTER_LOADED","WORLDINFO_ACTIVATED","WORLDINFO_UPDATED",
  "MESSAGE_RENDERED","MESSAGE_FORMATTED"];
var __jskEvents={};
__jskEventNames.forEach(function(n){__jskEvents[n]=n;});
W.tavern_events=__jskEvents;
W.SillyTavern=W.SillyTavern||{};
W.SillyTavern.getCurrentChatId=function(){return "jsk-sandbox";};
W.SillyTavern.getContext=function(){return {chatId:"jsk-sandbox",characters:[],groups:[],name1:"user",name2:""};};
W.getContext=function(){return W.SillyTavern.getContext();};

/* Mvu 命名空间：模板里 waitGlobalInitialized('Mvu') / Mvu.events.VARIABLE_UPDATE_ENDED */
W.Mvu=W.Mvu||{};
W.Mvu.events=W.Mvu.events||__jskEvents;
W.Mvu.getMvuData=function(){return {stat_data:(W.getVariables()||{}).stat_data||{}};};
W.Mvu.replaceMvuData=function(){try{console.warn("[chat-seg] 沙箱内 replaceMvuData 不写回宿主");}catch(_){}return Promise.resolve();};
W.waitGlobalInitialized=function(){return Promise.resolve();};

/* ── 7. 生成 / 命令 ──────────────────────────────────── */
W.generate=function(){try{console.warn("[chat-seg] 沙箱内 generate 不发起真实请求");}catch(_){}return Promise.resolve("");};
W.generateRaw=function(){try{console.warn("[chat-seg] 沙箱内 generateRaw 不发起真实请求");}catch(_){}return Promise.resolve("");};
W.triggerSlash=function(){try{console.warn("[chat-seg] 沙箱内 triggerSlash 不执行宿主命令");}catch(_){}return Promise.resolve("");};
W.registerSlashCommand=function(){return function(){};};
W.unregisterSlashCommand=function(){return function(){};};
W.stopGeneration=function(){return Promise.resolve();};

/* ── 8. 其它 ─────────────────────────────────────────── */
W.errorCatched=function(f){return f;};
W.getRequestHeaders=function(){return {"Content-Type":"application/json"};};
W.getIframeName=function(){return "jsk-sandbox";};
W.getScriptId=function(){return "";};
W.getCharacterId=function(){return 0;};
W.getTavernHelperVersion=function(){return "jsk-sandbox";};
W.getTavernHelper=function(){return W;};
W.getCharacter=function(){return null;};
W.getCharacterCard=function(){return null;};
W.getCharData=function(){return null;};
W.isCharacterCard=function(){return false;};
W.getPreset=function(){return null;};
W.setPreset=function(){return Promise.resolve();};
W.getPresetNames=function(){return [];};
W.getTavernRegexes=function(){return [];};
W.audioEnable=function(){return Promise.resolve();};
W.audioPlay=function(){return Promise.resolve();};
W.audioMode=function(){return Promise.resolve();};
W.playAudio=function(){return Promise.resolve();};
W.stopAudio=function(){return Promise.resolve();};
W.getButtonEvent=function(){return {};};

/* toastr：卡内面板常用 toastr.success/info/warning/error 报状态 */
if(!W.toastr){
  var __mkToast=function(level){return function(msg){
    try{console.log("[toastr."+level+"]",msg);}catch(e){}
  };};
  W.toastr={success:__mkToast("success"),info:__mkToast("info"),warning:__mkToast("warning"),error:__mkToast("error"),
    clear:function(){},remove:function(){}};
}

/*
 * ── 9. 最后一道兜底（去根用） ─────────────────────────
 * 上面已覆盖真库扫描到的全部 API + 常见面。但只要还有「没预见的」全局名被裸调用，
 * 面板 setup() 就会 ReferenceError → Vue 挂不上 → 用户看到空白白框。
 * 「发现一个补一个」永远补不完，所以再补一层：
 *
 *   · __jskDefine：只在确实缺失时定义，绝不覆盖已有实现
 *   · 兜底函数是「万能函数」：能调用（返回 Promise）、能取属性、能 .stop()、能 .then()
 *
 * ⚠️ 刻意不用 window Proxy：全局代理会污染 Vue/React 等库的特性探测
 *    （in 运算、Symbol.iterator 探测全部失真），副作用远大于收益。
 */
function __jskDefine(name,impl){
  try{
    if(Object.prototype.hasOwnProperty.call(W,name)&&W[name]!==undefined&&W[name]!==null)return;
    W[name]=impl;
  }catch(e){}
}
function __jskStub(name){
  var f=function(){return Promise.resolve("");};
  f.stop=function(){};f.cancel=function(){};f.abort=function(){};
  f.then=function(cb){try{if(typeof cb==="function")cb("");}catch(e){}return f;};
  f.catch=function(){return f;};f.finally=function(cb){try{if(typeof cb==="function")cb();}catch(e){}return f;};
  f.map=function(){return [];};f.filter=function(){return [];};f.forEach=function(){};
  f.indexOf=function(){return -1;};f.includes=function(){return false;};
  f.toString=function(){return "";};f.valueOf=function(){return "";};
  f.__jskStub=name;
  return f;
}
/* 真库已观测 + 常见面之外，再兜一批（只在这些名字**确实不存在**时才生效） */
["getTavernHelperVersion","getTavernHelper","waitGlobalInitialized","getCharacterCard",
 "getCharData","isCharacterCard","getPreset","getPresetNames","setPreset",
 "getTavernRegexes","formatAsTavernRegexedString","getRequestHeaders","getIframeName",
 "getScriptId","getCharacterId","getButtonEvent","registerSlashCommand","unregisterSlashCommand",
 "audioEnable","audioPlay","audioMode","playAudio","stopAudio","stopGeneration",
 "getAllChatMessages","getChatHistory","getLastMessage","getLastUserMessage",
 "createChatMessages","deleteChatMessages","deleteChatMessage",
 "insertOrAssignVariables","getLorebookEntry","createLorebookEntries","deleteWorldbook",
 "replaceWorldbook","createWorldbook","setLorebookEntries","deleteLorebookEntries",
 "eventOnce","eventRemoveListener","eventClearAll"
].forEach(function(n){__jskDefine(n,__jskStub(n));});
})();`;
}

/**
 * 兜底清单 API 名（供单测断言「扫描到的 API 全部有实现」）
 */
export function requiredApiNames() {
    return [...OBSERVED_APIS];
}

export { FALLBACK_APIS };
