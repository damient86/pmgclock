// clock.js — PMG Talking Clock upgrade to an audio sprite-based approach to
// try and sidestep some quirks with loading 80 tiny audio files before launch
// this version includes some tactics to deal with browser audio autoplay limitations.

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const SPRITE_URL   = 'clock_sprite.wav';        // approx ~10mb wav has h
// approx ~10mb wav
// PCM wav chosen over compressed audio to ensure timing remains exact
const MANIFEST_URL = 'manifest.json';

// How often to tick the scheduler
const SCHED_TICK_MS = 100; // 10 Hz
// Minimum lead time (s) we try to have before a boundary when scheduling
const MIN_LEAD_S = 0.2;

// ─────────────────────────────────────────────────────────────────────────────
// Globals
// ─────────────────────────────────────────────────────────────────────────────
let ctx = null;
let spriteBuffer = null;
let manifest = null;

let unlocked = false;
let started  = false;
let lastScheduledBoundary = null; // epoch seconds (wall-clock) of last scheduled boundary

// Simple logger (writes to the log window on the main page - verbosity of log greatly
// reduced over previous versions - enough to diagnose autoplay issues...
function log(...args) {
  try {
    const el = document.getElementById('log');
    if (el) {
      const line = `[${new Date().toLocaleTimeString()}] ${args.join(' ')}`;
      el.textContent += line + '\n';
      el.scrollTop = el.scrollHeight;
    }
  } catch {}
  // console always
  console.log('[clock]', ...args);
}

// Live clock (safe if #liveClock not present)
(function ensureLiveClock() {
  const el = document.getElementById('liveClock');
  if (!el) return;
  const fmt = () => {
    const d = new Date();
    el.textContent = d.toLocaleTimeString();
  };
  fmt();
  setInterval(fmt, 500);
})();

// ─────────────────────────────────────────────────────────────────────────────
function dBtoLinear(db) { return Math.pow(10, db / 20); }

function getEntry(label) {
  const e = manifest[label];
  if (!e) {
    log('Missing label:', label);
  }
  return e;
}

function entryDur(label) {
  const e = getEntry(label);
  return e ? e[1] : 0;
}

function seqDuration(labels) {
  return labels.reduce((sum, l) => sum + entryDur(l), 0);
}

function makeSource(label, whenCtxTime, gainDb = 0) {
  const e = getEntry(label);
  if (!e) return null;
  const [offset, dur] = e;

  const src = ctx.createBufferSource();
  src.buffer = spriteBuffer;

  const gain = ctx.createGain();
  gain.gain.value = dBtoLinear(gainDb);

  src.connect(gain).connect(ctx.destination);
  src.start(whenCtxTime, offset, dur);
  return src;
}

