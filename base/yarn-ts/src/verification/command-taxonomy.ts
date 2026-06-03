export type CargoCommandKind =
  | "check"
  | "build"
  | "test"
  | "clippy"
  | "fmt"
  | "fix"
  | "miri"
  | "bench"
  | "doc";

const CARGO_COMMAND_RE = /\bcargo\s+(check|build|test|clippy|fmt|fix|miri|bench|doc)\b/i;

export function normalizeCommandText(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

export function classifyCargoCommand(command: string): CargoCommandKind | null {
  const match = normalizeCommandText(command).match(CARGO_COMMAND_RE);
  return (match?.[1]?.toLowerCase() as CargoCommandKind | undefined) ?? null;
}

export function isCargoCommand(command: string): boolean {
  return classifyCargoCommand(command) !== null;
}

export function isCargoVerificationCommand(command: string): boolean {
  const kind = classifyCargoCommand(command);
  return kind === "check"
    || kind === "build"
    || kind === "test"
    || kind === "clippy"
    || kind === "fmt"
    || kind === "miri"
    || kind === "bench"
    || kind === "doc";
}

export function isCargoFixCommand(command: string): boolean {
  return classifyCargoCommand(command) === "fix";
}

export function isStandardVerificationCommand(command: string): boolean {
  const cmd = normalizeCommandText(command).toLowerCase();
  if (!cmd) return false;
  if (isCargoVerificationCommand(cmd)) return true;
  return /\b(go test|go build|go vet|dotnet test|ctest|mvn (test|verify)|gradle test|swift test|xcodebuild test|phpunit|rspec|pytest|npm test|pnpm test|yarn test|eslint|ruff|golangci-lint)\b/.test(cmd)
    || /\b(jest|vitest|npx jest|npx vitest)\b/.test(cmd)
    || /\bnpm\s+run\s+(test|check|lint|build|typecheck)\b/.test(cmd)
    || /\bpython3?\s+-m\s+(pytest|mypy|ruff)\b/.test(cmd)
    || /\buv\s+run\s+(pytest|ruff|mypy|coverage)\b/.test(cmd)
    || /\b(poetry|pipenv)\s+run\s+\S/.test(cmd)
    || /\btox\b/.test(cmd)
    || /\btsc(\s+--noEmit)?\b/.test(cmd);
}

export function isBroadVerificationCommandText(command: string): boolean {
  const cmd = normalizeCommandText(command).toLowerCase();
  if (/\bcargo\s+(?:test|build|check|clippy)\b/.test(cmd)) {
    if (/\s(?:-p|--package|--bin|--lib|--test|--example)\b/.test(cmd)) return false;
    return /\s(?:--workspace|--all|--all-targets)\b/.test(cmd)
      || /^cargo\s+(?:test|build|check|clippy)\b/.test(cmd);
  }
  return /\bgo\s+test\s+\.\/\.\.\./.test(cmd)
    || /\bgo\s+build\s+\.\/\.\.\./.test(cmd)
    || /\bgo\s+vet\s+\.\/\.\.\./.test(cmd)
    || /\bnpm\s+test\b/.test(cmd)
    || /\bpnpm\s+test\b/.test(cmd)
    || /\byarn\s+test\b/.test(cmd);
}

export function isDependencySetupCommand(command: string): boolean {
  return /\b(npm|pnpm|yarn)\s+install\b/i.test(command)
    || /\b(?:uv\s+)?pip\s+install\b/i.test(command)
    || /\bgo\s+mod\s+tidy\b/i.test(command)
    || /\bcargo\s+(?:fetch|update|generate-lockfile)\b/i.test(command);
}

export function cargoSuggestedFixCommands(output: string): string[] {
  const commands = new Set<string>();
  const regex = /run `([^`]*\bcargo\s+fix\b[^`]*)`/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(output)) !== null) {
    const command = normalizeCommandText(match[1] ?? "");
    if (command) commands.add(command);
  }
  return [...commands];
}
