// CLI 入口：node src/cli/main.ts <serve|sync|gen-demo> [选项]
import { parseArgs } from 'node:util';

const USAGE = `用法:
  node src/cli/main.ts serve [--port 8080]
      启动离线 Web 标注台（public/）
  node src/cli/main.ts sync --log in.jsonl --frames frames.json [--anchors anchors.json]
        [--combos combos.json] [--out-dir out]
      离线计算映射并导出 mapping.json / events.csv / events.json
  node src/cli/main.ts gen-demo [--out-dir demo]
      生成演示日志、帧表、锚点、连招配置
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === 'serve') {
    const { values } = parseArgs({ args: rest, options: { port: { type: 'string', default: '8080' } } });
    const { serve } = await import('./server.ts');
    serve(Number(values.port));
  } else if (cmd === 'sync') {
    const { values } = parseArgs({
      args: rest,
      options: {
        log: { type: 'string' }, frames: { type: 'string' },
        anchors: { type: 'string' }, combos: { type: 'string' },
        'out-dir': { type: 'string', default: 'out' },
      },
    });
    if (!values.log || !values.frames) throw new Error('sync 需要 --log 与 --frames');
    const { runSync } = await import('./syncCmd.ts');
    runSync({
      logPath: values.log, framesPath: values.frames,
      anchorsPath: values.anchors, combosPath: values.combos,
      outDir: values['out-dir']!,
    });
  } else if (cmd === 'gen-demo') {
    const { values } = parseArgs({ args: rest, options: { 'out-dir': { type: 'string', default: 'demo' } } });
    const { genDemo } = await import('./gendemo.ts');
    genDemo(values['out-dir']!);
  } else {
    throw new Error(`未知子命令: ${cmd}\n${USAGE}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
