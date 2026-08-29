# DM：世界书导出条目名缺失 BUG 修复 + 世界书库导入角色卡 新功能

> 本文档为**修改方案文档**，未改动任何源码。所有代码块均给出精确的文件、定位锚点与替换内容，可照抄落地。
> 涉及文件：`js/composables/useWorldbookExtras.js`、`js/components/App.vue`、`js/components/EditorPanel.vue`

---

## 修改点总览

| # | 类型 | 文件 | 位置锚点 | 内容 |
|---|------|------|----------|------|
| 1 | 🐛 BUG 修复 | `js/composables/useWorldbookExtras.js` | `extractWorldbookFromCard` 内 `cleanEntries` 映射（L61-69） | 补 `name → comment` 名字映射 + `insertion_order → order` 权重回退 |
| 2 | ✨ 新功能 | `js/components/App.vue` | `ensureCharacterBookEntries`（L2620）之后 | 新增「世界书库 → 角色卡」导入状态与三个函数 |
| 3 | ✨ 新功能 | `js/components/App.vue` | 现有 `<wb-import-modal>`（L298-309）之后 | 注册第二个 WbImportModal 弹窗实例 |
| 4 | ✨ 新功能 | `js/components/App.vue` | ctx 对象「角色卡内嵌世界书细化操作」区（L3692） | 暴露新增状态与函数给子组件 |
| 5 | ✨ 新功能 | `js/components/EditorPanel.vue` | 「📤 提取为世界书」按钮（L220）旁 | 新增「📥 从世界书库导入」按钮 |
| 6 | ✨ 新功能 | `js/components/EditorPanel.vue` | 空状态「此卡片未内置世界书数据」（L335-337） | 空状态同样提供导入入口 |
| 7 | ✨ 新功能 | `js/components/EditorPanel.vue` | setup return 中 `extractWorldbookFromCard: ctx...`（L936）旁 | 解构暴露新函数 |

---

## 一、BUG 反馈：角色卡导出的世界书，条目名字缺失

### 1.1 现象

在角色卡编辑页点「📤 提取为世界书」后，世界书库新增了一本世界书，但打开 Entry IDE 后**词条没有名字**（列表副标题为空、备注栏为空），而在角色卡内嵌编辑器里这些词条的名字是正常显示的。

### 1.2 根因

**字段口径不一致 + 导出时缺失映射。** 两套世界书对「条目名字」的存取字段不同：

| 位置 | 名字字段 | 代码证据 |
|------|----------|----------|
| 角色卡内嵌世界书（卡内编辑器） | `comment`，**兼容回退 `name`**（V1 旧卡 / RisuAI 等第三方卡用 `name`） | `EditorPanel.vue` L238：`{{ entry.comment \|\| entry.name \|\| '未命名条目' }}`；L261 输入框 `:value="entry.comment \|\| entry.name \|\| ''"` |
| 世界书库 Entry IDE（独立世界书） | **只读 `comment`**，无 `name` 回退 | `EditorPanel.vue` L571：`v-if="entry.comment"`；L599 `v-model="currentEntry.comment"`；`useWorldbookEntries.js` L97/L116；`WbImportModal.vue` L35 |

