# Intent Weights Plugins

Drop industry-specific "Rules of Law" YAML files here. Synesis absorbs them at startup.

## Format (v3)

Use `complexity_weights`, `risk_weights`, and `domain_keywords`. Domain never escalates complexity.

### complexity_weights

Steps, scope, technical complexity. Single category capped ~10.

```yaml
complexity_weights:
  interop_standards:
    weight: 12
    keywords: ["hl7", "fhir", "emr", "ehr"]
```

### risk_weights

Destructive ops, secrets, compliance. Can veto trivial → complex.

```yaml
risk_weights:
  phi_identifiers:
    weight: 15
    domain: healthcare_compliance
    keywords: ["phi", "patient", "hipaa"]
```

### domain_keywords

RAG gravity only. Never contributes to score.

```yaml
domain_keywords:
  healthcare_systems:
    domain: healthcare_compliance
    keywords: ["epic", "cerner", "meditech"]
```

### pairings

```yaml
pairings:
  - keywords: ["phi", "public"]
    extra_weight: 40
    axis: risk   # or complexity
  - keywords: ["cluster", "pod"]
    domain: kubernetes
    extra_weight: 0   # domain-only, no score
```

## Merge Rules

- **complexity_weights / risk_weights / domain_keywords**: Later plugins override same category names.
- **pairings**: Append (plugins add risk multipliers + domain disambiguators).
- **overrides**: Per-key merge.
- **thresholds**: Later overrides.

## Sovereign Intersection

When two high-gravity verticals are detected (e.g. HIPAA + K8s), both domains are tracked. The Context Curator retrieves RAG from both indices.

## Example Plugins

| Plugin | Focus |
|--------|-------|
| `domain_protocols.yaml` | Fediverse, ActivityPub, OAuth, gRPC — protocol triggers escalate to Planner |
| `compliance_healthcare.yaml` | PHI identifiers, HL7/FHIR/DICOM interop, Epic/Cerner — phi+public escalation |
| `compliance_fintech.yaml` | Ledger, PCI-DSS, SOX, KYC/AML — Four-Eyes on ledger updates, PCI+s3 |
| `secops_hardening.yaml` | FIPS, CIS-benchmark, STIGs, SELinux — selinux+disable hard block |
| `ai_governance.yaml` | LLM safety, bias, hallucination, Blackwell/GPU — hallucination+audit escalation |
| `domain_audio_synthesis.yaml` | Oscillators, LFO, modular, DAW, latency — audio synthesis & routing |
| `domain_running.yaml` | VO2max, biomechanics, marathon taper — injury+pain medical advisory |
| `domain_disambiguation.yaml` | Composite triggers (cluster+pod, cluster+patient) |
| `domain_protocols.yaml` | Fediverse, ActivityPub, OAuth, gRPC — sovereign veto to Planner |
