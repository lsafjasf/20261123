import { cropAtCut, resolveCrop } from "./crop.ts";
import { projectDuration } from "./content.ts";
import { makeCues } from "./subtitles.ts";
import type { Project } from "./types.ts";

interface ManifestOptions {
  includeAudio: boolean;
  burnCaptions: boolean;
  videoCodec: string;
  audioCodec: string;
}

export function buildManifest(project: Project, options: ManifestOptions): string {
  const manifest = {
    format: "portrait-cut/edit-parameters",
    version: "1.0",
    generatedAt: new Date().toISOString(),
    project: {
      title: project.title,
      subtitle: project.subtitle,
      duration: Number(projectDuration(project).toFixed(3)),
      source: {
        width: project.sourceWidth,
        height: project.sourceHeight,
        fps: project.fps,
        generated: true,
      },
      delivery: {
        width: project.outputWidth,
        height: project.outputHeight,
        pixelAspectRatio: "1:1",
        sampleAspectRatio: "1:1",
        audio: options.includeAudio,
        burnedCaptions: options.burnCaptions,
      },
    },
    safeAreaPolicy: {
      captionWidth: "86% of output width",
      captionMaxLines: 2,
      gestureProtection: "subject and key-gesture union clamped inside crop",
      overflowBehavior: "zoom out with blurred fill instead of hard crop",
    },
    codecs: {
      video: options.videoCodec,
      audio: options.includeAudio ? options.audioCodec : null,
      container: "WebM",
    },
    shots: project.shots.map((shot, index) => {
      const crop = cropAtCut(project, shot);
      const entry = resolveCrop(project, shot.start + 0.1);
      const next = project.shots[index + 1];
      const subjectCenterX = shot.sourceBox.x + shot.sourceBox.w / 2;
      const subjectCenterY = shot.sourceBox.y + shot.sourceBox.h / 2;
      return {
        index: index + 1,
        id: shot.id,
        time: { start: shot.start, end: shot.end, duration: Number((shot.end - shot.start).toFixed(3)) },
        speaker: { name: shot.speaker, role: shot.role, talent: shot.person },
        subtitle: shot.text,
        subjectBox: shot.sourceBox,
        keyGesture: {
          id: shot.gesture.id,
          label: shot.gesture.label,
          box: shot.gesture.rect,
          start: shot.gesture.start,
          end: shot.gesture.end,
        },
        motionTarget: shot.target,
        sourceSubjectCenter: {
          x: Number(subjectCenterX.toFixed(3)),
          y: Number(subjectCenterY.toFixed(3)),
          outputPixels: {
            x: Number(((subjectCenterX - crop.left) * crop.scale + crop.drawX).toFixed(3)),
            y: Number(((subjectCenterY - crop.top) * crop.scale + crop.drawY).toFixed(3)),
          },
        },
        framing: {
          zoom: shot.zoom,
          effectiveZoom: Number(crop.effectiveZoom.toFixed(4)),
          panInMs: shot.panMs,
          easing: shot.easing,
          letterbox: crop.letterbox,
        },
        panWindow: next && next.panMs > 0
          ? {
            start: Number((shot.end - next.panMs / 1000).toFixed(3)),
            end: shot.end,
            toShot: next.id,
            durationMs: next.panMs,
          }
          : null,
        cropWindow: {
          x: Number(crop.left.toFixed(3)),
          y: Number(crop.top.toFixed(3)),
          width: Number(crop.width.toFixed(3)),
          height: Number(crop.height.toFixed(3)),
        },
        safety: {
          captions: shot.safeCaptions,
          gestures: shot.safeGestures,
          contained: entry.contained,
          warnings: entry.warnings,
        },
      };
    }),
    subtitles: {
      file: "captions.zh-CN.vtt",
      cues: makeCues(project),
    },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function buildDeliveryReadme(project: Project): string {
  return [
    "竖映 PORTRAIT CUT / 交付说明",
    "================================",
    "",
    `项目：${project.title}`,
    `副标题：${project.subtitle}`,
    "",
    "文件：",
    "1. portrait-master.webm — 1080×1920 竖屏成片，WebCodecs 离线编码",
    "2. captions.zh-CN.vtt — 逐句字幕与时间码",
    "3. edit-parameters.json — 每一镜的主体框、手势区、运动目标、",
    "   裁切窗、缩放、平移时长与安全区校验结果",
    "",
    "安全规则：",
    "- 字幕限制在画幅宽度的 86% 内，并自动换两行；",
    "- 主体框与关键手势区合并后限制在裁切窗内；",
    "- 安全区超宽时自动缩小主体并加模糊背景，不做硬裁。",
    "",
    "本交付包完全由程序生成，不含外部素材或第三方依赖。",
    "",
  ].join("\n");
}
