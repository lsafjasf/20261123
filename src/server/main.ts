import { defaultQuota } from "./config.ts";
import { createHttpServer } from "./httpServer.ts";
import { Scheduler } from "./scheduler.ts";

const port = Number(process.env.PORT ?? 8080);

const scheduler = new Scheduler(defaultQuota());
await scheduler.start();

const { server } = createHttpServer(scheduler);
server.listen(port, () => {
  console.log(`转码任务调度器已启动: http://localhost:${port}`);
  console.log("配额:", scheduler.quota);
});

const shutdown = async (signal: string) => {
  console.log(`\n收到 ${signal}，安全关闭中（任务状态落盘）...`);
  server.close();
  await scheduler.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
