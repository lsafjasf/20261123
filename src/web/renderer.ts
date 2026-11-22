import type { CameraPlan, Project, Rect, Timeline } from "../shared/types.ts";
import { cropAt } from "../shared/camera.ts";
import { clamp } from "../shared/geometry.ts";

export interface LoadedImage {
  bitmap: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
}

export interface RenderContext {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  project: Project;
  timeline: Timeline;
  plans: Map<string, CameraPlan>;
  images: Map<string, LoadedImage>;
}

export async function loadImages(project: Project): Promise<Map<string, LoadedImage>> {
  const loaded = new Map<string, LoadedImage>();
  for (const spec of project.images) {
    const response = await fetch(spec.src);
    if (!response.ok) {
      throw new Error(`failed to load ${spec.src}: ${response.status}`);
    }
    const blob = await response.blob();
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(blob);
      loaded.set(spec.id, {
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
      });
    } else {
      const bitmap = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`image decode failed: ${spec.src}`));
        image.src = URL.createObjectURL(blob);
      });
      loaded.set(spec.id, { bitmap, width: bitmap.naturalWidth, height: bitmap.naturalHeight });
    }
  }
  return loaded;
}

function drawCrop(
  render: RenderContext,
  imageId: string,
  crop: Rect,
  alpha: number,
): void {
  const loaded = render.images.get(imageId);
  if (!loaded) {
    throw new Error(`image not loaded: ${imageId}`);
  }
  const { ctx, project } = render;
  const source = {
    x: crop.x * loaded.width,
    y: crop.y * loaded.height,
    width: crop.width * loaded.width,
    height: crop.height * loaded.height,
  };
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    loaded.bitmap,
    source.x,
    source.y,
    source.width,
    source.height,
    0,
    0,
    project.video.width,
    project.video.height,
  );
  ctx.restore();
}

export function renderFrame(render: RenderContext, time: number): void {
  const { ctx, project, timeline, plans } = render;
  ctx.save();
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, project.video.width, project.video.height);

  const segments = timeline.segments;
  let index = segments.findIndex(
    (segment) => time >= segment.enterAt && time < segment.end,
  );
  if (index < 0) {
    index = time < segments[0].enterAt ? 0 : segments.length - 1;
  }
  const segment = segments[clamp(index, 0, segments.length - 1)];
  const transition = timeline.transitionSeconds;
  if (index < segments.length - 1 && time >= segment.leaveAt) {
    const fade = clamp((time - segment.leaveAt) / transition, 0, 1);
    const next = segments[index + 1];
    const nextPlan = plans.get(next.imageId);
    if (nextPlan) {
      const nextProgress = clamp(
        (time - next.enterAt) / Math.max(0.001, next.leaveAt - next.enterAt),
        0,
        1,
      );
      drawCrop(render, next.imageId, cropAt(nextPlan, nextProgress), 1);
    }
  }

  const plan = plans.get(segment.imageId);
  if (!plan) {
    throw new Error(`missing plan for ${segment.imageId}`);
  }
  const motionSpan = Math.max(0.001, segment.leaveAt - segment.enterAt);
  const progress = clamp((time - segment.enterAt) / motionSpan, 0, 1);
  const inTransition = index < segments.length - 1 && time >= segment.leaveAt;
  const currentAlpha = inTransition
    ? 1 - clamp((time - segment.leaveAt) / transition, 0, 1)
    : 1;
  drawCrop(render, segment.imageId, cropAt(plan, progress), currentAlpha);
  ctx.restore();
}

