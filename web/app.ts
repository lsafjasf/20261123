import { verifyInBrowser, type BrowserReport } from './verify.ts';

const input = document.getElementById('file') as HTMLInputElement;
const status = document.getElementById('status')!;
const report = document.getElementById('report')!;

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}

function render(r: BrowserReport): void {
  const rows = r.sampleHashes.map(
    (s) => `<tr><td>${esc(s.handler)}</td><td>${esc(s.codec)}</td><td>${s.sampleCount}</td><td><code>${esc(s.hash)}</code></td></tr>`,
  ).join('');
  const mdats = r.mdatHashes.map(
    (m) => `<tr><td>${m.size}</td><td><code>${esc(m.hash)}</code></td></tr>`,
  ).join('');
  const findings = r.findings.length
    ? r.findings.map(
        (f) => `<tr><td>${esc(f.category)}</td><td>${esc(f.confidence)}</td><td><code>${esc(f.path)}</code></td><td>${esc(f.reason)}</td></tr>`,
      ).join('')
    : '<tr><td colspan="4" class="ok">未发现可识别的隐私元数据项</td></tr>';

  report.innerHTML = `
    <div class="card">
      <h2>容器与码流</h2>
      <p>文件: ${esc(r.fileName)} (${r.fileSize} 字节)</p>
      <p>容器可解析: <span class="${r.containerParseable ? 'ok' : 'bad'}">${r.containerParseable ? '是' : '否'}</span></p>
      <h3>每条轨道的采样 SHA-256（与 Node 清单对比）</h3>
      <table><thead><tr><th>handler</th><th>codec</th><th>采样数</th><th>哈希</th></tr></thead><tbody>${rows}</tbody></table>
      <h3>mdat 负载 SHA-256</h3>
      <table><thead><tr><th>字节数</th><th>哈希</th></tr></thead><tbody>${mdats}</tbody></table>
    </div>
    <div class="card">
      <h2>残留隐私项检查</h2>
      <table><thead><tr><th>类别</th><th>置信度</th><th>盒路径</th><th>说明</th></tr></thead><tbody>${findings}</tbody></table>
    </div>
    <div class="card">
      <h2>Web 平台独立验证</h2>
      <p>WebCodecs: <span class="${r.decode.webCodecsSupported ? 'ok' : 'warn'}">${r.decode.webCodecsSupported ? '支持' : '不支持'}</span> — ${esc(r.decode.note)}（解码 ${r.decode.framesDecoded} 帧）</p>
      <p>WebAudio: <span class="${r.audio.webAudioSupported ? 'ok' : 'warn'}">${r.audio.webAudioSupported ? '支持' : '不支持'}</span> — ${esc(r.audio.note)}</p>
      <p>MediaSource: <span class="${r.mediaSource.canDemux ? 'ok' : 'warn'}">${r.mediaSource.supported ? (r.mediaSource.canDemux ? '可解复用' : '不接受该容器') : '不支持'}</span> — ${esc(r.mediaSource.note)}</p>
      ${r.audio.fingerprint ? `<p class="muted">音频 PCM 指纹: <code>${esc(r.audio.fingerprint)}</code></p>` : ''}
    </div>`;
}

input.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (!file) return;
  status.textContent = '正在本地解析与验证，请稍候…';
  try {
    const result = await verifyInBrowser(file);
    status.textContent = '验证完成。请把上表采样/mdat 哈希与 Node 生成的 *.hash.json 逐字对比。';
    render(result);
  } catch (error) {
    status.textContent = `验证失败: ${(error as Error).message}`;
  }
});
