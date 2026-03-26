import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ReducerRegistry } from "../src/reduction/registry.js";

const root = join(process.cwd(), "tests", "fixtures", "reducers");
const files = readdirSync(root).filter((f) => f.endsWith(".txt"));
const registry = new ReducerRegistry({
  enabled: true,
  enabledFamilies: new Set(["pytest", "tsc", "lint", "git", "search"]),
  minConfidence: 0.6
});

let rawChars = 0;
let reducedChars = 0;
const started = Date.now();
for (const file of files) {
  const raw = readFileSync(join(root, file), "utf8");
  rawChars += raw.length;
  const out = registry.reduce({
    raw,
    context: { toolName: file, command: file, profile: "balanced", maxChars: 12000, minConfidence: 0.6 }
  });
  reducedChars += (out?.summary ?? raw).length;
}
const elapsedMs = Date.now() - started;
const savedPct = rawChars > 0 ? ((rawChars - reducedChars) / rawChars) * 100 : 0;
console.log(
  JSON.stringify(
    {
      fixtures: files.length,
      rawChars,
      reducedChars,
      savedPct: Number(savedPct.toFixed(2)),
      elapsedMs,
      lifecycle: registry.lifecycleStates()
    },
    null,
    2
  )
);
