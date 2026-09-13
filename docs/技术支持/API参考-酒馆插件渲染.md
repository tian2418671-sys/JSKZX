> 📎 位置说明：本文件是**外部 API 参考**（SillyTavern / JS-Slash-Runner 渲染能力），归入 `docs/技术支持/`。
> 用途：插件工作区「✨ 效果」页渲染能力的依据；当前宿主 `hostStub.js` 的缺口清单在文首「〇、结论速览」。
> 相关缺陷：插件预览空白 / CSP 拦截见 `docs/bugs/BUG-架构与渲染.md`（AR-27、AR-28）。

# 酒馆插件渲染 API 调研（插件工作区「效果」页修复依据）

> 调研日期：2026-09-07
> 用途：修复插件工作区（PluginWorkspace）「✨ 效果」页沙箱预览——当前 `js/plugins/hostStub.js`
> 的渲染链路是半成品（模板渲染返回空串、Markdown 直通、无消息块渲染等），本文档是修复依据。
>
> 数据来源（2026-09-07 抓取，release/main 分支）：
> - SillyTavern 主仓库 https://github.com/SillyTavern/SillyTavern（release 分支）
> - JS-Slash-Runner（Tavern-Helper）https://github.com/N0VI028/JS-Slash-Runner（main 分支）
> - JS-Slash-Runner 官方文档 https://n0vi028.github.io/JS-Slash-Runner-Doc/

---

## 〇、结论速览：当前 hostStub.js 的「半成品」缺口清单

| # | 缺口 | 真实酒馆行为（依据） | 当前桩子行为 |
|---|------|---------------------|-------------|
| 1 | **扩展模板渲染** | Handlebars 引擎，`renderExtensionTemplateAsync(ext, id, data)` 读 `scripts/extensions/<ext>/<id>.html` 编译渲染 | 返回空串，扩展设置面板全部渲染不出来 |
| 2 | **Markdown 渲染** | Showdown（`converter.makeHtml`）转换消息正文 | `__jskMarkdown.makeHtml` 直通原文，无 Markdown 效果 |
| 3 | **消息块渲染** | `#message_template .mes` 克隆出完整 `.mes` 块（头像/名字/时间戳/正文） | `#chat` 是空壳，`.mes` 块结构不存在，依赖它的插件无挂载点 |
| 4 | **messageFormatting** | substituteParams→正则→引号样式→Showdown→DOMPurify 完整管线 | 原样返回，不替换宏、不转 Markdown |
| 5 | **事件清单** | `events.js` 全量 `event_types`（含 APP_INITIALIZED、CHAT_LOADED 等） | 缺约 10 个事件；部分事件语义不完整 |
| 6 | **getContext 成员** | `st-context.js` 完整成员（swipe/macros/loader/variables 等） | 缺 deleteMessage、swipe、macros、loader、variables 等约 20 项 |
| 7 | **SlashCommand 类字段** | name/callback/helpString/splitUnnamedArgument/rawQuotes/aliases/returns/namedArgumentList/unnamedArgumentList | 缺 splitUnnamedArgument、rawQuotes、aliases、helpCache 渲染 |
| 8 | **SlashCommandParser** | 真解析器：parse/addCommandObject/addCommandObjectUnsafe/命令帮助渲染 | `parse()` 假实现（返回 {command:null,args:[]}） |

---

## 一、扩展模板渲染：renderExtensionTemplateAsync（Handlebars）

出处：`public/scripts/extensions.js`（行 ~123-139）、`public/scripts/templates.js`（引擎本体）。

```js
// extensions.js
export function renderExtensionTemplate(extensionName, templateId, templateData = {}, sanitize = true, localize = true) {
    return renderTemplate(`scripts/extensions/${extensionName}/${templateId}.html`, templateData, sanitize, localize, true);
}
export function renderExtensionTemplateAsync(extensionName, templateId, templateData = {}, sanitize = true, localize = true) {
    return renderTemplateAsync(`scripts/extensions/${extensionName}/${templateId}.html`, templateData, sanitize, localize, true);
}
```

