import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
let child: ChildProcess | null = null;
let timer: NodeJS.Timeout | null = null;
let building = false;

function build(): Promise<void> {
  building = true;
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", join(root, "scripts", "build.ts")],
      { stdio: "inherit" },
    );
    proc.on("exit", (code) => {
      building = false;
      code === 0 ? resolve() : reject(new Error(`build exited ${code}`));
    });
  });
}

function launch(): void {
  child?.kill("SIGTERM");
  child = spawn(process.execPath, [join(root, "dist", "server.js")], {
    stdio: "inherit",
    env: { ...process.env, PORT: process.env.PORT ?? "4178" },
  });
}

async function rebuild(): Promise<void> {
  if (building) return;
  try {
    await build();
    launch();
    console.log("Rebuilt. Server restarted.");
  } catch (error) {
    console.error(error);
  }
}

await build();
launch();

const watched = [
  join(root, "src"),
  join(root, "public", "index.html"),
  join(root, "public", "styles.css"),
  join(root, "public", "favicon.svg"),
  join(root, "server.ts"),
];

for (const target of watched) {
  watch(target, { recursive: target === join(root, "src") }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 120);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child?.kill("SIGTERM");
    process.exit(0);
  });
}
