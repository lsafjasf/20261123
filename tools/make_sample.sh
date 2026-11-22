#!/usr/bin/env bash
# Generates a synthetic "sports replay" clip: 12s, 30fps, H.264 + AAC.
# Fixed 1s GOPs (with B-frames) so keyframe-seek logic is exercised.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p media
ffmpeg -y -loglevel error \
  -f lavfi -i "testsrc2=size=960x540:rate=30:duration=12" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=12" \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p \
  -g 30 -keyint_min 30 -sc_threshold 0 \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  media/sample.mp4
# Same clip without B-frames, to test both reorder paths.
ffmpeg -y -loglevel error \
  -f lavfi -i "testsrc2=size=960x540:rate=30:duration=12" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=12" \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p \
  -g 30 -keyint_min 30 -sc_threshold 0 -bf 0 \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  media/sample-nobf.mp4
echo "wrote media/sample.mp4 and media/sample-nobf.mp4"
