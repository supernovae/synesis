# Intent Weights Plugins

Drop industry-specific "Rules of Law" YAML files here. Synesis absorbs them at startup.

## Merge Rules

- **weights**: Later plugins override same category names.
- **pairings**: Append (plugins add risk multipliers + domain disambiguators).
- **overrides**: Per-key merge (force_manual, force_teach, etc.).
- **thresholds**: Later overrides.

## Format

### Weights (category + domain)

```yaml
weights:
  compliance_healthcare:
    weight: 25
    domain: healthcare_compliance   # When hit, add to active_domains for RAG
    keywords: ["phi", "hipaa", "hl7", "fhir", "emr", "phr", "ehr", "patient data", "pii health"]
```

### Pairings (risk multipliers)

```yaml
pairings:
  - keywords: ["delete", "database"]
    extra_weight: 15
```

### Domain Disambiguation (composite triggers)

Resolve ambiguous words via keyword combos. E.g. "cluster" alone is ambiguous; pair with context:

```yaml
pairings:
  - keywords: ["cluster", "pod"]
    domain: kubernetes      # K8s cluster
  - keywords: ["cluster", "patient"]
    domain: healthcare_compliance
  - keywords: ["cluster", "shard", "replica"]
    domain: databases
```

## Sovereign Intersection

When two high-gravity verticals are detected (e.g. HIPAA + K8s), both domains are tracked. The Context Curator retrieves RAG from both indices; the Critic audits K8s manifests for HIPAA "Least Privilege" violations.

## Example Plugins

| Plugin | Focus |
|--------|-------|
| `compliance_healthcare.yaml` | PHI identifiers, HL7/FHIR/DICOM interop, Epic/Cerner — phi+public escalation |
| `compliance_fintech.yaml` | Ledger, PCI-DSS, SOX, KYC/AML — Four-Eyes on ledger updates, PCI+s3 |
| `secops_hardening.yaml` | FIPS, CIS-benchmark, STIGs, SELinux — selinux+disable hard block |
| `ai_governance.yaml` | LLM safety, bias, hallucination, Blackwell/GPU — hallucination+audit escalation |
| `domain_audio_synthesis.yaml` | Oscillators, LFO, modular, DAW, latency — audio synthesis & routing |
| `domain_running.yaml` | VO2max, biomechanics, marathon taper — injury+pain medical advisory |
| `domain_disambiguation.yaml` | Composite triggers (cluster+pod, cluster+patient) |
