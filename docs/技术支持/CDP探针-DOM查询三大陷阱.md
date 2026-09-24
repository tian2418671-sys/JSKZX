# 🧪 CDP 端到端探针 · DOM 查询三大陷阱（2026-09-24 实测踩坑）

> **背景**：写 `_probe-aitag-cot.mjs`（AI 打标分角色 + 思维链 + 连通性测试）时，
> 初版 **20 条断言里 10 条假失败** —— 全部是**探针自身写法**的问题，不是产品缺陷。> 记在这里，避免下次重踩。

---

## 🕳️ 陷阱 1 · `offsetParent` 对 `position:fixed` 元素**恒为 `null`**

**错的写法**（本项目既有探针 `_probe-aitag-nav.mjs` 用的就是这种，但**只对非 fixed 元素成立**）：

```js
const vis = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
```

**为什么错**：`offsetParent` 返回「最近的**定位**祖先」，而 **`position:fixed` 元素的 `offsetParent` 规范规定为 `null`**。
本项目所有弹窗都是 `fixed inset-0 z-50 ...` ⇒ 弹窗内的按钮/文本框用这个判据**全部判为「不可见」**。

**正确写法**（判「真实渲染出来且有尺寸」）：

```js
const isVisible = (el) => {
    if (getComputedStyle(el).display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
};
```

> ✅ `getBoundingClientRect()` 对 `display:none` 的**子孙**返回全 0 宽高，
> 所以「父级 `v-show=false` 隐藏了子元素」这种情况它**能正确判出**。

---

## 🕳️ 陷阱 2 · 弹窗根节点必须要求 `inset-0`（否则先命中 **Toast 容器**）

**错的写法**：

```js
const root = [...document.querySelectorAll('div')]
    .find(d => /fixed/.test(d.className) && /z-50/.test(d.className));
```

**为什么错**：**Toast 容器**也是 `fixed z-50 bg-gray-800/95 ...`（实测 420×72，6 个按钮），
而且它在 DOM 里**排在弹窗之前** ⇒ `find` 先命中它 ⇒ 之后所有「弹窗内查询」都在**Toast 容器里查**，
结果全是 `not-found` / `0 个`。

实测两个候选（同一时刻）：

| 元素 | class 前缀 | 尺寸 | 按钮数 |
| --- | --- | --- | --- |
| Toast 容器 | `fixed z-50 bg-gray-800/95 backdrop-blur-sm ...` | 420×72 | 6 |
| **AI 打标弹窗** | `fixed inset-0 z-50 bg-black/60 flex items-center justify-center ...` | 1264×761 | 133 |

**正确写法**（要求全屏遮罩 `inset-0`）：

```js
const MODAL_ROOT = `([...document.querySelectorAll('div')].find(d => {
    const c = typeof d.className === 'string' ? d.className : '';
    if (!/fixed/.test(c) || !/inset-0/.test(c) || !/z-50/.test(c)) return false;
    if (getComputedStyle(d).display === 'none') return false;
    const r = d.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}) || null)`;
```

---

## 🕳️ 陷阱 3 · 按钮查询**必须限定在弹窗内**（否则命中应用主体同名按钮）

**错的写法**：

```js
[...document.querySelectorAll('button')].find(x => x.textContent.includes('API 引擎'))
```

**为什么错**：弹窗打开时，**应用主体仍在 DOM 里**（只是被遮罩盖住）。实测会命中：

| 探针想点 | 实际先命中 | 后果 |
| --- | --- | --- |
| 「API 引擎」**分区** | HeaderBar 菜单项「⚡ API 引擎与模型设置...」 | 切不到分区 → 按钮查不到 |
| 「**关闭**档」（思维链第 3 档） | 弹窗右上角「✕ 关闭」 | **把弹窗关了** → 后续断言全崩 |

**正确写法**：

```js
// ① 限定在弹窗根节点内
const root = MODAL_ROOT;
const b = [...root.querySelectorAll('button')].find(...);

// ② 用「规范化后**完全等于**」而不是 includes —— 避免「关闭」命中「✕ 关闭」「关闭窗口」等
const norm = (s) => (s || '').replace(/[^A-Za-z\u4e00-\u9fa5]/g, '');
const btn = [...root.querySelectorAll('button')].find(x => norm(x.textContent) === '关闭');
```

---

## 📋 写新探针时的自检清单

1. 判可见性 → **不用 `offsetParent`**，用 `getComputedStyle` + `getBoundingClientRect`；
2. 找弹窗 → 必须带 **`inset-0`**（或按组件特有的 class 特征），别只靠 `fixed` + `z-50`；
3. 点按钮 → 先 **`MODAL_ROOT.querySelectorAll`**，再用 `norm(text) === label` 精确匹配；
4. 查文案是否渲染 → 也要限定在弹窗内（`document.body.innerText` 会把被遮罩的主体一起算进来）；
5. 状态读写 → 一律走 **`window.__jskDiag.*`**（自己 `import()` 会拿到另一个模块实例，读数全错）。

---

## 🕳️ 陷阱 4 · `[...divs].find(含文案)` 返回的是**最外层祖先**（2026-09-24 新增）

**错的写法**（想定位「包含某文案的那一行」）：

