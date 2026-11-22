export class PreviewClock {
          context                      = null;
          gain                  = null;
          audio                  ;
          sourceNode                                     = null;
          startedAt = 0;
          startPosition = 0;
          playing = false;
          rate = 1;
          volume = 0.8;

  constructor(audio                  ) {
    this.audio = audio;
  }

  get running()          {
    return this.playing;
  }

  get audioContext()                      {
    return this.context;
  }

  async unlock()                {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: "interactive" });
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.context.destination);
      this.sourceNode = this.context.createMediaElementSource(this.audio);
      this.sourceNode.connect(this.gain);
    }
    if (this.context.state === "suspended") await this.context.resume();
  }

  setMedia(url               )       {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    if (url) {
      this.audio.src = url;
      this.audio.load();
    }
  }

  setVolume(value        )       {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.gain && this.context) {
      this.gain.gain.setTargetAtTime(
        this.volume,
        this.context.currentTime,
        0.015
      );
    }
  }

  async play(positionSec        , rate = 1)                {
    await this.unlock();
    this.rate = rate;
    this.startPosition = positionSec;
    this.startedAt = this.context?.currentTime ?? performance.now() / 1000;
    this.playing = true;
    if (this.audio.src) {
      this.audio.currentTime = Math.max(0, positionSec);
      this.audio.playbackRate = rate;
      await this.audio.play().catch(() => undefined);
    }
  }

  pause(positionSec        )       {
    this.startPosition = positionSec;
    this.playing = false;
    this.audio.pause();
  }

  seek(positionSec        )       {
    this.startPosition = positionSec;
    this.startedAt = this.context?.currentTime ?? performance.now() / 1000;
    if (this.playing && this.audio.src) {
      this.audio.currentTime = Math.max(0, positionSec);
    }
  }

  position()         {
    if (!this.playing) return this.startPosition;
    const now = this.context?.currentTime ?? performance.now() / 1000;
    return this.startPosition + (now - this.startedAt) * this.rate;
  }

  setRate(rate        )       {
    const current = this.position();
    this.rate = rate;
    this.startPosition = current;
    this.startedAt = this.context?.currentTime ?? performance.now() / 1000;
    this.audio.playbackRate = rate;
  }
}
