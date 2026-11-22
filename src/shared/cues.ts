import type { SubtitleCue, SubtitleDocument, SubtitleSentence } from "./types.js";

const TIMECODE = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;
const SENTENCE_BREAK = /([。！？!?；;…]+|\.(?=\s|$))/u;

export function parseTimecode(value: string, unit: "ms" | "us" = "us"): number {
  const cleaned = value.trim().replace(/^(\d+):(?=\d{1,2}:\d{2})/, "$1:");
  const match = cleaned.match(TIMECODE);
  if (!match) {
    throw new Error(`Invalid timecode: ${value}`);
  }
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fraction = match[4].padEnd(3, "0");
  const milliseconds = hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + Number(fraction);
  return unit === "ms" ? milliseconds : milliseconds * 1_000;
}

export function formatTimecode(microseconds: number, compact = false): string {
  const clamped = Math.max(0, Math.round(microseconds));
  const totalMs = Math.floor(clamped / 1_000);
  const ms = totalMs % 1_000;
  const totalSeconds = Math.floor(totalMs / 1_000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);
  const stem = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return compact ? `${stem}.${String(ms).padStart(3, "0")}` : `${stem},${String(ms).padStart(3, "0")}`;
}

export function stripMarkup(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\{\\[^}]+\}/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function punctuationBreak(text: string): string {
  return /^[，。！？、；：,.!?;:）”’」』】…]+$/u.test(text) ? "no-break" : "auto";
}

export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!normalized) return [];

  const pieces: string[] = [];
  let rest = normalized;
  while (rest.length > 0) {
    const match = rest.match(SENTENCE_BREAK);
    if (!match || match.index === undefined) {
      pieces.push(rest.trim());
      break;
    }
    const end = match.index + match[0].length;
    const candidate = rest.slice(0, end).trim();
    if (candidate) pieces.push(candidate);
    rest = rest.slice(end).trimStart();
  }

  return pieces
    .flatMap((piece) => {
      if (piece.length <= 26) return [piece];
      return piece.split(/(?<=[，,、：:])\s*/u).filter(Boolean);
    })
    .filter(Boolean);
}

function sentenceWeight(text: string): number {
  let weight = 0;
  for (const character of text) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(character)) weight += 2;
    else if (/\s/u.test(character)) weight += 0.5;
    else weight += 1;
  }
  return Math.max(1, weight);
}

export function timeSentences(text: string, startUs: number, endUs: number): SubtitleSentence[] {
  const parts = splitSentences(text);
  if (parts.length === 0) return [];

  const weights = parts.map(sentenceWeight);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let cursor = startUs;
  const result: SubtitleSentence[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const isLast = index === parts.length - 1;
    const share = isLast ? endUs - cursor : Math.round(((endUs - startUs) * weights[index]) / totalWeight);
    const sentenceEnd = isLast ? endUs : Math.min(endUs, cursor + share);
    result.push({
      id: index,
      text: parts[index],
      startUs: cursor,
      endUs: sentenceEnd
    });
    cursor = sentenceEnd;
  }
  return result;
}

export function buildCue(
  id: string,
  startUs: number,
  endUs: number,
  rawText: string,
  speaker?: string
): SubtitleCue {
  const text = stripMarkup(rawText);
  return {
    id,
    startUs,
    endUs,
    text,
    speaker,
    sentences: timeSentences(text, startUs, endUs)
  };
}

function parseSrt(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim().split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [startRaw, endAndSettings] = lines[timingIndex].split("-->").map((value) => value.trim());
    if (!startRaw || !endAndSettings) continue;
    const endRaw = endAndSettings.split(/\s+/)[0];
    try {
      const startUs = parseTimecode(startRaw);
      const endUs = parseTimecode(endRaw);
      if (endUs <= startUs) continue;
      const body = lines.slice(timingIndex + 1).join("\n").trim();
      if (!body) continue;
      const idLine = timingIndex > 0 ? lines[0].trim() : "";
      cues.push(buildCue(String(cues.length + 1), startUs, endUs, body, idLine && !/^\d+$/.test(idLine) ? idLine : undefined));
    } catch {
      // A malformed cue is skipped; the parser reports the count budget instead of shifting later cues.
    }
  }
  return cues;
}

