#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

if [[ -f "$ENV_FILE" ]]; then
  if [[ -r "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  elif [[ -z "${PYPI_API_TOKEN:-}" ]]; then
    echo "Cannot read $ENV_FILE and PYPI_API_TOKEN is not set." >&2
    exit 1
  fi
fi

if [[ -z "${PYPI_API_TOKEN:-}" ]]; then
  echo "Missing PYPI_API_TOKEN in $ENV_FILE" >&2
  exit 1
fi

cd "$ROOT"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install: https://docs.astral.sh/uv/" >&2
  exit 1
fi

if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  uv venv "$ROOT/.venv"
fi

uv pip install --python "$ROOT/.venv/bin/python" -e ".[dev]" pip
"$ROOT/.venv/bin/python" -m build
TWINE_USERNAME=__token__ TWINE_PASSWORD="$PYPI_API_TOKEN" \
  "$ROOT/.venv/bin/twine" upload dist/*

echo
echo "Published to PyPI:"
echo "  pip install bytifi"
