/**
 * 💾 重型卡存档管家纯函数 — 单测（方向 C / 阶段一-附）
 * 规格：docs/规格与计划/功能规格/C1-C4-重型卡存档管家-实现规格.md §6.1
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    compareOrigins, safeOrigin, isFileUrl,
    groupBackupsByDay, computeStorageRanking,
    describePlayStats, sortByRecentPlay, formatDuration, formatBytes
} from '../js/utils/heavyCardStorage.js';

// ───────── C3：Origin 判定（上游架构级加固） ─────────
test('★ compareOrigins：同域不同路径 ⇒ same', () => {
    const r = compareOrigins('https://a.com/x/index.html', 'https://a.com/y/index.html');
    assert.equal(r.verdict, 'same');
    assert.equal(r.oldOrigin, 'https://a.com');
    assert.equal(r.newOrigin, 'https://a.com');
});

// 🩹 回归：本地目录模式走的是 `heavycard-local://`，不是 `file://`。
//    原实现只认 `file://` ⇒ 本地卡换目录被判成 unknown（「地址无法解析」），文案误导。
test('★ isFileUrl：heavycard-local:// 也算本地（回归）', () => {
    assert.equal(isFileUrl('heavycard-local://hc_ydrs/index.html'), true);
    assert.equal(isFileUrl('file:///D:/card/index.html'), true);
    assert.equal(isFileUrl('https://a.com/x'), false);
});

test('★ compareOrigins：本地目录变更 ⇒ local（回归，不能是 unknown）', () => {
    const r = compareOrigins(
        'heavycard-local://cardA/index.html',
        'heavycard-local://cardB/index.html'
    );
    assert.equal(r.verdict, 'local');
    assert.match(r.message, /本地文件夹路径已变更/);
});

test('★ compareOrigins：远程 ↔ 本地 ⇒ unknown（两者不可比）', () => {
    const r = compareOrigins('https://a.com/x', 'heavycard-local://cardA/index.html');
    assert.equal(r.verdict, 'unknown');
});

test('★ compareOrigins：不同域名 ⇒ cross', () => {
    const r = compareOrigins('https://a.com/x', 'https://b.com/x');
    assert.equal(r.verdict, 'cross');
});

test('★ compareOrigins：不同端口 ⇒ cross', () => {
    const r = compareOrigins('https://a.com:8080/x', 'https://a.com/x');
    assert.equal(r.verdict, 'cross');
});

test('★ compareOrigins：协议不同（http vs https）⇒ cross', () => {
    const r = compareOrigins('http://a.com/x', 'https://a.com/x');
    assert.equal(r.verdict, 'cross');
});

test('★★ compareOrigins：两个不同本地路径 ⇒ local，绝不可判为 same（file:// origin 都是 "null"）', () => {
    const r = compareOrigins('file:///E:/card/a/index.html', 'file:///D:/other/index.html');
    assert.equal(r.verdict, 'local');
    assert.notEqual(r.verdict, 'same', '两个 "null" 相等的陷阱必须被拦截');
});

test('compareOrigins：本地路径文案应针对「文件夹」而非「跨域名」（上游微调指令）', () => {
    const r = compareOrigins('file:///E:/a/index.html', 'file:///E:/b/index.html');
    assert.ok(r.message.includes('本地文件夹'), `文案应含「本地文件夹」，实际：${r.message}`);
});

test('★ compareOrigins：一侧为空 / 解析失败 ⇒ unknown（保守）', () => {
    assert.equal(compareOrigins('', 'https://a.com').verdict, 'unknown');
    assert.equal(compareOrigins('https://a.com', '').verdict, 'unknown');
    assert.equal(compareOrigins('not a url', 'https://a.com').verdict, 'unknown');
    assert.equal(compareOrigins(null, null).verdict, 'unknown');
});

test('compareOrigins：一侧本地、一侧网址 ⇒ unknown（不能假定可沿用）', () => {
    const r = compareOrigins('file:///E:/a/index.html', 'https://a.com/x');
    assert.equal(r.verdict, 'unknown');
});

test('safeOrigin：file:// 与非法输入返回 null', () => {
    assert.equal(safeOrigin('file:///E:/a'), null);
    assert.equal(safeOrigin(''), null);
    assert.equal(safeOrigin('abc'), null);
    assert.equal(safeOrigin('https://a.com/x'), 'https://a.com');
});

test('isFileUrl：正确识别 file 协议', () => {
    assert.equal(isFileUrl('file:///E:/a'), true);
    assert.equal(isFileUrl('FILE:///E:/a'), true);
    assert.equal(isFileUrl('https://a.com'), false);
    assert.equal(isFileUrl(null), false);
});

// ───────── C1：时间线 ─────────
const NOWNOW = new Date('2026-10-25T12:00:00').getTime();
const bk = (name, iso, bytes, kind = 'auto', gen = 1) => ({ name, createdAt: iso, totalBytes: bytes, kind, gen, fileCount: 10 });

test('★ groupBackupsByDay：同日 3 份 + 昨天 2 份 ⇒ 2 组，组内倒序', () => {
    const list = [
        bk('a1', '2026-10-25T08:00:00', 100),
        bk('a2', '2026-10-25T10:00:00', 200),
        bk('a3', '2026-10-25T09:00:00', 150),
        bk('b1', '2026-10-24T08:00:00', 300),
        bk('b2', '2026-10-24T20:00:00', 400)
    ];
    const r = groupBackupsByDay(list, { now: NOWNOW });
    assert.equal(r.days.length, 2);
    assert.equal(r.days[0].label, '今天');
    assert.equal(r.days[1].label, '昨天');
    assert.equal(r.days[0].items.length, 3);
    assert.deepEqual(r.days[0].items.map((i) => i.name), ['a2', 'a3', 'a1'], '天内按时间倒序');
    assert.equal(r.total, 5);
    assert.equal(r.totalBytes, 1150);
});

test('groupBackupsByDay：空数组 ⇒ 空 days、不抛错', () => {
    const r = groupBackupsByDay([], { now: NOWNOW });
    assert.deepEqual(r.days, []);
    assert.equal(r.total, 0);
    assert.equal(r.totalBytes, 0);
});

test('groupBackupsByDay：非数组入参不抛错', () => {
    assert.deepEqual(groupBackupsByDay(null).days, []);
});

test('★ groupBackupsByDay：默认只展开最近 3 天', () => {
    const list = [];
    for (let i = 0; i < 6; i++) {
        const d = new Date(NOWNOW - i * 86400000).toISOString();
        list.push(bk(`x${i}`, d, 10));
    }
    const r = groupBackupsByDay(list, { now: NOWNOW });
    assert.equal(r.days.filter((d) => d.expanded).length, 3);
    assert.equal(r.days.length, 6);
});

test('groupBackupsByDay：invalid createdAt 归入「时间未知」且可展开', () => {
    const r = groupBackupsByDay([bk('bad', 'not-a-date', 5)], { now: NOWNOW });
    assert.equal(r.days[0].key, 'unknown');
    assert.equal(r.days[0].label, '时间未知');
    assert.equal(r.days[0].expanded, true);
    assert.equal(r.days[0].items[0].timeLabel, '—');
});

test('groupBackupsByDay：kind 未知值归一为 auto', () => {
    const r = groupBackupsByDay([bk('k', '2026-10-25T08:00:00', 1, 'weird')], { now: NOWNOW });
    assert.equal(r.days[0].items[0].kind, 'auto');
});

// ───────── C2：占用榜 ─────────
test('★ computeStorageRanking：降序正确，合计 = 各份之和 + 当前占用', () => {
    const list = [bk('a', '2026-10-25T08:00:00', 100), bk('b', '2026-10-25T09:00:00', 500), bk('c', '2026-10-25T10:00:00', 300)];
    const r = computeStorageRanking(list, 1000);
    assert.deepEqual(r.items.map((i) => i.name), ['b', 'c', 'a']);
    assert.equal(r.backupBytes, 900);
    assert.equal(r.currentBytes, 1000);
    assert.equal(r.grandTotal, 1900);
    assert.equal(r.grandTotal, r.backupBytes + r.currentBytes, '校验等式');
});

test('★ computeStorageRanking：当前占用不可用 ⇒ currentBytes=null 且标记，不用 0 冒充', () => {
    const r = computeStorageRanking([bk('a', '2026-10-25T08:00:00', 100)], null);
    assert.equal(r.currentBytes, null);
    assert.equal(r.currentUnavailable, true);
    assert.equal(r.grandTotal, 100, 'null 不计入合计');
});

test('computeStorageRanking：topN 截断但 totalCount 反映全量', () => {
    const list = Array.from({ length: 30 }, (_, i) => bk(`b${i}`, '2026-10-25T08:00:00', i * 10));
    const r = computeStorageRanking(list, 0, { topN: 5 });
    assert.equal(r.items.length, 5);
    assert.equal(r.shownCount, 5);
    assert.equal(r.totalCount, 30);
});

test('computeStorageRanking：空列表各项为 0 / null，不抛错', () => {
    const r = computeStorageRanking([], null);
    assert.equal(r.totalCount, 0);
    assert.equal(r.backupBytes, 0);
    assert.equal(r.grandTotal, 0);
});

test('computeStorageRanking：负数/非数字字节按 0 计；负数当前占用视为「不可用」', () => {
    const r = computeStorageRanking([bk('a', '2026-10-25T08:00:00', -50), { name: 'b', createdAt: '', totalBytes: 'x' }], -10);
    assert.equal(r.backupBytes, 0, '负字节按 0 计');
    assert.equal(r.currentBytes, null, '负数当前占用不合法 ⇒ 判为不可用（不用 0 冒充）');
    assert.equal(r.currentUnavailable, true);
});

// ───────── C4：游玩状态 ─────────
test('★ describePlayStats：今天玩过 / 已 N 天未备份（≥3 天告警）', () => {
    const card = {
        lastOpenedAt: NOWNOW - 3600000,       // 1 小时前
        totalPlayMs: 45_000_000,
        backupStats: { lastBackupAt: NOWNOW - 4 * 86400000, count: 3, lastSize: 123 }
    };
    const r = describePlayStats(card, NOWNOW);
    assert.equal(r.playLabel, '今天玩过');
    assert.equal(r.totalPlayLabel, '12 小时 30 分');
    assert.equal(r.backupLabel, '已 4 天未备份');
    assert.equal(r.backupWarn, true);
    assert.equal(r.backupCount, 3);
});

test('describePlayStats：从未游玩 / 还没有备份 ⇒ 告警', () => {
    const r = describePlayStats({}, NOWNOW);
    assert.equal(r.playLabel, '从未游玩');
    assert.equal(r.backupLabel, '还没有备份');
    assert.equal(r.backupWarn, true);
    assert.equal(r.totalPlayLabel, '0 分钟');
});

test('describePlayStats：昨天玩过 / 今天已备份 ⇒ 不告警', () => {
    const r = describePlayStats({
        lastOpenedAt: NOWNOW - 86400000, totalPlayMs: 1000,
        backupStats: { lastBackupAt: NOWNOW - 1000, count: 1 }
    }, NOWNOW);
    assert.equal(r.playLabel, '昨天玩过');
    assert.equal(r.backupLabel, '今天已备份');
    assert.equal(r.backupWarn, false);
});

test('describePlayStats：2 天未备份不告警（阈值 3 天）', () => {
    const r = describePlayStats({ lastOpenedAt: NOWNOW, backupStats: { lastBackupAt: NOWNOW - 2 * 86400000 } }, NOWNOW);
    assert.equal(r.backupWarn, false);
});

test('describePlayStats：空对象不抛错', () => {
    const r = describePlayStats(null, NOWNOW);
    assert.equal(r.lastOpenedAt, 0);
});

test('★ sortByRecentPlay：按最近游玩降序，过滤掉从未游玩的', () => {
    const cards = [
        { name: 'A', lastOpenedAt: NOWNOW - 3 * 86400000 },
        { name: 'B', lastOpenedAt: NOWNOW - 3600000 },
        { name: 'C', lastOpenedAt: 0 },
        { name: 'D', lastOpenedAt: NOWNOW - 86400000 }
    ];
    const r = sortByRecentPlay(cards, { topN: 5, now: NOWNOW });
    assert.deepEqual(r.map((x) => x.card.name), ['B', 'D', 'A']);
    assert.equal(r[0].stats.playLabel, '今天玩过');
});

test('sortByRecentPlay：topN 生效', () => {
    const cards = Array.from({ length: 10 }, (_, i) => ({ name: `c${i}`, lastOpenedAt: NOWNOW - i * 1000 }));
    assert.equal(sortByRecentPlay(cards, { topN: 3, now: NOWNOW }).length, 3);
});

test('sortByRecentPlay：非数组入参不抛错', () => {
    assert.deepEqual(sortByRecentPlay(null), []);
});

// ───────── 格式化 ─────────
test('★ formatDuration：边界正确', () => {
    assert.equal(formatDuration(0), '0 分钟');
    assert.equal(formatDuration(59_999), '0 分钟');
    assert.equal(formatDuration(60_000), '1 分钟');
    assert.equal(formatDuration(90_000), '1 分钟');
    assert.equal(formatDuration(3_600_000), '1 小时');
    assert.equal(formatDuration(45_000_000), '12 小时 30 分');
    assert.equal(formatDuration(-100), '0 分钟');
    assert.equal(formatDuration('abc'), '0 分钟');
});

test('formatBytes：多档位正确', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1024 * 1024), '1.00 MB');
    assert.equal(formatBytes(1024 * 1024 * 1024), '1.00 GB');
    assert.equal(formatBytes(-5), '0 B');
});
