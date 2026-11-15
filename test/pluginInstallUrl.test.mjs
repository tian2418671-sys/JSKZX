/**
 * 插件「链接安装」URL 解析门禁
 *
 * 覆盖真实场景：酒馆插件的标准安装方式是粘贴 GitHub 仓库地址，
 * 例如 https://github.com/anyKami/AutoRandomInput 。
 * 解析错了会导致「下载不到东西」或「装成了别的东西」，所以逐类锁死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInstallUrl, gitHubZipUrl, pickPluginRoot } from '../js/utils/pluginInstallUrl.js';

test('识别 GitHub 仓库主页（最常见形态）', () => {
    const r = parseInstallUrl('https://github.com/anyKami/AutoRandomInput');
    assert.equal(r.kind, 'github-repo');
    assert.equal(r.owner, 'anyKami');
    assert.equal(r.repo, 'AutoRandomInput');
    assert.equal(r.branch, '');
    assert.equal(r.subdir, '');
    assert.equal(r.displayName, 'AutoRandomInput');
});

test('识别带 .git 后缀与尾部斜杠的仓库地址', () => {
    const r1 = parseInstallUrl('https://github.com/o/r.git');
    assert.equal(r1.kind, 'github-repo');
    assert.equal(r1.repo, 'r');

    const r2 = parseInstallUrl('https://github.com/o/r/');
    assert.equal(r2.kind, 'github-repo');
    assert.equal(r2.repo, 'r');
});

test('识别 www.github.com 与 http（非 https）', () => {
    assert.equal(parseInstallUrl('https://www.github.com/o/r').repo, 'r');
    const r = parseInstallUrl('http://github.com/o/r');
    assert.equal(r.kind, 'github-repo');
});

test('识别 /tree/<branch> 并提取分支', () => {
    const r = parseInstallUrl('https://github.com/o/r/tree/dev');
    assert.equal(r.kind, 'github-repo');
    assert.equal(r.branch, 'dev');
    assert.equal(r.subdir, '');
});

test('识别 /tree/<branch>/<子目录>：整串按分支名处理（与官方 git clone 行为一致）', () => {
    // GitHub 页面无法区分「分支 main/extensions/myext」与「分支 main 下的子目录」；
    // 官方 install 接口直接把 branch 交给 git clone，因此这里同样整串保留，
    // 由下载端在失败时回退默认分支。
    const r = parseInstallUrl('https://github.com/o/r/tree/main/extensions/myext');
    assert.equal(r.branch, 'main/extensions/myext');
});

test('分支名含斜杠时完整保留（如 feature/x）', () => {
    const r = parseInstallUrl('https://github.com/o/r/tree/feature/x');
    assert.equal(r.branch, 'feature/x');
});

test('支持 ?branch= 查询参数（对齐官方 install 接口）', () => {
    const r = parseInstallUrl('https://github.com/o/r?branch=dev');
    assert.equal(r.kind, 'github-repo');
    assert.equal(r.branch, 'dev');
});

test('支持 ?ref= 查询参数', () => {
    const r = parseInstallUrl('https://github.com/o/r?ref=dev');
    assert.equal(r.branch, 'dev');
});

test('拒绝 github.com 的功能页（不是仓库）', () => {
    for (const bad of [
        'https://github.com/settings/profile',
        'https://github.com/marketplace/actions',
        'https://github.com/explore',
    ]) {
        assert.equal(parseInstallUrl(bad).kind, 'unknown', `应拒绝 ${bad}`);
    }
});

test('识别 codeload zip 直链并还原分支', () => {
    const r = parseInstallUrl('https://codeload.github.com/o/r/zip/refs/heads/main');
    assert.equal(r.kind, 'github-repo');
    assert.equal(r.owner, 'o');
    assert.equal(r.repo, 'r');
    assert.equal(r.branch, 'main');
});

test('识别普通 zip 直链', () => {
    const r = parseInstallUrl('https://example.com/files/my-plugin.zip');
    assert.equal(r.kind, 'zip');
    assert.equal(r.fileName, 'my-plugin.zip');
    assert.equal(r.displayName, 'my-plugin');
});

test('zip 直链带 query 时仍能取到正确文件名', () => {
    const r = parseInstallUrl('https://example.com/a/b/plugin.zip?token=abc&x=1');
    assert.equal(r.kind, 'zip');
    assert.equal(r.fileName, 'plugin.zip');
});

test('识别单个 .json / .js 插件文件', () => {
    assert.equal(parseInstallUrl('https://ex.com/p/script.json').kind, 'single-file');
    assert.equal(parseInstallUrl('https://ex.com/p/script.js').kind, 'single-file');
    assert.equal(parseInstallUrl('https://ex.com/p/script.mjs').kind, 'single-file');
});

test('raw.githubusercontent 上的单文件也能识别', () => {
    const r = parseInstallUrl('https://raw.githubusercontent.com/o/r/main/script.json');
    assert.equal(r.kind, 'single-file');
    assert.equal(r.fileName, 'script.json');
});

test('拒绝非 http(s) 协议（安全）', () => {
    for (const bad of ['file:///C:/x.zip', 'javascript:alert(1)', 'ftp://x/y.zip', 'data:text/html,hi']) {
        const r = parseInstallUrl(bad);
        assert.equal(r.kind, 'unknown', `应拒绝 ${bad}`);
    }
});

test('空链接与无法识别的链接给出明确原因', () => {
    const empty = parseInstallUrl('');
    assert.equal(empty.kind, 'unknown');
    assert.ok(empty.reason);

    const weird = parseInstallUrl('https://github.com/o');
    // 只有 owner 没有 repo ⇒ 不是有效仓库
    assert.equal(weird.kind, 'unknown');
    assert.ok(weird.reason);
});

test('gitHubZipUrl: 无分支时用 HEAD', () => {
    assert.equal(
        gitHubZipUrl('o', 'r', ''),
        'https://codeload.github.com/o/r/zip/HEAD',
    );
});

test('gitHubZipUrl: 指定分支时走 refs/heads', () => {
    assert.equal(
        gitHubZipUrl('o', 'r', 'dev'),
        'https://codeload.github.com/o/r/zip/refs/heads/dev',
    );
});

test('gitHubZipUrl: 中文分支名需要编码', () => {
    const u = gitHubZipUrl('o', 'r', '开发');
    assert.ok(u.includes(encodeURIComponent('开发')), '中文分支应被 encodeURIComponent');
});

test('gitHubZipUrl: 去掉 .git 后缀', () => {
    assert.equal(
        gitHubZipUrl('o', 'r.git', 'main'),
        'https://codeload.github.com/o/r/zip/refs/heads/main',
    );
});

test('pickPluginRoot: 顶层就有 manifest.json ⇒ 当前目录即插件根', () => {
    const entries = [
        { name: 'manifest.json', type: 'file' },
        { name: 'index.js', type: 'file' },
    ];
    assert.equal(pickPluginRoot(entries), '');
});

test('pickPluginRoot: 顶层只有一层包裹目录 ⇒ 进入该目录', () => {
    const entries = [
        { name: 'AutoRandomInput-main', type: 'dir' },
    ];
    assert.equal(pickPluginRoot(entries), 'AutoRandomInput-main');
});

test('pickPluginRoot: 包裹目录 + 无关 README ⇒ 仍进入该目录', () => {
    const entries = [
        { name: 'repo-main', type: 'dir' },
        { name: 'README.md', type: 'file' },
        { name: '.DS_Store', type: 'file' },
    ];
    assert.equal(pickPluginRoot(entries), 'repo-main');
});

test('pickPluginRoot: 顶层 index.js + style.css（无 manifest 的扩展）也认作插件根', () => {
    const entries = [
        { name: 'index.js', type: 'file' },
        { name: 'style.css', type: 'file' },
    ];
    assert.equal(pickPluginRoot(entries), '');
});

test('pickPluginRoot: 空输入返回空字符串（不抛异常）', () => {
    assert.equal(pickPluginRoot([]), '');
    assert.equal(pickPluginRoot(null), '');
});
