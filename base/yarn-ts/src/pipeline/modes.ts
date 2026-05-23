import type { AppConfig } from "../config.js";
import type { PipelineMode } from "./types.js";

const PIPELINE_MODES: readonly PipelineMode[] = ["raw", "compat", "optimized", "governed", "workflow"];

export interface PipelineModeResolution {
  mode: PipelineMode;
  source: "header" | "body" | "config" | "default";
  explicit: boolean;
  requested?: string;
  valid: boolean;
}

export interface PipelineModeResolverInput {
  headers?: Record<string, unknown> | null;
  body?: Record<string, unknown> | null;
  config?: Partial<AppConfig> & { SYNESIS_YARN_PIPELINE_MODE?: string };
}

export function isPipelineMode(value: unknown): value is PipelineMode {
  return typeof value === "string" && (PIPELINE_MODES as readonly string[]).includes(value.trim().toLowerCase());
}

export function resolvePipelineMode(input: PipelineModeResolverInput = {}): PipelineModeResolution {
  const headerValue = firstHeaderValue(input.headers, "x-synesis-mode");
  const bodyValue = modeFromBody(input.body);
  const configValue = typeof input.config?.SYNESIS_YARN_PIPELINE_MODE === "string"
    ? input.config.SYNESIS_YARN_PIPELINE_MODE
    : undefined;

  const candidate =
    headerValue ? { value: headerValue, source: "header" as const }
      : bodyValue ? { value: bodyValue, source: "body" as const }
        : configValue ? { value: configValue, source: "config" as const }
          : null;

  if (!candidate) {
    return { mode: "governed", source: "default", explicit: false, valid: true };
  }

  const normalized = candidate.value.trim().toLowerCase();
  if (isPipelineMode(normalized)) {
    return {
      mode: normalized,
      source: candidate.source,
      explicit: candidate.source !== "config",
      requested: candidate.value,
      valid: true,
    };
  }

  return {
    mode: "governed",
    source: candidate.source,
    explicit: candidate.source !== "config",
    requested: candidate.value,
    valid: false,
  };
}

export function shouldRunGovernorForMode(mode: PipelineMode): boolean {
  return mode !== "raw" && mode !== "compat";
}

export function shouldRunHeavyEnrichmentForMode(mode: PipelineMode): boolean {
  return mode !== "raw";
}

function firstHeaderValue(headers: Record<string, unknown> | null | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    if (Array.isArray(value)) {
      const first = value.find((v) => typeof v === "string" && v.trim());
      return typeof first === "string" ? first : undefined;
    }
    return typeof value === "string" && value.trim() ? value : undefined;
  }
  return undefined;
}

function modeFromBody(body: Record<string, unknown> | null | undefined): string | undefined {
  if (!body) return undefined;
  const direct = body.synesis_mode ?? body.pipeline_mode;
  if (typeof direct === "string" && direct.trim()) return direct;
  const metadata = body.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const metaMode = (metadata as Record<string, unknown>).synesis_mode
    ?? (metadata as Record<string, unknown>).pipeline_mode;
  return typeof metaMode === "string" && metaMode.trim() ? metaMode : undefined;
}
