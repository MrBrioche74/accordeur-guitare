// Accordage standard (guitare 6 cordes)
const STANDARD = [
  { name: "E2", freq: 82.41 },
  { name: "A2", freq: 110.00 },
  { name: "D3", freq: 146.83 },
  { name: "G3", freq: 196.00 },
  { name: "B3", freq: 246.94 },
  { name: "E4", freq: 329.63 },
];

const el = {
  btn: document.getElementById("btnToggle"),
  status: document.getElementById("status"),
  note: document.getElementById("note"),
  freq: document.getElementById("freq"),
  string: document.getElementById("string"),
  cents: document.getElementById("cents"),
  needle: document.getElementById("needle"),
  ok: document.getElementById("ok"),
  hint: document.getElementById("hint"),
};

let audioCtx = null;
let analyser = null;
let source = null;
let stream = null;
let rafId = null;

const bufferSize = 4096;           // stable pour guitare
const minFreq = 70;                // en dessous de E2, marge
const maxFreq = 400;               // au dessus de E4, marge
const yinThreshold = 0.15;         // 0.10–0.20
const okCents = 5;                 // tolérance "OK"

el.btn.addEventListener("click", async () => {
  if (audioCtx) stop();
  else await start();
});

async function start() {
  try {
    // iOS Safari: il faut un geste utilisateur (clic) -> OK ici
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 8192; // pas crucial ici, on lit le buffer en time-domain
    analyser.smoothingTimeConstant = 0.0;

    source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);

    el.status.textContent = "🎤 micro actif";
    el.btn.textContent = "Arrêter";
    el.hint.textContent = "Joue une corde (une seule à la fois).";

    loop();
  } catch (e) {
    console.error(e);
    el.hint.textContent = "Impossible d’accéder au micro. Vérifie les permissions et que tu es en HTTPS.";
    stop();
  }
}

function stop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;

  if (source) source.disconnect();
  source = null;
  analyser = null;

  if (audioCtx) audioCtx.close();
  audioCtx = null;

  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }

  el.status.textContent = "⏹️ arrêté";
  el.btn.textContent = "Démarrer";
  el.note.textContent = "—";
  el.string.textContent = "—";
  el.freq.textContent = "0.00 Hz";
  el.cents.textContent = "0.0 cents";
  el.ok.style.opacity = "0";
  el.needle.style.left = "50%";
  el.hint.textContent = "Appuie sur “Démarrer”, accepte le micro, puis joue une corde.";
}

function loop() {
  const buf = new Float32Array(bufferSize);
  analyser.getFloatTimeDomainData(buf);

  // gate simple (RMS) pour éviter le bruit
  const rms = Math.sqrt(buf.reduce((s, v) => s + v*v, 0) / buf.length);
  if (rms > 0.01) {
    const sr = audioCtx.sampleRate;
    const f0 = yin(buf, sr, minFreq, maxFreq, yinThreshold);
    if (f0) updateUI(f0);
  }

  rafId = requestAnimationFrame(loop);
}

function updateUI(freq) {
  el.freq.textContent = `${freq.toFixed(2)} Hz`;

  const nearest = nearestString(freq);
  if (!nearest) return;

  const { target, cents } = nearest;

  el.string.textContent = `cible: ${target.name} (${target.freq.toFixed(2)} Hz)`;
  el.cents.textContent = `${cents >= 0 ? "+" : ""}${cents.toFixed(1)} cents`;

  // Note la plus proche (pour affichage)
  const { name } = freqToNote(freq);
  el.note.textContent = name;

  // Aiguille: -50..+50 cents -> 0..100%
  const clamped = Math.max(-50, Math.min(50, cents));
  const pct = (clamped + 50) / 100; // 0..1
  el.needle.style.left = `${pct * 100}%`;

  el.ok.style.opacity = (Math.abs(cents) <= okCents) ? "1" : "0";
}

function nearestString(freq) {
  if (!isFinite(freq) || freq <= 0) return null;
  let best = null;
  for (const t of STANDARD) {
    const cents = 1200 * Math.log2(freq / t.freq);
    if (!best || Math.abs(cents) < Math.abs(best.cents)) best = { target: t, cents };
  }
  return best;
}

function freqToNote(freq) {
  const A4 = 440;
  const midi = 69 + 12 * Math.log2(freq / A4);
  const nearest = Math.round(midi);
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const idx = ((nearest % 12) + 12) % 12;
  const octave = Math.floor(nearest / 12) - 1;
  return { name: `${names[idx]}${octave}`, midi: nearest };
}

// --- YIN (version simple, suffisante pour une corde)
function yin(x, sampleRate, minFreq, maxFreq, threshold) {
  const n = x.length;
  const maxTau = Math.min(Math.floor(n / 2), Math.floor(sampleRate / minFreq));
  const minTau = Math.max(2, Math.floor(sampleRate / maxFreq));
  if (minTau >= maxTau) return null;

  const d = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i + tau < n; i++) {
      const diff = x[i] - x[i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }

  const cmndf = new Float32Array(maxTau + 1);
  cmndf[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    running += d[tau];
    cmndf[tau] = running === 0 ? 1 : (d[tau] * tau) / running;
  }

  let tauEstimate = -1;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (cmndf[tau] < threshold) {
      while (tau + 1 <= maxTau && cmndf[tau + 1] < cmndf[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }
  if (tauEstimate === -1) return null;

  // interpolation parabolique
  const betterTau = parabolic(cmndf, tauEstimate);
  if (!isFinite(betterTau) || betterTau <= 0) return null;

  return sampleRate / betterTau;
}

function parabolic(arr, tau) {
  const t0 = Math.max(1, tau - 1);
  const t1 = tau;
  const t2 = Math.min(arr.length - 1, tau + 1);
  const s0 = arr[t0], s1 = arr[t1], s2 = arr[t2];

  const a = (s0 + s2 - 2 * s1) / 2;
  if (Math.abs(a) < 1e-12) return t1;

  const b = (s2 - s0) / 2;
  const shift = -b / (2 * a);
  return t1 + shift;
}
