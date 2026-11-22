import { access, readFile } from "node:fs/promises";
import { parseMp4Audio } from "../public/modules/mp4.js";

const root = new URL("..", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("public/fixtures/manifest.json", root)));
const truth = JSON.parse(await readFile(new URL("tests/fixtures/truth.json", root)));
const truthById = new Map(truth.segments.map((segment) => [segment.id, segment]));
const required = ["index.html", "styles.css", "modules/app.js", "modules/analyzer.js", "modules/decoder.js", "modules/mp4.js"];

for (const file of required) await access(new URL(`public/${file}`, root));

let paddingVariants = new Set();
for (const descriptor of manifest.segments) {
  const bytes = await readFile(new URL(`public/fixtures/${descriptor.file}`, root));
  const info = parseMp4Audio(new Uint8Array(bytes));
  const expected = truthById.get(descriptor.id);
  if (info.packets.length < 1) throw new Error(`${descriptor.id}: no packets`);
  if (info.channels !== 2 || info.sampleRate !== 48000) throw new Error(`${descriptor.id}: unexpected format`);
  if (expected.hasEditList) {
    if (!info.edit || info.editDurationSamples !== expected.sourceSamples) {
      throw new Error(`${descriptor.id}: edit list mismatch`);
    }
    const padding = info.totalDecodedSamples - info.editDurationSamples - (info.mediaTimeSamples || 0);
    if (padding < 0) throw new Error(`${descriptor.id}: negative padding`);
    paddingVariants.add(padding);
  } else if (info.edit) {
    throw new Error(`${descriptor.id}: expected no edit list`);
  }
}

if (manifest.segments.length !== 8) throw new Error("fixture count changed");
if (paddingVariants.size < 4) throw new Error("padding evidence is not variable");
console.log(`check: ${manifest.segments.length} AAC fixtures · ${paddingVariants.size} padding variants · local assets present`);
