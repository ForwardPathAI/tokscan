export type Tool = "claude" | "codex" | "opencode";

/** One model call (or one Codex token_count delta). */
export interface Call {
  ts: string; // ISO 8601 UTC
  tool: Tool;
  /** Stable id of where this call came from: file path (minus .zst) or `opencode:<session>`. Never sent. */
  source: string;
  /** "native" or "wsl:<distro>". Decides how cwd paths are resolved. */
  env: string;
  session: string;
  model: string;
  cwd: string;
  branch: string;
  input: number; // uncached input
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number; // includes reasoning / thinking
  /** API-equivalent USD. Set by the source if it records cost (OpenCode), else by pricing. */
  cost: number | null;
  repo: string;
}

export function newCall(p: Partial<Call> & Pick<Call, "ts" | "tool" | "source" | "env">): Call {
  return {
    session: "",
    model: "",
    cwd: "",
    branch: "",
    input: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    cost: null,
    repo: "",
    ...p,
  };
}
