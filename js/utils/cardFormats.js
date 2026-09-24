/**
 * 📇 角色卡**文件格式能力表**（渲染层 ESM 封装）
 *
 * 数据源与 `main/cardFormats.js` **完全相同**（都读 `main/cardFormats.json`）——
 * 唯一权威定义只有那一份 JSON，本文件只是**渲染层的读取入口**
 * （渲染层是 ESM，直接 import JSON 即可；不 import `.js` 以免走 CJS 转换）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 🎯 渲染层为什么要用它（DF-25）
 * ───────────────────────────────────────────────────────────────
 * `.json` / `.png` / `.webp` **都能保存内容**（WebP 会自动升级为 PNG，见 `main.js` 的
 * `file:saveCard`）—— 但**旧版程序**（或 `sharp` 缺失时）WebP 存不上，
 * 且当时**不提示**（用户以为保存成功，重启发现白改了）。
 * ⇒ 渲染层保留「能否保存」的判定能力，用于：
 *   · 极端情况下（如 `sharp` 缺失导致 WebP 无法转换）给出**可操作的**原因；
 *   · 保存失败时区分「能力边界」与「真故障」，不笼统报「保存失败」。
 *
 * ⚠️ 不要在这里重写格式列表 —— 一切以 `main/cardFormats.json` 为准（DF-22 的教训）。
 *
 * 📌 `with { type: 'json' }` 是**导入属性**语法：Node ESM 与 Vite/Rollup 都支持
 *    （Node 需 ≥20.10；本项目 Node 24 + Vite 8）。**缺它会报
 *    `ERR_IMPORT_ATTRIBUTE_MISSING`** —— 单测直接跑 Node 时会命中。
 */
import FORMATS from '../../main/cardFormats.json' with { type: 'json' };

/** 可**扫描进库**的扩展名 */
export const SCANNABLE_EXTS = FORMATS.scannable;
/** 可**写回保存**的扩展名（不在此列表 ⇒ 标签以外的编辑无法持久化） */
export const SAVABLE_EXTS = FORMATS.savable;
/** 图片类扩展名（需读内嵌数据；非图片走 JSON.parse） */
export const IMAGE_EXTS = FORMATS.image;
/** 导入对话框的 `accept`（由可扫描列表派生） */
export const IMPORT_ACCEPT = SCANNABLE_EXTS.join(',');

/** 统一小写并归一（`JPG` / `.JPG` / `jpg` 都要能判） */
export const normExt = (v) => {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return '';
    return s.startsWith('.') ? s : `.${s}`;
};

/** 该扩展名能否**扫描进库** */
export const isScannable = (ext) => SCANNABLE_EXTS.includes(normExt(ext));
/** 该扩展名能否**写回保存**（false ⇒ 内容编辑无法持久化，UI 必须告知用户） */
export const isSavable = (ext) => SAVABLE_EXTS.includes(normExt(ext));
/** 该扩展名是否**图片类** */
export const isImageExt = (ext) => IMAGE_EXTS.includes(normExt(ext));

/**
 * 🗂️ 按**路径**判能否保存（渲染层最常用的入口 —— 库条目给的是 `path`）
 * @param {string} filePath 卡片文件路径（含扩展名）
 * @returns {boolean} true = 可写回（`.json` / `.png`）
 */
export const isPathSavable = (filePath) => {
    const p = String(filePath || '');
    const dot = p.lastIndexOf('.');
    if (dot < 0) return false;
    return isSavable(p.slice(dot));
};

/**
 * 📝 不可保存格式的**用户可读原因**（给横幅 / 保存失败提示用）
 * @param {string} filePath 卡片文件路径
 * @returns {string} 可保存时返回空串；否则返回原因
 */
export const unsavableReason = (filePath) => {
    if (isPathSavable(filePath)) return '';
    const p = String(filePath || '');
    const dot = p.lastIndexOf('.');
    const ext = dot < 0 ? '' : p.slice(dot).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') {
        return 'JPEG 图片无法写入角色卡数据（该格式不在酒馆支持范围内，也无法无损转换）';
    }
    return `暂不支持 ${ext || '该'} 格式的在线保存`;
};

export default {
    SCANNABLE_EXTS, SAVABLE_EXTS, IMAGE_EXTS, IMPORT_ACCEPT,
    normExt, isScannable, isSavable, isImageExt, isPathSavable, unsavableReason
};
