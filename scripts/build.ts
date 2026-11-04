// Cross-compile standalone binaries into dist/.
//   bun run scripts/build.ts                 # all targets
//   bun run scripts/build.ts darwin-arm64    # one target
// Env: TOKSCAN_VERSION (default package.json), TOKSCAN_POSTHOG_KEY (baked in).
import { mkdirSync } from "node:fs";
import pkg from "../package.json";

const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"] as const;
const want = process.argv.slice(2);
const targets = want.length ? TARGETS.filter((t) => want.includes(t)) : TARGETS;
const version = (process.env.TOKSCAN_VERSION || pkg.version).replace(/^v/, "");
const key = process.env.TOKSCAN_POSTHOG_KEY || "";
if (!key) console.warn("warn: TOKSCAN_POSTHOG_KEY not set; binaries will need `tokscan config posthogKey`");

mkdirSync("dist", { recursive: true });
for (const t of targets) {
  const out = `dist/tokscan-${t}${t.startsWith("windows") ? ".exe" : ""}`;
  const args = [
    "build",
    "src/cli.ts",
    "--compile",
    "--minify",
    `--target=bun-${t}`,
    `--outfile=${out}`,
    `--define`,
    `__TOKSCAN_VERSION__=${JSON.stringify(version)}`,
    `--define`,
    `__TOKSCAN_POSTHOG_KEY__=${JSON.stringify(key)}`,
  ];
  // Exe metadata flags only work when building on Windows (CI builds Windows there).
  if (t.startsWith("windows") && process.platform === "win32") {
    args.push("--windows-title=tokscan", "--windows-publisher=Forward Path", `--windows-version=${version.replace(/-.*/, "")}.0`, "--windows-description=AI token usage sync");
  }
  const r = Bun.spawnSync(["bun", ...args], { stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
  console.log(`built ${out}`);
}
