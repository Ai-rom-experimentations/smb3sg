// Minimal but faithful SG-1000 harness for headless verification.
//   node sgemu.mjs <rom.sg> <frames> <outPrefix> [dumpEvery] [padScript]
// padScript: "frame:buttons,frame:buttons" e.g. "30:r,120:ra"  (r/l/a/b/u/d)
// Dumps <prefix>_NNNN.ppm (256x192) and prints RAM state each dump.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const bases = [
  new URL('./node_modules/', import.meta.url).pathname,
  new URL('../tools/node_modules/', import.meta.url).pathname,
  '/tmp/tools/',
];
let require;
for (const b of bases) {
  const r = createRequire(b + 'index.js');
  try { r.resolve('@specy/z80'); require = r; break; } catch {}
}
if (!require) { console.error('npm install in sg1000/tools first'); process.exit(1); }
const { Z80Machine } = require('@specy/z80');

const [romPath, framesArg, outPrefix, dumpEveryArg, script] = process.argv.slice(2);
const frames = parseInt(framesArg || '60', 10);
const dumpEvery = parseInt(dumpEveryArg || '0', 10);
const rom = fs.readFileSync(romPath);

// ---- pad script ----
const scriptEvents = [];
if (script) {
  for (const part of script.split(',')) {
    const [f, b] = part.split(':');
    let m = 0;
    for (const c of (b || '')) {
      if (c === 'r') m |= 1; else if (c === 'l') m |= 2;
      else if (c === 'a') m |= 4; else if (c === 'b') m |= 8;
      else if (c === 'u') m |= 16; else if (c === 'd') m |= 32;
    }
    scriptEvents.push([parseInt(f, 10), m]);
  }
}
let padMask = 0;
function padAt(frame) {
  let m = 0;
  for (const [f, mm] of scriptEvents) if (frame >= f) m = mm;
  return m;
}

// ---- VDP (TMS9918A) ----
const vram = new Uint8Array(16384);
const regs = new Uint8Array(8);
let latch = 0, pending = 0, vaddr = 0, readBuf = 0;
let intFlag = 0, fifthFlag = 0, collFlag = 0, fifthNum = 0;

const TMS_RGB = [
  [0,0,0],[0,0,0],[33,200,66],[94,220,120],[84,85,237],[125,118,252],
  [212,82,77],[66,235,245],[252,85,84],[255,121,120],[212,193,84],[230,206,128],
  [33,176,59],[201,91,180],[204,204,204],[255,255,255],
];

// ---- PSG (SN76489) write log ----
const psgLog = [];

// ---- machine ----
const machine = new Z80Machine({
  memory: new Uint8Array(65536),
  initialSp: 0xC400,
  onMemoryRead: (a) => {
    if (a < rom.length) return rom[a];
    if (a < 0xC000) return 0xFF;           // open bus
    return undefined;                       // RAM
  },
  onMemoryWrite: (a, v) => {
    if (a < 0xC000) return true;            // ROM area: ignore
    if (a >= 0xC400) return true;           // outside 1K RAM: ignore
    return false;                           // RAM
  },
  onPortWrite: (p, v) => {
    p &= 0xFF;
    if (p === 0xBE) {                       // VDP data
      vram[vaddr] = v;
      vaddr = (vaddr + 1) & 0x3FFF;
    } else if (p === 0xBF) {                // VDP ctrl
      if (!pending) { latch = v; pending = 1; }
      else {
        const code = v >> 6;
        vaddr = (((v & 0x3F) << 8) | latch) & 0x3FFF;
        pending = 0;
        if (code === 0) { readBuf = vram[vaddr]; vaddr = (vaddr + 1) & 0x3FFF; }
        else if (code & 2) { regs[v & 7] = latch; }
      }
    } else if (p === 0x7F || p === 0x7E) {  // PSG
      psgLog.push(v);
    }
  },
  onPortRead: (p) => {
    p &= 0xFF;
    if (p === 0xBE) { const b = readBuf; readBuf = vram[vaddr]; vaddr = (vaddr + 1) & 0x3FFF; return b; }
    if (p === 0xBF) {
      const st = (intFlag << 7) | (fifthFlag << 6) | (collFlag << 5) | (fifthNum & 0x1F);
      intFlag = 0; fifthFlag = 0; collFlag = 0;
      return st;
    }
    if (p === 0xC0) {
      // active low: bit=0 when pressed.  bit3 right, bit2 left, bit4 A, bit5 B, bit0 up, bit1 down
      let v = 0xFF;
      if (padMask & 1) v &= ~0x08;
      if (padMask & 2) v &= ~0x04;
      if (padMask & 4) v &= ~0x10;
      if (padMask & 8) v &= ~0x20;
      if (padMask & 16) v &= ~0x01;
      if (padMask & 32) v &= ~0x02;
      return v;
    }
    if (p === 0xC1) return 0xFF;
    return 0xFF;
  },
});
machine.loadBinary(rom, 0, 0);

