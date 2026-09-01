'use strict';
/**
 * 向量引擎主进程管理器
 * - 调度 Worker 线程（vectorWorker.js）执行 ONNX 推理，主进程不阻塞
 * - 提供 IPC handler 所需的 init / getStatus / deleteCache / batchMatch
 * - 标签向量索引持久化到 userData/vector_index_cache.json（带模型版本校验）
 *
 * 模块类型：CommonJS（与 main.js / preload.js 一致，项目无 "type": "module"）
 */
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs/promises');
const { app } = require('electron');
const crypto = require('crypto');

const DEFAULT_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
// 🔧 修正 3.5：默认阈值 0.65 → 0.35。实测（scripts/vector-model-test.cjs）：
//    「卡片长文（~800字）vs 2字短标签」在 mean pooling 下绝对相似度仅 0.18~0.57，
//    0.65 阈值导致正例命中率 0%（向量层等于白跑，全部降级 LLM）。
//    标签展开 + 0.35 阈值后：强相关（魔法/医疗等）能命中，误报基线实测最高 0.307，
//    0.35 留有安全余量；未命中卡片仍有第三层 LLM 兜底。
const DEFAULT_THRESHOLD = 0.35;
const DEFAULT_TOP_K = 3;
const CHUNK_SIZE = 500;        // 修正 3.2：单次 IPC 最多 500 张卡，防序列化瓶颈
const EMBED_BATCH = 32;        // Worker 内推理批次
const REQUEST_TIMEOUT_MS = 600000; // 10 分钟（大模型下载/大批量推理）

// 🔧 修正 3.5：标签展开模板。短标签（1-2 词）直接嵌入时与长卡片文本的方向差大，
//    余弦相似度被拉低到 0.2~0.5（永远够不到原 0.65 阈值）。把标签展开成描述句
//    「这是一个关于X的故事」能显著提升「长文 vs 标签」的绝对相似度（实测 +0.1~0.2），
//    让语义强相关的标签真正能跨过阈值。展开文本同时作为索引缓存的 hash 输入，
//    模板若有调整会自动触发缓存重建，不会误用旧向量。
const LABEL_TEMPLATE = '这是一个关于{label}的故事';
const expandLabel = (label) => {
    if (typeof label !== 'string' || label.trim() === '') return label;
    return LABEL_TEMPLATE.replace('{label}', label.trim());
};

// ========== 惰性求值：app 必须 ready 后才能调用 ==========
let _userData = null;
const getUserData = () => {
    if (!_userData) _userData = app.getPath('userData'); // 修正 1.5：真实项目路径，不硬编码
    return _userData;
};
const getCacheDir = () => path.join(getUserData(), 'hf_cache');
const getIndexFile = () => path.join(getUserData(), 'vector_index_cache.json');

// ========== 状态 ==========
let worker = null;
let isReady = false;
let initPromise = null;
const pendingRequests = new Map(); // id → { resolve, reject, timer, onProgress, onBatchProgress }

// ========== Worker 消息统一分发 ==========
const dispatch = (msg) => {
    const pending = pendingRequests.get(msg.id);
    if (!pending) return;

    if (msg.type === 'downloadSource') {
        pending.onSource?.(msg.source, msg.attempt, msg.total);
        return; // 不删除 pending，继续等 ready
    }
    if (msg.type === 'downloadProgress') {
        pending.onProgress?.(msg.progress);
        return; // 不删除 pending，继续等 ready
    }
    if (msg.type === 'batchProgress') {
        pending.onBatchProgress?.(msg.current, msg.total);
        return;
    }

    clearTimeout(pending.timer);
    pendingRequests.delete(msg.id);

    if (msg.type === 'result' || msg.type === 'ready') {
        pending.resolve(msg.type === 'ready' ? { status: 'ready' } : msg.vectors);
    } else if (msg.type === 'error') {
        pending.reject(new Error(msg.error || 'Worker error'));
    }
};

const rejectAllPending = (err) => {
    for (const [, p] of pendingRequests) {
        clearTimeout(p.timer);
        p.reject(err);
    }
    pendingRequests.clear();
};

const spawnWorker = () => {
    worker = new Worker(path.join(__dirname, 'vectorWorker.js'));
    worker.on('message', dispatch);
    worker.on('error', (err) => {
        // 修正 3.x：Worker 崩溃 → reject 所有 pending，不留挂起
        rejectAllPending(err);
    });
    worker.on('exit', (code) => {
        if (code !== 0) {
            rejectAllPending(new Error(`Worker exited with code ${code}`));
        }
        worker = null;
        isReady = false;
        initPromise = null; // 修正：允许重新初始化
    });
};

const sendToWorker = (type, data, callbacks = {}) => {
    if (!worker) return Promise.reject(new Error('Worker not running'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error(`Worker timeout after ${REQUEST_TIMEOUT_MS}ms`));
        }, REQUEST_TIMEOUT_MS);
        pendingRequests.set(id, { resolve, reject, timer, ...callbacks });
        worker.postMessage({ type, data, id });
    });
};

// ========== 对外 API ==========

