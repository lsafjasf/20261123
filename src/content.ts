import type { Project, Shot } from "./types.ts";
import { SOURCE_HEIGHT, SOURCE_WIDTH } from "./types.ts";

const subtitles = [
  "我在这个行业已经做了十二年。",
  "最早其实是从一个小工作室开始的。",
  "那时候只有三个人，什么都得自己来。",
  "最难的不是技术，而是学会倾听。",
  "每一次访谈，都是一次重新理解。",
  "所以我更愿意把镜头交给真实的人。",
];

const people = [
  { person: "zhou" as const, speaker: "周岚", role: "纪录片导演", x: 418, y: 226, scale: 1.04 },
  { person: "lin" as const, speaker: "林越", role: "主持人", x: 1260, y: 238, scale: 1.0 },
  { person: "zhou" as const, speaker: "周岚", role: "纪录片导演", x: 708, y: 218, scale: 1.07 },
  { person: "lin" as const, speaker: "林越", role: "主持人", x: 1450, y: 248, scale: 0.98 },
  { person: "zhou" as const, speaker: "周岚", role: "纪录片导演", x: 552, y: 230, scale: 1.02 },
  { person: "lin" as const, speaker: "林越", role: "主持人", x: 1040, y: 238, scale: 1.02 },
];

const durations = [4.2, 4.6, 4.4, 4.1, 4.5, 4.2];
const targets = [0.48, 0.58, 0.43, 0.6, 0.51, 0.46];
const zooms = [1.16, 1.08, 1.2, 1.08, 1.14, 1.1];

export function buildTestProject(): Project {
  let cursor = 0.6;
  const shots: Shot[] = subtitles.map((text, index) => {
    const person = people[index];
    const start = Number(cursor.toFixed(3));
    const end = Number((cursor + durations[index]).toFixed(3));
    cursor = end;
    const boxW = 420 * person.scale;
    const boxH = 610 * person.scale;
    const boxX = person.x - boxW / 2;
    const boxY = person.y;
    const nextPan = 0.76;
    const hasNext = index < subtitles.length - 1;
    return {
      id: `shot-${index + 1}`,
      person: person.person,
      speaker: person.speaker,
      role: person.role,
      start,
      end,
      text,
      sourceBox: { x: boxX, y: boxY, w: boxW, h: boxH },
      gesture: {
        id: `gesture-${index + 1}`,
        label: index % 2 === 0 ? "强调手势" : "倾听回应",
        rect: {
          x: person.x - 232 * person.scale,
          y: boxY + 332 * person.scale,
          w: 464 * person.scale,
          h: 188 * person.scale,
        },
        start: start + (index === 0 ? 0.58 : 0.38),
        end: end - (hasNext ? nextPan + 0.12 : 0.35),
      },
      target: { x: targets[index], y: 0.42 },
      zoom: zooms[index],
      easing: "easeInOut",
      panMs: index === 0 ? 0 : 760,
      safeCaptions: true,
      safeGestures: true,
    };
  });

  return {
    title: "把镜头交给真实的人",
    subtitle: "周岚 · 纪录片导演 / 离线竖屏访谈",
    sourceWidth: SOURCE_WIDTH,
    sourceHeight: SOURCE_HEIGHT,
    outputWidth: 1080,
    outputHeight: 1920,
    fps: 30,
    shots,
  };
}

export function projectDuration(project: Project): number {
  return project.shots.at(-1)?.end ?? 0;
}

export function captionCues(project: Project) {
  return project.shots.map((shot) => ({
    id: shot.id,
    start: shot.start,
    end: shot.end,
    text: shot.text,
  }));
}
