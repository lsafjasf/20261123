import type { CueIndex, CueSheet, CueTrack } from "./types.ts";
import { fail } from "./errors.ts";

const MSF_RE = /^(\d{1,3}):([0-5]?\d):([0-6]?\d|7[0-4])$/;

export function parseMsf(token: string, context: string): number {
  const match = MSF_RE.exec(token);
  if (!match) {
    fail("CUE_SYNTAX", `${context}: invalid MSF timestamp "${token}" (expected MM:SS:FF, FF 00-74).`);
  }
  const minutes = Number(match![1]);
  const seconds = Number(match![2]);
  const frames = Number(match![3]);
  if (minutes > 99) {
    fail("CUE_INDEX_INVALID", `${context}: MSF minute ${minutes} exceeds CD limit 99.`);
  }
  return (minutes * 60 + seconds) * 75 + frames;
}

export function frameToMsf(frame: number): string {
  const total = Math.max(0, Math.trunc(frame));
  const minutes = Math.floor(total / (75 * 60));
  const seconds = Math.floor((total % (75 * 60)) / 75);
  const frames = total % 75;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

function tokenizeLine(line: string): string[] {
  const tokens: string[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const char = line[cursor];
    if (char === " " || char === "\t") {
      cursor += 1;
      continue;
    }
    if (char === '"') {
      const end = line.indexOf('"', cursor + 1);
      if (end === -1) {
        fail("CUE_SYNTAX", `unterminated quoted string: ${line.trim()}`);
      }
      tokens.push(line.slice(cursor + 1, end));
      cursor = end + 1;
      continue;
    }
    let next = cursor;
    while (next < line.length && line[next] !== " " && line[next] !== "\t") {
      next += 1;
    }
    tokens.push(line.slice(cursor, next));
    cursor = next;
  }
  return tokens;
}

export function parseCueSheet(content: string, cuePath: string): CueSheet {
  const warnings: string[] = [];
  const tracks: CueTrack[] = [];
  let filePath: string | null = null;
  let fileType = "";
  let current: CueTrack | null = null;

  const lines = content.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  lines.forEach((rawLine, lineIndex) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("//")) {
      return;
    }
    const tokens = tokenizeLine(line);
    const command = tokens[0] ?? "";
    const lineRef = `${cuePath}:${lineIndex + 1}`;

    switch (command) {
      case "REM":
      case "CATALOG":
      case "ISRC":
      case "TITLE":
      case "PERFORMER":
      case "SONGWRITER":
      case "FLAGS":
        break;
      case "FILE": {
        if (tokens.length < 3) {
          fail("CUE_SYNTAX", `${lineRef}: FILE requires a quoted path and type.`);
        }
        if (filePath !== null) {
          fail("CUE_UNSUPPORTED", `${lineRef}: multiple FILE entries are not supported for single-image splitting.`);
        }
        filePath = tokens[1] ?? fail("CUE_SYNTAX", `${lineRef}: missing FILE path.`);
        fileType = (tokens[2] ?? "").toUpperCase();
        if (fileType !== "WAVE") {
          fail("CUE_UNSUPPORTED", `${lineRef}: FILE type "${tokens[2]}" is not WAVE; only PCM WAV images are supported.`);
        }
        break;
      }
      case "TRACK": {
        if (tokens.length < 3) {
          fail("CUE_SYNTAX", `${lineRef}: TRACK requires number and mode.`);
        }
        const number = parseTrackNumber(tokens[1] ?? "", lineRef);
        const mode = (tokens[2] ?? "").toUpperCase();
        if (mode !== "AUDIO") {
          fail("CUE_UNSUPPORTED", `${lineRef}: TRACK ${number} mode "${tokens[2]}" is not AUDIO.`);
        }
        if (tracks.some((track) => track.number === number)) {
          fail("CUE_SYNTAX", `${lineRef}: duplicate TRACK ${String(number).padStart(2, "0")}.`);
        }
        current = { number, indexes: [] };
        tracks.push(current);
        break;
      }
      case "INDEX": {
        if (!current) {
          fail("CUE_SYNTAX", `${lineRef}: INDEX outside of TRACK.`);
        }
        if (tokens.length < 3) {
          fail("CUE_SYNTAX", `${lineRef}: INDEX requires number and MSF.`);
        }
        const indexNumber = parseIndexNumber(tokens[1] ?? "", lineRef);
        const frame = parseMsf(tokens[2] ?? "", lineRef);
        if (current!.indexes.some((entry) => entry.number === indexNumber)) {
          fail("CUE_INDEX_INVALID", `${lineRef}: duplicate INDEX ${String(indexNumber).padStart(2, "0")} in TRACK ${current!.number}.`);
        }
        const entry: CueIndex = { number: indexNumber, msf: tokens[2]!, frame };
        current!.indexes.push(entry);
        break;
      }
      case "PREGAP":
        fail("CUE_UNSUPPORTED", `${lineRef}: PREGAP synthesizes silence absent from the WAV and cannot be byte-exact; embed it as INDEX 00 instead.`);
      case "POSTGAP":
        fail("CUE_UNSUPPORTED", `${lineRef}: POSTGAP synthesizes silence absent from the WAV and cannot be byte-exact.`);
      default:
        warnings.push(`${lineRef}: ignored unrecognized command "${command}".`);
    }
  });

  if (filePath === null) {
    fail("CUE_SYNTAX", `${cuePath}: no FILE entry found.`);
  }
  if (tracks.length === 0) {
    fail("CUE_SYNTAX", `${cuePath}: no TRACK entries found.`);
  }
  validateTracks(tracks, cuePath);

  return { filePath, fileType, tracks, warnings };
}

