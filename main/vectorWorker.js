'use strict';
/**
 * 向量引擎 Worker 线程（主进程子线程）
 * 承载 ONNX 推理（@xenova/transformers），避免阻塞 Electron 主进程 UI。
 * 消息协议（主进程 → Worker）：
 *   { type: 'init', data: { modelName, cacheDir }, id }
 *   { type: 'embed', data: { texts, batchSize }, id }
 *   { type: 'terminate' }
 * 消息协议（Worker → 主进程）：
 *   { type: 'ready' | 'result' | 'error', id, ... }
 *   { type: 'downloadProgress', id, progress }
 *   { type: 'batchProgress', id, current, total }
 */
const { parentPort } = require('worker_threads');

// ========== 关键修复：注入浏览器 User-Agent ==========
// 根因：transformers.js 在 Node 环境请求模型时 UA 为 `transformers.js/x.y.z`，
// hf-mirror.com 的防护会直接 RST（重置连接）这种请求，导致多源切换也全部失败。
// 在 require transformers 之前替换全局 fetch，确保其内部下载请求都带浏览器 UA。
const _origFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (!headers.has('User-Agent')) {
        headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    }
    return _origFetch(url, { ...options, headers });
};

const { pipeline, env } = require('@xenova/transformers');
const fs = require('fs/promises');
const path = require('path');

// 多下载源：模型下载失败时按顺序自动切换（国内镜像 hf-mirror 优先 → HuggingFace 官方兑底）
// 顺序说明：国内环境直连 huggingface.co 通常被墙/超时，hf-mirror 在国内可直连且经上面 UA 修复后稳定。
const REMOTE_SOURCES = ['https://hf-mirror.com/', 'https://huggingface.co/'];

// ========== GitHub 仓库兑底下载 ==========
// 模型文件已分片托管到 GitHub 仓库（onnx 113MB 切成 8 片，各 ~14MB）。
// 当所有在线源（hf-mirror / huggingface）都下载失败时，直接从 GitHub 仓库拉取并写入
// transformers 的本地缓存目录，随后 pipeline 会命中缓存直接加载，不再发起网络请求。
// 下载走加速代理（gh-proxy / ghfast），raw 直连作为最后手段。
const GITHUB_FILES = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    { file: 'onnx/model_quantized.onnx', parts: 8, partName: (i) => `onnx/model_quantized.onnx.part${i}` }
];
// 下载通道（按顺序尝试）：加速代理 × 2 → raw 直连（慢，仅最后手段）
const GITHUB_CHANNELS = [
    (p) => `https://gh-proxy.com/https://raw.githubusercontent.com/tian2418671-sys/JSKZX/master/models/${p}`,
    (p) => `https://ghfast.top/https://raw.githubusercontent.com/tian2418671-sys/JSKZX/master/models/${p}`,
    (p) => `https://raw.githubusercontent.com/tian2418671-sys/JSKZX/master/models/${p}`
];
const FETCH_TIMEOUT_MS = 120000; // 单文件/分片下载超时 2 分钟

// 带超时的 fetch（防连接挂起导致整个 Worker 卡死）
async function fetchWithTimeout(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    } finally {
        clearTimeout(timer);
    }
}

// 依次尝试所有通道下载一个仓库文件
async function downloadViaChannels(relPath, id) {
    let lastErr = null;
    for (let i = 0; i < GITHUB_CHANNELS.length; i++) {
        const url = GITHUB_CHANNELS[i](relPath);
        parentPort.postMessage({ type: 'downloadSource', id, source: `GitHub 仓库兑底 (通道 ${i + 1}/${GITHUB_CHANNELS.length})`, attempt: 1, total: 1 });
        try {
            return await fetchWithTimeout(url);
        } catch (e) {
            lastErr = e;
        }
    }
    throw new Error(`GitHub 兑底下载失败 ${relPath}: ${lastErr ? lastErr.message : '所有通道失败'}`);
}

// 原子写入：先写 tmp 再 rename，保证缓存文件不会是半截
async function writeAtomic(destPath, buf) {
    const tmp = destPath + '.tmp';
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, destPath);
}

/**
 * 从 GitHub 仓库兑底下载模型到 transformers 缓存目录。
 * 小文件存在且非空则跳过；大文件分片逐个下载（已完整的分片跳过，支持断点续传）。
 */
async function downloadFallbackFromGithub(modelName, cacheDir, id) {
    const modelDir = path.join(cacheDir, modelName); // cacheDir/Xenova/paraphrase-multilingual-MiniLM-L12-v2
    for (const entry of GITHUB_FILES) {
        if (typeof entry === 'string') {
            const destPath = path.join(modelDir, entry);
            try {
                const st = await fs.stat(destPath);
                if (st.size > 0) continue; // 已下载完整
            } catch { /* 不存在则下载 */ }
            const buf = await downloadViaChannels(modelName + '/' + entry, id);
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await writeAtomic(destPath, buf);
            parentPort.postMessage({ type: 'downloadProgress', id, progress: { status: 'done', file: entry } });
        } else {
            const destPath = path.join(modelDir, entry.file);
            const chunks = [];
            for (let i = 1; i <= entry.parts; i++) {
                const partFile = entry.partName(i);
                const partDest = path.join(modelDir, partFile);
                try {
                    const st = await fs.stat(partDest);
                    if (st.size > 0) {
                        chunks.push(await fs.readFile(partDest)); // 断点续传：已完整分片直接复用
                        continue;
                    }
                } catch { /* 不存在则下载 */ }
                const buf = await downloadViaChannels(modelName + '/' + partFile, id);
                await fs.mkdir(path.dirname(partDest), { recursive: true });
                await writeAtomic(partDest, buf);
                chunks.push(buf);
                parentPort.postMessage({
                    type: 'downloadProgress', id,
                    progress: { status: 'download', file: `onnx 分片 ${i}/${entry.parts}`, progress: Math.round(i / entry.parts * 100) }
                });
            }
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await writeAtomic(destPath, Buffer.concat(chunks));
        }
    }
}

