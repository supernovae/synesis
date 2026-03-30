export {
  TrustLevel,
  SourceType,
  ContentPurpose,
  AuthorityTier,
  ReviewStatus,
  IngestScanStatus,
  PolicyDecision,
  RetrievalChannel,
  AttributionV1,
  TrustPacketV1,
  SemiTrustedPacketV1,
  serializeStableJson,
  parseTrustPacket,
  makeTrustedControl,
  makeUntrusted,
  makeUntrustedEvidence,
  makeSemiTrusted,
} from "./trust-packet.js";

export {
  sanitize,
  estimateImperativeLikelihood,
  type SanitizeResult,
} from "./content-sanitizer.js";

export {
  normalizeConfusables,
  stripZeroWidth,
  normalizeForScan,
  detectBase64Payloads,
} from "./normalizer.js";

export {
  scanText,
  scanWebContent,
  scanModelOutput,
  redactPatterns,
  scanUserInput,
  type EventType,
  type ScanResult,
} from "./scanner.js";

export {
  TRUST_POLICY,
  TRUST_POLICY_COMPACT,
  SANDWICH_REMINDER,
  HIGH_STAKES_FLOOR,
  authorityDatamark,
} from "./operational-policy.js";

export {
  scanResultToPayload,
  policyRejectToPayload,
  emitSecurityEvent,
  type SecurityIngestPayload,
  type SecurityIngestConfig,
} from "./security-ingest.js";

export {
  freshnessScore,
  freshnessBoost,
  FRESHNESS_HALF_LIFE_DAYS,
  type FreshnessBoostable,
} from "./freshness-scoring.js";
