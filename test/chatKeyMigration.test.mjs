import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatStorage, migrateChatKeys } from '../js/composables/chat/chatStorage.js';

/**
 * 契约测试：**按 path 派生的键必须能随物理路径迁移**
 *
 * 背景（2026-09-13 排查发现）：测卡会话、变量树、最后会话指针都靠 `chat_store.json` 里的
 * `jsmobile-chat-<卡片完整路径>...` 作为键。卡片一旦被「移动分组 / 分组重命名 / 换卡图」，
 * 旧键就成孤儿 —— 数据还在，但按新路径读不到，用户看到的是「测卡会话与变量树消失」。
 * ⚠️ 同类缺陷 2026-09-01 已在「覆盖层 app_config.json」上踩过一次。
 */

const P1 = 'C:\\lib\\组A\\card1.png';
const P2 = 'C:\\lib\\组B\\card1.png';
const keyOf = (p) => 'jsmobile-chat-' + p + ':sessions';

test('迁移：旧路径派生键整体搬到新路径下（值不变）', () => {
    chatStorage._reset();
    chatStorage.set(keyOf(P1), '[{"id":"s1"}]');
    chatStorage.set(keyOf(P1) + ':last', 's1');
    chatStorage.set('jsmobile-chat-其他卡.png:sessions', '[]');   // 不该被动

    const moved = migrateChatKeys(P1, P2);

    assert.equal(moved, 2, '应迁移两条键（会话 + last 指针）');
    assert.equal(chatStorage.get(keyOf(P2)), '[{"id":"s1"}]', '新键应拿到原值');
    assert.equal(chatStorage.get(keyOf(P2) + ':last'), 's1');
    assert.equal(chatStorage.get(keyOf(P1)), null, '旧键应被删除');
    assert.equal(chatStorage.get('jsmobile-chat-其他卡.png:sessions'), '[]', '无关键不能动');
});

test('迁移：目标键已存在时不覆盖（宁可不迁，也不吞数据）', () => {
    chatStorage._reset();
    chatStorage.set(keyOf(P1), 'OLD');
    chatStorage.set(keyOf(P2), 'NEW');
    const moved = migrateChatKeys(P1, P2);
    assert.equal(moved, 0, '目标已存在 → 不迁移');
    assert.equal(chatStorage.get(keyOf(P2)), 'NEW', '目标值不能被旧值覆盖');
    assert.equal(chatStorage.get(keyOf(P1)), 'OLD', '源值也应原样保留，便于人工排查');
});

test('迁移：目录前缀形式（分组重命名）同样适用', () => {
    chatStorage._reset();
    const oldPrefix = 'C:\\lib\\旧组名';
    const newPrefix = 'C:\\lib\\新组名';
    chatStorage.set('jsmobile-chat-' + oldPrefix + '\\a.png:sessions', 'A');
    chatStorage.set('jsmobile-chat-' + oldPrefix + '\\sub\\b.png:sessions', 'B');
    const moved = migrateChatKeys(oldPrefix, newPrefix);
    assert.equal(moved, 2);
    assert.equal(chatStorage.get('jsmobile-chat-' + newPrefix + '\\a.png:sessions'), 'A');
    assert.equal(chatStorage.get('jsmobile-chat-' + newPrefix + '\\sub\\b.png:sessions'), 'B');
});

test('迁移：同路径 / 空值 立即返回，不做任何事', () => {
    chatStorage._reset();
    chatStorage.set(keyOf(P1), 'X');
    assert.equal(migrateChatKeys(P1, P1), 0);
    assert.equal(migrateChatKeys('', P2), 0);
    assert.equal(migrateChatKeys(P1, ''), 0);
    assert.equal(chatStorage.get(keyOf(P1)), 'X', '无操作时数据必须原样');
});