function parseTrackNumber(token: string, lineRef: string): number {
  if (!/^\d{1,3}$/.test(token)) {
    fail("CUE_SYNTAX", `${lineRef}: invalid TRACK number "${token}".`);
  }
  const number = Number(token);
  if (number < 1 || number > 99) {
    fail("CUE_INDEX_INVALID", `${lineRef}: TRACK number ${number} out of range 1-99.`);
  }
  return number;
}

function parseIndexNumber(token: string, lineRef: string): number {
  if (!/^\d{1,3}$/.test(token)) {
    fail("CUE_SYNTAX", `${lineRef}: invalid INDEX number "${token}".`);
  }
  const number = Number(token);
  if (number < 0 || number > 99) {
    fail("CUE_INDEX_INVALID", `${lineRef}: INDEX number ${number} out of range 0-99.`);
  }
  return number;
}

function validateTracks(tracks: CueTrack[], cuePath: string): void {
  let previousEnd = -1;
  tracks.forEach((track, trackOrdinal) => {
    const label = `TRACK ${String(track.number).padStart(2, "0")}`;
    if (track.indexes.length === 0) {
      fail("CUE_INDEX_INVALID", `${cuePath}: ${label} has no INDEX entries; INDEX 01 is mandatory.`);
    }
    const sorted = [...track.indexes].sort((a, b) => a.number - b.number);
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index]!.number !== sorted[index - 1]!.number + 1) {
        fail("CUE_INDEX_INVALID", `${cuePath}: ${label} has non-contiguous INDEX numbers.`);
      }
      if (sorted[index]!.frame <= sorted[index - 1]!.frame) {
        fail("CUE_INDEX_INVALID", `${cuePath}: ${label} INDEX ${sorted[index]!.number} is not strictly after INDEX ${sorted[index - 1]!.number}.`);
      }
    }
    const index01 = track.indexes.find((entry) => entry.number === 1);
    if (!index01) {
      fail("CUE_INDEX_INVALID", `${cuePath}: ${label} is missing mandatory INDEX 01.`);
    }
    if (track.indexes.some((entry) => entry.number > 1 && entry.number !== 0 && !track.indexes.some((candidate) => candidate.number === entry.number - 1))) {
      fail("CUE_INDEX_INVALID", `${cuePath}: ${label} INDEX sequence has gaps.`);
    }
    const firstFrame = sorted[0]!.frame;
    if (firstFrame <= previousEnd && trackOrdinal > 0) {
      fail("CUE_INDEX_INVALID", `${cuePath}: ${label} starts before the previous track's final index.`);
    }
    previousEnd = sorted[sorted.length - 1]!.frame;
  });
}
