import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { TOKSCAN_DIR } from "./paths.ts";

const LABEL = "ai.forwardpath.tokscan";
const TASK = "tokscan";
const INTERVAL_MIN = 15;

/** The compiled binary. Refuse to schedule `bun run src/cli.ts`. */
export function selfPath(): string {
  const p = process.execPath;
  if (/^bun(\.exe)?$/i.test(path.basename(p))) {
    throw new Error("install only works from the compiled binary, not `bun run`.");
  }
  return p;
}

function run(cmd: string[], quiet = false): { ok: boolean; out: string } {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = (r.stdout.toString() + r.stderr.toString()).trim();
  if (!quiet && r.exitCode !== 0) console.error(out);
  return { ok: r.exitCode === 0, out };
}

export function installSchedule(): string {
  const bin = selfPath();
  if (process.platform === "darwin") return installLaunchd(bin);
  if (process.platform === "win32") return installWindows(bin);
  return installLinux(bin);
}

export function uninstallSchedule(): string {
  if (process.platform === "darwin") {
    const plist = path.join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    run(["launchctl", "bootout", `gui/${process.getuid!()}/${LABEL}`], true);
    rmSync(plist, { force: true });
    return "removed launchd agent";
  }
  if (process.platform === "win32") {
    run(["schtasks", "/Delete", "/TN", TASK, "/F"], true);
    return "removed scheduled task";
  }
  const unit = path.join(homedir(), ".config", "systemd", "user");
  if (existsSync(path.join(unit, "tokscan.timer"))) {
    run(["systemctl", "--user", "disable", "--now", "tokscan.timer"], true);
    rmSync(path.join(unit, "tokscan.timer"), { force: true });
    rmSync(path.join(unit, "tokscan.service"), { force: true });
    run(["systemctl", "--user", "daemon-reload"], true);
  }
  const cur = run(["crontab", "-l"], true);
  if (cur.ok && cur.out.includes("# tokscan")) {
    const kept = cur.out.split("\n").filter((l) => !l.includes("# tokscan")).join("\n") + "\n";
    Bun.spawnSync(["crontab", "-"], { stdin: new TextEncoder().encode(kept) });
  }
  return "removed schedule";
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function installLaunchd(bin: string): string {
  const dir = path.join(homedir(), "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  const plist = path.join(dir, `${LABEL}.plist`);
  const log = path.join(TOKSCAN_DIR, "launchd.log");
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(bin)}</string><string>sync</string><string>--quiet</string></array>
  <key>StartInterval</key><integer>${INTERVAL_MIN * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`,
  );
  const domain = `gui/${process.getuid!()}`;
  run(["launchctl", "bootout", `${domain}/${LABEL}`], true);
  if (!run(["launchctl", "bootstrap", domain, plist]).ok && !run(["launchctl", "load", "-w", plist]).ok) {
    throw new Error(`launchctl could not load ${plist}`);
  }
  return `launchd agent ${LABEL} (every ${INTERVAL_MIN} min)`;
}

function installLinux(bin: string): string {
  const hasSystemd = run(["systemctl", "--user", "show-environment"], true).ok;
  if (hasSystemd) {
    const dir = path.join(homedir(), ".config", "systemd", "user");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "tokscan.service"),
      `[Unit]\nDescription=tokscan sync\n\n[Service]\nType=oneshot\nExecStart="${bin.replace(/(["\\])/g, "\\$1")}" sync --quiet\nNice=10\n`,
    );
    writeFileSync(
      path.join(dir, "tokscan.timer"),
      `[Unit]\nDescription=tokscan every ${INTERVAL_MIN} min\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=${INTERVAL_MIN}min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
    );
    run(["systemctl", "--user", "daemon-reload"]);
    run(["systemctl", "--user", "enable", "--now", "tokscan.timer"]);
    return `systemd user timer (every ${INTERVAL_MIN} min)`;
  }
  const cur = run(["crontab", "-l"], true);
  const lines = (cur.ok ? cur.out : "").split("\n").filter((l) => l && !l.includes("# tokscan"));
  const q = `'${bin.replace(/'/g, `'\\''`)}'`;
  lines.push(`*/${INTERVAL_MIN} * * * * ${q} sync --quiet >/dev/null 2>&1 # tokscan`);
  const r = Bun.spawnSync(["crontab", "-"], { stdin: new TextEncoder().encode(lines.join("\n") + "\n") });
  if (r.exitCode !== 0) throw new Error("no systemd user session and crontab failed; run `tokscan sync` some other way");
  return `cron (every ${INTERVAL_MIN} min)`;
}

function installWindows(bin: string): string {
  // conhost --headless runs the console exe without flashing a window.
  // Single quotes in a PowerShell '...' string are escaped by doubling.
  const arg = `--headless "${bin}" sync --quiet`.replace(/'/g, "''");
  const ps = `
$ErrorActionPreference = 'Stop'
$a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument '${arg}'
$t = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${INTERVAL_MIN})
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '${TASK}' -Action $a -Trigger $t -Settings $s -Description 'tokscan: AI token usage sync' -Force | Out-Null
`;
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  const r = run(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]);
  if (!r.ok) throw new Error(`Register-ScheduledTask failed: ${r.out}`);
  return `scheduled task '${TASK}' (every ${INTERVAL_MIN} min)`;
}
