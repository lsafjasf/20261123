// 主线程：音频图管理、链顺序/旁路/预设 UI、设备热插拔、测试信号、延迟显示。
// 设计要点：所有 DSP 常驻同一个 AudioWorklet，设备断开只替换输入源节点，
// 链的顺序/旁路/参数保存在单一 state 对象中，不会因设备变化而错位。

                                           

                      
                  
                                  
           
                             
                                
                                 
    
 

const PROC_META                                                 = {
  nr: { name: '降噪', desc: '谱减法，抑制平稳背景噪声' },
  clarity: { name: '清晰度', desc: '临场感/空气感 EQ，提升语音可懂度' },
  limiter: { name: '限峰', desc: '前视限幅，防止爆音削波' }
};

const state             = {
  order: ['nr', 'clarity', 'limiter'],
  bypass: { nr: false, clarity: false, limiter: false },
  params: {
    nr: { strength: 0.6 },
    clarity: { amount: 0.5 },
    limiter: { ceiling: 0.89 }
  }
};

// ---------- 音频图 ----------
let ctx                      = null;
let workletNode                          = null;
let analyser                      = null;
let monitorGain                  = null;
let recordDest                                         = null;
let srcNode                   = null;
let micStream                     = null;
let testSrc                               = null;
let workletLatencySamples = 0;

let currentDeviceId = '';
let currentDeviceLabel = '';
let micLive = false;
let wantMic = false; // 用户期望使用麦克风（断开后自动重连用）

function $(id        )              {
  const el = document.getElementById(id);
  if (!el) throw new Error('missing element #' + id);
  return el;
}

function setStatus(text        , warn         )       {
  const el = $('deviceStatus');
  el.textContent = text;
  el.className = warn ? 'status warn' : 'status ok';
}

async function initAudio()                {
  if (ctx) return;
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('worklet.js');
  workletNode = new AudioWorkletNode(ctx, 'chain-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1]
  });
  workletNode.port.onmessage = (e              ) => {
    const msg = e.data                                      ;
    if (msg.type === 'latency' && typeof msg.samples === 'number') {
      workletLatencySamples = msg.samples;
      updateLatencyDisplay();
    }
  };
  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  monitorGain = ctx.createGain();
  monitorGain.gain.value = 1;
  recordDest = ctx.createMediaStreamDestination();
  workletNode.connect(analyser);
  analyser.connect(monitorGain);
  monitorGain.connect(ctx.destination);
  workletNode.connect(recordDest);
  pushConfig();
  startVizLoop();
  updateLatencyDisplay();
}

function pushConfig()       {
  if (!workletNode) return;
  workletNode.port.postMessage({
    type: 'config',
    config: {
      order: state.order,
      bypass: state.bypass,
      params: state.params
    }
  });
}

// 切换输入源：先断开旧源，链接口始终保持在 worklet 上
function replaceSource(node                  )       {
  if (testSrc) {
    try { testSrc.stop(); } catch { /* 已停止 */ }
    testSrc.disconnect();
    testSrc = null;
  }
  if (srcNode) {
    srcNode.disconnect();
    srcNode = null;
  }
  if (node && workletNode) {
    srcNode = node;
    node.connect(workletNode);
  }
}

// ---------- 设备管理 ----------
async function refreshDevices()                {
  const select = $('deviceSelect')                     ;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  select.innerHTML = '';
  for (const d of inputs) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `麦克风 ${select.length + 1}`;
    select.appendChild(opt);
  }
  if (currentDeviceId && inputs.some((d) => d.deviceId === currentDeviceId)) {
    select.value = currentDeviceId;
  }
}

