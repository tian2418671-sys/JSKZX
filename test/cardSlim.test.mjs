import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isSlim, slimCard, ensureCardFull, ensureCardsFull, slimStats, SLIM_DESC_LIMIT
} from '../js/utils/cardSlim.js';

/**
 * P1a 契约测试：**压缩后可无损还原，且保持 `item.data` 对象身份**
 *
 * 为什么身份必须保住：全项目有 ~40 处 `library.value.find(item => item.data === cardData.value)`
 * （高亮当前卡 / 标签 / 分组 / 快照 / 查重全靠它）。压缩与还原**只能在原对象上原地增删字段**，
 * 不能替换 item.data，否则这些地方会集体失效。
 *
 * 为什么必须先压缩后还原：22k 卡实测堆 2,891MB，其中内嵌世界书词条正文 1,163MB（429,144 条）
 * —— 列表/排序/搜索索引都不需要这些重字段，只有「打开某张卡」和少数显式操作（查重/AI 打标/全局资产）才需要。
 */

/** 造一张「重字段齐全」的卡（V2 结构） */
const makeHeavyCard = (i = 1) => {
    const entries = [];
    for (let e = 0; e < 20; e++) {
        entries.push({
            keys: [`触发${e}`, `key${e}`],
            secondary_keys: [`次${e}`],
            content: `世界书正文${e} `.repeat(200),
            comment: `词条${e}`,
            enabled: true,
            constant: e % 3 === 0,
            insertion_order: 100 + e,
            order: 100 + e
        });
    }
    const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: `角色${i}`,
            description: '描述'.repeat(500),
            personality: '性格'.repeat(200),
            scenario: '场景'.repeat(100),
            first_mes: '开场白'.repeat(300),
            mes_example: '示例'.repeat(200),
            system_prompt: '系统提示'.repeat(50),
            post_history_instructions: '历史后注入'.repeat(50),
            alternate_greetings: ['附加问候1'.repeat(100), '附加问候2'.repeat(100)],
            tags: ['仙侠', '测试'],
            create_date: '2025-01-01T00:00:00.000Z',
            character_book: { name: '书', entries },
            extensions: { regex_scripts: [{ scriptName: 'r1', findRegex: 'x', replaceString: 'y' }] }
        }
    };
    return {
        id: 'card_' + i,
        path: `C:\\lib\\角色${i}.png`,
        name: `角色${i}`,
        _mtime: 1000 + i,
        _size: 5000 + i,
        _tokens: 12345,          // 扫描期算好的 token 数（压缩后列表排序仍要用）
        category: '仙侠',
        customTags: ['仙侠'],
        avatar: 'local-file://img/?path=x',
        data: card
    };
};

const clone = (v) => JSON.parse(JSON.stringify(v));

test('slimCard：丢掉世界书正文/附加问候语，保留列表/排序/索引/打标需要的一切', () => {
    const item = makeHeavyCard();
    const ref = item.data;
    const before = JSON.stringify(clone(item.data)).length;

    assert.equal(isSlim(item), false);
    const ok = slimCard(item, { keepDetail: false });
    assert.equal(ok, true);
    assert.equal(isSlim(item), true);
    assert.equal(item.data, ref, '必须原地压缩，不能替换 item.data');

    const d = item.data.data;
    // 保留（这些字段被列表之外的功能广泛使用：AI 打标拼 prompt / 查重差异 / Token 估算）
    assert.equal(d.name, '角色1');
    assert.deepEqual(d.tags, ['仙侠', '测试']);
    assert.equal(d.create_date, '2025-01-01T00:00:00.000Z');
    assert.equal(d.description, '描述'.repeat(500), '描述必须保留（打标/查重要用）');
    assert.equal(d.first_mes, '开场白'.repeat(300), '开场白必须保留（打标要用）');
    assert.ok(d.extensions, '正则脚本等扩展必须保留');
    assert.equal(item._tokens, 12345, 'token 数必须保留（列表排序用）');
    assert.equal(item._hasBook, true);
    assert.equal(item._bookCount, 20);
    assert.equal(item._descShort.length, SLIM_DESC_LIMIT, '列表用描述应截断保存');
    // 丢弃：世界书词条正文（占全部文本 88%）与附加问候语
    assert.equal(d.character_book.entries.length, 20, '词条对象本身必须保留（keys/开关/注入要用）');
    assert.equal(d.character_book.entries[0].content, '', '词条正文必须清空');
    assert.deepEqual(d.character_book.entries[0].keys, ['触发0', 'key0'], '触发词必须保留');
    assert.equal(d.alternate_greetings, undefined);
    assert.ok(JSON.stringify(item.data).length < before / 2, '压缩后体积应明显下降');
});

