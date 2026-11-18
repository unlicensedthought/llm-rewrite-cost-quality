export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

export function pearson(a, b) {
  const xs = [];
  const ys = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] != null && b[i] != null) {
      xs.push(a[i]);
      ys.push(b[i]);
    }
  }
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

export function meanAbsDiff(a, b) {
  const ds = [];
  for (let i = 0; i < a.length; i++) if (a[i] != null && b[i] != null) ds.push(Math.abs(a[i] - b[i]));
  return mean(ds);
}

/** A cell is Pareto-optimal if no other cell is at least as good on both axes and better on one. */
export function markPareto(rows) {
  const withQ = rows.filter((r) => r.q != null && r.cost != null);
  for (const r of withQ) {
    r.pareto = !withQ.some((o) => o !== r && o.q >= r.q && o.cost <= r.cost && (o.q > r.q || o.cost < r.cost));
  }
  return rows;
}
