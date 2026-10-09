'use strict';
/**
 * 📦 整库冷备（一键全量快照）— 主进程侧实现
 * ─────────────────────────────────────────────────────────────
 * 定位：配置备份（`app_config.json`）与「单卡/单书/单预设快照」（`jsTavern_Backups`）之上的
 *      **第三层：整库时间点** —— 把当前库的整个目录树冷备到用户指定目录（可指向备份盘），
 *      保留最近 N 份自动轮转，可浏览 / 恢复 / 删除。
 *
 * 规格：`docs/规格与计划/功能规格/整库冷备-实现规格.md`（本文实现与之逐条对齐）
 *
 * 设计要点（改动前先读）：
 *   · **逐文件复制**（不用 `fs.cp` 整树静默）：便于发进度事件、可取消、可跳过噪音文件；
 *   · **排除规则**：隐藏目录（`.` 开头 —— 与扫描口径一致，天然覆盖库内 `.bak_history` / `.trash`）、
 *     `*.tmp`、`jsTavern_Trash`（回收站在 userData，防御性排除）；
 *   · **`_manifest.json` 是唯一权威**：`list` 只认它 ⇒ 中断的冷备（没写完 manifest）不会被当成可用备份；
 *   · **防呆全部在主进程**（不信任渲染层）：目标不能是库自身/库内子目录、目标盘空间 < bytes×1.2 阻断、
 *     同一时刻仅一个任务、备份中禁恢复；
 *   · **恢复 = 改名 + 复制**（安全优先）：当前库先原地改名为 `<库名>_恢复前_<时间戳>`（同盘 rename，秒级），
 *     再把备份内容复制为原库名；任一步失败即中止且**不删任何备份**（幂等可重试）。
 *   · **不引入 zip 依赖**：v1 为目录直拷（规格 §五）。
 */
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const BACKUP_ROOT_NAME = 'JSK-FullBackup';
const MANIFEST_NAME = '_manifest.json';
const KEEP_MIN = 1;
const KEEP_MAX = 10;
const KEEP_DEFAULT = 3;
/** 空间余量系数（规格 §3.3.2：可用空间 < bytes × 1.2 → 阻断） */
const SPACE_FACTOR = 1.2;

// ─────────────────────────── 纯函数（可单测） ───────────────────────────

/** 归一化保留份数（1~10，默认 3） */
function normalizeKeep(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return KEEP_DEFAULT;
    return Math.min(KEEP_MAX, Math.max(KEEP_MIN, v));
}

/**
 * 排除规则：是否**跳过**该条目（目录或文件）
 * @param {string} name 条目名
 * @param {boolean} isDir
 */
function shouldExclude(name, isDir) {
    const n = String(name || '');
    if (!n) return true;
    if (n.startsWith('.')) return true;                       // 隐藏目录/文件（.bak_history / .trash …）
    if (/\.tmp$/i.test(n)) return true;                        // 临时文件
    if (isDir && (n === 'jsTavern_Trash' || n === BACKUP_ROOT_NAME)) return true;
    return false;
}

/** 时间戳 → `yyyyMMdd-HHmm`（本地时区） */
function stampOf(date) {
    const d = (date instanceof Date) ? date : new Date(date || Date.now());
    const p = (x) => String(x).padStart(2, '0');
    if (Number.isNaN(d.getTime())) return '00000000-0000';
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 备份目录名：`<库文件夹名>__<时间戳>` */
function backupFolderName(libraryPath, date) {
    const base = path.basename(String(libraryPath || '').replace(/[\\/]+$/, '')) || 'library';
    return `${base}__${stampOf(date)}`;
}

/**
 * 目标目录防呆：不能是库自身、也不能在库内（规格 §3.3.1）
 * @returns {{ ok: boolean, error?: string }}
 */
function assertDestRoot(destRoot, libraryPath) {
    const dest = path.resolve(String(destRoot || ''));
    const lib = path.resolve(String(libraryPath || ''));
    if (!destRoot) return { ok: false, error: '未选择冷备目录' };
    if (!libraryPath) return { ok: false, error: '当前未打开库（无可冷备的目录）' };
    if (dest === lib) return { ok: false, error: '冷备目录不能是库目录自身' };
    const rel = path.relative(lib, dest);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return { ok: false, error: '冷备目录不能位于库目录内部（会造成自我嵌套）' };
    }
    const rel2 = path.relative(dest, lib);
    if (rel2 && !rel2.startsWith('..') && !path.isAbsolute(rel2)) {
        return { ok: false, error: '库目录位于冷备目录内部，请换一个冷备目录' };
    }
    return { ok: true };
}

