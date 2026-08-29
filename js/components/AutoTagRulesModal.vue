<!--
  AutoTagRulesModal 自动打标规则表设置弹窗（v2.1）
  - 系统预设：内置规则集合（分组展示，默认全部生效，无需逐个添加）
  - 自定义规则：用户手动输入或点击关键词候选添加（持久化到配置）
  ⚠️ 纯 props/emits 组件；模块级常量经 computed 暴露给模板（坑 11）。
-->
<template>
    <transition name="fade">
        <div v-if="show" class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
            <div class="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">

                <div class="px-5 py-4 bg-gray-900 text-white border-b border-gray-800 flex justify-between items-center shrink-0">
                    <h3 class="font-bold text-sm flex items-center gap-2">📝 自动打标规则表</h3>
                    <button @click="$emit('close')" class="text-gray-400 hover:text-white transition">✕ 关闭</button>
                </div>

                <div class="p-5 overflow-y-auto space-y-3 flex-1 custom-scrollbar text-xs">
                    <p class="text-[11px] text-gray-500 leading-relaxed">
                        规则表用于 <strong>「导入自动分类」</strong> 与 <strong>「AI 打标第一层（规则匹配）」</strong>：卡片文本命中任关键词即打对应标签。
                        <strong class="text-blue-600">系统预设已内置</strong>（共 {{ systemRuleCount }} 条，默认生效）；自定义规则保存后<strong class="text-amber-600">立即生效</strong>并永久保留。
                    </p>

                    <!-- 选项卡 -->
                    <div class="flex border-b border-gray-200 gap-1">
                        <button @click="tab = 'system'"
                                :class="['px-3 py-1.5 text-xs font-bold rounded-t transition border-b-2',
                                         tab === 'system' ? 'text-blue-700 border-blue-600 bg-blue-50' : 'text-gray-500 border-transparent hover:text-gray-700']">
                            🏷️ 系统预设 <span class="text-[10px] font-normal">({{ systemRuleCount }})</span>
                        </button>
                        <button @click="tab = 'custom'"
                                :class="['px-3 py-1.5 text-xs font-bold rounded-t transition border-b-2',
                                         tab === 'custom' ? 'text-blue-700 border-blue-600 bg-blue-50' : 'text-gray-500 border-transparent hover:text-gray-700']">
                            ✏️ 自定义规则 <span class="text-[10px] font-normal">({{ localRules.length }})</span>
                        </button>
                    </div>

                    <!-- 🏷️ Tab 系统预设：内置集合，分组展示（默认全部生效） -->
                    <div v-if="tab === 'system'" class="space-y-2">
                        <div v-for="g in systemGroups" :key="g.group" class="border border-gray-200 rounded-lg overflow-hidden">
                            <button @click="toggleGroup(g.group)"
                                    class="w-full flex items-center justify-between px-3 py-2 bg-gray-50 hover:bg-gray-100 transition text-left">
                                <span class="text-xs font-bold text-gray-700">{{ g.group }} <span class="text-[10px] font-normal text-gray-400">({{ g.rules.length }})</span></span>
                                <span class="text-gray-400 text-xs">{{ expandedGroups[g.group] ? '🔼' : '🔽' }}</span>
                            </button>
                            <div v-if="expandedGroups[g.group]" class="px-3 py-2 space-y-1.5 bg-white">
                                <div v-for="r in g.rules" :key="r.name" class="flex items-start gap-2 py-0.5 border-b border-gray-100 last:border-0">
                                    <span class="shrink-0 px-1.5 py-0.5 bg-blue-600/10 text-blue-700 text-[11px] rounded whitespace-nowrap">{{ r.name }}</span>
                                    <code class="text-[10px] text-gray-500 font-mono break-all leading-5">{{ r.regex }}</code>
                                </div>
                            </div>
                        </div>
                        <p class="text-[10px] text-gray-400">💡 系统预设已内置并默认生效，无需逐个添加；如需补充请切到「自定义规则」。</p>
                    </div>

                    <!-- ✏️ Tab 自定义规则：手动输入 / 选词添加 -->
                    <div v-if="tab === 'custom'" class="space-y-3">
                        <div class="space-y-2">
                            <div v-for="(rule, idx) in localRules" :key="idx"
                                 class="border border-gray-200 rounded-lg p-2.5 bg-gray-50 transition"
                                 :class="{ 'border-rose-400 bg-rose-50': rule._error }">
                                <div class="flex items-center gap-2">
                                    <input v-model="rule.name" type="text" placeholder="规则名，如：末世"
                                           class="flex-1 bg-white border border-gray-300 rounded px-2 py-1 text-xs text-gray-800 focus:border-blue-500 focus:outline-none">
                                    <button @click="removeRule(idx)" class="text-gray-400 hover:text-rose-500 px-2 py-1 rounded hover:bg-gray-100 transition shrink-0" title="删除此规则">🗑️</button>
                                </div>
                                <input v-model="rule.regex" type="text" placeholder="关键词，用 | 分隔，如：末世|废土|丧尸"
                                       class="w-full mt-1.5 bg-white border border-gray-300 rounded px-2 py-1 text-xs font-mono text-gray-800 focus:border-blue-500 focus:outline-none">
                                <p v-if="rule._error" class="text-[10px] text-rose-500 mt-1">❌ {{ rule._error }}</p>
                            </div>
                            <div v-if="localRules.length === 0" class="text-gray-400 text-center py-4 border border-dashed border-gray-300 rounded-lg">
                                暂无自定义规则（系统预设 {{ systemRuleCount }} 条已内置生效）
                            </div>
                        </div>

                        <!-- 添加区：手动输入 + 关键词选词 -->
                        <div class="border border-blue-200 bg-blue-50 rounded-lg p-3 space-y-2">
                            <span class="text-xs font-bold text-blue-700">➕ 添加自定义规则</span>
                            <div class="flex gap-2">
                                <input v-model="draftName" type="text" placeholder="规则名（如：末世）"
                                       class="flex-1 bg-white border border-blue-300 rounded px-2 py-1 text-xs text-gray-800 focus:border-blue-500 focus:outline-none">
                                <button @click="addDraftRule" :disabled="!draftName.trim() || !draftRegex.trim()"
                                        class="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500 text-white rounded text-xs transition shrink-0">＋ 添加</button>
                            </div>
                            <input v-model="draftRegex" type="text" placeholder="关键词，用 | 分隔（也可点击下方词一键加入）"
                                   class="w-full bg-white border border-blue-300 rounded px-2 py-1 text-xs font-mono text-gray-800 focus:border-blue-500 focus:outline-none">
                            <div class="flex flex-wrap gap-1 max-h-24 overflow-y-auto custom-scrollbar p-0.5">
                                <button v-for="w in keywordList" :key="'s' + w" @click="appendKeyword(w)"
                                        class="px-2 py-0.5 bg-white border border-blue-300 text-blue-700 text-[11px] rounded hover:bg-blue-600 hover:text-white transition">
                                    + {{ w }}
                                </button>
                            </div>
                            <!-- 自定义关键词（用户添加，可删） -->
                            <div v-if="customKeywordList.length" class="flex flex-wrap gap-1 max-h-24 overflow-y-auto custom-scrollbar p-0.5">
                                <span v-for="w in customKeywordList" :key="'c' + w" class="group flex items-center bg-purple-50 border border-purple-300 text-purple-700 text-[11px] rounded">
                                    <button @click="appendKeyword(w)" class="px-1.5 py-0.5 hover:bg-purple-600 hover:text-white transition" title="点击加入关键词">+ {{ w }}</button>
                                    <button @click="$emit('remove-keyword', w)" class="px-1 py-0.5 text-purple-400 hover:text-rose-500 transition" title="删除自定义关键词">✕</button>
                                </span>
                            </div>
                            <div class="flex gap-2 pt-1">
                                <input v-model="newKeyword" @keyup.enter="addCustomKeyword" type="text" placeholder="添加自定义关键词（回车确认）"
                                       class="flex-1 bg-white border border-purple-300 rounded px-2 py-1 text-xs text-gray-800 focus:border-purple-500 focus:outline-none">
                                <button @click="addCustomKeyword" :disabled="!newKeyword.trim()"
                                        class="px-2.5 py-1 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-300 disabled:text-gray-500 text-white rounded text-[11px] transition shrink-0">＋ 添加</button>
                            </div>
                        </div>

                        <button @click="$emit('reset')" class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 border border-gray-300 text-gray-700 rounded text-xs transition">↩️ 清空自定义（恢复仅系统预设）</button>
                    </div>
                </div>

                <div class="px-5 py-4 bg-gray-50 border-t border-gray-200 flex justify-end gap-3 shrink-0">
                    <button @click="$emit('close')" class="px-5 py-2 bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 transition">取消</button>
                    <button @click="doSave" :disabled="saving" class="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold disabled:opacity-60 transition">
                        {{ saving ? '保存中...' : '💾 保存并生效' }}
                    </button>
                </div>
            </div>
        </div>
    </transition>