async function openMic(deviceId        )                   {
  if (!ctx) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,   // 处理链自己做，避免系统级处理叠加
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }
    });
    stopMicStream();
    micStream = stream;
    const track = stream.getAudioTracks()[0];
    currentDeviceId = track.getSettings().deviceId || deviceId;
    currentDeviceLabel = track.label;
    // 设备被系统拔出时 track 会触发 ended，作为 devicechange 的补充
    track.onended = () => handleDeviceGone();
    replaceSource(ctx.createMediaStreamSource(stream));
    micLive = true;
    setStatus(`已连接：${currentDeviceLabel}`, false);
    return true;
  } catch (err) {
    setStatus(`打开麦克风失败：${(err         ).message}`, true);
    return false;
  }
}

function stopMicStream()       {
  if (micStream) {
    for (const t of micStream.getTracks()) t.stop();
    micStream = null;
  }
}

// 设备断开：只摘除输入源，链配置（顺序/旁路/参数/预设）全部保留
function handleDeviceGone()       {
  if (!micLive) return;
  stopMicStream();
  replaceSource(null);
  micLive = false;
  setStatus(`设备「${currentDeviceLabel}」已断开，处理链状态已保留，等待重连…`, true);
}

async function handleDeviceChange()                {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const stillThere = inputs.some((d) => d.deviceId === currentDeviceId);
  await refreshDevices();
  if (micLive && !stillThere) {
    handleDeviceGone();
  } else if (!micLive && wantMic && stillThere) {
    // 同一设备重新插入：自动恢复，链状态原样生效
    const ok = await openMic(currentDeviceId);
    if (ok) setStatus(`已自动重连：${currentDeviceLabel}`, false);
  }
}

// ---------- 测试信号：呼吸 / 敲击 / 长元音 ----------
// 用 OfflineAudioContext 程序化渲染，循环播放进处理链，便于无麦调试。
function makeNoiseBuffer(offline                     , seconds        )              {
  const len = Math.floor(offline.sampleRate * seconds);
  const buf = offline.createBuffer(1, len, offline.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    last = last * 0.98 + white * 0.02; // 单极点低通，近似粉红噪声
    data[i] = last * 6;
  }
  return buf;
}

async function renderBreath()                       {
  const off = new OfflineAudioContext(1, 48000 * 4, 48000);
  const noise = off.createBufferSource();
  noise.buffer = makeNoiseBuffer(off, 4);
  const band = off.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 600;
  band.Q.value = 0.7;
  const amp = off.createGain();
  amp.gain.value = 0.5;
  const lfo = off.createOscillator();
  lfo.frequency.value = 0.3; // 呼吸节奏
  const lfoDepth = off.createGain();
  lfoDepth.gain.value = 0.35;
  lfo.connect(lfoDepth).connect(amp.gain);
  noise.connect(band).connect(amp).connect(off.destination);
  noise.start();
  lfo.start();
  return off.startRendering();
}

async function renderKnock()                       {
  const sr = 48000;
  const off = new OfflineAudioContext(1, sr * 4, sr);
  const buf = off.createBuffer(1, sr * 4, sr);
  const data = buf.getChannelData(0);
  // 每 0.8 秒一次敲击：180Hz 指数衰减正弦 + 高频瞬态
  for (let k = 0; k < 5; k++) {
    const t0 = Math.floor((0.2 + k * 0.8) * sr);
    const len = Math.floor(0.15 * sr);
    for (let i = 0; i < len && t0 + i < data.length; i++) {
      const t = i / sr;
      const env = Math.exp(-t * 40);
      data[t0 + i] += Math.sin(2 * Math.PI * 180 * t) * env * 0.9
        + (Math.random() * 2 - 1) * Math.exp(-t * 300) * 0.4;
    }
  }
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return off.startRendering();
}

async function renderVowel()                       {
  const off = new OfflineAudioContext(1, 48000 * 4, 48000);
  const osc = off.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 110;
  // 元音 /a/ 的近似共振峰：730 / 1090 / 2440 Hz
  let node            = osc;
  for (const [freq, gain] of [[730, 10], [1090, 8], [2440, 6]]         ) {
    const f = off.createBiquadFilter();
    f.type = 'peaking';
    f.frequency.value = freq;
    f.Q.value = 6;
    f.gain.value = gain;
    node.connect(f);
    node = f;
  }
  const amp = off.createGain();
  amp.gain.value = 0.25;
  node.connect(amp).connect(off.destination);
  osc.start();
  return off.startRendering();
}

