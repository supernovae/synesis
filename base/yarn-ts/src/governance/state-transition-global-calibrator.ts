import {
  DEFAULT_STATE_TRANSITION_QUALITY_THRESHOLDS,
  calibrateStateTransitionQualityThresholds,
  decodeStateTransitionQualityThresholds,
  encodeStateTransitionQualityThresholds,
  type StateTransitionCalibrationSample,
  type StateTransitionQualityCalibrationReport,
  type StateTransitionQualityThresholds,
} from "./state-transition-ledger.js";

type Scope = "org_model" | "model";

interface Bucket {
  samples: StateTransitionCalibrationSample[];
  thresholds: StateTransitionQualityThresholds;
  sampleCount: number;
  updatedAt: number;
  lastHydratedAt: number;
  lastPersistedAt: number;
}

interface ScopeRefreshState {
  lastRequestedAt: number;
  inflight: boolean;
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
  backingStoreRefreshMs?: number;
  backingStorePersistMs?: number;
  backingStore?: StateTransitionGlobalCalibrationBackingStore | null;
}

export interface StateTransitionGlobalCalibrationBackingStore {
  readScope(scopeKey: string): Promise<Record<string, unknown> | null>;
  writeScope(scopeKey: string, payload: Record<string, unknown>): Promise<boolean | void>;
}

interface PersistedScopePayload {
  schema_version: "state_transition_global_scope_v1";
  scope: Scope;
  scope_key: string;
  thresholds: Record<string, unknown>;
  sample_count: number;
  updated_at: number;
}

interface ResolvedOptions {
  maxBuckets: number;
  maxSamplesPerBucket: number;
  minSamples: number;
  minPositive: number;
  minNegative: number;
  smoothing: number;
  activationSampleCount: number;
  backingStoreRefreshMs: number;
  backingStorePersistMs: number;
  backingStore: StateTransitionGlobalCalibrationBackingStore | null;
}

const DEFAULT_OPTIONS: ResolvedOptions = {
  maxBuckets: 256,
  maxSamplesPerBucket: 128,
  minSamples: 16,
  minPositive: 4,
  minNegative: 4,
  smoothing: 0.45,
  activationSampleCount: 16,
  backingStoreRefreshMs: 15_000,
  backingStorePersistMs: 5_000,
  backingStore: null,
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decodePersistedScopePayload(
  scope: Scope,
  scopeKey: string,
  raw: Record<string, unknown> | null,
): PersistedScopePayload | null {
  if (!raw) return null;
  const thresholdsRaw = asRecord(raw.thresholds);
  const thresholds = decodeStateTransitionQualityThresholds(thresholdsRaw);
  if (!thresholds) return null;
  return {
    schema_version: "state_transition_global_scope_v1",
    scope,
    scope_key: scopeKey,
    thresholds: encodeStateTransitionQualityThresholds(thresholds),
    sample_count: Math.max(0, Math.trunc(asNumber(raw.sample_count, 0))),
    updated_at: asNumber(raw.updated_at, Date.now()),
  };
}

export class StateTransitionGlobalCalibrator {
  private readonly options: ResolvedOptions;
  private readonly buckets = new Map<string, Bucket>();
  private readonly refreshStateByScope = new Map<string, ScopeRefreshState>();

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
      sampleCount: 0,
      updatedAt: Date.now(),
      lastHydratedAt: 0,
      lastPersistedAt: 0,
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
      this.refreshStateByScope.delete(victim[0]);
    }
  }

  private maybeRefreshScope(
    scope: Scope,
    orgId: string,
    modelId: string,
    fallbackThresholds: StateTransitionQualityThresholds,
  ): void {
    if (!this.options.backingStore) return;
    const scopeKey = normalizeScopeKey(scope, orgId, modelId);
    const now = Date.now();
    const refreshState = this.refreshStateByScope.get(scopeKey) ?? {
      lastRequestedAt: 0,
      inflight: false,
    };
    if (refreshState.inflight || (now - refreshState.lastRequestedAt) < this.options.backingStoreRefreshMs) {
      return;
    }
    refreshState.inflight = true;
    refreshState.lastRequestedAt = now;
    this.refreshStateByScope.set(scopeKey, refreshState);
    void this.options.backingStore.readScope(scopeKey)
      .then((raw) => {
        this.mergePersistedScope(scope, scopeKey, raw, fallbackThresholds);
      })
      .catch(() => {})
      .finally(() => {
        const state = this.refreshStateByScope.get(scopeKey);
        if (!state) return;
        state.inflight = false;
        this.refreshStateByScope.set(scopeKey, state);
      });
  }

  private mergePersistedScope(
    scope: Scope,
    scopeKey: string,
    raw: Record<string, unknown> | null,
    fallbackThresholds: StateTransitionQualityThresholds,
  ): void {
    const decoded = decodePersistedScopePayload(scope, scopeKey, raw);
    if (!decoded) return;
    const bucket = this.ensureBucket(scopeKey, fallbackThresholds);
    const decodedThresholds = decodeStateTransitionQualityThresholds(decoded.thresholds) ?? bucket.thresholds;
    if (decoded.updated_at >= bucket.updatedAt || decoded.sample_count > bucket.sampleCount) {
      bucket.thresholds = cloneThresholds(decodedThresholds);
    }
    bucket.sampleCount = Math.max(bucket.sampleCount, decoded.sample_count);
    bucket.updatedAt = Math.max(bucket.updatedAt, decoded.updated_at);
    bucket.lastHydratedAt = Date.now();
  }

  private maybePersistScope(
    scope: Scope,
    orgId: string,
    modelId: string,
    force = false,
  ): void {
    if (!this.options.backingStore) return;
    const scopeKey = normalizeScopeKey(scope, orgId, modelId);
    const bucket = this.buckets.get(scopeKey);
    if (!bucket) return;
    const now = Date.now();
    if (!force && (now - bucket.lastPersistedAt) < this.options.backingStorePersistMs) {
      return;
    }
    bucket.lastPersistedAt = now;
    const payload: PersistedScopePayload = {
      schema_version: "state_transition_global_scope_v1",
      scope,
      scope_key: scopeKey,
      thresholds: encodeStateTransitionQualityThresholds(bucket.thresholds),
      sample_count: bucket.sampleCount,
      updated_at: bucket.updatedAt,
    };
    void this.options.backingStore.writeScope(scopeKey, payload as unknown as Record<string, unknown>)
      .catch(() => {});
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
    bucket.sampleCount += 1;
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
      sampleCount: bucket.sampleCount,
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
    this.maybeRefreshScope("org_model", input.orgId, input.modelId, fallback);
    this.maybeRefreshScope("model", input.orgId, input.modelId, fallback);
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
    this.maybeRefreshScope("org_model", input.orgId, input.modelId, fallback);
    this.maybeRefreshScope("model", input.orgId, input.modelId, fallback);
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
    const forcePersist = orgModelCalibration.applied || modelCalibration.applied;
    this.maybePersistScope("org_model", input.orgId, input.modelId, forcePersist);
    this.maybePersistScope("model", input.orgId, input.modelId, forcePersist);
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
