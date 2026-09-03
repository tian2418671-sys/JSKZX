<!--
  BatchTagModal 批量设置标签弹窗（子组件）
  状态通过 props 单向传入，变更经 emits 回传（v-model 风格）
-->
<template>
    <transition name="fade">
        <div v-if="show" class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
            <div class="bg-white rounded-lg shadow-xl w-full max-w-xl overflow-hidden flex flex-col max-h-[85vh]">
                <div class="px-4 py-3 bg-gray-100 border-b border-gray-200 flex justify-between items-center">
                    <h3 class="font-bold text-sm text-gray-800">批量设置标签 (已选 {{ selectedCount }} 张卡片)</h3>
                    <button @click="$emit('close')" class="text-gray-400 hover:text-gray-600">✕</button>
                </div>

                <div class="p-4 overflow-y-auto space-y-4 flex-1 custom-scrollbar text-xs">
                    <div>
                        <label class="block font-bold text-gray-600 mb-1">操作模式:</label>
                        <div class="flex gap-4">
                            <label class="flex items-center gap-1 cursor-pointer">
                                <input type="radio" :checked="batchMode === 'append'" @change="$emit('update:batchMode', 'append')"> 追加标签 (保留原有)
                            </label>
                            <label class="flex items-center gap-1 cursor-pointer">
                                <input type="radio" :checked="batchMode === 'overwrite'" @change="$emit('update:batchMode', 'overwrite')"> 覆盖标签 (清空旧标签)
                            </label>
                        </div>
                    </div>

                    <div>
                        <label class="block font-bold text-gray-600 mb-1">当前输入的标签 (用逗号分隔):</label>
                        <input :value="batchInputTags" @input="$emit('update:batchInputTags', $event.target.value)" type="text" class="w-full border border-gray-300 rounded p-2 outline-none focus:border-blue-500" placeholder="例如: Fantasy, Elf, 魔法">

                        <!-- 🌟 已输入的标签芯片（点击 ✕ 移除） -->
                        <div class="flex flex-wrap gap-2 mt-2 p-2 border border-gray-200 bg-gray-50 rounded min-h-[40px]">
                            <span v-for="(tag, idx) in batchTagChips" :key="idx"
                                  class="px-2 py-1 bg-blue-600/30 text-blue-700 text-xs rounded-full flex items-center gap-1 cursor-pointer hover:bg-red-500 hover:text-white transition"
                                  @click="$emit('remove-batch-tag', idx)" title="点击移除">
                                {{ tag }} ✕
                            </span>
                            <span v-if="batchTagChips.length === 0" class="text-gray-400 text-xs self-center">尚未添加任何标签</span>
                        </div>
                    </div>

                    <div>
                        <div class="flex justify-between items-center mb-1">
                            <label class="font-bold text-gray-600">💡 系统/常用标签库 (点击快速添加):</label>
                            <span class="text-[10px] text-gray-400">已选: {{ batchTagChips.length }} 个</span>
                        </div>

                        <div class="max-h-60 overflow-y-auto p-2 bg-gray-50 border border-gray-200 rounded custom-scrollbar">
                            <template v-for="group in groupedSystemTags" :key="group.key">
                                <div class="flex items-baseline gap-1 mb-1 mt-1.5 first:mt-0 cursor-pointer select-none" @click="toggleTagGroup(group.key)" :title="collapsedTagGroups[group.key] ? '点击展开' : '点击折叠'">
                                    <span class="text-[10px] text-gray-400">{{ collapsedTagGroups[group.key] ? '▸' : '▾' }}</span>
                                    <span class="text-[11px] font-bold text-gray-700">{{ group.icon }} {{ group.name }}</span>
                                    <span class="text-[9px] text-gray-400">({{ group.tags.length }})</span>
                                </div>
                                <div v-show="!collapsedTagGroups[group.key]" class="flex flex-wrap gap-1.5">
                                    <div v-for="tag in group.tags" :key="tag" class="flex items-center group shadow-sm rounded">
                                        <button @click="$emit('toggle-common-tag', tag)"
                                                class="px-2 py-1 text-[11px] border transition-colors rounded-l"
                                                :class="batchTagChips.includes(tag) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-gray-300 hover:border-blue-500 hover:text-blue-600'">
                                            {{ batchTagChips.includes(tag) ? '✓ 已选' : '+ ' + tag }}
                                        </button>
                                        <button @click.stop="$emit('remove-system-common-tag', tag)"
                                                class="px-1.5 py-1 text-[11px] border border-l-0 border-gray-300 bg-gray-200 text-gray-500 hover:bg-red-500 hover:text-white hover:border-red-500 rounded-r transition-colors" title="从全局系统库中彻底删除此标签">
                                            ✕
                                        </button>
                                    </div>
                                </div>
                            </template>
                        </div>
                    </div>
                </div>

                <div class="px-4 py-3 bg-gray-50 border-t border-gray-200 flex justify-end gap-2">
                    <button @click="$emit('close')" class="px-4 py-1.5 bg-white border border-gray-300 rounded text-gray-700">取消</button>
                    <button @click="$emit('confirm')" class="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold">确认应用</button>
                </div>
            </div>
        </div>
    </transition>
</template>

<script>
import { groupTagsByCategory } from '../utils/tagCategories.js';

export default {
    name: 'BatchTagModal',
    props: {
        show: { type: Boolean, default: false },
        selectedCount: { type: Number, default: 0 },
        batchMode: { type: String, default: 'append' },
        batchInputTags: { type: String, default: '' },
        batchTagChips: { type: Array, default: () => [] },
        systemCommonTags: { type: Array, default: () => [] }
    },
    emits: ['close', 'confirm', 'update:batchMode', 'update:batchInputTags', 'remove-batch-tag', 'toggle-common-tag', 'remove-system-common-tag'],
    // 🏷️ [标签大分类] 系统标签池按大分类分组（人物关系/角色设定/外貌身材...），标签云更好找
    computed: {
        groupedSystemTags() {
            return groupTagsByCategory(this.systemCommonTags || []);
        }
    },
    // 🏷️ [大分类折叠] 记录被折叠的分类 key（点击分组标题折叠/展开）
    data() {
        return { collapsedTagGroups: {} };
    },
    methods: {
        toggleTagGroup(key) {
            this.collapsedTagGroups[key] = !this.collapsedTagGroups[key];
        }
    }
};
</script>