function parseVtt(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const body = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/^WEBVTT.*(?:\n|$)/, "")
    .replace(/^X-TIMESTAMP-MAP=.*$/gm, "")
    .trim();

  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((line) => !/^(NOTE|STYLE|REGION)(\s|$)/.test(line));
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [startRaw, endAndSettings] = lines[timingIndex].split("-->").map((value) => value.trim());
    if (!startRaw || !endAndSettings) continue;
    const endRaw = endAndSettings.split(/\s+/)[0];
    try {
      const startUs = parseTimecode(startRaw);
      const endUs = parseTimecode(endRaw);
      if (endUs <= startUs) continue;
      const content = lines.slice(timingIndex + 1).join("\n").trim();
      if (!content) continue;
      cues.push(buildCue(String(cues.length + 1), startUs, endUs, content));
    } catch {
      // Ignore malformed cues while preserving the exact timing of all valid cues.
    }
  }
  return cues;
}

function parseJson(text: string): SubtitleCue[] {
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { cues?: unknown }).cues)
      ? (parsed as { cues: unknown[] }).cues
      : [];

  const cues: SubtitleCue[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const start = record.startUs ?? record.start ?? record.from;
    const end = record.endUs ?? record.end ?? record.to;
    const body = record.text ?? record.content;
    if (typeof start !== "number" || typeof end !== "number" || typeof body !== "string" || end <= start) continue;
    cues.push(buildCue(String(record.id ?? cues.length + 1), Math.round(start), Math.round(end), body));
  }
  return cues;
}

export function parseSubtitle(text: string, sourceName = "", sourceTypeHint?: SubtitleDocument["sourceType"]): SubtitleDocument {
  const trimmed = text.trim();
  if (!trimmed) {
    return { cues: [], sourceType: "plain", warnings: ["字幕内容为空"] };
  }

  const hint = sourceTypeHint ?? (/\.vtt$/i.test(sourceName) ? "vtt" : /\.json$/i.test(sourceName) ? "json" : /\.srt$/i.test(sourceName) ? "srt" : undefined);
  let sourceType: SubtitleDocument["sourceType"] = hint ?? (trimmed.startsWith("WEBVTT") ? "vtt" : trimmed.startsWith("{") || trimmed.startsWith("[") ? "json" : "srt");
  let cues: SubtitleCue[] = [];

  try {
    if (sourceType === "json") cues = parseJson(trimmed);
    else if (sourceType === "vtt") cues = parseVtt(trimmed);
    else cues = parseSrt(trimmed);
  } catch {
    cues = [];
  }

  if (cues.length === 0 && sourceType !== "srt") {
    sourceType = "srt";
    cues = parseSrt(trimmed);
  }
  if (cues.length === 0 && !trimmed.includes("-->")) {
    const rawLines = trimmed.split(/\n{2,}/).map((line) => line.trim()).filter(Boolean);
    const durationUs = Math.max(2_000_000, Math.round((trimmed.length / 9) * 1_000_000));
    cues = rawLines.map((line, index) =>
      buildCue(
        String(index + 1),
        Math.round((durationUs / rawLines.length) * index),
        Math.round((durationUs / rawLines.length) * (index + 1)),
        line
      )
    );
    sourceType = "plain";
  }

  cues.sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs);
  const warnings: string[] = [];
  if (cues.length === 0) warnings.push("未识别到有效字幕，请检查时间码格式");
  for (let i = 1; i < cues.length; i += 1) {
    if (cues[i].startUs < cues[i - 1].endUs) {
      warnings.push(`第 ${i + 1} 条字幕与上一条重叠，导出时按开始时间取最新一条`);
      break;
    }
  }
  return { cues, sourceType, warnings };
}

export function activeCueAt(cues: SubtitleCue[], timeUs: number): SubtitleCue | null {
  let low = 0;
  let high = cues.length - 1;
  let candidate = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid].startUs <= timeUs) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  for (let index = candidate; index >= 0 && index >= candidate - 3; index -= 1) {
    const cue = cues[index];
    if (timeUs >= cue.startUs && timeUs < cue.endUs) return cue;
  }
  return null;
}

export function activeSentenceAt(cue: SubtitleCue, timeUs: number): SubtitleSentence | null {
  let current: SubtitleSentence | null = null;
  for (const sentence of cue.sentences) {
    if (timeUs >= sentence.startUs) current = sentence;
    if (timeUs < sentence.startUs) break;
  }
  return current;
}

export function cueDuration(cues: SubtitleCue[]): number {
  return cues.reduce((max, cue) => Math.max(max, cue.endUs), 0);
}

export function normalizeCuesForTts(cues: SubtitleCue[]): SubtitleCue[] {
  return cues.map((cue) => ({ ...cue, sentences: timeSentences(cue.text, cue.startUs, cue.endUs) }));
}

export function isPunctuationOnly(text: string): boolean {
  return punctuationBreak(text) === "no-break";
}
