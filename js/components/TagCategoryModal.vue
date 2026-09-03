<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm" @click.self="$emit('close')">
      <div class="w-[940px] max-w-[94vw] max-h-[84vh] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        <!-- 顶部标题栏 -->
        <div class="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between shrink-0 gap-3">
          <span class="text-sm font-bold text-zinc-100">🛠️ 自定义标签大分类</span>
          <span class="text-[10px] text-zinc-500 flex-1 text-right">自定义大分类 · 手动批量 · AI 归类（实验）</span>
          <button @click="$emit('close')" class="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-100 transition-colors shrink-0" title="关闭">✕</button>
        </div>

        <div class="flex flex-1 min-h-0">
          <!-- 左栏：自定义分类管理 -->
          <div class="w-80 shrink-0 border-r border-zinc-800 p-3 overflow-y-auto custom-scrollbar flex flex-col gap-2">
            <div class="text-xs font-bold text-zinc-300">📁 自定义分类 <span class="text-zinc-500 font-normal">({{ customCats.length }})</span></div>

            <div class="flex gap-1.5">
              <input v-model="newCategoryName" @keyup.enter="addCategory" type="text" placeholder="新分类名，如：游戏作品"
                     class="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 text-[11px] px-2 py-1 rounded outline-none text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/50">
              <button @click="addCategory" class="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-[11px] rounded transition font-bold shrink-0">新增</button>
            </div>

            <div v-if="customCats.length === 0" class="text-[11px] text-zinc-600 py-2 px-1 leading-relaxed">
              暂无自定义分类。新增后，它会展现在标签云的「其他」之前，并可在右侧下拉中给未归类标签归属。
            </div>

            <div v-for="cat in customCats" :key="cat.key"
                 class="flex items-center gap-1.5 bg-zinc-800/60 border border-zinc-700 rounded px-2 py-1.5 group">
              <span class="text-sm shrink-0">{{ cat.icon }}</span>
              <template v-if="editingKey === cat.key">
                <input v-model="editingName" @keyup.enter="confirmRename" @keyup.esc="editingKey = ''" type="text"
                       class="flex-1 min-w-0 bg-zinc-900 border border-blue-500 text-[11px] px-1.5 py-0.5 rounded outline-none text-zinc-200">
                <button @click="confirmRename" class="text-[11px] text-blue-400 hover:text-blue-300 font-bold shrink-0" title="确认">✔</button>
                <button @click="editingKey = ''" class="text-[11px] text-zinc-500 hover:text-zinc-300 shrink-0" title="取消">✕</button>
              </template>
              <template v-else>
                <span class="flex-1 min-w-0 truncate text-[12px] text-zinc-200 font-medium">{{ cat.name }}</span>
                <span class="text-[10px] text-zinc-500 shrink-0">{{ countOf(cat.key) }} 个标签</span>
                <button @click="startRename(cat)" class="opacity-0 group-hover:opacity-100 text-[11px] text-zinc-500 hover:text-blue-400 transition-all shrink-0" title="重命名">✏️</button>
                <button @click="removeCategory(cat)" class="opacity-0 group-hover:opacity-100 text-[11px] text-zinc-500 hover:text-red-400 transition-all shrink-0" title="删除分类（其下标签回归自动分类）">🗑️</button>
              </template>
            </div>

            <div class="mt-auto pt-3 border-t border-zinc-800 text-[10px] text-zinc-600 leading-relaxed space-y-1">
              <div>🚀 高效批量归类流程：</div>
              <div>1️⃣ 右侧先选<b class="text-blue-400">目标分类</b>（内置/自定义皆可）</div>
              <div>2️⃣ 勾选标签；或输入<b class="text-blue-400">子串</b>（如 "Fate"、"JoJo"）筛选后点「全选」一次勾中同系列</div>
              <div>3️⃣ 点「📥 归入」一次批量入组，目标分类保持、自动清勾选，可连刷下一批</div>
              <div>💡 手动归属覆盖自动分类（含向量）；删除分类后其下标签回归自动。</div>
            </div>
          </div>

          <!-- 右栏：目标分类驱动 · 批量归属 + 🤖 AI 智能归类（规则即提示词） -->
          <div class="flex-1 min-w-0 p-3 flex flex-col gap-2">
            <!-- 🤖 AI 归类入口/进度条（常驻顶部） -->
            <div class="flex items-center gap-2 rounded border border-violet-500/30 bg-violet-500/5 px-2 py-1.5">
              <span class="text-xs font-bold text-violet-300 shrink-0">� 实验 · AI 归类</span>
              <span v-if="!aiBusy" class="text-[10px] text-zinc-500 flex-1 leading-tight">实验功能：把全部「其他」交给大模型按分类规则语义归类，结果请逐条核对后应用。</span>
              <template v-if="!aiBusy">
                <button @click="runAIClassify"
                        class="px-2.5 py-1 bg-violet-600 hover:bg-violet-500 text-white text-[11px] rounded transition font-bold shrink-0 whitespace-nowrap"
                        title="分批调用大模型，按内置+自定义分类语义为全部未分类标签归类">⚡ 一键归类全部({{ allOtherTags.length }})</button>
                <button v-if="aiSuggestions.length" @click="viewMode = 'ai'"
                        class="px-2.5 py-1 bg-violet-500/15 hover:bg-violet-500/25 text-violet-300 border border-violet-500/30 text-[11px] rounded transition font-bold shrink-0 whitespace-nowrap"
                        title="查看上次 AI 归类建议">📋 AI 建议({{ aiSuggestions.length }})待应用</button>
              </template>
              <span v-else class="text-[11px] text-violet-300 animate-pulse shrink-0 whitespace-nowrap">{{ aiText }}</span>
            </div>

            <!-- 视图 A：手动批量归属 -->
            <template v-if="viewMode === 'manual'">
              <div class="flex items-center gap-2">
                <span class="text-xs font-bold text-zinc-300 shrink-0">🎯 目标分类</span>
                <select v-model="targetKey" class="flex-1 min-w-0 bg-blue-600/15 border border-blue-500/40 text-[12px] font-bold px-2 py-1 rounded outline-none text-blue-200 focus:border-blue-400">
                  <option value="" disabled>—— 先选择要把标签归入的分类 ——</option>
                  <optgroup label="内置分类">
                    <option v-for="cat in builtInCats" :key="cat.key" :value="cat.key">{{ cat.icon }} {{ cat.name }}</option>
                  </optgroup>
                  <optgroup v-if="customCats.length" label="自定义分类">
                    <option v-for="cat in customCats" :key="cat.key" :value="cat.key">{{ cat.icon }} {{ cat.name }}</option>
                  </optgroup>
                </select>
                <button @click="batchAssign" :disabled="!targetKey || selectedTags.size === 0"
                        class="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-35 disabled:cursor-not-allowed text-white text-[12px] font-bold rounded transition shrink-0 whitespace-nowrap">
                  📥 归入{{ targetName ? '「' + targetName + '」' : '' }}({{ selectedTags.size }})
                </button>
              </div>

              <div class="flex items-center gap-1.5">
                <input v-model="otherSearch" type="text" placeholder="搜索标签 / 输入子串后一键全选匹配…"
                       class="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 text-[11px] px-2 py-1 rounded outline-none text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/50">
                <button @click="selectAllShown" :disabled="otherTags.length === 0"
                        class="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-35 disabled:cursor-not-allowed text-white text-[11px] rounded transition font-bold shrink-0 whitespace-nowrap" title="把当前列表(含搜索过滤结果)全部勾选">全选({{ otherTags.length }})</button>
                <button @click="clearSelected" :disabled="selectedTags.size === 0"
                        class="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-35 disabled:cursor-not-allowed text-zinc-200 text-[11px] rounded transition font-bold shrink-0 whitespace-nowrap">清除勾选</button>
              </div>
              <div class="text-[10px] text-zinc-500 -mt-1">「其他」未归类 {{ otherTags.length }} 个 · 已勾选 <span class="text-emerald-400 font-bold">{{ selectedTags.size }}</span> 个</div>

              <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar border border-zinc-700 rounded bg-zinc-800/40 p-1.5">
                <div v-if="otherTags.length === 0" class="text-[11px] text-zinc-600 py-3 text-center">
                  🎉 全部标签均已归类！新入库卡片产生的未知标签会自动出现在这里，供你勾选归属。
                </div>
                <label v-for="tag in otherTags" :key="tag"
                       class="flex items-center gap-2 px-2 py-1 rounded hover:bg-zinc-700/50 transition-colors cursor-pointer select-none">
                  <input type="checkbox" :checked="selectedTags.has(tag)" @change="toggleSelect(tag)" class="rounded accent-emerald-500 shrink-0">
                  <span class="flex-1 min-w-0 truncate text-[11px] text-zinc-200" :title="tag">{{ tag }}</span>
                </label>
              </div>
            </template>

            <!-- 视图 B：AI 归类建议（逐条核对后应用） -->
            <template v-else>
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-bold text-violet-300">� AI 归类建议（实验） <span class="text-zinc-500 font-normal">({{ aiSuggestions.length }} 条 · 下拉可修正)</span></span>
                <div class="flex items-center gap-1.5">
                  <button @click="backToManual" class="px-2 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-[11px] rounded transition font-bold">↩ 返回手动</button>
                  <button @click="applyAISuggestions" :disabled="aiSuggestions.length === 0"
                          class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-[11px] rounded transition font-bold">✅ 应用 {{ aiApplyCount }} 条</button>
                </div>
              </div>
              <div class="text-[10px] text-zinc-500 -mt-1">凡标注「其他(不处理)」的将跳过（作品/IP/人名等保留原样）。</div>
              <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar border border-zinc-700 rounded bg-zinc-800/40 p-1.5">
                <div v-for="s in aiSuggestions" :key="s.tag" class="flex items-center gap-2 px-2 py-1 rounded hover:bg-zinc-700/50 transition-colors">
                  <span class="flex-1 min-w-0 truncate text-[11px] text-zinc-200" :title="s.tag">{{ s.tag }}</span>
                  <select :value="s.cat" @change="s.cat = $event.target.value"
                          :class="s.cat === 'other' ? 'bg-zinc-800 text-zinc-500 border-zinc-700' : 'bg-blue-600/15 text-blue-200 border-blue-500/40'"
                          class="border text-[11px] px-1.5 py-0.5 rounded outline-none font-medium max-w-40 shrink-0 focus:border-blue-400">
                    <option value="other">🏷️ 其他（不处理）</option>
                    <optgroup label="内置分类">
                      <option v-for="cat in builtInCats" :key="cat.key" :value="cat.key">{{ cat.icon }} {{ cat.name }}</option>
                    </optgroup>
                    <optgroup v-if="customCats.length" label="自定义分类">
                      <option v-for="cat in customCats" :key="cat.key" :value="cat.key">{{ cat.icon }} {{ cat.name }}</option>
                    </optgroup>
                  </select>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script>
