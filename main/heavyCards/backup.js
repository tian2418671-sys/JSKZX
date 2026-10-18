'use strict';
/**
 * 💾 重型卡存档备份引擎
 * ─────────────────────────────────────────────────────────────
 * 规格：`docs/规格与计划/功能规格/独立前端角色卡-承载方案-v3.md` §六
 *
 * 四条硬约束（实现中不可破坏，均为实机验证结论）：
 *   R1. **备份必须原子**：先写 `<stamp>.part` → `_manifest.json` 最后写 → 成功后 rename。
 *       进程被强杀时最多留下 `.part` 垃圾，永远不会产生"看起来可用的半截备份"。
 *   R2. **备份前必须刷盘**：`session.fromPartition(p).flushStorageData()`，
 *       否则 leveldb MemTable 里的数据不在磁盘上。
 *   R3. **恢复禁止提前建 session**（D2）：必须先用 `path.join` + `fs` 写完文件，
 *       再初始化 `session.fromPartition(nextPartition)` —— 否则 Chromium 会提前接管目录并持锁。
 *   R4. **leveldb 文件处理**（实测 V7）：跳过 `LOCK`，但 `CURRENT` / `MANIFEST-*` / `*.log` 必须保留。
 *
 * 本文件为纯 Node 逻辑（除可选的 flush 回调），可直接 `node --test` 单测。
 */

const fs = require('fs');
const path = require('path');

/** 备份目录名（默认根目录在 userData 下） */
const BACKUP_ROOT_NAME = 'heavycard-backups';
/** manifest 文件名（唯一权威：没有它就不算可用备份） */
const MANIFEST_NAME = '_manifest.json';
/** 未完成的临时目录后缀 */
const PART_SUFFIX = '.part';
/** 快照目录名里的类型标签 */
const KINDS = ['auto', 'manual', 'pre-restore'];

/** 保留份数上下限 */
const KEEP_MIN = 1;
const KEEP_MAX = 20;
const KEEP_DEFAULT = 5;

/**
 * 备份白名单（实测 V6 / V8 得出）
 * ⚠️ 只备份「存档相关」目录；Cache / Code Cache / GPUCache / Dawn* 等一律不备份。
 * `IndexedDB` 在只写 localStorage 的站点上**不存在**（实测），必须容错。
 */
const STORE_DIRS = ['Local Storage', 'Session Storage', 'IndexedDB', 'Network'];

/** leveldb 里**必须跳过**的文件名 */
const SKIP_FILE_NAMES = new Set(['LOCK']);
/** leveldb 里**必须保留**的文件名模式（改动前先读 §5.4） */
const KEEP_FILE_PATTERNS = [/^CURRENT$/, /^MANIFEST-/, /^LOG(\.old)?$/, /\.log$/, /\.ldb$/, /\.sst$/];

// ─────────────────────────── 纯函数（可单测） ───────────────────────────

/** 归一化保留份数 */
function normalizeKeep(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return KEEP_DEFAULT;
    return Math.min(KEEP_MAX, Math.max(KEEP_MIN, v));
}

/** 归一化备份类型 */
function normalizeKind(k) {
    const s = String(k || '');
    return KINDS.includes(s) ? s : 'auto';
}

