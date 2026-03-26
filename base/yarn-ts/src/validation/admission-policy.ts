import type { ArtifactStore } from "../state/artifact-store.js";
import type { AdmissionPolicyConfig, AdmissionPolicyResult, ValidationEnvelope } from "./types.js";

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
      `artifact_handle=${artifact.id}`,
      `artifact_preview=${artifact.preview}`
    ].join("\n");
    usedArtifactHandle = true;
  } else if (config.includeRaw && rawOutput.trim()) {
    contentForModel = `${envelope.summary}\nraw_excerpt=${rawOutput.slice(0, config.maxRawChars)}`;
  }

  return {
    contentForModel,
    envelope,
    droppedChars,
    usedArtifactHandle
  };
}
