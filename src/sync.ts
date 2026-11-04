import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { collect } from "./collect.ts";
import { settings, VERSION } from "./config.ts";
import { TOKSCAN_DIR } from "./paths.ts";
import { issueFromBranch } from "./repo.ts";
import type { Call, Tool } from "./types.ts";

/**
 * Sync sends hourly rollups, not raw calls: one event per
 * (source file, model, repo, branch, UTC hour). That keeps PostHog volume to a
 * few hundred events per engineer per day.
 *
 * Only complete hours are sent. Each source keeps a watermark (`doneHour`), so
 * a later sync never resends an hour. Event UUIDs are derived from the bucket
 * key, so a crash between send and state write is harmless: PostHog drops
 * the duplicates.
 */

export const OTHER = "(other)";
const GRACE_MS = 5 * 60_000;
const BATCH = 500;

interface FileState {
  mtimeMs: number;
  size: number;
  doneHour: string; // "YYYY-MM-DDTHH", all hours <= this are sent
  pending: boolean; // has data in an hour not yet complete
}
export interface State {
  version: 1;
  files: Record<string, FileState>;
  opencode: Record<string, { doneHour: string }>;
  lastSync?: string;
  lastUpdateCheck?: number;
}

const STATE_FILE = path.join(TOKSCAN_DIR, "state.json");
const LOG_FILE = path.join(TOKSCAN_DIR, "sync.log");

export function readState(): State {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    // corrupt: start over; deterministic UUIDs make the resend safe
  }
  return { version: 1, files: {}, opencode: {} };
}

export function writeState(s: State) {
  mkdirSync(TOKSCAN_DIR, { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, STATE_FILE);
}

export const hourOf = (iso: string) => iso.slice(0, 13);
export const hourStartMs = (h: string) => Date.parse(`${h}:00:00Z`);
/** Last hour that is fully over (plus a grace period for late writes). */
export const cutoffHour = (nowMs: number) => new Date(nowMs - 3_600_000 - GRACE_MS).toISOString().slice(0, 13);

export interface Bucket {
  uuid: string;
  hour: string;
  sourceGroup: string;
  tool: Tool;
  env: string;
  model: string;
  repo: string;
  branch: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  unpriced: number;
}

export function isAllowed(repo: string, allow: string[]): boolean {
  const r = repo.toLowerCase() + "/";
  return allow.some((a) => r.startsWith(a.endsWith("/") ? a : a + "/"));
}

/** Watermark group for a call: the file key, or the OpenCode db path. */
export const sourceGroup = (c: Call) => (c.tool === "opencode" ? c.source.slice(0, c.source.lastIndexOf("#")) : c.source);

export function bucketize(calls: Call[], email: string, allow: string[]): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const c of calls) {
    const allowed = isAllowed(c.repo, allow);
    const repo = allowed ? c.repo : OTHER;
    const branch = allowed ? c.branch : "";
    const hour = hourOf(c.ts);
    const key = [email, c.source, c.model, repo, branch, hour].join("|");
    let b = map.get(key);
    if (!b) {
      b = {
        uuid: uuidFrom(key),
        hour,
        sourceGroup: sourceGroup(c),
        tool: c.tool,
        env: c.env,
        model: c.model,
        repo,
        branch,
        calls: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        unpriced: 0,
      };
      map.set(key, b);
    }
    b.calls++;
    b.input += c.input;
    b.output += c.output;
    b.cacheRead += c.cacheRead;
    b.cacheWrite += c.cacheWrite5m + c.cacheWrite1h;
    if (c.cost == null) b.unpriced++;
    else b.cost += c.cost;
  }
  return [...map.values()];
}

