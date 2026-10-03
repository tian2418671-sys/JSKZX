// ✨ 自定义模式（2026-10-03）：多段提示词纯函数单测
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    SEGMENT_ROLES, makeCustomSegment, normalizeCustomSegments,
    insertSegmentAtTop, removeSegmentAt, moveSegment, patchSegment, buildSegmentsFromPrompts,
    buildCustomMessages, customTailPrefill
} from '../js/utils/customPromptSegments.js';

describe('customPromptSegments — 多段提示词纯函数', () => {
    it('makeCustomSegment：默认 SYSTEM / 指定角色 / 非法角色回退', () => {
        assert.equal(makeCustomSegment().role, 'system');
        assert.equal(makeCustomSegment('user').role, 'user');
        assert.equal(makeCustomSegment('assistant').role, 'assistant');
        assert.equal(makeCustomSegment('xxx').role, 'system');
        const s = makeCustomSegment();
        assert.equal(s.content, '');
        assert.ok(s.id);
        assert.ok(SEGMENT_ROLES.includes(s.role));
    });
    it('normalizeCustomSegments：非数组 → []；脏数据过滤 + 字段补全', () => {
        assert.deepEqual(normalizeCustomSegments(null), []);
        assert.deepEqual(normalizeCustomSegments('x'), []);
        assert.deepEqual(normalizeCustomSegments(undefined), []);
        const l = normalizeCustomSegments([null, 1, { role: 'user', content: '你好' }, { role: 'bad', kind: 'weird', content: 5 }]);
        assert.equal(l.length, 2);
        assert.equal(l[0].role, 'user');
        assert.equal(l[0].content, '你好');
        assert.ok(l[0].id);
        assert.equal(l[1].role, 'system'); // 非法角色回退
        assert.equal(l[1].kind, undefined); // 旧数据附带的 kind 字段被自动清除（普通段选项已移除）
        assert.equal(l[1].content, '');   // 非法内容回退
    });
    it('insertSegmentAtTop：新段在最前；无参自动造段', () => {
        const a = makeCustomSegment();
        const b = makeCustomSegment();
        const l = insertSegmentAtTop([a], b);
        assert.deepEqual(l.map(s => s.id), [b.id, a.id]);
        assert.equal(insertSegmentAtTop([]).length, 1);
    });
    it('removeSegmentAt：正常删除 + 越界不动', () => {
        const a = makeCustomSegment('system'), b = makeCustomSegment('user');
        assert.deepEqual(removeSegmentAt([a, b], 0).map(s => s.id), [b.id]);
        assert.deepEqual(removeSegmentAt([a, b], 1).map(s => s.id), [a.id]);
        assert.deepEqual(removeSegmentAt([a, b], 5).map(s => s.id), [a.id, b.id]);
        assert.deepEqual(removeSegmentAt([a, b], -1).map(s => s.id), [a.id, b.id]);
    });
    it('moveSegment：上移 / 下移 / 首段上移不动 / 末段下移不动', () => {
        const a = makeCustomSegment(), b = makeCustomSegment(), c = makeCustomSegment();
        const l = [a, b, c];
        assert.deepEqual(moveSegment(l, 1, -1).map(s => s.id), [b.id, a.id, c.id]);
        assert.deepEqual(moveSegment(l, 1, 1).map(s => s.id), [a.id, c.id, b.id]);
        assert.deepEqual(moveSegment(l, 0, -1).map(s => s.id), [a.id, b.id, c.id]);
        assert.deepEqual(moveSegment(l, 2, 1).map(s => s.id), [a.id, b.id, c.id]);
        assert.deepEqual(moveSegment(l, 9, 1).map(s => s.id), [a.id, b.id, c.id]);
    });
    it('patchSegment：改内容 / 改角色；角色非法回退；越界不动', () => {
        const a = makeCustomSegment('system');
        assert.equal(patchSegment([a], 0, { content: '正文' })[0].content, '正文');
        assert.equal(patchSegment([a], 0, { role: 'assistant' })[0].role, 'assistant');
        assert.equal(patchSegment([a], 0, { role: 'bad' })[0].role, 'system');
        assert.equal(patchSegment([a], 3, { content: 'x' })[0].content, '');
        assert.equal(patchSegment([a], 0, { content: '正文' })[0].id, a.id); // id 不变
    });
    it('操作均不可变：不修改原数组 / 原段对象', () => {
        const a = makeCustomSegment();
        const l = [a];
        insertSegmentAtTop(l, makeCustomSegment());
        removeSegmentAt(l, 0);
        moveSegment(l, 0, 1);
        patchSegment(l, 0, { content: 'x' });
        assert.equal(l.length, 1);
        assert.equal(l[0].content, '');
        assert.equal(a.content, '');
    });
});

