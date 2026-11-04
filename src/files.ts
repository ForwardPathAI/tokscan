import { statSync } from "node:fs";

export interface FileInfo {
  path: string;
  /**
   * State key. Must not change when a tool moves or compresses the file
   * (Codex: sessions/ -> archived_sessions/, .jsonl -> .jsonl.zst), or the
   * file's history would be sent again under new event ids.
   */
  key: string;
  mtimeMs: number;
  size: number;
}

/** List files under `dir`. `keyOf` gets the path relative to `dir`, with forward slashes. */
export async function listFiles(dir: string, patterns: string[], keyOf: (rel: string) => string): Promise<FileInfo[]> {
  const sep = dir.includes("\\") ? "\\" : "/";
  const out: FileInfo[] = [];
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    for await (const raw of glob.scan({ cwd: dir, onlyFiles: true, dot: true, followSymlinks: false })) {
      const rel = raw.replace(/\\/g, "/");
      const p = dir + sep + rel.replace(/\//g, sep);
      try {
        const s = statSync(p);
        out.push({ path: p, key: keyOf(rel), mtimeMs: s.mtimeMs, size: s.size });
      } catch {
        // vanished between scan and stat
      }
    }
  }
  return out;
}

/** Keep one file per key, the most recently modified (e.g. mid-compression, or two dirs that alias). */
export function dedupeByKey(files: FileInfo[]): FileInfo[] {
  const byKey = new Map<string, FileInfo>();
  for (const f of files) {
    const prev = byKey.get(f.key);
    if (!prev || f.mtimeMs > prev.mtimeMs) byKey.set(f.key, f);
  }
  return [...byKey.values()];
}

/**
 * Read a .jsonl or .jsonl.zst file and return lines containing any needle.
 * Throws on read/decompress errors so the caller can leave the file's
 * watermark alone and retry next run.
 */
export async function grepLines(path: string, needles: string[]): Promise<string[]> {
  const file = Bun.file(path);
  const text = path.endsWith(".zst")
    ? new TextDecoder().decode(Bun.zstdDecompressSync(new Uint8Array(await file.arrayBuffer())))
    : await file.text();
  const out: string[] = [];
  for (const line of text.split("\n")) {
    for (const n of needles) {
      if (line.includes(n)) {
        out.push(line);
        break;
      }
    }
  }
  return out;
}

export function parse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