而导出函数 [useWorldbookExtras.js](file:///workspace/js/composables/useWorldbookExtras.js) 的 `extractWorldbookFromCard` 只转换了触发词字段，**没有做名字字段的映射**：

```js
// 现状（L61-69）：只转换了 keys → key、secondary_keys → keysecondary
const cleanEntries = entries.filter(e => e && typeof e === 'object').map(e => {
    const c = JSON.parse(JSON.stringify(e));
    c.key = Array.isArray(e.keys) ? [...e.keys] : (e.keys || []);
    c.keysecondary = Array.isArray(e.secondary_keys) ? [...e.secondary_keys] : (e.secondary_keys || []);
    delete c.keys; delete c.secondary_keys; delete c._collapsed;
    c.uid = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    return c;
});
```

于是：当卡的内嵌词条用 `name` 存名字（旧版/第三方卡）时，卡内编辑器靠 `|| entry.name` 兜底**正常显示**；导出后 `name` 原样写入 JSON，但库 IDE 只认 `comment` → **名字"消失"**。

**交叉证据（同仓库其他入口都做对了映射，唯独此函数漏了）：**

- `useWorldbookExtras.js` L35（JSONL 导入）：`comment: e.comment || e.name || ''`
- `useGlobalEntrySearch.js` L27（全库词条搜索）：`comment: entry.comment || entry.name || ''`

**顺带发现的同源问题（一并修复）：** 导出也未做 `insertion_order → order` 回退。库 IDE 编辑的权重字段是 `order`（`EditorPanel.vue` L610），纯 V2 卡词条只有 `insertion_order`，导出后权重显示为空。本应用自建词条同时含两字段（`addCharacterWorldbookEntry` 里 `insertion_order: 50, order: 100`），所以此前未暴露。

### 1.3 修复代码（修改点 1）

文件：`js/composables/useWorldbookExtras.js`
定位：`extractWorldbookFromCard` 函数内的 `cleanEntries` 映射（约 L61-69），将整段替换为：

```js
        const cleanEntries = entries.filter(e => e && typeof e === 'object').map(e => {
            const c = JSON.parse(JSON.stringify(e));
            // 字段转换：角色卡内嵌（keys/secondary_keys）→ 独立世界书（key/keysecondary）
            c.key = Array.isArray(e.keys) ? [...e.keys] : (e.keys || []);
            c.keysecondary = Array.isArray(e.secondary_keys) ? [...e.secondary_keys] : (e.secondary_keys || []);
            delete c.keys; delete c.secondary_keys; delete c._collapsed;
            // 【BUG 修复】条目名字映射：V1 旧卡/第三方卡词条用 name 存名字，
            // 世界书库 IDE 只读 comment，不映射会导致导出后条目名字缺失
            // （卡内编辑器显示 entry.comment || entry.name，掩盖了该问题）
            c.comment = String(c.comment || c.name || '');
            // 【BUG 修复】权重回退映射：纯 V2 卡词条只有 insertion_order，库 IDE 编辑的是 order 字段
            c.order = c.order ?? c.insertion_order ?? 100;
            c.uid = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            return c;
        });
```

说明：
- 保留 `name` 字段不删除，避免破坏原始数据（`wb:create` 落盘只剔除 `_` 前缀与 `uid`，`name` 会随 JSON 保留，无害）。
- `comment` 已存在的词条不受影响（`||` 短路，不覆盖）。
- 仅新增 2 行映射，改动面最小。

---

## 二、新功能：从世界书库导入词条到角色卡

### 2.1 功能设计

与现有「📤 提取为世界书」（卡 → 库）形成**双向对称**能力：在角色卡编辑页新增「📥 从世界书库导入」，把库中任意世界书的词条勾选后导入当前卡片的内嵌世界书（`character_book.entries`）。

**交互流程**（完全复用现有 `WbImportModal` 弹窗组件，零新组件）：

1. 角色卡「世界书」Tab 点「📥 从世界书库导入」（无内嵌世界书的空卡也可直接导入）；
2. 弹窗① 选择源世界书 → ② 勾选词条 → 确认导入；
3. 词条做**字段转换**后追加到 `safeData.character_book.entries`，并 `refreshCardData()` 刷新 Token 统计（与「新增词条」同口径），随后正常走既有保存流程落盘。

**字段映射表（库 → 卡，与提取方向严格互逆）：**

| 世界书库词条（V3 口径） | 角色卡内嵌词条（V2 口径） | 备注 |
|---|---|---|
| `key: []` | `keys: []` | 主触发词 |
| `keysecondary: []` | `secondary_keys: []` | 次级触发词 |
| `comment` | `comment`（原名保留） | 条目名字，卡内编辑器直接可读 |
| `order` | `insertion_order`（回退链 `insertion_order ?? order ?? 50`） | 权重/优先级 |
| `content` / `constant` / `selective` / `enabled` / `position` | 同名保留 | 两套格式字段名一致 |
| `uid`、`_` 前缀临时字段 | 剔除后重新生成 `uid` | 与 `wb:create`、`confirmImportEntries` 同一清洗口径 |

### 2.2 修改点 2：App.vue 新增导入状态与函数

文件：`js/components/App.vue`
定位：`ensureCharacterBookEntries` 函数定义结束（约 L2620 `};`）之后、`filteredCharacterWorldbookEntries` 计算属性之前，整块插入：

```js
        // =========================================================
        // 📥 从世界书库导入词条到角色卡（与「📤 提取为世界书」反向对称）
        // 复用 WbImportModal 弹窗 UI；字段转换：库（key/keysecondary/order）→ 内嵌（keys/secondary_keys/insertion_order）
        // =========================================================
        const showCardWbImportModal = ref(false);   // 导入弹窗显隐
        const cardWbImportSource = ref(null);       // 当前选中的源世界书
        const cardWbImportCandidates = ref([]);     // 源书词条候选（带临时 _srcUid 做勾选 key）
        const cardWbSelectedEntries = ref([]);      // 用户勾选的词条 _srcUid 集合

        const openCardWbImportModal = () => {
            if (!cardData.value) { nativeAlert('请先打开一张角色卡。', 'warning'); return; }
            if (worldbooks.value.length === 0) { nativeAlert('世界书库为空，请先在世界书模式导入世界书。', 'warning'); return; }
            cardWbImportSource.value = null;
            cardWbImportCandidates.value = [];
            cardWbSelectedEntries.value = [];
            showCardWbImportModal.value = true;
        };

        // 选中源世界书后，展开其词条候选（🛡️ 兼容字典形态 entries，与库内其他入口同一清洗口径）
        const pickCardWbImportSource = (wb) => {
            cardWbImportSource.value = wb;
            let srcEntries = (wb.data && wb.data.entries) || [];
            if (srcEntries && typeof srcEntries === 'object' && !Array.isArray(srcEntries)) {
                srcEntries = Object.values(srcEntries);
            }
            cardWbImportCandidates.value = srcEntries.map((e, i) => ({
                ...e,
                _srcIndex: i,
                _srcUid: e.uid || ('src-' + i)
            }));
            cardWbSelectedEntries.value = [];
        };

        // 确认导入：深拷贝勾选词条 → 库字段转换为内嵌字段 → 追加到 character_book.entries
        const confirmCardWbImport = () => {
            if (!cardWbImportSource.value) { nativeAlert('请先选择源世界书。', 'warning'); return; }
            if (cardWbSelectedEntries.value.length === 0) { nativeAlert('请至少勾选一个词条。', 'warning'); return; }
            const targetEntries = ensureCharacterBookEntries();
            if (!targetEntries) { nativeAlert('请先打开一张角色卡。', 'warning'); return; }

            let count = 0;
            cardWbImportCandidates.value.forEach(c => {
                if (!cardWbSelectedEntries.value.includes(c._srcUid)) return;
                // 深拷贝并剔除 _ 前缀临时字段与 uid，防止污染卡片 JSON（与 wb:create 同一清洗口径）
                const clean = JSON.parse(JSON.stringify(c, (k, v) => (k.startsWith('_') || k === 'uid') ? undefined : v));
                // 字段转换：世界书库（key/keysecondary/order）→ 角色卡内嵌（keys/secondary_keys/insertion_order）
                clean.keys = Array.isArray(c.key) ? [...c.key] : (c.key ? [c.key] : []);
                clean.secondary_keys = Array.isArray(c.keysecondary) ? [...c.keysecondary] : (c.keysecondary ? [c.keysecondary] : []);
                delete clean.key; delete clean.keysecondary;
                clean.insertion_order = c.insertion_order ?? c.order ?? 50;
                clean.uid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                targetEntries.push(clean);
                count++;
            });

            showCardWbImportModal.value = false;
            refreshCardData();
            const srcName = (cardWbImportSource.value.data && cardWbImportSource.value.data.name) || cardWbImportSource.value.name;
            nativeAlert(`📥 已从《${srcName}》导入 ${count} 个词条到角色卡内嵌世界书。`, 'info');
            addLog(`📥 从世界书库《${srcName}》导入 ${count} 个词条到角色卡内嵌世界书`, 'success');
        };
```

### 2.3 修改点 3：App.vue 模板注册第二个 WbImportModal

文件：`js/components/App.vue`
定位：现有「条目级导入合并弹窗」（约 L297-309）`</wb-import-modal>` 结束标签之后，追加：

```html
    <!-- ================= [ 📥 从世界书库导入词条到角色卡弹窗（复用 WbImportModal 子组件） ] ================= -->
    <wb-import-modal
        :show="showCardWbImportModal"
        :active-worldbook-name="safeData.name || '当前角色卡'"
        :source-books="worldbooks"
        :source-book="cardWbImportSource"
        :candidates="cardWbImportCandidates"
        :selected-entries="cardWbSelectedEntries"
        @close="showCardWbImportModal = false"
        @pick-source="pickCardWbImportSource"
        @update:selectedEntries="cardWbSelectedEntries = $event"
        @confirm-import="confirmCardWbImport"
    />
```

说明：`WbImportModal` 是纯 props/emits 驱动的 UI 组件，可直接复用；弹窗内「将导入到当前编辑的「xxx」」会显示当前角色卡名，语境自洽。与书→书导入不同，此处 `source-books` 传**全部**世界书（目标是卡片，无需排除某本书）。

### 2.4 修改点 4：App.vue ctx 暴露新增成员

文件：`js/components/App.vue`
定位：ctx 对象的「🎛️ 角色卡内嵌世界书细化操作」区块（约 L3688-3692），在 `addEntryKey, removeEntryKey, handleEntryKeyInput, updateEntryComment,` 一行之后追加：

```js
            // 📥 从世界书库导入词条到角色卡（与「📤 提取为世界书」对称）
            showCardWbImportModal, cardWbImportSource, cardWbImportCandidates, cardWbSelectedEntries,
            openCardWbImportModal, pickCardWbImportSource, confirmCardWbImport,
```

### 2.5 修改点 5：EditorPanel 工具栏新增按钮

文件：`js/components/EditorPanel.vue`
定位：「📤 提取为世界书」按钮（约 L220）之后，追加同排按钮：

```html
                                    <button @click="openCardWbImportModal" class="text-xs px-2.5 py-1 bg-emerald-600/80 hover:bg-emerald-500 border border-emerald-500/30 rounded text-emerald-100 transition whitespace-nowrap" title="从世界书库勾选词条导入到该卡片内嵌世界书">📥 从世界书库导入</button>
```

（与提取按钮的 amber 配色区分，导入用 emerald，符合应用内"导入=绿色"的既有配色习惯。）

### 2.6 修改点 6：EditorPanel 空状态增加入口

文件：`js/components/EditorPanel.vue`
定位：空状态区块（约 L335-337），替换为：

```html
                    <div v-else class="text-zinc-500 text-center py-10">此卡片未内置世界书数据
                        <button @click="addCharacterWorldbookEntry" class="ml-2 text-blue-400 hover:underline">+ 立即新增一条</button>
                        <button @click="openCardWbImportModal" class="ml-2 text-emerald-400 hover:underline">📥 从世界书库导入</button>
                    </div>
```

（无内嵌世界书的卡是本功能的高频场景：一键建壳 + 批量搬词。`ensureCharacterBookEntries` 会自动创建 `character_book.entries` 数组。）

### 2.7 修改点 7：EditorPanel setup 暴露新函数

文件：`js/components/EditorPanel.vue`
定位：setup return 对象中 `extractWorldbookFromCard: ctx.extractWorldbookFromCard,`（约 L936）之后追加：

```js
            openCardWbImportModal: ctx.openCardWbImportModal,
```

---

## 三、验证清单

### 3.1 BUG 修复验证（修改点 1）

1. 准备一张词条名字存在 `name` 字段的卡（V1 旧卡 / RisuAI 导出卡；或手工把某卡 `character_book.entries[0].comment` 改名为 `name`）；
2. 卡内世界书 Tab 确认条目名正常显示（`comment || name` 兜底）；
3. 点「📤 提取为世界书」→ 打开生成的世界书 → **Entry IDE 列表副标题与「备注」栏应显示条目名**（修复前为空）；
4. 回归：`comment` 正常的卡导出后名字不变、不重复；纯 V2 卡（只有 `insertion_order`）导出后权重列有值。
5. 可选单测（Node 独立跑，不动仓库测试文件）：

```js
// node -e 直接验证映射逻辑
const e = { name: '王国设定', keys: ['王国'], secondary_keys: [], content: '...', insertion_order: 30 };
const c = JSON.parse(JSON.stringify(e));
c.key = Array.isArray(e.keys) ? [...e.keys] : (e.keys || []);
c.keysecondary = Array.isArray(e.secondary_keys) ? [...e.secondary_keys] : (e.secondary_keys || []);
delete c.keys; delete c.secondary_keys; delete c._collapsed;
c.comment = String(c.comment || c.name || '');
c.order = c.order ?? c.insertion_order ?? 100;
console.log(c.comment === '王国设定', c.order === 30); // true true
```

### 3.2 新功能验证（修改点 2-7）

1. 打开一张**无**内嵌世界书的卡 → 世界书 Tab 空状态点「📥 从世界书库导入」→ 选源书 → 勾选若干词条 → 确认：词条出现在卡内列表，名字/触发词/正文/权重/启用状态完整；
2. 打开一张**已有**内嵌世界书的卡 → 重复导入 → 新词条**追加**在尾部，原有词条不受影响；
3. 导入后核对 Raw JSON：词条为 `keys/secondary_keys/insertion_order` 口径，且不含 `key/keysecondary` 与 `_` 前缀临时字段；
4. 保存卡片落盘后重新打开，词条仍在（持久化生效）；
5. 双向闭环：导入后立刻点「📤 提取为世界书」→ 库中新书条目名字/权重正常（两个功能互为逆操作，互验字段映射正确性）；
6. 边界：世界书库为空时点按钮 → 提示「世界书库为空」；不选源书/不勾词条点确认 → 对应警告提示。

---

## 四、设计备注

- **不改动 `WbImportModal.vue`**：其 UI 文案（"从其他世界书导入词条"）对卡导入场景语义兼容，props 全量复用，符合最小改动原则；若后续想区分文案，可为其增加可选 `title`/`hint` props，与本方案正交。
- **不做自动去重**：与既有「书→书导入」行为保持一致（按需人工勾选）；如需去重可后续在 `confirmCardWbImport` 里按 `keys+content` 比对已有词条，属于增量增强。
- **`uid` 保留策略**：卡内嵌词条携带 `uid` 是本应用既有约定（`addCharacterWorldbookEntry`、SillyTavern 世界书同款），导入时统一重新生成，避免与源书/本卡现有词条冲突。
- 修复（修改点 1）与新功能（修改点 2-7）**相互独立**，可分开合入；但建议同版发布，二者共用同一套字段映射语义（见 2.1 映射表），便于回归验证。
