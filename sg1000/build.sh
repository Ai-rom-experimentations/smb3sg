#!/bin/sh
# Build the SG-1000 ROM:  sg1000/out/smb3sg.sg (32K)
set -e
cd "$(dirname "$0")"
python3 tools/extract_mario.py
python3 tools/make_tiles.py
python3 tools/make_level.py
if [ -z "$MAZ" ]; then
  for c in "$(dirname "$0")/tools/node_modules/.bin/maz" /tmp/tools/node_modules/.bin/maz; do
    [ -x "$c" ] && MAZ="$c" && break
  done
fi
[ -z "$MAZ" ] && { echo "maz not found: npm install in sg1000/tools or set MAZ" >&2; exit 1; }
$MAZ -s src/main.z80 -o out/main.bin -l out/main.lst
python3 tools/pad_rom.py out/main.bin out/smb3sg.sg
echo "built out/smb3sg.sg"
