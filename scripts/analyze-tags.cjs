// 临时分析脚本：提取 app_config.json 全部标签，跑分类，统计覆盖
const fs = require('fs');
const path = require('path');

// 直接读取 tagCategories.js（ESM）——用正则提取？不行，改为动态 import
(async () => {
    const { groupTagsByCategory } = await import('../js/utils/tagCategories.js');
    const cfgPath = process.env.APPDATA + '\\sillytavern-card-manager\\app_config.json';
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const tags = new Set();
    if (Array.isArray(cfg.globalTags)) cfg.globalTags.forEach(t => { if (t) tags.add(String(t)); });
    const ov = cfg.cardOverlays || {};
    for (const k of Object.keys(ov)) {
        const v = ov[k];
        if (v && Array.isArray(v.tags)) v.tags.forEach(t => { if (t) tags.add(String(t)); });
    }
    const list = Array.from(tags).filter(t => t && t.trim());
    const groups = groupTagsByCategory(list);
    let total = 0;
    for (const gr of groups) {
        total += gr.tags.length;
        console.log(gr.icon, gr.name, '(' + gr.tags.length + ')');
        if (gr.key === 'other') {
            console.log('   [其他明细] ' + gr.tags.join(' | '));
        }
    }
    const otherGroup = groups.find(x => x.key === 'other');
    console.log('');
    console.log('总标签数:', total, '| 分类数:', groups.length, '| 其他占比:', (otherGroup ? otherGroup.tags.length : 0) + '/' + total);
})().catch(e => { console.error(e); process.exit(1); });
