import { issueFromBranch } from "./repo.ts";
import type { Call } from "./types.ts";

export const DIMENSIONS = ["repo", "tool", "model", "branch", "issue", "day", "month", "env", "cwd"] as const;
export type Dim = (typeof DIMENSIONS)[number];

function keyOf(c: Call, d: Dim): string {
  switch (d) {
    case "day":
      return c.ts.slice(0, 10);
    case "month":
      return c.ts.slice(0, 7);
    case "issue":
      return issueFromBranch(c.branch) || "-";
    default:
      return String(c[d] || "-");
  }
}

export function fmtTok(n: number): string {
  for (const [u, d] of [["B", 1e9], ["M", 1e6], ["K", 1e3]] as const) if (n >= d) return `${(n / d).toFixed(1)}${u}`;
  return String(Math.round(n));
}

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function table(calls: Call[], dims: Dim[], top: number): string {
  type Agg = { input: number; output: number; cr: number; cw: number; cost: number; calls: number; sessions: Set<string> };
  const agg = new Map<string, { k: string[]; a: Agg }>();
  for (const c of calls) {
    const k = dims.map((d) => keyOf(c, d));
    const id = k.join("\u0000");
    let e = agg.get(id);
    if (!e) agg.set(id, (e = { k, a: { input: 0, output: 0, cr: 0, cw: 0, cost: 0, calls: 0, sessions: new Set() } }));
    e.a.input += c.input;
    e.a.output += c.output;
    e.a.cr += c.cacheRead;
    e.a.cw += c.cacheWrite5m + c.cacheWrite1h;
    e.a.cost += c.cost ?? 0;
    e.a.calls++;
    e.a.sessions.add(c.session);
  }
  const total = [...agg.values()].reduce((s, e) => s + e.a.cost, 0) || 1;
  const rows = [...agg.values()].sort((a, b) => b.a.cost - a.a.cost).slice(0, top);

  const header = [...dims, "sessions", "calls", "input", "output", "cache_rd", "cache_wr", "api_$", "share"];
  const body = rows.map(({ k, a }) => [
    ...k,
    String(a.sessions.size),
    String(a.calls),
    fmtTok(a.input),
    fmtTok(a.output),
    fmtTok(a.cr),
    fmtTok(a.cw),
    money(a.cost),
    `${((a.cost / total) * 100).toFixed(1)}%`,
  ]);
  const sum = (f: (c: Call) => number) => calls.reduce((s, c) => s + f(c), 0);
  const foot = [
    "TOTAL",
    ...Array(dims.length - 1).fill(""),
    String(new Set(calls.map((c) => c.session)).size),
    String(calls.length),
    fmtTok(sum((c) => c.input)),
    fmtTok(sum((c) => c.output)),
    fmtTok(sum((c) => c.cacheRead)),
    fmtTok(sum((c) => c.cacheWrite5m + c.cacheWrite1h)),
    money(sum((c) => c.cost ?? 0)),
    "100%",
  ];
  const all = [header, ...body, foot];
  const w = header.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((c, i) => (i < dims.length ? c.padEnd(w[i]!) : c.padStart(w[i]!))).join("  ");
  return [line(header), ...body.map(line), w.map((n) => "-".repeat(n)).join("  "), line(foot)].join("\n");
}
