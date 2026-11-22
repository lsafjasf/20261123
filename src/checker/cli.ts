import { readFile } from "node:fs/promises";
import { checkManifestInput, formatCheckReport } from "./checker.ts";
import { describeRoundingAudit } from "../diagnostics/rounding.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const showAudit = args.includes("--audit");
  const path = args.find((arg) => !arg.startsWith("--"));
  if (!path) {
    process.stderr.write("usage: npm run checker -- <manifest.json> [--audit]\n");
    process.exitCode = 2;
    return;
  }

  let input: unknown;
  try {
    input = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    process.stderr.write(`cannot read manifest: ${(error as Error).message}\n`);
    process.exitCode = 2;
    return;
  }

  if (showAudit) process.stdout.write(`${describeRoundingAudit()}\n\n`);
  const report = checkManifestInput(input);
  process.stdout.write(`${formatCheckReport(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}

await main();
