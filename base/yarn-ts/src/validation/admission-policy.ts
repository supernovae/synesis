import type { ArtifactStore } from "../state/artifact-store.js";
import type { AdmissionPolicyConfig, AdmissionPolicyResult, ValidationEnvelope } from "./types.js";

function modelMetadataText(value: unknown, maxChars = 1000): string {
  return replaceControlCharsWithSpace(String(value ?? ""))
    .replace(/[<>"'`&]/g, "_")
    .replace(/=/g, ":")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
    .trim();
}

function replaceControlCharsWithSpace(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? " " : value[i];
  }
  return out;
}

export function applyAdmissionPolicy(
  envelope: ValidationEnvelope,
  rawOutput: string,
  config: AdmissionPolicyConfig,
  artifactStore: ArtifactStore
): AdmissionPolicyResult {
  let contentForModel = envelope.summary;
  let usedArtifactHandle = false;
  let droppedChars = 0;
  const shouldHandle = rawOutput.length > config.maxRawChars || envelope.findings.length > config.maxFindings;

  if (shouldHandle) {
    const artifact = artifactStore.putValidationOutput(rawOutput);
    envelope.artifactHandle = artifact.id;
    envelope.truncated = true;
    droppedChars = Math.max(0, rawOutput.length - envelope.summary.length);
    contentForModel = [
      envelope.summary,
      `artifact_handle: ${modelMetadataText(artifact.id, 128)}`,
      `artifact_preview: ${modelMetadataText(artifact.preview, 1000)}`
    ].join("\n");
    usedArtifactHandle = true;
  } else if (config.includeRaw && rawOutput.trim()) {
    contentForModel = `${envelope.summary}\nraw_excerpt: ${modelMetadataText(rawOutput, config.maxRawChars)}`;
  }

  return {
    contentForModel,
    envelope,
    droppedChars,
    usedArtifactHandle
  };
}
