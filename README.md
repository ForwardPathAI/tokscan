# tokscan

tokscan measures how many AI tokens each project uses, and what they would cost at API rates. It needs no API keys or proxies, and engineers don't have to change how they work.

Coding agents already write token counts to local log files. tokscan reads those logs, matches each model call to the git repo it ran in, and sends hourly totals to PostHog. Engineers keep using whatever tools and subscriptions they like.

| Tool | Where it reads |
|---|---|
| Claude Code (CLI, desktop, IDE, T3 Code) | `~/.claude/projects/**/*.jsonl` |
| Codex (CLI, app, T3 Code) | `~/.codex/sessions/**/*.jsonl[.zst]`, `~/.codex/state_*.sqlite` |
| OpenCode | `~/.local/share/opencode/opencode.db` |

On Windows it also reads the same folders inside every WSL distro.

Cursor is not covered yet. It keeps no token counts on disk, so it will need the Cursor Admin API.

## Install

macOS / Linux:

```sh
curl -fsSL https://github.com/ForwardPathAI/tokscan/releases/latest/download/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://github.com/ForwardPathAI/tokscan/releases/latest/download/install.ps1 | iex
```

The installer does four things:

1. Downloads one binary to `~/.tokscan/bin` and checks its SHA-256.
2. Schedules `tokscan sync` every 15 minutes, using launchd on macOS, a systemd user timer or cron on Linux, and Task Scheduler on Windows.
3. Runs a first sync, which sends the history already on disk.
4. Identifies you by `git config --global user.email`. To change it: `tokscan config email you@forwardpath.ai`.

If you run Windows with WSL, install the Windows version only, since it reads WSL logs too. The Linux installer refuses to run inside WSL so the same usage isn't counted twice.

## What it sends

It sends one `tokscan_usage` event per source log, model, repo, branch and UTC hour:

```json
{
  "event": "tokscan_usage",
  "distinct_id": "you@forwardpath.ai",
  "timestamp": "2026-11-04T14:00:00.000Z",
  "properties": {
    "tool": "claude", "model": "claude-opus-5-5",
    "repo": "github.com/forwardpathai/fp-os", "branch": "mack/pod-1860-x", "issue": "POD-1860",
    "calls": 42, "input_tokens": 120, "output_tokens": 31000,
    "cache_read_tokens": 4100000, "cache_write_tokens": 160000,
    "cost_usd": 3.71, "env": "native", "os": "darwin", "tokscan_version": "0.1.0"
  }
}
```

It never sends prompts, code, file contents or file paths.

Only repos that match the allowlist (default `github.com/forwardpathai/`) are sent by name. Usage in any other repo is sent as `(other)`, with no name and no branch.

To add client orgs, run `tokscan config allow github.com/forwardpathai/,bitbucket.org/some-client/`.

Run `tokscan preview` to see exactly what the next sync will send, without sending it.

## Commands

```
tokscan report [--days 30] [--by repo,tool,model,branch,issue,day,month] [--csv out.csv]
tokscan preview [--fresh]
tokscan sync
tokscan status
tokscan config [key [value]]
tokscan update
tokscan uninstall [--purge]
```

`tokscan report` is local only. It shows your own usage by repo, model or issue, and sends nothing.

## How the numbers work

- **Dollars are API-equivalent, not real spend.** Each call is priced at list rates from the [LiteLLM price list](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json). That includes cache read/write rates and long-context tiers. Your subscriptions cost less, so to cost a project, take its share of total API-equivalent dollars and apply it to the real subscription bill.
- **Claude Code** writes one log line per content block, each repeating the same usage. tokscan keeps one row per message and request ID.
- **Codex** logs running totals, so tokscan takes the difference between consecutive snapshots. Codex also compresses older sessions to `.jsonl.zst`, and those files keep their sync history.
- **OpenCode** records its own cost per message, and tokscan uses it.
- **Repo matching** first asks git for the session folder's `origin` remote. If the folder is gone (for example, a deleted worktree), it falls back to the remote Codex recorded, then to the T3 worktree name, then `gone:<folder>`.
- These numbers match [`ccusage`](https://github.com/ryoppippi/ccusage) to within about 3% on the same logs.

## Sync behaviour

- **Only complete UTC hours are sent**, with a 5-minute grace period, so data lags by up to about 1h20m.
- **No double sends.** Each log file has a watermark, so an hour is never sent twice. Event UUIDs come from the bucket key, so if a sync dies halfway, PostHog drops the repeats.
- **Fast reruns.** Unchanged files are skipped, so a typical run takes under a second.
- **Self-update.** Sync checks for a new release once a day. To turn this off: `tokscan config autoUpdate false` or `TOKSCAN_NO_UPDATE=1`.
- **Logs** go to `~/.tokscan/sync.log`.

## PostHog queries

AI cost by repo, last 30 days:

```sql
SELECT properties.repo AS repo, round(sum(toFloat(properties.cost_usd)), 2) AS api_usd
FROM events
WHERE event = 'tokscan_usage' AND timestamp > now() - INTERVAL 30 DAY
GROUP BY repo ORDER BY api_usd DESC
```

## Development

```sh
bun install
bun test
bun run dev report --by repo,tool
TOKSCAN_HOME=/tmp/ts TOKSCAN_POSTHOG_KEY=phc_x bun run dev preview
bun run build                      # all targets into dist/
```

Environment overrides:

- `TOKSCAN_HOME`: state folder, default `~/.tokscan`.
- `TOKSCAN_EMAIL`: your identity.
- `TOKSCAN_ALLOW`: the repo allowlist, comma-separated.
- `TOKSCAN_POSTHOG_KEY` and `TOKSCAN_POSTHOG_HOST`: where events go.
- `TOKSCAN_NO_UPDATE=1`: turns off self-update.
- `TOKSCAN_NO_WSL=1`: skips WSL scanning on Windows.

## Releasing

1. Set the repo variable `TOKSCAN_POSTHOG_KEY` (Settings → Secrets and variables → Variables). This is the PostHog project API key. It can only send events, so it is safe to build into the binary.
2. Tag and push:

   ```sh
   git tag v0.1.0 && git push origin v0.1.0
   ```

The `release` workflow then:

1. Builds all five binaries on macOS, so the Mac builds get a code signature.
2. Smoke-tests them on Linux x64, Linux arm64 and Windows.
3. Publishes the binaries, `install.sh`, `install.ps1` and `checksums.txt` as a GitHub release.

The install URLs above always point at the latest release.

The repo must be public for the `curl` / `irm` installers to work without a GitHub login.
