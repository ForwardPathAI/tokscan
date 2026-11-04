# tokscan installer for Windows (also reads logs from WSL distros).
#   irm https://github.com/ForwardPathAI/tokscan/releases/latest/download/install.ps1 | iex
# Env: TOKSCAN_VERSION=v0.1.0 to pin, TOKSCAN_NO_SCHEDULE=1 to only download.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is very slow with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = 'ForwardPathAI/tokscan'
$version = if ($env:TOKSCAN_VERSION) { $env:TOKSCAN_VERSION } else { 'latest' }
$asset = 'tokscan-windows-x64.exe'
$base = if ($version -eq 'latest') { "https://github.com/$repo/releases/latest/download" } else { "https://github.com/$repo/releases/download/$version" }

$root = if ($env:TOKSCAN_HOME) { $env:TOKSCAN_HOME } else { Join-Path $env:USERPROFILE '.tokscan' }
$dir = Join-Path $root 'bin'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$exe = Join-Path $dir 'tokscan.exe'
$tmp = "$exe.download"

Write-Host "Downloading $asset..."
Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $tmp
$sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/checksums.txt").Content
if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
$line = ($sums -split "`n") | Where-Object { $_ -match " $([regex]::Escape($asset))\s*$" } | Select-Object -First 1
if (-not $line) { Remove-Item $tmp -Force; throw "no checksum for $asset" }
$want = ($line -split '\s+')[0].ToLower()
$got = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLower()
if ($want -ne $got) { Remove-Item $tmp -Force; throw "checksum mismatch for $asset" }

# A scheduled sync may be running the old exe: Windows lets us rename it, not overwrite it.
if (Test-Path $exe) {
  Get-ChildItem -Path $dir -Filter 'tokscan.exe.old*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Move-Item -Force $exe "$exe.old-$([DateTime]::UtcNow.Ticks)"
}
Move-Item -Force $tmp $exe

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $dir)) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ";$dir"), 'User')
  $env:Path += ";$dir"
  Write-Host "Added $dir to your PATH (new terminals pick it up)."
}

if ($env:TOKSCAN_NO_SCHEDULE -eq '1') { & $exe version } else { & $exe install }
