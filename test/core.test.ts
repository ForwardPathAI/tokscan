import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dedupeByKey, listFiles } from "../src/files.ts";
import { priceCall } from "../src/pricing.ts";
import { issueFromBranch, normalizeRemote } from "../src/repo.ts";
import { parseClaudeFile } from "../src/sources/claude.ts";
import { parseCodexFile } from "../src/sources/codex.ts";
import { bucketize, cutoffHour, isAllowed, OTHER, uuidFrom } from "../src/sync.ts";
import { newCall } from "../src/types.ts";

const tmp = () => mkdtempSync(path.join(tmpdir(), "tokscan-test-"));
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("normalizeRemote", () => {
  test.each([
    ["git@github.com:ForwardPathAI/fp-os.git", "github.com/forwardpathai/fp-os"],
    ["https://github.com/ForwardPathAI/fp-os.git", "github.com/forwardpathai/fp-os"],
    ["https://github.com/ForwardPathAI/fp-os/", "github.com/forwardpathai/fp-os"],
    ["ssh://git@bitbucket.org/team/repo.git", "bitbucket.org/team/repo"],
    ["https://user@dev.azure.com/org/proj/_git/repo", "dev.azure.com/org/proj/_git/repo"],
    ["git@github.com:1Password/cli.git", "github.com/1password/cli"],
    ["ssh://git@github.com:22/ForwardPathAI/x.git", "github.com/forwardpathai/x"],
    ["https://github.com:443/ForwardPathAI/x", "github.com/forwardpathai/x"],
  ])("%s", (input, want) => expect(normalizeRemote(input)).toBe(want));
});

test("issueFromBranch", () => {
  expect(issueFromBranch("mack/pod-1860-fix-auth")).toBe("POD-1860");
  expect(issueFromBranch("main")).toBe("");
  expect(issueFromBranch("t3/0553d250")).toBe("");
});

describe("claude", () => {
  test("keeps one row per message, with the most output", async () => {
    const dir = tmp();
    const f = path.join(dir, "s.jsonl");
    const base = { type: "assistant", sessionId: "s1", cwd: "/x", gitBranch: "main", requestId: "r1", timestamp: "2026-11-01T10:00:00Z" };
    const usage = (out: number) => ({ input_tokens: 2, output_tokens: out, cache_read_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 50 } });
    writeFileSync(
      f,
      jsonl([
        { ...base, message: { id: "m1", model: "claude-opus-5-5", usage: usage(5) } },
        { ...base, message: { id: "m1", model: "claude-opus-5-5", usage: usage(40) } },
        { ...base, requestId: "r2", message: { id: "m2", model: "claude-opus-5-5", usage: usage(7) } },
        { ...base, message: { id: "m3", model: "<synthetic>", usage: usage(1) } },
        { type: "user", message: { content: "hi" } },
      ]),
    );
    const calls = await parseClaudeFile(f, f, "native");
    expect(calls.length).toBe(2);
    const m1 = calls.find((c) => c.output === 40)!;
    expect(m1).toMatchObject({ input: 2, cacheRead: 100, cacheWrite1h: 50, cacheWrite5m: 0, cwd: "/x", branch: "main" });
  });
});