const TEST_RENDERERS                                             = {
  breath: renderBreath,
  knock: renderKnock,
  vowel: renderVowel
};

async function playTest(kind        )                {
  await initAudio();
  if (ctx && ctx.state === 'suspended') await ctx.resume();
  const buffer = await TEST_RENDERERS[kind]();
  wantMic = false;
  stopMicStream();
  micLive = false;
  replaceSource(null);
  testSrc = (ctx                ).createBufferSource();
  testSrc.buffer = buffer;
  testSrc.loop = true;
  replaceSource(testSrc);
  testSrc.start();
  const names                         = { breath: '呼吸声', knock: '敲击声', vowel: '长元音 /a/' };
  setStatus(`测试信号播放中：${names[kind]}（循环）`, false);
}

function stopTest()       {
  replaceSource(null);
  setStatus(wantMic ? '测试已停止，等待麦克风…' : '测试已停止，输入空闲', false);
}

// ---------- 链 UI：可拖拽卡片 ----------
let dragId                = null;

function renderChain()       {
  const list = $('chainList');
  list.innerHTML = '';
  state.order.forEach((id, index) => {
    const meta = PROC_META[id];
    const card = document.createElement('div');
    card.className = 'card' + (state.bypass[id] ? ' bypassed' : '');
    card.draggable = true;
    card.dataset.proc = id;

    const head = document.createElement('div');
    head.className = 'card-head';
    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = `${index + 1}. ${meta.name}`;
    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = '⠿ 拖动';
    head.append(title, grip);

    const desc = document.createElement('div');
    desc.className = 'card-desc';
    desc.textContent = meta.desc;

    const bypassLabel = document.createElement('label');
    bypassLabel.className = 'bypass';
    const bypassBox = document.createElement('input');
    bypassBox.type = 'checkbox';
    bypassBox.checked = state.bypass[id];
    bypassBox.onchange = () => {
      state.bypass[id] = bypassBox.checked;
      card.classList.toggle('bypassed', bypassBox.checked);
      pushConfig();
    };
    bypassLabel.append(bypassBox, document.createTextNode(' 旁路此模块'));

    card.append(head, desc, bypassLabel, buildParamControls(id));

    card.ondragstart = (e) => {
      dragId = id;
      (e             ).dataTransfer?.setData('text/plain', id);
      card.classList.add('dragging');
    };
    card.ondragend = () => card.classList.remove('dragging');
    card.ondragover = (e) => { e.preventDefault(); card.classList.add('drop-hint'); };
    card.ondragleave = () => card.classList.remove('drop-hint');
    card.ondrop = (e) => {
      e.preventDefault();
      card.classList.remove('drop-hint');
      if (!dragId || dragId === id) return;
      const from = state.order.indexOf(dragId);
      const to = state.order.indexOf(id);
      state.order.splice(to, 0, state.order.splice(from, 1)[0]);
      dragId = null;
      renderChain();
      pushConfig();
    };

    list.appendChild(card);
  });
}