```js
const row = [...root.querySelectorAll('div')]
    .find(d => d.textContent.includes('探针原始内容') && d.querySelector('button'));
const btn = row.querySelector('button');   // ← 拿到的可能是**别的行**的按钮！
```

**为什么错**：`querySelectorAll` 按**文档顺序**返回，**外层容器排在行之前**。
外层容器的 `textContent` 也包含该文案 ⇒ `find` 返回**最外层祖先**，
在它里面 `querySelector('button')` 拿到的是**第一个**按钮 —— 完全不是那一行的。

> 🎯 **只注入 1 条数据时它碰巧能对**（只有 1 个按钮），**注入 2 条立刻暴露**（改错条目）。
> 本次实测：断言「保存 → 内容真的写进存储」失败，实际是**编辑了另一条记忆**。
> 📌 **教训：夹具至少要有 2 条同类数据** —— 单条数据会让「定位错行」这类缺陷隐形。

**正确写法**（用行自己的 class 特征）：

```js
const memRow = (text) => `([...document.querySelectorAll('div')].find(d => {
    const c = typeof d.className === 'string' ? d.className : '';
    if (!/border-b/.test(c) || !/group/.test(c)) return false;   // ← 行的特征 class
    return (d.textContent || '').includes(${JSON.stringify(text)});
}) || null)`;
```

---

## 🕳️ 陷阱 5 · 侧栏 / 列表这类**普通流式元素**不能用弹窗判据

**错的写法**：拿 `fixed inset-0 z-50` 去找「测卡侧栏」—— 侧栏是**右侧抽屉**（普通流式布局），永远找不到。

**正确写法**（按结构特征）：

```js
const SIDEBAR_ROOT = `([...document.querySelectorAll('div')].find(d => {
    const c = typeof d.className === 'string' ? d.className : '';
    if (!/border-l/.test(c) || !/flex-col/.test(c)) return false;
    if (!(d.textContent || '').includes('测卡工作区')) return false;   // ← 标题特征
    const r = d.getBoundingClientRect();
    return r.width > 100 && r.height > 100;
}) || null)`;
```

**附带发现**：分区 tab 是 **`<div>`（自绘 tab 栏）不是 `<button>`**，且标签带图标前缀（`⚙ 设置`）
⇒ 必须 `querySelectorAll('div')` + `endsWith(label)`，用 `button` + `===` 会 `not-found`。

---

## 🕳️ 陷阱 6 · 同页多个 `textarea` / `input` → 必须用 **placeholder 精确定位**

**错的写法**：`[...textareas].filter(可见)[0]` —— 侧栏里有多个 textarea（聊天输入、记忆编辑…），
取第一个就会「改了别的框，目标草稿没变」。

**正确写法**：

```js
const MEM_EDIT_TA = `([...document.querySelectorAll('textarea')].find(t =>
    (t.getAttribute('placeholder') || '').includes('记忆内容') && t.getBoundingClientRect().width > 0) || null)`;
```

---

## 🛑 附：**禁止用 PowerShell 改源码文件**（2026-09-24 真实事故）

本次用 `Set-Content`（PS 5.1 **默认 ANSI**）改 `ChatTestSidebar.vue`，
把 UTF-8 中文**写坏**（229 个 `U+FFFD`）—— `vite build` 与 `npm test` **都不报错**，
只有 `__jskDiag` 为 `undefined`（`import.meta.env.PROD` 判定受影响）才暴露。

**正确做法**：
1. **改源码一律用编辑工具**（`replace_string_in_file` / `multi_replace_string_in_file`），**绝不用 PS 重写整个文件**；
2. 若必须用命令行读写文件 → **用 Node**：`fs.readFileSync(p,'utf8')` / `fs.writeFileSync(p, s)`（默认 UTF-8）；
3. 改完立刻验：`node -e "const t=require('fs').readFileSync('文件','utf8'); console.log((t.match(/\uFFFD/g)||[]).length)"` → **必须是 0**；
4. 还原途径：`execFileSync('git',['show','HEAD:路径'])` 取回**干净 UTF-8** 版本（⚠️ 不要用 `git show > file`，PS 重定向会写成 UTF-16）。

---

## ✅ 有效性验证（探针必须能抓到缺陷，否则是「假绿」）

写完探针后做了**双向对照**（2026-09-24）：

| 注入的缺陷 | 期望 | 实测 |
| --- | --- | --- |
| 解析器「取最后一个有效包裹」→ 改回「取第一个」（模拟 AI-09 未修复） | 单测报错 | ✅ 单测 **69/70**（`多包裹时取「最后一个有效」` 用例失败） |
| 删掉 `AITagModal.vue` 的「🔗 思维链」小页签 | 探针报错 | ✅ 探针 **16/20**（4 条失败：页签齐全 / 逐页签切换 / 默认档只读 / 自定义可写） |
| 删掉 `ChatTestSidebar.vue` 的 `watch(memViewMode)`（列表不随模式刷新） | 探针报错 | ✅ 探针 **9/16**（7 条失败，含「记忆列表渲染出条目」） |

⇒ 三者都不是恒真的假绿；改动被还原后 `npm test` = **757/757**、两个探针 = **20/20** + **16/16**。
