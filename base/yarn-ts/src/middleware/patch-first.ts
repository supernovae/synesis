interface ToolDef {
  function?: {
    name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function enforcePatchFirst(tools: ToolDef[] | undefined): string | null {
  for (const t of tools ?? []) {
    const fn = t?.function;
    if (!fn || typeof fn.name !== "string") {
      continue;
    }
    if (fn.name === "write_file") {
      return "Patch-first policy violation: use str_replace/search-replace instead of write_file for non-trivial edits.";
    }
  }
  return null;
}
