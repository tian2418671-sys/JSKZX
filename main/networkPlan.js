/**
 * 🌐 网络探测的**决策层**（纯函数，可单测）—— 决定下载走直连还是镜像、npm 走官方还是国内镜像
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要：`GH_MIRRORS` 原来是**固定顺序**（直连 → ghfast → gh-proxy）blindly 依次尝试。
 * 实测（2026-11-16）：直连 codeload 2836ms、`ghfast.top` **5 秒超时**、`gh-proxy.com` 1094ms；
 * 而 `registry.npmjs.org` 1723ms、`registry.npmmirror.com` 448ms。
 * ⇒ 固定顺序会让用户先白等一次超时，而且 npm 侧完全不感知快慢。
 *
 * 本模块只做「探针结果 → 决策」，**不联网**（联网在 stManager 的 probeUrl）。
 *
 * 探针结构：{ key, label, kind: 'download'|'registry', ok, ms, status }
 *   · kind 'download'：直连与各镜像（可直接当下载地址前缀用）
 *   · kind 'registry'：npm 官方 / 国内镜像
 */

/** 判断是否「够快」：官方源在 1500ms 内视为直连良好（否则优先国内镜像，体验更稳） */
const GOOD_MS = 1500;

/**
 * npm registry 的**基地址**（注意：探针用 `/-/ping`，但 `--registry` 必须传基地址，
 * 传成 ping 地址会让 npm 把包解析成 `<base>/<pkg>/-/<pkg>.tgz` → 404，实测踩过）。
 */
const NPM_REGISTRY_BASE = Object.freeze({
    'npm-official': 'https://registry.npmjs.org',
    'npm-mirror': 'https://registry.npmmirror.com',
});

/**
 * 下载顺序：只保留可用项，按实测耗时升序（最快的排第一）。
 * 同一耗时按 `priority`（直连优先）再按 key 字典序，保证结果确定、可测。
 * @param {Array} probes
 * @returns {Array} 探针数组（已排序，只含 ok 的 download 项）
 */
function pickDownloadOrder(probes) {
    const list = (Array.isArray(probes) ? probes : [])
        .filter((p) => p && p.kind === 'download' && p.ok);
    return list.slice().sort((a, b) => (a.ms - b.ms)
        || ((b.priority || 0) - (a.priority || 0)) // priority 越大越优先（直连给 10）
        || String(a.key).localeCompare(String(b.key)));
}

/**
 * npm registry 选择：**可用且最快**；同耗时优先官方；都不可用 → 官方（交给 npm 自己报错）。
 * @param {Array} probes
 * @returns {{url:string, key:string, reason:string}} `url` 是**基地址**（可直接给 `--registry`）
 */
function pickNpmRegistry(probes) {
    const list = (Array.isArray(probes) ? probes : [])
        .filter((p) => p && p.kind === 'registry' && p.ok);
    const baseOf = (p) => p.registryUrl || NPM_REGISTRY_BASE[p.key] || NPM_REGISTRY_BASE['npm-official'];
    if (!list.length) {
        return { url: NPM_REGISTRY_BASE['npm-official'], key: 'npm-official', reason: '两个 registry 都探测失败，回退官方源（npm 会自行报错）' };
    }
    const sorted = list.slice().sort((a, b) => (a.ms - b.ms) || ((b.priority || 0) - (a.priority || 0)));
    const best = sorted[0];
    const reason = best.key === 'npm-mirror'
        ? `国内镜像更快（${best.ms}ms）`
        : `官方源可用（${best.ms}ms），${best.ms <= GOOD_MS ? '速度良好' : '偏慢但直连成功'}`;
    return { url: baseOf(best), key: best.key, reason };
}

/**
 * 生成给用户看的一行结论。
 * @param {Array} probes
 * @param {{order:Array, registry:object}} decision
 * @returns {string}
 */
function describeDecision(probes, decision) {
    const fmt = (p) => `${p.label} ${p.ok ? p.ms + 'ms' : '不可用'}`;
    const all = (Array.isArray(probes) ? probes : []).map(fmt).join('｜');
    const order = (decision && decision.order) || [];
    const reg = decision && decision.registry;
    const dl = order.length ? `下载：${order[0].label}（最快）` : '下载：无可用源';
    const npm = reg ? `npm：${reg.key === 'npm-mirror' ? '国内镜像' : '官方源'}` : '';
    return `${dl}｜${npm}｜探测结果 ${all}`;
}

module.exports = { GOOD_MS, NPM_REGISTRY_BASE, pickDownloadOrder, pickNpmRegistry, describeDecision };
