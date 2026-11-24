#!/usr/bin/env bash
# Downloads the embedder files from the Hugging Face hub, pinned to one revision, into models/.
# The same files are used to embed the docs at build time and the question on the phone.
set -euo pipefail
ID="Xenova/bge-small-en-v1.5"
REV="${MODEL_REVISION:-ea104dacec62c0de699686887e3f920caeb4f3e3}"
DEST="${MODELS_DIR:-$(dirname "$0")/../models}/$ID"
mkdir -p "$DEST/onnx"
for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json onnx/model_quantized.onnx; do
  [ -s "$DEST/$f" ] && continue
  echo "fetching $f"
  curl -fsSL --retry 3 "https://huggingface.co/$ID/resolve/$REV/$f" -o "$DEST/$f"
done
sha256sum "$DEST/onnx/model_quantized.onnx"
