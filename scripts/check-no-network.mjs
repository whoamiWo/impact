#!/usr/bin/env node
// Static gate: the CLI is local-first and must not contain network clients.
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "src");

const patterns = [
  { name: "node network module", re: /\b(?:from|import)\s*\(?\s*["'](?:node:)?(?:http|https|http2|net|tls|dgram)["']/ },
  { name: "require of network module", re: /\brequire\s*\(\s*["'](?:node:)?(?:http|https|http2|net|tls|dgram)["']\s*\)/ },
  { name: "network client package", re: /\bfrom\s+["'](?:undici|axios|node-fetch|got|ws)["']/ },
  { name: "global fetch", re: /(?<![.\w])fetch\s*\(/ },
];

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(abs)));
    else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) files.push(abs);
  }
  return files;
}

const violations = [];
for (const file of await walk(root)) {
  const text = await fs.readFile(file, "utf8");
  text.split("\n").forEach((line, index) => {
    for (const { name, re } of patterns) {
      if (re.test(line)) {
        violations.push(`${path.relative(root, file)}:${index + 1}: ${name}: ${line.trim()}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error("Network usage is not allowed in src/:\n" + violations.join("\n"));
  process.exit(1);
}
console.log("No network usage found in src/.");
