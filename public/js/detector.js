// 啸叫检测器：在频谱时间序列上识别“持续增长的窄带分量”。
// 设计要点：
//  - 逐频点斜率：对每个 FFT bin 的 dB 轨迹做滑动窗线性回归，只有
//    “持续正增长”才算风险（讲话/长音电平稳定，斜率≈0）。
//  - 窄带突出度：bin 电平需显著高于邻域中位数（啸叫是单频自激）。
//  - 宽带守卫：整帧谱平坦度高（讲话/噪声类宽带素材）时提高门限。
//  - 绝对电平门限：避免在噪声地板上误触发。
const HISTORY = 20; // 每 bin 保留的历史帧数
const MIN_FREQ = 150; // 啸叫监测下限
const MAX_FREQ = 9000; // 上限
const NEIGHBOR_GAP = 3; // 突出度计算的邻域间隔
const NEIGHBOR_SPAN = 10; // 邻域半宽
export class HowlDetector {
    constructor(cfg) {
        this.history = [];
        this.cooldownUntil = 0;
        this.frameIndex = 0;
        this.cfg = cfg;
        this.binCount = cfg.fftSize / 2;
    }
    reset() {
        this.history = [];
        this.frameIndex = 0;
        this.cooldownUntil = 0;
    }
    setSensitivity(v) {
        this.cfg.sensitivity = Math.max(0, Math.min(1, v));
    }
    binToFreq(bin) {
        return (bin * this.cfg.sampleRate) / this.cfg.fftSize;
    }
    /** 谱平坦度（几何均值/算数均值），宽带信号接近 1 */
    spectralFlatness(db) {
        let logSum = 0, sum = 0, count = 0;
        for (let i = 2; i < this.binCount; i += 2) {
            const lin = Math.pow(10, (db[i] ?? -100) / 20);
            logSum += Math.log(lin + 1e-12);
            sum += lin;
            count++;
        }
        if (count === 0 || sum <= 0)
            return 1;
        return Math.exp(logSum / count) / (sum / count);
    }
    /** 邻域中位数（排除自身附近 ±NEIGHBOR_GAP） */
    neighborMedian(db, bin) {
        const vals = [];
        for (let d = NEIGHBOR_GAP; d <= NEIGHBOR_SPAN; d++) {
            const lo = db[bin - d];
            const hi = db[bin + d];
            if (lo !== undefined)
                vals.push(lo);
            if (hi !== undefined)
                vals.push(hi);
        }
        if (vals.length === 0)
            return -100;
        vals.sort((a, b) => a - b);
        return vals[vals.length >> 1] ?? -100;
    }
    /** 单 bin 的 dB/秒 斜率（最近窗口的线性回归） */
    slope(bin, window) {
        const h = this.history;
        if (h.length < window)
            return 0;
        const n = window;
        let sx = 0, sy = 0, sxy = 0, sxx = 0;
        for (let k = 0; k < n; k++) {
            const frame = h[h.length - n + k];
            const y = frame?.[bin] ?? -100;
            sx += k;
            sy += y;
            sxy += k * y;
            sxx += k * k;
        }
        const denom = n * sxx - sx * sx;
        if (denom === 0)
            return 0;
        const perFrame = (n * sxy - sx * sy) / denom;
        return perFrame * this.cfg.framesPerSecond;
    }
    /** 宽带电平斜率（全带均值的 dB/s）。讲话 onset 全带齐涨，啸叫只涨单 bin */
    broadbandSlope(window) {
        const h = this.history;
        if (h.length < window)
            return 0;
        const bandMean = (frame) => {
            let sum = 0, count = 0;
            for (let i = 2; i < frame.length; i += 4) {
                sum += frame[i] ?? -100;
                count++;
            }
            return count ? sum / count : -100;
        };
        const first = bandMean(h[h.length - window]);
        const last = bandMean(h[h.length - 1]);
        return ((last - first) / (window - 1)) * this.cfg.framesPerSecond;
    }
    /** 增长一致性：窗口内逐帧正增长的占比。啸叫≈1，颤音/讲话≈0.5 */
    growthConsistency(bin, window) {
        const h = this.history;
        if (h.length < window)
            return 0;
        let pos = 0;
        for (let k = h.length - window + 1; k < h.length; k++) {
            const cur = h[k]?.[bin] ?? -100;
            const prev = h[k - 1]?.[bin] ?? -100;
            if (cur - prev > 0.05)
                pos++;
        }
        return pos / (window - 1);
    }
    /** 峰位驻留：窗口内该 bin(±1) 保持“窄带局部峰”的帧占比。扫频/讲话峰位会移动 */
    peakPersistence(bin, window, promThresh) {
        const h = this.history;
        if (h.length < window)
            return 0;
        let hit = 0;
        for (let k = h.length - window; k < h.length; k++) {
            const frame = h[k];
            if (!frame)
                continue;
            let ok = false;
            for (let b = bin - 1; b <= bin + 1; b++) {
                const level = frame[b] ?? -100;
                if (level < (frame[b - 1] ?? -100) || level < (frame[b + 1] ?? -100))
                    continue;
                if (level - this.neighborMedian(frame, b) >= promThresh * 0.6) {
                    ok = true;
                    break;
                }
            }
            if (ok)
                hit++;
        }
        return hit / window;
    }
    /** 起始电平守卫：窗口前段该 bin 必须已有信号。
     *  啸叫从既有声场上持续增长；讲话/长音的 onset 从无声突起，予以排除。 */
    onsetGuard(bin, window, absThresh) {
        const h = this.history;
        if (h.length < window)
            return false;
        const head = Math.max(2, Math.floor(window / 4));
        let sum = 0;
        for (let k = h.length - window; k < h.length - window + head; k++) {
            sum += h[k]?.[bin] ?? -100;
        }
        return sum / head > absThresh;
    }
    thresholds() {
        const s = this.cfg.sensitivity;
        return {
            slopeEff: 6 - 3.5 * s,
            promThresh: 12 - 5 * s,
            absThresh: -62,
        };
    }
    /** 评估既有陷波频点当前是否仍有增长风险（用于保持/恢复决策） */
    isRisky(db, freq) {
        const bin = Math.round((freq * this.cfg.fftSize) / this.cfg.sampleRate);
        if (bin < 2 || bin >= this.binCount - NEIGHBOR_SPAN)
            return false;
        const { slopeEff, promThresh, absThresh } = this.thresholds();
        const level = db[bin] ?? -100;
        if (level < absThresh)
            return false;
        if (level - this.neighborMedian(db, bin) < promThresh * 0.6)
            return false;
        const minWindow = Math.min(12, HISTORY);
        return this.slope(bin, minWindow) > slopeEff * 0.5;
    }
    /**
     * 输入一帧频谱（dB，来自 AnalyserNode.getFloatFrequencyData），
     * 返回检测到的啸叫候选（按斜率排序，最多 maxEvents 个）。
     */
    analyze(db, excludedFreqs, maxEvents = 2) {
        this.history.push(Float32Array.from(db));
        if (this.history.length > HISTORY)
            this.history.shift();
        this.frameIndex++;
        const minWindow = Math.min(12, HISTORY);
        if (this.history.length < minWindow)
            return [];
        if (this.frameIndex < this.cooldownUntil)
            return [];
        // 灵敏度映射：门限随灵敏度插值
        const { slopeEff: slopeBase, promThresh, absThresh } = this.thresholds();
        const flatness = this.spectralFlatness(db);
        // 宽带素材（讲话）提高斜率门限，最多 +2 dB/s
        const slopeEff = slopeBase + Math.min(2, flatness * 5);
        const wideSlope = this.broadbandSlope(minWindow);
        const binLo = Math.max(2, Math.floor((MIN_FREQ * this.cfg.fftSize) / this.cfg.sampleRate));
        const binHi = Math.min(this.binCount - NEIGHBOR_SPAN - 1, Math.ceil((MAX_FREQ * this.cfg.fftSize) / this.cfg.sampleRate));
        const events = [];
        for (let b = binLo; b < binHi; b++) {
            const level = db[b] ?? -100;
            if (level < absThresh)
                continue;
            // 局部峰：高于相邻 bin
            if (level < (db[b - 1] ?? -100) || level < (db[b + 1] ?? -100))
                continue;
            const prominence = level - this.neighborMedian(db, b);
            if (prominence < promThresh)
                continue;
            const sl = this.slope(b, minWindow);
            if (sl < slopeEff)
                continue;
            if (sl < wideSlope + 2)
                continue;
            if (this.growthConsistency(b, minWindow) < 0.7)
                continue;
            if (this.peakPersistence(b, minWindow, promThresh) < 0.7)
                continue;
            if (!this.onsetGuard(b, minWindow, absThresh))
                continue;
            const freq = this.binToFreq(b);
            // 与已有陷波保持间隔（±4%），避免重复触发同一点
            if (excludedFreqs.some((f) => Math.abs(f - freq) / f < 0.04))
                continue;
            events.push({ freq, bin: b, slopeDbPerSec: sl, prominenceDb: prominence });
        }
        events.sort((a, b2) => b2.slopeDbPerSec - a.slopeDbPerSec);
        const picked = events.slice(0, maxEvents);
        if (picked.length > 0) {
            // 触发后短暂冷却，让陷波生效后再评估
            this.cooldownUntil = this.frameIndex + Math.floor(this.cfg.framesPerSecond * 0.5);
        }
        return picked;
    }
}
//# sourceMappingURL=detector.js.map