describe('buildSegmentsFromPrompts — 初始映射', () => {
    it('全空 → []；破限未启用时不映射', () => {
        assert.deepEqual(buildSegmentsFromPrompts({}), []);
        assert.deepEqual(buildSegmentsFromPrompts({ system: '  ', user: '\n', prefill: ' ', jailbreak: 'J', useJailbreak: false }), []);
    });
    it('映射顺序与角色：系统 → 破限 → User → 预填充', () => {
        const segs = buildSegmentsFromPrompts({ system: 'S', jailbreak: 'J', useJailbreak: true, user: 'U', prefill: '<tags>[' });
        assert.deepEqual(segs.map(s => s.role), ['system', 'system', 'user', 'assistant']);
        assert.deepEqual(segs.map(s => s.content), ['S', 'J', 'U', '<tags>[']);
        assert.ok(segs.every(s => s.id));
        assert.equal(new Set(segs.map(s => s.id)).size, 4); // id 各自唯一
    });
    it('空项跳过（user 空 / prefill 空）', () => {
        const segs = buildSegmentsFromPrompts({ system: 'S', user: '', prefill: '' });
        assert.deepEqual(segs.map(s => s.role), ['system']);
    });
    it('原文保留（不做内部修改）', () => {
        const segs = buildSegmentsFromPrompts({ system: 'A\n\nB\n' });
        assert.equal(segs[0].content, 'A\n\nB\n');
    });
});

describe('buildCustomMessages — 自定义模式打标组装', () => {
    const seg = (role, content) => ({ id: role + ':' + content, role, content });
    it('段按顺序转消息；空段跳过；非法角色回退 system', () => {
        const msgs = buildCustomMessages({ segments: [seg('system', 'S'), seg('user', '  '), { id: 'x', role: 'bad', content: 'B' }] });
        assert.deepEqual(msgs.map(m => m.role), ['system', 'system']);
        assert.deepEqual(msgs.map(m => m.content), ['S', 'B']);
    });
    it('材料拼进最后一条 user 段', () => {
        const msgs = buildCustomMessages({ segments: [seg('system', 'S'), seg('user', 'U1'), seg('user', 'U2')], defaultUser: '材料' });
        assert.equal(msgs[1].content, 'U1');
        assert.equal(msgs[2].content, 'U2\n\n材料');
    });
    it('无 user 段 → 材料独立成 user，插在末尾 assistant 前', () => {
        const msgs = buildCustomMessages({ segments: [seg('system', 'S'), seg('assistant', '<t>[')], defaultUser: '材料' });
        assert.deepEqual(msgs.map(m => m.role), ['system', 'user', 'assistant']);
        assert.equal(msgs[1].content, '材料');
    });
    it('usePrefill=false → 仅去掉末尾（连续）assistant 段', () => {
        const msgs = buildCustomMessages({ segments: [seg('system', 'S'), seg('assistant', 'A1'), seg('user', 'U'), seg('assistant', 'A2')], usePrefill: false });
        assert.deepEqual(msgs.map(m => m.role), ['system', 'assistant', 'user']);
        const msgs2 = buildCustomMessages({ segments: [seg('user', 'U'), seg('assistant', 'A1'), seg('assistant', 'A2')], usePrefill: false, defaultUser: '材料' });
        assert.deepEqual(msgs2.map(m => m.role), ['user']);
        assert.equal(msgs2[0].content, 'U\n\n材料');
    });
    it('全空 → []；无段仅材料 → [user]', () => {
        assert.deepEqual(buildCustomMessages({ segments: [] }), []);
        assert.deepEqual(buildCustomMessages({}), []);
        const m2 = buildCustomMessages({ segments: [], defaultUser: '材料' });
        assert.deepEqual(m2.map(m => m.role), ['user']);
    });
    it('不改原数组', () => {
        const arr = [seg('user', 'U')];
        buildCustomMessages({ segments: arr, defaultUser: '材料' });
        assert.equal(arr[0].content, 'U');
    });
});

describe('customTailPrefill — 末尾预填充提取', () => {
    const seg = (role, content) => ({ id: role + ':' + content, role, content });
    it('末尾 assistant 段（trim 后）', () => {
        assert.equal(customTailPrefill([seg('system', 'S'), seg('assistant', ' <t>[ ')]), '<t>[');
    });
    it('末尾非 assistant / 空 → 空串', () => {
        assert.equal(customTailPrefill([seg('assistant', 'A'), seg('user', 'U')]), '');
        assert.equal(customTailPrefill([]), '');
        assert.equal(customTailPrefill(null), '');
    });
});
