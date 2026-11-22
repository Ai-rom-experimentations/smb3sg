# SMB3 -> Sega SG-1000 port

Five things, that's it: SMB3's physics, Mario's sprites, some sounds, a
scrolling camera and a test level. Z80 + TMS9918A VDP + SN76489 PSG.

## Build

    sh sg1000/build.sh            # needs maz (Z80 assembler) on PATH or $MAZ

Produces `sg1000/out/smb3sg.sg` (32 KB cartridge).

Pipeline: `tools/extract_mario.py` (SMB3 CHR -> 3-colour 16x16 sprite
groups) -> `tools/make_tiles.py` (background tiles) -> `tools/make_level.py`
(24x176 test level) -> maz -> `tools/pad_rom.py`.

## Test (headless)

    node sg1000/test/sgemu.mjs <rom> <frames> <outPrefix> [dumpEvery] [padScript]

`sgemu.mjs` is a small faithful SG-1000 harness (Z80 via @specy/z80,
TMS9918A Graphics II + sprites, SN76489 write log, joypad script).
padScript example: `"40:r,120:ra,200:l"` (r/l/u/d/a/b). It dumps PPM
frames and prints px/py/xvel/yvel/onGround/frame/cam each dump.

`sg1000/test/emulate.mjs` runs the same ROM in the Genesis Plus GX libretro
WASM core (real-hardware-accurate cross-check; frames match sgemu ~99.7%).

## What is in the box

1. Physics: SMB3 PRG008 walk/run/skid/jump/gravity constants, 4.4 fixed
   point integration, wiggly counter, tile collision (see src/physics.z80).
2. Mario: 16x16 sprites composited from three one-colour sprites
   (red / skin / dark) so he matches his SMB3 look within the TMS limit;
   stand, walk x2, run x2, jump, skid frames, both facings.
3. Sounds: SN76489 byte-burst streams - jump sweep, coin, bump, skid noise.
4. Camera: clamped follow cam streaming whole name-table columns.
5. Test level: ground, pits, pipes, brick/? blocks, stairs, clouds, end wall.
