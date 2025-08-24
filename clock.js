const $ = (s)=>document.querySelector(s);
function log(msg){
  const el=$('#log');
  const t=new Date().toLocaleTimeString();
  el.textContent += `[${t}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

// Live clock updater
function updateClock() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  $('#liveClock').textContent = `${h}:${m}:${s}`;
}
setInterval(updateClock, 1000);
window.addEventListener('load', updateClock);

let ctx;
let buffers = new Map();
let ticker = null;
let playing = false;

const BASE_PATH = './gordon_gow/';
const INTERVAL = 10;   // always 10 seconds
const GAP_MS   = 120;  // fixed spacing between clips

// ▶︎ Calibration: start this many seconds early so the pips land on the boundary
const AUDIO_LEAD_SEC = -1.0; // tweak to taste

const FILES = {
  preamble: 'at_the_third_stroke.wav',
  hours: Array.from({length:12}, (_,i)=>`hour_${String(i+1).padStart(2,'0')}.wav`),
  minutes: [ 'oclock.wav', ...Array.from({length:59}, (_,i)=>`${String(i+1).padStart(2,'0')}.wav`) ],
  seconds: {
    0: 'precisely.wav',
    10: 'and_10_seconds.wav',
    20: 'and_20_seconds.wav',
    30: 'and_30_seconds.wav',
    40: 'and_40_seconds.wav',
    50: 'and_50_seconds.wav'
  },
  pips: 'pips.wav'
};

function allNeededFiles(){
  return Array.from(new Set([FILES.preamble, ...FILES.hours, ...FILES.minutes, ...Object.values(FILES.seconds), FILES.pips]));
}

async function fetchBuffer(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`Fetch failed: ${url}`);
  const ab = await res.arrayBuffer();
  return await ctx.decodeAudioData(ab.slice(0));
}

async function load(relPath){
  if(buffers.has(relPath)) return buffers.get(relPath);
  const buf = await fetchBuffer(BASE_PATH+relPath);
  buffers.set(relPath, buf);
  return buf;
}

async function preloadAll(){
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
  buffers.clear();
  const files = allNeededFiles();
  log(`Preloading ${files.length} files from ${BASE_PATH}`);
  for(const f of files){
    try { await load(f); log(`✓ ${f}`); }
    catch(e){ log(`✗ ${f} — ${e.message}`); }
  }
  $('#startBtn').disabled = false;
  $('#onceBtn').disabled = false;
}

function nextAlignedDate(interval){
  const now = new Date();
  const s = Math.floor(now.getSeconds() / interval) * interval + interval;
  const next = new Date(now.getTime());
  next.setSeconds(s, 0);
  if(next <= now) next.setSeconds(s + interval, 0);
  return next;
}

function toHour12(h){ const hh = h % 12; return hh === 0 ? 12 : hh; }

function buildSequence(target){
  const seq = [];
  seq.push(FILES.preamble);
  const hour = toHour12(target.getHours());
  seq.push(`hour_${String(hour).padStart(2,'0')}.wav`);
  const minute = target.getMinutes();
  if(minute === 0){ seq.push('oclock.wav'); }
  else { seq.push(`${String(minute).padStart(2,'0')}.wav`); }
  const s = target.getSeconds();
  const secMap = FILES.seconds;
  if(s === 0 && secMap[0]) seq.push(secMap[0]);
  else if(secMap[s]) seq.push(secMap[s]);
  seq.push(FILES.pips);
  return seq;
}

// --- VIDEO SYNC: restart the video exactly when the announcement starts ---
function syncVideoAt(whenCtxTime){
  const vid = document.getElementById('syncVideo');
  if(!vid || !ctx) return;
  const delayMs = Math.max(0, (whenCtxTime - ctx.currentTime) * 1000);
  window.setTimeout(() => {
    try {
      vid.pause();
      vid.currentTime = 0;
      // Ensure autoplay can proceed on mobile: keep muted + playsinline on the element
      const p = vid.play();
      if (p && typeof p.catch === 'function') {
        p.catch(()=>{/* ignore autoplay race conditions */});
      }
    } catch(e) { /* no-op */ }
  }, delayMs);
  log(`Video re-sync scheduled in ${(delayMs/1000).toFixed(2)}s`);
}

async function playSequenceAt(when, relList){
  let t = when;
  for(const rel of relList){
    const buf = await load(rel);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(t);
    t += buf.duration + (GAP_MS/1000);
  }
  return t;
}

async function scheduleOne(interval){
  let target = nextAlignedDate(interval);
  let seq = buildSequence(target);

  let totalDur = 0;
  for (const rel of seq) {
    const buf = await load(rel);
    totalDur += buf.duration + (GAP_MS/1000);
  }

  let deltaToBoundary = (target.getTime() - Date.now()) / 1000;
  let startDelay = deltaToBoundary - totalDur;

  if (startDelay < 0) {
    target = new Date(target.getTime() + interval * 1000);
    seq = buildSequence(target);
    totalDur = 0;
    for (const rel of seq) {
      const buf = await load(rel);
      totalDur += buf.duration + (GAP_MS/1000);
    }
    deltaToBoundary = (target.getTime() - Date.now()) / 1000;
    startDelay = deltaToBoundary - totalDur;
  }

  // Apply calibration lead so playback finishes right on the boundary
  startDelay -= AUDIO_LEAD_SEC;

  const when = ctx.currentTime + Math.max(0, startDelay);
  log(`Scheduling: ${target.toLocaleTimeString()} — starts in ${Math.max(0, startDelay).toFixed(2)}s (lead ${AUDIO_LEAD_SEC}s) — ${seq.join(' , ')}`);

  // ⏱ Sync video to the exact start of this announcement block
  syncVideoAt(when);

  await playSequenceAt(when, seq);
}

async function sayOnceNow(){ await scheduleOne(INTERVAL); }

async function start(){
  if(playing) return; playing = true;
  $('#startBtn').disabled = true; $('#stopBtn').disabled = false; $('#onceBtn').disabled = true;
  await scheduleOne(INTERVAL);
  ticker = setInterval(()=>scheduleOne(INTERVAL), INTERVAL*1000);
}

function stop(){
  if(!playing) return; playing = false;
  $('#startBtn').disabled = false; $('#stopBtn').disabled = true; $('#onceBtn').disabled = false;
  if(ticker){ clearInterval(ticker); ticker = null; }
}

$('#startBtn').addEventListener('click', start);
$('#stopBtn').addEventListener('click', stop);
$('#onceBtn').addEventListener('click', sayOnceNow);

window.addEventListener('load', preloadAll);
