/**
 * PromptFrame — typed prompt structure for deterministic assembly.
 *
 * Each field is a string (already interned via BlockStore) or null.
 * The final prompt is assembled by buildPromptMessages() in a fixed,
 * documented order that maximizes upstream KV-cache prefix hits.
 *
 * Assembly order:
 *   1. stablePrefix (instructions + admin profiles + stable adapter)
 *   2. projectContext (PROJECT_ROOT tag)
 *   3. Single volatile system message (all volatile blocks joined)
 *   4. Original conversation messages
 */

export interface PromptFrame {
  stablePrefix: string;
  projectContext: string | null;

  volatileAdapter: string | null;
  workingFrame: string | null;
  structuralCritic: string | null;
  projectManifest: string | null;
  structuralIndex: string | null;
  fileSummary: string | null;
  verificationPlan: string | null;
  /** Go-doc fallback, MEMORY_HINT, chunked eval — from `generateExtendedMemoryContext`. */
  extendedMemoryBlocks: string[];
  responseStyle: string | null;
  governanceBlocks: string[];
  intentGate: string | null;
  toolEfficiency: string;
}

const VOLATILE_SEPARATOR = "\n---\n";

/**
 * Build the final system + conversation message array from a PromptFrame.
 *
 * Volatile blocks are joined into a single system message to minimize
 * the number of system messages (fewer segments = better prefix stability).
 */
export function buildPromptMessages(
  frame: PromptFrame,
  conversationMessages: Array<{ role: string; content: unknown }>,
): Array<{ role: string; content: unknown }> {
  let prefixContent = frame.stablePrefix;
  if (frame.projectContext) {
    prefixContent += "\n" + frame.projectContext;
  }

  const volatileParts: string[] = [];
  if (frame.volatileAdapter) volatileParts.push(frame.volatileAdapter);
  if (frame.workingFrame) volatileParts.push(frame.workingFrame);
  if (frame.structuralCritic) volatileParts.push(frame.structuralCritic);
  if (frame.projectManifest) volatileParts.push(frame.projectManifest);
  if (frame.structuralIndex) volatileParts.push(frame.structuralIndex);
  if (frame.fileSummary) volatileParts.push(frame.fileSummary);
  if (frame.verificationPlan) volatileParts.push(frame.verificationPlan);
  for (const em of frame.extendedMemoryBlocks) {
    if (em.trim()) volatileParts.push(em);
  }
  if (frame.responseStyle) volatileParts.push(frame.responseStyle);
  for (const g of frame.governanceBlocks) {
    if (g.trim()) volatileParts.push(g);
  }
  if (frame.intentGate) volatileParts.push(frame.intentGate);
  volatileParts.push(frame.toolEfficiency);

  const volatileContent = volatileParts.join(VOLATILE_SEPARATOR);

  return [
    { role: "system", content: prefixContent },
    ...(volatileContent ? [{ role: "system" as const, content: volatileContent }] : []),
    ...conversationMessages,
  ];
}

/**
 * Compute a concatenated string for volatile hash comparison.
 * Used to detect whether the volatile portion changed across turns.
 */
export function computeVolatileFingerprint(frame: PromptFrame): string {
  const parts: string[] = [];
  if (frame.volatileAdapter) parts.push(frame.volatileAdapter);
  if (frame.workingFrame) parts.push(frame.workingFrame);
  if (frame.structuralCritic) parts.push(frame.structuralCritic);
  if (frame.projectManifest) parts.push(frame.projectManifest);
  if (frame.structuralIndex) parts.push(frame.structuralIndex);
  if (frame.fileSummary) parts.push(frame.fileSummary);
  if (frame.verificationPlan) parts.push(frame.verificationPlan);
  for (const em of frame.extendedMemoryBlocks) {
    if (em.trim()) parts.push(em);
  }
  if (frame.responseStyle) parts.push(frame.responseStyle);
  for (const g of frame.governanceBlocks) {
    if (g.trim()) parts.push(g);
  }
  if (frame.intentGate) parts.push(frame.intentGate);
  parts.push(frame.toolEfficiency);
  return parts.join(VOLATILE_SEPARATOR);
}
