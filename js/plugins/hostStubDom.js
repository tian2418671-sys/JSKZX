/**
 * 酒馆宿主 DOM 骨架与主题 CSS（纯字符串生成，无外部依赖）
 *
 * [!] 为什么单独一个文件：
 *    hostStub.js 依赖 `?raw` 导入（jquery/lodash/handlebars…），那是 **Vite 专有语法**，
 *    Node 直接 import 会报 ERR_PACKAGE_PATH_NOT_EXPORTED —— 于是这部分输出**永远无法被单测**。
 *    历史上正是因为「没人测过输出」，buildHostDom 的函数头丢失后一半骨架静默消失两个月。
 *
 *    把骨架与 CSS 抽到这里后，test/hostStubOutput.test.mjs 可以零依赖断言输出完整性。
 */

/**
 * HTML 转义（本地实现，避免为了一个函数去依赖 hostStubPure 造成循环引用）
 * @param {string} s
 */
function escapeHtmlLocal(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

/**
 * [THEME] 酒馆主题变量 + 基础组件样式（方案 A 第一步 · 2026-10-25）
 *
 * [BUG] 用户实测「插件渲染三个问题：效果页一片空白 / 渲染了但样式不对 / 资源加载不出来」。
 *    根因之一：沙箱里**一个酒馆 CSS 变量都没定义**。酒馆 style.css 与绝大多数扩展
 *    全都用 `var(--SmartThemeXxx)` 取色/字号，变量缺失 ⇒ 全部退化成 initial
 *    （透明背景 / 黑字 / 0 边框）⇒ 看起来"渲染了但样式全错"。
 *
 * 本函数补的是**最小可用集合**（不是完整 style.css，那有几千行且随版本变动）：
 *   1. `:root` 定义酒馆全套核心 `--SmartTheme*` 变量（暗色主题默认值）
 *   2. 常用基础类：`.menu_button` / `.list-group-item` / `.inline-drawer` /
 *      `dialog.popup` / `.text_pole` / `input[type=range]` / `.flex-container` 等
 *      —— 扩展搭 UI 最常用的类，没有它们面板出来就是"裸 HTML"
 *   3. `.mes` 消息块基础外观（给依赖消息结构的插件一个视觉落点）
 *
 * [!] 这是**兜底主题**：将来若接入真实酒馆 style.css，应改为「真样式优先、本兜底仅在缺失时生效」，
 *    避免两套样式互相覆盖。
 * @returns {string} CSS 文本
 */
export function buildTavernThemeCss() {
    return `
:root{
  /* —— 颜色（暗色主题，对齐酒馆默认 dark）—— */
  --SmartThemeBodyColor:#dcdcdc;
  --SmartThemeEmColor:#8ab4f8;
  --SmartThemeUnderlineColor:#8ab4f8;
  --SmartThemeQuoteColor:#7ac0ff;
  --SmartThemeShadowColor:rgba(0,0,0,.5);
  --SmartThemeBorderColor:rgba(255,255,255,.15);
  --SmartThemeBlurTintColor:rgba(24,24,27,1);
  --SmartThemeChatTintColor:rgba(24,24,27,1);
  --SmartThemeUserMesBlurTintColor:rgba(40,40,48,1);
  --SmartThemeBotMesBlurTintColor:rgba(32,32,38,1);
  --SmartThemeBlurStrength:10px;
  --SmartThemeBlurTintColorHex:#18181b;
  --SmartThemeUserMesBlurTintColorHex:#282830;
  --SmartThemeBotMesBlurTintColorHex:#202026;
  --SmartThemeQuoteColorHex:#7ac0ff;
  --SmartThemeEmColorHex:#8ab4f8;
  /* —— 字体 / 字号 —— */
  --SmartThemeFontFamily:"Noto Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --SmartThemeFontScale:15px;
  --SmartThemeFontSize:15px;
  --SmartThemeFontWeight:400;
  /* —— 布局 —— */
  --SmartThemeAvatarWidth:40px;
  --SmartThemeAvatarHeight:40px;
  --SmartThemeChatWidth:100%;
  --SmartThemeMessageSpacing:10px;
  /* —— 酒馆布局/阴影变量（2026-11-08 补）——————————————————————
     [BUG] 遮挡根因：「更好的聊天记录管理」的弹窗用
          position:absolute; top:0; left:0; right:0; bottom:0; width:var(--sheldWidth);
        而这些变量当时**一个都没定义** → width 失效、shadow 失效，
        弹窗直接扑到 body 顶部盖住横幅与按钮，用户看到「一条紫色块压在顶部」。
        酒馆 style.css 里这些都是核心变量，扩展普遍直接引用，必须给齐。 */
  --sheldWidth:50%;
  --sheldAlignCenter:auto;
  --black10a:rgba(0,0,0,.1);
  --black30a:rgba(0,0,0,.3);
  --black50a:rgba(0,0,0,.5);
  --black70a:rgba(0,0,0,.7);
  --white30a:rgba(255,255,255,.3);
  --mainFontFamily:"Noto Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mainFontSize:15px;
  --mainFontColor:#dcdcdc;
}
*,*::before,*::after{box-sizing:border-box;}
/* 通用按钮（酒馆扩展几乎都用 .menu_button） */
.menu_button{
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  padding:6px 14px;margin:2px;border-radius:6px;cursor:pointer;
  background:var(--SmartThemeUserMesBlurTintColor);color:var(--SmartThemeBodyColor);
  border:1px solid var(--SmartThemeBorderColor);
  font-family:inherit;font-size:.9em;line-height:1.4;
  transition:background .15s,border-color .15s,filter .15s;
  user-select:none;
}
.menu_button:hover{background:var(--SmartThemeQuoteColor);border-color:var(--SmartThemeEmColor);}
.menu_button:active{filter:brightness(.9);}
.menu_button.redOverlayGlow,.menu_button.danger{background:#7f1d1d;border-color:#b91c1c;}
/* 列表项 */
.list-group,.list-group-item{list-style:none;}
.list-group-item{
  padding:8px 12px;margin-bottom:4px;border-radius:6px;
  background:var(--SmartThemeBotMesBlurTintColor);color:var(--SmartThemeBodyColor);
  border:1px solid var(--SmartThemeBorderColor);
}
/* 输入框 */
.text_pole,input[type=text],input[type=number],input[type=password],textarea,select{
  padding:6px 10px;border-radius:6px;
  background:rgba(0,0,0,.35);color:var(--SmartThemeBodyColor);
  border:1px solid var(--SmartThemeBorderColor);
  font-family:inherit;font-size:.95em;outline:none;
}
.text_pole:focus,input:focus,textarea:focus,select:focus{border-color:var(--SmartThemeEmColor);}
input[type=range]{accent-color:var(--SmartThemeEmColor);}
/* 折叠面板（扩展设置最常用） */
.inline-drawer{width:100%;margin:6px 0;border:1px solid var(--SmartThemeBorderColor);border-radius:8px;overflow:hidden;}
.inline-drawer-header{
  display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:8px 12px;cursor:pointer;font-weight:600;
  background:var(--SmartThemeBotMesBlurTintColor);
}
.inline-drawer-header:hover{filter:brightness(1.15);}
.inline-drawer-content{padding:10px 12px;display:none;}
.inline-drawer.open .inline-drawer-content{display:block;}
.inline-drawer-toggle-button{transition:transform .2s;}
.inline-drawer.open .inline-drawer-toggle-button{transform:rotate(180deg);}
/* 弹窗（酒馆用 <dialog class="popup">） */
dialog.popup{
  padding:18px 22px;border-radius:12px;min-width:320px;max-width:min(720px,90vw);
  background:var(--SmartThemeBlurTintColor);color:var(--SmartThemeBodyColor);
  border:1px solid var(--SmartThemeBorderColor);
  box-shadow:0 16px 48px rgba(0,0,0,.6);
}
dialog.popup::backdrop{background:rgba(0,0,0,.6);}
/* 布局工具类 */
.flex-container{display:flex;gap:8px;align-items:center;}
.flex1{flex:1;min-width:0;}
.wide50p{width:50%;}
.alignContentCenter{align-items:center;}
/* 消息块基础外观 */
#chat{display:flex;flex-direction:column;gap:var(--SmartThemeMessageSpacing);}
.mes{
  display:flex;gap:10px;padding:10px 12px;border-radius:10px;
  background:var(--SmartThemeBotMesBlurTintColor);
  border:1px solid var(--SmartThemeBorderColor);
}
.mes[is_user="true"]{background:var(--SmartThemeUserMesBlurTintColor);}
.mes .avatar{width:var(--SmartThemeAvatarWidth);height:var(--SmartThemeAvatarHeight);border-radius:50%;object-fit:cover;flex-shrink:0;}
.mes .mes_text{flex:1;min-width:0;line-height:1.6;overflow-wrap:anywhere;}
.mes .ch_name{font-weight:600;color:var(--SmartThemeEmColor);}
.mes_text em,i{color:var(--SmartThemeEmColor);font-style:italic;}
.mes_text q{color:var(--SmartThemeQuoteColor);quotes:"\\201C" "\\201D";}
.mes_text code{padding:1px 5px;border-radius:4px;background:rgba(0,0,0,.45);font-family:ui-monospace,monospace;font-size:.9em;}
.mes_text pre{padding:10px;border-radius:8px;background:rgba(0,0,0,.45);overflow:auto;}
.mes_text pre code{background:none;padding:0;}
.mes_text blockquote{margin:8px 0;padding:4px 12px;border-left:3px solid var(--SmartThemeQuoteColor);color:var(--SmartThemeQuoteColor);}
.mes_text img{max-width:100%;height:auto;border-radius:6px;}
/* 滚动条（与主界面一致） */
::-webkit-scrollbar{width:10px;height:10px;}
::-webkit-scrollbar-track{background:transparent;}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:5px;}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.3);}
`;
}

/**
 * 生成酒馆宿主 DOM 骨架（插件常用挂载点）
 *
 * 结构对齐 SillyTavern 官方 `public/index.html` 与 `templates/wandMenu.html`。
 * 原则：**每个 ID 全局唯一**，且必须真实输出到页面（曾因函数头丢失导致一半骨架
 * 变成游离代码、永不输出，表现为「所有插件都没效果」）。
 *
 * `data-jsk-zone` 标记出「插件可能注入界面」的区域，供 Step 4 的挂载嗅探器
 * 隐藏空容器、高亮有产出的区域。
 *
 * 缺失这些挂载点时，插件 jQuery 的空集合 `.append()` 会**静默失败** ——
 * 这是历史第一坑，不报错、不产 DOM，表现与「插件本来就没内容」完全一致。
 */
/**
 * 生成酒馆宿主 DOM 骨架（插件常用挂载点）
 *
 * @param {object} [plugin] 插件模型（仅用于顶部横幅显示插件名）
 * @returns {string} HTML 片段
 */
export function buildHostDom(plugin) {
    const pluginLabel = escapeHtmlLocal((plugin && plugin.name) || '未命名');
    const kindSuffix = plugin && plugin.kind === 'extension' ? ' (扩展工程)' : '';
    return `
<style>
/* ═══════════════════════════════════════════════════════════════════════════
   宿主工作台布局（2026-11-08 补）
   [!] 历史回归：重建骨架时只写了 id 与 data-jsk-zone，**把内联样式和 min-height
      全丢了** → 空 div 天然 0 高度 → 用户看到「只有一个🪄和一个输入框，其余全空白」。
      空容器在插件注入前本来就该是空的，所以**必须给每个区域撑出可见高度**，
      否则用户根本不知道插件可以往哪里放东西。
   ═══════════════════════════════════════════════════════════════════════════ */
#jsk-host-workbench{position:relative;display:flex;flex-direction:column;gap:10px;padding:10px 12px;box-sizing:border-box;}

/* [WARN] 弹窗/遮罩层不能压住顶部导航条与横幅（2026-11-08）
   [BUG] 遮挡根因：插件弹窗普遍写 position:absolute; top:0; left:0; right:0; bottom:0;
      如果最近的定位祖先是 body，它就会扑到页面最顶部、盖住 #host-banner。
      给工作台加 position:relative 后，absolute 弹窗被限制在工作台内部。
      再对已知弹窗类做一次上限保护，防止 z-index 过大盖住导航条。 */
.popup,.dialogue_popup,#chat_history_manager_modal{max-height:calc(100% - 20px);}
#host-banner{z-index:2147483000 !important;}
#jsk-mount-nav{z-index:2147482900 !important;}
#jsk-toast-dock{z-index:2147482800 !important;}

/* 选项菜单（.options-content）—— 插件常往 <hr> 后面插链接 */
#options{min-height:36px;padding:6px 8px;border:1px dashed rgba(255,255,255,.12);border-radius:8px;background:rgba(255,255,255,.02);}
#options hr{border:0;border-top:1px solid rgba(255,255,255,.12);margin:4px 0;}

/* 魔法棒按钮 */
#extensionsMenuButton{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;
  border-radius:8px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);cursor:pointer;font-size:15px;}

/* 魔法棒菜单 —— 插件注册的菜单项落在这里 */
#extensionsMenu{display:flex;flex-wrap:wrap;gap:6px;min-height:34px;padding:6px;
  border:1px dashed rgba(139,92,246,.35);border-radius:8px;background:rgba(139,92,246,.05);}
#extensionsMenu:empty::after{content:'🪄 魔法棒菜单（插件注册的菜单项会出现在这里）';
  color:#52525b;font-size:11px;padding:6px 2px;}

/* 聊天区 —— 模拟消息渲染在这里 */
#chat{display:flex;flex-direction:column;gap:10px;min-height:140px;padding:10px;
  border:1px dashed rgba(255,255,255,.12);border-radius:8px;background:rgba(0,0,0,.15);}
#chat:empty::after{content:'💬 聊天消息区（模拟会话气泡会渲染在这里）';color:#52525b;font-size:11px;}
#chat-history{display:flex;flex-direction:column;gap:10px;min-height:1px;}

/* 发送栏 */
#send_form{display:flex;flex-direction:column;gap:6px;min-height:56px;padding:8px;
  border:1px dashed rgba(255,255,255,.12);border-radius:8px;}
#leftSendForm,#rightSendForm{display:flex;flex-wrap:wrap;gap:6px;min-height:22px;}
#send_textarea{width:100%;min-height:44px;box-sizing:border-box;padding:8px 10px;border-radius:8px;
  border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.25);color:var(--SmartThemeBodyColor,#dcdcdc);
  font-family:inherit;font-size:13px;resize:vertical;}

/* 扩展设置面板 —— 大多数扩展把 UI 塞在这里 */
#extensions_settings,#extensions_settings2{display:flex;flex-direction:column;gap:7px;min-height:46px;padding:8px;
  border:1px dashed rgba(255,255,255,.12);border-radius:8px;background:rgba(255,255,255,.015);}
#extensions_settings:empty::after,#extensions_settings2:empty::after{content:'⚙️ 扩展设置面板（设置项会出现在这里）';color:#52525b;font-size:11px;}

/* 每个扩展容器：空时收起，有内容时自动撑开 */
.extension_container,.extension_wand_container{min-height:0;}
.extension_container:not(:empty){min-height:28px;padding:4px 6px;border-radius:6px;background:rgba(255,255,255,.03);}
.extension_wand_container:not(:empty){display:inline-flex;min-height:26px;}

/* 区域标题（JS 在挂载嗅探时写入，便于用户识别） */
[data-jsk-zone]{position:relative;}

/* [WARN] 顶部条（横幅 + 导航）
   2026-11-08 第三版：**放弃 sticky，改成普通块**。
   前两版都错：
     ① 横幅在 body 外 → 插件弹窗 absolute top:0 扑到 body 顶部压住按钮行
     ② 横幅 sticky + z-index 超高分 → 叠在 #options 上方，把按钮行整条盖掉
   现在：普通文档流块（自然占高、不叠加），并且工作台本身承载弹窗定位上下文。 */
#jsk-topbar{display:flex;flex-direction:column;margin:-10px -12px 0 -12px;
  background:#1b1b1f;border-bottom:1px solid #3f3f46;position:relative;z-index:1;}
#host-banner{padding:5px 12px;font-size:11px;line-height:1.6;background:#27272a;
  border-bottom:1px solid #3f3f46;color:#a1a1aa;white-space:normal;word-break:break-all;}

/* [NOTE] 插件弹窗约束：absolute 弹窗只能在工作台「内容区」内活动，
   且高度不得超过内容区 —— 避免再压住顶部条或按钮行。 */
#jsk-host-content{position:relative;display:flex;flex-direction:column;gap:10px;flex:1 1 auto;min-height:0;}
#jsk-host-content > .popup,
#jsk-host-content > #chat_history_manager_modal,
#jsk-host-content > .dialogue_popup{max-height:100%;}
</style>
<div id="jsk-host-workbench">

  <!-- [WARN] 顶部条：普通文档流块，不 sticky、不高 z-index
       （前两版分别把按钮行「压掉一半」和「整条盖掉」，这里是第三版的稳定解） -->
  <div id="jsk-topbar">
    <div id="host-banner">[PLUGIN] 酒馆运行模拟 · 插件: ${pluginLabel}${kindSuffix}</div>
    <div id="jsk-mount-nav"></div>
  </div>

  <!-- [NOTE] 内容区：插件的 absolute 弹窗以此为定位上下文，不会压到顶部条 -->
  <div id="jsk-host-content">

  <!-- ── 顶部：选项菜单 + 魔法棒菜单 ───────────────────────────── -->
  <div id="options" class="options-content" data-jsk-zone="选项菜单">
    <hr>
  </div>
  <div id="extensionsMenuButton" title="扩展菜单">🪄</div>
  <div id="extensionsMenu" data-jsk-zone="魔法棒菜单">
    <div id="agi_wand_container" class="extension_wand_container"></div>
    <div id="alltalk_wand_container" class="extension_wand_container"></div>
    <div id="assets_wand_container" class="extension_wand_container"></div>
    <div id="audio_wand_container" class="extension_wand_container"></div>
    <div id="blip_wand_container" class="extension_wand_container"></div>
    <div id="caption_wand_container" class="extension_wand_container"></div>
    <div id="expressions_wand_container" class="extension_wand_container"></div>
    <div id="hypebot_wand_container" class="extension_wand_container"></div>
    <div id="idle_wand_container" class="extension_wand_container"></div>
    <div id="live2d_wand_container" class="extension_wand_container"></div>
    <div id="objective_wand_container" class="extension_wand_container"></div>
    <div id="qr_wand_container" class="extension_wand_container"></div>
    <div id="rvc_wand_container" class="extension_wand_container"></div>
    <div id="sd_wand_container" class="extension_wand_container"></div>
    <div id="summarize_wand_container" class="extension_wand_container"></div>
  </div>

  <!-- ── 中部：聊天区 + 发送栏 ────────────────────────────────── -->
  <!-- [!] #chat-history 必须**嵌在** #chat 里：真实酒馆的消息是 #chat 的直接子节点，
       插件普遍按 $('#chat .mes') 取消息。之前两者是兄弟节点，导致插件读 #chat 拿到 0 个节点。 -->
  <div id="chat" data-jsk-zone="聊天消息区">
    <div id="chat-history"></div>
  </div>
  <form id="send_form" data-jsk-zone="发送栏" onsubmit="return false;">
    <div id="leftSendForm"></div>
    <textarea id="send_textarea" placeholder="模拟输入框（仅用于让插件找到节点）"></textarea>
    <div id="rightSendForm"></div>
  </form>

  <!-- ── 扩展设置面板 1 ──────────────────────────────────────── -->
  <div id="extensions_settings" data-jsk-zone="扩展设置">
    <div id="assets_container" class="extension_container"></div>
    <div id="typing_indicator_container" class="extension_container"></div>
    <div id="expressions_container" class="extension_container"></div>
    <div id="sd_container" class="extension_container"></div>
    <div id="tts_container" class="extension_container"></div>
    <div id="rvc_container" class="extension_container"></div>
    <div id="stt_container" class="extension_container"></div>
    <div id="audio_container" class="extension_container"></div>
    <div id="silence_container" class="extension_container"></div>
    <div id="objective_container" class="extension_container"></div>
    <div id="blip_container" class="extension_container"></div>
    <div id="live2d_container" class="extension_container"></div>
    <div id="vrm_container" class="extension_container"></div>
    <div id="timelines_container" class="extension_container"></div>
    <div id="webllm_container" class="extension_container"></div>
    <div id="rss_container" class="extension_container"></div>
  </div>

  <!-- ── 扩展设置面板 2 ──────────────────────────────────────── -->
  <div id="extensions_settings2" data-jsk-zone="扩展设置 2">
    <div id="websearch_container" class="extension_container"></div>
    <div id="emulatorjs_container" class="extension_container"></div>
    <div id="qr_container" class="extension_container"></div>
    <div id="translation_container" class="extension_container"></div>
    <div id="caption_container" class="extension_container"></div>
    <div id="idle_container" class="extension_container"></div>
    <div id="summarize_container" class="extension_container"></div>
    <div id="hypebot_container" class="extension_container"></div>
    <div id="regex_container" class="extension_container"></div>
  </div>

  <!-- ── 其它容器（部分插件直接按 id 找） ────────────────────── -->
  <div id="sheld" style="display:none;"></div>
  <div id="right-nav-panel"></div>
  <div id="movingDivs"></div>

  </div><!-- /#jsk-host-content -->

  <!-- ── 必需隐藏模板（插件 clone 用，放在内容区外，不参与布局） ── -->
  <!-- [WARN] 结构必须对齐真实酒馆：#message_template 是**外层容器**，.mes 在它**内部**。
       插件通用写法是 $("#message_template .mes").clone()；
       若把 .mes 挂在 #message_template 自己身上，选择器取不到 -> cloneNode 报 null。 -->
  <div id="message_template" style="display:none;">
    <div class="mes" is_user="false" is_system="false">
      <div class="mes_block">
        <div class="ch_name"><span class="name_text"></span></div>
        <div class="mes_text"></div>
        <div class="mes_buttons"></div>
      </div>
    </div>
  </div>
  <div id="zoomed_avatar_template" style="display:none;"></div>
</div>`;
}
