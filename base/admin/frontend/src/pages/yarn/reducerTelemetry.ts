export function formatReducerHealth(successTotal: number, failTotal: number): string {
  const total = successTotal + failTotal;
  if (total <= 0) return "No data";
  return `${((successTotal / total) * 100).toFixed(0)}%`;
}

export function formatSnapshotFreshness(
  snapshotCount: number,
  latestSnapshotAt: string | null,
  stale: boolean,
): string {
  if (snapshotCount <= 0) return "No snapshots yet";
  if (!latestSnapshotAt) return stale ? "Snapshot status stale" : "Snapshot timestamp missing";
  const ts = new Date(latestSnapshotAt).toLocaleString();
  return stale ? `Latest ${ts} (stale)` : `Latest ${ts}`;
}