```js
// templates.js —— 引擎是 Handlebars
const TEMPLATE_CACHE = new Map();
export async function renderTemplateAsync(templateId, templateData = {}, sanitize = true, localize = true, fullPath = false) {
    // fullPath=true：templateId 即完整路径；否则拼 /scripts/templates/<id>.html（内置模板）
    const pathToTemplate = fullPath ? templateId : `/scripts/templates/${templateId}.html`;
    let template = TEMPLATE_CACHE.get(pathToTemplate);
    if (!template) {
        const templateContent = await getUrlAsync(pathToTemplate);   // XHR 同步/异步拉取
        template = Handlebars.compile(templateContent);
        TEMPLATE_CACHE.set(pathToTemplate, template);
    }
    let result = template(templateData);   // 模板数据为 {{field}} 直接替换
    if (sanitize) result = DOMPurify.sanitize(result);
    if (localize) result = applyLocale(result);
    return result;
}
```

要点：
- **模板语法是 Handlebars**（`{{var}}`、`{{#each}}`、`{{#if}}`、三花括号 `{{{html}}}` 等）。
- 扩展模板路径约定：`scripts/extensions/<扩展名>/<模板id>.html`；内置模板 `/scripts/templates/<id>.html`。
- 渲染后强制 DOMPurify 消毒 + `applyLocale`（i18n 键替换）。
- `getContext().registerHelper` 在 release 已废弃为空函数（"Handlebars for extensions are no longer supported"）。

沙箱适配方案：模板文件随插件一起存在本地（扩展工程目录），预览时由主进程批量读入模板内容，
注入 iframe 一个 `__jskTemplates = { '<ext>/<id>.html': '...' }` 映射；桩子的
`renderExtensionTemplateAsync` 从映射取内容，用内嵌 Handlebars 运行时（可沿用
jquery/lodash 的 `?raw` 内联模式，新增 `handlebars` 依赖，约 70KB）编译渲染。
内置模板可只收录常用几张（或空实现回退）。

## 二、消息渲染：messageFormatting 与 Markdown（Showdown）

出处：`public/script.js`（`messageFormatting` 行 ~1753，converter 定义行 ~397/521）。

签名（release 分支真实签名）：

```js
export function messageFormatting(mes, ch_name, isSystem, isUser, messageId, sanitizerOverrides = {}, isReasoning = false)
```

处理管线（简化版即可覆盖插件预览需求）：
1. `substituteParams(mes, undefined, ch_name)`（第 0 条消息时替换宏）；
2. 用户提示词偏置剥离（power_user.user_prompt_bias）；
3. 正则脚本（`getRegexedString`，AI_OUTPUT/USER_INPUT 等 placement）；
4. `power_user.auto_fix_generated_markdown` → `fixMarkdown(mes, true)`；
5. **引号样式化**：英文引号/弯引号/书名号被包成 `<q>…</q>`；
6. **Markdown 转换：Showdown** —— `converter = new showdown.Converter({...})`，
   `converter.addExtension(markdownExclusionExt(), 'exclusion')`，然后 `converter.makeHtml(mes)`；
7. 代码块换行/`&amp;` 修复；
8. `DOMPurify.sanitize(mes, { MESSAGE_SANITIZE: true, ADD_TAGS: ['custom-style'], ... })`；
9. `encodeStyleTags` / `decodeStyleTags({ prefix: '.mes_text ' })`（内嵌 style 标签保护）。

要点：**酒馆正文 Markdown 引擎是 Showdown**（不是 marked/commonmark）。沙箱适配：新增
`showdown` 依赖（?raw 内联，约 40KB）实现 `makeHtml`，并实现宏替换 `substituteParams`
（{{user}}/{{char}}/{{original}} 等常见宏）与 `<q>` 引号样式，即可让消息正文渲染接近真实。

## 三、消息块 DOM 结构（.mes 块）

出处：`public/script.js`（`addOneMessage` 行 ~2490、`updateMessageElement` 行 ~2560）。

- 宿主 HTML 里有 `<div id="message_template"><div class="mes">…</div></div>` 模板；
  `messageTemplate = $('#message_template .mes')`，每条消息 `messageTemplate.clone()` 后填充。
