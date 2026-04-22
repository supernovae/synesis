import { describe, expect, it } from "vitest";

import {
  StateTransitionGlobalCalibrator,
} from "../src/governance/state-transition-global-calibrator.js";

import type {
  StateTransitionCalibrationSample,
  StateTransitionQualityThresholds,
} from "../src/governance/state-transition-ledger.js";

function sample(overrides: Partial<StateTransitionCalibrationSample> = {}): StateTransitionCalibrationSample {
  return {
    quality_score: 0.2,
    outcome_state: "partial",
    evidence_delta: "changed",
    governor_pause: false,
    needs_reground: false,
    ...overrides,
  };
}

async function waitForAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("state transition global calibrator", () => {
  it("falls back when no global history exists", () => {
    const calibrator = new StateTransitionGlobalCalibrator();
    const fallback: StateTransitionQualityThresholds = {
      forward_progress_min: 0.2,
      regressed_max: -0.35,
      minimum_gap: 0.08,
    };
    const resolution = calibrator.resolveThresholds({
      orgId: "org-a",
      modelId: "synesis-core",
      fallbackThresholds: fallback,
    });

    expect(resolution.selected_scope).toBe("none");
    expect(resolution.selected_thresholds.forward_progress_min).toBe(0.2);
    expect(resolution.org_model_sample_count).toBe(0);
    expect(resolution.model_sample_count).toBe(0);
  });

  it("tracks global samples and resolves org/model scope thresholds", () => {
    const calibrator = new StateTransitionGlobalCalibrator({
      minSamples: 6,
      minPositive: 2,
      minNegative: 2,
      activationSampleCount: 6,
      smoothing: 0.6,
    });
    const orgId = "org-demo";
    const modelId = "synesis-core";

    const samples: StateTransitionCalibrationSample[] = [
      sample({ quality_score: 0.75, outcome_state: "verified", evidence_delta: "improved" }),
      sample({ quality_score: 0.66, outcome_state: "verified", evidence_delta: "improved" }),
      sample({ quality_score: 0.59, outcome_state: "completed", evidence_delta: "changed" }),
      sample({ quality_score: -0.62, outcome_state: "stalled", evidence_delta: "regressed", governor_pause: true }),
      sample({ quality_score: -0.5, outcome_state: "stalled", evidence_delta: "stalled", governor_pause: true }),
      sample({ quality_score: -0.4, outcome_state: "partial", evidence_delta: "regressed" }),
    ];

    let applied = false;
    for (const row of samples) {
      const observation = calibrator.observeAndCalibrate({
        orgId,
        modelId,
        sample: row,
      });
      applied ||= observation.org_model_calibration.applied || observation.model_calibration.applied;
    }

    const resolution = calibrator.resolveThresholds({ orgId, modelId });
    expect(applied).toBe(true);
    expect(resolution.selected_scope).toBe("org_model");
    expect(resolution.org_model_sample_count).toBe(6);
    expect(resolution.selected_thresholds.forward_progress_min).toBeGreaterThan(0.2);
  });

  it("shares model-scope calibrations across orgs", () => {
    const calibrator = new StateTransitionGlobalCalibrator({
      minSamples: 4,
      minPositive: 2,
      minNegative: 2,
      activationSampleCount: 4,
      smoothing: 0.5,
    });
    const modelId = "synesis-core";

    const trainingRows: StateTransitionCalibrationSample[] = [
      sample({ quality_score: 0.7, outcome_state: "verified", evidence_delta: "improved" }),
      sample({ quality_score: 0.55, outcome_state: "verified", evidence_delta: "changed" }),
      sample({ quality_score: -0.58, outcome_state: "stalled", evidence_delta: "regressed", governor_pause: true }),
      sample({ quality_score: -0.46, outcome_state: "partial", evidence_delta: "regressed" }),
    ];
    for (const row of trainingRows) {
      calibrator.observeAndCalibrate({
        orgId: "org-one",
        modelId,
        sample: row,
      });
    }

    const otherOrgResolution = calibrator.resolveThresholds({
      orgId: "org-two",
      modelId,
    });
    expect(otherOrgResolution.model_sample_count).toBeGreaterThanOrEqual(4);
    expect(otherOrgResolution.selected_scope).toBe("model");
  });

  it("hydrates and persists through shared backing store", async () => {
    const store = new Map<string, Record<string, unknown>>();
    store.set("org_model:org-a:synesis-core", {
      schema_version: "state_transition_global_scope_v1",
      scope: "org_model",
      scope_key: "org_model:org-a:synesis-core",
      thresholds: {
        forward_progress_min: 0.31,
        regressed_max: -0.41,
        minimum_gap: 0.08,
      },
      sample_count: 24,
      updated_at: Date.now(),
    });

    const calibrator = new StateTransitionGlobalCalibrator({
      backingStoreRefreshMs: 0,
      backingStorePersistMs: 0,
      backingStore: {
        readScope: async (scopeKey) => store.get(scopeKey) ?? null,
        writeScope: async (scopeKey, payload) => {
          store.set(scopeKey, payload);
          return true;
        },
      },
      minSamples: 4,
      minPositive: 2,
      minNegative: 2,
      activationSampleCount: 4,
    });

    // First resolve triggers async hydration.
    calibrator.resolveThresholds({
      orgId: "org-a",
      modelId: "synesis-core",
    });
    await waitForAsyncWork();

    const resolvedAfterHydrate = calibrator.resolveThresholds({
      orgId: "org-a",
      modelId: "synesis-core",
    });
    expect(resolvedAfterHydrate.selected_scope).toBe("org_model");
    expect(resolvedAfterHydrate.selected_thresholds.forward_progress_min).toBe(0.31);
    expect(resolvedAfterHydrate.org_model_sample_count).toBe(24);

    calibrator.observeAndCalibrate({
      orgId: "org-a",
      modelId: "synesis-core",
      sample: sample({ quality_score: 0.74, outcome_state: "verified", evidence_delta: "improved" }),
    });
    await waitForAsyncWork();

    const persisted = store.get("org_model:org-a:synesis-core");
    expect(persisted).toBeDefined();
    expect(typeof persisted?.sample_count).toBe("number");
    expect(persisted?.thresholds).toBeDefined();
  });
});
