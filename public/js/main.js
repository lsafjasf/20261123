// 主控：音频图装配、检测循环、渲染循环、控件逻辑。
//
// 信号链：
//   素材/麦克风 → inputGain → [NotchBank 陷波链] → monitorGain → 扬声器
//                    │                │
//                    └→ preAnalyser   └→ postAnalyser（检测与显示均为抽头，不在监听路径上，
//                                        因此监听延迟仅由输出设备决定，陷波群延迟 <1ms）
import { HowlDetector } from './detector.js';
import { NotchBank } from './notches.js';
import { renderMaterial } from './material.js';
import { drawSpectrum, renderNotchTable, log } from './ui.js';
const FFT_SIZE = 4096;
const DETECT_FPS = 20;
const $ = (id) => document.getElementById(id);
const playBtn = $('play');
const micBtn = $('mic');
const stopBtn = $('stop');
const materialSel = $('material');
const monitorSlider = $('monitor');
const sensSlider = $('sensitivity');
const suppressChk = $('suppress');
let ctx = null;
let inputGain;
let monitorGain;
let preAnalyser;
let postAnalyser;
let bank;
let detector;
let source = null;
let micStream = null;
let marks = [];
let lastRisky = [];
function ensureGraph() {
    if (ctx)
        return;
    ctx = new AudioContext({ latencyHint: 'interactive' });
    inputGain = ctx.createGain();
    monitorGain = ctx.createGain();
    preAnalyser = ctx.createAnalyser();
    postAnalyser = ctx.createAnalyser();
    for (const a of [preAnalyser, postAnalyser]) {
        a.fftSize = FFT_SIZE;
        a.smoothingTimeConstant = 0.4;
    }
    bank = new NotchBank(ctx);
    detector = new HowlDetector({
        sampleRate: ctx.sampleRate,
        fftSize: FFT_SIZE,
        framesPerSecond: DETECT_FPS,
        sensitivity: 0.5,
    });
    inputGain.connect(bank.input);
    inputGain.connect(preAnalyser);
    bank.output.connect(monitorGain);
    bank.output.connect(postAnalyser);
    monitorGain.connect(ctx.destination);
    monitorGain.gain.value = Number(monitorSlider.value) / 100;
    log(`音频图就绪，采样率 ${ctx.sampleRate} Hz，基延迟 ${(ctx.baseLatency * 1000).toFixed(1)} ms`);
}
function stopSource() {
    if (source && 'stop' in source) {
        try {
            source.stop();
        }
        catch { /* 已停止 */ }
    }
    source?.disconnect();
    source = null;
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
    stopBtn.disabled = true;
    playBtn.disabled = false;
    micBtn.disabled = false;
}
function startPlayback() {
    ensureGraph();
    void ctx.resume();
    stopSource();
    const kind = materialSel.value;
    const { data, howlFreq } = renderMaterial(kind, ctx.sampleRate);
    const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buf.copyToChannel(data, 0);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(inputGain);
    node.start();
    node.onended = () => { if (source === node)
        stopSource(); };
    source = node;
    stopBtn.disabled = false;
    playBtn.disabled = true;
    micBtn.disabled = true;
    log(`播放素材「${materialSel.selectedOptions[0]?.text}」` +
        (howlFreq ? `，内含 ${howlFreq} Hz 增长窄带（啸叫模拟）` : ''));
}
async function startMic() {
    ensureGraph();
    void ctx.resume();
    stopSource();
    try {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
    }
    catch {
        log('麦克风不可用（需要 localhost/HTTPS 授权）');
        return;
    }
    const node = ctx.createMediaStreamSource(micStream);
    node.connect(inputGain);
    source = node;
    stopBtn.disabled = false;
    playBtn.disabled = true;
    micBtn.disabled = true;
    log('麦克风输入已接入（已关闭浏览器自带降噪/增益，保证检测原始性）');
}
function detectLoop() {
    if (!ctx)
        return;
    const db = new Float32Array(preAnalyser.frequencyBinCount);
    preAnalyser.getFloatFrequencyData(db);
    detector.setSensitivity(Number(sensSlider.value) / 100);
    const excluded = bank.slots.map((s) => s.freq);
    const events = suppressChk.checked ? detector.analyze(db, excluded) : [];
    lastRisky = events.map((e) => e.freq);
    for (const s of bank.slots) {
        if (detector.isRisky(db, s.freq) && !lastRisky.includes(s.freq))
            lastRisky.push(s.freq);
    }
    for (const ev of events) {
        const slot = bank.add(ev.freq);
        if (slot) {
            marks.push({ freq: ev.freq, time: performance.now() / 1000 });
            marks = marks.slice(-20);
            log(`触发陷波 #${slot.id} @ ${ev.freq.toFixed(0)} Hz ` +
                `(增长 ${ev.slopeDbPerSec.toFixed(1)} dB/s，突出 ${ev.prominenceDb.toFixed(1)} dB)`, 'trig');
        }
    }
    const removed = bank.update(lastRisky);
    for (const s of removed) {
        log(`陷波 #${s.id} @ ${s.freq.toFixed(0)} Hz 恢复完成，已释放`, 'rec');
    }
    renderNotchTable(bank, (slot, bypassed) => {
        bank.setBypass(slot, bypassed);
        log(`陷波 #${slot.id} @ ${slot.freq.toFixed(0)} Hz ${bypassed ? '已旁路' : '恢复启用'}`);
    });
}
function renderLoop() {
    requestAnimationFrame(renderLoop);
    if (!ctx || !postAnalyser)
        return;
    const db = new Float32Array(postAnalyser.frequencyBinCount);
    postAnalyser.getFloatFrequencyData(db);
    drawSpectrum(db, ctx.sampleRate, FFT_SIZE, bank, marks);
}
playBtn.addEventListener('click', startPlayback);
micBtn.addEventListener('click', () => void startMic());
stopBtn.addEventListener('click', () => { stopSource(); log('停止'); });
monitorSlider.addEventListener('input', () => {
    if (monitorGain)
        monitorGain.gain.value = Number(monitorSlider.value) / 100;
});
suppressChk.addEventListener('change', () => {
    log(suppressChk.checked ? '自动陷波已启用' : '自动陷波已停用（现有陷波保持，可逐项旁路）');
});
ensureGraph();
window.setInterval(detectLoop, 1000 / DETECT_FPS);
renderLoop();
log('系统就绪。选择素材播放，或接入麦克风实测。');
//# sourceMappingURL=main.js.map