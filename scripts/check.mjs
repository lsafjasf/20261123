import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const manifest = JSON.parse(
  await readFile(new URL("../data/demo-manifest.json", import.meta.url), "utf8"),
);
if (manifest.version !== 1) throw new Error("Unexpected manifest version");

const result = spawnSync(process.execPath, ["scripts/build.mjs"], {
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(
  `Manifest OK: ${manifest.segments.length} segments, ${manifest.mainline.length} mainline clips, ${manifest.decisions.length} decision`,
);
