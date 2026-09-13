/**
 * 测卡 API Key 配置（加密持久化，与设置页共用 stc-api-key 存储键）
 *  - 读取：优先经桥接 decryptSecret 解密；失败/无密文时返回原始存储值（兼容历史明文）
 *  - 保存：优先经桥接 encryptSecret 加密后落盘（Win DPAPI / Android Keystore）；失败回退明文
 *  - 存储：经 chatStorage 适配层（桌面生产 app:// 下 localStorage 不落盘，会重启丢 Key）
 * 与桌面 useConfigPersistence 的 API Key 加密语义对齐。
 *
 * ⚠️ 接线注意：桌面已有权威 API Key（`app_config.json` 的 `api.key`，由 useConfigPersistence 加密落盘）。
 *    测卡应优先复用桌面注入的 apiKey ref；本模块仅作为「独立使用测卡引擎」场景的自洽存储，
 *    两者共用 `stc-api-key` 键名，避免出现「设置页填了但测卡读不到」的割裂。
 */
import { api } from './chatBridge.js';
import { chatStorage } from './chatStorage.js';

const LS_KEY = 'stc-api-key';

export async function loadApiKey() {
    const stored = chatStorage.get(LS_KEY) || '';
    if (!stored) return '';
    try {
        const res = await api.decryptSecret(stored);
        if (res && res.success && res.value) return res.value;
    } catch (e) { /* 兼容旧明文/解密失败，返回原值 */ }
    return stored;
}

export async function saveApiKey(key) {
    const plain = (key || '').trim();
    if (!plain) {
        chatStorage.remove(LS_KEY);
        return;
    }
    try {
        const enc = await api.encryptSecret(plain);
        if (enc && enc.success && enc.value) chatStorage.set(LS_KEY, enc.value);
        else chatStorage.set(LS_KEY, plain);
    } catch (e) {
        chatStorage.set(LS_KEY, plain);
    }
}