/** 构建 manifest（纯数据，写盘由调用方负责） */
function buildManifest({ appVersion = '', libraryPath = '', files = [], createdAt = new Date().toISOString() } = {}) {
    const list = (files || []).map((f) => ({ rel: String(f.rel || '').replace(/\\/g, '/'), size: Number(f.size) || 0, mtimeMs: Number(f.mtimeMs) || 0 }));
    return {
        schema: SCHEMA_VERSION,
        appVersion: String(appVersion || ''),
        libraryPath: String(libraryPath || ''),
        createdAt: String(createdAt),
        fileCount: list.length,
        bytes: list.reduce((n, f) => n + f.size, 0),
        files: list
    };
}

/** 解析 manifest 文本（宽容：损坏/缺字段 → ok:false，绝不半信半疑） */
function parseManifest(text) {
    try {
        const o = JSON.parse(String(text == null ? '' : text));
        if (!o || typeof o !== 'object') return { ok: false, error: 'manifest 不是对象' };
        if (Number(o.schema) !== SCHEMA_VERSION) return { ok: false, error: `manifest schema 不支持：${o.schema}` };
        if (!Array.isArray(o.files)) return { ok: false, error: 'manifest 缺少 files' };
        return {
            ok: true,
            manifest: {
                schema: SCHEMA_VERSION,
                appVersion: String(o.appVersion || ''),
                libraryPath: String(o.libraryPath || ''),
                createdAt: String(o.createdAt || ''),
                fileCount: Number(o.fileCount) || o.files.length,
                bytes: Number(o.bytes) || o.files.reduce((n, f) => n + (Number(f && f.size) || 0), 0),
                files: o.files
            }
        };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
    }
}

/**
 * 轮转选择：给定已有备份（含 createdAt），返回**应移入回收站**的（最旧的超出部分）
 * @param {Array<{dir:string, createdAt:string}>} items
 * @param {number} keep
 */
function pickRotationVictims(items, keep) {
    const k = normalizeKeep(keep);
    const sorted = (items || []).slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    if (sorted.length <= k) return [];
    return sorted.slice(0, sorted.length - k);
}

/** 人类可读字节（UI 与日志共用） */
function formatBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
    return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 把底层 IO 错误翻成用户能懂的提示（长路径要单独说清 —— 规格 §五） */
function classifyIoError(e) {
    const code = (e && e.code) || '';
    const msg = (e && e.message) || String(e);
    if (code === 'ENAMETOOLONG' || /ENAMETOOLONG|path too long/i.test(msg)) {
        return '路径过长：库内深层目录 + 冷备路径叠加超过系统上限（260 字符），请把冷备目录改到更短的路径';
    }
    if (code === 'ENOSPC') return '目标盘空间不足（写入过程中用尽）';
    if (code === 'EACCES' || code === 'EPERM') return '没有写入权限：请换一个有权限的目录（或以管理员身份运行）';
    if (code === 'ENOENT') return '路径不存在：库目录或冷备目录可能已被移动/删除';
    return msg;
}

// ─────────────────────────── 扫描（逐文件） ───────────────────────────

/**
 * 递归列举库内文件（遵守排除规则）
 * @param {string} root
 * @param {(rel:string, size:number, mtimeMs:number)=>void} onFile
 * @param {(rel:string)=>boolean} [isCancelled]
 */
