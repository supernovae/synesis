import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parse } from "yaml";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const compose = parse(await readFile("podman-compose.yaml", "utf8"));
const helm = parse(await readFile("charts/synesis/values.yaml", "utf8"));
const components = new Map<string, { files: number; lines: number; routeFiles: string[]; configurationKeys: number }>();
const concerns = new Set<string>();
for (const path of files) {
  if (!/^base\//.test(path) || !/\.(py|tsx?)$/.test(path) || !existsSync(path)) continue;
  const component = path.split("/").slice(0, 2).join("/");
  const row = components.get(component) ?? { files: 0, lines: 0, routeFiles: [], configurationKeys: 0 };
  const source = await readFile(path, "utf8");
  row.files++; row.lines += source.split("\n").length;
  if (/\.(get|post|put|delete|patch|route)\(/.test(source) && !/\/tests?\//.test(path)) row.routeFiles.push(path);
  row.configurationKeys += [...source.matchAll(/^ {2}SYNESIS_\w+:/gm)].length;
  if (/\/src\/(auth|middleware|streaming|context|providers|llm)\//.test(path)) concerns.add(path.split("/").slice(0, 4).join("/"));
  components.set(component, row);
}
const workloads = Object.entries(helm.workloads as Record<string, { enabled: boolean; replicas?: number; resources?: { requests?: { cpu?: string; memory?: string } } }>).filter(([,v]) => v.enabled);
function memory(value = "0"): number {
  const factor = value.endsWith("Gi") ? 1024 : value.endsWith("Mi") ? 1 : value.endsWith("Ki") ? 1/1024 : 1/1024/1024;
  return parseFloat(value) * factor;
}
const output = {
  revision, generatedAt: new Date().toISOString(),
  defaultComposeServices: Object.entries(compose.services as Record<string, { profiles?: string[] }>).filter(([,v]) => !v.profiles?.length).map(([k]) => k),
  helm: { enabledWorkloads: workloads.length, replicas: workloads.reduce((n,[,v])=>n+(v.replicas??1),0),
    declaredMemoryGiB: workloads.reduce((n,[,v])=>n+memory(v.resources?.requests?.memory)*(v.replicas??1),0)/1024,
    exclusions: "Other top-level services/operators, jobs, model inference, missing requests, platform overhead; not measured usage" },
  components: Object.fromEntries(components), sharedConcernDirectories: [...concerns].sort(),
  coverage: "Tracked source files and potential route-owning files. Dynamic registration requires review; this is not an endpoint completeness proof.",
};
const result = JSON.stringify(output, null, 2) + "\n";
if (process.argv[2]) await writeFile(process.argv[2], result);
else process.stdout.write(result);
