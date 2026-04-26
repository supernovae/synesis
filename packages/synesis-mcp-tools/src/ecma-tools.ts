import type { SynesisMcpAuth } from "./auth-types.js";
import type { SynesisMcpDeps } from "./deps.js";

type JsonRecord = Record<string, unknown>;

function objectFromUnknown(value: unknown): JsonRecord {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonRecord) : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function nestedObject(parent: JsonRecord, key: string): JsonRecord {
  const value = parent[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberFromVersion(version: string): number {
  const match = version.match(/(\d+)(?:\.(\d+))?/);
  if (!match) return 0;
  return Number(match[1] ?? 0) + Number(match[2] ?? 0) / 100;
}

function detectPackageManager(lockfiles: string[]): string {
  const normalized = lockfiles.map((item) => item.toLowerCase());
  if (normalized.some((item) => item.endsWith("bun.lock") || item.endsWith("bun.lockb"))) return "bun";
  if (normalized.some((item) => item.endsWith("deno.lock"))) return "deno";
  if (normalized.some((item) => item.endsWith("pnpm-lock.yaml"))) return "pnpm";
  if (normalized.some((item) => item.endsWith("yarn.lock"))) return "yarn";
  if (normalized.some((item) => item.endsWith("package-lock.json") || item.endsWith("npm-shrinkwrap.json"))) return "npm";
  return "unknown";
}

function dependenciesFromPackageJson(pkg: JsonRecord): string[] {
  const names = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const dep of Object.keys(nestedObject(pkg, key))) names.add(dep);
  }
  return [...names].sort();
}

export function analyzeEcmaEnvironmentLocal(args: Record<string, unknown>): JsonRecord {
  const pkg = objectFromUnknown(args.package_json);
  const tsconfig = objectFromUnknown(args.tsconfig_json);
  const jsconfig = objectFromUnknown(args.jsconfig_json);
  const deno = objectFromUnknown(args.deno_json);
  const lockfiles = Array.isArray(args.lockfiles) ? args.lockfiles.map((item) => String(item)) : [];
  const compilerOptions = nestedObject(tsconfig, "compilerOptions");
  const jsCompilerOptions = nestedObject(jsconfig, "compilerOptions");
  const engines = nestedObject(pkg, "engines");
  const packageManager = detectPackageManager(lockfiles);
  const runtimes = new Set<string>();
  const warnings: string[] = [];
  const scopeTags = new Set<string>(["ecma", "javascript", "typescript"]);

  const engineNode = stringValue(engines.node);
  if (engineNode) {
    runtimes.add("node");
    scopeTags.add("node");
  }
  if (packageManager === "bun" || args.bunfig_toml) {
    runtimes.add("bun");
    scopeTags.add("bun");
  }
  if (packageManager === "deno" || Object.keys(deno).length > 0) {
    runtimes.add("deno");
    scopeTags.add("deno");
  }
  if (Object.keys(pkg).length && !runtimes.size) runtimes.add("node");

  const pkgType = stringValue(pkg.type);
  const tsModule = stringValue(compilerOptions.module || jsCompilerOptions.module);
  const tsModuleResolution = stringValue(compilerOptions.moduleResolution || jsCompilerOptions.moduleResolution);
  const moduleSystem = pkgType === "module" ? "esm" : pkgType === "commonjs" ? "commonjs" : tsModule || "unknown";
  if (String(moduleSystem).toLowerCase().includes("commonjs")) warnings.push("CommonJS posture detected; avoid ESM-only package assumptions.");
  if (String(moduleSystem).toLowerCase().includes("node")) scopeTags.add("module-system");

  const strict = compilerOptions.strict === true || jsCompilerOptions.strict === true;
  const noImplicitAny = compilerOptions.noImplicitAny === true || jsCompilerOptions.noImplicitAny === true;
  const tsSafety = strict ? "strict" : noImplicitAny ? "partial_strict" : "loose_or_unknown";
  if (!strict) warnings.push("TypeScript strict mode is not confirmed; prefer explicit narrowing and avoid any.");

  const nodeVersion = numberFromVersion(engineNode);
  let nativeTsPosture = "unknown";
  if (runtimes.has("bun")) nativeTsPosture = "bun_native_typescript";
  else if (runtimes.has("deno")) nativeTsPosture = "deno_native_typescript";
  else if (nodeVersion >= 24) nativeTsPosture = "node_type_stripping_possible";

  const deps = dependenciesFromPackageJson(pkg);
  if (deps.includes("moment")) warnings.push("moment is present; prefer Temporal or Intl APIs for new date/time code.");
  if (deps.includes("lodash")) warnings.push("lodash is present; check native Object.groupBy, Array methods, and structuredClone before adding more usage.");

  if (nativeTsPosture !== "unknown") scopeTags.add("type-stripping");
  if (deps.some((dep) => dep.includes("temporal"))) scopeTags.add("temporal");

  return {
    analyzer: "ecma_environment_check_v1",
    runtimes: [...runtimes].sort(),
    package_manager: packageManager,
    module_system: moduleSystem,
    module_resolution: tsModuleResolution || "unknown",
    ts_safety: tsSafety,
    native_typescript_posture: nativeTsPosture,
    dependency_count: deps.length,
    warnings,
    recommended_filters: {
      language: "ecma",
      scope_tags: [...scopeTags].sort(),
      artifact_kind: runtimes.has("node") || runtimes.has("bun") || runtimes.has("deno") ? "runtime_api" : "ecma_spec",
    },
  };
}

