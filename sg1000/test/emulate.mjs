// Minimal headless libretro frontend for the Genesis Plus GX WASM core,
// used to verify the SG-1000 ROM: runs scripted input and dumps frames.
//
// usage: node emulate.mjs <rom.sg> <frames> <outprefix> [script]
// script: comma separated  frame:buttons  pairs, buttons = r,l,a,b letters
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const coreBase = ['../tools/node_modules/', './node_modules/', '/tmp/tools/node_modules/']
  .map(p => new URL(p + 'romdev-core-gpgx/wasm/genesis_plus_gx_libretro.js', import.meta.url).pathname)
  .find(p => fs.existsSync(p));
if (!coreBase) { console.error('romdev-core-gpgx not found: npm install in sg1000/tools'); process.exit(1); }
const corePath = coreBase;

const romPath = process.argv[2];
const nFrames = parseInt(process.argv[3] || '120', 10);
const outPrefix = process.argv[4] || '/tmp/work/frame';
const dumpEvery = parseInt(process.argv[5] || '30', 10);
const scriptArg = process.argv[6] || '';

// input script: "30:r,60:ra,..." -> map frame -> button mask
const script = new Map();
if (scriptArg) {
  for (const part of scriptArg.split(',')) {
    const [f, b] = part.split(':');
    script.set(parseInt(f, 10), b || '');
  }
}
let currentButtons = '';
function buttonsAt(f) {
  if (script.has(f)) currentButtons = script.get(f);
  return currentButtons;
}

const JOY = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11 };

const mod = await import(corePath);
const create = mod.default || mod.create_genesis_plus_gx;

const rom = fs.readFileSync(romPath);

let frameBuf = null, frameW = 0, frameH = 0, framePitch = 0, frameFmt = 0;
let M = null;

const envLog = new Set();

const Module = {
  wasmBinary: fs.readFileSync(corePath.replace(/\.js$/, '.wasm')),
  print: (t) => console.log('CORE:', t),
  printErr: (t) => console.error('COREE:', t),
};

const core = await create(Module);
M = core;

const addFn = (fn, sig) => core.addFunction(fn, sig);

// environment callback: bool environ(unsigned cmd, void *arg)
const envCb = addFn((cmd, arg) => {
  envLog.add(cmd);
  switch (cmd) {
    case 3:  // GET_CAN_DUPE
      M.HEAPU8[arg] = 1;
      return 1;
    case 10: { // SET_PIXEL_FORMAT
      const fmt = M.HEAPU32[arg >> 2];
      frameFmt = fmt;
      return 1;
    }
    case 9: {  // GET_SYSTEM_DIRECTORY
      const p = utf8('/system');
      M.HEAPU32[arg >> 2] = p;
      return 1;
    }
    case 31: { // GET_SAVE_DIRECTORY
      const p = utf8('/saves');
      M.HEAPU32[arg >> 2] = p;
      return 1;
    }
    default:
      return 0;
  }
}, 'iii');

const videoCb = addFn((data, w, h, pitch) => {
  frameW = w; frameH = h; framePitch = pitch;
  if (data === 0) { frameBuf = null; return; }
  frameBuf = M.HEAPU8.slice(data, data + pitch * h);
}, 'viiii');

const audioCb = addFn((l, r) => {}, 'vii');
const audioBatchCb = addFn((buf, frames) => frames, 'iii');
const inputPollCb = addFn(() => {}, 'v');
const inputStateCb = addFn((port, device, index, id) => {
  if (port !== 0 || device !== 1) return 0;
  const b = buttonsAt(frameIndex);
  switch (id) {
    case JOY.right: return b.includes('r') ? 1 : 0;
    case JOY.left: return b.includes('l') ? 1 : 0;
    case JOY.a: return b.includes('a') ? 1 : 0;
    case JOY.b: return b.includes('b') ? 1 : 0;
    case JOY.up: return b.includes('u') ? 1 : 0;
    case JOY.down: return b.includes('d') ? 1 : 0;
    case JOY.start: return b.includes('s') ? 1 : 0;
    default: return 0;
  }
}, 'iiiii');

core._retro_set_environment(envCb);
core._retro_set_video_refresh(videoCb);
core._retro_set_audio_sample(audioCb);
core._retro_set_audio_sample_batch(audioBatchCb);
core._retro_set_input_poll(inputPollCb);
core._retro_set_input_state(inputStateCb);
core._retro_init();

// game info
const romPtr = core._malloc(rom.length);
core.HEAPU8.set(rom, romPtr);
let vfsPath = null;
if (core.FS) {
  vfsPath = '/rom' + (romPath.match(/\.[a-z0-9]+$/i) || ['.sg'])[0];
  try { core.FS.mkdir('/system'); } catch (e) {}
  try { core.FS.mkdir('/saves'); } catch (e) {}
  core.FS.writeFile(vfsPath, rom);
}
function utf8(str) {
  const p = core._malloc(str.length + 1);
  core.stringToUTF8(str, p, str.length + 1);
  return p;
}
const pathStr = utf8(vfsPath || romPath);
const info = core._malloc(32);
core.HEAPU8.fill(0, info, info + 32);
core.HEAPU32[info >> 2] = pathStr;
core.HEAPU32[(info >> 2) + 1] = romPtr;
core.HEAPU32[(info >> 2) + 2] = rom.length;
core.HEAPU32[(info >> 2) + 3] = 0;

let ok = core._retro_load_game(info);
console.log('try1(path+data) ->', ok);
if (!ok) {
  core.HEAPU32[info >> 2] = 0;           // path NULL
  ok = core._retro_load_game(info);
  console.log('try2(data only) ->', ok);
}
if (!ok) {
  const p2 = utf8((vfsPath || romPath).replace(/\.[a-z0-9]+$/i, '.sms'));
  core.HEAPU32[info >> 2] = p2;
  ok = core._retro_load_game(info);
  console.log('try3(.sms path) ->', ok);
}
console.log('load_game ->', ok, 'env cmds seen:', [...envLog].join(','));
if (!ok) process.exit(1);

let frameIndex = 0;
for (let f = 0; f < nFrames; f++) {
  frameIndex = f;
  core._retro_run();
  if (frameBuf && (f % dumpEvery === 0 || f === nFrames - 1)) {
    const raw = Buffer.from(frameBuf.buffer || frameBuf);
    const out = `${outPrefix}_${String(f).padStart(4, '0')}.raw`;
    fs.writeFileSync(out, raw);
    fs.writeFileSync(out + '.meta', JSON.stringify({ w: frameW, h: frameH, pitch: framePitch }));
  }
}
console.log('pixel format:', frameFmt);
console.log('ran', nFrames, 'frames; last frame', frameW, 'x', frameH, 'pitch', framePitch);
console.log('env cmds:', [...envLog].sort((a, b) => a - b).join(','));