const init = async (modelName = DEFAULT_MODEL, onProgress, onSource) => {
    if (isReady) return { status: 'ready' };
    if (initPromise) return initPromise;

    initPromise = (async () => {
        const cacheDir = getCacheDir();
        await fs.mkdir(cacheDir, { recursive: true });
        spawnWorker();
        try {
            await sendToWorker('init', { modelName, cacheDir }, { onProgress, onSource });
            isReady = true;
            return { status: 'ready' };
        } catch (e) {
            initPromise = null;
            if (worker) { try { await worker.terminate(); } catch {} worker = null; }
            throw e;
        }
    })();
    return initPromise;
};

const getStatus = async () => {
    const cacheDir = getCacheDir();
    let cacheExists = false;
    let cacheSizeMB = 0;
    try {
        await fs.access(cacheDir);
        cacheExists = true;
        cacheSizeMB = Math.round((await getDirSize(cacheDir)) / (1024 * 1024));
    } catch { /* 目录不存在 */ }
    return { ready: isReady, cacheExists, cacheSizeMB, cachePath: cacheDir };
};

const deleteCache = async () => {
    if (worker) {
        worker.postMessage({ type: 'terminate' });
        await new Promise((r) => setTimeout(r, 100));
        if (worker) { try { await worker.terminate(); } catch {} }
    }
    worker = null;
    isReady = false;
    initPromise = null;
    rejectAllPending(new Error('Cache deleted'));
    await fs.rm(getCacheDir(), { recursive: true, force: true });
    await fs.rm(getIndexFile(), { force: true });
};

const embed = async (texts, batchSize = EMBED_BATCH, onBatchProgress) => {
    if (!isReady) throw new Error('Vector engine not ready');
    return sendToWorker('embed', { texts, batchSize }, { onBatchProgress });
};

// ========== 索引缓存（带模型版本校验，修正 3.4）==========

const computePoolHash = (pool) => {
    const sorted = [...pool].sort(); // 修正：不污染调用方数组（sort 原地排序）
    return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
};

const loadIndex = async (labelPool, modelName) => {
    try {
        const raw = JSON.parse(await fs.readFile(getIndexFile(), 'utf-8'));
        if (raw.hash === computePoolHash(labelPool) && raw.modelId === modelName) {
            return raw.vectors; // 普通数组（Number[]），调用方负责转 Float32Array
        }
    } catch { /* 无缓存或损坏 */ }
    return null;
};

const saveIndex = async (labelPool, modelName, vectors) => {
    const data = {
        hash: computePoolHash(labelPool),
        modelId: modelName,
        vectors: vectors.map((v) => Array.from(new Float32Array(v)))
    };
    await fs.writeFile(getIndexFile(), JSON.stringify(data), 'utf-8');
};

// ========== 批量匹配（核心）==========

const cosineSimilarity = (a, b) => {
    let dot = 0, normA = 0, normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
};

const batchMatch = async (cards, labelPool, topK = DEFAULT_TOP_K, threshold = DEFAULT_THRESHOLD, modelName = DEFAULT_MODEL, onProgress) => {
    if (!isReady) throw new Error('Vector engine not ready');
    if (!labelPool || labelPool.length === 0) {
        return cards.map((c) => ({ id: c.id, name: c.name, tags: [], bestScore: 0 }));
    }

    // 1. 标签展开为描述句后再嵌入（修正 3.5：提升长文 vs 短词的绝对相似度）。
    //    展开文本同时作为索引缓存 hash 输入（模板变化 → hash 变 → 自动重建缓存）
    const expandedPool = labelPool.map(expandLabel);

    // 2. 加载或构建标签向量索引（持久化缓存，重启不重算）
    let labelVectors = await loadIndex(expandedPool, modelName);
    if (!labelVectors) {
        const rawBuffers = await embed(expandedPool, EMBED_BATCH);
        labelVectors = rawBuffers.map((buf) => new Float32Array(buf));
        await saveIndex(expandedPool, modelName, labelVectors);
    } else {
        labelVectors = labelVectors.map((arr) => new Float32Array(arr));
    }

    // 3. 分块处理卡片（修正 3.2）
    const results = [];
    let processed = 0;

    for (let i = 0; i < cards.length; i += CHUNK_SIZE) {
        const chunk = cards.slice(i, i + CHUNK_SIZE);
        const texts = chunk.map((c) => (c.text || '').substring(0, 800));
        const vecBuffers = await embed(texts, EMBED_BATCH);

        for (let j = 0; j < chunk.length; j++) {
            const vec = new Float32Array(vecBuffers[j]);
            const scored = [];
            for (let k = 0; k < labelPool.length; k++) {
                const s = cosineSimilarity(vec, labelVectors[k]);
                if (s >= threshold) scored.push({ label: labelPool[k], score: s });
            }
            scored.sort((a, b) => b.score - a.score);
            const top = scored.slice(0, topK);
            results.push({
                id: chunk[j].id,
                name: chunk[j].name,
                tags: top.map((s) => s.label),
                bestScore: top.length > 0 ? top[0].score : 0
            });
        }

        processed += chunk.length;
        onProgress?.(processed, cards.length);
    }

    return results;
};

// ========== 工具：递归目录大小（修正 1.4）==========

const getDirSize = async (dirPath) => {
    let total = 0;
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) total += await getDirSize(full);
        else total += (await fs.stat(full)).size;
    }
    return total;
};

module.exports = { init, getStatus, deleteCache, embed, batchMatch, DEFAULT_MODEL };
