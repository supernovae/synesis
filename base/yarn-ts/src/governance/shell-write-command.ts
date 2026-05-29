function normalizeCommand(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isShellWriteCommand(command: string): boolean {
  return extractShellWriteTargets(command).length > 0;
}

export function extractShellWriteTargets(command: string): string[] {
  const normalized = normalizeCommand(command);
  if (!normalized) return [];

  const targets: string[] = [];
  const patterns = [
    /\bcat\s+>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/gi,
    /(?:^|[\s;&|])(?:printf|echo)\b[^;&|]*\s>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/gi,
    /\btee\s+(?:-[\w-]+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/gi,
    /\btouch\s+(?:-[\w-]+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalized)) !== null) {
      const raw = match[1] ?? match[2] ?? match[3] ?? "";
      const target = raw.trim();
      if (target && !isEphemeralShellWriteTarget(target)) targets.push(target);
      if (targets.length >= 20) return targets;
    }
  }

  return targets;
}

function isEphemeralShellWriteTarget(target: string): boolean {
  const normalized = target.replace(/\\/g, "/");
  return normalized === "1"
    || normalized === "2"
    || normalized.startsWith("/tmp/")
    || normalized.startsWith("/private/tmp/")
    || normalized.startsWith("/var/tmp/")
    || normalized.startsWith("/private/var/folders/");
}
