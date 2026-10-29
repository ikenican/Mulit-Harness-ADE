#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
plugin_root="$(cd -- "$script_dir/../../.." && pwd)"
target="${1:-$PWD}"

exec bash "$plugin_root/install.sh" "$target"