// Pull the synchronised clock video back to
// the start frame when then announcement restarts
function restartSyncVideo() {
  const v = document.getElementById('syncVideo');
  if (!v) return;
  try { v.currentTime = 0; } catch(_) {}
  const p = v.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Label mapping — see manifest.json
// minutes "01".."59"; hour "hour_01".."hour_12"; seconds phrase; plus pips.
// ─────────────────────────────────────────────────────────────────────────────
function labelMinute(m) {
  // minutes 1 to 59 as "01" - "59"
  // on the hour "oclock" will be used
  return String(m).padStart(2, '0');
}

function labelHour12(h24) {
  const h12 = ((h24 + 11) % 12) + 1; // 0->12, 13->1, etc.
  return `hour_${String(h12).padStart(2, '0')}`;
}

function labelSecondsPhrase(s) {
  // 0 => precisely; otherwise and_10_seconds / 20 / 30 / 40 / 50
  if (s === 0) return 'precisely';
  return `and_${String(s).padStart(2, '0')}_seconds`;
}

// Build the announcement sequence for the NEXT boundary
function buildAnnouncementLabels(nextDate) {
  const h = nextDate.getHours();
  const m = nextDate.getMinutes();
  const s = nextDate.getSeconds(); // should be 0/10/20/30/40/50

  const labels = [];
  labels.push('at_the_third_stroke');  // intro
  labels.push(labelHour12(h));         // hour

  if (m === 0) {
    labels.push('oclock');
  } else {
    labels.push(labelMinute(m));
  }

  labels.push(labelSecondsPhrase(s));  // precisely / and NN seconds
  labels.push('pips');                 // three beeps

  return labels;
}

// Timing schedule constructed so that the final pips should lands
// directly on the boundary - the end of the 10 second block.
function scheduleAnnouncementForBoundary(nextBoundaryWallSec) {
  const nextDate = new Date(nextBoundaryWallSec * 1000);
  const labels = buildAnnouncementLabels(nextDate);
  const totalDur = seqDuration(labels);

  const nowWall = Date.now() / 1000;
  const wallSecondsUntilBoundary = nextBoundaryWallSec - nowWall;

  //const whenCtxStart = ctx.currentTime + Math.max(0, wallSecondsUntilBoundary - totalDur);
  //FINE ADJUSTMENT FOR TIMING -- WORKS ON MY PC...?
const whenCtxStart = ctx.currentTime + Math.max(0, (wallSecondsUntilBoundary + 0.5) - totalDur);

  log('Scheduling boundary', new Date(nextBoundaryWallSec * 1000).toLocaleTimeString(),
      `in ${ (whenCtxStart - ctx.currentTime).toFixed(3) }s, block len ${ totalDur.toFixed(3) }s`);

  let t = whenCtxStart;
  const gainDb = 0; // master trim if needed
  for (const label of labels) {
    const e = getEntry(label);
    if (!e) continue;
    const dur = e[1];
    makeSource(label, t, gainDb);
    t += dur;
  }

  restartSyncVideo();
  lastScheduledBoundary = nextBoundaryWallSec;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading & unlock
// ─────────────────────────────────────────────────────────────────────────────
async function initAudioContext() {
  if (ctx) return ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });

  // 1-sample silent blip unlock (helps in iframes/iOS)
  const silentBuf = ctx.createBuffer(1, 1, ctx.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = silentBuf;
  src.connect(ctx.destination);
  try { src.start(0); } catch(_) {}
  try { await ctx.resume(); } catch(_) {}

  log('AudioContext state:', ctx.state);
  return ctx;
}

async function loadSpriteAndManifest() {
  // Assumes ctx already created by initAudioContext()
  const [audioArrBuf, manifestJson] = await Promise.all([
    fetch(SPRITE_URL).then(r => {
      if (!r.ok) throw new Error(`Failed to fetch ${SPRITE_URL}: ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch(MANIFEST_URL).then(r => {
      if (!r.ok) throw new Error(`Failed to fetch ${MANIFEST_URL}: ${r.status}`);
      return r.json();
    }),
  ]);
  spriteBuffer = await ctx.decodeAudioData(audioArrBuf);
  manifest = manifestJson;
  log('Sprite & manifest loaded');
}

async function startAfterUnlock() {
  if (started) return;
  started = true;
  await loadSpriteAndManifest();
  schedulerLoop(); // kick the scheduler
}

function attachUnlockOnce() {
  const handler = async () => {
    try {
      await initAudioContext();
      unlocked = true;
      detach();
      await startAfterUnlock();
    } catch (e) {
      console.error('Unlock/start failed:', e);
      log('Unlock/start failed:', e.message || e);
    }
  };

  const detach = () => {
    ['pointerdown','click','keydown','touchstart','mousedown','mouseup']
      .forEach(ev => window.removeEventListener(ev, handler, {capture:true}));
    document.removeEventListener('visibilitychange', visHandler);
  };

  const visHandler = async () => {
    if (document.visibilityState === 'visible' && !unlocked) {
      await handler();
    }
  };

  ['pointerdown','click','keydown','touchstart','mousedown','mouseup']
    .forEach(ev => window.addEventListener(ev, handler, {once:true, capture:true}));
  document.addEventListener('visibilitychange', visHandler);

  log('Waiting for first user gesture to start audio…');
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler loop
// ─────────────────────────────────────────────────────────────────────────────
function schedulerLoop() {
  if (!started || !spriteBuffer || !manifest) return;

  const nowWall = Date.now() / 1000;
  const nextBoundary = Math.ceil(nowWall / 10) * 10;

  // Build labels to know total duration (for back-timing)
  const labels = buildAnnouncementLabels(new Date(nextBoundary * 1000));
  const totalDur = seqDuration(labels);

  const timeUntil = nextBoundary - nowWall;

  // Decide which boundary to target:
  // If we don't have enough runway to back-time cleanly, use the FOLLOWING boundary
  // this should stop an announcement block from playing as soon as audio is ready
  // which will not only be incorrect but will also overlap into the next announcement
  // and sound like trash
  const targetBoundary =
    (timeUntil < totalDur + MIN_LEAD_S) ? (nextBoundary + 10) : nextBoundary;

  // Only schedule each boundary once
  if (lastScheduledBoundary !== targetBoundary) {
    scheduleAnnouncementForBoundary(targetBoundary);
  }

  setTimeout(schedulerLoop, SCHED_TICK_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Page lifecycle helpers (resume audio on focus/pageshow)
// ─────────────────────────────────────────────────────────────────────────────
window.addEventListener('focus',  () => { if (ctx && ctx.state !== 'running') ctx.resume(); });
window.addEventListener('pageshow',() => { if (ctx && ctx.state !== 'running') ctx.resume(); });

// Start: DO NOT create/resume AudioContext here. Wait for gesture.
window.addEventListener('load', () => {
  attachUnlockOnce();
});
