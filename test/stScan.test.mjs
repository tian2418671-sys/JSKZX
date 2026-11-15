/**
 * 「自动查找本地已安装酒馆」的判定逻辑测试。
 *
 * 背景：`StInstallModal` 的「🔍 自动查找」会扫描所有磁盘与常用目录，
 * 判定「这个目录是不是酒馆根」用的必须是**严格规则** —— 扫描全盘时宁漏勿误：
 * 普通 Node 工程同样常备 `package.json` + `src` + `data`，
 * 用宽松的 `detectSillyTavern`（命中 3 个特征就放行）会报出一堆假酒馆。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isStRootStrict, detectSillyTavern, summarizeChecks, compareSemver, pickLatestVersion } from '../js/utils/stInstallCore.js';

test('isStRootStrict：server.js + public 同时存在 → 是酒馆', () => {
    assert.equal(isStRootStrict(['server.js', 'public', 'package.json']), true);
    // 大小写不敏感（Windows 目录列表可能原样返回）
    assert.equal(isStRootStrict(['Server.js', 'Public']), true);
});

test('isStRootStrict：package.json 的 name === sillytavern → 是酒馆', () => {
    assert.equal(isStRootStrict(['package.json', 'src'], { packageName: 'sillytavern' }), true);
    assert.equal(isStRootStrict(['package.json'], { packageName: '  SillyTavern  ' }), true);
});

test('isStRootStrict：普通 Node 工程不得误判（这是它存在的意义）', () => {
    // 有 package.json + src + data（3 个特征），但不是酒馆
    const entries = ['package.json', 'src', 'data', 'README.md'];
    assert.equal(isStRootStrict(entries), false, '缺少 server.js + public，不得判为酒馆');
    // 对比：宽松版会把它当酒馆（medium）—— 这正是扫描不能用的原因
    const loose = detectSillyTavern(entries);
    assert.equal(loose.isSillyTavern, true, '宽松判定会误报，故扫描必须用严格版');
});

test('isStRootStrict：只有其中一个特征不够', () => {
    assert.equal(isStRootStrict(['server.js']), false);
    assert.equal(isStRootStrict(['public']), false);
    assert.equal(isStRootStrict(['config.yaml', 'data', 'public']), false);
    assert.equal(isStRootStrict([]), false);
    assert.equal(isStRootStrict(null), false);
});

test('isStRootStrict：name 不叫 sillytavern 时不以 name 放行', () => {
    assert.equal(isStRootStrict(['package.json'], { packageName: 'sillytavern-card-manager' }), false);
    assert.equal(isStRootStrict(['package.json'], { packageName: 'sillytavern-fork-tool' }), false);
});

test('summarizeChecks：全绿 → 一切正常', () => {
    const r = summarizeChecks([{ status: 'ok' }, { status: 'ok' }]);
    assert.equal(r.ok, 2);
    assert.equal(r.warn, 0);
    assert.equal(r.error, 0);
    assert.equal(r.total, 2);
    assert.equal(r.verdict, '一切正常');
});

test('summarizeChecks：只有 warn → 能跑但需留意', () => {
    const r = summarizeChecks([{ status: 'ok' }, { status: 'warn' }, { status: 'warn' }]);
    assert.equal(r.ok, 1);
    assert.equal(r.warn, 2);
    assert.equal(r.error, 0);
    assert.match(r.verdict, /可以正常运行/);
    assert.match(r.verdict, /2 项/);
});

test('summarizeChecks：有 error → 结论只报必须修复项（优先级最高）', () => {
    const r = summarizeChecks([
        { status: 'ok' },
        { status: 'warn' },
        { status: 'error' },
        { status: 'error' },
    ]);
    assert.equal(r.error, 2);
    assert.equal(r.warn, 1);
    assert.equal(r.total, 4);
    assert.match(r.verdict, /2 个必须修复/);
    // 有 error 时不应只说「可以正常运行」
    assert.equal(r.verdict.includes('可以正常运行'), false);
});

test('summarizeChecks：空数组 / 非法输入不崩', () => {
    assert.equal(summarizeChecks([]).verdict, '一切正常');
    assert.equal(summarizeChecks([]).total, 0);
    assert.equal(summarizeChecks(null).total, 0);
    assert.equal(summarizeChecks(undefined).verdict, '一切正常');
});

// ==================== 版本比较（「已是最新版」判断的基础） ====================

test('compareSemver：逐段按数字比，不受字符串排序干扰', () => {
    // 字符串比较 '1.9.7' > '1.19.0'，但语义上新版是 1.19.0 —— 必须按数字比
    assert.equal(compareSemver('1.19.0', '1.9.7'), 1);
    assert.equal(compareSemver('1.9.7', '1.19.0'), -1);
    assert.equal(compareSemver('1.18.0', '1.19.0'), -1);
    assert.equal(compareSemver('2.0.0', '1.99.99'), 1);
    assert.equal(compareSemver('1.19.0', '1.19.0'), 0);
});

test('compareSemver：容忍 v 前缀与缺段', () => {
    assert.equal(compareSemver('v1.19.0', '1.18.0'), 1);
    assert.equal(compareSemver('1.19', '1.19.0'), 0);
    assert.equal(compareSemver('1', '1.0.1'), -1);
});

test('pickLatestVersion：从 tag 列表挑真正的最大版本', () => {
    const tags = ['1.9.2', '1.9.7', '1.18.0', '1.19.0', '1.19.10', '1.20.0'];
    assert.equal(pickLatestVersion(tags), '1.20.0');
    // 关键回归：1.19.10 必须大于 1.19.9（字符串排序会判错）
    assert.equal(pickLatestVersion(['1.19.9', '1.19.10']), '1.19.10');
    // 去掉 v 前缀
    assert.equal(pickLatestVersion(['v1.18.0', 'v1.19.0']), '1.19.0');
});

test('pickLatestVersion：过滤非法 tag，全非法时返回空串', () => {
    assert.equal(pickLatestVersion(['nightly', 'latest', 'abc']), '');
    assert.equal(pickLatestVersion([]), '');
    assert.equal(pickLatestVersion(null), '');
    assert.equal(pickLatestVersion(['1.18.0', 'nightly', '1.19.0-rc1']), '1.19.0-rc1'.match(/^\d+\.\d+\.\d+$/) ? '1.19.0-rc1' : '1.18.0');
});
