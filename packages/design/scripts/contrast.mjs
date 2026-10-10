#!/usr/bin/env node
// Measures every colour pairing the system allows, in both palettes, straight
// from tokens.css, and fails if one falls below its WCAG threshold. Also
// prints the forbidden pairings with their ratios, as a record of why.
//
// Some pairings are read from components.css and base.css rather than listed:
// the ink .progress__stages is set in, on land and at every water depth, and a
// check that the disabled ink is used for nothing that has to be read.
//   node scripts/contrast.mjs            table + exit code
//   node scripts/contrast.mjs --markdown the tables as Markdown, for DESIGN.md
import { disabledInkMisuse, measure } from "./lib/tokens.mjs";

const markdown = process.argv.includes("--markdown");
let failures = 0;

for (const theme of ["dusk", "night"]) {
  const { allowed, forbidden } = measure(theme);
  if (markdown) {
    console.log(`\n### ${theme}\n\n| Ink | Ground | Ratio | Needs | Use |\n| --- | --- | --- | --- | --- |`);
    for (const p of allowed) console.log(`| ${p.fgName} \`${p.fgHex}\` | ${p.bgName} \`${p.bgHex}\` | ${p.ratio.toFixed(1)} | ${p.min} | ${p.use} |`);
    console.log(`\nForbidden:\n\n| Ink | Ground | Ratio | Why |\n| --- | --- | --- | --- |`);
    for (const p of forbidden) console.log(`| ${p.fgName} \`${p.fgHex}\` | ${p.bgName} \`${p.bgHex}\` | ${p.ratio.toFixed(1)} | ${p.why} |`);
    continue;
  }
  console.log(`\n${theme}`);
  for (const p of allowed) {
    const ok = p.ratio >= p.min;
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${p.ratio.toFixed(2).padStart(6)}  (>= ${p.min})  ${p.fgName} on ${p.bgName}: ${p.use}`);
  }
  console.log("  forbidden:");
  for (const p of forbidden) console.log(`       ${p.ratio.toFixed(2).padStart(6)}  ${p.fgName} on ${p.bgName}: ${p.why}`);
}

if (!markdown) {
  // The disabled ink is for what cannot be used. Anything else set in it is text that has to be read.
  const misuse = disabledInkMisuse();
  console.log("\ncomponents");
  console.log(`  ${misuse.length === 0 ? "ok  " : "FAIL"} the disabled ink is used only for disabled controls and placeholders${misuse.length ? `: ${misuse.join("; ")}` : ""}`);
  failures += misuse.length;

  if (failures > 0) {
    console.error(`\ncontrast: ${failures} allowed pairing(s) below threshold`);
    process.exit(1);
  }
  console.log("\ncontrast: every allowed pairing meets its threshold");
}
