export interface TestScopeSuggestion {
  isBroad: boolean;
  suggestedCommand: string | null;
  reason: string;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function goPackageFromPath(filePath: string): string {
  const clean = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = clean.split("/");
  if (parts.length <= 1) return "./...";
  if (parts[0] === "cmd" || parts[0] === "internal" || parts[0] === "pkg") {
    return `./${parts.slice(0, 2).join("/")}/...`;
  }
  return `./${parts[0]}/...`;
}

function nodeTestSelector(filePath: string): string {
  const clean = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return clean;
}

export function suggestScopedVerificationCommand(
  command: string,
  changedFiles: string[],
): TestScopeSuggestion {
  const cmd = command.trim();
  const files = dedupe(changedFiles.filter(Boolean));
  const lower = cmd.toLowerCase();
  const isBroad = /(^|\s)go test \.\/\.\.\.(\s|$)|^npm test$|^pnpm test$|^yarn test$/.test(lower);
  if (!isBroad) {
    return {
      isBroad: false,
      suggestedCommand: null,
      reason: "Command is already scoped or not a known broad test sweep.",
    };
  }
  if (files.length === 0) {
    if (lower.includes("go test")) {
      return {
        isBroad: true,
        suggestedCommand: "go test ./<changed_pkg>/...",
        reason: "Prefer package-scoped Go tests before full-module sweep.",
      };
    }
    return {
      isBroad: true,
      suggestedCommand: null,
      reason: "No changed files detected to derive narrower scope.",
    };
  }

  if (lower.includes("go test")) {
    const scopes = dedupe(files.map(goPackageFromPath)).slice(0, 3);
    return {
      isBroad: true,
      suggestedCommand: `go test ${scopes.join(" ")}`,
      reason: "Prefer package-scoped Go tests before full-module sweep.",
    };
  }

  const target = nodeTestSelector(files[0]);
  if (lower.startsWith("npm")) {
    return {
      isBroad: true,
      suggestedCommand: `npm test -- ${target}`,
      reason: "Run a file-scoped test target first.",
    };
  }
  if (lower.startsWith("pnpm")) {
    return {
      isBroad: true,
      suggestedCommand: `pnpm test -- ${target}`,
      reason: "Run a file-scoped test target first.",
    };
  }
  return {
    isBroad: true,
    suggestedCommand: `yarn test ${target}`,
    reason: "Run a file-scoped test target first.",
  };
}
