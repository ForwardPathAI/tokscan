#!/usr/bin/env bun
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { collect } from "./collect.ts";
import { readConfig, settings, VERSION, writeConfig, type Config } from "./config.ts";
import { TOKSCAN_DIR } from "./paths.ts";
import { DIMENSIONS, fmtTok, table, type Dim } from "./report.ts";
import { installSchedule, uninstallSchedule } from "./schedule.ts";
import { log, plan, readState, send, toEvent, writeState, type Bucket } from "./sync.ts";
import type { Tool } from "./types.ts";
import { update } from "./update.ts";

const HELP = `tokscan ${VERSION} - per-project AI token usage from local coding-agent logs

Reads Claude Code, Codex and OpenCode logs on this machine (including T3 Code,
which runs those), maps each call to its git repo, and prices it at API rates.

Usage:
  tokscan report [--days 30 | --since YYYY-MM-DD] [--until YYYY-MM-DD]
                 [--by repo,tool,model,branch,issue,day,month,env,cwd]
                 [--top 40] [--tools claude,codex,opencode] [--csv out.csv]
  tokscan preview [--fresh]   show what the next sync would send (sends nothing)
  tokscan sync [--quiet]      send completed hours to PostHog
  tokscan install             schedule sync every 15 min and run it once
  tokscan uninstall [--purge] remove the schedule (--purge: also ~/.tokscan)
  tokscan status              config, last sync, schedule log
  tokscan config [key [value]]  keys: email, allow, posthogKey, posthogHost, autoUpdate
  tokscan update              install the latest release
  tokscan version

What sync sends: hourly totals per repo/tool/model/branch (token counts and
API-equivalent $), tagged with your email. Never prompts, code or file paths.
Repos outside the allowlist (default github.com/forwardpathai/) are sent as
"(other)" with no name or branch.`;

const ALL_TOOLS: Tool[] = ["claude", "codex", "opencode"];

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "report":
      return report(rest);
    case "preview":
      return preview(rest);
    case "sync":
      return sync(rest);
    case "install":
      return install(rest);
    case "uninstall":
      return uninstall(rest);
    case "status":
      return status();
    case "config":
      return config(rest);
    case "update": {
      const v = await update();
      console.log(v ? `updated to ${v}` : `already on latest (${VERSION})`);
      return;
    }
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(2);
  }
}

function parseTools(s: string | undefined): Set<Tool> {
  const t = (s ?? ALL_TOOLS.join(",")).split(",").map((x) => x.trim()) as Tool[];
  for (const x of t) if (!ALL_TOOLS.includes(x)) throw new Error(`unknown tool: ${x}`);
  return new Set(t);
}

async function report(argv: string[]) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      days: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      by: { type: "string", default: "repo" },
      top: { type: "string", default: "40" },
      tools: { type: "string" },
      csv: { type: "string" },
    },
  });
  const since = v.since ? Date.parse(`${v.since}T00:00:00Z`) : Date.now() - Number(v.days ?? 30) * 86_400_000;
  const until = v.until ? Date.parse(`${v.until}T00:00:00Z`) : Infinity;
  if (Number.isNaN(since) || Number.isNaN(until)) throw new Error("dates must be YYYY-MM-DD");
  const dims = v.by!.split(",").map((s) => s.trim()) as Dim[];
  for (const d of dims) if (!DIMENSIONS.includes(d)) throw new Error(`--by: unknown ${d} (use ${DIMENSIONS.join(", ")})`);

  const t0 = performance.now();
  const got = await collect({ sinceMs: since, tools: parseTools(v.tools) });
  const calls = got.calls.filter((c) => {
    const t = Date.parse(c.ts);
    return t >= since && t < until;
  });
  console.log(
    `tokscan  ${new Date(since).toISOString().slice(0, 10)} -> ${v.until ?? "now"}  ` +
      `(${calls.length.toLocaleString()} calls, ${((performance.now() - t0) / 1000).toFixed(1)}s)\n`,
  );
  console.log(table(calls, dims, Number(v.top)));
  if (got.unpriced.size) console.error(`\nunpriced models (counted as $0): ${[...got.unpriced].sort().join(", ")}`);
  if (v.csv) {
    const cols = ["ts", "tool", "env", "session", "model", "repo", "branch", "cwd", "input", "cacheRead", "cacheWrite5m", "cacheWrite1h", "output", "cost"] as const;
    const esc = (x: unknown) => {
      const s = x == null ? "" : String(x);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(","), ...calls.map((c) => cols.map((k) => esc(c[k])).join(","))];
    writeFileSync(v.csv, lines.join("\n") + "\n");
    console.log(`\nwrote ${calls.length.toLocaleString()} rows -> ${v.csv}`);
  }
}