// ---- rendering ----
const fb = new Uint8Array(256 * 192 * 3);
function renderFrame() {
  const bd = regs[7] & 0x0F;
  const gm2 = (regs[0] & 0x02) !== 0;
  const ntBase = (regs[2] << 10) & 0x3C00;
  const pgBase0 = (regs[4] & 0x07) << 11;      // 0 for SG-1000 GM2
  const ctBase0 = 0x2000;                       // R3=$FF on TMS
  const size16 = (regs[1] & 0x02) !== 0;
  const satBase = (regs[5] & 0x7F) << 7;
  const spgBase = (regs[6] & 0x07) << 11;
  // per-line sprite pixels
  const sprLine = new Int16Array(256).fill(-1);
  for (let y = 0; y < 192; y++) {
    // sprites for this line
    sprLine.fill(-1);
    let cnt = 0;
    const list = [];
    for (let s = 0; s < 32; s++) {
      const Y = vram[satBase + s * 4];
      if (Y === 0xD0) break;
      let sy = (Y + 1) & 0xFF;
      if (sy > 224) sy -= 256;
      const h = size16 ? 16 : 8;
      let ry = y - sy;
      if (ry < 0 || ry >= h) continue;
      if (cnt === 4) { fifthFlag = 1; fifthNum = s; break; }
      cnt++;
      list.push([s, sy, ry]);
    }
    // draw back-to-front (highest index first)
    for (let i = list.length - 1; i >= 0; i--) {
      const [s, sy, ry] = list[i];
      const X = vram[satBase + s * 4 + 1];
      const pat = vram[satBase + s * 4 + 2];
      const col = vram[satBase + s * 4 + 3] & 0x0F;
      if (col === 0) continue;
      let sx = X;
      if (vram[satBase + s * 4 + 3] & 0x80) sx -= 32;
      if (sx > 224) sx -= 256;
      const w = size16 ? 16 : 8;
      for (let rx = 0; rx < w; rx++) {
        const x = sx + rx;
        if (x < 0 || x > 255) continue;
        let byte;
        if (size16) {
          const p = (pat & 0xFC) + (ry >= 8 ? 1 : 0) + (rx >= 8 ? 2 : 0);
          byte = vram[spgBase + p * 8 + (ry & 7)];
        } else {
          byte = vram[spgBase + pat * 8 + ry];
        }
        if (byte & (0x80 >> (rx & 7))) {
          if (sprLine[x] >= 0) collFlag = 1;
          sprLine[x] = col;
        }
      }
    }
    // background
    const sec = y >> 6, row = y & 7;
    for (let col32 = 0; col32 < 32; col32++) {
      const name = vram[ntBase + (y >> 3) * 32 + col32];
      let patB, colB;
      if (gm2) {
        const off = sec * 0x800 + name * 8 + row;
        patB = vram[pgBase0 + off];
        colB = vram[ctBase0 + off];
      } else {
        patB = vram[pgBase0 + name * 8 + row];
        colB = vram[ctBase0 + (name >> 3)];
      }
      const fg = colB >> 4, bg = colB & 0x0F;
      for (let b = 0; b < 8; b++) {
        const x = col32 * 8 + b;
        let idx = (patB & (0x80 >> b)) ? fg : bg;
        if (idx === 0) idx = bd;
        let c = idx;
        if (sprLine[x] >= 0) c = sprLine[x];
        const o = (y * 256 + x) * 3;
        fb[o] = TMS_RGB[c][0]; fb[o+1] = TMS_RGB[c][1]; fb[o+2] = TMS_RGB[c][2];
      }
    }
  }
}
function dumpPPM(path) {
  const hdr = Buffer.from(`P6\n256 192\n255\n`, 'ascii');
  fs.writeFileSync(path, Buffer.concat([hdr, Buffer.from(fb)]));
}

