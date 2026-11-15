/**
 * 🗑️ 回收站清单（trash manifest）—— 让「移入回收站」可精确撤销
 * ═══════════════════════════════════════════════════════════════
 * 背景（P5）：`sys:trashFiles` 把文件移进 `userData/jsTavern_Trash`，文件名会被加上
 * `<时间戳>_<序号>_` 前缀，**原路径信息随之丢失** ⇒ 想「撤销本次批量清理」时无从还原。
 *
 * 本模块负责：
 *   1. 每次成功移入回收站，追加一条「原路径 ↔ 回收站文件」映射；
 *   2. 撤销时按原路径找回对应回收站文件并搬回原位（目标已存在则加 `_restored_<ts>` 后缀，**绝不覆盖**）；
 *   3. 清单自净：超过 30 天或超过 5000 条的旧条目自动淘汰。
 *
 * 纯 Node（只用 fs/path），不依赖 Electron → 可用临时目录单测。
 */
const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 5000;
const KEEP_DAYS = 30;

/** 路径归一化（Windows 下大小写/分隔符不敏感） */
const norm = (p) => String(p == null ? '' : p).replace(/\//g, '\\').toLowerCase();

/** 读清单（坏文件一律当空，不阻断清理流程） */
function readManifest(manifestPath) {
    try {
        const j = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        return Array.isArray(j && j.entries) ? j.entries : [];
    } catch (e) {
        return [];
    }
}

/** 原子写清单（tmp + rename；失败静默——撤销能力不能用「写不进去」挡住正常清理） */
function writeManifest(manifestPath, entries) {
    try {
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        const tmp = `${manifestPath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ updatedAt: Date.now(), entries }, null, 2), 'utf-8');
        fs.renameSync(tmp, manifestPath);
        return true;
    } catch (e) {
        return false;
    }
}

/** 淘汰旧条目（按时间截断 + 条数上限） */
function pruneEntries(entries, now = Date.now()) {
    const cutoff = now - KEEP_DAYS * 24 * 60 * 60 * 1000;
    const fresh = (Array.isArray(entries) ? entries : [])
        .filter((e) => e && e.original && e.trashed && Number(e.at || 0) >= cutoff);
    return fresh.slice(-MAX_ENTRIES);
}

/**
 * 追加「已移入回收站」记录
 * @param {string} manifestPath
 * @param {Array<{original:string, trashed:string}>} pairs
 * @param {number} [now]
 */
function appendTrashEntries(manifestPath, pairs, now = Date.now()) {
    const list = (Array.isArray(pairs) ? pairs : []).filter((p) => p && p.original && p.trashed);
    if (!list.length) return 0;
    const entries = readManifest(manifestPath);
    for (const p of list) entries.push({ original: p.original, trashed: p.trashed, at: now });
    writeManifest(manifestPath, pruneEntries(entries, now));
    return list.length;
}

/**
 * 从回收站还原
 * @param {object} args
 *   · manifestPath  清单路径
 *   · paths         可选：只还原这些**原路径**；不传 = 还原清单里全部（上限 MAX_ENTRIES）
 *   · now           注入时间戳（单测确定性）
 * @returns {{restored:Array<{original,finalPath,renamed:boolean}>, failed:Array<{path,error}>, remaining:number}}
 */
function restoreFromTrash({ manifestPath, paths, now = Date.now() } = {}) {
    const entries = readManifest(manifestPath);
    const want = Array.isArray(paths) && paths.length ? new Set(paths.map(norm)) : null;

    const restored = [];
    const failed = [];
    const keep = [];

    for (const entry of entries) {
        const hit = !want || want.has(norm(entry.original));
        if (!hit) { keep.push(entry); continue; }

        const trashed = entry.trashed;
        if (!fs.existsSync(trashed)) {
            failed.push({ path: entry.original, error: '回收站里已找不到该文件（可能已被手动清理）' });
            continue; // 失效条目直接丢弃
        }
        try {
            const dir = path.dirname(entry.original);
            fs.mkdirSync(dir, { recursive: true });
            let finalPath = entry.original;
            let renamed = false;
            if (fs.existsSync(finalPath)) {
                // 原位已有同名文件 → 加后缀并存，绝不覆盖
                const ext = path.extname(entry.original);
                const base = path.basename(entry.original, ext);
                finalPath = path.join(dir, `${base}_restored_${now}${ext}`);
                renamed = true;
                let seq = 1;
                while (fs.existsSync(finalPath)) {
                    finalPath = path.join(dir, `${base}_restored_${now}_${seq++}${ext}`);
                }
            }
            try {
                fs.renameSync(trashed, finalPath);
            } catch (e) {
                if (e && e.code === 'EXDEV') {
                    fs.copyFileSync(trashed, finalPath);
                    fs.unlinkSync(trashed);
                } else {
                    throw e;
                }
            }
            restored.push({ original: entry.original, finalPath, renamed });
        } catch (e) {
            failed.push({ path: entry.original, error: (e && e.message) || '还原失败' });
            keep.push(entry); // 还原失败：保留映射，便于重试
        }
    }

    writeManifest(manifestPath, pruneEntries(keep, now));
    return { restored, failed, remaining: keep.length };
}

module.exports = {
    MAX_ENTRIES, KEEP_DAYS,
    readManifest, writeManifest, pruneEntries, appendTrashEntries, restoreFromTrash,
};