test('slimCard：keepDetail 的卡（当前打开的那张）不动', () => {
    const item = makeHeavyCard(2);
    assert.equal(slimCard(item, { keepDetail: true }), false);
    assert.equal(isSlim(item), false);
    assert.equal(item.data.data.character_book.entries[0].content.length > 0, true, '当前编辑的卡必须保持完整');
});

test('ensureCardFull：按 path 重新加载并**原地还原**（身份不变、内容一致）', async () => {
    const item = makeHeavyCard(3);
    const ref = item.data;
    const disk = clone(item.data);                 // 模拟磁盘上的完整卡

    slimCard(item);
    assert.equal(isSlim(item), true);

    let asked = null;
    const loader = async (p) => { asked = p; return clone(disk); };
    const ok = await ensureCardFull(item, loader);

    assert.equal(ok, true);
    assert.equal(asked, item.path, '必须按卡片 path 去加载');
    assert.equal(item.data, ref, '还原也必须原地进行');
    assert.equal(isSlim(item), false);
    const d = item.data.data;
    assert.equal(d.character_book.entries.length, 20, '词条必须在');
    assert.equal(d.character_book.entries[0].content, '世界书正文0 '.repeat(200), '词条正文必须被填回');
    assert.equal(d.character_book.entries[19].content, '世界书正文19 '.repeat(200));
    assert.equal(d.first_mes, '开场白'.repeat(300));
    assert.equal(d.alternate_greetings.length, 2, '附加问候语必须回来');
    assert.equal(d.description, '描述'.repeat(500));
});

test('ensureCardFull：已完整的卡直接返回，不触发加载', async () => {
    const item = makeHeavyCard(4);
    let called = 0;
    const ok = await ensureCardFull(item, async () => { called++; return null; });
    assert.equal(ok, true);
    assert.equal(called, 0, '未压缩的卡不该产生一次磁盘读取');
});

test('ensureCardFull：loader 必须收到 (path, item) 两参（PK-14 契约 —— 调用方要用 item._size 读 PNG 内嵌）', async () => {
    const item = makeHeavyCard(6);
    const disk = clone(item.data);
    slimCard(item);
    let gotPath = null, gotItem = null;
    const ok = await ensureCardFull(item, async (p, it) => { gotPath = p; gotItem = it; return clone(disk); });
    assert.equal(ok, true);
    assert.equal(gotPath, item.path);
    assert.equal(gotItem, item, '第二参必须是库条目本体（取 _size/_mtime 用）');
    assert.equal(gotItem._size, 5006);
});

test('ensureCardFull：加载失败时保持压缩态、不破坏现有数据', async () => {
    const item = makeHeavyCard(5);
    slimCard(item);
    const ok = await ensureCardFull(item, async () => null);
    assert.equal(ok, false);
    assert.equal(isSlim(item), true);
    assert.equal(item.data.data.name, '角色5', '原有小字段不能被清掉');
});

test('V1 扁平卡（无 data 层）也能压缩/还原', async () => {
    const flat = {
        id: 'card_v1', path: 'C:\\lib\\v1.png', name: 'V1卡', _tokens: 7, _mtime: 1, _size: 2,
        data: {
            name: 'V1卡', description: 'D'.repeat(300), first_mes: 'F'.repeat(100), tags: ['a'],
            character_book: { entries: [{ key: 'k', content: 'C'.repeat(500), comment: 'c' }] }
        }
    };
    const disk = clone(flat.data);
    slimCard(flat);
    assert.equal(flat.data.character_book.entries[0].content, '', 'V1 扁平卡的词条正文也要清');
    assert.equal(flat.data.description, 'D'.repeat(300), '描述保留');
    const ok = await ensureCardFull(flat, async () => clone(disk));
    assert.equal(ok, true);
    assert.equal(flat.data.character_book.entries[0].content, 'C'.repeat(500), '词条正文要填回');
});

