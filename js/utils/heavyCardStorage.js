/**
 * 💾 重型卡存档管家 · 纯函数（C1~C4）
 *
 * 设计原则（上游裁决 Q6/Q7 · v3 红线「只碰壳不碰芯」）：
 *   · **只处理 manifest 元数据**，不读 leveldb 内容、不解析卡数据、不注 AI；
 *   · **零主进程改动**：全部数据来自既有的 `heavycard:listBackups` / `heavycard:storageInfo`；
 *   · 纯函数 = 可单测、可预览，不碰 fs / window。
 *
 * 四块能力：
 *   C1 `groupBackupsByDay`      存档时间线（按天折叠）
 *   C2 `computeStorageRanking`  空间占用榜
 *   C3 `compareOrigins`         换址沿用判定（**含 Origin 校验**，上游架构级加固）
 *   C4 `describePlayStats` / `sortByRecentPlay`  今日游玩推荐
 *
 * ⚠️ C3 的 Origin 陷阱（实测踩过）：
 *   `new URL('file:///E:/a').origin === 'null'`（**字符串**），
 *   两个不同的本地路径会**都得到 `'null'`** ⇒ 若直接比对会误判同源。
 *   本模块对 `origin === 'null'` / 解析失败 一律归为「无法判定」，走保守分支。
 *
 * 规格：`docs/规格与计划/功能规格/C1-C4-重型卡存档管家-实现规格.md`
 */

/** 解析 URL 的 origin；失败或 `file://` 返回 null（表示「无法用于同源判定」） */
export function safeOrigin(url) {
    const s = String(url == null ? '' : url).trim();
    if (!s) return null;
    try {
        const u = new URL(s);
        const o = u.origin;
        // file:// 的 origin 是字符串 'null'，对同源判定无意义
        if (!o || o === 'null' || o === 'file://') return null;
        return o;
    } catch (e) {
        return null;
    }
}

/** 是否为本地文件协议（`file://` 或本项目的 `heavycard-local://`） */
export function isFileUrl(url) {
    const s = String(url == null ? '' : url).trim();
    // ⚠️ 真实缺陷修复：原先只认 `file://`，而重型卡的「本地目录模式」走的是
    //    **`heavycard-local://<cardId>/index.html`**（见 useHeavyCards 的 effective URL）。
    //    漏掉它 ⇒ 本地卡换目录时被判成 `unknown`（「地址无法解析」），
    //    而不是 `local`（「本地文件夹路径已变更」）——文案误导用户。
    return /^(file|heavycard-local):\/\//i.test(s);
}

/**
 * C3：比较两个 URL 是否可沿用旧存档
 * @returns {{verdict:'same'|'cross'|'local'|'unknown', oldOrigin:string|null, newOrigin:string|null, message:string}}
 *   same    → 同源，可安全沿用
 *   cross   → 跨源（域名/协议/端口不同），LevelDB 可能读不出，需警告
 *   local   → 本地文件夹卡（origin 无意义），文案要区别于「跨域名」
 *   unknown → 至少一侧解析失败，保守处理
 */
export function compareOrigins(oldUrl, newUrl) {
    const oldOrigin = safeOrigin(oldUrl);
    const newOrigin = safeOrigin(newUrl);
    const bothFile = isFileUrl(oldUrl) && isFileUrl(newUrl);
    const anyFile = isFileUrl(oldUrl) || isFileUrl(newUrl);

    // 至少一侧是本地文件 ⇒ 单独一类（文案不同）
    if (bothFile) {
        return {
            verdict: 'local', oldOrigin: null, newOrigin: null,
            message: '本地文件夹路径已变更，是否尝试沿用旧存档？'
        };
    }
    if (anyFile) {
        return {
            verdict: 'unknown', oldOrigin, newOrigin,
            message: '新旧地址一个是本地文件夹、一个是网址，无法判断能否沿用，请手动确认'
        };
    }
    if (!oldOrigin || !newOrigin) {
        return {
            verdict: 'unknown', oldOrigin, newOrigin,
            message: '地址无法解析，为避免读不出存档，请手动确认是否沿用'
        };
    }
    if (oldOrigin === newOrigin) {
        return {
            verdict: 'same', oldOrigin, newOrigin,
            message: '网址路径已变化（同域名），存档可继续使用'
        };
    }
    return {
        verdict: 'cross', oldOrigin, newOrigin,
        message: `跨域名/端口换址（${oldOrigin} → ${newOrigin}），浏览器内部存储可能无法读取，建议谨慎`
    };
}

