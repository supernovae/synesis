import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("router governance", () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const srcDir = path.resolve(currentDir, "../src");
  const files = collectTsFiles(srcDir);

  it("only router node and DI wiring import retrieval client", () => {
    const allowed = new Set([
      "nodes/router.ts",
      "app.ts",
      "pipeline.ts",
    ]);
    const violations: string[] = [];
    for (const file of files) {
      if (file.includes("/retrieval/")) continue;
      const content = readFileSync(file, "utf8");
      if (content.includes("from \"../retrieval/client.js\"") || content.includes("from \"./retrieval/client.js\"")) {
        const relative = path.relative(srcDir, file).replace(/\\/g, "/");
        if (!allowed.has(relative)) {
          violations.push(file);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("router node imports retrieval client", () => {
    const routerFile = path.resolve(srcDir, "nodes/router.ts");
    const content = readFileSync(routerFile, "utf8");
    expect(content.includes("from \"../retrieval/client.js\"")).toBe(true);
  });
});