- `updateMessageElement` 填充点（真实选择器）：
  - `.avatar img`（头像 URL：用户 → getThumbnailUrl('persona', user_avatar)；角色 → avatar/default_avatar）
  - `.ch_name .name_text`（消息者名字）、`.timestamp`（时间，moment 格式 LL LT）、`.mesIDDisplay`（#id）、`.tokenCounterDisplay`（token 数）、`.mes_timer`（生成耗时）
  - `.mes_bias`（偏置提示）、`.mes_text`（正文 HTML = messageFormatting 输出）、`.mes_reasoning`（思考区）
- 消息根元素属性：`mesid`、`swipeid`、`ch_name`、`is_user`、`is_system`、`timestamp`、`bookmark_link`、`force_avatar`、`type`（extra.type）。
- `addOneMessage(mes, {type, insertAfter, insertBefore, scroll, forceId, showSwipes})`：
  挂到 `#chat`，维护 `.last_mes` 类，swipe 用 `[mesid=…]` 定位复用。

沙箱适配方案：`buildHostDom()` 里补 `#message_template .mes` 完整骨架 + CSS；
桩子实现 `addOneMessage` 把 `__jskChat` 渲染成真实 `.mes` 块（配合 Showdown + 简化 messageFormatting），
并让 `getContext().chat` 与 `.mes[mesid]` 双向对应，插件注入的消息 UI 就有真实挂载点了。

## 四、getContext() 完整成员清单（st-context.js 行 ~114 起）

真实返回对象成员（节选，完整列表已本地核对）：

```
accountStorage, chat, characters, groups, name1, name2,
characterId: this_chid, groupId: selected_group, chatId,
getCurrentChatId, getRequestHeaders, reloadCurrentChat, renameChat,
saveSettingsDebounced, onlineStatus, maxContext, chatMetadata,
saveMetadataDebounced, streamingProcessor, eventSource, eventTypes,
addOneMessage, deleteLastMessage, deleteMessage, generate, sendStreamingRequest,
sendGenerationRequest, stopGeneration, tokenizers, getTextTokens, getTokenCount,
getTokenCountAsync, extensionPrompts, setExtensionPrompt, updateChatMetadata,
saveChat, openCharacterChat, openGroupChat, saveMetadata, sendSystemMessage,
activateSendButtons, deactivateSendButtons, saveReply, substituteParams,
substituteParamsExtended, SlashCommandParser, SlashCommand, SlashCommandArgument,
SlashCommandNamedArgument, SlashCommandEnumValue, ARGUMENT_TYPE,
executeSlashCommandsWithOptions, registerSlashCommand(废弃), executeSlashCommands(废弃),
timestampToMoment, registerHelper(废弃空函数), registerMacro, unregisterMacro,
registerFunctionTool, unregisterFunctionTool, isToolCallingSupported,
canPerformToolCalls, ToolManager, registerDebugFunction,
renderExtensionTemplate(废弃), renderExtensionTemplateAsync,
registerDataBankScraper, callPopup(废弃), callGenericPopup, showLoader, hideLoader,
mainApi, extensionSettings, ModuleWorkerWrapper, getTokenizerModel,
generateQuietPrompt, generateRaw, generateRawData, writeExtensionField,
writeExtensionFieldBulk, getThumbnailUrl, selectCharacterById, messageFormatting,
shouldSendOnEnter, isMobile, t, translate, getCurrentLocale, addLocaleData,
tags, tagMap, menuType, createCharacterData, event_types(兼容旧名), Popup,
POPUP_TYPE, POPUP_RESULT, chatCompletionSettings, textCompletionSettings,
powerUserSettings, getCharacters, getOneCharacter, getCharacterCardFields,
getCharacterSource, importFromExternalUrl, importTags, uuidv4, humanizedDateTime,
updateMessageBlock, appendMediaToMessage, ensureMessageMediaIsArray,
getMediaDisplay, getMediaIndex, scrollChatToBottom, scrollOnMediaLoad,
macros, loader, swipe: { left, right, to, show, hide, refresh, isAllowed, state },
variables: { local: { get, set, del, … }, global: { … } }, …
```

桩子缺口重点：`deleteMessage`、`swipe` 对象、`macros`、`loader`、`variables`、`getCharacterSource`、
`generateRaw`、`writeExtensionFieldBulk`、`registerHelper`（空实现也算补位）、`getTokenCount` 等。

## 五、事件系统

