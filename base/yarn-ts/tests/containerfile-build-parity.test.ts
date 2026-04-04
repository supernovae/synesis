/**
 * Guards against "step 1" image build failures: yarn-ts depends on compiled
 * workspace packages; the Containerfile must COPY and `npm run build` each
 * before `base/yarn-ts` (see prior regression when @synesis/mcp-tools was omitted).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const yarnTsDir = join(__dirname, "..");
const repoRoot = join(yarnTsDir, "..", "..");
const containerfilePath = join(yarnTsDir, "Containerfile");
const packagesDir = join(repoRoot, "packages");

function readPackageJson(path: string): { name?: string; dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(path, "utf-8")) as { name?: string; dependencies?: Record<string, string> };
}

/** Map @synesis/foo -> directory name under packages/ by reading each package.json */
function workspaceFolderForSynesisPackage(pkgName: string): string | undefined {
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(packagesDir, entry.name, "package.json");
    try {
      const j = readPackageJson(p);
      if (j.name === pkgName) return entry.name;
    } catch {
      /* skip */
    }
  }
  return undefined;
}

describe("base/yarn-ts/Containerfile", () => {
  it("lists compile steps for every @synesis/* dependency in package.json", () => {
    const pkg = readPackageJson(join(yarnTsDir, "package.json"));
    const synesisDeps = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith("@synesis/"));
    expect(synesisDeps.length).toBeGreaterThan(0);

    const container = readFileSync(containerfilePath, "utf-8");

    for (const dep of synesisDeps) {
      const folder = workspaceFolderForSynesisPackage(dep);
      expect(folder, `packages/*/package.json with name ${dep}`).toBeTruthy();
      expect(container, `COPY packages/${folder} for ${dep}`).toContain(`packages/${folder}/`);
      expect(container, `npm run build workspace packages/${folder} for ${dep}`).toMatch(
        new RegExp(`npm run build --workspace=packages/${folder}`),
      );
    }
  });

  it("runs yarn-ts build after the last shared-package build", () => {
    const container = readFileSync(containerfilePath, "utf-8");
    const yarnIdx = container.indexOf("RUN npm run build --workspace=base/yarn-ts");
    expect(yarnIdx).toBeGreaterThan(0);
    const tailBeforeYarn = container.slice(0, yarnIdx);
    const packageBuilds = [...tailBeforeYarn.matchAll(/RUN npm run build --workspace=packages\/[^\s]+/g)];
    expect(packageBuilds.length).toBeGreaterThan(0);
  });
});
