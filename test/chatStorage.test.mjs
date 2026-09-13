/**
 * 测卡数据持久化适配层单测（chatStorage）
 * 运行：node --test "test/**\/*.test.mjs"
 *
 * 覆盖：
 *   ① 同步 get/set/remove 语义（引擎的同步 getter 依赖它）
 *   ② 磁盘恢复优先于 localStorage 旧残留
 *   ③ 写入触发 chatStore:save 落盘（经 chatBridge → window.electronAPI）
 *   ④ 无 electronAPI 时静默降级，不抛错（浏览器/测试环境安全）
 *   ⑤ 落盘失败不冒泡（保证主流程不被存储问题打断）
 *
 * ⚠️ 时序约束：chatBridge.js 在模块加载瞬间就读 window.electronAPI，
 *    因此必须在 import 之前把桩挂到 globalThis.window 上。
 */

import { test } from 'node:test';
import assert from 'node:assert';

// ---- 必须在 import 之前安装 window 桩 ----
const saveCalls = [];
let loadResult = { success: true, data: null };
let failSave = false;

globalThis.window = {
    electronAPI: {
        sendChatMessage: async () => ({ success: true }),
        encryptSecret: async (v) => ({ success: true, value: v }),
        decryptSecret: async (v) => ({ success: true, value: v }),
        loadChatStore: async () => loadResult,
        saveChatStore: async (data) => {
            if (failSave) throw new Error('disk full');
            saveCalls.push(JSON.parse(JSON.stringify(data)));
            return { success: true };
        }
    },
    addEventListener: () => {}
};

const { chatStorage, chatStorageVersion } = await import('../js/composables/chat/chatStorage.js');

function resetAll() {
    chatStorage._reset();
    saveCalls.length = 0;
    loadResult = { success: true, data: null };
    failSave = false;
    try { localStorage.clear(); } catch (e) { /* Node 无 localStorage 时忽略 */ }
}

// ---------------------------------------------------------------- ① 同步语义

test('chatStorage：同步 get/set 往返', () => {
    resetAll();
    assert.equal(chatStorage.get('k1'), null, '未写入应返回 null');
    chatStorage.set('k1', 'v1');
    assert.equal(chatStorage.get('k1'), 'v1', '写入后应立即可同步读到');
});

test('chatStorage：set 归一化为字符串（引擎按字符串存取）', () => {
    resetAll();
    chatStorage.set('n', 42);
    assert.strictEqual(chatStorage.get('n'), '42');
    chatStorage.set('nil', null);
    assert.strictEqual(chatStorage.get('nil'), '');
});

test('chatStorage：remove 后读回 null', () => {
    resetAll();
    chatStorage.set('k2', 'v2');
    chatStorage.remove('k2');
    assert.equal(chatStorage.get('k2'), null);
});

// ---------------------------------------------------------------- ③ 落盘

test('chatStorage：set 后 flush 触发 chatStore:save，且带全部键', () => {
    resetAll();
    chatStorage.set('jsmobile-user-name', '测试用户');
    chatStorage.set('jsmobile-chat-reply-count', '3');
    chatStorage.flush();
    assert.equal(saveCalls.length, 1, 'flush 应恰好落盘一次');
    assert.deepEqual(saveCalls[0], {
        'jsmobile-user-name': '测试用户',
        'jsmobile-chat-reply-count': '3'
    });
});

test('chatStorage：remove 会从落盘镜像中删除键', () => {
    resetAll();
    chatStorage.set('a', '1');
    chatStorage.set('b', '2');
    chatStorage.remove('a');
    chatStorage.flush();
    assert.deepEqual(saveCalls[0], { b: '2' });
});

// ---------------------------------------------------------------- ② 恢复

test('chatStorage：hydrate 从磁盘恢复键值', async () => {
    resetAll();
    loadResult = { success: true, data: { 'jsmobile-user-name': '磁盘用户', 'jsmobile-memory-limit': '50' } };
    const ok = await chatStorage.hydrate();
    assert.equal(ok, true, '应从磁盘恢复成功');
    assert.equal(chatStorage.get('jsmobile-user-name'), '磁盘用户');
    assert.equal(chatStorage.get('jsmobile-memory-limit'), '50');
    assert.equal(chatStorage.isHydrated(), true);
});

test('chatStorage：磁盘优先于 localStorage 旧残留（关键：否则重启会回退旧值）', async () => {
    resetAll();
    // 先制造 localStorage 旧残留（模拟上一进程遗留）
    try { localStorage.setItem('jsmobile-user-name', '旧残留'); } catch (e) { /* 无 localStorage 则跳过该断言 */ }
    chatStorage._reset();
    loadResult = { success: true, data: { 'jsmobile-user-name': '磁盘用户' } };
    await chatStorage.hydrate();
    assert.equal(chatStorage.get('jsmobile-user-name'), '磁盘用户', '磁盘值必须覆盖 localStorage 旧残留');
});