function summarize(buckets: Bucket[]): string {
  const byRepo = new Map<string, { cost: number; tokens: number; events: number }>();
  for (const b of buckets) {
    const e = byRepo.get(b.repo) ?? { cost: 0, tokens: 0, events: 0 };
    e.cost += b.cost;
    e.tokens += b.input + b.output + b.cacheRead + b.cacheWrite;
    e.events++;
    byRepo.set(b.repo, e);
  }
  const rows = [...byRepo.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const w = Math.max(4, ...rows.map(([r]) => r.length));
  return [
    `${"repo".padEnd(w)}  ${"events".padStart(7)}  ${"tokens".padStart(8)}  ${"api_$".padStart(10)}`,
    ...rows.map(([r, e]) => `${r.padEnd(w)}  ${String(e.events).padStart(7)}  ${fmtTok(e.tokens).padStart(8)}  ${e.cost.toFixed(2).padStart(10)}`),
  ].join("\n");
}

async function preview(argv: string[]) {
  const { values: v } = parseArgs({ args: argv, options: { fresh: { type: "boolean" } } });
  const p = await plan({ fresh: v.fresh });
  console.log(`Would send ${p.buckets.length.toLocaleString()} events as ${p.email}:\n`);
  if (p.buckets.length) {
    console.log(summarize(p.buckets));
    console.log(`\nExample event:\n${JSON.stringify(toEvent(p.buckets[p.buckets.length - 1]!, p.email), null, 2)}`);
  }
  console.log(`\nNothing sent. Allowlist: ${settings().allow.join(", ")}`);
}

const LOCK = path.join(TOKSCAN_DIR, "sync.lock");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** One sync at a time. The lock holds our pid; a lock whose pid is dead is stale. */
function lock(): boolean {
  mkdirSync(TOKSCAN_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(LOCK, "utf8").trim());
      // Fresh empty lock: another process is between open and write.
      if (!pid && Date.now() - statSync(LOCK).mtimeMs < 60_000) return false;
      if (pid && alive(pid)) return false;
      rmSync(LOCK, { force: true });
    }
  }
  return false;
}

function unlock() {
  try {
    if (Number(readFileSync(LOCK, "utf8").trim()) === process.pid) rmSync(LOCK, { force: true });
  } catch {
    // already gone
  }
}

async function sync(argv: string[]) {
  const { values: v } = parseArgs({ args: argv, options: { quiet: { type: "boolean" } } });
  const say = (s: string) => !v.quiet && console.log(s);
  if (!lock()) {
    say("another sync is running");
    return;
  }
  try {
    const t0 = performance.now();
    const p = await plan();
    if (p.buckets.length) await send(p.buckets, p.email);
    writeState(p.next);
    const cost = p.buckets.reduce((s, b) => s + b.cost, 0);
    const failed = p.failed ? `, ${p.failed} sources unreadable (retry next run)` : "";
    const msg = `sync ok: ${p.buckets.length} events, $${cost.toFixed(2)}, ${((performance.now() - t0) / 1000).toFixed(1)}s${failed}`;
    log(msg);
    say(msg);
    await maybeUpdate(v.quiet ?? false);
  } catch (e) {
    log(`sync failed: ${(e as Error).message}`);
    throw e;
  } finally {
    unlock();
  }
}

