#!/bin/sh
# The same picture in logical and in panel layout must draw identically, at
# y = 0, at a y that is a multiple of 8, and at an unaligned y. A wrong
# transposition shows up flipped in groups of eight.
#
# On the PC this checks the transposition only: the emulator has one byte
# per pixel, so there is no speed difference to see.
set -e
cd "$(dirname "$0")"

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
APP=../emulator/card/apps
DATA=$APP/data/checkobm
mkdir -p "$DATA"

if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "panel layout: skipped (needs ffmpeg)"
    exit 0
fi
if [ ! -x ../emulator/orion-emu ]; then
    echo "panel layout: skipped (build the emulator first: make -C ../emulator)"
    exit 0
fi

ffmpeg -v error -f lavfi -i "testsrc2=size=200x120" -frames:v 1 -y "$T/t.png"
./image.py "$T/t.png" "$DATA/log.obm" --width 200 --height 120 --dither bayer8 >/dev/null
./image.py "$T/t.png" "$DATA/pan.obm" --width 200 --height 120 --dither bayer8 --panel >/dev/null

# there and back must give the same file, byte for byte
./obm_panel.py "$DATA/log.obm" "$T/there.obm" >/dev/null
./obm_panel.py "$T/there.obm" "$T/back.obm" --logical >/dev/null
if ! cmp -s "$DATA/log.obm" "$T/back.obm"; then
    echo "panel layout: there and back does not match, obm_panel.py is wrong"
    exit 1
fi
if ! cmp -s "$T/there.obm" "$DATA/pan.obm"; then
    echo "panel layout: obm_panel.py and image.py --panel disagree"
    exit 1
fi

cat > "$APP/checkobm.lua" <<'LUA'
function init()
    local a = orion.gfx.image("data/log.obm")
    local b = orion.gfx.image("data/pan.obm")
    if not a or not b then print("NOT LOADED"); orion.sys.exit(); return end
    orion.gfx.clear(orion.WHITE); a:draw(0, 0);   orion.gfx.present()
    orion.gfx.clear(orion.WHITE); b:draw(0, 0);   orion.gfx.present()
    orion.gfx.clear(orion.WHITE); a:draw(20, 64); orion.gfx.present()
    orion.gfx.clear(orion.WHITE); b:draw(20, 64); orion.gfx.present()
    orion.gfx.clear(orion.WHITE); a:draw(37, 60); orion.gfx.present()
    orion.gfx.clear(orion.WHITE); b:draw(37, 60); orion.gfx.present()
end
function update() orion.sys.exit() end
LUA

( cd ../emulator && SDL_VIDEODRIVER=dummy ORION_SNAPSHOTS="$T/i" \
      ./orion-emu card apps/checkobm.lua >/dev/null 2>&1 ) || true
rm -f "$APP/checkobm.lua"
rm -rf "$DATA"

n=0
for pair in "000 001 at_y=0" "002 003 at_y=64" "004 005 at_unaligned_y=60"; do
    set -- $pair
    if [ ! -f "$T/i$1.pgm" ] || [ ! -f "$T/i$2.pgm" ]; then
        echo "panel layout: the emulator wrote no snapshots"
        exit 1
    fi
    if ! cmp -s "$T/i$1.pgm" "$T/i$2.pgm"; then
        echo "panel layout: different $3, the transposition is wrong"
        exit 1
    fi
    n=$((n + 1))
done

echo "panel layout: both layouts draw the same ($n comparisons), round trip ok"