function changedDepsFromPackageJson(before: unknown, after: unknown): string[] {
  const beforeDeps = new Set(dependenciesFromPackageJson(objectFromUnknown(before)));
  return dependenciesFromPackageJson(objectFromUnknown(after)).filter((dep) => !beforeDeps.has(dep));
}

export function analyzeEcmaPackageRiskLocal(args: Record<string, unknown>): JsonRecord {
  const dependenciesAdded = new Set<string>([
    ...(Array.isArray(args.dependencies_added) ? args.dependencies_added.map((item) => String(item)) : []),
    ...changedDepsFromPackageJson(args.package_json_before, args.package_json_after),
  ]);
  const scriptsAdded = objectFromUnknown(args.scripts_added);
  const scriptsChanged = objectFromUnknown(args.scripts_changed);
  const risks: JsonRecord[] = [];
  const highRiskScripts = new Set(["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"]);
  const legacyOrHeavy = new Map<string, string>([
    ["moment", "Legacy date/time dependency; prefer native Temporal or Intl when supported."],
    ["request", "Deprecated HTTP client; prefer fetch or runtime-native APIs."],
    ["lodash", "Check native Object.groupBy, structuredClone, and standard array/object helpers before adding."],
    ["underscore", "Legacy utility package; prefer modern standard APIs."],
  ]);

  for (const [name, script] of Object.entries({ ...scriptsAdded, ...scriptsChanged })) {
    if (highRiskScripts.has(name)) {
      risks.push({
        kind: "lifecycle_script",
        name,
        core_safety: 0,
        message: `Package lifecycle script '${name}' can run code during install/publish: ${String(script)}`,
      });
    }
  }
  for (const dep of dependenciesAdded) {
    const bare = dep.replace(/^@types\//, "");
    if (legacyOrHeavy.has(dep) || legacyOrHeavy.has(bare)) {
      risks.push({
        kind: "dependency",
        name: dep,
        core_safety: dep === "moment" || bare === "moment" ? 0 : 1,
        message: legacyOrHeavy.get(dep) || legacyOrHeavy.get(bare),
      });
    }
  }

  const hardGateRequired = risks.some((risk) => risk.core_safety === 0);
  return {
    analyzer: "ecma_package_risk_v1",
    ok: !hardGateRequired,
    hard_gate_required: hardGateRequired,
    risks,
    approval_request: hardGateRequired
      ? {
          action: "package_json_change",
          core_safety: 0,
          agent_directive:
            "Before applying this dependency or lifecycle-script change, explain why native platform APIs or a safer package are insufficient and request explicit human approval.",
          suggested_synpack_query: "Ecma package dependency lifecycle script Temporal native replacement",
        }
      : null,
  };
}

export async function runEcmaEnvironmentCheck(
  args: Record<string, unknown>,
  _auth?: SynesisMcpAuth,
  _deps?: SynesisMcpDeps,
): Promise<JsonRecord> {
  return analyzeEcmaEnvironmentLocal(args);
}

export async function runEcmaPackageRiskAnalyze(
  args: Record<string, unknown>,
  _auth?: SynesisMcpAuth,
  _deps?: SynesisMcpDeps,
): Promise<JsonRecord> {
  return analyzeEcmaPackageRiskLocal(args);
}