### 5.1 event_types 全量清单（public/scripts/events.js）

真实键值（常量 → 字符串），与桩子对比**缺**：`APP_INITIALIZED: 'app_initialized'`、
`CHAT_LOADED: 'chatLoaded'`、`GROUP_UPDATED: 'group_updated'`、`CHAT_RENAMED: 'chat_renamed'`、
`GROUP_CHAT_DELETED/CREATED`、`GROUP_MEMBER_DRAFTED`、`GROUP_WRAPPER_STARTED/FINISHED`、
`CHARACTER_GROUP_OVERLAY_STATE_CHANGE_BEFORE/AFTER`。
其余（APP_READY、MESSAGE_SWIPED、MESSAGE_SENT、CHAT_CHANGED='chat_id_changed'、
GENERATION_*、SETTINGS_LOADED、EXTENSIONS_FIRST_LOAD、CHARACTER_DELETED='characterDeleted' 等）
桩子已具备且字符串值正确。

### 5.2 AbstractEventTarget（public/scripts/slash-commands/AbstractEventTarget.js）

```js
export class AbstractEventTarget {
    addEventListener(type, callback, _options) { … }
    dispatchEvent(event) { … listeners 逐个执行，返回 true … }
    removeEventListener(type, callback, _options) { … }
}
```

### 5.3 JS-Slash-Runner 事件 API（@types/iframe/event.d.ts）

```ts
declare function eventOn<T extends EventType>(event_type: T, listener: ListenerType[T]): EventOnReturn;      // { stop: () => void }
declare function eventOnce<T>(event_type: T, listener: ListenerType[T]): EventOnReturn;
declare function eventMakeLast<T>(event_type: T, listener: ListenerType[T]): EventOnReturn;
declare function eventMakeFirst<T>(event_type: T, listener: ListenerType[T]): EventOnReturn;
declare function eventEmit(event_type: EventType, ...args: unknown[]): Promise<void>; // 签名形式
declare function eventOnButton(event_type: T, listener): void;  // 废弃：建议 eventOn(getButtonEvent(name), fn)
```

桩子已有 eventOn/eventOnce/eventMakeLast/eventMakeFirst/eventEmit/eventOnButton，返回 {stop()} 语义正确。

## 六、Slash 命令系统

### 6.1 SlashCommand（public/scripts/slash-commands/SlashCommand.js）

类字段（真实）：`name`、`callback`、`helpString`、`splitUnnamedArgument`（默认 false）、
`splitUnnamedArgumentCount`、`rawQuotes`（默认 false）、`aliases`（[]）、`returns`、
`namedArgumentList`（[]）、`unnamedArgumentList`（[]）；`static fromProps(props)` = Object.assign(new this(), props)。
另有 helpCache/helpDetailsCache 生成 `<li>` 帮助条目 DOM（命令帮助渲染）。

### 6.2 SlashCommandParser（public/scripts/slash-commands/SlashCommandParser.js）

- `static addCommand(command, callback, aliases, helpString='')` —— 废弃，
  内部 `this.addCommandObject(SlashCommand.fromProps({...}))`。
- `static addCommandObject(command)` / `addCommandObjectUnsafe(command)` —— 现代注册入口。
- `parse(text, …)` —— 真解析器（命令名/未命名参数/命名参数/枚举/闭包），桩子目前是假实现。

沙箱适配：SlashCommand 类补齐字段与 fromProps；SlashCommandParser 实现一个最小真实解析
（命令名 + 空格分词参数 + `name=value` 命名参数），addCommandObject 后继续渲染可点击命令面板
（现有 render() 机制保留）。

## 七、JS-Slash-Runner（Tavern-Helper）脚本 API

仓库：https://github.com/N0VI028/JS-Slash-Runner（display name Tavern-Helper；历史同名仓库有 endege/JS-Slash-Runner）。
文档：https://n0vi028.github.io/JS-Slash-Runner-Doc/

脚本内可用 API（@types/iframe/script.d.ts + 文档）：
- `getButtonEvent(button_name): string` —— 按钮点击事件类型 = `'button_' + name`（桩子一致 ✓）
- `getScriptButtons(): ScriptButton[]`、`replaceScriptButtons(buttons)`、
  `updateScriptButtonsWith(updater)`（支持同步/异步 updater）、`appendInexistentScriptButtons(buttons)`（桩子一致 ✓）
