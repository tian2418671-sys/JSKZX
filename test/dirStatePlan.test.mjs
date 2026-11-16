/**
 * 🗂️ 选中目录的状态判定（纯函数）单测
 * 背景（2026-11-16 用户实测）：选一个**准备往里装**的空目录去体检，
 * 结果报「发现 1 个必须修复的问题：酒馆目录 该目录不是有效的酒馆工程」——
 * 用户莫名其妙。空目录/目录不存在都该是「可以安装」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyDirState } = require('../main/dirStatePlan.js');

test('已定位到酒馆根 → installed（由后续项继续体检）', () => {
    const r = classifyDirState({ entries: ['server.js', 'public', 'package.json'], stRoot: 'D:\\st' });
    assert.equal(r.kind, 'installed');
    assert.equal(r.status, 'ok');
});

test('空目录 → ok「待安装」，不是必须修复', () => {
    const r = classifyDirState({ entries: [], stRoot: '' });
    assert.equal(r.kind, 'empty');
    assert.equal(r.status, 'ok');
    assert.match(r.detail, /空目录/);
    assert.match(r.hint, /一键安装/);
});

test('目录还不存在 → ok（安装时自动创建）', () => {
    const r = classifyDirState({ exists: false, entries: [], stRoot: '' });
    assert.equal(r.kind, 'missing');
    assert.equal(r.status, 'ok');
    assert.match(r.detail, /自动创建/);
});

test('目录里有别的东西、没有 server.js → error，且提示两种可能（选错层级 / 换空目录）', () => {
    const r = classifyDirState({ entries: ['我的文档', '照片', 'a.txt'], stRoot: '' });
    assert.equal(r.kind, 'occupied');
    assert.equal(r.status, 'error');
    assert.match(r.detail, /3 项/);
    assert.match(r.detail, /我的文档/);
    assert.match(r.hint, /上一级/);
    assert.match(r.hint, /空目录/);
});

test('像酒馆但缺 public/ → error（安装不完整）', () => {
    const r = classifyDirState({ entries: ['server.js', 'package.json', 'src'], stRoot: '', hasServerJs: true, hasPublic: false });
    assert.equal(r.kind, 'partial');
    assert.equal(r.status, 'error');
    assert.match(r.detail, /public/);
});

test('条目很多时详情只列前 6 项 + 总数，避免糊满一行', () => {
    const entries = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
    const r = classifyDirState({ entries, stRoot: '' });
    assert.match(r.detail, /等 20 项/);
    assert.ok(r.detail.length < 200);
});

test('非法入参不崩', () => {
    assert.equal(classifyDirState().kind, 'empty'); // 默认 exists=true、无条目
    assert.equal(classifyDirState({ entries: null }).kind, 'empty');
    assert.equal(classifyDirState({ entries: [null, '', 0] }).kind, 'empty');
});