test('ensureCardsFull：批量还原（全局资产库/全库词条搜索面板用）', async () => {
    const lib = [makeHeavyCard(21), makeHeavyCard(22), makeHeavyCard(23)];
    const disks = lib.map((it) => clone(it.data));
    lib.forEach((it) => slimCard(it));
    const n = await ensureCardsFull(lib, async (p) => {
        const i = Number(String(p).match(/(\d+)\.png$/)[1]) - 21;
        return clone(disks[i]);
    }, 2);
    assert.equal(n, 3);
    assert.equal(lib.every((it) => !isSlim(it)), true);
    assert.equal(lib[0].data.data.character_book.entries[0].content.length > 0, true);
});

test('slimStats：统计压缩状态（压测前后对比用）', () => {
    const lib = [makeHeavyCard(11), makeHeavyCard(12), makeHeavyCard(13)];
    slimCard(lib[0]);
    slimCard(lib[1]);
    const s = slimStats(lib);
    assert.equal(s.total, 3);
    assert.equal(s.slim, 2);
    assert.equal(s.full, 1);
});

// ══════════════════════════════════════════════════════════════
// 🔌 PK-31（2026-09-25）：**注册式统一入口** —— 让任何模块都能保证「读到的是正文」
//     🐞 病根：加载器过去是逐处注入的 ⇒ 后来新增的消费者（全库词条搜索）漏了注入、
//        差异比对又撞上「查重收尾把正文交还」⇒ **读到空串却当真**，输出「（无正文）」空结论。
// ══════════════════════════════════════════════════════════════
import { setCardBodyLoader, hasCardBodyLoader, ensureFullBody } from '../js/utils/cardSlim.js';

/** 造一张「瘦身态」卡（词条正文已清空、_slim=true） */
function makeSlimItem(name) {
    return {
        path: '/x/' + name + '.png',
        _slim: true,
        data: { data: { name, character_book: { entries: [{ comment: 'a', content: '' }] } } }
    };
}
/** 假加载器：把正文补回去（模拟 App.vue 的 loadFullCardFromDisk） */
const fakeLoader = async (path, item) => ({
    data: { name: item.data.data.name, character_book: { entries: [{ comment: 'a', content: '正文' + path }] } }
});

test('★ 契约：未注册加载器时 → 报 unavailable（**绝不静默返回空**）', async () => {
    setCardBodyLoader(null);
    assert.equal(hasCardBodyLoader(), false);
    const it = makeSlimItem('a');
    const r = await ensureFullBody(it, { silent: true });
    assert.equal(r.unavailable, true, '缺加载器必须让调用方知道（否则又会把空正文当真）');
    assert.equal(isSlim(it), true, '未还原成功时保持瘦身态（不假装完整）');
});

test('注册后：瘦身卡被读回，且是非瘦身态返回零成本', async () => {
    setCardBodyLoader(fakeLoader);
    assert.equal(hasCardBodyLoader(), true);
    const it = makeSlimItem('b');
    const r = await ensureFullBody(it, { silent: true });
    assert.equal(r.unavailable, false);
    assert.equal(r.restored, 1);
    assert.equal(isSlim(it), false, '读回成功后应摘掉 _slim');
    assert.equal(it.data.data.character_book.entries[0].content, '正文/x/b.png', '正文必须真的回来了');

    const fresh = { path: '/x/full.png', data: { data: { name: 'f' } } };   // 本来就完整
    const r2 = await ensureFullBody(fresh, { silent: true });
    assert.equal(r2.total, 0, '非瘦身卡不计入待办（零成本）');
    setCardBodyLoader(null);
});

test('批量：多张瘦身卡一次读回；数组/单张两种入参都支持', async () => {
    setCardBodyLoader(fakeLoader);
    const list = [makeSlimItem('c1'), makeSlimItem('c2'), { path: '/x/ok.png', data: {} }];
    const r = await ensureFullBody(list, { silent: true });
    assert.equal(r.total, 2, '只把瘦身的那两张算进总数');
    assert.equal(r.restored, 2);
    assert.ok(list.slice(0, 2).every(x => !isSlim(x)));
    setCardBodyLoader(null);
});
