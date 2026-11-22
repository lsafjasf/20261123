/**
 * 切点表导出：CSV（UTF-8 BOM，Excel 可直接打开）与 JSON。
 * 时间列同时给出秒与 timecode，便于人工核对。
 */

import type { Clip, CutPoint, SpeechSpan } from "./types.ts";
import { formatTimecode } from "./timeline.ts";

export interface CutRow {
  index: number;
  cutId: string;
  timeSec: number;
  timecode: string;
  leftClip: string;
  rightClip: string;
  snapToBeat: boolean;
  manual: boolean;
  speechSafe: boolean;
}

function csvEscape(value: string | number | boolean): string {
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function buildCutRows(
  cuts: readonly CutPoint[],
  speech: readonly SpeechSpan[] = [],
): CutRow[] {
  const sorted = cuts.slice().sort((a, b) => a.time - b.time);
  return sorted.map((cut, index) => {
    const insideSpeech = speech.some(
      (span) => cut.time > span.start && cut.time < span.end,
    );
    return {
      index,
      cutId: cut.id,
      timeSec: Number(cut.time.toFixed(3)),
      timecode: formatTimecode(cut.time),
      leftClip: cut.leftClipId ?? "",
      rightClip: cut.rightClipId ?? "",
      snapToBeat: cut.beatTime !== null,
      manual: cut.manual,
      speechSafe: !insideSpeech,
    };
  });
}
export function toCsv(rows: readonly CutRow[]): string {
  const header = [
    "index",
    "cut_id",
    "time_sec",
    "timecode",
    "left_clip",
    "right_clip",
    "snap_to_beat",
    "manual",
    "speech_safe",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.index,
        row.cutId,
        row.timeSec,
        row.timecode,
        row.leftClip,
        row.rightClip,
        row.snapToBeat,
        row.manual,
        row.speechSafe,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

export interface CutListJson {
  version: 1;
  exportedAt: string;
  timelineDurationSec: number;
  clips: { id: string; name: string; weight: Clip["weight"]; sourceInPointSec: number }[];
  cuts: CutRow[];
  speechSpans: { start: number; end: number }[];
}

export function toJson(
  rows: readonly CutRow[],
  clips: readonly Clip[],
  speech: readonly SpeechSpan[],
  duration: number,
  exportedAt: string,
): string {
  const payload: CutListJson = {
    version: 1,
    exportedAt,
    timelineDurationSec: Number(duration.toFixed(3)),
    clips: clips.map((clip) => ({
      id: clip.id,
      name: clip.name,
      weight: clip.weight,
      sourceInPointSec: clip.source.inPoint,
    })),
    cuts: rows,
    speechSpans: speech.map((span) => ({
      start: Number(span.start.toFixed(3)),
      end: Number(span.end.toFixed(3)),
    })),
  };
  return JSON.stringify(payload, null, 2);
}
