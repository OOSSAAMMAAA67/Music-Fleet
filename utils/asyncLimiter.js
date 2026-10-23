'use strict';
class AsyncLimiter {
    constructor({ concurrency = 8, maxPending = 500 } = {}) {
        if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(maxPending) || maxPending < 1) throw new TypeError('Limiter bounds must be positive integers.');
        this.concurrency = concurrency; this.maxPending = maxPending;
        this.running = 0; this.queue = [];
    }
    run(work, { signal } = {}) {
        if (typeof work !== 'function') return Promise.reject(new TypeError('Limiter work must be a function.'));
        if (signal?.aborted) return Promise.reject(signal.reason || new Error('Cancelled.'));
        if (this.queue.length >= this.maxPending) return Promise.reject(Object.assign(new Error('Metadata queue is busy; retry shortly.'), { code: 'METADATA_BUSY' }));
        return new Promise((resolve, reject) => {
            const item = { work, resolve, reject, signal };
            item.cancel = () => {
                const index = this.queue.indexOf(item);
                if (index >= 0) { this.queue.splice(index, 1); reject(signal.reason || new Error('Cancelled.')); }
            };
            signal?.addEventListener('abort', item.cancel, { once: true });
            this.queue.push(item); this._pump();
        });
    }
    _pump() {
        while (this.running < this.concurrency && this.queue.length) {
            const item = this.queue.shift(); item.signal?.removeEventListener('abort', item.cancel);
            if (item.signal?.aborted) { item.reject(item.signal.reason || new Error('Cancelled.')); continue; }
            this.running++;
            Promise.resolve().then(item.work).then(item.resolve, item.reject).finally(() => { this.running--; this._pump(); });
        }
    }
}
module.exports = { AsyncLimiter };