import { TAG_CATEGORIES, getTagCategory, buildTagClassificationSystemPrompt, buildTagClassificationUserPrompt } from '../utils/tagCategories.js';

export default {
    name: 'TagCategoryModal',
    inject: ['appCtx'],
    emits: ['close'],
    errorCaptured(err) {
        console.error('[tagcat] 渲染错误:', err && err.message, err);
        return false;
    },
    data() {
        return {
            newCategoryName: '',
            editingKey: '',
            editingName: '',
            otherSearch: '',
            targetKey: '',          // 🎯 当前目标分类（批量归入对象）
            selectedTags: new Set(), // ✅ 已勾选待批量归入的「其他」标签
            viewMode: 'manual',     // 'manual' 手动批量 | 'ai' AI 建议核对
            aiBusy: false,          // 🤖 AI 归类进行中
            aiText: '',             // AI 运行状态文案（批次进度）
            aiSuggestions: []       // [{ tag, cat }] AI 建议（可逐条修正）
        };
    },
    computed: {
        ctx() { return this.appCtx; },
        customCats() { return this.ctx.customTagCategories?.value || []; },
        builtInCats() {
            return TAG_CATEGORIES.filter(c => c.key !== 'other');
        },
        targetName() {
            if (!this.targetKey) return '';
            const all = [...this.builtInCats, ...this.customCats];
            const cat = all.find(c => c.key === this.targetKey);
            return cat ? cat.name : this.targetKey;
        },
        otherTags() {
            const q = this.otherSearch.trim().toLowerCase();
            const all = this.ctx.globalAvailableTags?.value || [];
            return all
                .filter(t => getTagCategory(t) === 'other')
                .filter(t => !q || String(t).toLowerCase().includes(q))
                .sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN'));
        },
        // 🤖 全量「其他」（不受搜索过滤，AI 输入全集）
        allOtherTags() {
            const all = this.ctx.globalAvailableTags?.value || [];
            return [...new Set(all.filter(t => getTagCategory(t) === 'other'))]
                .sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN'));
        },
        // ✅ 可应用的 AI 建议数（排除「其他=不处理」）
        aiApplyCount() {
            return this.aiSuggestions.filter(s => s.cat && s.cat !== 'other').length;
        },
        // 合法分类 key 集合（内置非 other + 自定义）
        legalKeys() {
            return new Set(['other', ...this.builtInCats.map(c => c.key), ...this.customCats.map(c => c.key)]);
        }
    },
    methods: {
        // === 左栏：自定义分类管理 ===
        addCategory() {
            const key = this.ctx.addCustomTagCategory(this.newCategoryName);
            if (key) this.newCategoryName = '';
        },
        startRename(cat) {
            this.editingKey = cat.key;
            this.editingName = cat.name;
        },
        confirmRename() {
            if (this.ctx.renameCustomTagCategory(this.editingKey, this.editingName)) {
                this.editingKey = '';
            }
        },
        async removeCategory(cat) {
            const n = this.countOf(cat.key);
            const ok = await this.ctx.confirmDialog(
                `确认删除自定义分类「${cat.name}」？` + (n > 0 ? `其下 ${n} 个手动归类的标签将回归自动分类。` : '')
            );
            if (ok) this.ctx.removeCustomTagCategory(cat.key);
        },
        countOf(key) {
            const assignments = this.ctx.customTagAssignments?.value || {};
            return Object.values(assignments).filter(v => v === key).length;
        },

        // === 右栏：目标分类驱动批量归属 ===
        toggleSelect(tag) {
            const s = new Set(this.selectedTags);
            if (s.has(tag)) s.delete(tag); else s.add(tag);
            this.selectedTags = s;
        },
        selectAllShown() {
            this.selectedTags = new Set(this.otherTags);
        },
        clearSelected() {
            this.selectedTags = new Set();
        },
        // 📥 批量归入目标分类（末尾单次落盘）；完成保持目标分类不变、清空勾选继续下一批
        async batchAssign() {
            if (!this.targetKey || this.selectedTags.size === 0) return;
            const tags = [...this.selectedTags];
            const key = this.targetKey;
            this.ctx.assignTagsToCategory(tags, key);
            this.selectedTags = new Set();
            const catName = this.targetName;
            if (this.ctx.showToast) this.ctx.showToast(`已将 ${tags.length} 个标签归入「${catName}」`, 'success');
        },

        // ============ 🤖 AI 大模型智能归类（规则即提示词） ============
        // 提取 AI 回复文本（复用 App.vue 同结构：OpenAI choices / Anthropic content）
        aiExtractText(result) {
            if (!result || !result.data) return '';
            const d = result.data;
            if (this.ctx.apiType?.value === 'anthropic') {
                return (d.content && d.content[0] && d.content[0].text) || '';
            }
            return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
        },
        // 稳健解析模型 JSON：剥 ```json 围栏，取首个 {…} 块，兼容尾逗号
        parseAIJson(text) {
            if (!text) return null;
            let t = String(text).trim();
            const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
            if (fence) t = fence[1].trim();
            const s = t.indexOf('{');
            const e = t.lastIndexOf('}');
            if (s < 0 || e <= s) return null;
            t = t.slice(s, e + 1).replace(/,\s*([}\]])/g, '$1'); // 去尾逗号
            try {
                const obj = JSON.parse(t);
                if (obj && typeof obj === 'object') return obj;
            } catch (err) { /* 落到下面宽松提取 */ }
            const out = {};
            const re = /["']([^"']+)["']\s*:\s*["']([^"']+)["']/g;
            let m;
            while ((m = re.exec(t)) !== null) out[m[1]] = m[2];
            return out;
        },
        // ⚡ 分批调用大模型，把全量「其他」按分类规则归类
        async runAIClassify() {
            if (this.aiBusy) return;
            const labels = this.allOtherTags;
            console.log('[tagcat] AI 归类点击 → 待分类数 =', labels.length);
            if (labels.length === 0) {
                if (this.ctx.showToast) this.ctx.showToast('当前没有「其他」未归类标签', 'info');
                return;
            }
            const api = this.ctx;
            const endpoint = (api.apiEndpoint && api.apiEndpoint.value || '').trim();
            const apiModelVal = (api.apiModel && api.apiModel.value || '').trim();
            console.log('[tagcat] API 配置: endpoint=', endpoint ? endpoint.replace(/\/?(v1\/)?chat\/completions$/i, '…') : '(空)', 'model=', apiModelVal || '(由 resolveApiModel 兜底)', 'type=', (api.apiType && api.apiType.value) || '');
            if (!endpoint) {
                console.warn('[tagcat] 未配置 API Endpoint');
                if (api.nativeAlert) api.nativeAlert('请先在 ⚙️ 设置 中配置 API Endpoint，才能调用大模型归类。', 'warning');
                return;
            }
            const authKey = (api.apiKey && api.apiKey.value && api.apiKey.value.trim()) ? api.apiKey.value : 'test-key';
            const model = api.resolveApiModel ? api.resolveApiModel() : apiModelVal;
            const apiType = (api.apiType && api.apiType.value) || 'openai';
            const system = buildTagClassificationSystemPrompt(this.customCats);

            const BATCH = 120; // 每批标签数（避免单请求过长/掉质量）
            const batches = [];
            for (let i = 0; i < labels.length; i += BATCH) batches.push(labels.slice(i, i + BATCH));

            this.viewMode = 'manual';
            this.aiBusy = true;
            this.aiText = '准备调用…';
            this.aiSuggestions = [];
            const legal = this.legalKeys;
            const suggestions = [];
            try {
                for (let b = 0; b < batches.length; b++) {
                    this.aiText = `🤖 归类中 批次 ${b + 1}/${batches.length}（${labels.length} 个）…`;
                    const batch = batches[b];
                    const user = buildTagClassificationUserPrompt(batch);
                    const payload = {
                        model,
                        messages: [
                            { role: 'system', content: system },
                            { role: 'user', content: user }
                        ],
                        temperature: 0
                    };
                    console.log(`[tagcat] 发送批次 ${b + 1}/${batches.length}，标签 ${batch.length} 个 → sendChatMessage`);
                    const result = await window.electronAPI.sendChatMessage(endpoint, payload, authKey, apiType);
                    console.log('[tagcat] sendChatMessage 返回 success =', !!(result && result.success), result && result.error ? `(error: ${result.error})` : '');
                    if (!result || !result.success) throw new Error((result && result.error) || 'API 请求失败');
                    const text = this.aiExtractText(result);
                    console.log('[tagcat] 回复长度 =', text ? text.length : 0);
                    const map = this.parseAIJson(text) || {};
                    console.log('[tagcat] 解析出键值 =', Object.keys(map).length);
                    for (let k = 0; k < batch.length; k++) {
                        const tag = batch[k];
                        // 优先“标签原文”为键，回退“序号”为键（模型两种都可能输出）
                        let cat = map[tag];
                        if (cat === undefined && map[String(k)] !== undefined) cat = map[String(k)];
                        suggestions.push({ tag, cat: (cat && legal.has(cat)) ? cat : 'other' });
                    }
                    if (b < batches.length - 1) await new Promise(r => setTimeout(r, 400));
                }
                this.aiSuggestions = suggestions;
                this.aiText = '';
                this.viewMode = 'ai';
                if (api.showToast) api.showToast(`AI 归类完成，共 ${suggestions.length} 条建议（可逐条核对）`, 'success');
            } catch (e) {
                this.aiText = '';
                if (api.nativeAlert) api.nativeAlert(`AI 归类失败：${(e && e.message) || e}`, 'error');
                console.error('[tagcat] AI 归类失败:', e);
            } finally {
                this.aiBusy = false;
            }
        },
        // 返回手动视图（保留 AI 建议，可再切回查看）
        backToManual() {
            this.viewMode = 'manual';
        },
        // ✅ 应用 AI 建议：按分类分组一次批量归属；「其他」= 跳过
        applyAISuggestions() {
            if (this.aiSuggestions.length === 0) return;
            const byKey = {};
            for (const s of this.aiSuggestions) {
                if (s.cat && s.cat !== 'other') {
                    if (!byKey[s.cat]) byKey[s.cat] = [];
                    byKey[s.cat].push(s.tag);
                }
            }
            let total = 0;
            for (const [key, tags] of Object.entries(byKey)) {
                this.ctx.assignTagsToCategory(tags, key);
                total += tags.length;
            }
            this.aiSuggestions = [];
            this.viewMode = 'manual';
            if (this.ctx.showToast) this.ctx.showToast(`已应用 AI 归类 ${total} 条（其余保留「其他」）`, 'success');
        }
    }
};
</script>
