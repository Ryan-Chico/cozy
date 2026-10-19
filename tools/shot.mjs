/**
 * shot.mjs — screenshot the running page with headless Chrome, and print any
 * console errors it produced.
 *
 *   node tools/shot.mjs [url] [out.png] [width] [height]
 *
 * Drives Chrome over the DevTools protocol so it can wait for the model to
 * finish loading (window.__creekReady) instead of guessing at a delay.
 * WebGL runs on SwiftShader, so it is slow but real.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL_ = process.argv[2] || 'http://127.0.0.1:5173/';
const OUT = process.argv[3] || 'shot.png';
const W = Number(process.argv[4] || 1200);
const H = Number(process.argv[5] || 675);
const PORT = Number(process.env.CDP_PORT || 9333);
const WAIT_MS = Number(process.env.WAIT_MS || 90000);

const profile = join(tmpdir(), `creek-shot-${Date.now()}`);
mkdirSync(dirname(OUT), { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--disable-component-update',
  '--disable-sync', '--disable-default-apps', '--disable-translate',
  '--hide-scrollbars', '--mute-audio', '--no-sandbox',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=' + W + ',' + H,
  'about:blank',
], { stdio: 'ignore' });

const logs = [];
let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rej(new Error(`timeout on ${method}`));
      }
    }, 60000);
  });
}

async function findPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint never appeared');
}

function cleanup(code) {
  try { ws && ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

const wsUrl = await findPage();
ws = new WebSocket(wsUrl);

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(new Error(JSON.stringify(msg.error)));
    else res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || [])
      .map((a) => a.value ?? a.description ?? a.type).join(' ');
    logs.push(`[${msg.params.type}] ${text}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push(`[EXCEPTION] ${d.text} ${d.exception?.description || ''}`);
  }
  if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    if (e.level === 'error' || e.level === 'warning') {
      logs.push(`[${e.level}] ${e.text} ${e.url || ''}`);
    }
  }
});

await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 1, mobile: false,
});

await send('Page.navigate', { url: URL_ });

const started = Date.now();
let state = 'loading';
while (Date.now() - started < WAIT_MS) {
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const fb = document.getElementById('fallback');
      if (fb && fb.style.display === 'grid') return 'fallback';
      if (window.__creekReady) return 'ready';
      return 'loading';
    })()`,
    returnByValue: true,
  });
  state = r.result.value;
  if (state !== 'loading') break;
  await sleep(500);
}

const info = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    state: ${JSON.stringify(state)},
    gl: (() => { try {
      const c = document.createElement('canvas');
      const g = c.getContext('webgl2') || c.getContext('webgl');
      if (!g) return 'none';
      const d = g.getExtension('WEBGL_debug_renderer_info');
      return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
    } catch (e) { return 'err ' + e.message } })(),
    size: [innerWidth, innerHeight],
    errs: (window.__creekErrors || []).length
  })`,
  returnByValue: true,
});

// let the water settle and the fireflies blink for a moment before shooting
await sleep(Number(process.env.SETTLE_MS || 4000));

// Optional first-frame probe, for A/B checks that need a "before" value:
//   EVAL="window.__m0 = __creek.monster.object.position.toArray()"
// Sits before MOVES so it captures the undisturbed scene.
if (process.env.EVAL) {
  const r = await send('Runtime.evaluate', {
    expression: process.env.EVAL, returnByValue: true,
  });
  if (r.exceptionDetails) console.log('[EVAL threw]', r.exceptionDetails.text);
  else if (r.result && r.result.value !== undefined) console.log('[EVAL]', r.result.value);
}

// Optional pointer drive, for checking the interactive bits in a still:
//   MOVES="300,300 420,380 560,440"  move the cursor through those points
// and leave a trail of ripple rings behind it.
if (process.env.MOVES) {
  const pts = process.env.MOVES.trim().split(/\s+/).map((p) => p.split(',').map(Number));
  const steps = Number(process.env.MOVE_STEPS || 6);
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: x0 + (x1 - x0) * t,
        y: y0 + (y1 - y0) * t,
        button: 'none',
      });
      await sleep(Number(process.env.MOVE_MS || 55));
    }
  }
  await sleep(Number(process.env.AFTER_MOVE_MS || 120));
}

// Drag to look:  DRAG="800,400,1100,430"
if (process.env.DRAG) {
  const [x0, y0, x1, y1] = process.env.DRAG.split(',').map(Number);
  const steps = Number(process.env.DRAG_STEPS || 12);
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1,
  });
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: x0 + (x1 - x0) * t,
      y: y0 + (y1 - y0) * t,
      button: 'left',
      buttons: 1,
    });
    await sleep(Number(process.env.DRAG_MS || 45));
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1,
  });
  await sleep(Number(process.env.AFTER_DRAG_MS || 150));
}

// Hold keys:  KEYS="KeyW:1500,KeyD:700"
const KEY_CODES = {
  KeyW: ['w', 87], KeyA: ['a', 65], KeyS: ['s', 83], KeyD: ['d', 68],
  KeyR: ['r', 82], ShiftLeft: ['Shift', 16],
};
if (process.env.KEYS) {
  for (const item of process.env.KEYS.split(',')) {
    const [code, ms] = item.split(':');
    const [key, vk] = KEY_CODES[code.trim()] || ['', 0];
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown', code: code.trim(), key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
    await sleep(Number(ms || 600));
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp', code: code.trim(), key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
    await sleep(Number(process.env.BETWEEN_KEYS_MS || 140));
  }
  await sleep(Number(process.env.AFTER_KEYS_MS || 300));
}

const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));

// Optional second frame with something changed in between, for A/B checks:
//   OUT2=... EVAL2="__creek.sun.castShadow = false"
if (process.env.OUT2) {
  if (process.env.EVAL2) {
    const r = await send('Runtime.evaluate', {
      expression: process.env.EVAL2, returnByValue: true,
    });
    if (r.exceptionDetails) console.log('[EVAL2 threw]', r.exceptionDetails.text);
    else if (r.result && r.result.value !== undefined) console.log('[EVAL2]', r.result.value);
  }
  await sleep(Number(process.env.AFTER2_MS || 900));
  const shot2 = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  writeFileSync(process.env.OUT2, Buffer.from(shot2.data, 'base64'));
  console.log('wrote', process.env.OUT2);
}

console.log('state:', state, 'elapsed:', ((Date.now() - started) / 1000).toFixed(1) + 's');
console.log('page:', info.result.value);
if (logs.length) {
  console.log('--- console ---');
  for (const l of logs.slice(0, 40)) console.log(l);
} else {
  console.log('--- console: clean ---');
}
console.log('wrote', OUT);

cleanup(0);
