/**
 * 酒馆 UI 主题预览器（纯函数，供 node --test 直接单测）
 *
 * ── 为什么单独做一套 ─────────────────────────────────────────────────────
 * `晦明v2.6.json` 这类文件是**纯配色配置**，没有任何可执行代码：
 *   { "name": "晦明v2.6", "blur_tint_color": "rgba(248,247,245,1)", ... }
 * 丢进脚本沙箱必然一无所获，用户只会看到「插件没有可运行的脚本内容」。
 * 正确做法：把配色映射成 CSS 变量，渲染一个「套用该主题」的示意页，
 * 让人一眼看出这个主题是什么调性（暖白 / 冷灰 / 高对比…）。
 */

/** 酒馆主题 JSON 字段 → CSS 变量 */
export const THEME_VAR_MAP = {
    main_text_color: '--SmartThemeBodyColor',
    italics_text_color: '--SmartThemeEmColor',
    underline_text_color: '--SmartThemeUnderlineColor',
    quote_text_color: '--SmartThemeQuoteColor',
    shadow_color: '--SmartThemeShadowColor',
    border_color: '--SmartThemeBorderColor',
    blur_tint_color: '--SmartThemeBlurTintColor',
    chat_tint_color: '--SmartThemeChatTintColor',
    user_mes_blur_tint_color: '--SmartThemeUserMesBlurTintColor',
    bot_mes_blur_tint_color: '--SmartThemeBotMesBlurTintColor',
    blur_strength: '--SmartThemeBlurStrength',
};

/** CSS 值净化：只允许颜色/长度/关键字等安全字符，阻断 `;}` `</style>` 之类的逃逸 */
function sanitizeCssValue(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    // 危险字符：分号、花括号、尖括号、反斜杠、换行 —— 一律拒绝整条
    if (/[;{}<>\\\r\n]/.test(s)) return '';
    // 只接受：颜色(#rgb/rgba()/hsl()/颜色名)、长度(px/%/em/rem)、纯数字
    if (!/^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla)\([^)]*\)|[a-zA-Z]+|\d+(\.\d+)?(px|%|em|rem|vh|vw)?)$/.test(s)) {
        return '';
    }
    return s;
}

/**
 * 把主题 JSON 转成 CSS 变量声明
 * @param {object} theme 主题对象
 * @returns {{css:string, vars:Array<{key:string,varName:string,value:string}>}}
 */
export function themeToCssVars(theme) {
    const vars = [];
    const obj = theme && typeof theme === 'object' ? theme : {};
    for (const [key, cssVar] of Object.entries(THEME_VAR_MAP)) {
        const raw = obj[key];
        if (raw == null || raw === '') continue;
        let value = sanitizeCssValue(raw);
        if (!value) continue;
        // blur_strength 是纯数字（px 单位），其它是颜色
        if (key === 'blur_strength' && /^\d+(\.\d+)?$/.test(value)) value += 'px';
        vars.push({ key, varName: cssVar, value });
    }
    const css = vars.map((v) => `${v.varName}:${v.value};`).join('');
    return { css, vars };
}

/** HTML 转义 */
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

/**
 * 生成主题预览页（完整 HTML，可装进 iframe）
 * @param {object} theme 主题对象
 * @param {object} [opts]
 * @param {string} [opts.name] 主题名（缺省读 theme.name）
 * @returns {string}
 */
export function buildThemePreviewHtml(theme, opts = {}) {
    const obj = theme && typeof theme === 'object' ? theme : {};
    const name = (opts && opts.name) || obj.name || '未命名主题';
    const { css, vars } = themeToCssVars(obj);

    // 色板：把每个变量渲染成一块颜色
    const swatches = vars.map((v) => `
      <div class="jsk-swatch">
        <div class="jsk-swatch-chip" style="background:${esc(v.value)}"></div>
        <div class="jsk-swatch-meta">
          <code>${esc(v.key)}</code>
          <span>${esc(v.value)}</span>
        </div>
      </div>`).join('');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
/* [THEME] 默认暗色底，再用主题变量覆盖 —— 让人看出「套用后是什么样」 */
:root{
  --SmartThemeBodyColor:#dcdcdc;
  --SmartThemeEmColor:#8ab4f8;
  --SmartThemeUnderlineColor:#8ab4f8;
  --SmartThemeQuoteColor:#7ac0ff;
  --SmartThemeShadowColor:rgba(0,0,0,.5);
  --SmartThemeBorderColor:rgba(255,255,255,.15);
  --SmartThemeBlurTintColor:#18181b;
  --SmartThemeChatTintColor:#18181b;
  --SmartThemeUserMesBlurTintColor:#282830;
  --SmartThemeBotMesBlurTintColor:#202026;
  --SmartThemeBlurStrength:10px;
  ${css}
}
html,body{margin:0;padding:0;background:var(--SmartThemeBlurTintColor);color:var(--SmartThemeBodyColor);
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;}
body{padding:16px 18px;box-sizing:border-box;}
.jsk-head{display:flex;align-items:baseline;gap:10px;margin-bottom:14px;padding-bottom:10px;
  border-bottom:1px solid var(--SmartThemeBorderColor);}
.jsk-head h1{margin:0;font-size:16px;font-weight:700;}
.jsk-head .jsk-tag{font-size:11px;padding:2px 8px;border-radius:999px;
  background:var(--SmartThemeBotMesBlurTintColor);border:1px solid var(--SmartThemeBorderColor);}
.jsk-section{margin:16px 0;}
.jsk-section > h2{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--SmartThemeEmColor);
  letter-spacing:.04em;}
