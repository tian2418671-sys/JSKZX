/**
 * 长期记忆存储单测（桌面版 memoryStore）
 *
 * 覆盖：
 *   · add / list / search / update / remove / clear 基本契约
 *   · 去重合并（同 type+key+content+cardName 只更新时间戳）
 *   · 空内容/超长内容规范化与拒绝
 *   · 按类型修剪（maxPerType 超限淘汰最旧）
 *   · 落盘串行化：多次写操作的 save 调用不并发覆盖（快照式）
 *   · 加载已有数据 + 坏文件容错
 *   · 检索：中文 2-gram 命中、fact 优先于 message、空查询退化为最近 N 条
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, tokenize } from '../main/memoryStore.js';

/** 造一个受控 store：内存文件 + 可注入时间 */
function makeStore(seed = null, opts = {}) {
    const disk = { data: seed ? JSON.parse(JSON.stringify(seed)) : null, saves: 0, maxConcurrent: 0, running: 0 };
    let clock = 1_700_000_000_000;
    const store = createMemoryStore({
        load: async () => disk.data,
        save: async (payload) => {
            disk.saves++;
            disk.running++;
            disk.maxConcurrent = Math.max(disk.maxConcurrent, disk.running);
            await new Promise((r) => setTimeout(r, 5));   // 模拟异步写盘
            disk.data = payload;
            disk.running--;
        },
        now: () => (clock += 1000),
        ...opts
    });
    return { store, disk };
}

test('memoryStore: add → list 返回条目并落盘', async () => {
    const { store, disk } = makeStore();
    const r = await store.add({ type: 'fact', key: '名字', content: '小明', cardName: '阿狸' });
    assert.equal(r.success, true);
    assert.ok(r.id, '应返回 id');
    const l = await store.list({});
    assert.equal(l.items.length, 1);
    assert.equal(l.items[0].key, '名字');
    assert.equal(l.items[0].content, '小明');
    assert.equal(disk.saves, 1, '应已落盘一次');
    assert.equal(disk.data.items.length, 1);
});

test('memoryStore: 同 type+key+content+cardName 去重合并（只更新时间戳）', async () => {
    const { store } = makeStore();
    await store.add({ type: 'fact', key: '喜欢', content: '咖啡', cardName: 'A' });
    const first = (await store.list({})).items[0];
    const firstTs = first.ts;
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await store.add({ type: 'fact', key: '喜欢', content: '咖啡', cardName: 'A' });
    const after = await store.list({});
    assert.equal(after.items.length, 1, '不应产生第二行');
    assert.equal(r2.merged, true);
    assert.equal(r2.id, first.id);
    assert.ok(after.items[0].ts > firstTs, '时间戳应被刷新');
    assert.equal(first.ts, firstTs, 'list() 返回的应是副本，不被后续写入影响');
});

test('memoryStore: 空内容拒绝、超长内容与 key 截断规范化', async () => {
    const { store } = makeStore();
    assert.equal((await store.add({ type: 'message', content: '   ' })).success, false);
    const long = 'x'.repeat(9000);
    const r = await store.add({ type: 'message', content: long, key: 'k'.repeat(500) });
    assert.equal(r.success, true);
    const it = (await store.list({})).items[0];
    assert.equal(it.content.length, 4000, 'content 应截断到 4000');
    assert.equal(it.key.length, 200, 'key 应截断到 200');
});

test('memoryStore: 按类型修剪，超限淘汰最旧（不同 type 互不影响）', async () => {
    const { store } = makeStore(null, { maxPerType: 3 });
    for (let i = 1; i <= 5; i++) await store.add({ type: 'message', content: `第${i}句` });
    await store.add({ type: 'fact', key: '保留', content: '不被 message 修剪影响' });
    const msgs = await store.list({ type: 'message' });
    assert.equal(msgs.items.length, 3);
    assert.deepEqual(msgs.items.map((m) => m.content), ['第5句', '第4句', '第3句'], '应保留最新 3 条');
    assert.equal((await store.list({ type: 'fact' })).items.length, 1);
});

