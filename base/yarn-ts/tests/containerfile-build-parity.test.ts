/**
 * Guards against "step 1" image build failures: yarn-ts depends on compiled
 * workspace packages. The Node workspace base image must COPY and `npm run build`
 * each @synesis/* dependency before thin service images build their own package.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const yarnTsDir = join(__dirname, "..");
const repoRoot = join(yarnTsDir, "..", "..");
const nodeBaseContainerfilePath = join(repoRoot, "base", "images", "base-node-workspace", "Containerfile");
const packagesDir = join(repoRoot, "packages");
const nodeServiceWorkspaces = ["base/yarn-ts", "base/planner-ts", "base/synesis-mcp", "base/admin-mcp-ts"];
const nodeServiceImageFiles = [
  ...nodeServiceWorkspaces.map((workspace) => [workspace, join(repoRoot, workspace, "Containerfile")] as const),
  ["base/synesis-mcp", join(repoRoot, "base/synesis-mcp/Dockerfile")] as const,
  ["base/admin-mcp-ts", join(repoRoot, "base/admin-mcp-ts/Dockerfile")] as const,
];

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

describe("TypeScript service Containerfiles", () => {
  it.each(nodeServiceImageFiles)("keeps %s thin and uses the minimal runtime image", (workspace, imageFile) => {
    const container = readFileSync(imageFile, "utf-8");
    expect(container).toContain("ARG BASE_IMAGE=ghcr.io/supernovae/synesis/synesis-base-node-workspace:latest");
    expect(container).toContain("FROM ${BASE_IMAGE} AS builder");
    expect(container).toContain("FROM registry.access.redhat.com/ubi10/nodejs-24-minimal:latest");
    expect(container).not.toContain("RUN npm ci");
    expect(container).not.toMatch(/RUN npm run build --workspace=packages\//);
    expect(container).toContain(`RUN npm run build --workspace=${workspace}`);
    expect(container).toContain("RUN npm prune --omit=dev");
  });
});

describe("base/images/base-node-workspace/Containerfile", () => {
  it("lists compile steps for every @synesis/* dependency used by TypeScript services", () => {
    const synesisDeps = [
      ...new Set(
        nodeServiceWorkspaces.flatMap((workspace) => {
          const pkg = readPackageJson(join(repoRoot, workspace, "package.json"));
          return Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith("@synesis/"));
        }),
      ),
    ].sort();
    expect(synesisDeps.length).toBeGreaterThan(0);

    const container = readFileSync(nodeBaseContainerfilePath, "utf-8");

    for (const dep of synesisDeps) {
      const folder = workspaceFolderForSynesisPackage(dep);
      expect(folder, `packages/*/package.json with name ${dep}`).toBeTruthy();
      expect(container, `COPY packages/${folder} for ${dep}`).toContain(`packages/${folder}/`);
      expect(container, `npm run build workspace packages/${folder} for ${dep}`).toMatch(
        new RegExp(`npm run build --workspace=packages/${folder}`),
      );
    }
  });

  it("installs the root workspace once before shared package builds", () => {
    const container = readFileSync(nodeBaseContainerfilePath, "utf-8");
    const npmCiIdx = container.indexOf("RUN npm ci --ignore-scripts");
    expect(npmCiIdx).toBeGreaterThan(0);
    const packageBuilds = [...container.matchAll(/RUN npm run build --workspace=packages\/[^\s]+/g)];
    expect(packageBuilds.length).toBeGreaterThan(0);
    expect(packageBuilds[0]!.index).toBeGreaterThan(npmCiIdx);
  });
});