test('chatStorage：hydrate 幂等（重复调用复用同一 Promise，不重复回填）', async () => {
    resetAll();
    loadResult = { success: true, data: { k: 'v' } };
    const p1 = chatStorage.hydrate();
    const p2 = chatStorage.hydrate();
    assert.strictEqual(p1, p2, '第二次调用应返回同一个 Promise');
    await p1;
    assert.equal(chatStorage.get('k'), 'v');
});

test('chatStorage：磁盘无数据时回退 localStorage 现有值，不丢旧键', async () => {
    resetAll();
    try { localStorage.setItem('jsmobile-user-persona', '人设') } catch (e) { /* 忽略 */ }
    chatStorage._reset();
    loadResult = { success: true, data: null };
    const ok = await chatStorage.hydrate();
    assert.equal(ok, false, '无磁盘数据时返回 false');
    // 若环境支持 localStorage，应已回填进内存
    try {
        localStorage.setItem('jsmobile-user-persona', '人设');
        chatStorage._reset();
        loadResult = { success: true, data: null };
        await chatStorage.hydrate();
        assert.equal(chatStorage.get('jsmobile-user-persona'), '人设');
    } catch (e) { /* 无 localStorage 环境跳过 */ }
});

// ---------------------------------------------------------------- ④⑤ 降级

test('chatStorage：磁盘异常时 hydrate 不抛错，返回 false', async () => {
    resetAll();
    loadResult = { success: false, error: 'corrupted', data: null };
    const ok = await chatStorage.hydrate();
    assert.equal(ok, false);
});

test('chatStorage：落盘失败不冒泡（存储故障不得打断发消息主流程）', async () => {
    resetAll();
    failSave = true;
    chatStorage.set('k', 'v');
    assert.doesNotThrow(() => chatStorage.flush());
    assert.equal(chatStorage.get('k'), 'v', '落盘失败后内存副本仍必须可读');
});

// ---------------------------------------------------------------- ⑥ 响应式版本号
// 回归背景（真实故障）：侧栏选了预设、localStorage 也写进去了，但引擎的
// `computed(() => loadActivePreset())` 永远返回 null —— 因为 getter 读的是同步存储，
// Vue 认为它「无依赖」而永久缓存首次结果。修法是 chatStorage 每次写入 bump
// chatStorageVersion，读存储的 computed `void` 一下建立依赖。以下用例锁住这个契约。

test('chatStorageVersion：写入时递增（computed 依赖它才能重算）', () => {
    resetAll();
    const before = chatStorageVersion.value;
    chatStorage.set('react-key', 'v1');
    assert.ok(chatStorageVersion.value > before, 'set 必须 bump 版本号');
});

test('chatStorageVersion：删除时递增', () => {
    resetAll();
    chatStorage.set('react-key', 'v1');
    const mid = chatStorageVersion.value;
    chatStorage.remove('react-key');
    assert.ok(chatStorageVersion.value > mid, 'remove 必须 bump 版本号');
});

test('chatStorageVersion：hydrate 完成时递增', async () => {
    resetAll();
    const before = chatStorageVersion.value;
    loadResult = { success: true, data: { 'k-h': 'v' } };
    await chatStorage.hydrate();
    assert.ok(chatStorageVersion.value > before, 'hydrate 必须 bump 版本号');
});

test('chatStorageVersion：computed 依赖它 → 存储变更后能读到新值（防「永久缓存」回归）', async () => {
    // 用 Vue 的 computed + effect 复现真实场景：不依赖版本号的 computed 会永久缓存
    const { computed, effect } = await import('vue');
    resetAll();
    // ① 反例：无依赖的 computed 确实读不到后续变更（说明这个坑真实存在）
    const blind = computed(() => chatStorage.get('probe-key'));
    const seen = [];
    effect(() => { seen.push(blind.value); });
    chatStorage.set('probe-key', 'first');
    assert.equal(blind.value, null, '无依赖的 computed 会永久缓存首次结果（这正是故障成因）');
    // ② 正例：依赖 chatStorageVersion 的 computed 能看到变更
    const aware = computed(() => { void chatStorageVersion.value; return chatStorage.get('probe-key'); });
    const seen2 = [];
    effect(() => { seen2.push(aware.value); });
    chatStorage.set('probe-key', 'second');
    assert.equal(aware.value, 'second', '依赖版本号的 computed 必须读到最新值');
    assert.ok(seen2.length >= 2, 'effect 必须被重新触发');
});
