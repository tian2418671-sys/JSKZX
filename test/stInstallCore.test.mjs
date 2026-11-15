/**
 * 酒馆「安装与维护」纯逻辑门禁
 *
 * 这些函数决定「装到哪、能不能装、卸什么、什么绝不能删」，
 * 任何一条判断错误都会造成真实损失（尤其是误删角色卡或浏览器快捷方式）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    detectSillyTavern,
    parseNodeVersion,
    judgeNodeVersion,
    validateInstallPath,
    isOwnedUninstallEntry,
    buildUninstallInventory,
    formatBytes,
} from '../js/utils/stInstallCore.js';

// ==================== 目录形态识别 ====================
test('检测：server.js + public 同时存在 ⇒ 判定为酒馆', () => {
    const r = detectSillyTavern(['server.js', 'public', 'src', 'data', 'config.yaml']);
    assert.equal(r.isSillyTavern, true);
    assert.equal(r.confidence, 'high');
});

test('检测：package.json name=sillytavern ⇒ 高置信度', () => {
    const r = detectSillyTavern(['server.js'], { packageName: 'sillytavern' });
    assert.equal(r.isSillyTavern, true);
    assert.equal(r.confidence, 'high');
});

test('检测：只命中 3 个特征 ⇒ 中等置信度', () => {
    const r = detectSillyTavern(['server.js', 'src', 'data']);
    assert.equal(r.isSillyTavern, true);
    assert.equal(r.confidence, 'medium');
});

test('检测：普通目录不误判为酒馆', () => {
    const r = detectSillyTavern(['readme.txt', 'photo.jpg', 'data']);
    assert.equal(r.isSillyTavern, false);
    assert.equal(r.hits.length, 1);
});

test('检测：空目录不误判', () => {
    assert.equal(detectSillyTavern([]).isSillyTavern, false);
    assert.equal(detectSillyTavern(null).isSillyTavern, false);
});

// ==================== Node 版本 ====================
test('解析 node -v：标准格式', () => {
    assert.deepEqual(parseNodeVersion('v25.2.1'), { ok: true, major: 25, version: '25.2.1' });
});

test('解析 node -v：无 v 前缀 / 带换行 / 带后缀', () => {
    assert.equal(parseNodeVersion('20.11.1\n').major, 20);
    assert.equal(parseNodeVersion('  v18.19.0  ').major, 18);
    assert.equal(parseNodeVersion('v20.0.0-nightly20240101').major, 20);
});

test('解析 node -v：非法输入', () => {
    assert.equal(parseNodeVersion('').ok, false);
    assert.equal(parseNodeVersion('not a version').major, -1);
    assert.equal(parseNodeVersion(null).ok, false);
});

test('判定 Node：>= 20 通过', () => {
    assert.equal(judgeNodeVersion(20).level, 'ok');
    assert.equal(judgeNodeVersion(25).level, 'ok');
});

test('判定 Node：< 20 明确报过低（酒馆要求 engines >= 20）', () => {
    const r = judgeNodeVersion(18);
    assert.equal(r.level, 'too-old');
    assert.match(r.message, /18/);
    assert.match(r.message, /20/);
});

test('判定 Node：未安装', () => {
    assert.equal(judgeNodeVersion(-1).level, 'missing');
    assert.equal(judgeNodeVersion(NaN).level, 'missing');
});

// ==================== 安装路径校验 ====================
test('路径：空值拒绝', () => {
    assert.equal(validateInstallPath({ dirPath: '' }).ok, false);
});

test('路径：盘符不存在拒绝', () => {
    const r = validateInstallPath({
        dirPath: 'Z:\\SillyTavern',
        existingDrives: ['C', 'D'],
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /Z:/);
});

test('路径：Program Files 拒绝（权限问题）', () => {
    assert.equal(validateInstallPath({ dirPath: 'C:\\Program Files\\ST' }).ok, false);
    assert.equal(validateInstallPath({ dirPath: 'C:\\Program Files (x86)\\ST' }).ok, false);
});

test('路径：过长给出警告', () => {
    const deep = 'D:\\' + 'a'.repeat(210);
    const r = validateInstallPath({ dirPath: deep });
    assert.equal(r.ok, false);
    assert.equal(r.level, 'warn');
});

test('路径：含特殊字符警告', () => {
    const r = validateInstallPath({ dirPath: 'D:\\A&B\\SillyTavern' });
    assert.equal(r.ok, false);
    assert.equal(r.level, 'warn');
});

test('路径：已装酒馆 ⇒ 拒绝安装（应走升级）', () => {
    const r = validateInstallPath({ dirPath: 'D:\\SillyTavern', hasSillyTavern: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /已安装/);
});

test('路径：非空目录给出警告', () => {
    const r = validateInstallPath({
        dirPath: 'D:\\SillyTavern',
        dirExists: true,
        dirEmpty: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.level, 'warn');
});

test('路径：空间不足拒绝', () => {
    const r = validateInstallPath({
        dirPath: 'D:\\SillyTavern',
        freeBytes: 1 * 1024 * 1024 * 1024,   // 1GB
        needBytes: 5 * 1024 * 1024 * 1024,   // 需 5GB
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /空间不足/);
});

test('路径：正常情况通过', () => {
    const r = validateInstallPath({
        dirPath: 'D:\\SillyTavern',
        dirExists: false,
        existingDrives: ['C', 'D'],
        freeBytes: 100 * 1024 * 1024 * 1024,
    });
    assert.equal(r.ok, true);
    assert.equal(r.level, 'ok');
});

// ==================== 注册表归属判定（防误删） ====================
test('注册表：Chrome 装的 PWA 绝不能删（真实踩坑）', () => {
    const r = isOwnedUninstallEntry({
        DisplayName: 'SillyTavern',
        Publisher: 'Google\\Chrome',
        UninstallString: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --uninstall-app-id=xxx',
    });
    assert.equal(r.owned, false);
    assert.match(r.reason, /PWA|浏览器/);
});

test('注册表：Edge 的 PWA 同样跳过', () => {
    const r = isOwnedUninstallEntry({
        DisplayName: 'SillyTavern',
        Publisher: 'Microsoft',
        UninstallString: '"C:\\Program Files\\Microsoft\\Edge\\msedge.exe" --uninstall-app-id=xxx',
    });
    assert.equal(r.owned, false);
});

test('注册表：路径属于本软件安装位置 ⇒ 判定为自有', () => {
    const r = isOwnedUninstallEntry(
        {
            DisplayName: 'SillyTavern 资源管理器',
            UninstallString: '"C:\\Program Files\\SillyTavernRM\\Uninstall.exe"',
        },
        { ownedPaths: ['C:\\Program Files\\SillyTavernRM'] },
    );
    assert.equal(r.owned, true);
});

test('注册表：名称不匹配的直接跳过', () => {
    const r = isOwnedUninstallEntry({ DisplayName: 'Steam' });
    assert.equal(r.owned, false);
    assert.match(r.reason, /名称不匹配/);
});

test('注册表：无法确认来源时默认不删（安全优先）', () => {
    const r = isOwnedUninstallEntry({
        DisplayName: 'SillyTavern',
        Publisher: 'SomeoneUnknown',
        UninstallString: 'D:\\Somewhere\\uninst.exe',
    });
    assert.equal(r.owned, false);
    assert.match(r.reason, /跳过/);
});

// ==================== 卸载清单 ====================
test('清单：只删酒馆（模式 1）不含软件本体', () => {
    const inv = buildUninstallInventory({
        stBytes: 2400 * 1024 * 1024,
        rtBytes: 18 * 1024 * 1024,
        appDataBytes: 1049 * 1024 * 1024,
        appBytes: 320 * 1024 * 1024,
        cards: 49,
        mode: 1,
    });
    assert.equal(inv.items.length, 2);
    assert.equal(inv.items.some((x) => x.label.includes('本软件')), false);
    assert.equal(inv.counts.cards, 49);
});

test('清单：彻底删除（模式 2）含软件本体与数据', () => {
    const inv = buildUninstallInventory({
        stBytes: 2400 * 1024 * 1024,
        rtBytes: 18 * 1024 * 1024,
        appDataBytes: 1049 * 1024 * 1024,
        appBytes: 320 * 1024 * 1024,
        mode: 2,
    });
    assert.equal(inv.items.length, 4);
    assert.ok(inv.totalBytes > 3700 * 1024 * 1024);
});

test('清单：非法数值按 0 处理，不产生 NaN', () => {
    const inv = buildUninstallInventory({ stBytes: 'abc', cards: -5, mode: 2 });
    assert.equal(Number.isNaN(inv.totalBytes), false);
    assert.equal(inv.counts.cards, 0);
});

test('字节格式化', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(2400 * 1024 * 1024), '2.3 GB');
    assert.equal(formatBytes(null), '0 B');
});
