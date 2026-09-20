/**
 * 命令注册表单元测试（P2-A）
 * 关注四件事（对应方案 §三 P2-1 的评审补充意见）：
 *   1. 快捷键归一化与事件解析（`Ctrl+Shift+P` 各种写法等价）
 *   2. `when` 只支持单值比较 + 语法不认识时**宽松放行**（不藏命令）
 *   3. **id 重复 / 快捷键冲突一律拒绝**（后注册拒绝 + 明确报错，不静默覆盖）
 *   4. 执行未知命令 / 命令抛错**不抛给调用方**（单条命令出错不拖垮宿主）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
    normalizeShortcut,
    shortcutFromEvent,
    evaluateWhen,
    createCommandRegistry
} from '../js/utils/commandRegistry.js';

// ---------- 快捷键归一化 ----------

test('normalizeShortcut：大小写 / 空格 / 修饰键顺序不敏感', () => {
    assert.strictEqual(normalizeShortcut('Ctrl+O'), 'ctrl+o');
    assert.strictEqual(normalizeShortcut('ctrl + o'), 'ctrl+o');
    assert.strictEqual(normalizeShortcut('CTRL+O'), 'ctrl+o');
    assert.strictEqual(normalizeShortcut('Shift+Ctrl+P'), 'ctrl+shift+p');
    assert.strictEqual(normalizeShortcut('Ctrl+Shift+P'), 'ctrl+shift+p');
    assert.strictEqual(normalizeShortcut('shift+ctrl+p'), 'ctrl+shift+p');
});

test('normalizeShortcut：空值 / 非字符串 → 空串', () => {
    assert.strictEqual(normalizeShortcut(''), '');
    assert.strictEqual(normalizeShortcut(null), '');
    assert.strictEqual(normalizeShortcut(undefined), '');
    assert.strictEqual(normalizeShortcut('  '), '');
    assert.strictEqual(normalizeShortcut('+'), '');
});

test('shortcutFromEvent：从键盘事件还原归一化快捷键', () => {
    assert.strictEqual(shortcutFromEvent({ ctrlKey: true, key: 's' }), 'ctrl+s');
    assert.strictEqual(shortcutFromEvent({ ctrlKey: true, shiftKey: true, key: 'P' }), 'ctrl+shift+p');
    assert.strictEqual(shortcutFromEvent({ key: 'Escape' }), 'escape');
    assert.strictEqual(shortcutFromEvent({ ctrlKey: true, key: 'Control' }), 'ctrl', '只按修饰键时不把修饰键再当主键');
    assert.strictEqual(shortcutFromEvent(null), '');
});

// ---------- when 条件 ----------

test('evaluateWhen：空条件恒为真', () => {
    assert.strictEqual(evaluateWhen('', {}), true);
    assert.strictEqual(evaluateWhen(undefined, {}), true);
    assert.strictEqual(evaluateWhen(null, {}), true);
});

test('evaluateWhen：单值相等比较（== 与 === 等价）', () => {
    assert.strictEqual(evaluateWhen("appMode == 'worldbooks'", { appMode: 'worldbooks' }), true);
    assert.strictEqual(evaluateWhen("appMode == 'worldbooks'", { appMode: 'cards' }), false);
    assert.strictEqual(evaluateWhen("appMode === 'cards'", { appMode: 'cards' }), true);
    assert.strictEqual(evaluateWhen("  appMode   ==   'cards'  ", { appMode: 'cards' }), true);
});

test('evaluateWhen：支持点号路径（一级嵌套）', () => {
    assert.strictEqual(evaluateWhen("ui.compact == 'true'", { ui: { compact: true } }), true);
    assert.strictEqual(evaluateWhen("ui.compact == 'false'", { ui: { compact: true } }), false);
});

test('evaluateWhen：上下文缺键 → false（不是"宽松放行"）', () => {
    assert.strictEqual(evaluateWhen("hasCard == 'x'", {}), false);
    assert.strictEqual(evaluateWhen("a.b == 'x'", {}), false);
    assert.strictEqual(evaluateWhen("a.b == 'x'", { a: null }), false);
});

test('evaluateWhen：语法不支持时宽松放行（v1 不做表达式引擎，宁可多显示也不藏命令）', () => {
    assert.strictEqual(evaluateWhen("appMode == 'cards' && hasCard == 'true'", { appMode: 'cards' }), true);
    assert.strictEqual(evaluateWhen("!isBusy", { isBusy: true }), true);
    // eslint-disable-next-line no-template-curly-in-string
    assert.strictEqual(evaluateWhen('appMode == x', { appMode: 'cards' }), true);
});

// ---------- 注册与冲突 ----------

function makeCmd(over = {}) {
    return { id: 'test.a', title: '测试命令', run: () => {}, ...over };
}

test('register：缺 id / title / run 一律拒绝并记录问题', () => {
    const reg = createCommandRegistry();
    assert.strictEqual(reg.register(null), false);
    assert.strictEqual(reg.register({ title: 'x', run: () => {} }), false);
    assert.strictEqual(reg.register({ id: 'x', run: () => {} }), false);
    assert.strictEqual(reg.register({ id: 'x', title: 'y' }), false);
    assert.strictEqual(reg.list().length, 0);
    assert.strictEqual(reg.getProblems().length, 4);
});

test('register：允许用 titleFn 提供动态标题（无静态 title）', () => {
    const reg = createCommandRegistry();
    assert.strictEqual(reg.register({ id: 'dyn', titleFn: () => '动态标题', run: () => {} }), true);
    assert.strictEqual(reg.register({ id: 'dyn2', titleFn: () => '', run: () => {} }), true, 'titleFn 存在即可（返回值可为空）');
    assert.strictEqual(reg.getProblems().length, 0);
});

test('register：既无 title 也无 titleFn → 拒绝', () => {
    const reg = createCommandRegistry();
    assert.strictEqual(reg.register({ id: 'noTitle', run: () => {} }), false);
    assert.strictEqual(reg.getProblems()[0].type, 'invalid');
});

test('register：保留快捷键原始显示文案（shortcut），另存归一化匹配键（shortcutKey）', () => {
    const reg = createCommandRegistry();
    reg.register(makeCmd({ id: 'a', title: 'A', shortcut: 'Ctrl+Shift+P' }));
    const cmd = reg.get('a');
    assert.strictEqual(cmd.shortcut, 'Ctrl+Shift+P', '菜单显示用原始文案（不得小写化）');
    assert.strictEqual(cmd.shortcutKey, 'ctrl+shift+p', '匹配用归一化键');
    assert.strictEqual(reg.findShortcut('ctrl+shift+p'), 'a');
});

test('register：id 重复 → 拒绝后注册者，保留先注册者', () => {
    const reg = createCommandRegistry();
    reg.register(makeCmd({ id: 'dup', title: '先注册' }));
    const okSecond = reg.register(makeCmd({ id: 'dup', title: '后注册' }));
    assert.strictEqual(okSecond, false);
    assert.strictEqual(reg.get('dup').title, '先注册');
    assert.strictEqual(reg.list().length, 1);
    const p = reg.getProblems();
    assert.strictEqual(p.length, 1);
    assert.strictEqual(p[0].type, 'duplicate-id');
});

test('register：快捷键冲突 → 拒绝后注册者（评审要求：不静默覆盖）', () => {
    const reg = createCommandRegistry();
    reg.register(makeCmd({ id: 'a', title: 'A', shortcut: 'Ctrl+S' }));
    const ok = reg.register(makeCmd({ id: 'b', title: 'B', shortcut: 'ctrl+s' }));
    assert.strictEqual(ok, false, '大小写不同的同一快捷键也算冲突');
    assert.strictEqual(reg.findShortcut('ctrl+s'), 'a');
    const p = reg.getProblems();
    assert.strictEqual(p.length, 1);
    assert.strictEqual(p[0].type, 'shortcut-conflict');
    assert.ok(p[0].reason.includes('A'), '报错信息应指出占用者');
});

test('register：不写快捷键的命令可共存', () => {
    const reg = createCommandRegistry();
    assert.strictEqual(reg.register(makeCmd({ id: 'a', title: 'A' })), true);
    assert.strictEqual(reg.register(makeCmd({ id: 'b', title: 'B' })), true);
    assert.strictEqual(reg.getProblems().length, 0);
});

test('registerMany：逐条注册，失败的跳过并计入问题', () => {
    const reg = createCommandRegistry();
    const n = reg.registerMany([
        makeCmd({ id: 'a', title: 'A' }),
        makeCmd({ id: 'a', title: 'A 重复' }),
        makeCmd({ id: 'b', title: 'B' })
    ]);
    assert.strictEqual(n, 2);
    assert.strictEqual(reg.getProblems().length, 1);
});

// ---------- 排序与菜单渲染 ----------

test('list：按 menu / section / order 稳定排序', () => {
    const reg = createCommandRegistry();
    reg.register(makeCmd({ id: 'f2', title: 'F2', menu: 'file', section: 2, order: 1 }));
    reg.register(makeCmd({ id: 'f1', title: 'F1', menu: 'file', section: 1, order: 99 }));
    reg.register(makeCmd({ id: 'e1', title: 'E1', menu: 'edit', section: 1, order: 1 }));
    reg.register(makeCmd({ id: 'f3', title: 'F3', menu: 'file', section: 1, order: 2 }));
    assert.deepStrictEqual(reg.list().map(c => c.id), ['e1', 'f3', 'f1', 'f2']);
});

test('listByMenu：按 section 分组（供模板渲染分隔线）', () => {
    const reg = createCommandRegistry();
    reg.register(makeCmd({ id: 'a', title: 'A', menu: 'file', section: 1, order: 1 }));
    reg.register(makeCmd({ id: 'b', title: 'B', menu: 'file', section: 1, order: 2 }));
    reg.register(makeCmd({ id: 'c', title: 'C', menu: 'file', section: 2, order: 1 }));
    reg.register(makeCmd({ id: 'd', title: 'D', menu: 'edit', section: 1, order: 1 }));
    const groups = reg.listByMenu('file');
    assert.strictEqual(groups.length, 2);
    assert.deepStrictEqual(groups[0].commands.map(c => c.id), ['a', 'b']);
    assert.deepStrictEqual(groups[1].commands.map(c => c.id), ['c']);
});

test('listByMenu：传 context 时按 when 过滤；不传则不过滤', () => {
    const reg = createCommandRegistry();
    reg.register(makeCmd({ id: 'x', title: 'X', menu: 'view', when: "appMode == 'worldbooks'" }));
    assert.strictEqual(reg.listByMenu('view').length, 1, '不传 context 不过滤');
    assert.strictEqual(reg.listByMenu('view', { appMode: 'worldbooks' }).length, 1);
    assert.strictEqual(reg.listByMenu('view', { appMode: 'cards' }).length, 0);
});

// ---------- 快捷键分发与执行 ----------

test('findShortcut：命中 / 未命中 / 被 when 拦下', () => {
    const reg = createCommandRegistry();
    reg.register(makeCmd({ id: 'save', title: '保存', shortcut: 'Ctrl+S' }));
    reg.register(makeCmd({ id: 'wb', title: '世界书专用', shortcut: 'Ctrl+W', when: "appMode == 'worldbooks'" }));
    assert.strictEqual(reg.findShortcut({ ctrlKey: true, key: 's' }), 'save');
    assert.strictEqual(reg.findShortcut('ctrl+s'), 'save');
    assert.strictEqual(reg.findShortcut('ctrl+q'), null);
    assert.strictEqual(reg.findShortcut('ctrl+w', { appMode: 'worldbooks' }), 'wb');
    assert.strictEqual(reg.findShortcut('ctrl+w', { appMode: 'cards' }), null, 'when 不满足则不派发');
});

test('execute：正常执行并返回 true；支持透传参数', () => {
    const reg = createCommandRegistry();
    let got = null;
    reg.register(makeCmd({ id: 'go', title: 'GO', run: (a, b) => { got = [a, b]; } }));
    assert.strictEqual(reg.execute('go', 1, 'x'), true);
    assert.deepStrictEqual(got, [1, 'x']);
});

test('execute：未知命令 → false + 记录问题（不抛错）', () => {
    const reg = createCommandRegistry();
    assert.strictEqual(reg.execute('nope'), false);
    assert.strictEqual(reg.getProblems().filter(p => p.type === 'unknown-command').length, 1);
});

test('execute：命令执行体抛错 → false + 记录问题（单条命令不拖垮宿主）', () => {
    const reg = createCommandRegistry();
    reg.register(makeCmd({ id: 'boom', title: 'BOOM', run: () => { throw new Error('炸了'); } }));
    assert.strictEqual(reg.execute('boom'), false);
    const p = reg.getProblems().find(x => x.type === 'run-error');
    assert.ok(p && p.reason.includes('炸了'));
});

// ---------- P2-2：多菜单镜像入口 / 分组标题 ----------

test('menu 数组：同一命令可出现在多个菜单（镜像入口共用同一 id）', () => {
    const reg = createCommandRegistry();
    let n = 0;
    const ok = reg.register(makeCmd({
        id: 'appearance.themeDark', title: '🌙 暗夜', menu: ['view', 'settings'], run: () => { n++; }
    }));
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(reg.get('appearance.themeDark').menus, ['view', 'settings'], 'menus 已归一化为数组');
    assert.strictEqual(reg.listByMenu('view').length, 1);
    assert.strictEqual(reg.listByMenu('settings').length, 1);
    assert.strictEqual(reg.listByMenu('file').length, 0);
    // 两处入口执行的是同一条命令（同源）
    reg.listByMenu('view')[0].commands[0].run();
    reg.listByMenu('settings')[0].commands[0].run();
    assert.strictEqual(n, 2);
});

test('menu 为单字符串时兼容（menus 长度为 1，旧写法不受影响）', () => {
    const reg = createCommandRegistry();
    reg.register(makeCmd({ id: 'a', title: 'A', menu: 'file' }));
    assert.deepStrictEqual(reg.get('a').menus, ['file']);
    assert.strictEqual(reg.listByMenu('file').length, 1);
});

test('没有 menu 的命令不进任何菜单（仍可从命令面板执行）', () => {
    const reg = createCommandRegistry();
    reg.register(makeCmd({ id: 'orphan', title: '孤儿' }));
    assert.deepStrictEqual(reg.get('orphan').menus, []);
    assert.strictEqual(reg.listByMenu('file').length, 0);
    assert.strictEqual(reg.list().length, 1, '命令面板取 list()，仍可见');
    assert.strictEqual(reg.execute('orphan'), true);
});

test('listByMenu：sectionTitle 只在分组首条声明处生效', () => {
    const reg = createCommandRegistry();
    reg.register(makeCmd({ id: 't1', title: 'T1', menu: 'tools', section: 4, order: 10, sectionTitle: '🗄️ 维护' }));
    reg.register(makeCmd({ id: 't2', title: 'T2', menu: 'tools', section: 4, order: 20 }));
    reg.register(makeCmd({ id: 't3', title: 'T3', menu: 'tools', section: 5, order: 10 }));
    const groups = reg.listByMenu('tools');
    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups[0].sectionTitle, '🗄️ 维护');
    assert.strictEqual(groups[0].commands.length, 2);
    assert.strictEqual(groups[1].sectionTitle, '', '未声明该字段的分组给出空串而非 undefined');
});

test('list 排序：多菜单命令按 menus[0] 参与排序（不因数组而崩）', () => {
    const reg = createCommandRegistry();
    reg.register(makeCmd({ id: 'z', title: 'Z', menu: ['view', 'settings'], section: 1, order: 10 }));
    reg.register(makeCmd({ id: 'a', title: 'A', menu: 'file', section: 1, order: 10 }));
    const ids = reg.list().map(c => c.id);
    assert.deepStrictEqual(ids, ['a', 'z'], 'file < view');
});

test('listByMenu：按「本菜单」的 section/order 独立排序（不被主菜单名干扰）', () => {
    // 回归用例：曾复用 list() 的顺序 → 多菜单命令在非主菜单里按“主菜单名”排序，
    // 把「标签」菜单里的「反选」「批量加标签」甩到末尾、sectionTitle 分组标题重复出现。
    const reg = createCommandRegistry();
    reg.register(makeCmd({ id: 'edit.selectAll', title: '全选', menu: ['edit', 'tags'], section: 1, order: 20 }));
    reg.register(makeCmd({ id: 'edit.selectInvert', title: '反选', menu: 'tags', section: 1, order: 30 }));
    reg.register(makeCmd({ id: 'tag.batchAdd', title: '批量加标签', menu: 'tags', section: 2, order: 10 }));
    reg.register(makeCmd({ id: 'set.x', title: 'X', menu: ['settings', 'tags'], section: 2, order: 20 }));

    const groups = reg.listByMenu('tags');
    assert.deepStrictEqual(groups.map(g => g.section), [1, 2], '分组按 section 升序');
    assert.deepStrictEqual(
        groups.flatMap(g => g.commands.map(c => c.id)),
        ['edit.selectAll', 'edit.selectInvert', 'tag.batchAdd', 'set.x'],
        'section 1 稳定在前，section 2 随后（与各自的主菜单名无关）'
    );
    // 同一命令在其它菜单里仍保持该菜单自己的分组
    assert.deepStrictEqual(reg.listByMenu('edit').map(g => g.section), [1]);
    assert.deepStrictEqual(reg.listByMenu('edit')[0].commands.map(c => c.id), ['edit.selectAll']);
});

test('listByMenu：sectionTitle 取「本菜单内」该组首条的声明（不串菜单）', () => {
    const reg = createCommandRegistry();
    // 首条（order 10）已声明标题；第二条（order 20）无权覆盖
    reg.register(makeCmd({ id: 'a', title: 'A', menu: ['x', 'y'], section: 1, order: 20 }));
    reg.register(makeCmd({ id: 'b', title: 'B', menu: 'x', section: 1, order: 10, sectionTitle: '🔹 X 菜单标题' }));
    reg.register(makeCmd({ id: 'c', title: 'C', menu: 'y', section: 1, order: 10, sectionTitle: '🔸 Y 菜单标题' }));
    assert.strictEqual(reg.listByMenu('x')[0].sectionTitle, '🔹 X 菜单标题');
    assert.strictEqual(reg.listByMenu('y')[0].sectionTitle, '🔸 Y 菜单标题');
});
