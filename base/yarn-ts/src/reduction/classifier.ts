import type { ReducerFamily } from "./types.js";

function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

export function classifyReducerFamily(toolName?: string, command?: string, raw?: string): ReducerFamily {
  const t = (toolName ?? "").toLowerCase();
  const c = (command ?? "").toLowerCase();
  const tc = `${t} ${c}`;
  const r = (raw ?? "").toLowerCase();

  // Phase 1: high-confidence toolName / command hints (no raw scanning)

  // Original 5
  if (hasAny(tc, ["pytest", "py.test"])) return "pytest";
  if (hasAny(tc, ["tsc", "tsc --"])) return "tsc";
  if (hasAny(tc, ["eslint", "ruff"])) return "lint";
  if (hasAny(tc, ["git status", "git diff", "git log", "git show"])) return "git";
  if (hasAny(tc, ["rg ", "rg\t", "ripgrep", "grep "])) return "search";

  // Batch A
  if (hasAny(tc, ["npm install", "npm ci", "npm i ", "yarn install", "yarn add", "pnpm install"])) return "npm-install";
  if (hasAny(tc, ["docker build", "podman build", "docker compose build", "buildah"])) return "docker-build";
  if (hasAny(tc, ["cargo build", "cargo test", "cargo clippy", "cargo check", "cargo run"])) return "cargo";
  if (t === "make" || hasAny(tc, ["make ", "cmake ", "gmake "])) return "make";

  // Batch B
  if (hasAny(tc, ["jest", "vitest", "npx jest", "npx vitest"])) return "jest";
  if (hasAny(tc, ["go build", "go test", "go vet", "go run"])) return "go-build";
  if (hasAny(tc, ["pip install", "pip3 install", "uv pip install", "uv pip compile"])) return "pip-install";
  if (t === "ls" || t === "find" || t === "tree" || hasAny(tc, ["ls -", "find .", "tree "])) return "ls-tree";
  if (t === "curl" || hasAny(tc, ["curl ", "httpx ", "wget "])) return "curl-http";

  // Batch C
  if (hasAny(tc, ["kubectl", "oc get", "oc describe", "oc logs"])) return "kubectl";
  if (hasAny(tc, ["terraform", "tofu "])) return "terraform";
  if (hasAny(tc, ["psql", "mysql", "sqlite3", "sqlcmd"])) return "sql-result";
  if (hasAny(tc, ["mypy"])) return "mypy";
  if (hasAny(tc, ["mvn ", "gradle ", "mvnw", "gradlew"])) return "java-build";

  // Batch D
  if (hasAny(tc, ["ansible-playbook", "ansible "])) return "ansible";
  if (hasAny(tc, ["helm install", "helm upgrade", "helm template", "helm status"])) return "helm";
  if (hasAny(tc, ["ping ", "traceroute", "tracert", "dig ", "nslookup"])) return "network-diag";
  if (hasAny(tc, ["strace", "ltrace", "perf stat", "perf record"])) return "strace-perf";
  if (hasAny(tc, ["journalctl", "tail -f", "docker logs"])) return "log-stream";

  // Phase 2: raw content patterns (for generic tool names like "bash", "shell")
  // Order matters — specific patterns first, generic fallbacks last.

  // Original 5 (except search, which is a generic fallback and moved to end)
  if (hasAny(r, ["=== failures", "failed", "assert "]) && hasAny(r, ["test_", "::test"])) return "pytest";
  if (hasAny(r, ["error ts"]) && hasAny(r, ["): error ts"])) return "tsc";
  if (hasAny(r, ["f401", "e501", "e711", "e722"]) || (hasAny(r, ["warning  ", " error  "]) && hasAny(r, ["eslint", "ruff"]))) return "lint";
  if (hasAny(r, ["on branch", "changes not staged", "changes to be committed"])) return "git";

  // Batch A: raw patterns
  if (hasAny(r, ["npm warn", "npm err!", "added "]) && hasAny(r, [" packages", "peer dep"])) return "npm-install";
  if (hasAny(r, ["successfully built", "successfully tagged", "naming to", "exporting to image"]) ||
      (/step\s+\d+\/\d+\s*:/i.test(r) && hasAny(r, [": from ", ": run ", ": copy ", ": add ", ": cmd "])) ||
      /^#\d+\s+\[/m.test(r)) return "docker-build";
  if (hasAny(r, ["compiling ", "downloading "]) && hasAny(r, ["cargo", "crate"])) return "cargo";
  if (/error\[e\d+\]/.test(r) && hasAny(r, ["-->"])) return "cargo";
  if (hasAny(r, ["make[", "make:"])) return "make";
  if (hasAny(r, [": error:", ": warning:"]) && /\.(c|cpp|h|cc|cxx):\d+/.test(r)) return "make";

  // Stack trace (runs after tool-specific checks)
  if (hasAny(r, ["traceback (most recent call last)", "  file \""])) return "stack-trace";
  if (/^\s+at .+\(/.test(r) && hasAny(r, ["error:", "exception:"])) return "stack-trace";
  if (hasAny(r, ["caused by:", "exception in thread"])) return "stack-trace";

  // Batch B: raw patterns
  if (hasAny(r, ["fail ", "✕", "●"]) && hasAny(r, ["test suites:", "tests:"])) return "jest";
  if (/\.go:\d+:\d+:/.test(r) && hasAny(r, ["cannot ", "undefined:", "declared"])) return "go-build";
  if (hasAny(r, ["--- fail:", "fail\t"])) return "go-build";
  if (hasAny(r, ["successfully installed", "requirement already satisfied", "collecting "])) return "pip-install";
  if (/^(HTTP\/[\d.]+)\s+\d{3}/m.test(r) && (hasAny(r, ["content-type:", "< "]) || /^[*>]\s/m.test(r))) return "curl-http";

  // Batch C: raw patterns
  if (hasAny(r, ["running", "pending", "crashloopbackoff"]) && hasAny(r, ["pod/", "deploy/", "namespace"])) return "kubectl";
  if (hasAny(r, ["plan:", "apply complete!", "terraform"]) && /^\s*[+~-]\s+(resource|data)\b/m.test(r)) return "terraform";
  if (/^\+[-+]+\+$/m.test(r) && /^\|.*\|$/m.test(r)) return "sql-result";
  if (/\(\d+ rows?\)/m.test(r) && /^\|.*\|$/m.test(r)) return "sql-result";
  if (/\.py:\d+: error:/.test(r) && hasAny(r, ["found ", "incompatible", "has no attribute"])) return "mypy";
  if (hasAny(r, ["[error]", "build failure", "build success"]) && hasAny(r, ["[info]", "downloading from"])) return "java-build";

  // Batch D: raw patterns
  if (hasAny(r, ["play recap", "fatal:", "task ["]) && hasAny(r, ["ok=", "changed=", "failed="])) return "ansible";
  if (hasAny(r, ["name:", "status:", "revision:"]) && hasAny(r, ["chart:", "notes:"])) return "helm";
  if (hasAny(r, ["packets transmitted", "packet loss", "rtt min"])) return "network-diag";
  if (hasAny(r, [";; answer section", ";; query"]) || (hasAny(r, ["server:", "address:"]) && /\bIN\s+(A|AAAA|CNAME|MX|NS|TXT)\b/i.test(r))) return "network-diag";
  if (/^\w+\(/.test(r) && /= -?\d/.test(r) && (r.match(/^\w+\(/gm) ?? []).length > 20) return "strace-perf";
  if (/^% time\s+seconds/m.test(r)) return "strace-perf";

  // Log stream: many lines with log-level patterns
  const logLevelCount = (r.match(/\b(ERROR|WARN|INFO|DEBUG|FATAL)\b/gi) ?? []).length;
  if (logLevelCount >= 10) return "log-stream";

  // Search / grep: generic file:line: pattern — checked last because many tools produce this format
  const searchLineCount = (r.match(/^[^\s:]+:\d+:/gm) ?? []).length;
  if (searchLineCount >= 3) return "search";

  return "generic";
}
