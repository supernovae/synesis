import type { AppConfig } from "../config.js";
import { ArtifactStore } from "../state/artifact-store.js";
import { applyAdmissionPolicy } from "./admission-policy.js";
import {
  normalizeValidationOutput,
  normalizeValidationOutputWithTierC,
  type TierCFallbackContext,
  type TierCFallbackResult,
} from "./normalizer.js";

export interface MessageLike {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
}

export interface NormalizationStats {
  rawCharsTotal: number;
  normalizedCharsTotal: number;
  findingsTotal: number;
  tokensSavedEstimateTotal: number;
  artifactHandleCount: number;
  admissionDroppedCount: number;
  normalizedMessageCount: number;
  tierCAttemptCount: number;
  tierCSuccessCount: number;
  tierCFallbackCount: number;
  tierCErrorCount: number;
}

export interface NormalizationResult {
  messages: MessageLike[];
  normalizedCount: number;
}

const VALIDATION_TOOL_HINTS = [
  "ruff", "eslint", "tsc", "typescript", "pytest", "mypy", "pylint",
  "jest", "cargo", "clippy", "rustc", "golangci", "tfsec", "trivy",
  "semgrep", "checkstyle", "detekt", "swiftlint", "phpcs",
  "terraform", "tf_validate", "tofu"
];

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ValidationNormalizationService {
  private readonly stats: NormalizationStats = {
    rawCharsTotal: 0,
    normalizedCharsTotal: 0,
    findingsTotal: 0,
    tokensSavedEstimateTotal: 0,
    artifactHandleCount: 0,
    admissionDroppedCount: 0,
    normalizedMessageCount: 0,
    tierCAttemptCount: 0,
    tierCSuccessCount: 0,
    tierCFallbackCount: 0,
    tierCErrorCount: 0,
  };

  constructor(
    private readonly config: AppConfig,
    private readonly artifactStore: ArtifactStore = new ArtifactStore()
  ) {}

  normalizeMessages(messages: MessageLike[]): NormalizationResult {
    let normalizedCount = 0;
    const out = messages.map((m) => {
      if (typeof m.content !== "string") return m;
      if (!this.shouldNormalize(m.name, m.content)) return m;

      const envelope = normalizeValidationOutput({
        toolName: m.name,
        rawOutput: m.content,
        maxFindings: this.config.SYNESIS_YARN_VALIDATION_MAX_FINDINGS,
        maxExcerptChars: 280
      });
      if (envelope.findings.length === 0) {
        if (typeof m.content === "string" && m.content.length > this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS) {
          // Let admission policy truncate it to an artifact handle
        } else {
          return m;
        }
      }
      const decision = applyAdmissionPolicy(
        envelope,
        m.content,
        {
          maxRawChars: this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS,
          maxFindings: this.config.SYNESIS_YARN_VALIDATION_MAX_FINDINGS,
          includeRaw: this.config.SYNESIS_YARN_VALIDATION_INCLUDE_RAW
        },
        this.artifactStore
      );

      this.stats.rawCharsTotal += envelope.rawChars;
      this.stats.normalizedCharsTotal += decision.contentForModel.length;
      this.stats.findingsTotal += envelope.findings.length;
      this.stats.tokensSavedEstimateTotal += Math.max(0, estimateTokens(m.content) - estimateTokens(decision.contentForModel));
      this.stats.admissionDroppedCount += decision.droppedChars > 0 ? 1 : 0;
      this.stats.artifactHandleCount += decision.usedArtifactHandle ? 1 : 0;
      this.stats.normalizedMessageCount += 1;
      normalizedCount += 1;

      return {
        ...m,
        content: decision.contentForModel
      };
    });

    return { messages: out, normalizedCount };
  }

  async normalizeMessagesAsync(
    messages: MessageLike[],
    tierCFallback?: (ctx: TierCFallbackContext) => Promise<TierCFallbackResult | null>,
  ): Promise<NormalizationResult> {
    let normalizedCount = 0;
    const out: MessageLike[] = [];
    for (const m of messages) {
      if (typeof m.content !== "string" || !this.shouldNormalize(m.name, m.content)) {
        out.push(m);
        continue;
      }
      const input = {
        toolName: m.name,
        rawOutput: m.content,
        maxFindings: this.config.SYNESIS_YARN_VALIDATION_MAX_FINDINGS,
        maxExcerptChars: 280,
      };
      let envelope;
      if (this.config.SYNESIS_YARN_VALIDATION_TIER_C_ENABLED && tierCFallback) {
        this.stats.tierCAttemptCount += 1;
        try {
          const base = normalizeValidationOutput(input);
          envelope = await normalizeValidationOutputWithTierC(input, {
            enabled: true,
            fallback: tierCFallback,
          });
          if (envelope.summary !== base.summary) {
            this.stats.tierCSuccessCount += 1;
          } else {
            this.stats.tierCFallbackCount += 1;
          }
        } catch {
          this.stats.tierCErrorCount += 1;
          envelope = normalizeValidationOutput(input);
        }
      } else {
        envelope = normalizeValidationOutput(input);
      }
      if (envelope.findings.length === 0) {
        if (typeof m.content === "string" && m.content.length > this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS) {
          // Let admission policy truncate it to an artifact handle
        } else {
          out.push(m);
          continue;
        }
      }
      const decision = applyAdmissionPolicy(
        envelope,
        m.content,
        {
          maxRawChars: this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS,
          maxFindings: this.config.SYNESIS_YARN_VALIDATION_MAX_FINDINGS,
          includeRaw: this.config.SYNESIS_YARN_VALIDATION_INCLUDE_RAW,
        },
        this.artifactStore,
      );

      this.stats.rawCharsTotal += envelope.rawChars;
      this.stats.normalizedCharsTotal += decision.contentForModel.length;
      this.stats.findingsTotal += envelope.findings.length;
      this.stats.tokensSavedEstimateTotal += Math.max(0, estimateTokens(m.content) - estimateTokens(decision.contentForModel));
      this.stats.admissionDroppedCount += decision.droppedChars > 0 ? 1 : 0;
      this.stats.artifactHandleCount += decision.usedArtifactHandle ? 1 : 0;
      this.stats.normalizedMessageCount += 1;
      normalizedCount += 1;

      out.push({
        ...m,
        content: decision.contentForModel,
      });
    }
    return { messages: out, normalizedCount };
  }

  private _savedCheckpoint = 0;

  /** Returns estimated tokens saved since the last call (per-request delta). */
  getPerRequestDelta(): number {
    const current = this.stats.tokensSavedEstimateTotal;
    const delta = current - this._savedCheckpoint;
    this._savedCheckpoint = current;
    return Math.max(0, delta);
  }

  getStats(): NormalizationStats {
    return { ...this.stats };
  }

  getArtifact(id: string) {
    return this.artifactStore.get(id);
  }

  private shouldNormalize(toolName: string | undefined, content: string): boolean {
    const name = (toolName ?? "").toLowerCase();
    
    // Never treat file operations or search tools as validation output.
    // ToolResultReductionService will handle them if they are too large.
    if (
      name === "read" || 
      name === "write" || 
      name === "edit" || 
      name === "update" || 
      name === "glob" || 
      name === "read_file" || 
      name === "search_files" ||
      name === "synesis_code_search" ||
      name === "synesis_docs_search" ||
      name === "synesis_config_search" ||
      name === "synesis_knowledge_search" ||
      name === "synesis_web_search" ||
      name === "synesis_artifact_retrieve"
    ) {
      return false;
    }

    if (VALIDATION_TOOL_HINTS.some((h) => name.includes(h))) return true;
    if (content.length >= this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS) return true;

    // Detect structured formats (SARIF, JUnit, Checkstyle, JSON diagnostics)
    const trimmed = content.trimStart();
    if (trimmed.startsWith("<testsuite") || trimmed.startsWith("<testsuites") || trimmed.startsWith("<checkstyle")) {
      return true;
    }
    if (trimmed.includes('"$schema"') && trimmed.includes("sarif")) return true;
    if (trimmed.includes('"runs"') && trimmed.includes('"results"')) return true;

    const lower = content.toLowerCase();
    if (lower.includes("error ts") || lower.includes("eslint") || lower.includes("ruff")) {
      return true;
    }
    // More specific test failure patterns instead of just "failed"
    if (
      content.includes("FAIL:") || 
      content.includes("FAILED") || 
      content.includes("FAILURES") || 
      content.includes("E       assert") ||
      (content.includes("--- FAIL:") && content.includes(".go:"))
    ) {
      return true;
    }
    // Terraform validate text pattern: "Error: ... on file.tf line N"
    if (lower.includes("error:") && lower.includes(" on ") && lower.includes(" line ")) return true;
    return false;
  }
}
