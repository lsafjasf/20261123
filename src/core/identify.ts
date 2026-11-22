import type { TrackKind } from './types.ts';

/**
 * Heuristic track role identification.
 * Filename tokens carry the strongest signal; channel count and naming
 * language are used as corroborating evidence with a confidence score.
 */
export interface IdentifyResult {
  kind: TrackKind;
  confidence: number; // 0..1
  reasons: string[];
}

const ZH_TOKENS = ['zh', 'cn', 'mandarin', 'chinese', '中文', '国语', '普通话', '对白中', 'cmn'];
const EN_TOKENS = ['en', 'eng', 'english', '英文', '英语'];
const MUSIC_TOKENS = ['music', 'm&e', 'me', 'mne', 'score', '音乐', '配乐', '说明', 'stem', 'fx'];
const DIALOGUE_TOKENS = ['dialog', 'dialogue', 'dx', 'dub', 'vo', 'vocal', 'speech', '对白', '台词', '人声'];

function normalize(fileName: string): string {
  return fileName.toLowerCase().replace(/\.[a-z0-9]+$/, '');
}

function scoreTokens(name: string, tokens: string[]): number {
  let score = 0;
  for (const token of tokens) {
    if (name.includes(token)) score += 1;
  }
  return score;
}

/** Identify a track from its file name and basic signal attributes. */
export function identifyTrack(
  fileName: string,
  channelCount: number,
  hasContent: boolean,
): IdentifyResult {
  const name = normalize(fileName);
  const reasons: string[] = [];

  const zh = scoreTokens(name, ZH_TOKENS);
  const en = scoreTokens(name, EN_TOKENS);
  const music = scoreTokens(name, MUSIC_TOKENS);
  const dialogue = scoreTokens(name, DIALOGUE_TOKENS);

  let kind: TrackKind = 'unknown';
  let confidence = 0;

  if (music > 0 && zh === 0 && en === 0) {
    kind = 'music';
    confidence = 0.75 + Math.min(music, 2) * 0.1;
    reasons.push('命中音乐/说明命名标记');
  } else if (zh > 0 || (dialogue > 0 && en === 0 && zh > 0)) {
    kind = 'dialogue-zh';
    confidence = 0.75 + Math.min(zh, 2) * 0.1;
    reasons.push('命中中文对白命名标记');
  } else if (en > 0) {
    kind = 'dialogue-en';
    confidence = 0.75 + Math.min(en, 2) * 0.1;
    reasons.push('命中英文对白命名标记');
  } else if (dialogue > 0) {
    kind = 'dialogue-zh';
    confidence = 0.45;
    reasons.push('仅命中通用对白标记，默认归为中文，需人工确认');
  }

  // Corroboration: mono/stereo dialogue vs multichannel music stem.
  if (kind === 'music' && channelCount >= 4) {
    confidence = Math.min(1, confidence + 0.1);
    reasons.push(`${channelCount} 声道与多声道音乐/说明轨特征一致`);
  }
  if ((kind === 'dialogue-zh' || kind === 'dialogue-en') && channelCount <= 2) {
    confidence = Math.min(1, confidence + 0.05);
    reasons.push('单/双声道与对白轨特征一致');
  }
  if (!hasContent) {
    confidence = Math.min(confidence, 0.2);
    reasons.push('轨道无有效内容，识别可信度受限');
  }

  if (kind === 'unknown') {
    reasons.push('文件名未命中任何已知语言/音乐标记');
  }
  return { kind, confidence: Math.round(confidence * 100) / 100, reasons };
}
