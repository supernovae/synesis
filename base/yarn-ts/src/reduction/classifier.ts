import type { ReducerFamily } from "./types.js";

function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

export function classifyReducerFamily(toolName?: string, command?: string, raw?: string): ReducerFamily {
  const t = (toolName ?? "").toLowerCase();
  const c = (command ?? "").toLowerCase();
  const tc = `${t} ${c}`;
  const r = (raw ?? "").toLowerCase();

  // ── Phase 1: high-confidence toolName / command hints ──────────────
  // More specific matches first within each group.

  // VCS — specific subcommands before generic
  if (hasAny(tc, ["git diff", "git show", "git apply", "git format-patch"])) return "git-diff";
  if (hasAny(tc, ["git log", "git shortlog"])) return "git-log";
  if (hasAny(tc, ["git status", "git branch", "git stash", "git remote", "git tag"])) return "git";

  // Test runners — coverage-flavored before plain
  if (hasAny(tc, ["jest --coverage", "vitest --coverage", "pnpm test --coverage", "c8 ", "nyc ", "coverage run", "coverage report", "pytest --cov"])) return "coverage";
  if (hasAny(tc, ["pytest", "py.test"])) return "pytest";
  if (hasAny(tc, ["jest", "vitest", "npx jest", "npx vitest"])) return "jest";
  if (hasAny(tc, ["mocha", "npx mocha"])) return "mocha";
  if (hasAny(tc, ["rspec", "bundle exec rspec"])) return "rspec";
  if (hasAny(tc, ["phpunit", "vendor/bin/phpunit"])) return "phpunit";
  if (hasAny(tc, ["python -m unittest", "python3 -m unittest"])) return "python-unittest";

  // Linters / static analysis — specific before generic
  if (hasAny(tc, ["cargo clippy"])) return "clippy";
  if (hasAny(tc, ["eslint", "ruff check", "ruff "])) return "lint";
  if (hasAny(tc, ["pylint"])) return "pylint";
  if (hasAny(tc, ["shellcheck"])) return "shellcheck";
  if (hasAny(tc, ["rubocop"])) return "rubocop";
  if (hasAny(tc, ["cppcheck"])) return "cppcheck";
  if (hasAny(tc, ["mypy"])) return "mypy";
  if (hasAny(tc, ["tsc", "tsc --"])) return "tsc";

  // Search
  if (hasAny(tc, ["rg ", "rg\t", "ripgrep", "grep "])) return "search";

  // JS/TS build tools
  if (hasAny(tc, ["webpack", "npx webpack"])) return "webpack";
  if (hasAny(tc, ["vite build", "npx vite", "vite "])) return "vite";
  if (hasAny(tc, ["esbuild", "npx esbuild"])) return "esbuild";

  // Package managers — specific flavors before generic npm-install
  if (hasAny(tc, ["npm audit", "yarn audit", "pnpm audit"])) return "npm-audit";
  if (hasAny(tc, ["yarn install", "yarn add", "yarn "])) return "yarn-install";
  if (hasAny(tc, ["pnpm install", "pnpm add", "pnpm i "])) return "pnpm";
  if (hasAny(tc, ["npm install", "npm ci", "npm i "])) return "npm-install";
  if (hasAny(tc, ["composer install", "composer update", "composer require"])) return "composer";
  if (hasAny(tc, ["pip install", "pip3 install", "uv pip install", "uv pip compile"])) return "pip-install";
  if (hasAny(tc, ["apt install", "apt-get install", "apt upgrade", "dnf install", "yum install", "brew install"])) return "apt-pkg";

  // Container tools — compose before build, build before generic
  if (hasAny(tc, ["docker compose ", "docker-compose ", "podman-compose "])) return "docker-compose";
  if (hasAny(tc, ["docker build", "podman build", "docker compose build", "buildah"])) return "docker-build";
  if (hasAny(tc, ["podman ps", "podman inspect", "podman images", "podman logs", "podman run", "podman start", "podman stop"])) return "podman";

  // Build tools — specific before generic
  if (hasAny(tc, ["cargo build", "cargo test", "cargo check", "cargo run"])) return "cargo";
  if (hasAny(tc, ["dotnet build", "dotnet test", "dotnet run", "dotnet publish", "msbuild"])) return "dotnet";
  if (hasAny(tc, ["gradle ", "gradlew", "./gradlew"])) return "gradle";
  if (hasAny(tc, ["mvn ", "mvnw", "./mvnw"])) return "java-build";
  if (hasAny(tc, ["swift build", "xcodebuild", "swiftc"])) return "swift-build";
  if (hasAny(tc, ["cmake"])) return "cmake";
  if (t === "make" || t === "gmake" || /\bmake\s/.test(tc) || /\bgmake\s/.test(tc)) return "make";
  if (hasAny(tc, ["go build", "go test", "go vet", "go run"])) return "go-build";

  // Infrastructure / cloud — oc before kubectl
  if (hasAny(tc, ["oc get", "oc describe", "oc logs", "oc status", "oc adm", "oc rollout", "oc projects"])) return "oc";
  if (hasAny(tc, ["kubectl", "k9s"])) return "kubectl";
  if (hasAny(tc, ["terraform", "tofu "])) return "terraform";
  if (hasAny(tc, ["aws ", "aws s3", "aws ec2", "aws iam", "aws sts", "aws lambda"])) return "aws-cli";
  if (hasAny(tc, ["gcloud ", "gcloud compute", "gcloud run"])) return "gcloud";
  if (hasAny(tc, ["az ", "az vm", "az group", "az aks"])) return "az-cli";
  if (hasAny(tc, ["ansible-playbook", "ansible "])) return "ansible";
  if (hasAny(tc, ["helm install", "helm upgrade", "helm template", "helm status"])) return "helm";

  // Database
  if (hasAny(tc, ["psql", "mysql", "sqlite3", "sqlcmd"])) return "sql-result";

  // System / diagnostics
  if (t === "ls" || t === "find" || t === "tree" || hasAny(tc, ["ls -", "find .", "tree "])) return "ls-tree";
  if (t === "curl" || hasAny(tc, ["curl ", "httpx ", "wget "])) return "curl-http";
  if (hasAny(tc, ["ping ", "traceroute", "tracert", "dig ", "nslookup"])) return "network-diag";
  if (hasAny(tc, ["strace", "ltrace", "perf stat", "perf record"])) return "strace-perf";
  if (hasAny(tc, ["journalctl", "tail -f", "docker logs"])) return "log-stream";

  // ── Phase 2: raw content patterns ─────────────────────────────────
  // For generic tool names like "bash" / "shell". Order: specific first, generic last.

  // VCS
  if (/^diff --git /m.test(r) || (/^--- /m.test(r) && /^\+\+\+ /m.test(r) && /^@@/m.test(r))) return "git-diff";
  if (/^commit [0-9a-f]{7,64}\b/m.test(r) && hasAny(r, ["author:", "date:"])) return "git-log";
  if (hasAny(r, ["on branch", "changes not staged", "changes to be committed"])) return "git";

  // Container
  if ((hasAny(r, ["attaching to", " exited with code "]) && hasAny(r, ["compose", "creating", "started", "recreating"])) ||
      /\w+_\d+\s+\|/m.test(r)) return "docker-compose";
  if (/^\s*\{[\s\S]*"id"\s*:/m.test(r) && r.includes("networksettings") && r.includes("mounts")) return "podman";
  if (hasAny(r, ["successfully built", "successfully tagged", "naming to", "exporting to image"]) ||
      (/step\s+\d+\/\d+\s*:/i.test(r) && hasAny(r, [": from ", ": run ", ": copy ", ": add ", ": cmd "])) ||
      /^#\d+\s+\[/m.test(r)) return "docker-build";

  // Test runners (specific frameworks first)
  if (hasAny(r, ["=== failures", "failed", "assert "]) && hasAny(r, ["test_", "::test"])) return "pytest";
  if (hasAny(r, ["error ts"]) && hasAny(r, ["): error ts"])) return "tsc";
  if (hasAny(r, ["fail ", "✕", "●"]) && hasAny(r, ["test suites:", "tests:"])) return "jest";
  if (/\d+\s+passing/m.test(r) && (hasAny(r, ["failing", "pending"]) || r.includes("✓"))) return "mocha";
  if (/\d+\s+examples?,\s*\d+\s+failures?/m.test(r) || hasAny(r, ["rspec ./", "failure/error:"])) return "rspec";
  if (hasAny(r, ["phpunit"]) || (/tests?:/i.test(r) && /assertions?:/i.test(r))) return "phpunit";
  if (/ran \d+ tests? in/i.test(r) && (hasAny(r, ["ok", "failed (failures=", "failed (errors="]))) return "python-unittest";
  if ((hasAny(r, ["build succeeded", "build failed"]) && hasAny(r, ["error cs", "warning cs", "msbuild"])) ||
      (hasAny(r, ["total tests:", "total:"]) && hasAny(r, ["passed:", "failed:"]))) return "dotnet";

  // Coverage (before generic linters)
  if (/\bStmts\b/.test(r) && /\bMiss\b/.test(r) && /\bCover\b/.test(r)) return "coverage";
  if (/\b%?\s*Stmts\b/i.test(r) && r.includes("|") && /\d+\s*\|\s*\d+/.test(r)) return "coverage";

  // Linters / static analysis
  if (hasAny(r, ["f401", "e501", "e711", "e722"]) || (hasAny(r, ["warning  ", " error  "]) && hasAny(r, ["eslint", "ruff"]))) return "lint";
  if (hasAny(r, ["rated at"]) && /\*{5,}\s*module/i.test(r)) return "pylint";
  if (/\.py:\d+:\d+:\s*\[[crwef]\d+/i.test(r)) return "pylint";
  if (/in .+\s+line \d+:/m.test(r) && /sc\d{4}/i.test(r)) return "shellcheck";
  if (hasAny(r, ["clippy::", "#[warn(clippy::", "#[deny(clippy::"])) return "clippy";
  if (/\.rb:\d+:\d+:\s*[cwef]:/i.test(r) && (hasAny(r, ["offenses", "inspected"]))) return "rubocop";
  if (/\(error\)|\(warning\)|\(style\)|\(performance\)/.test(r) && /\[\w+:\d+\]/.test(r)) return "cppcheck";
  if (/\.py:\d+: error:/.test(r) && hasAny(r, ["found ", "incompatible", "has no attribute"])) return "mypy";

  // Build tools — cmake before make (cmake filenames contain "make:" as substring)
  if (hasAny(r, ["npm warn", "npm err!", "added "]) && hasAny(r, [" packages", "peer dep"])) return "npm-install";
  if (hasAny(r, ["compiling ", "downloading "]) && hasAny(r, ["cargo", "crate"])) return "cargo";
  if (/error\[e\d+\]/.test(r) && hasAny(r, ["-->"])) return "cargo";
  if ((hasAny(r, ["-- configuring done"]) && (hasAny(r, ["-- found", "-- generating"]))) ||
      (hasAny(r, ["cmake error"]) && !hasAny(r, ["make["]))) return "cmake";
  if (/\bmake\[/.test(r) || /\bmake:/.test(r)) return "make";
  if (hasAny(r, [": error:", ": warning:"]) && /\.(c|cpp|h|cc|cxx):\d+/.test(r)) return "make";

  // Stack trace (after tool-specific checks)
  if (hasAny(r, ["traceback (most recent call last)", "  file \""])) return "stack-trace";
  if (/^\s+at .+\(/.test(r) && hasAny(r, ["error:", "exception:"])) return "stack-trace";
  if (hasAny(r, ["caused by:", "exception in thread"])) return "stack-trace";

  // Go / pip
  if (/\.go:\d+:\d+:/.test(r) && hasAny(r, ["cannot ", "undefined:", "declared"])) return "go-build";
  if (hasAny(r, ["--- fail:", "fail\t"])) return "go-build";
  if (hasAny(r, ["successfully installed", "requirement already satisfied", "collecting "])) return "pip-install";

  // JS build tools
  if (hasAny(r, ["error in", "warning in"]) && (hasAny(r, ["asset ", "modules", "webpack"]) || /built in \d/i.test(r))) return "webpack";
  if (hasAny(r, ["vite v", "✓ built in"]) || (/dist\//m.test(r) && /\d+\.\d+\s*kb/i.test(r) && !r.includes("webpack"))) return "vite";
  if (hasAny(r, ["✘ [error]"]) || (hasAny(r, ["esbuild"]) && /done in \d/i.test(r))) return "esbuild";

  // Package managers
  if (/found \d+ vulnerabilit/i.test(r) || (hasAny(r, ["critical", "high", "moderate"]) && hasAny(r, ["vulnerabilit", "severity"]))) return "npm-audit";
  if (hasAny(r, ["yn0", "➤ yn"]) || (hasAny(r, ["resolution step", "fetch step"]) && hasAny(r, ["done in"]))) return "yarn-install";
  if (hasAny(r, ["packages: +", "progress: resolved"]) || (hasAny(r, ["dependencies:", "devdependencies:"]) && r.includes("pnpm"))) return "pnpm";
  if (hasAny(r, ["composerinstaller", "generating autoload", "writing lock file"]) ||
      (hasAny(r, ["installing "]) && hasAny(r, ["loading composer"]))) return "composer";
  if ((hasAny(r, ["setting up", "unpacking"]) && hasAny(r, ["processing triggers"])) ||
      (hasAny(r, ["get:", "fetched "]) && hasAny(r, ["packages newly installed", "packages upgraded"])) ||
      (hasAny(r, ["installing:", "upgrading:"]) && hasAny(r, ["transaction summary"])) ||
      (hasAny(r, ["==> pouring", "==> downloading"]))) return "apt-pkg";

  // HTTP / curl
  if (/^(HTTP\/[\d.]+)\s+\d{3}/m.test(r) && (hasAny(r, ["content-type:", "< "]) || /^[*>]\s/m.test(r))) return "curl-http";

  // Infrastructure / cloud
  if (hasAny(r, ["openshift.io/", "deploymentconfig/", "route.route.openshift.io", "imagestream.image.openshift.io"])) return "oc";
  if (hasAny(r, ["running", "pending", "crashloopbackoff"]) && hasAny(r, ["pod/", "deploy/", "namespace"])) return "kubectl";
  if (hasAny(r, ["plan:", "apply complete!", "terraform"]) && /^\s*[+~-]\s+(resource|data)\b/m.test(r)) return "terraform";
  if (hasAny(r, ["arn:aws:", "instanceid"]) || (/^\s*\{/m.test(r) && hasAny(r, ["\"region\"", "\"accountid\""]))) return "aws-cli";
  if (/^\s*\{/m.test(r) && hasAny(r, ["\"selflink\"", "\"zone\"", "projects/"])) return "gcloud";
  if (/^\s*\[?\s*\{/m.test(r) && hasAny(r, ["\"provisioningstate\"", "\"resourcegroup\"", "microsoft."])) return "az-cli";

  // Build tools
  if (hasAny(r, ["build successful", "build failed"]) && hasAny(r, ["> task :", "actionable task"])) return "gradle";
  if ((hasAny(r, ["build complete!", "compileswift"]) || (hasAny(r, ["linking"]) && hasAny(r, ["build target"]))) &&
      !hasAny(r, ["cargo", "rustc"])) return "swift-build";
  if (hasAny(r, ["[error]", "build failure", "build success"]) && hasAny(r, ["[info]", "downloading from"])) return "java-build";

  // Database
  if (/^\+[-+]+\+$/m.test(r) && /^\|.*\|$/m.test(r)) return "sql-result";
  if (/\(\d+ rows?\)/m.test(r) && /^\|.*\|$/m.test(r)) return "sql-result";

  // Ops
  if (hasAny(r, ["play recap", "fatal:", "task ["]) && hasAny(r, ["ok=", "changed=", "failed="])) return "ansible";
  if (hasAny(r, ["name:", "status:", "revision:"]) && hasAny(r, ["chart:", "notes:"])) return "helm";
  if (hasAny(r, ["packets transmitted", "packet loss", "rtt min"])) return "network-diag";
  if (hasAny(r, [";; answer section", ";; query"]) || (hasAny(r, ["server:", "address:"]) && /\bIN\s+(A|AAAA|CNAME|MX|NS|TXT)\b/i.test(r))) return "network-diag";
  if (/^\w+\(/.test(r) && /= -?\d/.test(r) && (r.match(/^\w+\(/gm) ?? []).length > 20) return "strace-perf";
  if (/^% time\s+seconds/m.test(r)) return "strace-perf";

  // Log stream (generic — many log-level lines)
  const logLevelCount = (r.match(/\b(ERROR|WARN|INFO|DEBUG|FATAL)\b/gi) ?? []).length;
  if (logLevelCount >= 10) return "log-stream";

  // Search / grep: generic file:line: fallback — last because many tools produce this format
  const searchLineCount = (r.match(/^[^\s:]+:\d+:/gm) ?? []).length;
  if (searchLineCount >= 3) return "search";

  return "generic";
}