.jsk-swatches{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;}
.jsk-swatch{display:flex;align-items:center;gap:8px;padding:6px;border-radius:8px;
  background:var(--SmartThemeBotMesBlurTintColor);border:1px solid var(--SmartThemeBorderColor);}
.jsk-swatch-chip{width:28px;height:28px;border-radius:6px;flex:0 0 auto;
  border:1px solid var(--SmartThemeBorderColor);}
.jsk-swatch-meta{display:flex;flex-direction:column;min-width:0;}
.jsk-swatch-meta code{font-size:10px;color:var(--SmartThemeEmColor);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.jsk-swatch-meta span{font-size:10px;color:var(--SmartThemeBodyColor);opacity:.7;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.jsk-msg{display:flex;gap:10px;padding:10px 12px;border-radius:10px;margin-bottom:8px;
  border:1px solid var(--SmartThemeBorderColor);box-shadow:0 1px 4px var(--SmartThemeShadowColor);}
.jsk-msg[data-role="user"]{background:var(--SmartThemeUserMesBlurTintColor);}
.jsk-msg[data-role="bot"]{background:var(--SmartThemeBotMesBlurTintColor);}
.jsk-msg .jsk-avatar{width:32px;height:32px;border-radius:50%;flex:0 0 auto;
  background:var(--SmartThemeEmColor);opacity:.85;}
.jsk-msg .jsk-name{font-weight:700;color:var(--SmartThemeEmColor);font-size:12px;margin-bottom:3px;}
.jsk-msg .jsk-text{font-size:13px;line-height:1.6;}
.jsk-msg .jsk-text em{color:var(--SmartThemeEmColor);}
.jsk-msg .jsk-text q{color:var(--SmartThemeQuoteColor);}
.jsk-msg .jsk-text a{color:var(--SmartThemeQuoteColor);text-decoration:underline;}
.jsk-btns{display:flex;flex-wrap:wrap;gap:8px;}
.jsk-btn{padding:6px 14px;border-radius:8px;font-size:12px;cursor:default;
  background:var(--SmartThemeBotMesBlurTintColor);color:var(--SmartThemeBodyColor);
  border:1px solid var(--SmartThemeBorderColor);}
.jsk-empty{padding:14px;border-radius:8px;font-size:12px;opacity:.7;
  border:1px dashed var(--SmartThemeBorderColor);}
</style>
</head>
<body>
  <div class="jsk-head">
    <h1>[THEME] ${esc(name)}</h1>
    <span class="jsk-tag">主题预览</span>
    <span class="jsk-tag">不运行脚本</span>
  </div>

  <div class="jsk-section">
    <h2>配色变量（${vars.length} 项）</h2>
    ${vars.length ? `<div class="jsk-swatches">${swatches}</div>` : '<div class="jsk-empty">这个主题没有可识别的配色字段。</div>'}
  </div>

  <div class="jsk-section">
    <h2>套用效果示意</h2>
    <div class="jsk-msg" data-role="user">
      <div class="jsk-avatar"></div>
      <div>
        <div class="jsk-name">User</div>
        <div class="jsk-text">这是用户消息，背景色取自主题的用户气泡配色。</div>
      </div>
    </div>
    <div class="jsk-msg" data-role="bot">
      <div class="jsk-avatar"></div>
      <div>
        <div class="jsk-name">角色</div>
        <div class="jsk-text">
          这是角色消息。<em>斜体强调</em>、<q>引用文字</q>、<a>链接</a>
          都会使用主题里对应的颜色。
        </div>
      </div>
    </div>
  </div>

  <div class="jsk-section">
    <h2>按钮与边框</h2>
    <div class="jsk-btns">
      <span class="jsk-btn">普通按钮</span>
      <span class="jsk-btn">另一个按钮</span>
    </div>
  </div>
</body>
</html>`;
}
