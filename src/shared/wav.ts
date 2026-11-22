// PCM <-> WAV helpers and sample-accurate audio reversal. No dependencies.

// Reverses interleaved multi-channel PCM in place, frame by frame, so each
// channel plays backwards while channel layout is preserved.
export function reversePcmInterleaved(pcm: Float32Array, channels: number): Float32Array {
  const frames = Math.floor(pcm.length / channels);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < frames; i++) {
    const src = (frames - 1 - i) * channels;
    const dst = i * channels;
    for (let c = 0; c < channels; c++) out[dst + c] = pcm[src + c];
  }
  return out;
}

export function reversePcmPlanar(channelsData: Float32Array[]): Float32Array[] {
  return channelsData.map(ch => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[ch.length - 1 - i];
    return out;
  });
}

// Encodes planar float PCM to a 16-bit PCM WAV file.
export function encodeWav(channelsData: Float32Array[], sampleRate: number): Uint8Array {
  const numCh = channelsData.length;
  const frames = channelsData[0]?.length ?? 0;
  const dataBytes = frames * numCh * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, numCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * numCh * 2, true);
  v.setUint16(32, numCh * 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, "data");
  v.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const x = Math.max(-1, Math.min(1, channelsData[c][i]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}
