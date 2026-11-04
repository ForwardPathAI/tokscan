import { grepLines, parse } from "../files.ts";
import { newCall, type Call } from "../types.ts";

/**
 * Claude Code writes one JSONL line per content block, each repeating the
 * message id and usage. Keep one row per (message id, request id), taking the
 * line with the most output tokens (earlier lines can hold partial counts).
 */
export async function parseClaudeFile(path: string, key: string, env: string): Promise<Call[]> {
  const best = new Map<string, Call>();
  for (const line of await grepLines(path, ['"usage"'])) {
    const d = parse(line);
    if (!d || d.type !== "assistant") continue;
    const msg = d.message ?? {};
    const u = msg.usage;
    const model: string = msg.model ?? "";
    if (!u || model === "<synthetic>") continue;
    const cc = u.cache_creation ?? {};
    let w5m = cc.ephemeral_5m_input_tokens;
    let w1h = cc.ephemeral_1h_input_tokens;
    if (w5m == null && w1h == null) {
      w5m = u.cache_creation_input_tokens ?? 0;
      w1h = 0;
    }
    const call = newCall({
      ts: d.timestamp ?? "",
      tool: "claude",
      source: key,
      env,
      session: d.sessionId ?? "",
      model,
      cwd: d.cwd ?? "",
      branch: d.gitBranch ?? "",
      input: u.input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite5m: w5m ?? 0,
      cacheWrite1h: w1h ?? 0,
      output: u.output_tokens ?? 0,
    });
    const id = `${msg.id ?? ""}|${d.requestId ?? d.uuid ?? ""}`;
    const prev = best.get(id);
    if (!prev || call.output > prev.output) best.set(id, call);
  }
  return [...best.values()];
}
