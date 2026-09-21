#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="$ROOT/models"
MODEL_NAME="vosk-model-small-en-us-0.15"
URL="https://alphacephei.com/vosk/models/${MODEL_NAME}.zip"
ZIP="$MODELS_DIR/${MODEL_NAME}.zip"

mkdir -p "$MODELS_DIR"

if [ -d "$MODELS_DIR/$MODEL_NAME" ]; then
  echo "Vosk model already exists: $MODELS_DIR/$MODEL_NAME"
  exit 0
fi

command -v curl >/dev/null 2>&1 || {
  echo "curl is required"
  exit 1
}

command -v unzip >/dev/null 2>&1 || {
  echo "unzip is required"
  exit 1
}

echo "Downloading $MODEL_NAME..."
curl -L --fail --progress-bar "$URL" -o "$ZIP"

echo "Extracting..."
unzip -q "$ZIP" -d "$MODELS_DIR"
rm -f "$ZIP"

echo "Installed: $MODELS_DIR/$MODEL_NAME"
