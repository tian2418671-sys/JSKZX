/**
 * 📇 角色卡**文件格式能力表**（**唯一权威定义** —— DF-22 的根治）
 *
 * ═══════════════════════════════════════════════════════════════
 * 🔴 为什么必须有这个文件（DF-22 的病根：三处各写一份，必然漂移）
 * ───────────────────────────────────────────────────────────────
 * 缺陷现象：「**导入能进、扫描不进**」—— 导入对话框声明支持 JPEG，
 * 但磁盘扫描白名单只有 `.png`/`.webp`/`.json` ⇒ 目录里的 JPEG 卡被**静默跳过**。
 * 根因就是**同一件事（能处理哪些格式）在三个地方各写了一遍**：
 *   · `js/components/HeaderBar.vue` 的 `accept="…"`
 *   · `js/utils/cardLoader.js` 的注释与判断
 *   · `main.js` 的扫描白名单（**两处**）
 *
 * ⚠️ 更关键的事实（本次排查发现，决定了「该对齐到哪一边」）：
 *   `main.js` 的 `file:saveCard` **只支持 `.json` / `.png`**（源码原话：
 *   「仅支持 .json / .png 卡片，**webp 无法回写数据**」）⇒
 *   **JPEG / WebP 卡无法把「标签 / 分类 / 编辑」写回文件**。
 *   若把 JPEG 加进扫描白名单，只是**把「静默不落盘」的陷阱扩大到更多文件类型**。
 *   ⇒ 正确方向是**收敛到「可读且可写」的格式**，而不是扩大「只能读」的格式。
 *
 * 📐 数据源：`main/cardFormats.json`（**单一数据源**，CJS 与 ESM 都能直接读 ⇒ 不会漂移）
 *
 * | 格式 | 扫描（进库） | 读内嵌数据 | **写回保存** |
 * |---|---|---|---|
 * | `.json` | ✅ | ✅ 直接 JSON.parse | ✅ 原子写文本 |
 * | `.png`  | ✅ | ✅ tEXt/iTXt 块 | ✅ `writeTavernPNGChunk` |
 * | `.webp` | ✅ | ✅ 深度扫描 base64 | ✅ **升级为 PNG 后写入**（DF-25 修复） |
 * | `.jpg` / `.jpeg` | ❌（DF-22 收敛掉） | ✅ 深度扫描 base64 | ❌ **无法回写** |
 */

const FORMATS = require('./cardFormats.json');

/** 可**扫描进库**的扩展名（磁盘目录扫描 + 导入对话框都以此为准） */
const SCANNABLE_EXTS = FORMATS.scannable;
/** 可**写回保存**的扩展名（`file:saveCard` 实际支持的范围） */
const SAVABLE_EXTS = FORMATS.savable;
/** 图片类（需要走「读内嵌数据」而非 JSON.parse）的扩展名 */
const IMAGE_EXTS = FORMATS.image;

/**
 * 导入对话框的 `accept` 值 —— **由可扫描列表派生**（不手写，避免再次漂移）
 * ⚠️ 不要在这里加 `.jpg`/`.jpeg`：它们**不可写回**，加了就是「声明了做不到的事」（DF-22）
 */
const IMPORT_ACCEPT = SCANNABLE_EXTS.join(',');

/** 统一小写并归一（`JPG` / `.JPG` / `jpg` 都要能判） */
const normExt = (v) => {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return '';
    return s.startsWith('.') ? s : `.${s}`;
};

/** 该扩展名能否**扫描进库**（磁盘扫描白名单 + 导入对话框共用） */
const isScannable = (ext) => SCANNABLE_EXTS.includes(normExt(ext));
/** 该扩展名能否**写回保存**（不可写的格式 ⇒ 标签/编辑无法持久化，必须让用户知道） */
const isSavable = (ext) => SAVABLE_EXTS.includes(normExt(ext));
/** 该扩展名是否**图片类**（需读内嵌数据；非图片走 JSON.parse） */
const isImageExt = (ext) => IMAGE_EXTS.includes(normExt(ext));

module.exports = {
    SCANNABLE_EXTS,
    SAVABLE_EXTS,
    IMAGE_EXTS,
    IMPORT_ACCEPT,
    normExt,
    isScannable,
    isSavable,
    isImageExt
};
