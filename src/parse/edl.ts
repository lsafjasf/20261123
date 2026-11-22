/**
 * CMX3600 EDL parser. Produces raw events; normalization to the unified
 * model happens in normalize.ts (frame rate is assigned there, since EDL
 * itself carries no explicit rate beyond the FCM drop-frame flag).
 */

export type EdlEditCode = "C" | "D" | "W" | "K";

export interface EdlMotion {
  /** Speed in percent; 0 = freeze frame. Negative = reverse. */
  readonly speedPercent: number;
  /** Source timecode where the motion segment starts. */
  readonly sourceStartTc: string;
}

export interface EdlEvent {
  readonly number: number;
  readonly reel: string;
  /** Raw track code: V, A, A2, AA, B, etc. */
  readonly trackCode: string;
  readonly editCode: EdlEditCode;
  /** Transition duration in frames (D/W only). */
  readonly transitionFrames: number;
  readonly sourceInTc: string;
  readonly sourceOutTc: string;
  readonly recordInTc: string;
  readonly recordOutTc: string;
  clipName: string | null;
  motion: EdlMotion | null;
  /** Wipe pattern code, e.g. "W001". */
  readonly wipeCode: string | null;
}

export interface EdlDocument {
  readonly title: string;
  readonly dropFrame: boolean | null;
  readonly events: EdlEvent[];
  readonly warnings: string[];
}

const EVENT_RE =
  /^(\d{3,6})\s+(\S+)\s+(V|A\d*|AA|AA\/V|B|VB)\s+(C|D|K|W\d{3})\s*(\d{0,3})\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/;

const M2_RE = /^M2\s+(\S+)\s+(-?\d+(?:\.\d+)?)\s+(\S+)\s*$/;

export function parseEdl(text: string): EdlDocument {
  const lines = text.split(/\r?\n/);
  let title = "";
  let dropFrame: boolean | null = null;
  const events: EdlEvent[] = [];
  const warnings: string[] = [];
  let current: EdlEvent | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (/^TITLE:/i.test(trimmed)) {
      title = trimmed.slice(6).trim();
      continue;
    }
    if (/^FCM:/i.test(trimmed)) {
      dropFrame = /NON[- ]?DROP/i.test(trimmed) ? false : /DROP/i.test(trimmed);
      continue;
    }

    const ev = EVENT_RE.exec(trimmed);
    if (ev) {
      const rawCode = ev[4];
      const editCode: EdlEditCode = rawCode === "C" ? "C" : rawCode === "D" ? "D" : rawCode === "K" ? "K" : "W";
      current = {
        number: Number(ev[1]),
        reel: ev[2],
        trackCode: ev[3],
        editCode,
        transitionFrames: ev[5] === "" ? 0 : Number(ev[5]),
        sourceInTc: ev[6],
        sourceOutTc: ev[7],
        recordInTc: ev[8],
        recordOutTc: ev[9],
        clipName: null,
        motion: null,
        wipeCode: editCode === "W" ? rawCode : null,
      };
      events.push(current);
      continue;
    }

    const nameMatch = /^\*\s*FROM CLIP NAME:\s*(.*)$/i.exec(trimmed);
    if (nameMatch && current) {
      current.clipName = nameMatch[1].trim() || null;
      continue;
    }

    const m2 = M2_RE.exec(trimmed);
    if (m2 && current) {
      current.motion = { speedPercent: Number(m2[2]), sourceStartTc: m2[3] };
      continue;
    }

    if (trimmed.startsWith("*")) continue; // other comments: ignore
    warnings.push(`line ${i + 1}: unrecognized: "${trimmed.slice(0, 60)}"`);
  }

  return { title, dropFrame, events, warnings };
}
