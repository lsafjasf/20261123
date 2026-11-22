// gen-demo 子命令：生成演示输入（日志/帧表/锚点/连招）
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { demoFramePts, demoLog, demoAnchors, demoCombos } from '../shared/demo.ts';
import { serializeLog } from '../shared/logparse.ts';

export function genDemo(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'log.jsonl'), serializeLog(demoLog()));
  writeFileSync(join(outDir, 'frames.json'), JSON.stringify({ pts: demoFramePts() }));
  writeFileSync(join(outDir, 'anchors.json'), JSON.stringify(demoAnchors(), null, 2));
  writeFileSync(join(outDir, 'combos.json'), JSON.stringify(demoCombos(), null, 2));
  console.log(`演示数据已写入 ${outDir}/`);
  console.log('提示: 打开 Web 标注台的「演示模式」可生成与 frames.json 完全一致的演示视频。');
}
