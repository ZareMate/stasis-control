#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WHISPER_DIR="$ROOT/whisper.cpp"
MODEL_DIR="$ROOT/models"
MODEL_NAME="${WHISPER_MODEL_NAME:-small.en}"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required"
  exit 1
fi

if ! command -v cmake >/dev/null 2>&1; then
  echo "cmake is required"
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required for Discord voice audio conversion"
  echo "Install it with: sudo apt install ffmpeg"
  exit 1
fi

if [ ! -d "$WHISPER_DIR/.git" ]; then
  echo "Cloning whisper.cpp..."
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$WHISPER_DIR"
fi

echo "Building whisper-cli..."
if [ -n "${WHISPER_CMAKE_ARGS:-}" ]; then
  cmake -S "$WHISPER_DIR" -B "$WHISPER_DIR/build" $WHISPER_CMAKE_ARGS
else
  cmake -S "$WHISPER_DIR" -B "$WHISPER_DIR/build"
fi
cmake --build "$WHISPER_DIR/build" -j --config Release --target whisper-cli

mkdir -p "$MODEL_DIR"

if [ ! -f "$MODEL_DIR/ggml-${MODEL_NAME}.bin" ]; then
  echo "Downloading Whisper ${MODEL_NAME} model..."
  bash "$WHISPER_DIR/models/download-ggml-model.sh" "$MODEL_NAME"
  cp "$WHISPER_DIR/models/ggml-${MODEL_NAME}.bin" "$MODEL_DIR/ggml-${MODEL_NAME}.bin"
fi

echo "Whisper STT ready."
echo "Binary: $WHISPER_DIR/build/bin/whisper-cli"
echo "Model:  $MODEL_DIR/ggml-${MODEL_NAME}.bin"