</template>

<script>
// 系统预设规则集合 + 关键词候选库（模块级常量，模板访问须经 computed —— 坑 11）
import { defaultAutoTagRules, autoTagKeywordCandidates } from '../utils/cardLoader.js';

export default {
    name: 'AutoTagRulesModal',
    props: {
        show: { type: Boolean, default: false },
        rules: { type: Array, default: () => [] },       // 用户自定义规则 [{name, regex}]
        customKeywords: { type: Array, default: () => [] } // 用户自定义关键词库
    },
    emits: ['close', 'save', 'reset', 'add-keyword', 'remove-keyword'],
    data() {
        return {
            saving: false,
            tab: 'system',            // 选项卡：'system' | 'custom'
            expandedGroups: {},       // 系统预设分组折叠状态
            draftName: '',            // 自定义添加：规则名
            draftRegex: '',           // 自定义添加：关键词
            newKeyword: '',           // 自定义关键词添加输入
            localRules: []            // 自定义规则工作副本
        };
    },
    computed: {
        // ⚠️ 坑 11：模块级常量挂 computed 供模板访问
        systemRuleCount() {
            return Array.isArray(defaultAutoTagRules) ? defaultAutoTagRules.length : 0;
        },
        keywordList() {
            return autoTagKeywordCandidates;
        },
        customKeywordList() {
            return Array.isArray(this.customKeywords) ? this.customKeywords : [];
        },
        // 系统预设按 group 分组：[{group, rules}]（保持默认集合原始顺序）
        systemGroups() {
            const map = {};
            for (const r of defaultAutoTagRules) {
                const g = r.group || '其他';
                if (!map[g]) map[g] = [];
                map[g].push(r);
            }
            return Object.keys(map).map(g => ({ group: g, rules: map[g] }));
        }
    },
    watch: {
        // 打开弹窗时同步父级自定义配置为工作副本
        show: {
            immediate: true,
            handler(v) { if (v) { this.syncLocal(); this.tab = 'system'; } }
        },
        rules: {
            deep: true,
            handler() { if (this.show) this.syncLocal(); }
        }
    },
    methods: {
        syncLocal() {
            this.localRules = (this.rules || []).map(r => ({
                name: String(r && r.name || ''),
                regex: String(r && r.regex || ''),
                _error: ''
            }));
        },
        toggleGroup(g) {
            this.expandedGroups = { ...this.expandedGroups, [g]: !this.expandedGroups[g] };
        },
        // 关键词候选点击 → 追加到 draftRegex（用 | 分隔，自动去重）
        appendKeyword(w) {
            const cur = this.draftRegex.trim();
            const parts = cur ? cur.split('|').map(s => s.trim()).filter(Boolean) : [];
            if (!parts.includes(w)) parts.push(w);
            this.draftRegex = parts.join('|');
        },
        // 添加自定义关键词（emit 给父级持久化；去重由父级处理）
        addCustomKeyword() {
            const w = this.newKeyword.trim();
            if (!w) return;
            this.$emit('add-keyword', w);
            this.newKeyword = '';
        },
        // 从添加区提交自定义规则（同名覆盖；校验正则）
        addDraftRule() {
            const name = this.draftName.trim();
            const regex = this.draftRegex.trim();
            if (!name || !regex) return;
            try { new RegExp(regex); } catch (e) { return; }
            const idx = this.localRules.findIndex(r => r.name.trim() === name);
            if (idx >= 0) this.localRules[idx] = { name, regex, _error: '' };
            else this.localRules.push({ name, regex, _error: '' });
            this.draftName = '';
            this.draftRegex = '';
        },
        removeRule(idx) {
            this.localRules.splice(idx, 1);
        },
        doSave() {
            // 逐条校验自定义规则：名称/关键词非空 + 关键词可编译为正则
            let allOk = true;
            for (const r of this.localRules) {
                if (!r.name.trim() || !r.regex.trim()) { r._error = '规则名与关键词不能为空'; allOk = false; continue; }
                try { new RegExp(r.regex.trim()); r._error = ''; } catch (e) { r._error = '关键词格式非法：' + e.message; allOk = false; }
            }
            if (!allOk) return;
            this.saving = true;
            this.$emit('save', this.localRules.map(r => ({ name: r.name.trim(), regex: r.regex.trim() })));
            setTimeout(() => { this.saving = false; }, 600);
        }
    }
};
</script>