async function walkLibrary(root, onFile, isCancelled) {
    const stack = [''];
    while (stack.length) {
        const relDir = stack.pop();
        if (isCancelled && isCancelled(relDir)) throw Object.assign(new Error('已取消'), { canceled: true });
        const abs = relDir ? path.join(root, relDir) : root;
        let entries = [];
        try { entries = await fs.promises.readdir(abs, { withFileTypes: true }); } catch (e) {
            if (e && (e.code === 'ENOENT' || e.code === 'EACCES')) continue; // 读不到的目录跳过（不中断整库冷备）
            throw e;
        }
        for (const ent of entries) {
            if (shouldExclude(ent.name, ent.isDirectory())) continue;
            const childRel = relDir ? path.join(relDir, ent.name) : ent.name;
            if (ent.isDirectory()) { stack.push(childRel); continue; }
            if (!ent.isFile()) continue; // 符号链接等一律跳过（避免环）
            let st;
            try { st = await fs.promises.stat(path.join(root, childRel)); } catch (e) { continue; }
            onFile(childRel, st.size, st.mtimeMs);
        }
    }
}

// ─────────────────────────── 服务（IPC 用） ───────────────────────────

/**
 * 创建整库冷备服务（IPC 层只做参数校验与事件转发）
 * @param {object} o
 * @param {string} o.appVersion
 * @param {object} o.shell Electron shell（删除走 trashItem）
 * @param {(p:object)=>void} [o.onProgress]
 */
