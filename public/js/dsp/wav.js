export function encodeWav(
  channels                ,
  sampleRate        ,
  bitDepth               = 24,
)              {
  const numCh = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytesPerSample = bitDepth / 8;
  const dataSize = frames * numCh * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buffer);
  const writeStr = (off        , s        ) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  v.setUint16(22, numCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * numCh * bytesPerSample, true);
  v.setUint16(32, numCh * bytesPerSample, true);
  v.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  v.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const x = Math.max(-1, Math.min(1, channels[ch][i]));
      if (bitDepth === 16) {
        v.setInt16(off, Math.round(x * 32767), true);
      } else if (bitDepth === 24) {
        const s = Math.round(x * 8388607);
        v.setUint8(off, s & 0xff);
        v.setUint8(off + 1, (s >> 8) & 0xff);
        v.setUint8(off + 2, (s >> 16) & 0xff);
      } else {
        v.setFloat32(off, x, true);
      }
      off += bytesPerSample;
    }
  }
  return buffer;
}

                             
                           
                     
 

export function decodeWav(buffer             )             {
  const v = new DataView(buffer);
  const readStr = (off        , len        ) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(v.getUint8(off + i));
    return s;
  };
  if (readStr(0, 4) !== 'RIFF' || readStr(8, 4) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12;
  let fmt = { format: 1, channels: 1, sampleRate: 44100, bits: 16 };
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buffer.byteLength) {
    const id = readStr(off, 4);
    const size = v.getUint32(off + 4, true);
    if (id === 'fmt ') {
      fmt = {
        format: v.getUint16(off + 8, true),
        channels: v.getUint16(off + 10, true),
        sampleRate: v.getUint32(off + 12, true),
        bits: v.getUint16(off + 22, true),
      };
    } else if (id === 'data') {
      dataOff = off + 8;
      dataLen = size;
    }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0) throw new Error('no data chunk');
  const bytesPerSample = fmt.bits / 8;
  const frames = Math.floor(dataLen / (bytesPerSample * fmt.channels));
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  let p = dataOff;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < fmt.channels; ch++) {
      let x = 0;
      if (fmt.format === 3 && fmt.bits === 32) x = v.getFloat32(p, true);
      else if (fmt.bits === 16) x = v.getInt16(p, true) / 32768;
      else if (fmt.bits === 24) {
        const s = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16);
        x = (s << 8 >> 8) / 8388608;
      } else if (fmt.bits === 32) x = v.getInt32(p, true) / 2147483648;
      channels[ch][i] = x;
      p += bytesPerSample;
    }
  }
  return { channels, sampleRate: fmt.sampleRate };
}
