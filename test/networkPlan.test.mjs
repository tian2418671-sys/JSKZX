/**
 * 🌐 网络探测决策层（纯函数）单测 —— 「先测网络再选地址」
 * 背景（2026-11-16 实测本机）：直连 codeload 2836ms / ghfast.top 超时 / gh-proxy.com 1094ms；
 * npm 官方 1723ms / 国内镜像 448ms。固定顺序会让用户白等超时。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GOOD_MS, pickDownloadOrder, pickNpmRegistry, describeDecision } = require('../main/networkPlan.js');

const probe = (key, kind, ok, ms, label = key, priority = 0) => ({ key, kind, ok, ms, label, priority, url: `https://x/${key}` });

const P = () => [
    probe('github-direct', 'download', true, 2836, 'GitHub 直连', 10),
    probe('m-ghfast', 'download', false, 5000, 'ghfast.top'),
    probe('m-ghproxy', 'download', true, 1094, 'gh-proxy.com'),
    probe('npm-official', 'registry', true, 1723, 'npm 官方', 10),
    probe('npm-mirror', 'registry', true, 448, 'npm 国内镜像'),
];

test('下载顺序：只保留可用项，按耗时升序（最快在前）', () => {
    const order = pickDownloadOrder(P());
    assert.deepEqual(order.map((p) => p.key), ['m-ghproxy', 'github-direct']);
});

test('下载顺序：直连可用且最快时优先直连；同耗时按 priority 直连优先', () => {
    const fast = [
        probe('github-direct', 'download', true, 200, 'GitHub 直连', 10),
        probe('m-ghproxy', 'download', true, 900, 'gh-proxy.com'),
    ];
    assert.deepEqual(pickDownloadOrder(fast).map((p) => p.key), ['github-direct', 'm-ghproxy']);

    const tie = [
        probe('m-ghproxy', 'download', true, 500, 'gh-proxy.com'),
        probe('github-direct', 'download', true, 500, 'GitHub 直连', 10),
    ];
    assert.deepEqual(pickDownloadOrder(tie).map((p) => p.key), ['github-direct', 'm-ghproxy']);
});

test('下载顺序：全不可用 ⇒ 空数组（调用方据此直接报「网络不可用」而不是白等）', () => {
    const allDead = [
        probe('github-direct', 'download', false, 0, 'GitHub 直连', 10),
        probe('m-ghproxy', 'download', false, 0, 'gh-proxy.com'),
    ];
    assert.deepEqual(pickDownloadOrder(allDead), []);
    assert.deepEqual(pickDownloadOrder(null), []);
});

test('registry 选择：谁快选谁（本机实测镜像 448 < 官方 1723 ⇒ 国内镜像）', () => {
    const r = pickNpmRegistry(P());
    assert.equal(r.key, 'npm-mirror');
    assert.equal(r.url, 'https://registry.npmmirror.com'); // 基地址，不是探针 URL
    assert.match(r.reason, /国内镜像更快/);
});

test('registry 选择：官方可用且更快 ⇒ 官方源', () => {
    const probes = [
        probe('npm-official', 'registry', true, 300, 'npm 官方', 10),
        probe('npm-mirror', 'registry', true, 900, 'npm 国内镜像'),
    ];
    const r = pickNpmRegistry(probes);
    assert.equal(r.key, 'npm-official');
    assert.match(r.reason, /官方源可用/);
});

test('registry 选择：镜像不可用 ⇒ 官方兜底；两个都挂 ⇒ 仍回退官方并说明', () => {
    const onlyOfficial = [
        probe('npm-official', 'registry', true, 4000, 'npm 官方', 10),
        probe('npm-mirror', 'registry', false, 0, 'npm 国内镜像'),
    ];
    assert.equal(pickNpmRegistry(onlyOfficial).key, 'npm-official');

    const bothDead = [
        probe('npm-official', 'registry', false, 0, 'npm 官方', 10),
        probe('npm-mirror', 'registry', false, 0, 'npm 国内镜像'),
    ];
    const r = pickNpmRegistry(bothDead);
    assert.equal(r.key, 'npm-official');
    assert.match(r.reason, /都探测失败/);
});

test('describeDecision：一行结论包含选中的下载源与 npm 源', () => {
    const probes = P();
    const text = describeDecision(probes, { order: pickDownloadOrder(probes), registry: pickNpmRegistry(probes) });
    assert.match(text, /下载：gh-proxy\.com（最快）/);
    assert.match(text, /npm：国内镜像/);
    assert.match(text, /ghfast\.top 不可用/);
});

test('registry 选择：返回的必须是**基地址**而不是探针的 /-/ping 地址（否则 npm 会 404）', () => {
    const probes = [
        { key: 'npm-official', kind: 'registry', ok: true, ms: 900, priority: 10, url: 'https://registry.npmjs.org/-/ping' },
        { key: 'npm-mirror', kind: 'registry', ok: true, ms: 200, url: 'https://registry.npmmirror.com/-/ping' },
    ];
    const r = pickNpmRegistry(probes);
    assert.equal(r.url, 'https://registry.npmmirror.com');
    assert.ok(!r.url.includes('/-/ping'), '不能把 ping 地址当 registry');

    const off = pickNpmRegistry([{ key: 'npm-official', kind: 'registry', ok: true, ms: 300, priority: 10, url: 'https://registry.npmjs.org/-/ping' }]);
    assert.equal(off.url, 'https://registry.npmjs.org');

    // 显式给了 registryUrl 时优先用它
    const explicit = pickNpmRegistry([{ key: 'npm-mirror', kind: 'registry', ok: true, ms: 100, url: 'https://x/-/ping', registryUrl: 'https://x' }]);
    assert.equal(explicit.url, 'https://x');
});

test('GOOD_MS 常量存在且合理', () => {
    assert.equal(typeof GOOD_MS, 'number');
    assert.ok(GOOD_MS > 300 && GOOD_MS < 5000);
});
