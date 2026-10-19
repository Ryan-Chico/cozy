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
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

// The DevTools client is the platform's own WebSocket. Node 20 has one, but only
// behind --experimental-websocket; 22 exposes it by default. Fail in a sentence
// rather than with a bare ReferenceError halfway into the run.
if (typeof WebSocket === 'undefined') {
  console.error(`tools/shot.mjs needs Node 22 or newer (this is ${process.version}).`);
  process.exit(1);
}

// Where Chrome lives is platform business, not something every caller should have
// to know. CHROME still wins if it is set; otherwise take the first of the usual
// places that exists, which is what lets the same script run on a laptop and on
// the ubuntu runner.
const CHROME = process.env.CHROME || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((path) => existsSync(path)) || 'google-chrome';
const URL_ = process.argv[2] || 'http://127.0.0.1:5173/';
const OUT = process.argv[3] || 'shot.png';
const W = Number(process.argv[4] || 1200);
const H = Number(process.argv[5] || 675);
const PORT = Number(process.env.CDP_PORT || 9333);
const WAIT_MS = Number(process.env.WAIT_MS || 90000);
// anything else Chrome needs, e.g. EXTRA_FLAGS="--force-prefers-reduced-motion"
const EXTRA = (process.env.EXTRA_FLAGS || '').trim().split(/\s+/).filter(Boolean);

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
  ...EXTRA,
  'about:blank',
], { stdio: 'ignore' });

const logs = [];
let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}, timeoutMs = 60000) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rej(new Error(`timeout on ${method}`));
      }
    }, timeoutMs);
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

/** Runtime.evaluate, with the exception explained rather than just "Uncaught". */
async function evaluate(expression, label) {
  const r = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true },
    // Driving the clock is the documented way to test anything slow, and a few
    // simulated minutes is a lot of synchronous work in one call. The default
    // one-minute cutoff would turn a slow check into a failed one.
    Number(process.env.EVAL_TIMEOUT_MS || 300000),
  );
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown';
    console.log(`[${label} threw]`, String(desc).split('\n')[0]);
  } else if (r.result && r.result.value !== undefined) {
    console.log(`[${label}]`, r.result.value);
  }
}

// Optional first-frame probe, for A/B checks that need a "before" value:
//   EVAL="window.__m0 = __creek.monster.object.position.toArray()"
// Sits before MOVES so it captures the undisturbed scene.
if (process.env.EVAL) await evaluate(process.env.EVAL, 'EVAL');

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
  if (process.env.EVAL2) await evaluate(process.env.EVAL2, 'EVAL2');
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

// The page's error list is read now rather than at 'ready', because the run does
// not end at ready: a model can finish loading — and fail to place itself — during
// the settle, and the EVAL, MOVES, DRAG and KEYS hooks all run after it. Checking
// the count from the top of the run would miss every one of those, which is most
// of what this tool is for.
const errProbe = await send('Runtime.evaluate', {
  expression: 'window.__creekErrors || []',
  returnByValue: true,
});
const pageErrors = errProbe.result?.value || [];
if (pageErrors.length) {
  console.log(`--- page errors (${pageErrors.length}) ---`);
  for (const e of pageErrors.slice(0, 10)) console.log('  ' + String(e).split('\n')[0]);
} else {
  console.log('--- page errors: none ---');
}

// Exit non-zero when the page never came up, so CI can act on it. The shots are
// written either way — a failing run is exactly when you want to look at the
// frame. ALLOW_ERRORS=1 is the escape hatch for when the error is the thing
// being investigated.
const faults = [];
if (state !== 'ready') faults.push(`page state is "${state}"`);
if (pageErrors.length) faults.push(`${pageErrors.length} error(s) recorded by the page`);
if (faults.length && process.env.ALLOW_ERRORS !== '1') {
  console.log('FAILED —', faults.join('; '));
  cleanup(1);
}

cleanup(0);
