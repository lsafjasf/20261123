import { PRESETS } from '../shared/types.ts';

export function appShell(): string {
  const presetOptions = PRESETS.map((preset, index) =>
    `<option value="${preset.id}"${index === 0 ? ' selected' : ''}>${preset.name} · ${preset.detail}</option>`
  ).join('');
  return `
  <div class="backdrop-grid"></div>
  <div class="app-shell">
    <aside class="rail">
      <div class="brand">
        <div class="brand-mark"><span></span><span></span><span></span><span></span></div>
        <div>
          <strong>Loudness Desk</strong>
          <small>交付级响度复核</small>
        </div>
      </div>

      <label class="drop-zone" id="dropZone" for="fileInput">
        <input id="fileInput" type="file" accept="audio/*,.wav,.aac" />
        <span class="drop-icon">＋</span>
        <span class="drop-title">载入交付音频</span>
        <span class="drop-note">WAV 流式读取 · AAC/ADTS 视 WebCodecs 支持</span>
      </label>

      <div class="rail-section">
        <div class="rail-label">当前素材</div>
        <div id="fileSummary" class="file-summary muted">
          <strong>尚未载入</strong>
          <span>也可以直接打开示例音频</span>
        </div>
        <button class="button ghost full" id="demoButton" type="button">打开示例音频</button>
      </div>

      <div class="rail-section">
        <div class="rail-label">交付口径</div>
        <select id="presetSelect" class="select">${presetOptions}</select>
        <div class="settings-grid">
          <label>目标 LUFS<input id="targetInput" type="number" step="0.1" value="-14" /></label>
          <label>容差 ±LU<input id="toleranceInput" type="number" step="0.1" value="1" /></label>
          <label>真峰值上限<input id="truePeakInput" type="number" step="0.1" value="-1" /></label>
          <label>采样峰预警<input id="peakWarningInput" type="number" step="0.1" value="-3" /></label>
        </div>
      </div>

      <div class="rail-section scan-panel">
        <div class="rail-label">流式扫描</div>
        <div class="scan-state">
          <span class="status-dot" id="scanDot"></span>
          <span id="scanLabel">等待素材</span>
        </div>
        <div class="progress-track"><span id="scanProgress"></span></div>
        <div class="scan-meta">
          <span id="scanRatio">0%</span>
          <span id="scanElapsed">0.0s</span>
        </div>
        <button class="button subtle full" id="scanPauseButton" type="button" disabled>暂停扫描</button>
      </div>

      <div class="rail-footer">
        <span>BS.1770-4 门控</span>
        <span>8× 真峰值</span>
        <span>本地运算</span>
      </div>
    </aside>

    <main class="workspace">
      <header class="topbar">
        <div>
          <div class="eyebrow">AUDIO DELIVERY QC <span class="slash">/</span> <span id="topStatus">未载入</span></div>
          <h1 id="workTitle">响度复核工作台</h1>
          <p id="workSubtitle">逐秒数据、问题区间与广告段独立统计</p>
        </div>
        <div class="top-actions">
          <button class="button ghost" id="exportJsonButton" type="button" disabled>导出 JSON</button>
          <button class="button primary" id="exportCsvButton" type="button" disabled>导出逐秒 CSV</button>
        </div>
      </header>

      <section class="metrics-grid">
        <article class="panel summary-panel">
          <div class="panel-head">
            <div>
              <span class="panel-kicker">整段整合响度</span>
              <h2>Integrated <em>I</em></h2>
            </div>
            <span class="status-pill idle" id="deliveryStatus">待分析</span>
          </div>
          <div class="integrated-row">
            <div class="integrated-value"><span id="integratedValue">—</span><small>LUFS</small></div>
            <div class="integrated-side">
              <div class="delta-chip" id="integratedDelta">目标 —</div>
              <span id="gatingText">门控块 0</span>
            </div>
          </div>
          <div class="target-scale">
            <div class="scale-line">
              <span class="scale-target" id="targetMarker"></span>
              <span class="scale-current" id="targetNeedle"></span>
            </div>
            <div class="scale-labels">
              <span id="scaleLow">—</span><span>目标 <b id="scaleTarget">-14.0</b></span><span id="scaleHigh">—</span>
            </div>
          </div>
          <div class="mini-stats">
            <div><span>采样峰</span><strong id="samplePeakValue">—</strong><small>dBFS</small></div>
            <div><span>真峰值</span><strong id="truePeakValue">—</strong><small>dBTP</small></div>
            <div><span>节目净响度</span><strong id="programValue">—</strong><small>LUFS</small></div>
            <div><span>广告段</span><strong id="adCountValue">0</strong><small>段</small></div>
          </div>
        </article>

        <article class="panel live-panel">
          <div class="panel-head">
            <div>
              <span class="panel-kicker">连续播放监测</span>
              <h2>Live <em>M / S / I</em></h2>
            </div>
            <span class="live-badge"><i></i> 状态保持</span>
          </div>
          <div class="transport-row">
            <button class="transport-button" id="backButton" type="button" aria-label="后退五秒">−5</button>
            <button class="play-button" id="playButton" type="button" aria-label="播放">▶</button>
            <button class="transport-button" id="forwardButton" type="button" aria-label="前进五秒">+5</button>
            <div class="time-readout">
              <strong id="currentTime">00:00.000</strong>
              <span>/ <b id="durationTime">--:--</b></span>
            </div>
          </div>
          <div class="live-values">
            <div class="live-cell momentary">
              <span>瞬时 M</span>
              <strong id="liveMomentary">—</strong>
              <small>400 ms</small>
            </div>
            <div class="live-cell short">
              <span>短期 S</span>
              <strong id="liveShortTerm">—</strong>
              <small>3 s</small>
            </div>
            <div class="live-cell integrated">
              <span>当前 I</span>
              <strong id="liveIntegrated">—</strong>
              <small>至播放头 LUFS</small>
            </div>
          </div>
          <div class="live-foot">
            <span id="liveSecond">当前秒 —</span>
            <span id="livePeak">TP — / SP —</span>
          </div>
        </article>
      </section>

      <section class="panel timeline-panel">
        <div class="timeline-head">
          <div>
            <span class="panel-kicker">时间线复核</span>
            <h2>波形 · 响度 · 广告段 · 问题区间</h2>
          </div>
          <div class="timeline-tools">
            <div class="segmented" role="group" aria-label="时间线工具">
              <button class="active" id="seekModeButton" type="button">定位播放</button>
              <button id="adModeButton" type="button">框选广告段</button>
            </div>
            <div class="legend">
              <span><i class="legend-wave"></i>波形</span>
              <span><i class="legend-m"></i>M</span>
              <span><i class="legend-s"></i>S</span>
              <span><i class="legend-ad"></i>广告</span>
            </div>
          </div>
        </div>
        <div class="canvas-wrap">
          <canvas id="timelineCanvas"></canvas>
          <div class="canvas-hint" id="canvasHint">拖拽或点击定位播放</div>
        </div>
        <div class="ad-editor">
          <div class="ad-editor-title">
            <span>广告段</span>
            <small>单独门控统计，不混入节目净响度</small>
          </div>
          <div class="ad-inputs">
            <label>入点 s<input id="adStartInput" type="number" min="0" step="0.1" placeholder="0.0" /></label>
            <label>出点 s<input id="adEndInput" type="number" min="0" step="0.1" placeholder="0.0" /></label>
            <label class="ad-name">名称<input id="adLabelInput" type="text" maxlength="24" placeholder="如：前贴片 / 中插" /></label>
            <button class="button primary compact" id="addAdButton" type="button" disabled>加入广告段</button>
          </div>
          <div class="ad-chips" id="adChips"><span class="muted">暂无广告段</span></div>
        </div>
      </section>

      <section class="panel review-panel">
        <div class="tabs" role="tablist">
          <button class="tab active" data-tab="seconds" type="button">逐秒数据 <span id="secondsBadge">0</span></button>
          <button class="tab" data-tab="problems" type="button">问题区间 <span id="problemsBadge">0</span></button>
          <button class="tab" data-tab="segments" type="button">分段统计</button>
          <button class="tab" data-tab="method" type="button">口径说明</button>
        </div>
        <div id="tabContent" class="tab-content"></div>
      </section>
    </main>
  </div>
  <audio id="audio" preload="metadata"></audio>
  <div id="toast" class="toast" role="status"></div>
  `;
}