function buildParamControls(id        )              {
  const wrap = document.createElement('div');
  wrap.className = 'params';
  const addSlider = (
    label        , min        , max        , step        ,
    get              , set                     , fmt                       
  )       => {
    const row = document.createElement('label');
    row.className = 'param-row';
    const name = document.createElement('span');
    name.textContent = label;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(get());
    const val = document.createElement('span');
    val.className = 'param-val';
    val.textContent = fmt(get());
    slider.oninput = () => {
      set(Number(slider.value));
      val.textContent = fmt(Number(slider.value));
      pushConfig();
    };
    row.append(name, slider, val);
    wrap.appendChild(row);
  };
  if (id === 'nr') {
    addSlider('降噪强度', 0, 1, 0.01,
      () => state.params.nr.strength,
      (v) => { state.params.nr.strength = v; },
      (v) => `${Math.round(v * 100)}%`);
  } else if (id === 'clarity') {
    addSlider('清晰度提升', 0, 1, 0.01,
      () => state.params.clarity.amount,
      (v) => { state.params.clarity.amount = v; },
      (v) => `${Math.round(v * 100)}%`);
  } else {
    addSlider('限峰门限', 0.5, 1, 0.01,
      () => state.params.limiter.ceiling,
      (v) => { state.params.limiter.ceiling = v; },
      (v) => `${(20 * Math.log10(v)).toFixed(1)} dBFS`);
  }
  return wrap;
}

// ---------- 预设：localStorage 持久化 ----------
const PRESET_KEY = 'lectureChainPresets.v1';

function loadPresets()                             {
  try {
    return JSON.parse(localStorage.getItem(PRESET_KEY) || '{}')                              ;
  } catch {
    return {};
  }
}

function savePreset()       {
  const input = $('presetName')                    ;
  const name = input.value.trim();
  if (!name) return;
  const presets = loadPresets();
  presets[name] = JSON.parse(JSON.stringify(state))              ;
  localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
  input.value = '';
  renderPresetList();
}

function applyPreset(name        )       {
  const p = loadPresets()[name];
  if (!p) return;
  state.order = p.order.slice()            ;
  state.bypass = { ...p.bypass };
  state.params = JSON.parse(JSON.stringify(p.params))                        ;
  renderChain();
  pushConfig();
}

function renderPresetList()       {
  const list = $('presetList');
  list.innerHTML = '';
  const presets = loadPresets();
  for (const name of Object.keys(presets)) {
    const row = document.createElement('div');
    row.className = 'preset-row';
    const apply = document.createElement('button');
    apply.textContent = name;
    apply.onclick = () => applyPreset(name);
    const del = document.createElement('button');
    del.textContent = '删除';
    del.className = 'danger';
    del.onclick = () => {
      const all = loadPresets();
      delete all[name];
      localStorage.setItem(PRESET_KEY, JSON.stringify(all));
      renderPresetList();
    };
    row.append(apply, del);
    list.appendChild(row);
  }
  if (Object.keys(presets).length === 0) {
    list.textContent = '（暂无预设）';
  }
}

// ---------- 处理延迟显示 ----------
function updateLatencyDisplay()       {
  if (!ctx) return;
  const sr = ctx.sampleRate;
  const workletMs = (workletLatencySamples / sr) * 1000;
  const quantumMs = (128 / sr) * 1000; // 渲染量子
  const outSec = (ctx                              ).outputLatency
    ?? ctx.baseLatency ?? 0;
  const outMs = outSec * 1000;
  const total = workletMs + quantumMs + outMs;
  $('latencyValue').textContent = `${total.toFixed(1)} ms`;
  $('latencyBreakdown').textContent =
    `处理链 ${workletMs.toFixed(1)} + 渲染量子 ${quantumMs.toFixed(1)} + 输出设备 ${outMs.toFixed(1)} ms` +
    `${total > 45 ? '（偏高，可旁路降噪降低延迟）' : '（可正常监听）'}`;
}