test('memoryStore: 落盘串行化 —— 并发写不重叠', async () => {
    const { store, disk } = makeStore();
    await Promise.all([
        store.add({ type: 'message', content: '并发一' }),
        store.add({ type: 'message', content: '并发二' }),
        store.add({ type: 'fact', key: 'k', content: '并发三' })
    ]);
    assert.equal(disk.maxConcurrent, 1, 'save 必须串行执行，不能并发覆盖');
    assert.equal(disk.saves, 3);
    assert.equal((await store.list({})).items.length, 3);
    assert.equal(disk.data.items.length, 3, '最后一次落盘应包含全部 3 条');
});

test('memoryStore: update / remove / clear 契约', async () => {
    const { store } = makeStore();
    const a = await store.add({ type: 'fact', key: '旧键', content: '旧值' });
    assert.equal((await store.update(a.id, { key: '新键', content: '新值' })).success, true);
    const it = (await store.list({})).items[0];
    assert.equal(it.key, '新键');
    assert.equal(it.content, '新值');
    assert.equal((await store.update('不存在', { content: 'x' })).success, false);
    assert.equal((await store.update(a.id, { content: '  ' })).success, false, '空内容不允许');
    assert.equal((await store.remove(a.id)).success, true);
    assert.equal((await store.remove(a.id)).success, false, '重复删除应失败');
    await store.add({ type: 'message', content: '一' });
    await store.add({ type: 'summary', content: '二' });
    const c = await store.clear('message');
    assert.equal(c.success, true);
    assert.equal(c.removed, 1);
    assert.equal((await store.list({ type: 'message' })).items.length, 0);
    assert.equal((await store.list({})).items.length, 1, 'clear(单类型) 不应清掉别的类型');
    assert.equal((await store.clear()).removed, 1);
    assert.equal((await store.list({})).items.length, 0);
});

test('memoryStore: 加载已有数据 + 坏文件容错', async () => {
    const seed = { v: 1, items: [{ id: 'x1', type: 'fact', key: '名字', content: '旧卡记忆', cardName: 'B', ts: 1 }] };
    const { store } = makeStore(seed);
    const l = await store.list({});
    assert.equal(l.items.length, 1);
    assert.equal(l.items[0].content, '旧卡记忆');

    const bad = createMemoryStore({ load: async () => { throw new Error('坏文件'); }, save: async () => {} });
    assert.deepEqual((await bad.list({})).items, [], '坏文件应容错为空');
    const r = await bad.add({ type: 'fact', key: 'k', content: '仍可写入' });
    assert.equal(r.success, true);
});

test('memoryStore: 检索 —— 中文 2-gram 命中、fact 优先、空查询取最近', async () => {
    const { store } = makeStore();
    await store.add({ type: 'message', content: '用户: 我今天想去海边散步' });
    await store.add({ type: 'fact', key: '喜欢', content: '海边' });
    await store.add({ type: 'message', content: '用户: 与海边无关的一句话' });
    const r = await store.search({ query: '海边', limit: 5 });
    assert.ok(r.items.length >= 2, '应命中含「海边」的记忆');
    assert.equal(r.items[0].type, 'fact', 'fact 权重高于 message，应排第一');
    const empty = await store.search({ query: '', limit: 2 });
    assert.equal(empty.items.length, 2);
    assert.ok(empty.items[0].ts >= empty.items[1].ts, '空查询应按时间倒序');
    assert.deepEqual((await store.search({ query: '不存在的词xyz' })).items, []);
});

test('memoryStore: tokenize 切词（英文词 + 中文 2-gram + 单字）', () => {
    assert.ok(tokenize('hello world').includes('hello'));
    assert.ok(tokenize('海边散步').includes('海边'));
    assert.ok(tokenize('海边散步').includes('散步'));
    assert.deepEqual(tokenize('甲'), ['甲']);
    assert.deepEqual(tokenize('   '), []);
});
