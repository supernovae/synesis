import {
  DEFAULT_STATE_TRANSITION_QUALITY_THRESHOLDS,
  calibrateStateTransitionQualityThresholds,
  type StateTransitionCalibrationSample,
  type StateTransitionQualityCalibrationReport,
  type StateTransitionQualityThresholds,
} from "./state-transition-ledger.js";

type Scope = "org_model" | "model";

interface Bucket {
  samples: StateTransitionCalibrationSample[];
  thresholds: StateTransitionQualityThresholds;
  updatedAt: number;
}

export interface GlobalThresholdResolution {
  selected_scope: Scope | "none";
  selected_thresholds: StateTransitionQualityThresholds;
  org_model_sample_count: number;
  model_sample_count: number;
}

export interface GlobalCalibrationObservation {
  resolution: GlobalThresholdResolution;
  org_model_calibration: StateTransitionQualityCalibrationReport;
  model_calibration: StateTransitionQualityCalibrationReport;
}

export interface StateTransitionGlobalCalibratorOptions {
  maxBuckets?: number;
  maxSamplesPerBucket?: number;
  minSamples?: number;
  minPositive?: number;
  minNegative?: number;
  smoothing?: number;
  activationSampleCount?: number;
}

const DEFAULT_OPTIONS: Required<StateTransitionGlobalCalibratorOptions> = {
  maxBuckets: 256,
  maxSamplesPerBucket: 128,
  minSamples: 16,
  minPositive: 4,
  minNegative: 4,
  smoothing: 0.45,
  activationSampleCount: 16,
};

function normalizeScopeKey(scope: Scope, orgId: string, modelId: string): string {
  const normalizedOrg = (orgId || "unknown").trim().toLowerCase().slice(0, 120);
  const normalizedModel = (modelId || "unknown").trim().toLowerCase().slice(0, 180);
  if (scope === "org_model") {
    return `org_model:${normalizedOrg}:${normalizedModel}`;
  }
  return `model:${normalizedModel}`;
}

function cloneThresholds(input: StateTransitionQualityThresholds): StateTransitionQualityThresholds {
  return {
    forward_progress_min: input.forward_progress_min,
    regressed_max: input.regressed_max,
    minimum_gap: input.minimum_gap,
  };
}

export class StateTransitionGlobalCalibrator {
  private readonly options: Required<StateTransitionGlobalCalibratorOptions>;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: StateTransitionGlobalCalibratorOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
  }

  private ensureBucket(key: string, seedThresholds: StateTransitionQualityThresholds): Bucket {
    const existing = this.buckets.get(key);
    if (existing) return existing;
    const created: Bucket = {
      samples: [],
      thresholds: cloneThresholds(seedThresholds),
      updatedAt: Date.now(),
    };
    this.buckets.set(key, created);
    this.evictIfNeeded();
    return created;
  }

  private evictIfNeeded(): void {
    if (this.buckets.size <= this.options.maxBuckets) return;
    const candidates = [...this.buckets.entries()]
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const overshoot = this.buckets.size - this.options.maxBuckets;
    for (let i = 0; i < overshoot; i += 1) {
      const victim = candidates[i];
      if (!victim) break;
      this.buckets.delete(victim[0]);
    }
  }

  private calibrateScope(
    scope: Scope,
    orgId: string,
    modelId: string,
    sample: StateTransitionCalibrationSample,
    fallbackThresholds: StateTransitionQualityThresholds,
  ): StateTransitionQualityCalibrationReport {
    const key = normalizeScopeKey(scope, orgId, modelId);
    const bucket = this.ensureBucket(key, fallbackThresholds);
    bucket.samples.push(sample);
    if (bucket.samples.length > this.options.maxSamplesPerBucket) {
      bucket.samples = bucket.samples.slice(-this.options.maxSamplesPerBucket);
    }
    const report = calibrateStateTransitionQualityThresholds({
      samples: bucket.samples,
      baseThresholds: bucket.thresholds,
      minSamples: this.options.minSamples,
      minPositive: this.options.minPositive,
      minNegative: this.options.minNegative,
      smoothing: this.options.smoothing,
    });
    if (report.applied) {
      bucket.thresholds = cloneThresholds(report.calibrated_thresholds);
    }
    bucket.updatedAt = Date.now();
    return report;
  }

  private getScopeThresholds(
    scope: Scope,
    orgId: string,
    modelId: string,
  ): { thresholds: StateTransitionQualityThresholds; sampleCount: number } | null {
    const key = normalizeScopeKey(scope, orgId, modelId);
    const bucket = this.buckets.get(key);
    if (!bucket) return null;
    return {
      thresholds: cloneThresholds(bucket.thresholds),
      sampleCount: bucket.samples.length,
    };
  }

  resolveThresholds(input: {
    orgId: string;
    modelId: string;
    fallbackThresholds?: StateTransitionQualityThresholds;
  }): GlobalThresholdResolution {
    const fallback = input.fallbackThresholds
      ? cloneThresholds(input.fallbackThresholds)
      : cloneThresholds(DEFAULT_STATE_TRANSITION_QUALITY_THRESHOLDS);
    const orgModel = this.getScopeThresholds("org_model", input.orgId, input.modelId);
    const model = this.getScopeThresholds("model", input.orgId, input.modelId);
    const activation = this.options.activationSampleCount;

    if (orgModel && orgModel.sampleCount >= activation) {
      return {
        selected_scope: "org_model",
        selected_thresholds: orgModel.thresholds,
        org_model_sample_count: orgModel.sampleCount,
        model_sample_count: model?.sampleCount ?? 0,
      };
    }
    if (model && model.sampleCount >= activation) {
      return {
        selected_scope: "model",
        selected_thresholds: model.thresholds,
        org_model_sample_count: orgModel?.sampleCount ?? 0,
        model_sample_count: model.sampleCount,
      };
    }
    if (orgModel && (!model || orgModel.sampleCount >= model.sampleCount)) {
      return {
        selected_scope: "org_model",
        selected_thresholds: orgModel.thresholds,
        org_model_sample_count: orgModel.sampleCount,
        model_sample_count: model?.sampleCount ?? 0,
      };
    }
    if (model) {
      return {
        selected_scope: "model",
        selected_thresholds: model.thresholds,
        org_model_sample_count: orgModel?.sampleCount ?? 0,
        model_sample_count: model.sampleCount,
      };
    }
    return {
      selected_scope: "none",
      selected_thresholds: fallback,
      org_model_sample_count: 0,
      model_sample_count: 0,
    };
  }

  observeAndCalibrate(input: {
    orgId: string;
    modelId: string;
    sample: StateTransitionCalibrationSample;
    fallbackThresholds?: StateTransitionQualityThresholds;
  }): GlobalCalibrationObservation {
    const fallback = input.fallbackThresholds
      ? cloneThresholds(input.fallbackThresholds)
      : cloneThresholds(DEFAULT_STATE_TRANSITION_QUALITY_THRESHOLDS);
    const orgModelCalibration = this.calibrateScope(
      "org_model",
      input.orgId,
      input.modelId,
      input.sample,
      fallback,
    );
    const modelCalibration = this.calibrateScope(
      "model",
      input.orgId,
      input.modelId,
      input.sample,
      fallback,
    );
    return {
      resolution: this.resolveThresholds({
        orgId: input.orgId,
        modelId: input.modelId,
        fallbackThresholds: fallback,
      }),
      org_model_calibration: orgModelCalibration,
      model_calibration: modelCalibration,
    };
  }
}
