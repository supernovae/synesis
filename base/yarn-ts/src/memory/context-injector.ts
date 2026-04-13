/**
 * Context Injector — wires the extended memory layer into the request pipeline.
 *
 * Produces system context blocks for injection into the model's prompt:
 *   - Structural index (repo map) for project navigation
 *   - Chunked eval phase context when in multi-pass evaluation mode
 *   - Summary augmentation for file reads
 */

import type { AppConfig } from "../config.js";
import type { ChunkedEvalPlan, StructuralIndex } from "./types.js";
import type { MemoryGovernorSignals } from "./governor-integration.js";
import { renderStructuralMap, type RenderOptions } from "./structural-index.js";
import { renderGoDocMap } from "./go-doc-index.js";
import { formatEvalProgress } from "./chunked-eval.js";

export interface ContextInjectorInput {
  structuralIndex: StructuralIndex | null;
  goDocOutput: string | null;
  evalPlan: ChunkedEvalPlan | null;
  recentFiles: string[];
  projectLanguage: string;
  memorySignals: MemoryGovernorSignals;
}

export interface InjectedContext {
  blocks: string[];
  totalTokenEstimate: number;
}

const CHARS_PER_TOKEN = 4;

/**
 * Generate all extended memory system context blocks for a request.
 * Returns blocks in injection order (structural index first, eval progress last).
 */
export function generateExtendedMemoryContext(
  config: AppConfig,
  input: ContextInjectorInput,
): InjectedContext {
  const blocks: string[] = [];
  let totalChars = 0;

  if (config.SYNESIS_YARN_STRUCTURAL_INDEX_ENABLED && input.structuralIndex) {
    const opts: RenderOptions = {
      tokenBudget: config.SYNESIS_YARN_STRUCTURAL_INDEX_TOKEN_BUDGET,
      recentFiles: input.recentFiles,
    };
    const map = renderStructuralMap(input.structuralIndex, opts);
    blocks.push(map);
    totalChars += map.length;
  } else if (
    config.SYNESIS_YARN_GO_DOC_REPOMAP_ENABLED
    && input.goDocOutput
    && input.projectLanguage === "go"
  ) {
    const map = renderGoDocMap(
      input.goDocOutput,
      config.SYNESIS_YARN_STRUCTURAL_INDEX_TOKEN_BUDGET,
    );
    blocks.push(map);
    totalChars += map.length;
  }

  if (config.SYNESIS_YARN_CHUNKED_EVAL_ENABLED && input.evalPlan) {
    const progress = formatEvalProgress(input.evalPlan);
    blocks.push(progress);
    totalChars += progress.length;
  }

  if (config.SYNESIS_YARN_MEMORY_TOOLS_ENABLED && input.memorySignals.findingsStoreSize > 0) {
    const hint = `<MEMORY_HINT findings="${input.memorySignals.findingsStoreSize}">You have ${input.memorySignals.findingsStoreSize} stored observations. Use RecallFindings to retrieve them instead of re-reading files.</MEMORY_HINT>`;
    blocks.push(hint);
    totalChars += hint.length;
  }

  return {
    blocks,
    totalTokenEstimate: Math.ceil(totalChars / CHARS_PER_TOKEN),
  };
}