/**
 * C1：按天折叠的存档时间线
 * @param {Array<{createdAt:string, kind?:string, gen?:number, fileCount?:number, totalBytes?:number, name?:string}>} backups
 * @param {object} [opts] { expandDays = 3, now = Date.now() }
 * @returns {{ days: Array<{key:string, label:string, dateLabel:string, items:Array, totalBytes:number, expanded:boolean}>, total:number, totalBytes:number }}
 */
export function groupBackupsByDay(backups, opts = {}) {
    const list = Array.isArray(backups) ? backups : [];
    const expandDays = Math.max(0, Number(opts.expandDays) || 0) || 3;
    const now = Number(opts.now) || Date.now();

    const map = new Map();
    let totalBytes = 0;

    for (const b of list) {
        if (!b) continue;
        const t = Date.parse(String(b.createdAt || ''));
        const ms = Number.isFinite(t) ? t : 0;
        const d = new Date(ms);
        const key = Number.isFinite(t)
            ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
            : 'unknown';
        let day = map.get(key);
        if (!day) { day = { key, items: [], totalBytes: 0, ms: Number.isFinite(t) ? t : 0 }; map.set(key, day); }
        const bytes = Number(b.totalBytes) || 0;
        day.items.push({
            name: String(b.name || ''),
            kind: normalizeKind(b.kind),
            gen: Math.max(1, Math.round(Number(b.gen) || 1)),
            fileCount: Math.max(0, Number(b.fileCount) || 0),
            totalBytes: bytes,
            createdAt: b.createdAt || '',
            timeLabel: Number.isFinite(t) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '—'
        });
        day.totalBytes += bytes;
        totalBytes += bytes;
    }

    // 天内按时间倒序（最新在前）
    for (const day of map.values()) {
        day.items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    }

    const days = [...map.values()]
        .sort((a, b) => (b.key.localeCompare(a.key)))     // 日期倒序
        .map((day, idx) => ({
            key: day.key,
            label: dayLabel(day.key, now),
            dateLabel: day.key,
            items: day.items,
            totalBytes: day.totalBytes,
            expanded: idx < expandDays || day.key === 'unknown'   // 默认只展开最近 N 天
        }));

    return { days, total: list.length, totalBytes };
}

/** 相对日期文案 */
function dayLabel(key, now) {
    if (key === 'unknown') return '时间未知';
    const today = new Date(now);
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const t0 = ymd(today);
    const y = new Date(now); y.setDate(y.getDate() - 1);
    if (key === t0) return '今天';
    if (key === ymd(y)) return '昨天';
    return key;
}

/** 备份类型归一（与 manifest 的 kind 对齐，未知按 auto） */
function normalizeKind(k) {
    const s = String(k == null ? '' : k).trim().toLowerCase();
    return (s === 'manual' || s === 'auto' || s === 'exit') ? s : 'auto';
}

/**
 * C2：空间占用榜
 * @param {Array} backups  listBackups 结果
 * @param {number} currentBytes  storageInfo.bytes（当前分区占用；不可用时传 null）
 * @param {object} [opts] { topN = 20 }
 */
