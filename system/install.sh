#!/usr/bin/env bash
set -euo pipefail
workspace="${1:?usage: install.sh /full/path/to/workspace}"
workspace="${workspace%/}"
[ -d "$workspace/scripts" ] || { echo "not a workspace: $workspace (scripts/ missing)" >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
target="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$target"
for unit in collab-ingest.service collab-ingest.timer collab-publish.service collab-publish.timer; do
  sed "s|__WORKSPACE__|$workspace|g" "$here/$unit" > "$target/$unit"
  echo "installed $target/$unit"
done
echo "run: systemctl --user daemon-reload && systemctl --user enable --now collab-ingest.timer collab-publish.timer"
