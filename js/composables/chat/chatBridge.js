/**
 * 桌面版桥接适配层（替代移动版的 js/bridge/api.js）
 * ─────────────────────────────────────────────────────────────
 * 移动版 bridge 按运行环境选择 androidImpl / electronImpl；
 * 桌面版直接透传 preload 注入的 window.electronAPI（其本身即契约实现）。
 * 浏览器纯调试模式（无 electronAPI）下提供最小桩，避免渲染层崩溃。
 *
 * 注意：window.electronAPI 由 contextBridge 注入且被冻结，只能用展开复制读取属性，
 *      不能用 Object.assign 改写原对象。
 */
const real = (typeof window !== 'undefined' && window.electronAPI) ? window.electronAPI : null;

if (typeof window !== 'undefined' && !real) {
    console.warn('[chatBridge] 未检测到 electronAPI（非 Electron 环境），测卡部分能力将受限');
}

/** 生成一个失败桩（保证调用方 try/catch 或降级逻辑能正常工作） */
const stub = (name) => async () => ({ success: false, error: `[chatBridge] ${name} 在非 Electron 环境不可用` });

/** 记忆通道：preload 未暴露时用桩兜底，避免直接抛 undefined is not a function */
const MEMORY_METHODS = ['memoryAdd', 'memoryUpdate', 'memoryRemove', 'memoryClear', 'memoryList', 'memorySearch', 'memoryStats'];

const FALLBACK = {
    encryptSecret: async (v) => ({ success: true, value: v }),   // 无加密环境回退明文
    decryptSecret: async (v) => ({ success: true, value: v })
};
for (const m of MEMORY_METHODS) FALLBACK[m] = stub(m);

export const api = real
    ? {
        // 透传全部原生能力
        ...real,
        // 个别方法在旧版 preload 可能缺失 → 逐个兜底
        encryptSecret: typeof real.encryptSecret === 'function' ? real.encryptSecret : FALLBACK.encryptSecret,
        decryptSecret: typeof real.decryptSecret === 'function' ? real.decryptSecret : FALLBACK.decryptSecret,
        ...Object.fromEntries(MEMORY_METHODS.map((m) => [m,
            typeof real[m] === 'function' ? real[m] : FALLBACK[m]
        ]))
    }
    : { ...FALLBACK };

export default api;