let extractor = null;
let modelLoaded = false;

parentPort.on('message', async (msg) => {
    const { type, data, id } = msg;

    if (type === 'init') {
        try {
            // 修正 1.1：用 cacheDir 而非 useBrowserCache（后者是浏览器 Cache API，Node 主进程不存在）
            env.cacheDir = data.cacheDir;
            env.allowLocalModels = true;
            env.allowRemoteModels = true;

            // 多下载源：支持从主进程传入自定义源列表，缺省用内置的官方源 + 国内镜像
            const sources = (Array.isArray(data.sources) && data.sources.length > 0)
                ? data.sources
                : REMOTE_SOURCES;

            let lastError = null;
            for (let i = 0; i < sources.length; i++) {
                const source = sources[i];
                // transformers.js 在下载时读取 env.remoteHost，切换源即可切换下载地址
                env.remoteHost = source;
                parentPort.postMessage({ type: 'downloadSource', id, source, attempt: i + 1, total: sources.length });

                try {
                    extractor = await pipeline('feature-extraction', data.modelName, {
                        quantized: true,
                        progress_callback: (p) => {
                            parentPort.postMessage({ type: 'downloadProgress', id, progress: p });
                        }
                    });
                    modelLoaded = true;
                    parentPort.postMessage({ type: 'ready', id });
                    return;
                } catch (err) {
                    lastError = err;
                    extractor = null;
                    modelLoaded = false;
                    // 继续尝试下一个下载源
                }
            }

            // ===== 兑底：所有在线源失败后，从 GitHub 仓库拉取模型到本地缓存 =====
            try {
                parentPort.postMessage({
                    type: 'downloadSource', id,
                    source: 'GitHub 仓库兑底（正在从仓库拉取模型）',
                    attempt: sources.length + 1, total: sources.length + 1
                });
                await downloadFallbackFromGithub(data.modelName, data.cacheDir, id);
                // 文件已写入缓存目录，pipeline 将命中本地缓存直接加载（不再发起网络请求）
                extractor = await pipeline('feature-extraction', data.modelName, {
                    quantized: true,
                    progress_callback: (p) => {
                        parentPort.postMessage({ type: 'downloadProgress', id, progress: p });
                    }
                });
                modelLoaded = true;
                parentPort.postMessage({ type: 'ready', id });
                return;
            } catch (fbErr) {
                lastError = fbErr;
                extractor = null;
                modelLoaded = false;
            }

            // 所有源均失败
            const detail = lastError ? (lastError.message || String(lastError)) : '所有下载源均失败';
            parentPort.postMessage({ type: 'error', id, error: `模型下载失败（已尝试 ${sources.length} 个在线源 + GitHub 仓库兑底）: ${detail}` });
        } catch (err) {
            parentPort.postMessage({ type: 'error', id, error: err.message || String(err) });
        }
        return;
    }

    if (type === 'embed') {
        if (!extractor || !modelLoaded) {
            parentPort.postMessage({ type: 'error', id, error: 'Model not loaded' });
            return;
        }
        try {
            const { texts, batchSize } = data;
            const vectors = [];
            const transferList = [];

            // 分批内部处理，防止 Worker 内存溢出
            for (let i = 0; i < texts.length; i += batchSize) {
                const batch = texts.slice(i, i + batchSize);
                const output = await extractor(batch, { pooling: 'mean', normalize: true });

                // 修正 1.2：严格按 dims 重塑 Tensor（output.data 是拼接的一维数组，不能整块当单个向量）
                const dim = output.dims[output.dims.length - 1];
                const flat = output.data; // Float32Array

                for (let j = 0; j < batch.length; j++) {
                    const start = j * dim;
                    const end = start + dim;
                    // 转 ArrayBuffer 以便 transferable 零拷贝传输（比 Array<Number> 快数倍）
                    const buf = flat.slice(start, end).buffer;
                    vectors.push(buf);
                    transferList.push(buf);
                }

                parentPort.postMessage(
                    { type: 'batchProgress', id, current: Math.min(i + batchSize, texts.length), total: texts.length },
                    []
                );
            }

            parentPort.postMessage({ type: 'result', id, vectors }, transferList);
        } catch (err) {
            parentPort.postMessage({ type: 'error', id, error: err.message || String(err) });
        }
        return;
    }

    if (type === 'terminate') {
        process.exit(0);
    }
});
