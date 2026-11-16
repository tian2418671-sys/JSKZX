/**
 * 🧩 跨平台 spawn 计划（AR-84）单测
 * 背景：Windows 上 `npm` 是 `npm.cmd`，Node ≥18.20.2 起 shell:false 直接 spawn 会抛 EINVAL，
 *      导致「酒馆一键安装」的依赖安装必然失败（用户实测退出码 -1）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planSpawn, needsShellWrap, quoteForCmd, pickNodeCli } = require('../main/spawnPlan.js');

test('非 .cmd/.bat 一律原样透传（任何平台）', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
        assert.deepEqual(planSpawn('node', ['-v'], { platform }), { cmd: 'node', args: ['-v'], wrapped: false, windowsVerbatimArguments: false });
        assert.deepEqual(planSpawn('git', ['status'], { platform }), { cmd: 'git', args: ['status'], wrapped: false, windowsVerbatimArguments: false });
        assert.deepEqual(planSpawn('winget', ['--version'], { platform }), { cmd: 'winget', args: ['--version'], wrapped: false, windowsVerbatimArguments: false });
    }
});

test('Windows 的裸名 .cmd ⇒ 走 cmd.exe /d /s /c，且必须开 verbatim', () => {
    const r = planSpawn('npm.cmd', ['install', '--no-audit'], { platform: 'win32', comspec: 'C:\\Windows\\System32\\cmd.exe' });
    assert.equal(r.wrapped, true);
    assert.equal(r.cmd, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(r.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(r.args[3], 'npm.cmd install --no-audit');
    // ⚠️ 不开 verbatim 时 Node 会二次转义引号，cmd 收到 `\"npm.cmd\"` 字面量（实测失败）
    assert.equal(r.windowsVerbatimArguments, true);
});

test('带路径的 .cmd 直接拒绝（cmd /s /c 会剥外层引号，实测报「C:\\Program 不是内部或外部命令」）', () => {
    assert.throws(
        () => planSpawn('C:\\Program Files\\nodejs\\npm.cmd', ['--version'], { platform: 'win32', comspec: 'cmd.exe' }),
        /不能直接 spawn 带路径的批处理命令/,
    );
});

test('pickNodeCli：node.exe 同级有 npm-cli.js ⇒ 返回 node + cli（绕开 cmd）', () => {
    const r = pickNodeCli({
        nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
        npmCmdPath: 'C:\\Program Files\\nodejs\\npm.cmd',
        exists: (p) => p === 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    });
    assert.deepEqual(r, { cmd: 'C:\\Program Files\\nodejs\\node.exe', argsPrefix: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'] });
});

test('pickNodeCli：找不到 npm-cli.js ⇒ null（调用方回退 PATH 裸名）', () => {
    assert.equal(pickNodeCli({ nodeExe: 'C:\\nodejs\\node.exe', exists: () => false }), null);
    assert.equal(pickNodeCli({}), null);
});

test('非 Windows 平台即使名字带 .cmd 也不包装（Linux 上无需 cmd.exe）', () => {
    const r = planSpawn('npm.cmd', ['--version'], { platform: 'linux' });
    assert.equal(r.wrapped, false);
    assert.equal(r.cmd, 'npm.cmd');
    assert.equal(r.windowsVerbatimArguments, false);
});

test('大小写 / .bat 都要识别', () => {
    assert.equal(needsShellWrap('NPM.CMD', 'win32'), true);
    assert.equal(needsShellWrap('run.bat', 'win32'), true);
    assert.equal(needsShellWrap('npm.cmd', 'linux'), false);
    assert.equal(needsShellWrap('node.exe', 'win32'), false);
});

test('含空格的参数要加引号（cwd 里带空格时路径参数不会被打散）', () => {
    assert.equal(quoteForCmd('--no-audit'), '--no-audit');
    assert.equal(quoteForCmd('C:\\Program Files\\x'), '"C:\\Program Files\\x"');
    const r = planSpawn('npm.cmd', ['install', 'C:\\Program Files\\pkg'], { platform: 'win32', comspec: 'cmd.exe' });
    assert.equal(r.args[3], 'npm.cmd install "C:\\Program Files\\pkg"');
});

test('入参不被修改（args 复制）', () => {
    const args = ['install'];
    planSpawn('npm.cmd', args, { platform: 'win32', comspec: 'cmd.exe' });
    assert.deepEqual(args, ['install']);
});

test('空/缺失参数不崩', () => {
    const r = planSpawn('npm.cmd', undefined, { platform: 'win32', comspec: 'cmd.exe' });
    assert.equal(r.args[3], 'npm.cmd');
    const r2 = planSpawn(null, [], { platform: 'win32', comspec: 'cmd.exe' });
    assert.equal(r2.wrapped, false); // 没有 .cmd 后缀 → 不包装
});
