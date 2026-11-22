// 陷波器管理：受控介入（交叉淡入避免爆音）、逐项旁路、自动恢复。
// 每个槽位结构：in → [biquad(notch) → wetGain] → out
//                  └→ [dryGain] ────────────────┘
// 旁路 = dry 1 / wet 0；启用 = dry 0 / wet 1，切换用短斜坡防爆音。
const RAMP = 0.15; // 介入/旁路交叉淡化时间（秒）
const RECOVER_HOLD = 5; // 无风险持续该时长后开始恢复（秒）
const RECOVER_FADE = 2; // 恢复淡出时长（秒）
const MAX_SLOTS = 8;
export class NotchBank {
    constructor(ctx) {
        this.slots = [];
        this.nextId = 1;
        this.ctx = ctx;
        this.input = ctx.createGain();
        this.output = ctx.createGain();
        this.input.connect(this.output);
    }
    relink() {
        this.input.disconnect();
        for (const s of this.slots)
            s.output.disconnect();
        let prev = this.input;
        for (const s of this.slots) {
            prev.connect(s.input);
            prev = s.output;
        }
        prev.connect(this.output);
    }
    /** 在指定频率受控启用一个陷波器 */
    add(freq) {
        if (this.slots.length >= MAX_SLOTS)
            return null;
        const t = this.ctx.currentTime;
        const input = this.ctx.createGain();
        const output = this.ctx.createGain();
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'notch';
        filter.frequency.value = freq;
        filter.Q.value = 12;
        const dry = this.ctx.createGain();
        const wet = this.ctx.createGain();
        input.connect(filter);
        filter.connect(wet);
        wet.connect(output);
        input.connect(dry);
        dry.connect(output);
        // 受控介入：wet 从 0 淡入，dry 淡出
        dry.gain.setValueAtTime(1, t);
        dry.gain.linearRampToValueAtTime(0, t + RAMP);
        wet.gain.setValueAtTime(0, t);
        wet.gain.linearRampToValueAtTime(1, t + RAMP);
        const slot = {
            id: this.nextId++, freq, state: 'active', recoverProgress: 0,
            input, output, filter, dry, wet, lastRiskTime: t,
        };
        this.slots.push(slot);
        this.relink();
        return slot;
    }
    /** 逐项旁路切换 */
    setBypass(slot, bypassed) {
        const t = this.ctx.currentTime;
        const wetTarget = bypassed ? 0 : 1;
        slot.dry.gain.cancelScheduledValues(t);
        slot.wet.gain.cancelScheduledValues(t);
        slot.dry.gain.setValueAtTime(slot.dry.gain.value, t);
        slot.wet.gain.setValueAtTime(slot.wet.gain.value, t);
        slot.dry.gain.linearRampToValueAtTime(1 - wetTarget, t + RAMP);
        slot.wet.gain.linearRampToValueAtTime(wetTarget, t + RAMP);
        slot.state = bypassed ? 'bypassed' : 'active';
        slot.recoverProgress = 0;
        slot.lastRiskTime = t;
    }
    /**
     * 每帧调用：根据各频点当前风险状态推进恢复过程。
     * riskyFreqs 为检测器判定仍有增长风险的频率集合。
     * 返回本次完成恢复并移除的槽位。
     */
    update(riskyFreqs) {
        const t = this.ctx.currentTime;
        const removed = [];
        for (const s of this.slots) {
            if (riskyFreqs.some((f) => Math.abs(f - s.freq) / s.freq < 0.04)) {
                s.lastRiskTime = t;
                if (s.state === 'recovering') {
                    s.state = 'active';
                    s.recoverProgress = 0;
                    this.setWet(s, 1);
                }
            }
        }
        for (let i = this.slots.length - 1; i >= 0; i--) {
            const s = this.slots[i];
            if (s.state === 'bypassed')
                continue;
            const quiet = t - s.lastRiskTime;
            if (s.state === 'active' && quiet > RECOVER_HOLD) {
                s.state = 'recovering';
                s.recoverProgress = 0;
            }
            if (s.state === 'recovering') {
                s.recoverProgress = Math.min(1, (quiet - RECOVER_HOLD) / RECOVER_FADE);
                this.setWet(s, 1 - s.recoverProgress);
                if (s.recoverProgress >= 1) {
                    removed.push(s);
                    this.slots.splice(i, 1);
                }
            }
        }
        if (removed.length > 0)
            this.relink();
        return removed;
    }
    setWet(s, v) {
        const t = this.ctx.currentTime;
        s.wet.gain.cancelScheduledValues(t);
        s.wet.gain.setTargetAtTime(v, t, 0.05);
        s.dry.gain.cancelScheduledValues(t);
        s.dry.gain.setTargetAtTime(1 - v, t, 0.05);
    }
    clear() {
        this.slots.length = 0;
        this.relink();
    }
}
//# sourceMappingURL=notches.js.map