export function computeStorageRanking(backups, currentBytes, opts = {}) {
    const list = Array.isArray(backups) ? backups : [];
    const topN = Math.max(1, Number(opts.topN) || 20);
    // ⚠️ 不能只写 `Number.isFinite(Number(x))`：`Number(null) === 0`、`Number(-10) === -10`
    //    都会通过 ⇒ 把「读不到占用」当成「占用 0」。必须先判 null/undefined，再要求非负。
    const hasCurrent = currentBytes !== null && currentBytes !== undefined
        && Number.isFinite(Number(currentBytes)) && Number(currentBytes) >= 0;

    const items = list
        .map((b) => ({
            name: String((b && b.name) || ''),
            kind: normalizeKind(b && b.kind),
            gen: Math.max(1, Math.round(Number(b && b.gen) || 1)),
            createdAt: (b && b.createdAt) || '',
            totalBytes: Math.max(0, Number(b && b.totalBytes) || 0)
        }))
        .sort((a, b) => (b.totalBytes - a.totalBytes) || String(a.name).localeCompare(String(b.name)));

    const backupBytes = items.reduce((n, x) => n + x.totalBytes, 0);
    const current = hasCurrent ? Math.max(0, Number(currentBytes)) : 0;

    return {
        items: items.slice(0, topN),
        shownCount: Math.min(items.length, topN),
        totalCount: items.length,
        backupBytes,
        currentBytes: hasCurrent ? current : null,
        grandTotal: backupBytes + current,
        // 校验等式：grandTotal === backupBytes + currentBytes（currentBytes 为 null 时不计入）
        currentUnavailable: !hasCurrent
    };
}

/**
 * C4：游玩/备份状态摘要
 * @param {object} card  重型卡条目（含 lastOpenedAt / totalPlayMs / backupStats）
 * @param {number} [now]
 */
export function describePlayStats(card, now = Date.now()) {
    const c = card || {};
    const lastOpened = Number(c.lastOpenedAt) || 0;
    const totalPlayMs = Math.max(0, Number(c.totalPlayMs) || 0);
    const stats = c.backupStats || {};
    const lastBackupAt = Number(stats.lastBackupAt) || 0;

    const DAY = 86400000;
    const daysSincePlay = lastOpened ? Math.floor((now - lastOpened) / DAY) : null;
    const daysSinceBackup = lastBackupAt ? Math.floor((now - lastBackupAt) / DAY) : null;

    let playLabel;
    if (!lastOpened) playLabel = '从未游玩';
    else if (daysSincePlay === 0) playLabel = '今天玩过';
    else if (daysSincePlay === 1) playLabel = '昨天玩过';
    else playLabel = `${daysSincePlay} 天前玩过`;

    let backupLabel;
    let backupWarn = false;
    if (!lastBackupAt) {
        backupLabel = '还没有备份';
        backupWarn = true;
    } else if (daysSinceBackup === 0) {
        backupLabel = '今天已备份';
    } else {
        backupLabel = `已 ${daysSinceBackup} 天未备份`;
        backupWarn = daysSinceBackup >= 3;   // 上游 D-C4：这是存档管家最核心的价值信号
    }

    return {
        lastOpenedAt: lastOpened,
        totalPlayMs,
        totalPlayLabel: formatDuration(totalPlayMs),
        playLabel,
        lastBackupAt,
        backupLabel,
        backupWarn,
        backupCount: Math.max(0, Number(stats.count) || 0),
        lastSize: Math.max(0, Number(stats.lastSize) || 0)
    };
}

/** C4：按最近游玩排序（前 N 张「继续游玩」） */
export function sortByRecentPlay(cards, opts = {}) {
    const list = Array.isArray(cards) ? cards : [];
    const topN = Math.max(1, Number(opts.topN) || 5);
    const now = Number(opts.now) || Date.now();
    return list
        .filter((c) => c && (Number(c.lastOpenedAt) || 0) > 0)
        .sort((a, b) => (Number(b.lastOpenedAt) - Number(a.lastOpenedAt)) || String(a.name || '').localeCompare(String(b.name || '')))
        .slice(0, topN)
        .map((c) => ({ card: c, stats: describePlayStats(c, now) }));
}

/**
 * 时长格式化（毫秒 → 中文简述）
 * 0 → '0 分钟'；90_000 → '1 分钟'；45_000_000 → '12 小时 30 分'
 */
export function formatDuration(ms) {
    const n = Math.max(0, Number(ms) || 0);
    if (n < 60000) return '0 分钟';
    const totalMin = Math.floor(n / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (!h) return `${m} 分钟`;
    if (!m) return `${h} 小时`;
    return `${h} 小时 ${m} 分`;
}

/** 字节格式化（UI 复用；与 HeavyCardWorkspace 既有 formatBytes 同口径，二选一即可） */
export function formatBytes(n) {
    const v = Math.max(0, Number(n) || 0);
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(2)} MB`;
    return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
