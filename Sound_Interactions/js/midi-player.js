/**
 * MIDI file playback: load file, select tracks, transpose, speed, play/stop.
 * Drives existing createSynthVoice and triggerVisualsForMidi from main.js.
 */
import { Midi } from '@tonejs/midi';

const MAX_NOTE_DURATION_SEC = 10;
const IS_MOBILE = /iPad|iPhone|Android/i.test(navigator.userAgent);
const LOOKAHEAD_SEC = IS_MOBILE ? 0.14 : 0.2;
const CHUNK_MS = IS_MOBILE ? 32 : 24;
const MIDI_POLY_LIMIT = IS_MOBILE ? 8 : 10;
const BAR_BINS = 256;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SPEED_OPTIONS = [0.5, 0.66, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const TAP_RESET_MS = 2200;
const TAP_MAX_INTERVAL_MS = 2000;
const TAP_MIN_INTERVAL_MS = 180;
const ROLL_WINDOW_SEC = 9.0;
const ENABLE_LEGACY_ROLL = false;

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function midiToName(midi) {
  const m = Math.max(0, Math.min(127, Math.round(midi)));
  const oct = Math.floor(m / 12) - 1;
  return NOTE_NAMES[m % 12] + oct;
}
function trackColor(trackIndex, alpha) {
  const hue = ((trackIndex * 43) + 198) % 360;
  return `hsla(${hue}, 88%, 68%, ${alpha})`;
}
function isPercTrack(track, trackName) {
  if (!track) return false;
  const byChannel = typeof track.channel === 'number' && track.channel === 9;
  const byInstr = !!(track.instrument && track.instrument.percussion);
  const nm = String(trackName || '').toLowerCase();
  const byName = /(drum|perc|kit|beat|kick|snare|hat|tom|ride|crash)/.test(nm);
  return byChannel || byInstr || byName;
}
function gmDrumToType(midi) {
  const m = Math.max(0, Math.min(127, Math.round(midi || 0)));
  if (m === 35 || m === 36) return 'kick';
  if (m === 37) return 'rim';
  if (m === 38 || m === 40) return 'snare';
  if (m === 39) return 'clap';
  if (m === 41 || m === 43) return 'tomLow';
  if (m === 45 || m === 47) return 'tomMid';
  if (m === 42 || m === 44) return 'hatClosed';
  if (m === 46) return 'hatOpen';
  if (m === 49 || m === 57) return 'crash';
  if (m === 51 || m === 59) return 'ride';
  if (m >= 27 && m <= 34) return '808';
  return 'snap';
}
function gmDrumVariant(midi) {
  const m = Math.max(0, Math.min(127, Math.round(midi || 0)));
  if (m === 35) return 'kick_deep';
  if (m === 36) return 'kick_punch';
  if (m === 37) return 'rim_wood';
  if (m === 38) return 'snare_acoustic';
  if (m === 39) return 'clap_wide';
  if (m === 40) return 'snare_tight';
  if (m === 41) return 'tom_floor';
  if (m === 42) return 'hat_closed_tight';
  if (m === 43) return 'tom_floor_bright';
  if (m === 44) return 'hat_pedal';
  if (m === 45) return 'tom_mid_round';
  if (m === 46) return 'hat_open_short';
  if (m === 47) return 'tom_mid_tight';
  if (m === 48) return 'tom_high_round';
  if (m === 49) return 'crash_bright';
  if (m === 50) return 'tom_high_tight';
  if (m === 51) return 'ride_bright';
  if (m === 52) return 'crash_soft';
  if (m === 53) return 'ride_bell';
  if (m === 54) return 'tamb_bright';
  if (m === 55) return 'crash_splash';
  if (m === 56) return 'cowbell';
  if (m === 57) return 'crash_dark';
  if (m === 58) return 'vibra_slap';
  if (m === 59) return 'ride_dark';
  if (m >= 27 && m <= 30) return '808_sub';
  if (m >= 31 && m <= 34) return '808_click';
  return 'snap_dry';
}
function drumTypeToClass(type) {
  const t = String(type || '').toLowerCase();
  const map = {
    kick: 0, snare: 1, '808': 2, clap: 3, hatclosed: 4, hatopen: 5,
    rim: 6, snap: 7, tomlow: 8, tommid: 9, ride: 10, crash: 11
  };
  return map[t] != null ? map[t] : 7;
}
function expressiveVelocity(note, overPoly) {
  const base = clamp01(typeof note.velocity === 'number' ? note.velocity : 0.8);
  const shaped = 0.58 + Math.pow(base, 0.86) * 0.34;
  return overPoly ? Math.max(0.5, shaped * 0.95) : shaped;
}

/**
 * @param {object} api
 * @param {function(number, object)} api.createSynthVoice
 * @param {function(number)} api.triggerVisualsForMidi
 * @param {function()} api.initAudio
 * @param {function()} api.getAudioContext
 */
export function initMidiPlayer(api) {
  const {
    createSynthVoice,
    triggerVisualsForMidi,
    triggerVisualsForMidiDrum,
    playDrumFromMidi,
    initAudio,
    getAudioContext,
    updateKeyDisplayFromMidi,
    setMidiPlaybackState,
    setMidiTransportInfo
  } = api;

  let parsedMidi = null;
  let activeVoices = [];
  let playbackIntervalId = null;
  let endTimeoutId = null;
  let progressWrap = null;
  let progressBar = null;
  let waveCanvas = null;
  let progressFill = null;

  let rollOverlay = null;
  let rollCanvas = null;
  let rollTooltip = null;
  let rollMeta = null;
  let rollInfoLeft = null;
  let rollInfoRight = null;
  let rollHitRegions = [];
  let rollPointerActive = false;
  let rollPointerX = 0;
  let rollPointerY = 0;

  const container = document.createElement('div');
  container.setAttribute('aria-label', 'MIDI player');
  container.className = 'midi-player';

  const fileLabel = document.createElement('label');
  fileLabel.className = 'midi-player-label';
  fileLabel.innerHTML = 'MIDI: <input type="file" accept=".mid,.midi" id="midi-file-input" class="midi-player-file">';
  container.appendChild(fileLabel);

  const controlRow = document.createElement('div');
  controlRow.className = 'midi-player-inline';

  const transposeLabel = document.createElement('label');
  transposeLabel.className = 'midi-player-label';
  transposeLabel.textContent = 'Transpose: ';
  const transposeSelect = document.createElement('select');
  transposeSelect.id = 'midi-transpose';
  transposeSelect.className = 'midi-player-select';
  for (let i = -12; i <= 12; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = i === 0 ? '0' : (i > 0 ? '+' + i : i);
    transposeSelect.appendChild(opt);
  }
  transposeSelect.value = '0';
  transposeLabel.appendChild(transposeSelect);
  controlRow.appendChild(transposeLabel);

  const speedLabel = document.createElement('label');
  speedLabel.className = 'midi-player-label';
  speedLabel.textContent = 'Speed: ';
  const speedSelect = document.createElement('select');
  speedSelect.id = 'midi-speed';
  speedSelect.className = 'midi-player-select';
  for (let i = 0; i < SPEED_OPTIONS.length; i++) {
    const rate = SPEED_OPTIONS[i];
    const opt = document.createElement('option');
    opt.value = String(rate);
    opt.textContent = rate.toFixed(rate % 1 === 0 ? 0 : 2).replace(/\.00$/, '') + 'x';
    speedSelect.appendChild(opt);
  }
  speedSelect.value = '1';
  speedLabel.appendChild(speedSelect);
  controlRow.appendChild(speedLabel);

  const tapBtn = document.createElement('button');
  tapBtn.type = 'button';
  tapBtn.className = 'midi-player-btn midi-player-btn-tap';
  tapBtn.textContent = 'Tap';
  controlRow.appendChild(tapBtn);

  container.appendChild(controlRow);

  const trackList = document.createElement('div');
  trackList.id = 'midi-track-list';
  trackList.className = 'midi-player-tracks';
  container.appendChild(trackList);

  const infoDiv = document.createElement('div');
  infoDiv.id = 'midi-info';
  infoDiv.className = 'midi-player-info';
  container.appendChild(infoDiv);

  const metricsDiv = document.createElement('div');
  metricsDiv.className = 'midi-player-metrics';
  container.appendChild(metricsDiv);

  const btnWrap = document.createElement('div');
  btnWrap.className = 'midi-player-buttons';
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.textContent = 'Play';
  playBtn.disabled = true;
  playBtn.className = 'midi-player-btn';
  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.textContent = 'Stop';
  stopBtn.disabled = true;
  stopBtn.className = 'midi-player-btn';
  btnWrap.appendChild(playBtn);
  btnWrap.appendChild(stopBtn);
  container.appendChild(btnWrap);

  function createProgressUi() {
    progressWrap = document.createElement('div');
    progressWrap.className = 'midi-progress-wrap midi-progress-float';
    progressWrap.dataset.orientation = 'horizontal';
    progressWrap.dataset.playing = '0';
    progressBar = document.createElement('div');
    progressBar.className = 'midi-progress-bar';
    progressBar.setAttribute('aria-label', 'Playback position');

    waveCanvas = document.createElement('canvas');
    waveCanvas.className = 'midi-progress-wave';
    progressFill = document.createElement('div');
    progressFill.className = 'midi-progress-fill';

    progressBar.appendChild(waveCanvas);
    progressBar.appendChild(progressFill);
    progressWrap.appendChild(progressBar);
    progressWrap.style.display = 'none';
    document.body.appendChild(progressWrap);
  }

  function createRollOverlay() {
    if (!ENABLE_LEGACY_ROLL) return;
    rollOverlay = document.createElement('div');
    rollOverlay.className = 'midi-roll-overlay';
    rollOverlay.style.display = 'none';

    rollCanvas = document.createElement('canvas');
    rollCanvas.className = 'midi-roll-canvas';
    rollMeta = document.createElement('div');
    rollMeta.className = 'midi-roll-meta';
    rollMeta.textContent = 'PERSPECTIVE PIANO ROLL';
    rollInfoLeft = document.createElement('div');
    rollInfoLeft.className = 'midi-roll-info midi-roll-info-left';
    rollInfoLeft.textContent = 'TRK 0/0 · BPM — · TAP —';
    rollInfoRight = document.createElement('div');
    rollInfoRight.className = 'midi-roll-info midi-roll-info-right';
    rollInfoRight.textContent = 'NEXT — · ON none';
    rollTooltip = document.createElement('div');
    rollTooltip.className = 'midi-roll-tooltip';
    rollTooltip.style.display = 'none';

    rollOverlay.appendChild(rollCanvas);
    rollOverlay.appendChild(rollMeta);
    rollOverlay.appendChild(rollInfoLeft);
    rollOverlay.appendChild(rollInfoRight);
    rollOverlay.appendChild(rollTooltip);
    document.body.appendChild(rollOverlay);

    rollCanvas.addEventListener('mousemove', (e) => {
      rollPointerActive = true;
      rollPointerX = e.clientX;
      rollPointerY = e.clientY;
      updateRollTooltip(e.clientX, e.clientY);
    });
    rollCanvas.addEventListener('mouseleave', () => {
      rollPointerActive = false;
      if (rollTooltip) rollTooltip.style.display = 'none';
    });
  }

  const barRoot = document.getElementById('player-bar-root');
  if (!barRoot) {
    const floatPanel = document.createElement('div');
    floatPanel.className = 'midi-float-panel';
    floatPanel.appendChild(container);
    document.body.appendChild(floatPanel);
    createProgressUi();
    createRollOverlay();
  } else {
    const playerBar = document.createElement('div');
    playerBar.className = 'player-bar';
    const barInner = document.createElement('div');
    barInner.className = 'player-bar-inner';
    const controlsRow = document.createElement('div');
    controlsRow.className = 'player-controls-row';
    const midiToggle = document.createElement('button');
    midiToggle.type = 'button';
    midiToggle.className = 'player-midi-toggle';
    midiToggle.setAttribute('aria-expanded', 'false');
    midiToggle.textContent = 'MIDI';
    controlsRow.appendChild(btnWrap);
    controlsRow.appendChild(midiToggle);
    barInner.appendChild(controlsRow);
    playerBar.appendChild(barInner);
    const midiDrawer = document.createElement('div');
    midiDrawer.className = 'player-midi-drawer';
    midiDrawer.appendChild(container);
    playerBar.appendChild(midiDrawer);
    barRoot.appendChild(playerBar);
    midiToggle.addEventListener('click', () => {
      const open = midiDrawer.classList.toggle('player-midi-drawer-open');
      midiToggle.setAttribute('aria-expanded', String(open));
    });
    createProgressUi();
    createRollOverlay();
  }

  if (!progressWrap) progressWrap = document.querySelector('.midi-progress-wrap');
  if (!progressBar) progressBar = document.querySelector('.midi-progress-bar');
  if (!waveCanvas && progressBar) waveCanvas = progressBar.querySelector('.midi-progress-wave');
  if (!progressFill && progressBar) progressFill = progressBar.querySelector('.midi-progress-fill');
  if (progressWrap && !progressWrap.dataset.playing) progressWrap.dataset.playing = '0';

  const isVerticalProgress = () => !!(progressWrap && progressWrap.dataset && progressWrap.dataset.orientation === 'vertical');

  let complexityBins = [];
  let pianoRollNotes = [];
  let pianoRollMin = 48;
  let pianoRollMax = 84;
  let totalDuration = 0;
  let playbackStartOffset = 0;
  let segmentStartTime = 0;
  let isPlaying = false;
  let currentNotes = [];
  let currentTranspose = 0;
  let playbackRate = 1;
  let rafId = null;
  let liveMidiNotes = [];
  let lastPolyphony = 0;
  let sourceBpm = 120;
  let tapBpm = 0;
  let tapTimes = [];
  let selectedTrackCount = 0;
  let totalTrackCount = 0;

  function setProgressPlayingState(active) {
    if (!progressWrap) return;
    progressWrap.dataset.playing = active ? '1' : '0';
  }

  function emitPlayback(active) {
    setProgressPlayingState(!!active);
    if (typeof setMidiPlaybackState === 'function') setMidiPlaybackState(!!active);
  }

  function buildRollPreview(nowSec, maxCount) {
    const src = currentNotes.length ? currentNotes : pianoRollNotes;
    if (!src || !src.length) return [];
    const out = [];
    const cap = Math.max(32, maxCount || 180);
    const horizon = nowSec + Math.max(7.2, (ROLL_WINDOW_SEC + 2.8) / Math.max(0.84, playbackRate * 0.9));
    for (let i = 0; i < src.length; i++) {
      const n = src[i];
      const start = typeof n.time === 'number' ? n.time : 0;
      const dur = Math.max(0.02, typeof n.duration === 'number' ? n.duration : 0.2);
      const end = start + dur;
      if (end < nowSec - 0.12) continue;
      if (start > horizon + 0.6) break;
      const drum = !!n.isDrum;
      const outMidi = drum
        ? Math.max(0, Math.min(127, Math.round(n.midi || 0)))
        : Math.max(0, Math.min(127, Math.round((n.midi || 0) + currentTranspose)));
      out.push({
        midi: outMidi,
        velocity: typeof n.velocity === 'number' ? n.velocity : 0.8,
        trackIndex: n.trackIndex | 0,
        ahead: start - nowSec,
        duration: dur,
        time: start,
        isDrum: drum,
        drumType: n.drumType || '',
        drumClass: n.drumClass != null ? n.drumClass : null,
        drumVariant: n.drumVariant || ''
      });
      if (out.length >= cap) break;
    }
    return out;
  }

  function emitTransport() {
    if (typeof setMidiTransportInfo === 'function') {
      const nowSec = getCurrentTime();
      setMidiTransportInfo({
        active: isPlaying,
        speed: playbackRate,
        position: nowSec,
        duration: totalDuration,
        polyphony: lastPolyphony,
        notes: liveMidiNotes.slice(),
        preview: buildRollPreview(nowSec, 260)
      });
    }
  }

  function syncSpeedSelect(rate) {
    const opts = Array.from(speedSelect.options);
    let matched = opts.find(o => Math.abs(parseFloat(o.value) - rate) < 0.0005);
    if (!matched) {
      let custom = speedSelect.querySelector('option[data-custom="1"]');
      if (!custom) {
        custom = document.createElement('option');
        custom.dataset.custom = '1';
        speedSelect.appendChild(custom);
      }
      custom.value = String(rate);
      custom.textContent = `${rate.toFixed(2)}x`;
      matched = custom;
    }
    speedSelect.value = matched.value;
  }

  function setPlaybackRate(nextRate, restartIfPlaying) {
    const clamped = clamp(nextRate, 0.5, 2.0);
    const prev = playbackRate;
    if (Math.abs(clamped - prev) < 0.0005) return;
    const seekTime = getCurrentTime();
    playbackRate = clamped;
    syncSpeedSelect(clamped);
    if (isPlaying && currentNotes.length && restartIfPlaying !== false) {
      clearPlayback();
      playbackStartOffset = seekTime;
      startPlayback(seekTime);
    }
    updateInfo();
    updateMetrics();
    drawPianoRoll();
    emitTransport();
  }

  function stepSpeed(direction) {
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < SPEED_OPTIONS.length; i++) {
      const d = Math.abs(SPEED_OPTIONS[i] - playbackRate);
      if (d < best) {
        best = d;
        idx = i;
      }
    }
    const next = clamp(idx + direction, 0, SPEED_OPTIONS.length - 1);
    setPlaybackRate(SPEED_OPTIONS[next], true);
  }

  function tapTempo() {
    const now = performance.now();
    if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > TAP_RESET_MS) tapTimes = [];
    tapTimes.push(now);
    if (tapTimes.length > 6) tapTimes.shift();
    if (tapTimes.length < 2) {
      updateMetrics();
      return;
    }
    const intervals = [];
    for (let i = 1; i < tapTimes.length; i++) {
      const dt = tapTimes[i] - tapTimes[i - 1];
      if (dt >= TAP_MIN_INTERVAL_MS && dt <= TAP_MAX_INTERVAL_MS) intervals.push(dt);
    }
    if (!intervals.length) {
      updateMetrics();
      return;
    }
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const bpm = clamp(60000 / avg, 30, 300);
    tapBpm = bpm;
    const base = sourceBpm > 0 ? sourceBpm : 120;
    setPlaybackRate(bpm / base, true);
    updateMetrics();
  }

  function buildComplexity(notes) {
    complexityBins = [];
    totalDuration = 0;
    if (!notes.length) return;
    totalDuration = notes.reduce((max, n) => Math.max(max, n.time + Math.min(MAX_NOTE_DURATION_SEC, n.duration)), 0);
    if (totalDuration < 0.01) return;
    const bins = new Float32Array(BAR_BINS);
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const startBin = Math.floor((n.time / totalDuration) * BAR_BINS);
      const endBin = Math.min(BAR_BINS - 1, Math.ceil((n.time + n.duration) / totalDuration * BAR_BINS));
      const activity = (n.velocity || 0.8) * (1 + 0.3 * Math.min(3, endBin - startBin + 1));
      for (let b = startBin; b <= endBin; b++) bins[b] += activity;
    }
    let max = 0;
    for (let i = 0; i < BAR_BINS; i++) if (bins[i] > max) max = bins[i];
    if (max > 0) for (let i = 0; i < BAR_BINS; i++) bins[i] /= max;
    complexityBins = Array.from(bins);
  }

  function buildPianoRoll(notes) {
    pianoRollNotes = [];
    pianoRollMin = 48;
    pianoRollMax = 84;
    if (!notes || !notes.length) return;

    let minMidi = 127;
    let maxMidi = 0;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const dur = Math.min(MAX_NOTE_DURATION_SEC, Math.max(0.02, n.duration));
      const m = Math.max(0, Math.min(127, Math.round(n.midi)));
      const isDrum = !!n.isDrum;
      const drumType = isDrum ? (n.drumType || gmDrumToType(m)) : '';
      const drumVariant = isDrum ? (n.drumVariant || gmDrumVariant(m)) : '';
      pianoRollNotes.push({
        time: Math.max(0, n.time),
        duration: dur,
        midi: m,
        velocity: typeof n.velocity === 'number' ? n.velocity : 0.8,
        trackIndex: n.trackIndex != null ? n.trackIndex : 0,
        trackName: n.trackName || ('Track ' + (n.trackIndex || 0)),
        isDrum,
        drumType,
        drumClass: isDrum ? (n.drumClass != null ? n.drumClass : drumTypeToClass(drumType)) : null,
        drumVariant
      });
      if (!isDrum) {
        minMidi = Math.min(minMidi, m);
        maxMidi = Math.max(maxMidi, m);
      }
    }
    if (minMidi > maxMidi) return;
    let lo = Math.max(0, Math.floor(minMidi) - 3);
    let hi = Math.min(127, Math.ceil(maxMidi) + 3);
    if (hi - lo < 18) {
      const mid = (hi + lo) * 0.5;
      lo = Math.max(0, Math.floor(mid - 9));
      hi = Math.min(127, Math.ceil(mid + 9));
    }
    pianoRollMin = lo;
    pianoRollMax = hi;
  }

  function drawWave() {
    const canvas = waveCanvas || (progressBar && progressBar.querySelector('.midi-progress-wave'));
    if (!canvas || !progressBar) return;
    const rect = progressBar.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w <= 0 || h <= 0) return;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (!complexityBins.length) return;

    if (isVerticalProgress()) {
      const stepH = h / BAR_BINS;
      for (let i = 0; i < BAR_BINS; i++) {
        const v = complexityBins[i] || 0;
        const y = h - (i + 1) * stepH;
        const lineW = Math.max(2, w * (0.2 + 0.8 * v));
        const x = (w - lineW) * 0.5;
        ctx.fillStyle = `rgba(174,220,255,${0.08 + 0.44 * v})`;
        ctx.fillRect(x, y, lineW, Math.ceil(stepH) + 0.5);
      }
      return;
    }

    const barW = w / BAR_BINS;
    const midY = h / 2;
    ctx.fillStyle = 'rgba(212,236,255,0.22)';
    ctx.fillRect(0, midY - 0.5, w, 1);
    for (let i = 0; i < BAR_BINS; i++) {
      const v = complexityBins[i] || 0;
      const barH = Math.max(1.2, (h * 0.66) * (0.18 + 0.82 * v));
      ctx.fillStyle = `rgba(168,214,255,${0.16 + 0.42 * v})`;
      ctx.fillRect(i * barW, midY - barH / 2, Math.ceil(barW) + 0.5, barH);
    }
  }

  function getCurrentTime() {
    if (!isPlaying) return playbackStartOffset;
    const ctx = getAudioContext();
    return playbackStartOffset + (ctx.currentTime - segmentStartTime) * playbackRate;
  }

  function updateProgressDisplay() {
    if (totalDuration <= 0 || !progressFill) return;
    const t = getCurrentTime();
    const pct = Math.min(1, Math.max(0, t / totalDuration));
    if (isVerticalProgress()) {
      progressFill.style.height = (pct * 100) + '%';
      progressFill.style.width = '100%';
    } else {
      progressFill.style.width = (pct * 100) + '%';
      progressFill.style.height = '100%';
    }
  }

  function updateRollTooltip(clientX, clientY) {
    if (!ENABLE_LEGACY_ROLL) return;
    if (!rollCanvas || !rollTooltip || !rollHitRegions.length) {
      if (rollTooltip) rollTooltip.style.display = 'none';
      return;
    }
    const rect = rollCanvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let hit = null;
    for (let i = rollHitRegions.length - 1; i >= 0; i--) {
      const r = rollHitRegions[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        hit = r;
        break;
      }
    }
    if (!hit) {
      rollTooltip.style.display = 'none';
      return;
    }

    const n = hit.note;
    const vel = Math.round(clamp01(n.velocity) * 127);
    const px = clamp(x + 12, 8, rect.width - 180);
    const py = clamp(y - 44, 8, rect.height - 34);
    rollTooltip.style.display = 'block';
    rollTooltip.style.left = px + 'px';
    rollTooltip.style.top = py + 'px';
    rollTooltip.innerHTML = `
      <div>${n.trackName}</div>
      <div>${midiToName(n.midi)} · vel ${vel}</div>
    `;
  }

  function drawPianoRoll() {
    if (!ENABLE_LEGACY_ROLL) return;
    if (!rollCanvas || !rollOverlay) return;
    const rect = rollCanvas.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (w <= 0 || h <= 0) return;

    rollCanvas.width = w;
    rollCanvas.height = h;
    const ctx = rollCanvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, w, h);

    const laneCount = Math.max(1, pianoRollMax - pianoRollMin + 1);
    const now = getCurrentTime();
    const windowSec = Math.max(4.8, ROLL_WINDOW_SEC / Math.max(0.88, playbackRate * 0.9));

    const centerX = w * 0.5;
    const nearY = h * 0.92;
    const farY = h * 0.08;
    const nearWidth = w * 0.96;
    const farWidth = w * 0.36;

    function yAtDepth(depth) {
      return nearY + (farY - nearY) * depth;
    }
    function spanAtDepth(depth) {
      return nearWidth + (farWidth - nearWidth) * depth;
    }
    function laneAt(midi, depth) {
      const span = spanAtDepth(depth);
      const left = centerX - span * 0.5;
      const laneNorm = (midi - pianoRollMin + 0.5) / laneCount;
      return {
        x: left + laneNorm * span,
        y: yAtDepth(depth),
        laneW: span / laneCount,
        left,
        span
      };
    }

    const bgGrad = ctx.createLinearGradient(0, farY, 0, nearY);
    bgGrad.addColorStop(0, 'rgba(255,255,255,0.0)');
    bgGrad.addColorStop(1, 'rgba(10,18,30,0.2)');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Lane lines (runway perspective).
    for (let i = 0; i <= laneCount; i++) {
      const nearX = (centerX - nearWidth * 0.5) + (i / laneCount) * nearWidth;
      const farX = (centerX - farWidth * 0.5) + (i / laneCount) * farWidth;
      const midiEdge = pianoRollMin + i;
      const pc = midiEdge % 12;
      const isC = pc === 0;
      const isWhite = pc === 0 || pc === 2 || pc === 4 || pc === 5 || pc === 7 || pc === 9 || pc === 11;
      ctx.strokeStyle = isC
        ? 'rgba(210,236,255,0.24)'
        : (isWhite ? 'rgba(176,206,236,0.12)' : 'rgba(118,142,168,0.08)');
      ctx.lineWidth = isC ? 1.2 : 1;
      ctx.beginPath();
      ctx.moveTo(nearX, nearY);
      ctx.lineTo(farX, farY);
      ctx.stroke();
    }

    // Beat lines.
    const beatSec = Math.max(0.12, 60 / Math.max(40, sourceBpm || 120));
    const beatStart = Math.floor(now / beatSec) * beatSec;
    for (let bt = beatStart; bt <= now + windowSec + beatSec; bt += beatSec) {
      const depth = clamp01((bt - now) / windowSec);
      const y = yAtDepth(depth);
      const span = spanAtDepth(depth);
      const left = centerX - span * 0.5;
      const alpha = 0.06 + 0.1 * (1 - depth);
      ctx.fillStyle = `rgba(156,190,226,${alpha})`;
      ctx.fillRect(left, y, span, 1);
    }

    // Side rails.
    ctx.strokeStyle = 'rgba(120,255,230,0.42)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(centerX - nearWidth * 0.5, nearY);
    ctx.lineTo(centerX - farWidth * 0.5, farY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(centerX + nearWidth * 0.5, nearY);
    ctx.lineTo(centerX + farWidth * 0.5, farY);
    ctx.stroke();

    rollHitRegions = [];
    if (pianoRollNotes.length) {
      const visible = [];
      for (let i = 0; i < pianoRollNotes.length; i++) {
        const n = pianoRollNotes[i];
        const headRaw = (n.time - now) / windowSec;
        const tailRaw = (n.time + n.duration - now) / windowSec;
        if (tailRaw < -0.06 || headRaw > 1.04) continue;
        let headD = clamp01(headRaw);
        let tailD = clamp01(tailRaw);
        if (tailD < headD + 0.004) tailD = Math.min(1, headD + 0.004);
        visible.push({ note: n, headD, tailD });
      }
      visible.sort((a, b) => b.headD - a.headD); // far -> near

      for (let i = 0; i < visible.length; i++) {
        const n = visible[i].note;
        const headD = visible[i].headD;
        const tailD = visible[i].tailD;
        const pHead = laneAt(n.midi, headD);
        const pTail = laneAt(n.midi, tailD);
        const headHalfW = Math.max(1.6, pHead.laneW * 0.44);
        const tailHalfW = Math.max(0.9, pTail.laneW * 0.4);
        const velAlpha = 0.18 + clamp01(n.velocity) * 0.52;
        const color = trackColor(n.trackIndex, velAlpha * (0.65 + (1 - headD) * 0.5));

        const x1 = pTail.x - tailHalfW;
        const x2 = pTail.x + tailHalfW;
        const y1 = pTail.y;
        const x3 = pHead.x + headHalfW;
        const x4 = pHead.x - headHalfW;
        const y2 = pHead.y;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y1);
        ctx.lineTo(x3, y2);
        ctx.lineTo(x4, y2);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = 'rgba(255,255,255,0.24)';
        ctx.beginPath();
        ctx.moveTo(x1 + (x2 - x1) * 0.12, y1);
        ctx.lineTo(x1 + (x2 - x1) * 0.28, y1);
        ctx.lineTo(x4 + (x3 - x4) * 0.28, y2);
        ctx.lineTo(x4 + (x3 - x4) * 0.12, y2);
        ctx.closePath();
        ctx.fill();

        const minX = Math.min(x1, x2, x3, x4);
        const maxX = Math.max(x1, x2, x3, x4);
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);
        rollHitRegions.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY, note: n });
      }
    }

    // Hit line near camera.
    ctx.fillStyle = 'rgba(226,246,255,0.9)';
    ctx.fillRect(centerX - nearWidth * 0.5, nearY - 1, nearWidth, 2);

    // Active lanes.
    if (liveMidiNotes.length) {
      for (let i = 0; i < liveMidiNotes.length; i++) {
        const m = liveMidiNotes[i];
        if (m < pianoRollMin || m > pianoRollMax) continue;
        const p = laneAt(m, 0);
        ctx.fillStyle = 'rgba(255,255,255,0.32)';
        ctx.fillRect(p.x - p.laneW * 0.25, nearY - 3, Math.max(2, p.laneW * 0.5), 3);
      }
    }

    if (rollMeta) {
      const posText = totalDuration > 0 ? `${now.toFixed(1)} / ${totalDuration.toFixed(1)}s` : '—';
      rollMeta.textContent = `PERSPECTIVE PIANO ROLL · SPD ${playbackRate.toFixed(2)}x · POLY ${lastPolyphony} · POS ${posText}`;
    }
    let nextNote = null;
    for (let i = 0; i < pianoRollNotes.length; i++) {
      if (pianoRollNotes[i].time >= now - 0.001) { nextNote = pianoRollNotes[i]; break; }
    }
    if (rollInfoLeft) {
      const tapText = tapBpm > 0 ? tapBpm.toFixed(1) : '—';
      rollInfoLeft.textContent = `TRK ${selectedTrackCount}/${totalTrackCount} · BPM ${Math.round(sourceBpm)} · TAP ${tapText}`;
    }
    if (rollInfoRight) {
      const nextText = nextNote ? `${midiToName(nextNote.midi)} ${Math.max(0, nextNote.time - now).toFixed(2)}s` : '—';
      const activeText = liveMidiNotes.length ? liveMidiNotes.slice(0, 4).map(midiToName).join(' ') : 'none';
      rollInfoRight.textContent = `NEXT ${nextText} · ON ${activeText}`;
    }
    if (rollPointerActive) updateRollTooltip(rollPointerX, rollPointerY);
  }

  function showProgressBar(show) {
    if (progressWrap) progressWrap.style.display = show ? 'block' : 'none';
    if (!show) setProgressPlayingState(false);
    else setProgressPlayingState(isPlaying);
    if (rollOverlay) rollOverlay.style.display = (show && ENABLE_LEGACY_ROLL) ? 'block' : 'none';
    if (show) {
      requestAnimationFrame(() => {
        drawWave();
        drawPianoRoll();
        updateProgressDisplay();
      });
    }
  }

  function getSelectedTrackIndices() {
    const checkboxes = trackList.querySelectorAll('input[type="checkbox"]');
    const indices = [];
    checkboxes.forEach((cb, i) => { if (cb.checked) indices.push(i); });
    return indices;
  }

  function updateMetrics() {
    selectedTrackCount = getSelectedTrackIndices().length;
    totalTrackCount = parsedMidi && parsedMidi.tracks ? parsedMidi.tracks.length : 0;
    const pos = totalDuration > 0 ? `${getCurrentTime().toFixed(2)} / ${totalDuration.toFixed(2)}s` : '—';
    let noteText = '—';
    if (liveMidiNotes.length) {
      const shown = liveMidiNotes.slice(0, 8).map(midiToName);
      noteText = shown.join(' · ');
      if (liveMidiNotes.length > shown.length) noteText += ` +${liveMidiNotes.length - shown.length}`;
    }
    const tapText = tapBpm > 0 ? tapBpm.toFixed(1) : '—';
    metricsDiv.innerHTML = [
      `<span>SPD ${playbackRate.toFixed(2)}x</span>`,
      `<span>TRK ${selectedTrackCount}/${totalTrackCount || 0}</span>`,
      `<span>POLY ${lastPolyphony}</span>`,
      `<span>BPM src ${Math.round(sourceBpm)} tap ${tapText}</span>`,
      `<span>POS ${pos}</span>`,
      '<span>HK ALT+↑/↓ ALT+0 ALT+T</span>',
      `<span class="midi-metrics-wide">ON ${noteText}</span>`
    ].join('');
  }

  function clearPlayback() {
    if (playbackIntervalId != null) clearInterval(playbackIntervalId);
    playbackIntervalId = null;
    if (endTimeoutId != null) clearTimeout(endTimeoutId);
    endTimeoutId = null;
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;

    activeVoices.forEach(v => {
      const stop = typeof v === 'function' ? v : (v && v.stop);
      if (stop) {
        try { stop(); } catch (_) {}
      }
    });
    activeVoices = [];
    liveMidiNotes = [];
    lastPolyphony = 0;

    if (updateKeyDisplayFromMidi) updateKeyDisplayFromMidi([]);
    isPlaying = false;
    emitPlayback(false);
    emitTransport();
    updateMetrics();
    drawPianoRoll();
  }

  function startPlayback(fromTime) {
    if (!currentNotes.length || totalDuration <= 0) return;
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();

    clearPlayback();
    playbackStartOffset = fromTime;
    segmentStartTime = ctx.currentTime;
    isPlaying = true;
    stopBtn.disabled = false;
    playBtn.disabled = true;
    emitPlayback(true);

    const speed = clamp(playbackRate, 0.5, 2.0);
    const prepared = [];
    for (let i = 0; i < currentNotes.length; i++) {
      const n = currentNotes[i];
      const isDrum = !!n.isDrum;
      const rawDur = isDrum
        ? Math.min(0.24, Math.max(0.03, n.duration))
        : Math.min(MAX_NOTE_DURATION_SEC, Math.max(0.02, n.duration));
      const noteStart = n.time;
      const noteEnd = n.time + rawDur;
      if (noteEnd <= fromTime - 0.001) continue;
      const relStartTrack = Math.max(0, noteStart - fromTime);
      const relEndTrack = Math.max(relStartTrack + 0.02, noteEnd - fromTime);
      prepared.push({
        on: relStartTrack / speed,
        off: relEndTrack / speed,
        midi: isDrum
          ? Math.max(0, Math.min(127, n.midi))
          : Math.max(0, Math.min(127, n.midi + currentTranspose)),
        velocity: typeof n.velocity === 'number' ? n.velocity : 0.8,
        isDrum,
        drumType: n.drumType || '',
        drumClass: n.drumClass != null ? n.drumClass : null,
        drumVariant: n.drumVariant || '',
        trackIndex: n.trackIndex | 0,
        drop: false
      });
    }

    if (!prepared.length) {
      isPlaying = false;
      emitPlayback(false);
      stopBtn.disabled = true;
      playBtn.disabled = false;
      playbackStartOffset = totalDuration;
      updateProgressDisplay();
      updateMetrics();
      emitTransport();
      return;
    }

    prepared.sort((a, b) => a.on - b.on);
    const offEvents = prepared.map(n => ({ off: n.off, midi: n.midi, note: n })).sort((a, b) => a.off - b.off);
    let scheduleIdx = 0;
    let onIdx = 0;
    let offIdx = 0;
    const activeMidiCounts = new Map();
    let activePoly = 0;
    const pendingStarts = [];

    function cleanupVoices(nowAbs) {
      if (activeVoices.length === 0) return;
      let w = 0;
      for (let i = 0; i < activeVoices.length; i++) {
        const v = activeVoices[i];
        if (v && v.endAbs > nowAbs - 0.05) activeVoices[w++] = v;
      }
      activeVoices.length = w;
    }

    function scheduleChunk(relNow) {
      const horizon = relNow + LOOKAHEAD_SEC;
      while (pendingStarts.length && pendingStarts[0] <= relNow + 0.008) pendingStarts.shift();
      while (scheduleIdx < prepared.length && prepared[scheduleIdx].on <= horizon) {
        const note = prepared[scheduleIdx++];
        const startRel = Math.max(relNow, note.on);
        const durationSec = Math.max(0.02, note.off - startRel);
        const polyEstimate = activePoly + pendingStarts.length;
        const overPoly = polyEstimate >= MIDI_POLY_LIMIT;
        if (!note.isDrum && overPoly && note.velocity < 0.2) {
          note.drop = true;
          continue;
        }
        const velocity = expressiveVelocity(note, !note.isDrum && overPoly);
        if (note.isDrum && typeof playDrumFromMidi === 'function') {
          playDrumFromMidi(note.drumType || gmDrumToType(note.midi), {
            startTime: segmentStartTime + startRel,
            velocity,
            midiNote: note.midi,
            drumClass: note.drumClass,
            drumVariant: note.drumVariant || gmDrumVariant(note.midi),
            trackIndex: note.trackIndex | 0
          });
          note.drop = false;
          continue;
        }
        const voice = createSynthVoice(note.midi, {
          sustained: true,
          velocity,
          fromMIDI: true,
          snapPitch: false,
          startTime: segmentStartTime + startRel,
          duration: durationSec,
          polyHint: Math.max(1, polyEstimate + 1)
        });
        if (voice && voice.stop) {
          activeVoices.push({ stop: voice.stop, endAbs: segmentStartTime + startRel + durationSec + 0.16 });
          pendingStarts.push(note.on);
          note.drop = false;
        } else {
          note.drop = true;
        }
      }
    }

    function tick() {
      const relNow = ctx.currentTime - segmentStartTime;
      scheduleChunk(relNow);

      let visualsBudget = IS_MOBILE ? 6 : 12;
      while (onIdx < prepared.length && prepared[onIdx].on <= relNow + 0.012) {
        const note = prepared[onIdx++];
        if (note.drop) continue;
        if (!note.isDrum) {
          const cur = (activeMidiCounts.get(note.midi) || 0) + 1;
          activeMidiCounts.set(note.midi, cur);
          activePoly++;
        }
        if (visualsBudget > 0) {
          if (note.isDrum && typeof triggerVisualsForMidiDrum === 'function') {
            triggerVisualsForMidiDrum(
              note.midi,
              note.drumType || gmDrumToType(note.midi),
              note.velocity,
              note.drumVariant || gmDrumVariant(note.midi)
            );
          } else {
            triggerVisualsForMidi(note.midi);
          }
          visualsBudget--;
        }
      }

      while (offIdx < offEvents.length && offEvents[offIdx].off <= relNow) {
        const evt = offEvents[offIdx++];
        if (evt.note && evt.note.drop) continue;
        if (evt.note && evt.note.isDrum) continue;
        const midi = evt.midi;
        const cur = (activeMidiCounts.get(midi) || 0) - 1;
        if (cur <= 0) activeMidiCounts.delete(midi);
        else activeMidiCounts.set(midi, cur);
        activePoly = Math.max(0, activePoly - 1);
      }

      const sounding = [];
      activeMidiCounts.forEach((count, midi) => { if (count > 0) sounding.push(midi); });
      sounding.sort((a, b) => a - b);
      liveMidiNotes = sounding;
      lastPolyphony = sounding.length;
      if (updateKeyDisplayFromMidi) updateKeyDisplayFromMidi(sounding);

      cleanupVoices(ctx.currentTime);
      updateMetrics();
      emitTransport();
    }

    function progressLoop() {
      updateProgressDisplay();
      drawPianoRoll();
      rafId = requestAnimationFrame(progressLoop);
    }

    tick();
    playbackIntervalId = setInterval(tick, CHUNK_MS);
    rafId = requestAnimationFrame(progressLoop);

    const segmentDurReal = (totalDuration - fromTime) / speed;
    endTimeoutId = setTimeout(() => {
      if (playbackIntervalId != null) clearInterval(playbackIntervalId);
      playbackIntervalId = null;
      if (rafId != null) cancelAnimationFrame(rafId);
      rafId = null;
      endTimeoutId = null;
      isPlaying = false;
      emitPlayback(false);
      stopBtn.disabled = true;
      playBtn.disabled = false;
      playbackStartOffset = totalDuration;
      liveMidiNotes = [];
      lastPolyphony = 0;
      updateProgressDisplay();
      drawPianoRoll();
      updateMetrics();
      emitTransport();
      if (updateKeyDisplayFromMidi) updateKeyDisplayFromMidi([]);
    }, (segmentDurReal + 0.5) * 1000);
  }

  function mergeNotesFromTracks(midi, trackIndices) {
    const notes = [];
    trackIndices.forEach(idx => {
      const track = midi.tracks[idx];
      if (!track || !track.notes) return;
      const trackName = (track.name && track.name.trim()) ? track.name.trim() : ('Track ' + idx);
      const percussion = isPercTrack(track, trackName);
      track.notes.forEach(n => {
        const drumType = percussion ? gmDrumToType(n.midi) : '';
        const drumVariant = percussion ? gmDrumVariant(n.midi) : '';
        notes.push({
          time: n.time,
          duration: typeof n.duration === 'number' ? n.duration : 0.2,
          midi: n.midi,
          velocity: typeof n.velocity === 'number' ? n.velocity : 0.8,
          trackIndex: idx,
          trackName,
          isDrum: percussion,
          drumType,
          drumClass: percussion ? drumTypeToClass(drumType) : null,
          drumVariant
        });
      });
    });
    notes.sort((a, b) => a.time - b.time || a.trackIndex - b.trackIndex);
    return notes;
  }

  function updateInfo() {
    if (!parsedMidi) {
      infoDiv.textContent = 'Load a .mid file';
      updateMetrics();
      return;
    }
    const headerTempo = parsedMidi.header.tempos && parsedMidi.header.tempos[0]
      ? parsedMidi.header.tempos[0].bpm
      : sourceBpm;
    sourceBpm = headerTempo && Number.isFinite(headerTempo) ? headerTempo : 120;

    let maxEnd = 0;
    let noteCount = 0;
    parsedMidi.tracks.forEach(tr => {
      if (!tr.notes || !tr.notes.length) return;
      noteCount += tr.notes.length;
      tr.notes.forEach(n => {
        const end = n.time + (typeof n.duration === 'number' ? n.duration : 0.2);
        if (end > maxEnd) maxEnd = end;
      });
    });
    const dur = maxEnd > 0 ? (Math.round(maxEnd * 10) / 10) + ' s' : '—';
    infoDiv.textContent = `BPM ${Math.round(sourceBpm)} · Duration ${dur} · Notes ${noteCount}`;
    updateMetrics();
  }

  function rebuildWaveFromSelection() {
    if (!parsedMidi) {
      buildComplexity([]);
      buildPianoRoll([]);
      drawWave();
      drawPianoRoll();
      updateMetrics();
      return;
    }
    const indices = getSelectedTrackIndices();
    if (indices.length === 0) {
      buildComplexity([]);
      buildPianoRoll([]);
      drawWave();
      drawPianoRoll();
      updateMetrics();
      return;
    }
    const notes = mergeNotesFromTracks(parsedMidi, indices);
    buildComplexity(notes);
    buildPianoRoll(notes);
    drawWave();
    drawPianoRoll();
    updateMetrics();
  }

  transposeSelect.addEventListener('change', () => {
    currentTranspose = parseInt(transposeSelect.value, 10) || 0;
    if (isPlaying && currentNotes.length) {
      const seekTime = getCurrentTime();
      clearPlayback();
      playbackStartOffset = seekTime;
      startPlayback(seekTime);
    }
    updateMetrics();
  });

  speedSelect.addEventListener('change', () => {
    const nextRate = parseFloat(speedSelect.value);
    if (!Number.isFinite(nextRate) || nextRate <= 0) return;
    setPlaybackRate(nextRate, true);
  });

  tapBtn.addEventListener('click', () => {
    tapTempo();
  });

  progressBar.addEventListener('click', (e) => {
    if (totalDuration <= 0) return;
    const rect = progressBar.getBoundingClientRect();
    const pct = isVerticalProgress()
      ? Math.max(0, Math.min(1, 1 - ((e.clientY - rect.top) / rect.height)))
      : Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const seekTime = pct * totalDuration;
    playbackStartOffset = seekTime;
    updateProgressDisplay();
    drawPianoRoll();
    if (isPlaying) startPlayback(seekTime);
    updateMetrics();
    emitTransport();
  });

  function onHotkeys(e) {
    if (!e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.code === 'ArrowUp') {
      e.preventDefault();
      stepSpeed(1);
      return;
    }
    if (e.code === 'ArrowDown') {
      e.preventDefault();
      stepSpeed(-1);
      return;
    }
    if (e.code === 'Digit0') {
      e.preventDefault();
      setPlaybackRate(1.0, true);
      return;
    }
    if (e.code === 'KeyT') {
      e.preventDefault();
      tapTempo();
    }
  }
  window.addEventListener('keydown', onHotkeys);

  window.addEventListener('resize', () => {
    drawWave();
    drawPianoRoll();
  });

  const fileInput = document.getElementById('midi-file-input');
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    clearPlayback();
    tapTimes = [];
    tapBpm = 0;
    try {
      const arrayBuffer = await file.arrayBuffer();
      parsedMidi = new Midi(arrayBuffer);
    } catch (err) {
      infoDiv.textContent = 'Parse error: ' + (err.message || err);
      parsedMidi = null;
    }

    trackList.innerHTML = '';
    if (parsedMidi && parsedMidi.tracks) {
      parsedMidi.tracks.forEach((track, i) => {
        const label = document.createElement('label');
        label.className = 'midi-player-track';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.name = 'midi-track';
        cb.value = i;
        cb.addEventListener('change', rebuildWaveFromSelection);

        const swatch = document.createElement('span');
        swatch.className = 'midi-track-swatch';
        swatch.style.background = trackColor(i, 0.9);

        const name = (track.name && track.name.trim()) ? track.name : ('Track ' + i);
        const drumTag = isPercTrack(track, name) ? ' [DRUM]' : '';
        label.appendChild(cb);
        label.appendChild(swatch);
        label.appendChild(document.createTextNode(' ' + name + drumTag));
        trackList.appendChild(label);
      });
    }

    updateInfo();
    playBtn.disabled = !parsedMidi || !parsedMidi.tracks.length;
    stopBtn.disabled = true;
    playbackStartOffset = 0;
    rebuildWaveFromSelection();
    showProgressBar(!!parsedMidi);
    emitTransport();
  });

  playBtn.addEventListener('click', () => {
    if (!parsedMidi) return;
    initAudio();
    const indices = getSelectedTrackIndices();
    if (indices.length === 0) return;
    const notes = mergeNotesFromTracks(parsedMidi, indices);
    if (notes.length === 0) return;
    currentNotes = notes;
    currentTranspose = parseInt(transposeSelect.value, 10) || 0;
    buildComplexity(notes);
    buildPianoRoll(notes);
    drawWave();
    drawPianoRoll();
    showProgressBar(true);
    startPlayback(playbackStartOffset >= totalDuration ? 0 : playbackStartOffset);
  });

  stopBtn.addEventListener('click', () => {
    clearPlayback();
    if (updateKeyDisplayFromMidi) updateKeyDisplayFromMidi([]);
    stopBtn.disabled = true;
    playBtn.disabled = parsedMidi && parsedMidi.tracks.length ? false : true;
    updateProgressDisplay();
    drawPianoRoll();
    updateMetrics();
    emitTransport();
  });

  updateInfo();
}
