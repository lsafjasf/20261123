import type { AudioMetadata } from './types.ts';
import type { ByteSource } from './wav.ts';

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

interface AdtsHeader {
  sampleRate: number;
  channels: number;
  sampleRateIndex: number;
  profile: number;
  frameLength: number;
  headerLength: number;
  timestamp: number;
  duration: number;
}

interface AdtsFrame {
  header: AdtsHeader;
  payload: Uint8Array;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left, 0);
  result.set(right, left.length);
  return result;
}

class AdtsReader {
  private readonly source: ByteSource;
  private buffer = new Uint8Array(0);
  private cursor = 0;
  private eof = false;
  readonly chunkBytes: number;

  constructor(source: ByteSource, chunkBytes = 512 * 1024) {
    this.source = source;
    this.chunkBytes = chunkBytes;
  }

  get bytesRead(): number {
    return this.cursor;
  }

  private async ensure(bytes: number): Promise<boolean> {
    while (this.buffer.length < bytes && !this.eof) {
      const absolute = this.cursor + this.buffer.length;
      if (absolute >= this.source.size) {
        this.eof = true;
        break;
      }
      const read = await this.source.read(absolute, Math.max(this.chunkBytes, bytes - this.buffer.length));
      if (read.byteLength === 0) {
        this.eof = true;
        break;
      }
      this.buffer = concatBytes(this.buffer, new Uint8Array(read));
    }
    return this.buffer.length >= bytes;
  }

  private drop(bytes: number): void {
    this.buffer = this.buffer.subarray(bytes);
    this.cursor += bytes;
  }

  private parseHeader(): AdtsHeader | null {
    if (this.buffer.length < 7) return null;
    const b = this.buffer;
    if (b[0] !== 0xff || (b[1] & 0xf6) !== 0xf0) return null;
    const protectionAbsent = b[1] & 1;
    const profile = (b[2] >> 6) & 3;
    const sampleRateIndex = (b[2] >> 2) & 0x0f;
    const sampleRate = SAMPLE_RATES[sampleRateIndex];
    const channels = ((b[2] & 1) << 2) | ((b[3] >> 6) & 3);
    const frameLength = ((b[3] & 3) << 11) | (b[4] << 3) | ((b[5] & 0xe0) >> 5);
    if (!sampleRate || !channels || frameLength < 7 || frameLength > 16384) return null;
    return {
      sampleRate,
      channels,
      sampleRateIndex,
      profile,
      frameLength,
      headerLength: protectionAbsent ? 7 : 9,
      timestamp: 0,
      duration: 0
    };
  }

  async *frames(): AsyncGenerator<AdtsFrame> {
    let frameIndex = 0;
    while (true) {
      if (!(await this.ensure(7))) {
        if (this.buffer.length === 0) return;
        if (this.buffer.length < 7) return;
      }
      let sync = -1;
      for (let index = 0; index + 1 < this.buffer.length; index += 1) {
        if (this.buffer[index] === 0xff && (this.buffer[index + 1] & 0xf6) === 0xf0) {
          sync = index;
          break;
        }
      }
      if (sync < 0) {
        this.drop(Math.max(0, this.buffer.length - 1));
        continue;
      }
      if (sync > 0) this.drop(sync);
      const parsed = this.parseHeader();
      if (!parsed) {
        this.drop(1);
        continue;
      }
      if (!(await this.ensure(parsed.frameLength))) {
        throw new Error('AAC/ADTS 文件尾部帧不完整');
      }
      const parsedFrame = this.parseHeader();
      if (!parsedFrame || parsedFrame.frameLength !== parsed.frameLength) {
        this.drop(1);
        continue;
      }
      const payload = this.buffer.slice(parsedFrame.headerLength, parsedFrame.frameLength);
      parsedFrame.timestamp = frameIndex * 1024 / parsedFrame.sampleRate * 1_000_000;
      parsedFrame.duration = 1024 / parsedFrame.sampleRate * 1_000_000;
      frameIndex += 1;
      yield { header: parsedFrame, payload };
      this.drop(parsedFrame.frameLength);
    }
  }
}

