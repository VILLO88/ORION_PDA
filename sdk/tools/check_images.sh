#!/bin/sh
# Checks the .obm format and the dithering modes: right size, and different
# results for different algorithms. Judging the picture itself is a job for
# obm_view.py and your eyes.
set -e
cd "$(dirname "$0")"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "images: skipped (needs ffmpeg)"; exit 0
fi

ffmpeg -v error -f lavfi -i "gradients=s=200x100:c0=black:c1=white:d=1" \
       -frames:v 1 -y "$T/g.png"

for m in threshold fs atkinson bayer4 bayer8; do
  ./image.py "$T/g.png" "$T/$m.obm" --dither "$m" >/dev/null
  n=$(wc -c < "$T/$m.obm" | tr -d ' ')
  # 12-byte header + 25 bytes per row * 100 rows
  [ "$n" = "2512" ] || { echo "images: $m gives $n bytes instead of 2512"; exit 1; }
done

if cmp -s "$T/fs.obm" "$T/bayer4.obm"; then
  echo "images: fs and bayer4 give the same file"; exit 1
fi
if cmp -s "$T/threshold.obm" "$T/fs.obm"; then
  echo "images: threshold and fs give the same file"; exit 1
fi

./obm_view.py "$T/fs.obm" "$T/r.png" >/dev/null
echo "images: format and dithering ok (5 modes)"
