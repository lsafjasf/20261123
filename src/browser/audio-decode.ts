import { decodeWav } from '../shared/wav-codec.ts';
import type { AudioBufferData } from '../shared/types.ts';

export interface CodecSupport {
  webCodecs: boolean;
  audioDecoder: boolean;
  mediaSource: boolean;
  mediaSourceMp4: boolean;
}

export const detectCodecSupport = (): CodecSupport => {
  const hasWebCodecs = typeof (globalThis as { AudioDecoder?: unknown }).AudioDecoder === 'function';
  const mediaSource = typeof (globalThis as { MediaSource?: unknown }).MediaSource === 'function';
  return {
    webCodecs: hasWebCodecs,
    audioDecoder: hasWebCodecs,
    mediaSource,
    mediaSourceMp4:
      mediaSource &&
      typeof (
        globalThis as { MediaSource?: { isTypeSupported?: (type: string) => boolean } }
      ).MediaSource?.isTypeSupported === 'function' &&
      (
        globalThis as {
          MediaSource?: { isTypeSupported: (type: string) => boolean };
        }
      ).MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'),
  };
};

const toSharedBuffer = (
  buffer: AudioBuffer,
  label: string,
): AudioBufferData => ({
  sampleRate: buffer.sampleRate,
  channels: Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
    buffer.getChannelData(channel).slice(),
  ),
  label,
});

// Primary path: pure-TS WAV parser keeps analysis fully local and deterministic.
// Fallback: WebAudio decodeAudioData for browser-native compressed formats.
export const decodeAudioFile = async (
  file: File,
  audioContext: BaseAudioContext,
): Promise<AudioBufferData> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isWav =
    bytes.length > 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46;
  if (isWav) {
    try {
      return decodeWav(bytes, file.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`WAV 解析失败：${message}（可改用浏览器原生解码重试）`);
    }
  }
  const copy = bytes.slice().buffer;
  const decoded = await audioContext.decodeAudioData(copy);
  return toSharedBuffer(decoded, file.name);
};
