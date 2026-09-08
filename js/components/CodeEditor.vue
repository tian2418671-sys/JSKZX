<!--
  CodeEditor 轻量代码编辑器（CodeMirror 6 封装）——类 Notepad++ 基础体验
  基础能力：语法高亮 / 行号 / 自动缩进 / 括号匹配 / 等宽字体 / 自动换行 / 深色 IDE 主题
  props:
    modelValue String  受控文本
    filename   String  可选；按扩展名推断语言（.js/.mjs/.ts→js，.json→json，.css→css，.html/.svg/.xml→html）
    language   String  显式语言 'auto'|'javascript'|'json'|'css'|'html'，默认 'auto'
    height     String  编辑器高度（CSS），默认 '100%'（父容器须给高度）
    readonly   Boolean 只读（默认 false）
  emits:
    update:modelValue  每次编辑实时写回（v-model 友好）
    change             用户编辑触发（供父级置脏标记）；程序化 setValue 不触发
-->
<template>
    <div class="code-editor-wrap group relative w-full" :style="{ height }">
        <div ref="host" class="code-editor-host w-full h-full"></div>
        <button v-if="!readonly" type="button" @click.stop="formatNow"
                class="absolute top-1.5 right-2 z-10 px-2 py-0.5 rounded text-[11px] font-medium bg-zinc-800/90 hover:bg-violet-600 text-zinc-300 hover:text-white border border-white/15 transition pointer-events-auto shadow"
                title="格式化代码（快捷键 Ctrl+Shift+F）">✨ 格式化</button>
    </div>
</template>

<script>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { oneDark } from '@codemirror/theme-one-dark';
import beautify from 'js-beautify'; // ✨ 代码格式化（js/css/html beautifier）

const LANG_EXTS = { javascript, json, css, html };

export default {
    name: 'CodeEditor',
    props: {
        modelValue: { type: String, default: '' },
        filename: { type: String, default: '' },
        language: { type: String, default: 'auto' },
        height: { type: String, default: '100%' },
        readonly: { type: Boolean, default: false }
    },
    emits: ['update:modelValue', 'change'],
    setup(props, { emit }) {
        const host = ref(null);
        let view = null;
        let currentLang = 'javascript'; // 当前语言（供格式化按语言分发）
        let syncing = false; // 程序化 setValue 期间抑制 change

        const extLang = (name) => {
            const ext = String(name || '').split('.').pop().toLowerCase();
            if (['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'vue'].includes(ext)) return 'javascript';
            if (ext === 'json') return 'json';
            if (ext === 'css') return 'css';
            if (['html', 'htm', 'svg', 'xml'].includes(ext)) return 'html';
            return null;
        };
        const resolveLang = () => {
            const byName = extLang(props.filename);
            if (byName) return byName;
            const l = String(props.language || 'auto').toLowerCase();
            return LANG_EXTS[l] ? l : 'javascript';
        };

        // ✨ 格式化当前文档（按语言分发：JSON 用 parse/stringify，JS/CSS/HTML 用 js-beautify）
        const formatNow = () => {
            if (!view) return;
            const doc = view.state.doc.toString();
            if (!doc) return;
            let next = doc;
            try {
                if (currentLang === 'json') {
                    // JSON 优先解析；若内容其实是 JS（如 .json 插件的 content 是压缩 JS），回退按 JS 格式化
                    try {
                        const parsed = JSON.parse(doc);
                        next = JSON.stringify(parsed, null, 2);
                    } catch (e) {
                        next = beautify.js_beautify(doc, { indent_size: 2, indent_char: ' ', max_preserve_newlines: 2, preserve_newlines: true, space_in_empty_paren: true, brace_style: 'collapse', end_with_newline: false });
                    }
                } else if (currentLang === 'javascript') {
                    next = beautify.js_beautify(doc, { indent_size: 2, indent_char: ' ', max_preserve_newlines: 2, preserve_newlines: true, space_in_empty_paren: true, brace_style: 'collapse', end_with_newline: false });
                } else if (currentLang === 'css') {
                    next = beautify.css_beautify(doc, { indent_size: 2 });
                } else if (currentLang === 'html') {
                    next = beautify.html_beautify(doc, { indent_size: 2, max_preserve_newlines: 2 });
                }
            } catch (err) {
                return; // 格式化失败（如语法错误）保持原文，不打扰用户
            }
            if (next !== doc) {
                // 程序化替换走普通 dispatch → 触发 change，父级置脏，用户可 Ctrl+Z 还原
                view.dispatch({ changes: { from: 0, to: doc.length, insert: next } });
            }
        };

        const create = () => {
            if (!host.value) return;
            const lang = LANG_EXTS[resolveLang()]();
            currentLang = resolveLang();
            view = new EditorView({
                state: EditorState.create({
                    doc: props.modelValue || '',
                    extensions: [
                        basicSetup,
                        // 🌐 中文化 CodeMirror 搜索面板文案（key 即 @codemirror/search 里的英文原文）
                        EditorState.phrases.of({
                            'Find': '查找',
                            'Replace': '替换',
                            'next': '下一个',
                            'previous': '上一个',
                            'all': '全部',
                            'match case': '区分大小写',
                            'regexp': '正则',
                            'by word': '全词匹配',
                            'replace': '替换',
                            'replace all': '全部替换',
                            'close': '关闭',
                            'Go to line': '跳转到行',
                            'go': '跳转',
                            'current match': '当前匹配',
                            'on line': '位于第'
                        }),
                        lang,
                        oneDark,
                        EditorView.lineWrapping,
                        keymap.of([{ key: 'Mod-Shift-f', run: () => { formatNow(); return true; } }]),
                        EditorState.readOnly.of(props.readonly),
                        EditorView.theme({
                            '&': {
                                height: '100%',
                                fontSize: '12px',
                                backgroundColor: 'rgba(9,9,11,0.5)'
                            },
                            '.cm-scroller': {
                                fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
                                lineHeight: '1.55',
                                overflow: 'auto'
                            },
                            '.cm-content': {
                                fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace'
                            },
                            '.cm-gutters': {
                                backgroundColor: 'rgba(255,255,255,0.03)',
                                borderRight: '1px solid rgba(255,255,255,0.07)',
                                color: '#6b7280'
                            },
                            '&.cm-focused': { outline: 'none' }
                        }),
                        EditorView.updateListener.of((u) => {
                            if (!u.docChanged) return;
                            const val = view.state.doc.toString();
                            emit('update:modelValue', val);
                            if (!syncing) emit('change');
                        })
                    ]
                }),
                parent: host.value
            });
        };
        const destroy = () => {
            if (view) { view.destroy(); view = null; }
        };

        // 外部受控值变化（切文件/切脚本/撤销保存）→ 同步进编辑器，不触发 change
        watch(() => props.modelValue, (val) => {
            if (!view) return;
            const cur = view.state.doc.toString();
            if (val !== cur) {
                syncing = true;
                view.dispatch({ changes: { from: 0, to: cur.length, insert: val || '' } });
                syncing = false;
            }
        });

        // 文件名/语言变化（如扩展工程从 .js 切到 .json）→ 重建以正确高亮
        watch(() => props.filename + '|' + props.language, () => {
            destroy();
            create();
        });

        onMounted(create);
        onBeforeUnmount(destroy);
        return { host, formatNow };
    }
};
</script>