export function uuidFrom(key: string): string {
  const h = new Bun.CryptoHasher("sha256").update(key).digest("hex");
  // RFC 4122 layout, version 5 / variant 10 bits, so PostHog accepts it.
  const v = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function toEvent(b: Bucket, email: string) {
  return {
    event: "tokscan_usage",
    distinct_id: email,
    uuid: b.uuid,
    timestamp: `${b.hour}:00:00.000Z`,
    properties: {
      tool: b.tool,
      model: b.model,
      repo: b.repo,
      branch: b.branch || null,
      issue: issueFromBranch(b.branch) || null,
      env: b.env,
      os: process.platform,
      calls: b.calls,
      input_tokens: b.input,
      output_tokens: b.output,
      cache_read_tokens: b.cacheRead,
      cache_write_tokens: b.cacheWrite,
      total_tokens: b.input + b.output + b.cacheRead + b.cacheWrite,
      cost_usd: Math.round(b.cost * 1e6) / 1e6,
      unpriced_calls: b.unpriced,
      tokscan_version: VERSION,
      $set: { email },
      // Don't let PostHog attach the sender's IP address or IP-based location.
      $ip: null,
      $geoip_disable: true,
    },
  };
}

export interface SyncPlan {
  buckets: Bucket[];
  next: State;
  email: string;
  unpriced: Set<string>;
  /** Sources that failed to read this run (retried next run). */
  failed: number;
}

/** Work out what to send and the state after a successful send. Sends nothing. */
export async function plan(opts: { fresh?: boolean; tools?: Set<Tool>; nowMs?: number } = {}): Promise<SyncPlan> {
  const cfg = settings();
  if (!cfg.email) throw new Error("No email. Run `git config --global user.email you@forwardpath.ai` or `tokscan config email you@forwardpath.ai`.");
  const now = opts.nowMs ?? Date.now();
  const cutoff = cutoffHour(now);
  const prev: State = opts.fresh ? { version: 1, files: {}, opencode: {} } : readState();
  // A watermark far in the future means the clock was wrong when it was set.
  // Pull it back, or every real hour after it would be skipped forever.
  const sane = (h: string | undefined) => (h && h > cutoffHour(now + 86_400_000) ? cutoff : (h ?? ""));
  const next: State = structuredClone(prev);

  const got = await collect({
    sinceMs: 0,
    tools: opts.tools ?? new Set<Tool>(["claude", "codex", "opencode"]),
    wantFile: (f) => {
      const s = prev.files[f.key];
      return !(s && s.mtimeMs === f.mtimeMs && s.size === f.size && !s.pending);
    },
    opencodeSince: (db) => {
      const d = sane(prev.opencode[db]?.doneHour);
      return d ? hourStartMs(d) + 3_600_000 : 0;
    },
  });

  const done = (group: string, tool: Tool) => sane(tool === "opencode" ? prev.opencode[group]?.doneHour : prev.files[group]?.doneHour);
  const all = bucketize(got.calls, cfg.email, cfg.allow);
  const buckets = all.filter((b) => b.hour > done(b.sourceGroup, b.tool) && b.hour <= cutoff);

  // Advance watermarks only for sources read cleanly this run. Failed reads
  // keep their old watermark and are retried next run.
  const pending = new Set(all.filter((b) => b.hour > cutoff).map((b) => b.sourceGroup));
  const advance = (old: string) => (old > cutoff ? old : cutoff);
  for (const f of got.parsed) {
    next.files[f.key] = {
      mtimeMs: f.mtimeMs,
      size: f.size,
      doneHour: advance(sane(prev.files[f.key]?.doneHour)),
      pending: pending.has(f.key),
    };
  }
  for (const db of got.opencodeOk) next.opencode[db] = { doneHour: advance(sane(prev.opencode[db]?.doneHour)) };

  // Drop state for files untouched for 180 days. Absence from one listing is
  // not enough: a dir can be missing for one run (env var unset under the
  // scheduler, WSL not running) and reappear.
  const old = cutoffHour(now - 180 * 86_400_000);
  const touched = new Set(got.parsed.map((f) => f.key));
  for (const [k, v] of Object.entries(next.files)) if (v.doneHour < old && !touched.has(k)) delete next.files[k];
  next.lastSync = new Date(now).toISOString();

  return { buckets, next, email: cfg.email, unpriced: got.unpriced, failed: got.failed.size };
}

export async function send(buckets: Bucket[], email: string): Promise<void> {
  const cfg = settings();
  if (!cfg.posthogKey) throw new Error("No PostHog key in this build. Set TOKSCAN_POSTHOG_KEY or `tokscan config posthogKey phc_...`.");
  const events = buckets.map((b) => toEvent(b, email));
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
  // Backfill goes through PostHog's historical path so it doesn't jam live ingestion.
  const groups = [
    { historical: true, events: events.filter((e) => e.timestamp < twoDaysAgo) },
    { historical: false, events: events.filter((e) => e.timestamp >= twoDaysAgo) },
  ];
  for (const g of groups) {
    for (let i = 0; i < g.events.length; i += BATCH) {
      const batch = g.events.slice(i, i + BATCH);
      const r = await fetch(`${cfg.posthogHost}/batch/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: cfg.posthogKey, historical_migration: g.historical, batch }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new Error(`PostHog ${r.status}: ${(await r.text()).slice(0, 300)}`);
    }
  }
}

export function log(line: string) {
  try {
    mkdirSync(TOKSCAN_DIR, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 1_000_000) renameSync(LOG_FILE, LOG_FILE + ".1");
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // logging must never break a sync
  }
}
