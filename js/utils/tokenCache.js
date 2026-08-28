/**
 * 卡片 Token 估算缓存。使用 WeakMap 按卡片对象缓存，卡片释放后缓存可自动回收。
 */
import { estimateTokens } from './tokenEstimate.js';

class TokenCache {
    constructor() {
        this.cache = new WeakMap();
        this.stats = { hits: 0, misses: 0, totalComputed: 0, totalTime: 0 };
    }

    get(card) {
        if (!card || typeof card !== 'object') return 0;
        if (this.cache.has(card)) {
            this.stats.hits++;
            return this.cache.get(card);
        }
        this.stats.misses++;
        const start = performance.now();
        const tokens = estimateTokens(this._extractFullText(card));
        this.stats.totalComputed++;
        this.stats.totalTime += performance.now() - start;
        this.cache.set(card, tokens);
        return tokens;
    }

    getBatch(cards) { return (cards || []).map(card => [card, this.get(card)]); }

    warmup(cards) { for (const card of cards || []) this.get(card); }

    /**
     * 异步分片预热：将大批量卡片拆分为小块，每块之间 yield 给主线程，
     * 避免阻塞 UI 渲染和用户交互。
     */
    async warmupAsync(cards, chunkSize = 50) {
        const list = cards || [];
        for (let i = 0; i < list.length; i += chunkSize) {
            const chunk = list.slice(i, i + chunkSize);
            for (const card of chunk) this.get(card);
            if (i + chunkSize < list.length) {
                await new Promise(resolve => {
                    if (typeof requestIdleCallback === 'function') {
                        requestIdleCallback(resolve, { timeout: 50 });
                    } else {
                        setTimeout(resolve, 0);
                    }
                });
            }
        }
    }

    clear() {
        this.cache = new WeakMap();
        this.stats = { hits: 0, misses: 0, totalComputed: 0, totalTime: 0 };
    }

    getStats() {
        const total = this.stats.hits + this.stats.misses;
        return {
            ...this.stats,
            hitRate: total ? `${((this.stats.hits / total) * 100).toFixed(2)}%` : '0%',
            avgComputeTime: this.stats.totalComputed
                ? `${(this.stats.totalTime / this.stats.totalComputed).toFixed(2)}ms`
                : '0ms'
        };
    }

    _extractFullText(card) {
        const data = card?.data?.data || card?.data || {};
        const parts = [
            card?.name, card?.creator, card?.fileName, card?.path,
            data.name, data.creator || data.author, data.description,
            data.personality, data.scenario, data.first_mes,
            data.mes_example, data.creator_notes,
            Array.isArray(data.alternate_greetings) ? data.alternate_greetings.join(' ') : '',
            data.extensions?.depth_prompt?.prompt,
            typeof data.extensions?.system_prompt === 'string' ? data.extensions.system_prompt : ''
        ];
        return parts.filter(Boolean).join(' ');
    }
}

export default new TokenCache();
