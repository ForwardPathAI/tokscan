#!/bin/sh
# tokscan installer for macOS and Linux.
#   curl -fsSL https://github.com/ForwardPathAI/tokscan/releases/latest/download/install.sh | sh
# Env: TOKSCAN_VERSION=v0.1.0 to pin, TOKSCAN_NO_SCHEDULE=1 to only download.
set -eu

REPO="ForwardPathAI/tokscan"
VERSION="${TOKSCAN_VERSION:-latest}"

err() { echo "tokscan install: $*" >&2; exit 1; }

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) err "unsupported OS $os. On Windows use: irm https://github.com/$REPO/releases/latest/download/install.ps1 | iex" ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) err "unsupported CPU $arch" ;;
esac
# x86 shell under Rosetta on Apple Silicon: use the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

# Inside WSL the Windows build already reads these logs. Installing both would double count.
if [ "$os" = linux ] && grep -qi microsoft /proc/version 2>/dev/null && [ "${TOKSCAN_ALLOW_WSL:-}" != 1 ]; then
  err "this looks like WSL. Install the Windows version instead (it reads WSL logs too):
  irm https://github.com/$REPO/releases/latest/download/install.ps1 | iex
Set TOKSCAN_ALLOW_WSL=1 only if you never install it on the Windows side."
fi

asset="tokscan-$os-$arch"
if [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

dir="${TOKSCAN_HOME:-$HOME/.tokscan}/bin"
mkdir -p "$dir"
tmp="$dir/tokscan.download"

echo "Downloading $asset..."
curl -fsSL "$base/$asset" -o "$tmp" || err "download failed: $base/$asset"
curl -fsSL "$base/checksums.txt" -o "$dir/checksums.txt" || err "could not fetch checksums.txt"

want=$(grep " $asset\$" "$dir/checksums.txt" | awk '{print $1}')
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp" | awk '{print $1}')
else
  got=$(shasum -a 256 "$tmp" | awk '{print $1}')
fi
[ -n "$want" ] && [ "$want" = "$got" ] || { rm -f "$tmp"; err "checksum mismatch for $asset"; }
rm -f "$dir/checksums.txt"

chmod +x "$tmp"
mv -f "$tmp" "$dir/tokscan"

# Put it on PATH via ~/.local/bin when that exists, else tell the user.
if [ -d "$HOME/.local/bin" ]; then
  ln -sf "$dir/tokscan" "$HOME/.local/bin/tokscan"
  echo "Linked ~/.local/bin/tokscan"
else
  echo "Add to PATH:  export PATH=\"$dir:\$PATH\""
fi

if [ "${TOKSCAN_NO_SCHEDULE:-}" = 1 ]; then
  "$dir/tokscan" version
else
  "$dir/tokscan" install
fi
