import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TOKSCAN_DIR } from "./paths.ts";

// Replaced at build time (scripts/build.ts). `typeof` keeps dev runs working.
declare const __TOKSCAN_VERSION__: string;
declare const __TOKSCAN_POSTHOG_KEY__: string;

export const VERSION = typeof __TOKSCAN_VERSION__ !== "undefined" ? __TOKSCAN_VERSION__ : "0.0.0-dev";
export const RELEASE_REPO = "ForwardPathAI/tokscan";
const BUILD_KEY = typeof __TOKSCAN_POSTHOG_KEY__ !== "undefined" ? __TOKSCAN_POSTHOG_KEY__ : "";

export interface Config {
  email?: string;
  /** Repo prefixes reported by name. Anything else is sent as "(other)". */
  allow?: string[];
  posthogKey?: string;
  posthogHost?: string;
  autoUpdate?: boolean;
}

export const DEFAULT_ALLOW = ["github.com/forwardpathai/"];
const FILE = path.join(TOKSCAN_DIR, "config.json");

export function readConfig(): Config {
  try {
    return existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
  } catch {
    return {};
  }
}

export function writeConfig(c: Config) {
  mkdirSync(TOKSCAN_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(c, null, 2) + "\n");
}

export function settings() {
  const c = readConfig();
  const allowEnv = process.env.TOKSCAN_ALLOW?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    email: process.env.TOKSCAN_EMAIL || c.email || gitEmail(),
    allow: allowEnv ?? c.allow?.map((s) => s.toLowerCase()) ?? DEFAULT_ALLOW,
    posthogKey: process.env.TOKSCAN_POSTHOG_KEY || c.posthogKey || BUILD_KEY,
    posthogHost: (process.env.TOKSCAN_POSTHOG_HOST || c.posthogHost || "https://us.i.posthog.com").replace(/\/+$/, ""),
    autoUpdate: process.env.TOKSCAN_NO_UPDATE === "1" ? false : (c.autoUpdate ?? true),
  };
}

function gitEmail(): string {
  try {
    const r = Bun.spawnSync(["git", "config", "--global", "user.email"], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}
