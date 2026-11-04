import { chmodSync, existsSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RELEASE_REPO, VERSION } from "./config.ts";
import { selfPath } from "./schedule.ts";

export function assetName(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  // No Windows arm64 build: x64 runs under emulation there.
  return process.platform === "win32" ? "tokscan-windows-x64.exe" : `tokscan-${os}-${arch}`;
}

export function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(/[.-]/).map(Number);
  const pb = b.replace(/^v/, "").split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

async function get(url: string, timeoutMs: number): Promise<Response> {
  const r = await fetch(url, { headers: { "user-agent": "tokscan" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r;
}

/** Replace this binary with the latest release, checked against checksums.txt. Returns the new version or null if current. */
export async function update(): Promise<string | null> {
  const rel = (await (await get(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, 15_000)).json()) as { tag_name: string };
  if (!newer(rel.tag_name, VERSION)) return null;

  const bin = selfPath();
  const base = `https://github.com/${RELEASE_REPO}/releases/download/${rel.tag_name}`;
  const asset = assetName();
  const sums = await (await get(`${base}/checksums.txt`, 15_000)).text();
  const want = sums
    .split("\n")
    .find((l) => l.trim().endsWith(` ${asset}`))
    ?.split(/\s+/)[0]
    ?.toLowerCase();
  if (!want) throw new Error(`no checksum for ${asset} in ${rel.tag_name}`);

  const body = new Uint8Array(await (await get(`${base}/${asset}`, 300_000)).arrayBuffer());
  const got = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  if (got !== want) throw new Error(`checksum mismatch for ${asset} ${rel.tag_name}`);

  const tmp = bin + ".new";
  writeFileSync(tmp, body);
  if (process.platform !== "win32") {
    chmodSync(tmp, 0o755);
    renameSync(tmp, bin);
    return rel.tag_name;
  }
  // Windows can't overwrite a running exe, but it can rename it. Roll back if the swap fails.
  const dir = path.dirname(bin);
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(path.basename(bin) + ".old")) continue;
    try {
      rmSync(path.join(dir, f), { force: true });
    } catch {
      // still running from an earlier update; cleaned up next time
    }
  }
  const old = `${bin}.old-${Date.now()}`;
  renameSync(bin, old);
  try {
    renameSync(tmp, bin);
  } catch (e) {
    if (!existsSync(bin)) renameSync(old, bin);
    rmSync(tmp, { force: true });
    throw e;
  }
  return rel.tag_name;
}
