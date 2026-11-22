import { parseMp4Audio } from "./mp4.js";
                                                                            

function concatenateChannel(chunks                )               {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Float32Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    result.set(chunk, cursor);
    cursor += chunk.length;
  }
  return result;
}

async function decodeWebCodecs(bytes            , info              )                    {
  if (typeof AudioDecoder === "undefined") throw new Error("AudioDecoder unavailable");
  const support = await AudioDecoder.isConfigSupported({
    codec: info.codec,
    sampleRate: info.sampleRate,
    numberOfChannels: info.channels,
    description: info.description
  });
  if (!support.supported) throw new Error(`AudioDecoder does not support ${info.codec}`);

  const chunks                   = [];
  let channelCount = info.channels;
  let failure               = null;
  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        channelCount = data.numberOfChannels;
        const planes                 = [];
        for (let channel = 0; channel < data.numberOfChannels; channel++) {
          const plane = new Float32Array(data.numberOfFrames);
          data.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
          planes.push(plane);
        }
        chunks.push(planes);
      } finally {
        data.close();
      }
    },
    error: (error) => {
      failure = error;
    }
  });

  decoder.configure({
    codec: info.codec,
    sampleRate: info.sampleRate,
    numberOfChannels: info.channels,
    description: info.description.slice()
  });

  for (const packet of info.packets) {
    decoder.decode(
      new EncodedAudioChunk({
        type: "key",
        timestamp: Math.round(packet.timestamp),
        duration: Math.round(packet.duration),
        data: bytes.slice(packet.offset, packet.offset + packet.size)
      })
    );
  }
  await decoder.flush();
  decoder.close();
  if (failure) throw failure;
  if (chunks.length === 0) throw new Error("AAC decoder returned no audio");

  const channels = Array.from({ length: channelCount }, (_, channel) =>
    concatenateChannel(chunks.map((planes) => planes[channel] || new Float32Array(planes[0].length)))
  );
  return { sampleRate: info.sampleRate, channels, decodeMode: "webcodecs-raw" };
}

async function decodeWebAudio(bytes             , info              )                    {
  const Constructor = window.AudioContext || (window                                                                ).webkitAudioContext;
  if (!Constructor) throw new Error("WebAudio unavailable");
  const context = new Constructor();
  try {
    const buffer = await context.decodeAudioData(bytes.slice(0));
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel).slice());
    return { sampleRate: buffer.sampleRate || info.sampleRate, channels, decodeMode: "webaudio-trimmed" };
  } finally {
    void context.close();
  }
}

export async function decodeFile(descriptor                   ) {
  const response = await fetch(`./fixtures/${descriptor.file}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${descriptor.file}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const info = parseMp4Audio(bytes);
  try {
    return { info, pcm: await decodeWebCodecs(bytes, info), decodePath: "WebCodecs"          };
  } catch (error) {
    const fallback = await decodeWebAudio(bytes.buffer               , info);
    return { info, pcm: fallback, decodePath: "WebAudio"         , webCodecsError: String(error) };
  }
}

export async function probeMediaSource(descriptor                   )                                                  {
  if (typeof MediaSource === "undefined") return { supported: false, detail: "MediaSource 不可用" };
  const mime = 'audio/mp4; codecs="mp4a.40.2"';
  if (!MediaSource.isTypeSupported(mime)) return { supported: false, detail: "不支持 audio/mp4 AAC" };
  const media = new MediaSource();
  const audio = document.createElement("audio");
  audio.muted = true;
  audio.src = URL.createObjectURL(media);
  try {
    await new Promise      ((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sourceopen timeout")), 2500);
      media.addEventListener("sourceopen", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    const source = media.addSourceBuffer(mime);
    const sourceFile = descriptor.fragmentedFile || descriptor.file;
    const bytes = new Uint8Array(await (await fetch(`./fixtures/${sourceFile}`)).arrayBuffer());
    await new Promise      ((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("append timeout")), 2500);
      source.addEventListener("updateend", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      source.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("SourceBuffer append failed"));
      }, { once: true });
      if (!media.readyState || media.readyState !== "open") {
        clearTimeout(timer);
        reject(new Error("MediaSource not open"));
        return;
      }
      try {
        source.appendBuffer(bytes);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
    const ranges = source.buffered.length;
    const detail = ranges ? `fMP4 · ${source.buffered.end(ranges - 1).toFixed(3)} s 已入缓冲` : "fMP4 append 完成";
    return { supported: true, detail };
  } finally {
    if (audio.src) URL.revokeObjectURL(audio.src);
  }
}


//# sourceURL=decoder.ts