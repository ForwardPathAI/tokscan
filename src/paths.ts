import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** A home folder whose agent logs we scan. On Windows we also scan WSL homes. */
export interface Root {
  env: string; // "native" | "wsl:<distro>"
  home: string; // path as seen from this process
  distro?: string;
}

export const TOKSCAN_DIR = process.env.TOKSCAN_HOME || path.join(homedir(), ".tokscan");

export function roots(): Root[] {
  const out: Root[] = [{ env: "native", home: homedir() }];
  if (process.platform === "win32" && process.env.TOKSCAN_NO_WSL !== "1") out.push(...wslRoots());
  return out;
}

function wslDistros(): string[] {
  try {
    const r = Bun.spawnSync(["wsl.exe", "--list", "--quiet"], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode !== 0) return [];
    // wsl.exe prints UTF-16LE.
    const text = new TextDecoder("utf-16le").decode(r.stdout).replace(/\0/g, "");
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !/^docker-desktop/i.test(s));
  } catch {
    return [];
  }
}

function wslRoots(): Root[] {
  const out: Root[] = [];
  for (const distro of wslDistros()) {
    for (const prefix of ["\\\\wsl.localhost\\", "\\\\wsl$\\"]) {
      const homeDir = `${prefix}${distro}\\home`;
      let users: string[];
      try {
        users = readdirSync(homeDir);
      } catch {
        continue;
      }
      for (const u of users) out.push({ env: `wsl:${distro}`, home: `${homeDir}\\${u}`, distro });
      if (existsSync(`${prefix}${distro}\\root\\.claude`) || existsSync(`${prefix}${distro}\\root\\.codex`)) {
        out.push({ env: `wsl:${distro}`, home: `${prefix}${distro}\\root`, distro });
      }
      break;
    }
  }
  return out;
}

const join = (r: Root, ...p: string[]) => (r.env === "native" ? path.join(r.home, ...p) : [r.home, ...p].join("\\"));

export function claudeDirs(r: Root): string[] {
  const c = [join(r, ".claude", "projects"), join(r, ".config", "claude", "projects")];
  if (r.env === "native" && process.env.CLAUDE_CONFIG_DIR) {
    for (const d of process.env.CLAUDE_CONFIG_DIR.split(",")) c.unshift(path.join(d.trim(), "projects"));
  }
  return [...new Set(c)].filter((d) => existsSync(d));
}

export function codexHome(r: Root): string | null {
  const c = r.env === "native" && process.env.CODEX_HOME ? process.env.CODEX_HOME : join(r, ".codex");
  return existsSync(c) ? c : null;
}

export function opencodeDbs(r: Root): string[] {
  const c = [join(r, ".local", "share", "opencode", "opencode.db")];
  if (r.env === "native") {
    if (process.env.XDG_DATA_HOME) c.unshift(path.join(process.env.XDG_DATA_HOME, "opencode", "opencode.db"));
    if (process.env.LOCALAPPDATA) c.push(path.join(process.env.LOCALAPPDATA, "opencode", "opencode.db"));
    if (process.env.APPDATA) c.push(path.join(process.env.APPDATA, "opencode", "opencode.db"));
  }
  return [...new Set(c)].filter((d) => existsSync(d));
}

/** Translate a path recorded inside WSL (/home/x/repo) to one this process can read. */
export function hostPath(r: Root, p: string): string {
  if (r.env === "native" || !r.distro || !p.startsWith("/")) return p;
  const m = r.home.match(/^(\\\\[^\\]+\\[^\\]+)\\/);
  const base = m ? m[1]! : r.home;
  return base + p.replace(/\//g, "\\");
}
