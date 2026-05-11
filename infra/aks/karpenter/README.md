# AKS Karpenter Capacity

These manifests keep the Synesis AKS Karpenter layout in source control.

The cluster uses two explicit capacity roles:

- `core-reserved`: fixed on-demand baseline for core workloads. It keeps two right-sized nodes online, avoids the 8 GiB SKUs that were causing memory pressure, and disables consolidation for that baseline.
- `spot-burst`: spot-only burst pool for affordable overflow capacity. It uses a longer consolidation window so empty or underutilized spot nodes are not churned immediately.
- `spot-flex-migration`: optional patch for the previous mixed-capacity `spot-flex` pool. Apply it only after `core-reserved` is healthy; it converts the old pool into a low-priority spot-only overflow pool with a 16 GiB memory floor.

Apply with:

```sh
kubectl apply -f infra/aks/karpenter/core-reserved.yaml
kubectl apply -f infra/aks/karpenter/spot-burst.yaml
```

After the reserved nodes are ready, apply the migration patch if the old mixed pool still exists:

```sh
kubectl apply -f infra/aks/karpenter/spot-flex-migration.yaml
```

Retire the old pool entirely after workloads are pinned to the intended pool labels and the reserved baseline has settled.
