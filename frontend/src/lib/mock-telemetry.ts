type Row = Record<string, unknown>;

export function mockTelemetryStats(
  rows: Row[],
  query: { from?: unknown; to?: unknown; bucket?: unknown },
) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const time = Date.parse(String(row.recorded_at));
    if (
      !Number.isFinite(time) ||
      row.clock_skew ||
      (query.from && time < Date.parse(String(query.from))) ||
      (query.to && time >= Date.parse(String(query.to)))
    )
      continue;
    const bucket = new Date(time);
    if (query.bucket === "day") bucket.setUTCHours(0, 0, 0, 0);
    else bucket.setUTCMinutes(0, 0, 0);
    const key = bucket.toISOString();
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket_at, samples]) => {
      const result: Row = {
        bucket_at,
        sample_count: samples.length,
        occupied_samples: samples.filter((row) => row.occupancy === true)
          .length,
        occupancy_known_samples: samples.filter((row) => row.occupancy != null)
          .length,
      };
      for (const metric of ["temperature", "humidity", "lux"]) {
        const values = samples
          .filter((row) => row[metric] != null)
          .map((row) => Number(row[metric]))
          .filter(Number.isFinite);
        result[metric + "_avg"] = values.length
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : null;
        result[metric + "_min"] = values.length ? Math.min(...values) : null;
        result[metric + "_max"] = values.length ? Math.max(...values) : null;
      }
      return result;
    });
}
