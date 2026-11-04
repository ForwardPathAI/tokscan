import { existsSync } from "node:fs";
import path from "node:path";
import { hostPath, type Root } from "./paths.ts";

/** git@github.com:Org/Repo.git | https://github.com/Org/Repo -> github.com/org/repo */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(u);
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  u = u.replace(/^[^@/]+@/, "");
  if (hasScheme) {
    u = u.replace(/^([^/:]+):\d+(?=\/)/, "$1"); // drop :port
  } else {
    u = u.replace(/^([^/:]+):\/?/, "$1/"); // scp-style host:path
  }
  u = u.replace(/\.git$/, "").replace(/\/+$/, "");
  return u.toLowerCase();
}

const T3_WORKTREE = /[\\/]\.t3[\\/]worktrees[\\/]([^\\/]+)[\\/]/;
const T3_SCRATCH = /[\\/]\.t3[\\/]scratch[\\/]/;
const CLAUDE_WORKTREE = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/]/;

export const UNATTRIBUTED = "(unattributed)";
export const SCRATCH = "(scratch)";

/**
 * Maps a session's working folder to a normalized git remote.
 * Fallbacks, in order: Codex-recorded remote for that folder, `git remote`
 * on the nearest existing parent, T3 worktree name matched to a known repo,
 * then `gone:<folder>` for repos deleted since.
 */
export class RepoResolver {
  private cache = new Map<string, string>();
  private hints = new Map<string, string>();
  private byName = new Map<string, string>();

  constructor(
    private rootsByEnv: Map<string, Root>,
    hints: Map<string, string>,
  ) {
    for (const [cwd, url] of hints) {
      const r = normalizeRemote(url);
      this.hints.set(cwd, r);
      this.remember(r);
    }
  }

  private remember(repo: string) {
    if (!repo || repo.includes(":") || repo.startsWith("(")) return;
    const name = repo.split("/").pop()!;
    if (!this.byName.has(name)) this.byName.set(name, repo);
  }

  /** Resolve real folders before T3 worktrees so worktree names can borrow them. */
  resolveAll(cwds: Iterable<[env: string, cwd: string]>) {
    const list = [...cwds].sort((a, b) => Number(T3_WORKTREE.test(a[1])) - Number(T3_WORKTREE.test(b[1])));
    for (const [env, cwd] of list) this.resolve(env, cwd);
  }

  resolve(env: string, cwd: string): string {
    if (!cwd) return UNATTRIBUTED;
    const ck = `${env}|${cwd}`;
    const hit = this.cache.get(ck);
    if (hit) return hit;

    const root = this.rootsByEnv.get(env) ?? { env: "native", home: "" };
    const p = env === "native" ? path : path.posix;
    const exists = (x: string) => existsSync(hostPath(root, x));

    let repo = this.hints.get(cwd) ?? "";
    if (!repo) {
      const m = cwd.match(CLAUDE_WORKTREE);
      let probe = m ? m[1]! : cwd;
      while (!exists(probe) && p.dirname(probe) !== probe) probe = p.dirname(probe);
      const isHome = probe === root.home || probe === p.dirname(probe) || /^\/home\/[^/]+$/.test(probe);
      if (!isHome) repo = gitRemote(root, probe);
    }
    if (!repo || repo.startsWith("local:")) {
      const m = (cwd + "/").match(T3_WORKTREE);
      if (m) repo = this.byName.get(m[1]!.toLowerCase()) ?? (repo || `t3:${m[1]}`);
    }
    if (!repo && T3_SCRATCH.test(cwd + "/")) repo = SCRATCH;
    if (!repo) {
      // Folder deleted since the session ran: name it after the topmost missing folder.
      const m = cwd.match(CLAUDE_WORKTREE);
      let q = m ? m[1]! : cwd;
      if (!exists(q)) {
        while (!exists(p.dirname(q)) && p.dirname(q) !== q) q = p.dirname(q);
        const name = p.basename(q);
        repo = this.byName.get(name.toLowerCase()) ?? `gone:${name}`;
      }
    }
    repo ||= UNATTRIBUTED;
    this.remember(repo);
    this.cache.set(ck, repo);
    return repo;
  }
}

function gitRemote(root: Root, dir: string): string {
  const run = (args: string[]) => {
    const cmd = root.env === "native" ? ["git", "-C", dir, ...args] : ["wsl.exe", "-d", root.distro!, "git", "-C", dir, ...args];
    try {
      const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
      return r.exitCode === 0 ? r.stdout.toString().trim() : "";
    } catch {
      return "";
    }
  };
  const url = run(["remote", "get-url", "origin"]);
  if (url) return normalizeRemote(url);
  const top = run(["rev-parse", "--show-toplevel"]);
  return top ? `local:${top.split(/[\\/]/).pop()}` : "";
}

// Branch words that look like issue IDs but aren't ("setup-1", "review-2").
const NOT_ISSUE = new Set(
  "ISSUE SETUP REVIEW FIX FEAT FEATURE BUG CHORE HOTFIX RELEASE TEST TASK STEP PHASE PART SPRINT DEMO POC SPIKE WIP AGENT PR V".split(" "),
);

/** Linear-style issue id from a branch name, e.g. "mack/pod-1860-fix-auth" -> "POD-1860". */
export function issueFromBranch(branch: string): string {
  for (const m of branch.matchAll(/(?:^|[^a-z])([a-z]{2,6})-(\d+)/gi)) {
    const key = m[1]!.toUpperCase();
    if (!NOT_ISSUE.has(key)) return `${key}-${m[2]}`;
  }
  return "";
}
