#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd -- "$APP_DIR/../.." && pwd)"
NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"

cd "$APP_DIR"
export PATH="$APP_DIR/node_modules/.bin:$REPO_DIR/node_modules/.bin:$PATH"

required_node=""
if [ -f "$APP_DIR/.nvmrc" ]; then
  required_node="$(tr -d '[:space:]' < "$APP_DIR/.nvmrc")"
fi
[ -n "$required_node" ] || { echo "$APP_DIR/.nvmrc no fija Node" >&2; exit 1; }

if [ -n "$required_node" ] && [ "${SHERLOCK_WITH_MISE_NODE:-}" != "1" ] && [ -s "$NVM_SH" ]; then
  # shellcheck source=/dev/null
  source "$NVM_SH"

  if ! nvm use --silent >/dev/null; then
    {
      echo "Could not activate Node from .nvmrc (${required_node}); falling back to active node on PATH."
      echo "If the next version check fails, run: cd \"$APP_DIR\" && nvm install ${required_node} && nvm use"
    } >&2
  fi
fi

if [ -n "$required_node" ] && [ "${SHERLOCK_WITH_MISE_NODE:-}" != "1" ]; then
  if command -v mise >/dev/null 2>&1; then
    if ! node -e "process.exit(process.versions.node === process.argv[1] ? 0 : 1)" "$required_node" >/dev/null 2>&1; then
      mise_node_dir="$(mise where "node@${required_node}")"
      if [ -z "$mise_node_dir" ] || [ ! -x "$mise_node_dir/bin/node" ]; then
        echo "mise could not resolve Node ${required_node}." >&2
        exit 1
      fi
      export SHERLOCK_WITH_MISE_NODE=1
      export PATH="$mise_node_dir/bin:$PATH"
      exec bash "$SCRIPT_DIR/with-project-node.sh" "$@"
    fi
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node is not available. Install Node ${required_node}, then try again." >&2
  exit 1
fi

node_version="$(node -v)"

if ! node -e "process.exit(process.versions.node === process.argv[1] ? 0 : 1)" "$required_node"; then
  {
    echo "This project requires Node ${required_node}, but the active Node is ${node_version}."
    echo "Active node path: $(command -v node)"
    echo "Run: cd \"$APP_DIR\" && nvm install ${required_node} && nvm use"
    echo "Or:  cd \"$APP_DIR\" && mise x -- bun run <script>"
  } >&2
  exit 1
fi

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"

exec "$@"
