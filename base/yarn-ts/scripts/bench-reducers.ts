import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ReducerRegistry, registeredFamilies } from "../src/reduction/registry.js";

const root = join(process.cwd(), "tests", "fixtures", "reducers");
const files = readdirSync(root).filter((f) => f.endsWith(".txt"));
const registry = new ReducerRegistry({
  enabled: true,
  disabledFamilies: new Set<string>(),
  minConfidence: 0.6
});

const TOOL_HINTS: Record<string, string> = {
  pytest: "pytest", tsc: "tsc", lint: "ruff", git: "git status", search: "rg",
  "npm-install": "npm install", "docker-build": "docker build", cargo: "cargo build",
  make: "make", "stack-trace": "python", jest: "npx jest", "go-build": "go build",
  "pip-install": "pip install", "ls-tree": "tree", "curl-http": "curl",
  kubectl: "kubectl", terraform: "terraform plan", "sql-result": "psql",
  mypy: "mypy", "java-build": "mvn", ansible: "ansible-playbook",
  helm: "helm install", "network-diag": "ping", "strace-perf": "strace",
  "log-stream": "journalctl"
};

let rawChars = 0;
let reducedChars = 0;
const started = Date.now();
for (const file of files) {
  const raw = readFileSync(join(root, file), "utf8");
  rawChars += raw.length;
  const family = file.replace(/\.txt$/, "");
  const hint = TOOL_HINTS[family] ?? family;
  const out = registry.reduce({
    raw,
    context: { toolName: hint.split(" ")[0], command: hint, profile: "balanced", maxChars: 12000, minConfidence: 0.6 }
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