- `getScriptName(): string`、`getScriptInfo(): string`、`replaceScriptInfo(info)`（桩子一致 ✓）
- `ScriptButton = { name: string; visible: boolean }`
- 渲染器机制：**代码块内 iframe 渲染** —— 酒馆助手识别「 ``` 代码块且内容同时含 `<body>` 和 `</body>` 」，
  用 iframe 渲染成独立前端页面（支持任意框架/script 标签）；
- 头像：CSS 类 `user-avatar`/`user_avatar`、`char-avatar`/`char_avatar` 自动获得头像背景图；
  宏 `{{userAvatarPath}}`、`{{charAvatarPath}}` 替换为头像路径；
- 脚本侧 AI 生成入口 `triggerSlash(command)` → 酒馆 `executeSlashCommandsWithOptions`（返回 pipe/isError/errorMessage）。
- 事件 API 见 5.3；`eventOn` 所在界面关闭时监听自动卸载。

注：`SlashRunner.registerCommand/registerModule/registerHook/showMessage` 是**旧版 v1 脚本约定**，
新版脚本主要用 TavernHelper 函数 + eventOn；桩子两套都应保留（现状已支持），文档记录以示区分。

## 八、酒馆助手（Tavern Helper）JSON 插件约定

- JSON 形态：`{ id, name, content(userscript 源码), buttons: [{name, visible}] }`（本项目 scanner 已支持）。
- 加载后 content 以 jQuery 脚本注入酒馆页面，buttons 渲染进 `#extensionsMenu`，点击触发 `button_<name>` 事件（桩子一致 ✓）。
- 常用全局：`TavernHelper_API`（getChatMessages/getLastMessageId/getCurrentCharPrimaryLorebook/
  createLorebookEntries/getLorebookEntries/setLorebookEntries/triggerSlash）、toastr、jQuery、lodash。
- `getChatMessages(range)` 语义：`'0-9'` 返回 [0,9] 闭区间；无参返回全部（桩子实现一致 ✓）。

## 九、extension_settings 真实默认结构（extensions.js）

顶层 key：`apiUrl/apiKey/autoConnect/notifyUpdates/disabledExtensions/expressionOverrides/
memory/note/caption/expressions/connectionManager/dice/regex/regex_presets/character_allowed_regex/
preset_allowed_regex/tts/sd/chromadb/translate/objective/quickReply/randomizer/speech_recognition/
rvc/hypebot/vectors/variables{global}/attachments/character_attachments/disabled_attachments/gallery`。
桩子可复制此默认结构，避免扩展读 `extension_settings.xxx.yyy` 时 undefined 崩掉。

## 十、修复实施建议（对照 §〇 清单）

1. **依赖**：新增 `handlebars`、`showdown` 两个依赖（package.json），按现有 jquery/lodash 模式
   `import x from 'pkg/dist/xxx.min.js?raw'` 内联进沙箱 HTML（离线可用，符合项目打包约束）。
2. **模板渲染**（缺口 1）：PluginWorkspace.buildPreview 读取扩展工程模板文件（IPC readPluginFile）
   → 注入 `__jskTemplates` 映射 → 桩子 renderExtensionTemplateAsync/renderExtensionTemplate
   用 Handlebars.compile 渲染 + 轻量转义。
3. **消息渲染**（缺口 2/3/4）：buildHostDom 补 `#message_template` 骨架；桩子实现简化
   messageFormatting（宏替换 + `<q>` + Showdown.makeHtml）；addOneMessage 把演示会话渲染成 .mes 块。
4. **事件与上下文**（缺口 5/6）：按 §五/§四 清单补齐 event_types 与 getContext 成员（空实现/演示数据即可）。
5. **Slash 系统**（缺口 7/8）：SlashCommand 字段补齐；SlashCommandParser.parse 最小真实实现。
6. 每项修复配套 `test/` 单测（沿用 node --test 纯逻辑测试模式）；改完跑 `npm test` + 插件工作区热测试
   （资料库内置脚本：全自动总结.json / 更好的聊天记录管理 .json / statusSystem.js 作为真实样例回归）。