function createFullBackupService({ appVersion = '', shell = null, onProgress = null } = {}) {
    let busy = false;              // 同一时刻仅一个任务（规格 §3.3.3）
    let cancelFlag = false;
    const emit = (p) => { try { if (onProgress) onProgress(p); } catch (e) { /* 事件失败不影响主流程 */ } };

    /** 目标盘可用空间（取不到 → null，跳过该防呆而不阻断） */
    async function freeSpaceOf(targetPath) {
        try {
            if (typeof fs.promises.statfs !== 'function') return null;
            // 目标目录可能还不存在：逐级上溯到存在的祖先
            let p = path.resolve(targetPath);
            for (let i = 0; i < 6; i++) {
                try { const st = await fs.promises.statfs(p); return Number(st.bavail) * Number(st.bsize); } catch (e) {
                    const up = path.dirname(p);
                    if (up === p) break;
                    p = up;
                }
            }
            return null;
        } catch (e) { return null; }
    }

    /** 列出某个 destRoot 下的全部可用备份（只认 manifest） */
    async function listBackups({ destRoot } = {}) {
        const root = path.join(String(destRoot || ''), BACKUP_ROOT_NAME);
        let dirs = [];
        try { dirs = await fs.promises.readdir(root, { withFileTypes: true }); } catch (e) { return { ok: true, items: [] }; }
        const items = [];
        for (const d of dirs) {
            if (!d.isDirectory() || shouldExclude(d.name, true)) continue;
            const dir = path.join(root, d.name);
            let parsed = { ok: false };
            try { parsed = parseManifest(await fs.promises.readFile(path.join(dir, MANIFEST_NAME), 'utf-8')); } catch (e) { parsed = { ok: false, error: 'no manifest' }; }
            if (!parsed.ok) continue;                                   // 中断的半成品：不露面
            const m = parsed.manifest;
            items.push({
                dir, name: d.name, createdAt: m.createdAt, fileCount: m.fileCount, bytes: m.bytes,
                libraryPath: m.libraryPath, appVersion: m.appVersion, schema: m.schema
            });
        }
        items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); // 新的在前
        return { ok: true, items, root };
    }

    /**
     * 全量冷备（逐文件 + manifest + 轮转）
     * @returns {Promise<{ok:boolean, backupDir?:string, fileCount?:number, bytes?:number, trashed?:string[], canceled?:boolean, error?:string}>}
     */
    async function createBackup({ libraryPath, destRoot, keep, label } = {}) {
        if (busy) return { ok: false, error: '已有冷备任务在进行中，请等它结束' };
        // ⚠️ 抢锁必须**在任何 await 之前**：否则两个并发调用会双双通过 `if (busy)` 检查（都被第一个 await 挂起），
        //    「同一时刻只允许一个任务」的防呆就形同虚设（单测 `★ 防呆` 抓到的真实竞态）。
        busy = true; cancelFlag = false;
        try {
            const guard = assertDestRoot(destRoot, libraryPath);
            if (!guard.ok) return { ok: false, error: guard.error };
            try {
                const st = await fs.promises.stat(libraryPath);
                if (!st.isDirectory()) return { ok: false, error: '库路径不是目录' };
            } catch (e) {
                return { ok: false, error: '库目录不可读：' + classifyIoError(e) };
            }
            const startedAt = Date.now();
            // ① 先列文件（拿总大小，供进度与空间检查）
            emit({ phase: 'scan', done: 0, total: 0, bytesDone: 0, bytesTotal: 0 });
            const files = [];
            await walkLibrary(libraryPath, (rel, size, mtimeMs) => files.push({ rel, size, mtimeMs }), () => cancelFlag);
            const bytesTotal = files.reduce((n, f) => n + f.size, 0);
            emit({ phase: 'scan', done: files.length, total: files.length, bytesDone: bytesTotal, bytesTotal });

            // ② 空间检查（取不到可用空间则跳过，不阻断）
            const free = await freeSpaceOf(destRoot);
            if (free != null && free < bytesTotal * SPACE_FACTOR) {
                return { ok: false, error: `目标盘可用空间不足：需要约 ${formatBytes(Math.ceil(bytesTotal * SPACE_FACTOR))}，当前可用 ${formatBytes(free)}` };
            }

            // ③ 逐文件复制
            const name = `${backupFolderName(libraryPath, new Date())}${label ? '__' + String(label).replace(/[\\/:*?"<>|]/g, '_').slice(0, 24) : ''}`;
            const backupDir = path.join(String(destRoot), BACKUP_ROOT_NAME, name);
            await fs.promises.mkdir(backupDir, { recursive: true });
            let bytesDone = 0;
            let done = 0;
            let lastEmit = 0;
            for (const f of files) {
                if (cancelFlag) {
                    // 取消：清掉半成品（没有 manifest，list 也不认，但目录会占空间 ⇒ 直接删掉）
                    try { await fs.promises.rm(backupDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
                    return { ok: false, canceled: true, error: '已取消（半成品已清理）' };
                }
                const src = path.join(libraryPath, f.rel);
                const dst = path.join(backupDir, f.rel);
                await fs.promises.mkdir(path.dirname(dst), { recursive: true });
                await fs.promises.copyFile(src, dst);
                bytesDone += f.size; done++;
                const now = Date.now();
                if (now - lastEmit > 120 || done === files.length) {
                    lastEmit = now;
                    emit({ phase: 'copy', done, total: files.length, bytesDone, bytesTotal });
                }
            }

            // ④ manifest **最后写**（中断的冷备不会被 list 认可）
            const manifest = buildManifest({ appVersion, libraryPath, files, createdAt: new Date().toISOString() });
            await fs.promises.writeFile(path.join(backupDir, MANIFEST_NAME), JSON.stringify(manifest, null, 1), 'utf-8');

            // ⑤ 轮转（最旧 → 回收站，不硬删）
            const listed = await listBackups({ destRoot });
            const victims = pickRotationVictims(listed.items, keep);
            const trashed = [];
            for (const v of victims) {
                if (v.dir === backupDir) continue;
                try {
                    if (shell && typeof shell.trashItem === 'function') await shell.trashItem(v.dir);
                    else await fs.promises.rm(v.dir, { recursive: true, force: true });
                    trashed.push(v.name);
                } catch (e) { /* 轮转失败不影响本次冷备成功 */ }
            }
            emit({ phase: 'done', done: files.length, total: files.length, bytesDone: bytesTotal, bytesTotal, backupDir });
            return { ok: true, backupDir, fileCount: files.length, bytes: bytesTotal, trashed, elapsedMs: Date.now() - startedAt };
        } catch (e) {
            if (e && e.canceled) return { ok: false, canceled: true, error: '已取消' };
            return { ok: false, error: classifyIoError(e) };
        } finally {
            busy = false;
        }
    }

    /**
     * 恢复（改名 + 复制；安全优先：任一步失败即中止，且不删任何备份）
     */
    async function restoreBackup({ backupDir, libraryPath } = {}) {
        if (busy) return { ok: false, error: '有任务在进行中（冷备/恢复），请稍后再试' };
        busy = true;
        try {
            let manifest = null;
            try {
                const parsed = parseManifest(await fs.promises.readFile(path.join(String(backupDir || ''), MANIFEST_NAME), 'utf-8'));
                if (!parsed.ok) return { ok: false, error: '备份不可用：' + parsed.error };
                manifest = parsed.manifest;
            } catch (e) {
                return { ok: false, error: '备份不可用：读不到 _manifest.json' };
            }
            if (!(manifest.fileCount > 0)) return { ok: false, error: '备份为空（fileCount = 0），拒绝恢复' };
            const lib = path.resolve(String(libraryPath || ''));
            if (!lib) return { ok: false, error: '未指定要恢复到哪个库路径' };
            // ① 当前库改名保留（同盘 rename；失败即中止，不动任何数据）
            let safeCopyPath = '';
            let renamed = false;
            try {
                await fs.promises.stat(lib);
                safeCopyPath = `${lib}_恢复前_${stampOf(new Date())}`;
                emit({ phase: 'restore-rename', done: 0, total: manifest.fileCount, bytesDone: 0, bytesTotal: manifest.bytes });
                await fs.promises.rename(lib, safeCopyPath);
                renamed = true;
            } catch (e) {
                if (e && e.code === 'ENOENT') { safeCopyPath = ''; } // 原库不存在：直接复制过去即可
                else return { ok: false, error: '改名当前库失败（未做任何改动）：' + classifyIoError(e) };
            }
            // ② 复制备份内容为原库路径
            try {
                let bytesDone = 0, done = 0, lastEmit = 0;
                for (const f of manifest.files) {
                    const src = path.join(String(backupDir), String(f.rel).split('/').join(path.sep));
                    const dst = path.join(lib, String(f.rel).split('/').join(path.sep));
                    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
                    await fs.promises.copyFile(src, dst);
                    bytesDone += Number(f.size) || 0; done++;
                    const now = Date.now();
                    if (now - lastEmit > 120 || done === manifest.files.length) {
                        lastEmit = now;
                        emit({ phase: 'restore-copy', done, total: manifest.files.length, bytesDone, bytesTotal: manifest.bytes });
                    }
                }
                emit({ phase: 'done', done: manifest.files.length, total: manifest.files.length, bytesDone: manifest.bytes, bytesTotal: manifest.bytes });
                return { ok: true, safeCopyPath, restored: manifest.fileCount, renamed };
            } catch (e) {
                return {
                    ok: false,
                    safeCopyPath,
                    error: '复制备份内容失败（旧库仍完整保留在安全副本中，备份也未被改动）：' + classifyIoError(e)
                };
            }
        } finally {
            busy = false;
        }
    }

    /** 删除一份备份（走回收站） */
    async function deleteBackup({ backupDir } = {}) {
        const dir = String(backupDir || '');
        if (!dir) return { ok: false, error: '未指定要删除的备份' };
        if (!dir.includes(BACKUP_ROOT_NAME)) return { ok: false, error: '拒绝删除：路径不在冷备根目录内' };
        try {
            if (shell && typeof shell.trashItem === 'function') await shell.trashItem(dir);
            else await fs.promises.rm(dir, { recursive: true, force: true });
            return { ok: true };
        } catch (e) {
            return { ok: false, error: classifyIoError(e) };
        }
    }

    return {
        createBackup,
        listBackups,
        restoreBackup,
        deleteBackup,
        cancel: () => { if (busy) { cancelFlag = true; return { ok: true }; } return { ok: false, error: '当前没有进行中的任务' }; },
        isBusy: () => busy,
        _freeSpaceOf: freeSpaceOf
    };
}

module.exports = {
    SCHEMA_VERSION, BACKUP_ROOT_NAME, MANIFEST_NAME, KEEP_MIN, KEEP_MAX, KEEP_DEFAULT, SPACE_FACTOR,
    normalizeKeep, shouldExclude, stampOf, backupFolderName, assertDestRoot,
    buildManifest, parseManifest, pickRotationVictims, formatBytes, classifyIoError,
    walkLibrary, createFullBackupService
};