export async function probeAdts(source: ByteSource): Promise<AudioMetadata> {
  const reader = new AdtsReader(source);
  let frames = 0;
  let sampleRate = 0;
  let channels = 0;
  for await (const frame of reader.frames()) {
    if (frames === 0) {
      sampleRate = frame.header.sampleRate;
      channels = frame.header.channels;
    }
    frames += 1;
  }
  if (!frames || !sampleRate || !channels) throw new Error('未找到有效的 AAC/ADTS 帧');
  return {
    fileName: source.fileName,
    fileSize: source.size,
    format: 'AAC / ADTS',
    sampleRate,
    channels,
    bitsPerSample: 0,
    duration: frames * 1024 / sampleRate,
    decoder: 'webcodecs-adts',
    streaming: true
  };
}

function audioSpecificConfig(header: AdtsHeader): Uint8Array {
  const objectType = header.profile + 1;
  return new Uint8Array([
    (objectType << 3) | (header.sampleRateIndex >> 1),
    ((header.sampleRateIndex & 1) << 7) | (header.channels << 3)
  ]);
}

async function copyAudioData(data: AudioData): Promise<{ channels: Float32Array[]; frameCount: number }> {
  const frameCount = data.numberOfFrames;
  const channelData = Array.from({ length: data.numberOfChannels }, () => new Float32Array(frameCount));
  for (let channel = 0; channel < channelData.length; channel += 1) {
    data.copyTo(channelData[channel], { planeIndex: channel, format: 'f32-planar' });
  }
  data.close();
  return { channels: channelData, frameCount };
}

export async function decodeAdts(
  source: ByteSource,
  onFrames: (channels: Float32Array[], frameCount: number) => Promise<void> | void,
  onProgress: (ratio: number) => Promise<void> | void,
  waitIfPaused: () => Promise<boolean>,
  batchFrames = 96
): Promise<void> {
  if (typeof AudioDecoder === 'undefined') throw new Error('当前浏览器不支持 WebCodecs AudioDecoder');
  const reader = new AdtsReader(source);
  let decoder: AudioDecoder | null = null;
  let outputs: AudioData[] = [];
  let decoderError: Error | null = null;
  let configured = false;
  let pending: AdtsFrame[] = [];

  const drain = async (): Promise<void> => {
    if (decoderError) throw decoderError;
    outputs.sort((a, b) => a.timestamp - b.timestamp);
    const batch = outputs;
    outputs = [];
    for (const data of batch) {
      const frames = await copyAudioData(data);
      await onFrames(frames.channels, frames.frameCount);
    }
    if (decoderError) throw decoderError;
  };

  const flush = async (): Promise<void> => {
    if (!decoder || pending.length === 0) return;
    for (const frame of pending) {
      decoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: frame.header.timestamp,
        duration: frame.header.duration,
        data: frame.payload
      }));
    }
    pending = [];
    await decoder.flush();
    await drain();
  };

  try {
    for await (const frame of reader.frames()) {
      if (!(await waitIfPaused())) return;
      if (!configured) {
        const description = audioSpecificConfig(frame.header);
        const config: AudioDecoderConfig = {
          codec: `mp4a.40.${frame.header.profile + 1}`,
          sampleRate: frame.header.sampleRate,
          numberOfChannels: frame.header.channels,
          description: description.buffer
        };
        const support = await AudioDecoder.isConfigSupported(config);
        if (!support.supported) {
          throw new Error(`浏览器 WebCodecs 不支持该 AAC 配置：${config.codec} / ${config.sampleRate} Hz / ${config.numberOfChannels}ch`);
        }
        decoder = new AudioDecoder({
          output(data) {
            outputs.push(data);
          },
          error(error) {
            decoderError = error;
          }
        });
        decoder.configure(support.config);
        configured = true;
      }
      pending.push(frame);
      if (pending.length >= batchFrames) {
        await flush();
        await onProgress(Math.min(1, reader.bytesRead / source.size));
      }
    }
    if (decoder) {
      await flush();
      await decoder.flush();
      await drain();
    }
    await onProgress(1);
  } finally {
    for (const data of outputs) data.close();
    if (decoder && decoder.state !== 'closed') decoder.close();
  }
}
