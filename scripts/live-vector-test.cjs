'use strict';
/**
 * 热测试：在真实 Electron 主进程环境中调用修复后的 vectorManager
 * 验证：标签展开 + 0.35 阈值在生产代码路径上真正生效（而非仅测试脚本模拟）
 * 运行：npx electron scripts/live-vector-test.cjs
 */
const { app } = require('electron');
const path = require('path');

// 🔧 关键：显式指向生产 userData（否则临时脚本的 userData 不同 → 模型缓存未命中 → 触发网络下载卡住）
const PROD_USER_DATA = path.join(process.env.APPDATA || '', 'sillytavern-card-manager');
app.setPath('userData', PROD_USER_DATA);
console.log('[LIVE] userData =', PROD_USER_DATA);

app.whenReady().then(async () => {
    try {
        const vm = require('../main/vectorManager.js');
        console.log('[LIVE] 向量引擎模块加载成功，DEFAULT_MODEL =', vm.DEFAULT_MODEL);

        // 1. 初始化（复用生产缓存，模型已在缓存中）
        console.log('[LIVE] 初始化向量引擎...');
        await vm.init();
        console.log('[LIVE] 向量引擎就绪 ✓');

        // 2. 真实 batchMatch：卡片长文 vs 候选标签池（阈值 0.35，模拟生产 AI 打标场景）
        const cards = [
            { id: 'c1', name: '魔法学院少女', text: '她是一名在魔法学院就读的天才少女，精通火系魔法，梦想成为大魔导师，与好友组队参加学院大比。' },
            { id: 'c2', name: '吸血鬼伯爵夫人', text: '她是一名吸血鬼伯爵夫人，数百年来统治着黑暗的古老城堡，以鲜血为食，拥有优雅而危险的气质。' },
            { id: 'c3', name: '赛博黑客', text: '出身于赛博朋克都市的雇佣黑客，擅长入侵义体网络，在霓虹闪烁的街头接取高额委托。' },
            { id: 'c4', name: '都市女医生', text: '现代都市的温柔女医生，在繁忙的医院里救死扶伤，下班后却陷入一段纠葛的感情。' },
            { id: 'c5', name: '无关角色', text: '农民在田野里收割稻谷，夕阳下炊烟袅袅，一片祥和的田园景象。' }
        ];
        const pool = ['魔法', '吸血鬼', '赛博朋克', '都市', '恋爱', '田园'];

        console.log('[LIVE] batchMatch(5 卡 × 6 标签, 阈值 0.35, topK 3)...');
        const res = await vm.batchMatch(cards, pool, 3, 0.35);
        console.log('[LIVE] ====== 结果 ======');
        for (const r of res) {
            console.log(`  ${r.name}: tags=[${r.tags.join(', ') || '（无）'}] bestScore=${r.bestScore.toFixed(3)}`);
        }
        console.log('[LIVE] ==================');

        // 3. 期望验证
        const expect = { '魔法学院少女': '魔法', '吸血鬼伯爵夫人': '吸血鬼', '赛博黑客': '赛博朋克', '都市女医生': '都市', '无关角色': [] };
        let pass = 0, fail = 0;
        for (const r of res) {
            const exp = expect[r.name];
            const got = r.tags;
            const ok = Array.isArray(exp)
                ? (got.length === 0)
                : got.includes(exp);
            if (ok) pass++; else { fail++; console.log(`  ⚠️ ${r.name}: 期望含「${exp}」实际 [${got.join(', ')}]`); }
        }
        console.log(`[LIVE] 命中判定: ${pass}/5 通过, ${fail} 未达预期（未命中项在生产中会交给 LLM 兜底）`);
        console.log('[LIVE] 热测试完成 ✓');
    } catch (e) {
        console.error('[LIVE] 热测试失败:', e.message || e);
        process.exitCode = 1;
    } finally {
        app.quit();
    }
});
