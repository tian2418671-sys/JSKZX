/**
 * ⏯️ 断点续传（纯函数）
 *
 * 背景（2026-11-16 用户需求）：下载 36.7MB 的 zip 时如果软件被意外关闭（关窗口、崩溃、断电），
 * 下次必须**从 0 重下**——慢网下等于白等几分钟。改成保留 `.part` 文件 + HTTP Range 续传。
 *
 * 关键判断都放这里，便于单测：
 *   ① 上次的 `/source` 与 `total`（元数据）还能不能用；
 *   ② 服务器返回 206 且 `Content-Range` 的起点正好等于本地已下载字节 → 追加；
 *      返回 200 / 起点对不上 / 416 → 从头下载（镜像经常不支持 Range，必须能优雅退回）；
 *   ③ 已经下满但没来得及改名（崩溃在 rename 之前）→ 直接复用，不再联网。
 */

/** 元数据版本（结构变了就让旧 meta 失效，避免误续传） */
const META_VERSION = 1;

/** `bytes 1024-2047/36700160` → { start, end, total }；`*` 表示总量未知（total=0） */
function parseContentRange(value) {
    const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || '').trim());
    if (!m) return null;
    return {
        start: Number(m[1]),
        end: Number(m[2]),
        total: m[3] === '*' ? 0 : Number(m[3]),
    };
}

/**
 * 续传请求头：`Range: bytes=N-`，并尽量带 `If-Range` 防止「文件已变但本地还是老片段」。
 * @param {{offset:number, etag?:string, lastModified?:string}} p
 * @returns {object} 需要合并进 headers 的对象；offset<=0 时返回 {}
 */
function buildRangeHeaders({ offset = 0, etag = '', lastModified = '' } = {}) {
    const n = Number(offset);
    if (!Number.isFinite(n) || n <= 0) return {};
    const headers = { Range: `bytes=${Math.floor(n)}-` };
    if (etag) headers['If-Range'] = String(etag);
    else if (lastModified) headers['If-Range'] = String(lastModified);
    return headers;
}

/**
 * 服务器回应能不能接着写。
 * @param {{offset:number, status:number, contentRange?:string|null}} p
 * @returns {'append'|'restart'|'complete'} complete = 本地片段已满且服务端 416（范围越界）
 */
function decideResume({ offset = 0, status = 0, contentRange = null } = {}) {
    const off = Number(offset);
    if (!Number.isFinite(off) || off <= 0) return 'restart';
    const code = Number(status);
    if (code === 416) return 'complete';
    if (code !== 206) return 'restart'; // 200 = 服务器不支持 Range（或文件变了）→ 只能重下
    const cr = parseContentRange(contentRange);
    if (!cr) return 'restart';
    if (cr.start !== Math.floor(off)) return 'restart'; // 起点对不上就不敢追加，否则文件会错位
    return 'append';
}

/**
 * 校验并归一化磁盘上的元数据；损坏/版本不符一律当作没有（不冒险续传）。
 * @param {any} raw
 * @returns {{url:string,total:number,etag:string,lastModified:string,rateBps:number}|null}
 */
function normalizeMeta(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (Number(raw.version) !== META_VERSION) return null;
    const total = Number(raw.total);
    const rate = Number(raw.rateBps);
    return {
        url: typeof raw.url === 'string' ? raw.url : '',
        total: Number.isFinite(total) && total > 0 ? total : 0,
        etag: typeof raw.etag === 'string' ? raw.etag : '',
        lastModified: typeof raw.lastModified === 'string' ? raw.lastModified : '',
        // 上次这个源的实测速度（字节/秒）：决定「续传还是重下」时要用
        rateBps: Number.isFinite(rate) && rate > 0 ? Math.round(rate) : 0,
    };
}

/** 写盘用的元数据（带上版本号） */
function makeMeta({ url = '', total = 0, etag = '', lastModified = '', rateBps = 0 } = {}) {
    const t = Number(total);
    const r = Number(rateBps);
    return {
        version: META_VERSION,
        url: String(url || ''),
        total: Number.isFinite(t) && t > 0 ? Math.floor(t) : 0,
        etag: String(etag || ''),
        lastModified: String(lastModified || ''),
        rateBps: Number.isFinite(r) && r > 0 ? Math.round(r) : 0,
        savedAt: new Date().toISOString(),
    };
}

/**
 * 续传源是不是「明显比上次慢」——是的话宁可重下，也别让用户等更久。
 *
 * 实测反例（2026-11-16）：直连能跑 2.4 MB/s，而支持 Range 的镜像只有 ~70 KB/s，
 * 硬续传 33MB 花了 8 分钟，比直接重下 15 秒差得多。所以续传先跑一小段测速，
 * 低于上次速度的 70% 就放弃续传、换回原来的快源。
 *
 * @param {{resumeRateBps?:number, previousRateBps?:number, factor?:number}} p
 * @returns {boolean} true = 放弃续传，改为从头下载
 */