async function maybeUpdate(quiet: boolean) {
  if (!settings().autoUpdate || VERSION.includes("dev")) return;
  const s = readState();
  if (s.lastUpdateCheck && Date.now() - s.lastUpdateCheck < 86_400_000) return;
  writeState({ ...s, lastUpdateCheck: Date.now() });
  try {
    const v = await update();
    if (v) {
      log(`updated to ${v}`);
      if (!quiet) console.log(`updated to ${v}`);
    }
  } catch (e) {
    log(`update check failed: ${(e as Error).message}`);
  }
}

function inWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

async function install(argv: string[]) {
  const { values: v } = parseArgs({ args: argv, options: { "no-sync": { type: "boolean" } } });
  if (inWsl() && process.env.TOKSCAN_ALLOW_WSL !== "1") {
    throw new Error(
      "This is WSL. Install the Windows version instead; it reads WSL logs too, and running both double counts.\n" +
        "Set TOKSCAN_ALLOW_WSL=1 only if tokscan will never run on the Windows side.",
    );
  }
  const s = settings();
  if (!s.email) {
    throw new Error("No email found. Run `git config --global user.email you@forwardpath.ai` or `tokscan config email you@forwardpath.ai`, then rerun install.");
  }
  if (!s.posthogKey) console.warn("warn: this build has no PostHog key; sync will fail until you set one (tokscan config posthogKey phc_...)");
  console.log(`email:     ${s.email}`);
  console.log(`allowlist: ${s.allow.join(", ")}`);
  console.log(`schedule:  ${installSchedule()}`);
  if (!v["no-sync"] && s.posthogKey) {
    console.log("\nFirst sync (sends all history on this machine; can take a minute)...");
    await sync([]);
  }
  console.log("\nDone. See your own numbers any time with: tokscan report");
}

async function uninstall(argv: string[]) {
  const { values: v } = parseArgs({ args: argv, options: { purge: { type: "boolean" } } });
  console.log(uninstallSchedule());
  if (v.purge) {
    rmSync(TOKSCAN_DIR, { recursive: true, force: true });
    console.log(`deleted ${TOKSCAN_DIR}`);
  }
}

function status() {
  const s = settings();
  const st = readState();
  console.log(`tokscan ${VERSION}`);
  console.log(`email:       ${s.email || "(none)"}`);
  console.log(`allowlist:   ${s.allow.join(", ")}`);
  console.log(`posthog:     ${s.posthogKey ? `${s.posthogHost} (key set)` : "no key"}`);
  console.log(`last sync:   ${st.lastSync ?? "never"}`);
  console.log(`files known: ${Object.keys(st.files).length}`);
  const logFile = path.join(TOKSCAN_DIR, "sync.log");
  if (existsSync(logFile)) {
    const tail = readFileSync(logFile, "utf8").trim().split("\n").slice(-5);
    console.log(`\nrecent log:\n  ${tail.join("\n  ")}`);
  }
}

function config(argv: string[]) {
  const c = readConfig();
  const [key, ...vals] = argv;
  if (!key) {
    console.log(JSON.stringify({ file: readConfig(), effective: { ...settings(), posthogKey: settings().posthogKey ? "(set)" : "" } }, null, 2));
    return;
  }
  const keys: (keyof Config)[] = ["email", "allow", "posthogKey", "posthogHost", "autoUpdate"];
  if (!keys.includes(key as keyof Config)) throw new Error(`unknown key ${key} (use ${keys.join(", ")})`);
  const val = vals.join(" ");
  if (!val) {
    console.log(JSON.stringify(c[key as keyof Config] ?? null));
    return;
  }
  const next: Config = { ...c };
  if (key === "allow") next.allow = val.split(",").map((s) => s.trim()).filter(Boolean);
  else if (key === "autoUpdate") next.autoUpdate = val === "true";
  else (next as Record<string, unknown>)[key] = val;
  writeConfig(next);
  console.log(`set ${key}`);
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
