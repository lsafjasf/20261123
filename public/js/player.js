// 播放器：容器受支持时走 MediaSource 分片追加（内存有界、可拖动），
// 否则回退 Blob URL（WAV/MP3 浏览器原生支持）。
export class Player {
           audio                  ;
          objectUrl                = null;
          mediaSource                     = null;
          appending = false;

  constructor(audio                  ) {
    this.audio = audio;
  }

          guessMime(name        , type        )                {
    if (type && MediaSource.isTypeSupported(type)) return type;
    const ext = (name.split('.').pop() || '').toLowerCase();
    const candidates                           = {
      m4a: ['audio/mp4; codecs="mp4a.40.2"', 'audio/mp4'],
      mp4: ['audio/mp4; codecs="mp4a.40.2"', 'audio/mp4'],
      webm: ['audio/webm; codecs="opus"', 'audio/webm'],
    };
    for (const m of candidates[ext] || []) {
      if (MediaSource.isTypeSupported(m)) return m;
    }
    return null;
  }

  async load(file      )                {
    this.unload();
    const mime = typeof MediaSource !== 'undefined'
      ? this.guessMime(file.name, file.type)
      : null;
    if (mime) {
      try {
        await this.loadViaMse(file, mime);
        return;
      } catch { /* 回退 blob */ }
    }
    this.objectUrl = URL.createObjectURL(file);
    this.audio.src = this.objectUrl;
  }

          async loadViaMse(file      , mime        )                {
    const ms = new MediaSource();
    this.mediaSource = ms;
    this.objectUrl = URL.createObjectURL(ms);
    this.audio.src = this.objectUrl;
    await new Promise      ((resolve, reject) => {
      ms.addEventListener('sourceopen', () => resolve(), { once: true });
      ms.addEventListener('error', () => reject(new Error('MSE 打开失败')), { once: true });
    });
    const sb = ms.addSourceBuffer(mime);
    sb.mode = 'sequence';
    const CHUNK = 4 * 1024 * 1024;
    this.appending = true;
    for (let off = 0; off < file.size && this.mediaSource === ms; off += CHUNK) {
      const buf = await file.slice(off, off + CHUNK).arrayBuffer();
      await new Promise      ((resolve, reject) => {
        sb.addEventListener('updateend', () => resolve(), { once: true });
        sb.addEventListener('error', () => reject(new Error('MSE 追加失败')), { once: true });
        sb.appendBuffer(buf);
      });
    }
    if (this.mediaSource === ms && ms.readyState === 'open') ms.endOfStream();
    this.appending = false;
  }

  seek(sec        )       {
    if (Number.isFinite(this.audio.duration)) {
      this.audio.currentTime = Math.max(0, Math.min(sec, this.audio.duration));
    } else {
      this.audio.currentTime = sec;
    }
  }

  get time()         { return this.audio.currentTime; }

  unload()       {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.mediaSource = null;
    this.appending = false;
  }

  get streaming()          { return this.appending; }
}