/** 时间戳 → `2026-10-18T14-20-00`（本地时区，可直接当目录名） */
function stampOf(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** 快照目录名：`<stamp>_<kind>` */
function snapshotNameOf(date, kind) {
    return `${stampOf(date)}_${normalizeKind(kind)}`;
}

/**
 * 某个 partition 的磁盘目录（**纯字符串**，绝不经 Chromium）
 * 实测 V10：与 `session.getStoragePath()` 完全一致。
 */
function partitionDirOf(userDataPath, cardId, gen) {
    const g = Math.max(1, Math.round(Number(gen) || 1));
    return path.join(userDataPath, 'Partitions', `heavycard-${cardId}_g${g}`);
}

/** 该卡的备份根目录 */
function backupRootOf(userDataPath, cardId) {
    return path.join(userDataPath, BACKUP_ROOT_NAME, cardId);
}

/**
 * leveldb / 存储目录里该不该复制这个文件
 * @param {string} name 文件名
 * @returns {boolean}
 */
function shouldCopyFile(name) {
    const n = String(name || '');
    if (!n) return false;
    if (SKIP_FILE_NAMES.has(n)) return false;           // LOCK 必须跳过（运行时锁文件）
    if (n.endsWith(PART_SUFFIX)) return false;          // 自己的临时产物
    if (n === MANIFEST_NAME) return false;              // manifest 由本模块单独写
    // 其余一律复制（白名单按**目录**控制，不在这里做文件名白名单，
    // 否则会漏掉 Cookie / QuotaManager 等必要文件）
    return true;
}

/**
 * 保留策略：从按时间排序（旧→新）的列表中挑出应删除的
 * 规则：
 *   · 保留最近 keep 份
 *   · **最后一份 manual 永不删除**（用户手动备份视为锚点）
 *   · `pre-restore` 属于自动兜底，可被裁掉（但仅在超出 keep 时）
 * @param {Array<{name:string, kind:string, mtime:number}>} list 旧→新
 * @param {number} keep
 * @returns {Array<object>} 应删除的条目
 */
function pickRotateVictims(list, keep) {
    const items = Array.isArray(list) ? list.slice() : [];
    const k = normalizeKeep(keep);
    if (items.length <= k) return [];

    // 从最旧开始考虑删除，总量控制在 keep 份
    const excess = items.length - k;
    const victims = [];
    for (let i = 0; i < items.length && victims.length < excess; i++) {
        victims.push(items[i]);
    }

    // 保护：最后一份 manual 不能被删
    const lastManualIdx = (() => {
        for (let i = items.length - 1; i >= 0; i--) {
            if (items[i].kind === 'manual') return i;
        }
        return -1;
    })();
    if (lastManualIdx >= 0) {
        const vs = new Set(victims);
        const target = items[lastManualIdx];
        if (vs.has(target)) {
            // 用一份「非 manual」或「较早的 manual」替换掉
            const replacement = items.find((it) => !vs.has(it) && it !== target && it.kind !== 'manual')
                || items.find((it) => !vs.has(it) && it !== target);
            const idx = victims.indexOf(target);
            if (replacement) victims[idx] = replacement;
            else victims.splice(idx, 1);
        }
    }
    return victims;
}

/**
 * 构建 manifest（备份目录的**唯一权威**）
 * @param {object} p
 */
function buildManifest({
    cardId, name, url, gen, partition,
    kind = 'auto', createdAt = new Date().toISOString(),
    appVersion = '', electronVersion = '',
    files = [], totalBytes = 0, warnings = []
} = {}) {
    return {
        schema: 1,
        cardId: String(cardId || ''),
        name: String(name || ''),
        url: String(url || ''),
        gen: Math.max(1, Math.round(Number(gen) || 1)),
        partition: String(partition || ''),
        kind: normalizeKind(kind),
        createdAt,
        appVersion: String(appVersion || ''),
        electronVersion: String(electronVersion || ''),
        fileCount: Array.isArray(files) ? files.length : 0,
        files: Array.isArray(files) ? files : [],
        totalBytes: Number(totalBytes) || 0,
        warnings: Array.isArray(warnings) ? warnings : []
    };
}

/** 解析 manifest 文本；失败返回 null（调用方视为「非可用备份」） */
function parseManifest(text) {
    try {
        const o = JSON.parse(String(text || ''));
        if (!o || typeof o !== 'object') return null;
        if (!o.cardId || !o.createdAt) return null;
        return o;
    } catch (e) {
        return null;
    }
}

/** 字节格式化（展示用） */
function formatBytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// ─────────────────────────── IO 实现 ───────────────────────────

/** 递归统计目录（文件数 + 字节数） */
function statTree(dir) {
    let files = 0;
    let bytes = 0;
    const walk = (cur) => {
        let entries = [];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { return; }
        for (const ent of entries) {
            const full = path.join(cur, ent.name);
            if (ent.isDirectory()) walk(full);
            else if (ent.isFile()) {
                files++;
                try { bytes += fs.statSync(full).size; } catch (e) { /* 忽略 */ }
            }
        }
    };
    if (fs.existsSync(dir)) walk(dir);
    return { files, bytes };
}

/**
 * 递归复制目录（逐文件，可跳过 + 可发进度）
 * 为什么不用 `fs.cpSync`：需要跳过 LOCK、需要进度回调、需要单文件 EBUSY 重试。
 * @returns {{copied:number, skipped:number, warnings:string[]}}
 */
function copyTree(srcDir, destDir, { onProgress = null } = {}) {
    let copied = 0;
    let skipped = 0;
    const warnings = [];

    const walk = (src, dest, rel) => {
        let entries = [];
        try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch (e) {
            warnings.push(`读取失败 ${rel || '.'}: ${e.code || e.message}`);
            return;
        }
        try { fs.mkdirSync(dest, { recursive: true }); } catch (e) {
            warnings.push(`创建失败 ${rel || '.'}: ${e.code || e.message}`);
            return;
        }
        for (const ent of entries) {
            const s = path.join(src, ent.name);
            const d = path.join(dest, ent.name);
            const r = rel ? `${rel}/${ent.name}` : ent.name;
            if (ent.isDirectory()) {
                walk(s, d, r);
            } else if (ent.isFile()) {
                if (!shouldCopyFile(ent.name)) { skipped++; continue; }
                let ok = false;
                // EBUSY 重试：Windows 上 Chromium 会持有 Cookies / Cookies-journal 的句柄，
                // flushStorageData 不释放它。重试 + 逐级延长等待（10/40/120ms）比穷等更有效。
                let lastErr = null;
                for (let attempt = 0; attempt < 4 && !ok; attempt++) {
                    try {
                        fs.copyFileSync(s, d);
                        ok = true;
                    } catch (e) {
                        lastErr = e;
                        if (attempt < 3) {
                            // 同步短等待（本模块为同步遍历；总代价不超过 170ms/文件）
                            const until = Date.now() + [10, 40, 120][attempt];
                            while (Date.now() < until) { /* busy wait 极短 */ }
                        }
                    }
                }
                if (!ok) {
                    // Cookies 这类文件被占用属**可接受**降级：多一次重载会重新生成。
                    // 其它文件（leveldb 数据）失败才算真问题 —— 用 warn 前缀区分。
                    const isCookie = /^Cookies(-journal)?$/i.test(ent.name);
                    warnings.push(`${isCookie ? '[可忽略] ' : ''}复制失败 ${r}: ${(lastErr && (lastErr.code || lastErr.message)) || '未知'}`);
                } else {
                    copied++;
                    if (typeof onProgress === 'function') {
                        try { onProgress({ copied, rel: r }); } catch (e) { /* 忽略 */ }
                    }
                }
            }
        }
    };
    walk(srcDir, destDir, '');
    return { copied, skipped, warnings };
}

/**
 * 创建备份服务
 * @param {object} opts
 * @param {string} opts.userDataPath
 * @param {string} opts.appVersion
 * @param {string} opts.electronVersion
 */
function createHeavyCardBackupService({ userDataPath, appVersion = '', electronVersion = '' } = {}) {
    if (!userDataPath) throw new Error('userDataPath 必填');

    /** 列出某卡的全部可用备份（旧→新）。没有 manifest 的目录一律不算。 */
    function listBackups(cardId) {
        const root = backupRootOf(userDataPath, cardId);
        if (!fs.existsSync(root)) return [];
        let entries = [];
        try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return []; }
        const out = [];
        for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            if (ent.name.endsWith(PART_SUFFIX)) continue;   // 未完成，不暴露
            const dir = path.join(root, ent.name);
            let text = '';
            try { text = fs.readFileSync(path.join(dir, MANIFEST_NAME), 'utf8'); } catch (e) { continue; }
            const man = parseManifest(text);
            if (!man) continue;
            out.push({
                name: ent.name,
                dir,
                kind: man.kind,
                createdAt: man.createdAt,
                gen: man.gen,
                fileCount: man.fileCount,
                totalBytes: man.totalBytes,
                url: man.url
            });
        }
        out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        return out;
    }

    /**
     * 备份一张卡
     * @param {object} p
     * @param {string} p.cardId
     * @param {string} p.name
     * @param {string} p.url
     * @param {number} p.gen
     * @param {string} p.partition
     * @param {'auto'|'manual'|'pre-restore'} p.kind
     * @param {number} [p.keep]
     * @param {() => Promise<void>} [p.flush] 刷新存储（由调用方注入 session.flushStorageData）
     * @param {(info:object)=>void} [p.onProgress]
     */
    async function createBackup({ cardId, name, url, gen, partition, kind = 'auto', keep = KEEP_DEFAULT, flush = null, onProgress = null } = {}) {
        if (!cardId) return { success: false, error: 'cardId 必填' };

        // ① 刷盘（R2）：把 MemTable 落到 SSTable
        if (typeof flush === 'function') {
            try { await flush(); } catch (e) {
                return { success: false, error: `刷盘失败: ${e.message}` };
            }
        }

        const srcDir = partitionDirOf(userDataPath, cardId, gen);
        if (!fs.existsSync(srcDir)) {
            return { success: false, error: '该卡尚无存档目录（还没打开过）' };
        }

        const root = backupRootOf(userDataPath, cardId);
        fs.mkdirSync(root, { recursive: true });

        const baseName = snapshotNameOf(new Date(), kind);
        // 防止同一秒重名：追加序号
        let finalName = baseName;
        let seq = 1;
        while (fs.existsSync(path.join(root, finalName)) || fs.existsSync(path.join(root, finalName + PART_SUFFIX))) {
            finalName = `${baseName}-${seq++}`;
            if (seq > 999) return { success: false, error: '名称冲突过多' };
        }
        const partDir = path.join(root, finalName + PART_SUFFIX);   // R1：先写 .part
        const finalDir = path.join(root, finalName);

        try {
            fs.mkdirSync(partDir, { recursive: true });
            const allWarnings = [];
            let copiedTotal = 0;

            // ② 按白名单逐目录复制（缺失目录跳过 —— IndexedDB 可能不存在）
            for (const sub of STORE_DIRS) {
                const srcSub = path.join(srcDir, sub);
                if (!fs.existsSync(srcSub)) continue;   // 实测 V8：允许缺失
                const r = copyTree(srcSub, path.join(partDir, sub), {
                    onProgress: (info) => {
                        if (typeof onProgress === 'function') {
                            try { onProgress({ stage: 'copy', dir: sub, ...info }); } catch (e) { /* 忽略 */ }
                        }
                    }
                });
                copiedTotal += r.copied;
                allWarnings.push(...r.warnings);
            }

            // ③ 统计体积
            const stat = statTree(partDir);

            // ④ manifest **最后写**（R1：这是"可用"的唯一标志）
            const manifest = buildManifest({
                cardId, name, url, gen, partition, kind,
                createdAt: new Date().toISOString(),
                appVersion, electronVersion,
                files: [],
                totalBytes: stat.bytes,
                warnings: allWarnings
            });
            manifest.fileCount = stat.files;
            fs.writeFileSync(path.join(partDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');

            // ⑤ 原子改名
            fs.renameSync(partDir, finalDir);

            // ⑥ 保留策略
            const removed = rotate(cardId, keep);

            return {
                success: true,
                name: finalName,
                dir: finalDir,
                fileCount: stat.files,
                totalBytes: stat.bytes,
                copied: copiedTotal,
                warnings: allWarnings,
                removed: removed.map((x) => x.name)
            };
        } catch (e) {
            // 失败清理：删掉 .part，绝不留半成品
            try { fs.rmSync(partDir, { recursive: true, force: true }); } catch (err) { /* 忽略 */ }
            return { success: false, error: e.message };
        }
    }

    /** 执行保留策略，返回被删条目 */
    function rotate(cardId, keep) {
        const list = listBackups(cardId);
        const victims = pickRotateVictims(list, keep);
        for (const v of victims) {
            try { fs.rmSync(v.dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
        }
        return victims;
    }

    /**
     * 恢复到某份备份（世代轮换，免重启）
     * ⚠️ R3：**不在这里调 session.fromPartition** —— 本函数只做文件操作，
     *    调用方拿到 nextPartition 后再创建 WebContentsView。
     * @returns {{success:boolean, nextGen:number, nextPartition:string, targetDir:string, error?:string}}
     */
    function restoreGeneration({ cardId, currentGen, backupName } = {}) {
        const list = listBackups(cardId);
        const target = list.find((b) => b.name === backupName);
        if (!target) return { success: false, error: '备份不存在或已损坏' };

        const nextGen = Math.max(1, Math.round(Number(currentGen) || 1)) + 1;
        const targetDir = partitionDirOf(userDataPath, cardId, nextGen);
        const nextPartition = `persist:heavycard-${cardId}_g${nextGen}`;

        // 若目标世代目录已存在（异常残留），跳到下一个
        let gen = nextGen;
        let dir = targetDir;
        let guard = 0;
        while (fs.existsSync(dir) && guard < 5) {
            gen++;
            dir = partitionDirOf(userDataPath, cardId, gen);
            guard++;
        }
        if (fs.existsSync(dir)) return { success: false, error: '无法找到空闲的世代目录' };

        try {
            fs.mkdirSync(dir, { recursive: true });
            // 纯文件复制：此刻 Chromium 100% 没碰过该目录
            for (const sub of STORE_DIRS) {
                const srcSub = path.join(target.dir, sub);
                if (!fs.existsSync(srcSub)) continue;
                copyTree(srcSub, path.join(dir, sub));
            }
            return {
                success: true,
                nextGen: gen,
                nextPartition: `persist:heavycard-${cardId}_g${gen}`,
                targetDir: dir,
                from: target.name
            };
        } catch (e) {
            // 失败：清掉刚建的目录，避免留下半个世代
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* 忽略 */ }
            return { success: false, error: e.message };
        }
    }

    /** 删除一份备份 */
    function deleteBackup(cardId, backupName) {
        const list = listBackups(cardId);
        const target = list.find((b) => b.name === backupName);
        if (!target) return { success: false, error: '备份不存在' };
        try {
            fs.rmSync(target.dir, { recursive: true, force: true });
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    /**
     * 启动期清理（保守策略）
     *   · 删除：残留的 `*.part` 目录（R1 的垃圾）
     *   · 删除：各卡 `gN` 与 `gN-1` 之外的旧世代目录
     * @param {Array<{id:string, gen:number}>} cards 当前清单
     * @returns {{removedParts:string[], removedGens:string[]}}
     */
    function cleanupOnStartup(cards = []) {
        const removedParts = [];
        const removedGens = [];

        // ① 清 .part
        const backupRoot = path.join(userDataPath, BACKUP_ROOT_NAME);
        if (fs.existsSync(backupRoot)) {
            for (const cardEnt of fs.readdirSync(backupRoot, { withFileTypes: true })) {
                if (!cardEnt.isDirectory()) continue;
                const cardRoot = path.join(backupRoot, cardEnt.name);
                let entries = [];
                try { entries = fs.readdirSync(cardRoot, { withFileTypes: true }); } catch (e) { continue; }
                for (const ent of entries) {
                    if (ent.isDirectory() && ent.name.endsWith(PART_SUFFIX)) {
                        const full = path.join(cardRoot, ent.name);
                        try { fs.rmSync(full, { recursive: true, force: true }); removedParts.push(full); } catch (e) { /* 忽略 */ }
                    }
                }
            }
        }

        // ② 清旧世代（保留 gN 与 gN-1）
        const partRoot = path.join(userDataPath, 'Partitions');
        if (fs.existsSync(partRoot)) {
            const keepSet = new Set();
            for (const c of (Array.isArray(cards) ? cards : [])) {
                const id = String(c && c.id || '');
                const gen = Math.max(1, Math.round(Number(c && c.gen) || 1));
                if (!id) continue;
                keepSet.add(`heavycard-${id}_g${gen}`);
                if (gen > 1) keepSet.add(`heavycard-${id}_g${gen - 1}`);
            }
            let entries = [];
            try { entries = fs.readdirSync(partRoot, { withFileTypes: true }); } catch (e) { entries = []; }
            for (const ent of entries) {
                if (!ent.isDirectory()) continue;
                if (!/^heavycard-.+_g\d+$/.test(ent.name)) continue;   // 不是我们的目录
                if (keepSet.has(ent.name)) continue;
                const full = path.join(partRoot, ent.name);
                try { fs.rmSync(full, { recursive: true, force: true }); removedGens.push(full); } catch (e) { /* 忽略 */ }
            }
        }

        return { removedParts, removedGens };
    }

    /**
     * 导出为单文件 tar（跨机迁移用）
     * @param {object} p
     * @param {string} p.cardId
     * @param {string} p.backupName 快照目录名（不传则用最新一份）
     * @param {string} p.outFile 目标文件绝对路径（.tar）
     */
    function exportBundle({ cardId, backupName, outFile } = {}) {
        if (!cardId || !outFile) return { success: false, error: '参数不完整' };
        const list = listBackups(cardId);
        const snap = backupName
            ? list.find((b) => b.name === backupName)
            : list[list.length - 1];
        if (!snap) return { success: false, error: '没有可用备份' };

        try {
            const files = walkFiles(snap.dir);
            // 必须含 manifest（否则导入侧不认）
            if (!files.some((f) => f.rel === MANIFEST_NAME)) {
                return { success: false, error: '备份缺少 manifest，无法导出' };
            }
            const fd = fs.openSync(outFile, 'w');
            try {
                const mtime = Math.floor(new Date(snap.createdAt).getTime() / 1000) || Math.floor(Date.now() / 1000);
                for (const f of files) {
                    const data = fs.readFileSync(f.abs);
                    fs.writeSync(fd, buildTarHeader(toTarName(f.rel), data.length, mtime));
                    fs.writeSync(fd, data);
                    const pad = (512 - (data.length % 512)) % 512;
                    if (pad) fs.writeSync(fd, Buffer.alloc(pad, 0));
                }
                fs.writeSync(fd, Buffer.alloc(1024, 0));   // 结束块
            } finally {
                fs.closeSync(fd);
            }
            const size = fs.statSync(outFile).size;
            return { success: true, outFile, from: snap.name, fileCount: files.length, totalBytes: size };
        } catch (e) {
            try { fs.rmSync(outFile, { force: true }); } catch (err) { /* 忽略 */ }
            return { success: false, error: e.message };
        }
    }

    /**
     * 从 tar 导入为一份新快照（跨机迁移的接收端）
     * ⚠️ 只写 `heavycard-backups/<cardId>/` 下，不碰 partition 目录 ——
     *    导入后用户需再点「恢复」才会真正生效，这给了二次确认的机会。
     */
    function importBundle({ cardId, inFile } = {}) {
        if (!cardId || !inFile) return { success: false, error: '参数不完整' };
        let entries = [];
        try {
            entries = readTarEntries(fs.readFileSync(inFile));
        } catch (e) {
            return { success: false, error: `读取失败: ${e.message}` };
        }
        const manifestEntry = entries.find((e) => e.name === MANIFEST_NAME);
        if (!manifestEntry) return { success: false, error: '不是有效的重型卡备份包（缺少 manifest）' };
        const man = parseManifest(manifestEntry.data.toString('utf8'));
        if (!man) return { success: false, error: 'manifest 损坏' };

        const root = backupRootOf(userDataPath, cardId);
        fs.mkdirSync(root, { recursive: true });
        const baseName = `${snapshotNameOf(new Date(), 'manual')}-import`;
        let finalName = baseName;
        let seq = 1;
        while (fs.existsSync(path.join(root, finalName))) finalName = `${baseName}-${seq++}`;
        const partDir = path.join(root, finalName + PART_SUFFIX);
        const finalDir = path.join(root, finalName);

        try {
            fs.mkdirSync(partDir, { recursive: true });
            let written = 0;
            for (const ent of entries) {
                // 防路径穿越：禁止 .. 与绝对路径
                const clean = toTarName(ent.name);
                if (!clean || clean.split('/').includes('..')) continue;
                const dest = path.join(partDir, clean);
                if (!dest.startsWith(partDir)) continue;
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, ent.data);
                written++;
            }
            if (written === 0) {
                fs.rmSync(partDir, { recursive: true, force: true });
                return { success: false, error: '包内没有可用文件' };
            }
            fs.renameSync(partDir, finalDir);
            return { success: true, name: finalName, fileCount: written, from: man.name || '' };
        } catch (e) {
            try { fs.rmSync(partDir, { recursive: true, force: true }); } catch (err) { /* 忽略 */ }
            return { success: false, error: e.message };
        }
    }

    return {
        listBackups,
        createBackup,
        rotate,
        restoreGeneration,
        deleteBackup,
        cleanupOnStartup,
        exportBundle,
        importBundle,
        backupRootOf: (cardId) => backupRootOf(userDataPath, cardId)
    };
}

// ─────────────────────────── tar 辅助（纯函数，可单测） ───────────────────────────

/** tar 头构造 */
function buildTarHeader(name, size, mtimeSec) {
    const buf = Buffer.alloc(512, 0);
    const write = (str, offset, len) => {
        const b = Buffer.from(String(str), 'utf8');
        b.copy(buf, offset, 0, Math.min(b.length, len));
    };
    const writeOctal = (num, offset, len) => {
        const s = Math.max(0, Math.floor(Number(num) || 0)).toString(8).padStart(len - 1, '0').slice(-(len - 1));
        write(s, offset, len - 1);
    };

    let n = String(name || '').replace(/\\/g, '/');
    let prefix = '';
    if (Buffer.byteLength(n, 'utf8') > 100) {
        const parts = n.split('/');
        while (parts.length > 1 && Buffer.byteLength(parts.join('/'), 'utf8') > 100) {
            prefix = parts.pop() + (prefix ? '/' + prefix : '');
        }
        n = parts.join('/');
        if (Buffer.byteLength(prefix, 'utf8') > 155) prefix = '';
    }
    write(n, 0, 100);
    writeOctal(0o644, 100, 8);
    writeOctal(0, 108, 8);
    writeOctal(0, 116, 8);
    writeOctal(size, 124, 12);
    writeOctal(mtimeSec, 136, 12);
    write('        ', 148, 8);
    write('0', 156, 1);
    write('ustar', 257, 6);
    write('00', 263, 2);
    if (prefix) write(prefix, 345, 155);

    let sum = 0;
    for (let i = 0; i < 512; i++) sum += buf[i];
    write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    return buf;
}

/** 路径 → tar 内相对名 */
function toTarName(rel) {
    return String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

/** 递归列出目录下所有文件 */
function walkFiles(rootDir, relPrefix = '') {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch (e) { return out; }
    for (const ent of entries) {
        const abs = path.join(rootDir, ent.name);
        const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
        if (ent.isDirectory()) out.push(...walkFiles(abs, rel));
        else if (ent.isFile()) out.push({ abs, rel });
    }
    return out;
}

/** 解析 tar */
function readTarEntries(buf) {
    const entries = [];
    let off = 0;
    const readOctal = (b, start, len) => {
        const s = b.slice(start, start + len).toString('utf8').replace(/\0/g, ' ').trim();
        return s ? parseInt(s, 8) : 0;
    };
    const readStr = (b, start, len) => b.slice(start, start + len).toString('utf8').replace(/\0.*$/, '');
    while (off + 512 <= buf.length) {
        const head = buf.slice(off, off + 512);
        if (head.every((x) => x === 0)) break;
        const name = readStr(head, 0, 100);
        const prefix = readStr(head, 345, 155);
        const size = readOctal(head, 124, 12);
        const full = prefix ? `${prefix}/${name}` : name;
        off += 512;
        entries.push({ name: full, size, data: buf.slice(off, off + size) });
        off += Math.ceil(size / 512) * 512;
    }
    return entries;
}

module.exports = {
    createHeavyCardBackupService,
    // 纯函数（单测直接调用）
    normalizeKeep,
    normalizeKind,
    stampOf,
    snapshotNameOf,
    partitionDirOf,
    backupRootOf,
    shouldCopyFile,
    pickRotateVictims,
    buildManifest,
    parseManifest,
    formatBytes,
    statTree,
    copyTree,
    buildTarHeader,
    readTarEntries,
    walkFiles,
    toTarName,
    // 常量
    BACKUP_ROOT_NAME,
    MANIFEST_NAME,
    PART_SUFFIX,
    STORE_DIRS,
    KINDS
};
