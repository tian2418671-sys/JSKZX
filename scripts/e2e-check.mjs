/**
 * 端到端验证：模拟渲染层完整链路，输出最终 HTML 里的能力卡是否存在
 * 不走 Electron，纯 Node 复现 buildPreview 的关键步骤
 */
import { readFileSync, writeFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync('E:/AI/酒馆工具/酒馆助手插件/酒馆助手脚本-发送前最后正则.json', 'utf8'));

const plugin = {
    name: raw.name || '发送前最后正则',
    kind: 'tavern-helper',
    scripts: [{ file: 'x.json', lang: 'js', kind: 'A', content: raw.content || '' }],
    files: ['E:/x.json'],
};

// 步骤 1：分类
const { classifyPlugin, PLUGIN_KIND } = await import('../js/plugins/pluginClassify.js');
const cls = classifyPlugin(plugin);
console.log('[1] 分类:', cls.kind, '|', cls.reason);

// 步骤 2：生成能力卡
const { renderCapabilityCard, capabilityCardCss } = await import('../js/plugins/capabilityCard.js');
const capHtml = renderCapabilityCard(plugin);
const capCss = capabilityCardCss();
console.log('[2] 能力卡 HTML:', capHtml.length, '字符 | CSS:', capCss.length, '字符');

// 步骤 3：传入 hostStub 生成完整预览页
const { buildPluginPreviewHtml } = await import('../js/plugins/hostStub.js');
const capability = { ...cls, capHtml, capCss };
const full = buildPluginPreviewHtml(plugin, { previewId: 'test123', capability });

console.log('[3] 完整预览 HTML:', full.length, '字符');

// 步骤 4：检查能力卡内容是否真的进了最终 HTML
const checks = {
    '含「后台逻辑插件」': full.includes('后台逻辑插件'),
    '含「运行时机会」': full.includes('运行时机会'),
    '含能力卡样式 .jsk-cap': full.includes('.jsk-cap'),
    '含 jsk-empty-probe 容器': full.includes('jsk-empty-probe'),
    '含 produced 判定': full.includes('produced'),
};
for (const [k, v] of Object.entries(checks)) console.log('   ', v ? '✅' : '❌', k);

// 步骤 5：把最终 HTML 落盘，人工可查
writeFileSync('E:/AI/酒馆工具/JSK管理/scripts/_last_preview.html', full, 'utf8');
console.log('[4] 已写出 scripts/_last_preview.html 供检查');
