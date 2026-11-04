import { Database } from "bun:sqlite";
import { newCall, type Call } from "../types.ts";

const DAY = 86_400_000;

/**
 * OpenCode keeps messages in SQLite (the db can be many GB, mostly its
 * event log, so open it in place, read-only, and touch only `message`).
 * Each assistant message carries tokens and its own cost estimate.
 * `sinceMs` filters on completion time. Returns null if the db can't be
 * read, so the caller keeps its watermark and retries next run.
 */
export function readOpencode(dbPath: string, key: string, env: string, sinceMs: number): Call[] | null {
  const calls: Call[] = [];
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    // A message completes after it is created; look back a day to catch long ones.
    const rows = db
      .query(`select session_id, data from message where time_created >= ? and data like '%"tokens"%'`)
      .all(Math.max(0, sinceMs - DAY)) as { session_id: string; data: string }[];
    for (const r of rows) {
      let d: any;
      try {
        d = JSON.parse(r.data);
      } catch {
        continue;
      }
      if (d.role !== "assistant" || !d.time?.completed || d.time.completed < sinceMs) continue;
      const tk = d.tokens ?? {};
      calls.push(
        newCall({
          ts: new Date(d.time.completed).toISOString(),
          tool: "opencode",
          source: `${key}#${r.session_id}`,
          env,
          session: r.session_id,
          model: d.modelID ?? "",
          cwd: d.path?.root || d.path?.cwd || "",
          input: tk.input ?? 0,
          cacheRead: tk.cache?.read ?? 0,
          cacheWrite5m: tk.cache?.write ?? 0,
          output: (tk.output ?? 0) + (tk.reasoning ?? 0),
          cost: typeof d.cost === "number" && d.cost > 0 ? d.cost : null,
        }),
      );
    }
  } catch (e) {
    console.error(`warn: opencode db ${dbPath}: ${(e as Error).message}`);
    return null;
  } finally {
    db?.close();
  }
  return calls;
}