describe("codex", () => {
  const rows = [
    { timestamp: "2026-11-01T10:00:00Z", type: "session_meta", payload: { id: "t1", cwd: "/r", git: { branch: "feat", repository_url: "https://github.com/ForwardPathAI/r.git" } } },
    { timestamp: "2026-11-01T10:00:01Z", type: "turn_context", payload: { model: "gpt-6.1-sol", cwd: "/r" } },
    { timestamp: "2026-11-01T10:00:02Z", type: "event_msg", payload: { type: "token_count", info: null } },
    { timestamp: "2026-11-01T10:00:03Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } } } },
    { timestamp: "2026-11-01T10:00:04Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } } } },
    { timestamp: "2026-11-01T10:00:05Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 2500, cached_input_tokens: 2000, output_tokens: 80 } } } },
  ];

  test("diffs cumulative totals and skips repeats", async () => {
    const f = path.join(tmp(), "rollout.jsonl");
    writeFileSync(f, jsonl(rows));
    const { calls, hints } = await parseCodexFile(f, f, "native");
    expect(calls.map((c) => [c.input, c.cacheRead, c.output])).toEqual([
      [200, 800, 50],
      [300, 1200, 30],
    ]);
    expect(calls[0]).toMatchObject({ model: "gpt-6.1-sol", branch: "feat", session: "t1" });
    expect(hints.get("/r")).toBe("https://github.com/ForwardPathAI/r.git");
  });

  test("reads .jsonl.zst", async () => {
    const f = path.join(tmp(), "rollout.jsonl.zst");
    writeFileSync(f, Bun.zstdCompressSync(new TextEncoder().encode(jsonl(rows))));
    const { calls } = await parseCodexFile(f, "k", "native");
    expect(calls.length).toBe(2);
  });

  test("unreadable file throws so its watermark is kept", async () => {
    const f = path.join(tmp(), "broken.jsonl.zst");
    writeFileSync(f, "not zstd");
    await expect(parseCodexFile(f, "k", "native")).rejects.toThrow();
  });
});

describe("file keys", () => {
  test("survive archive moves and compression; aliases collapse", async () => {
    const root = tmp();
    const keyOf = (rel: string) => `native|codex|${rel.split("/").pop()!.replace(/\.zst$/, "")}`;
    mkdirSync(path.join(root, "sessions/2026/11/01"), { recursive: true });
    mkdirSync(path.join(root, "archived_sessions"), { recursive: true });
    writeFileSync(path.join(root, "sessions/2026/11/01/rollout-a.jsonl"), "{}\n");
    writeFileSync(path.join(root, "archived_sessions/rollout-a.jsonl.zst"), "x");
    const a = await listFiles(path.join(root, "sessions"), ["**/*.jsonl"], keyOf);
    const b = await listFiles(path.join(root, "archived_sessions"), ["**/*.jsonl.zst"], keyOf);
    expect(a[0]!.key).toBe(b[0]!.key);
    expect(dedupeByKey([...a, ...b]).length).toBe(1);
  });
});

describe("pricing", () => {
  const prices = {
    m: {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 1e-5,
      cache_read_input_token_cost: 1e-7,
      input_cost_per_token_above_272k_tokens: 2e-6,
      cache_read_input_token_cost_above_272k_tokens: 2e-7,
    },
  };
  const call = (input: number, cacheRead: number) => newCall({ ts: "", tool: "codex", source: "", env: "native", model: "m", input, cacheRead, output: 0 });

  test("base rate", () => expect(priceCall(call(1000, 1000), prices)).toBeCloseTo(1000 * 1e-6 + 1000 * 1e-7));
  test("long-context tier", () => expect(priceCall(call(1000, 300_000), prices)).toBeCloseTo(1000 * 2e-6 + 300_000 * 2e-7));
  test("unknown model", () => expect(priceCall({ ...call(1, 1), model: "nope" }, prices)).toBeNull());
  test("source-recorded cost wins", () => expect(priceCall({ ...call(1, 1), cost: 0.5 }, prices)).toBe(0.5));
});

describe("sync buckets", () => {
  const mk = (ts: string, repo: string, source = "/f1") =>
    ({ ...newCall({ ts, tool: "claude", source, env: "native", model: "claude-opus-5-5", input: 10, output: 5, branch: "mack/pod-1-x" }), repo, cost: 0.01 });

  test("rolls up by hour and hides non-allowlisted repos", () => {
    const b = bucketize(
      [
        mk("2026-11-01T10:05:00Z", "github.com/forwardpathai/a"),
        mk("2026-11-01T10:55:00Z", "github.com/forwardpathai/a"),
        mk("2026-11-01T11:01:00Z", "github.com/forwardpathai/a"),
        mk("2026-11-01T10:10:00Z", "github.com/someone/private"),
      ],
      "me@x.ai",
      ["github.com/forwardpathai/"],
    );
    expect(b.length).toBe(3);
    const ten = b.find((x) => x.hour === "2026-11-01T10" && x.repo !== OTHER)!;
    expect(ten.calls).toBe(2);
    expect(ten.input).toBe(20);
    const other = b.find((x) => x.repo === OTHER)!;
    expect(other.branch).toBe("");
  });

  test("uuid is stable and valid", () => {
    const u = uuidFrom("k");
    expect(u).toBe(uuidFrom("k"));
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(u).not.toBe(uuidFrom("k2"));
  });

  test("isAllowed matches whole owner segment", () => {
    expect(isAllowed("github.com/forwardpathai/x", ["github.com/forwardpathai/"])).toBe(true);
    expect(isAllowed("github.com/forwardpathai-evil/x", ["github.com/forwardpathai"])).toBe(false);
    expect(isAllowed("gone:x", ["github.com/forwardpathai/"])).toBe(false);
  });

  test("cutoffHour leaves the current hour and a grace period", () => {
    expect(cutoffHour(Date.parse("2026-11-01T12:04:00Z"))).toBe("2026-11-01T10");
    expect(cutoffHour(Date.parse("2026-11-01T12:06:00Z"))).toBe("2026-11-01T11");
  });
});
