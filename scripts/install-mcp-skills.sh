#!/usr/bin/env bash
# Install / refresh Digit MCP agent skills from GitHub main (always current).
# Copies create-digit-app and update-digit-app into a skills directory.
#
# Usage:
#   ./scripts/install-mcp-skills.sh              # .agents/skills if present, else ~/.cursor/skills
#   ./scripts/install-mcp-skills.sh --user       # ~/.cursor/skills
#   ./scripts/install-mcp-skills.sh /path/to/dir # that directory
set -euo pipefail

REPO="${DIGIT_APPS_STARTER_REPO:-Digit-Technologies/digit-apps-starter}"
REF="${DIGIT_APPS_STARTER_REF:-main}"
ARCHIVE_URL="https://github.com/${REPO}/archive/refs/heads/${REF}.tar.gz"

dest=""
if [[ "${1:-}" == "--user" ]]; then
  dest="${HOME}/.cursor/skills"
elif [[ -n "${1:-}" ]]; then
  dest="$1"
elif [[ -d .agents/skills ]]; then
  dest=".agents/skills"
else
  dest="${HOME}/.cursor/skills"
fi

mkdir -p "$dest"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$ARCHIVE_URL" | tar -xz -C "$tmp"

src="$(find "$tmp" -type d -path '*/.agents/skills' | head -n1)"
if [[ -z "$src" || ! -d "${src}/create-digit-app" || ! -d "${src}/update-digit-app" ]]; then
  echo "install-mcp-skills: could not find both skills in ${ARCHIVE_URL}" >&2
  exit 1
fi

rm -rf "${dest}/create-digit-app" "${dest}/update-digit-app"
cp -R "${src}/create-digit-app" "${src}/update-digit-app" "$dest"

echo "Installed Digit MCP skills into ${dest} (from ${REPO}@${REF})"
echo "  create-digit-app  — new apps, or edits when source is already on disk"
echo "  update-digit-app  — change a published app from a fresh MCP workspace"