// ---- main loop ----
const T_PER_LINE = 228, LINES = 262;
let t = 0;
const mem = machine.memory;
function rd16(a) { return mem[a] | (mem[a+1] << 8); }
for (let f = 0; f < frames; f++) {
  padMask = padAt(f);
  for (let line = 0; line < LINES; line++) {
    machine.run({ maxTStates: T_PER_LINE });
    t += T_PER_LINE;
    if (line === 192) intFlag = 1;
  }
  renderFrame();
  if (dumpEvery && (f % dumpEvery === 0)) {
    const name = `${outPrefix}_${String(f).padStart(4, '0')}.ppm`;
    dumpPPM(name);
    const px = rd16(0xC000), py = rd16(0xC002);
    const xv = mem[0xC004], yv = mem[0xC006];
    console.log(`f=${f} px=${px} py=${py} xvel=${xv} yvel=${yv} onG=${mem[0xC009]} frame=${mem[0xC00D]} cam=${rd16(0xC00F)} fcnt=${rd16(0xC02F)} R1=${regs[1].toString(16)} R7=${regs[7].toString(16)}`);
  }
}
console.log(`ran ${frames} frames; psg writes: ${psgLog.length}`);
if (process.env.PNTDUMP) {
  // settle: step until the CPU is mid-spin in WaitVBlank (pc at the
  // in-instruction twice) so the dump never catches a half-drawn sweep
  const WV = 0x148;
  let seen = 0;
  for (let g = 0; g < 400000 && seen < 2; g++) {
    if (machine.z80.regs.pc === WV) seen++;
    machine.step();
  }
  fs.writeFileSync(process.env.PNTDUMP, Buffer.from(vram.slice(0x1800, 0x1B00)));
  fs.writeFileSync(process.env.PNTDUMP + '.cam', Buffer.from([mem[0xC00F], mem[0xC010], mem[0xC00E]]));
}
if (process.env.VDUMP) {
  const h = (a, n) => Array.from(vram.slice(a, a + n)).map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log('PGT0  :', h(0x0000, 24));
  console.log('PGT1  :', h(0x0800, 24));
  console.log('PNT   :', h(0x1800, 32));
  console.log('PNTrow1:', h(0x1820, 32));
  console.log('PNTrow21:', h(0x1800+21*32, 32));
  console.log('PNTrow22:', h(0x1800+22*32, 32));
  console.log('CT0   :', h(0x2000, 24));
  console.log('CT1   :', h(0x2800, 24));
  console.log('SPAT  :', h(0x3800, 24));
  console.log('SAT   :', h(0x3F00, 16));
  console.log('OVL   :', h(0xC040, 16));
  console.log('regs  :', Array.from(regs).map(b => b.toString(16)).join(' '));
}
if (psgLog.length) console.log('psg head:', psgLog.slice(0, 24).map(b => b.toString(16)).join(' '));
