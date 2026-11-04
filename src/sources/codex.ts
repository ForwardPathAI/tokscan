import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { grepLines, parse } from "../files.ts";
import { newCall, type Call } from "../types.ts";

export interface CodexParse {
  calls: Call[];
  /** cwd -> git remote URL, recorded by Codex at session start. */
  hints: Map<string, string>;
}

type Totals = [input: number, cached: number, cacheWrite: number, output: number];

/**
 * Codex logs cumulative totals per session file. Diff consecutive snapshots
 * into per-call rows. OpenAI's input_tokens includes cached tokens.
 */
export async function parseCodexFile(path: string, key: string, env: string): Promise<CodexParse> {
  const calls: Call[] = [];
  const hints = new Map<string, string>();
  let cwd = "";
  let branch = "";
  let session = "";
  let model = "";
  let prev: Totals | null = null;

  const lines = await grepLines(path, ['"session_meta"', '"turn_context"', '"token_count"']);
  for (const line of lines) {
    const d = parse(line);
    if (!d) continue;
    const p = d.payload ?? {};
    if (d.type === "session_meta") {
      session = p.id ?? session;
      cwd = p.cwd || cwd;
      branch = p.git?.branch || branch;
      if (cwd && p.git?.repository_url) hints.set(cwd, p.git.repository_url);
    } else if (d.type === "turn_context") {
      model = p.model || model;
      cwd = p.cwd || cwd;
    } else if (d.type === "event_msg" && p.type === "token_count" && p.info) {
      const t = p.info.total_token_usage ?? {};
      const cur: Totals = [
        t.input_tokens ?? 0,
        t.cached_input_tokens ?? 0,
        t.cache_write_input_tokens ?? 0,
        t.output_tokens ?? 0,
      ];
      let delta: Totals;
      if (!prev) delta = cur;
      else if (cur.every((v, i) => v === prev![i])) continue; // repeated snapshot
      else if (cur.some((v, i) => v < prev![i]!)) delta = cur; // counter reset
      else delta = cur.map((v, i) => v - prev![i]!) as Totals;
      prev = cur;
      const [inp, cached, cw, out] = delta;
      calls.push(
        newCall({
          ts: d.timestamp ?? "",
          tool: "codex",
          source: key,
          env,
          session,
          model,
          cwd,
          branch,
          input: Math.max(inp - cached - cw, 0),
          cacheRead: cached,
          cacheWrite5m: cw,
          output: out,
        }),
      );
    }
  }
  return { calls, hints };
}

/** Codex's thread index keeps each thread's git origin even after its worktree is deleted. */
export function codexThreadHints(codexHome: string): Map<string, string> {
  const hints = new Map<string, string>();
  let dbs: string[] = [];
  try {
    dbs = readdirSync(codexHome)
      .filter((f) => /^state_\d+\.sqlite$/.test(f))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
  } catch {
    return hints;
  }
  const sep = codexHome.includes("\\") ? "\\" : "/";
  for (const f of dbs.slice(0, 1)) {
    try {
      const db = new Database(codexHome + sep + f, { readonly: true });
      const rows = db
        .query("select cwd, git_origin_url from threads where git_origin_url is not null and git_origin_url != ''")
        .all() as { cwd: string; git_origin_url: string }[];
      for (const r of rows) if (!hints.has(r.cwd)) hints.set(r.cwd, r.git_origin_url);
      db.close();
    } catch {
      // schema changed or db locked: hints are best-effort
    }
  }
  return hints;
}