function shouldAbandonResume({ resumeRateBps = 0, previousRateBps = 0, factor = 0.7 } = {}) {
    const cur = Number(resumeRateBps);
    const prev = Number(previousRateBps);
    if (!Number.isFinite(cur) || cur <= 0) return false;        // 测不出速度就不下结论
    if (!Number.isFinite(prev) || prev <= 0) return false;      // 不知道上次多快，就别乱换
    const f = Number(factor) > 0 ? Number(factor) : 0.7;
    return cur < prev * f;
}

/** 本地片段是否已下满（可以跳过联网直接用） */
function isPartComplete({ partBytes = 0, total = 0 } = {}) {
    const p = Number(partBytes);
    const t = Number(total);
    return Number.isFinite(p) && Number.isFinite(t) && t > 0 && p >= t;
}

/**
 * 把「上次的源」提到候选列表最前面（续传必须优先回到同一个源）。
 * @param {string[]} candidates
 * @param {string} lastUrl
 * @returns {{list:string[], resumedSource:boolean}}
 */
function prioritizeResumeSource(candidates = [], lastUrl = '') {
    const list = (Array.isArray(candidates) ? candidates : []).filter((x) => typeof x === 'string' && x);
    const url = String(lastUrl || '');
    if (!url) return { list, resumedSource: false };
    const i = list.indexOf(url);
    if (i === 0) return { list, resumedSource: true };
    if (i > 0) return { list: [list[i], ...list.slice(0, i), ...list.slice(i + 1)], resumedSource: true };
    return { list: [url, ...list], resumedSource: false };
}

/**
 * 检查 zip 尾部是否有合法的「中央目录结束记录」（EOCD）。
 *
 * 用途：跨源续传时兜底——片段若拼错（镜像给了不同 commit / 大小凑巧相同），
 * 结构校验会失败，从而在解压前就发现问题，而不是让用户看到「解压失败」。
 *
 * @param {Buffer|Uint8Array} tail 文件尾部（建议最后 128KB）
 * @param {number} [fileSize] 整个文件大小（弱校验：中央目录不得越界）
 * @returns {{ok:boolean, entries?:number, cdOffset?:number, cdSize?:number, reason?:string}}
 */
function checkZipTail(tail, fileSize = 0) {
    const buf = Buffer.isBuffer(tail) ? tail : Buffer.from(tail || []);
    const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const idx = buf.lastIndexOf(sig);
    if (idx < 0 || idx + 22 > buf.length) return { ok: false, reason: 'no-eocd' };
    const entries = buf.readUInt16LE(idx + 10);
    const cdSize = buf.readUInt32LE(idx + 12);
    const cdOffset = buf.readUInt32LE(idx + 16);
    const total = Number(fileSize) || 0;
    if (total > 0 && cdOffset + cdSize > total) return { ok: false, reason: 'cd-out-of-range' };
    return { ok: true, entries, cdOffset, cdSize };
}

/**
 * 一次 `Range: bytes=0-0` 探测的结果是否真的支持续传（206 + 能读到总量）。
 * @param {{status:number, contentRange?:string|null}} probe
 */
function isRangeProbeOk({ status = 0, contentRange = null } = {}) {
    if (Number(status) !== 206) return false;
    const cr = parseContentRange(contentRange);
    return Boolean(cr && cr.start === 0);
}

/**
 * 挑一个能续传的源。
 *
 * 实测（2026-11-16）：GitHub 直连 codeload **不支持 Range**（永远 200 全量），
 * 但镜像 gh-proxy.com 支持（206 + Content-Range）。所以有残留片段时要挑「支持 Range」的源，
 * 并且**总量必须对得上**（同一个分支的产物大小一致；代理的 ETag 各家不同，不能拿来比对）。
 *
 * @param {Array<{url:string, ok:boolean, total:number, ms?:number}>} probes 各候选源的探测结果
 * @param {{total?:number, preferUrl?:string}} [opts]
 * @returns {string} 可续传的源（没有则空字符串）
 */
function pickResumeSource(probes = [], { total = 0, preferUrl = '' } = {}) {
    const list = (Array.isArray(probes) ? probes : []).filter((p) => p && p.ok && p.url);
    if (!list.length) return '';
    const expect = Number(total) || 0;
    // 知道总量就必须严格一致：宁可重下，也不把两个不同产物的前半截拼在一起
    const pool = expect > 0 ? list.filter((p) => Number(p.total) === expect) : list;
    if (!pool.length) return '';
    const pref = String(preferUrl || '');
    const exact = pool.find((p) => p.url === pref);
    if (exact) return exact.url;
    // 其余按探测耗时最快优先
    const sorted = [...pool].sort((a, b) => (Number(a.ms) || 0) - (Number(b.ms) || 0));
    return sorted[0].url;
}


module.exports = {
    META_VERSION,
    parseContentRange,
    buildRangeHeaders,
    decideResume,
    normalizeMeta,
    makeMeta,
    isPartComplete,
    prioritizeResumeSource,
    checkZipTail,
    isRangeProbeOk,
    pickResumeSource,
    shouldAbandonResume,
};
