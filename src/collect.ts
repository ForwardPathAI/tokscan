import { dedupeByKey, listFiles, type FileInfo } from "./files.ts";
import { claudeDirs, codexHome, opencodeDbs, roots, type Root } from "./paths.ts";
import { loadPrices, priceCall } from "./pricing.ts";
import { RepoResolver } from "./repo.ts";
import { parseClaudeFile } from "./sources/claude.ts";
import { codexThreadHints, parseCodexFile } from "./sources/codex.ts";
import { readOpencode } from "./sources/opencode.ts";
import type { Call, Tool } from "./types.ts";

export interface CollectOptions {
  /** Skip files last modified before this. */
  sinceMs: number;
  tools: Set<Tool>;
  /** Return false to skip a file (e.g. unchanged since last sync). */
  wantFile?: (f: FileInfo) => boolean;
  /** Per-database lower bound for OpenCode (sync watermark). */
  opencodeSince?: (dbKey: string) => number;
}

export interface Collected {
  calls: Call[];
  /** Files parsed successfully this run. */
  parsed: FileInfo[];
  /** Files or OpenCode dbs that failed to read: leave their watermarks alone. */
  failed: Set<string>;
  /** OpenCode dbs read successfully, by state key. */
  opencodeOk: string[];
  unpriced: Set<string>;
}

const CONCURRENCY = 16;

async function pool<T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (i < items.length) {
        const j = i++;
        out[j] = await fn(items[j]!);
      }
    }),
  );
  return out;
}

const basename = (rel: string) => rel.split("/").pop()!;

export async function collect(opts: CollectOptions): Promise<Collected> {
  const rs = roots();
  const calls: Call[] = [];
  const hints = new Map<string, string>();
  const parsed: FileInfo[] = [];
  const failed = new Set<string>();
  const opencodeOk: string[] = [];

  for (const root of rs) {
    const jobs: { f: FileInfo; tool: "claude" | "codex" }[] = [];
    if (opts.tools.has("claude")) {
      const found: FileInfo[] = [];
      // Sessions never move inside projects/, so the relative path is stable.
      // Two config dirs that alias each other give the same keys and collapse.
      for (const dir of claudeDirs(root)) found.push(...(await listFiles(dir, ["**/*.jsonl"], (rel) => `${root.env}|claude|${rel}`)));
      for (const f of dedupeByKey(found)) jobs.push({ f, tool: "claude" });
    }
    const ch = codexHome(root);
    if (opts.tools.has("codex") && ch) {
      for (const [k, v] of codexThreadHints(ch)) hints.set(k, v);
      // Rollout file names carry a timestamp and thread id, and survive both
      // archiving (sessions/ -> archived_sessions/) and compression (.zst).
      const keyOf = (rel: string) => `${root.env}|codex|${basename(rel).replace(/\.zst$/, "")}`;
      const found: FileInfo[] = [];
      for (const sub of ["sessions", "archived_sessions"]) {
        const dir = ch + (ch.includes("\\") ? "\\" : "/") + sub;
        try {
          found.push(...(await listFiles(dir, ["**/*.jsonl", "**/*.jsonl.zst"], keyOf)));
        } catch {
          // folder missing
        }
      }
      for (const f of dedupeByKey(found)) jobs.push({ f, tool: "codex" });
    }

    const todo = jobs.filter(({ f }) => f.mtimeMs >= opts.sinceMs && (opts.wantFile?.(f) ?? true));
    const results = await pool(todo, async ({ f, tool }) => {
      try {
        if (tool === "claude") return { f, calls: await parseClaudeFile(f.path, f.key, root.env), hints: null };
        const r = await parseCodexFile(f.path, f.key, root.env);
        return { f, ...r };
      } catch (e) {
        console.error(`warn: skipped ${f.path}: ${(e as Error).message}`);
        return { f, calls: null, hints: null };
      }
    });
    for (const r of results) {
      if (!r.calls) {
        failed.add(r.f.key);
        continue;
      }
      parsed.push(r.f);
      calls.push(...r.calls);
      if (r.hints) for (const [k, v] of r.hints) hints.set(k, v);
    }

    if (opts.tools.has("opencode")) {
      for (const db of opencodeDbs(root)) {
        const key = `${root.env}|opencode|${db}`;
        const since = Math.max(opts.sinceMs, opts.opencodeSince?.(key) ?? 0);
        const got = readOpencode(db, key, root.env, since);
        if (got) {
          opencodeOk.push(key);
          calls.push(...got);
        } else failed.add(key);
      }
    }
  }

  const resolver = new RepoResolver(new Map(rs.map((r: Root) => [r.env, r])), hints);
  resolver.resolveAll(new Map(calls.map((c) => [`${c.env}|${c.cwd}`, [c.env, c.cwd] as [string, string]])).values());
  const prices = await loadPrices();
  const unpriced = new Set<string>();
  for (const c of calls) {
    c.repo = resolver.resolve(c.env, c.cwd);
    c.cost = priceCall(c, prices);
    if (c.cost == null) unpriced.add(`${c.tool}:${c.model || "?"}`);
  }
  return { calls, parsed, failed, opencodeOk, unpriced };
}
