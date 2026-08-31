<!--
  OptionSelectModal 通用选项选择弹窗（替代"手输名称"交互，如右键换组/批量移动分组）
  点击选项即返回所选 value；allowCreate 时底部提供"新建"输入框；选项多时支持搜索过滤
  状态经 props 传入、选择结果经 emits 回传
-->
<template>
    <transition name="fade">
        <div v-if="show" class="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4" @click.self="$emit('cancel')">
            <div class="bg-white rounded-lg shadow-xl w-[420px] max-w-full p-5 border border-gray-200">
                <h3 class="text-sm font-bold text-gray-800 mb-3 whitespace-pre-line">{{ title }}</h3>

                <!-- 搜索过滤（选项较多时显示） -->
                <input v-if="filterable && options.length > 6"
                       v-model="keyword"
                       @keyup.esc="$emit('cancel')"
                       type="text" placeholder="🔍 搜索..."
                       class="w-full px-3 py-1.5 border border-gray-300 rounded outline-none focus:border-blue-500 text-xs mb-2">

                <!-- 选项列表 -->
                <div class="max-h-56 overflow-y-auto border border-gray-200 rounded mb-3">
                    <button v-for="opt in filteredOptions" :key="opt.value"
                            @click="$emit('select', opt.value)"
                            class="w-full text-left px-3 py-2 text-xs hover:bg-blue-50 hover:text-blue-700 flex items-center justify-between gap-2 border-b border-gray-100 last:border-0 transition">
                        <span class="truncate">{{ opt.label }}</span>
                        <span v-if="opt.value === defaultValue" class="text-[10px] text-gray-400 shrink-0">当前</span>
                    </button>
                    <div v-if="filteredOptions.length === 0" class="px-3 py-3 text-xs text-gray-400 text-center">无匹配选项</div>
                </div>

                <!-- 新建分组 -->
                <div v-if="allowCreate" class="flex gap-2 mb-3">
                    <input v-model="createValue"
                           @keyup.enter="submitCreate" @keyup.esc="$emit('cancel')"
                           type="text" placeholder="➕ 输入新名称新建..."
                           class="flex-1 px-3 py-1.5 border border-gray-300 rounded outline-none focus:border-blue-500 text-xs">
                    <button @click="submitCreate"
                            class="px-3 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded shadow-sm transition whitespace-nowrap">新建</button>
                </div>

                <div class="flex justify-end">
                    <button @click="$emit('cancel')" class="px-4 py-1.5 text-xs font-bold text-gray-500 hover:bg-gray-100 rounded border border-gray-300 transition">取消</button>
                </div>
            </div>
        </div>
    </transition>
</template>

<script>
import { ref, computed, watch } from 'vue';

export default {
    name: 'OptionSelectModal',
    props: {
        show: { type: Boolean, default: false },
        title: { type: String, default: '' },
        options: { type: Array, default: () => [] },     // [{ label, value }]（也兼容纯字符串数组）
        defaultValue: { type: String, default: '' },     // 标记"当前"项
        allowCreate: { type: Boolean, default: false },  // 是否提供新建输入框
        filterable: { type: Boolean, default: true }     // 是否显示搜索过滤
    },
    emits: ['select', 'create', 'cancel'],
    setup(props, { emit }) {
        const keyword = ref('');
        const createValue = ref('');

        // 每次打开时重置搜索与新建输入
        watch(() => props.show, (v) => {
            if (v) {
                keyword.value = '';
                createValue.value = '';
            }
        });

        const filteredOptions = computed(() => {
            const kw = keyword.value.trim().toLowerCase();
            if (!kw) return props.options;
            return props.options.filter(o => (o.label || '').toLowerCase().includes(kw));
        });

        const submitCreate = () => {
            const name = createValue.value.trim();
            if (!name) return;
            emit('create', name);
        };

        return { keyword, createValue, filteredOptions, submitCreate };
    }
};
</script>
