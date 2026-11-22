import { render,                   } from './dsp/engine.js';
import { TEST_SIGNALS } from './dsp/testsignals.js';
import { encodeWav } from './dsp/wav.js';
import { buildControls, BAND_COLOR_HEX } from './ui/controls.js';
import { drawWaveform, drawGainLanes, drawEnergyLanes } from './ui/views.js';
import {
  renderLoudnessTable,
  renderTransientTable,
  loudnessReportJson,
  transientReportJson,
  download,
} from './ui/report.js';

                 
                             
             
                     
                              
 

const state        = { input: null, fs: 48000, sourceName: '', result: null };

const $ = (id        ) => document.getElementById(id)                     ;

function setInputsEnabled()       {
  const has = state.input !== null;
  $('process').disabled = !has;
  $('playOriginal').disabled = !has;
}

function setResultEnabled()       {
  const has = state.result !== null;
  $('playProcessed').disabled = !has;
  $('exportWav').disabled = !has;
  $('exportLoudness').disabled = !has;
  $('exportTransient').disabled = !has;
}

function loadSignal(data              , fs        , name        )       {
  state.input = data;
  state.fs = fs;
  state.sourceName = name;
  state.result = null;
  const info = document.getElementById('sourceInfo')               ;
  info.textContent = `${name} · ${fs} Hz · ${(data.length / fs).toFixed(1)} s`;
  drawWaveform(data, null, controls.readSettings().ceilingDb);
  setInputsEnabled();
  setResultEnabled();
}

const controls = buildControls(() => {
  if (state.input && !state.result) {
    drawWaveform(state.input, null, controls.readSettings().ceilingDb);
  }
});

function runProcess()       {
  if (!state.input) return;
  const settings = controls.readSettings();
  const result = render(state.input, state.fs, settings);
  state.result = result;
  drawWaveform(state.input, result.output, settings.ceilingDb);
  drawGainLanes(
    result.bands.map((b, i) => ({
      name: b.name,
      gainDb: b.gainDb,
      color: BAND_COLOR_HEX[i % BAND_COLOR_HEX.length],
    })),
    result.limiterGainDb,
  );
  drawEnergyLanes(result.bands.map((b) => ({
    name: b.name,
    energyDb: b.energyDb,
    peakDb: b.peakDb,
  })));
  renderLoudnessTable(result);
  renderTransientTable(result);
  setResultEnabled();
}

// --- Playback (WebAudio) ---------------------------------------------------

let audioCtx                      = null;
let sourceNode                               = null;

function stopPlayback()       {
  if (sourceNode) {
    try { sourceNode.stop(); } catch { /* already stopped */ }
    sourceNode = null;
  }
  $('stopPlay').disabled = true;
}

function play(data              )       {
  stopPlayback();
  if (!audioCtx) audioCtx = new AudioContext({ sampleRate: state.fs });
  const buffer = audioCtx.createBuffer(1, data.length, state.fs);
  buffer.copyToChannel(data, 0);
  sourceNode = audioCtx.createBufferSource();
  sourceNode.buffer = buffer;
  sourceNode.connect(audioCtx.destination);
  sourceNode.onended = () => { $('stopPlay').disabled = true; };
  sourceNode.start();
  $('stopPlay').disabled = false;
}

// --- Wiring ----------------------------------------------------------------

$('process').addEventListener('click', runProcess);
$('playOriginal').addEventListener('click', () => state.input && play(state.input));
$('playProcessed').addEventListener('click', () => state.result && play(state.result.output));
$('stopPlay').addEventListener('click', stopPlayback);

$('exportWav').addEventListener('click', () => {
  if (!state.result) return;
  const wav = encodeWav([state.result.output], state.fs, 24);
  download(`${state.sourceName}-mastered.wav`, wav, 'audio/wav');
});
$('exportLoudness').addEventListener('click', () => {
  if (!state.result) return;
  download(`${state.sourceName}-loudness.json`,
    loudnessReportJson(state.result, state.sourceName), 'application/json');
});
$('exportTransient').addEventListener('click', () => {
  if (!state.result) return;
  download(`${state.sourceName}-transients.json`,
    transientReportJson(state.result, state.sourceName, state.fs), 'application/json');
});

for (const btn of document.querySelectorAll                   ('button[data-signal]')) {
  btn.addEventListener('click', () => {
    const gen = TEST_SIGNALS[btn.dataset.signal          ];
    if (gen) loadSignal(gen(state.fs), state.fs, btn.textContent ?? 'test');
  });
}

const fileInput = document.getElementById('fileInput')                    ;
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  if (!audioCtx) audioCtx = new AudioContext();
  const buf = await file.arrayBuffer();
  const decoded = await audioCtx.decodeAudioData(buf);
  const mono = new Float32Array(decoded.length);
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const data = decoded.getChannelData(ch);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / decoded.numberOfChannels;
  }
  loadSignal(mono, decoded.sampleRate, file.name.replace(/\.[^.]+$/, ''));
});

setInputsEnabled();
setResultEnabled();