// ---------- Canvas 可视化：波形 + 频谱 ----------
function startVizLoop()       {
  if (!analyser) return;
  const waveCanvas = $('waveCanvas')                     ;
  const specCanvas = $('specCanvas')                     ;
  const waveCtx = waveCanvas.getContext('2d')                            ;
  const specCtx = specCanvas.getContext('2d')                            ;
  const timeData = new Uint8Array(analyser.fftSize);
  const freqData = new Uint8Array(analyser.frequencyBinCount);

  const draw = ()       => {
    requestAnimationFrame(draw);
    if (!analyser) return;
    analyser.getByteTimeDomainData(timeData);
    waveCtx.fillStyle = '#101418';
    waveCtx.fillRect(0, 0, waveCanvas.width, waveCanvas.height);
    waveCtx.strokeStyle = '#4ade80';
    waveCtx.beginPath();
    for (let i = 0; i < timeData.length; i++) {
      const x = (i / timeData.length) * waveCanvas.width;
      const y = (timeData[i] / 255) * waveCanvas.height;
      if (i === 0) waveCtx.moveTo(x, y);
      else waveCtx.lineTo(x, y);
    }
    waveCtx.stroke();

    analyser.getByteFrequencyData(freqData);
    specCtx.fillStyle = '#101418';
    specCtx.fillRect(0, 0, specCanvas.width, specCanvas.height);
    const bars = 96;
    const bw = specCanvas.width / bars;
    for (let i = 0; i < bars; i++) {
      const bin = Math.floor(Math.pow(i / bars, 1.6) * freqData.length); // 对数分布
      const h = (freqData[bin] / 255) * specCanvas.height;
      specCtx.fillStyle = `hsl(${210 - (i / bars) * 160}, 70%, 55%)`;
      specCtx.fillRect(i * bw, specCanvas.height - h, bw - 1, h);
    }
  };
  draw();
}

// ---------- 录制与回放（MediaRecorder + MediaSource） ----------
let recorder                       = null;
let recChunks         = [];

function startRecording()       {
  if (!recordDest) return;
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : '';
  recorder = new MediaRecorder(recordDest.stream, mime ? { mimeType: mime } : undefined);
  recChunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => void playRecording(mime || 'audio/webm');
  recorder.start();
  $('recStatus').textContent = '录制中…';
}

function stopRecording()       {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  $('recStatus').textContent = '录制结束，正在装载回放…';
}

// 优先走 MediaSource 追加 SourceBuffer 回放；不支持时退回 Blob URL
async function playRecording(mime        )                {
  const blob = new Blob(recChunks, { type: mime });
  const player = $('recPlayer')                    ;
  if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime)) {
    const ms = new MediaSource();
    player.src = URL.createObjectURL(ms);
    ms.addEventListener('sourceopen', async () => {
      const sb = ms.addSourceBuffer(mime);
      sb.appendBuffer(await blob.arrayBuffer());
      sb.addEventListener('updateend', () => {
        if (ms.readyState === 'open') ms.endOfStream();
      }, { once: true });
    }, { once: true });
    $('recStatus').textContent = '回放就绪（MediaSource）';
  } else {
    player.src = URL.createObjectURL(blob);
    $('recStatus').textContent = '回放就绪（Blob 回退）';
  }
}

// ---------- 启动接线 ----------
async function startMic()                {
  await initAudio();
  if (ctx && ctx.state === 'suspended') await ctx.resume();
  wantMic = true;
  const select = $('deviceSelect')                     ;
  const ok = await openMic(select.value);
  if (ok) await refreshDevices();
}

function wireUi()       {
  $('btnMic').addEventListener('click', () => void startMic());
  $('deviceSelect').addEventListener('change', () => void startMic());
  $('testBreath').addEventListener('click', () => void playTest('breath'));
  $('testKnock').addEventListener('click', () => void playTest('knock'));
  $('testVowel').addEventListener('click', () => void playTest('vowel'));
  $('testStop').addEventListener('click', stopTest);
  $('monitorToggle').addEventListener('change', () => {
    if (monitorGain) {
      monitorGain.gain.value = ($('monitorToggle')                    ).checked ? 1 : 0;
    }
  });
  $('presetSave').addEventListener('click', savePreset);
  $('recStart').addEventListener('click', startRecording);
  $('recStop').addEventListener('click', stopRecording);
  navigator.mediaDevices.addEventListener('devicechange', () => void handleDeviceChange());
  setInterval(updateLatencyDisplay, 1000);
  renderChain();
  renderPresetList();
}

wireUi();
