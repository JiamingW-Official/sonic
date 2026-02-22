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
    setTrackVolume,
    setTrackPan,
    setDrumTrackVolume,
    setDrumTrackPan,
    getTrackEffects,
    setTrackEffectEnabled,
    setTrackEffectParam,
    getMainEffects,
    setMainEffectEnabled,
    setMainEffectParam,
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

  // Hidden file input (triggered programmatically from folder window)
  const fileLabel = document.createElement('label');
  fileLabel.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none';
  fileLabel.innerHTML = '<input type="file" accept=".mid,.midi" id="midi-file-input" class="midi-player-file">';
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
  playBtn.innerHTML = '<span class="midi-btn-icon midi-btn-play"></span> Play';
  playBtn.disabled = true;
  playBtn.className = 'midi-player-btn';
  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.innerHTML = '<span class="midi-btn-icon midi-btn-stop"></span> Stop';
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

  // === WINDOWS 95 MIXER PANEL ===
  let mixerPanel = null;
  let mixerChannelsEl = null;
  let mixerTrackData = [];
  const MIXER_CHANNEL_W = 54;
  // Custom scrollbar state
  let mixerScrollbar = null, sbThumb = null, sbTrack = null;
  // FX panel state
  let fxPanel = null, fxRack = null, fxPanelTitle = null, fxPanelSlots = [];
  let selectedMixerTrack = null;

  function createMixerStyle() {
    const st = document.createElement('style');
    st.textContent = `
      .w95-mixer {
        position: fixed;
        right: 12px;
        z-index: 1099;
        max-width: 370px;
        width: 370px;
        background: #c0c0c0;
        border: 2px solid #000;
        box-shadow:
          inset -1px -1px 0 #808080,
          inset 1px 1px 0 #fff,
          inset -2px -2px 0 #000,
          inset 2px 2px 0 #dfdfdf,
          0 4px 0 rgba(0,0,0,0.35);
        font: 11px/1.25 "Tahoma","MS Sans Serif",sans-serif;
        color: #000;
        overflow: hidden;
      }
      .w95-mixer-titlebar {
        background: linear-gradient(90deg, #000080, #1084d0);
        color: #fff;
        font: bold 11px/1 "Tahoma","MS Sans Serif",sans-serif;
        padding: 3px 4px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        user-select: none;
        cursor: default;
      }
      .w95-mixer-titlebar-btns {
        display: flex;
        gap: 2px;
      }
      .w95-mixer-titlebar-btn {
        width: 16px;
        height: 14px;
        background: #c0c0c0;
        border: 1px solid #000;
        box-shadow: inset -1px -1px 0 #808080, inset 1px 1px 0 #fff;
        font: bold 9px/1 "Tahoma",sans-serif;
        text-align: center;
        cursor: pointer;
        padding: 0;
        color: #000;
      }
      .w95-mixer-titlebar-btn:active {
        box-shadow: inset 1px 1px 0 #808080, inset -1px -1px 0 #fff;
      }
      .w95-mixer-body {
        display: flex;
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-width: none;
        padding: 4px 2px 6px;
        gap: 0;
        border-top: 1px solid #808080;
      }
      .w95-mixer-body::-webkit-scrollbar { display: none; }
      .w95-mixer-ch {
        flex: 0 0 ${MIXER_CHANNEL_W}px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        border-right: 1px solid #808080;
        padding: 2px 2px 0;
      }
      .w95-mixer-ch:last-child { border-right: none; }
      .w95-mixer-ch-label {
        font: 9px/1.1 "Tahoma","MS Sans Serif",sans-serif;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        width: 100%;
        color: #000;
        margin-bottom: 1px;
      }
      .w95-mixer-ch-tag {
        font: bold 8px/1 "Tahoma",sans-serif;
        color: #808080;
        letter-spacing: 0.04em;
      }
      .w95-mixer-fader-wrap {
        position: relative;
        width: 18px;
        height: 80px;
        background: #000;
        border: 1px solid #808080;
        box-shadow: inset 1px 1px 0 #404040, inset -1px -1px 0 #dfdfdf;
      }
      .w95-mixer-fader-fill {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        background: linear-gradient(180deg, #00ff00, #008800);
        pointer-events: none;
      }
      .w95-mixer-fader-thumb {
        position: absolute;
        left: -1px;
        right: -1px;
        height: 6px;
        background: #c0c0c0;
        border: 1px solid #000;
        box-shadow: inset -1px -1px 0 #808080, inset 1px 1px 0 #fff;
        cursor: ns-resize;
        z-index: 2;
      }
      .w95-mixer-pan-wrap {
        width: 36px;
        display: flex;
        align-items: center;
        gap: 1px;
        margin: 2px 0;
      }
      .w95-mixer-pan-label {
        font: 8px/1 "Tahoma",sans-serif;
        color: #404040;
      }
      .w95-mixer-pan-input {
        width: 36px;
        height: 10px;
        -webkit-appearance: none;
        appearance: none;
        background: #fff;
        border: 1px solid #808080;
        box-shadow: inset 1px 1px 0 #404040;
        outline: none;
        cursor: ew-resize;
      }
      .w95-mixer-pan-input::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 6px;
        height: 10px;
        background: #c0c0c0;
        border: 1px solid #000;
        box-shadow: inset -1px -1px 0 #808080, inset 1px 1px 0 #fff;
        cursor: ew-resize;
      }
      .w95-mixer-pan-input::-moz-range-thumb {
        width: 6px;
        height: 10px;
        background: #c0c0c0;
        border: 1px solid #000;
        box-shadow: inset -1px -1px 0 #808080, inset 1px 1px 0 #fff;
        cursor: ew-resize;
        border-radius: 0;
      }
      .w95-mixer-vol-val {
        font: 9px/1 "Tahoma",sans-serif;
        color: #404040;
        text-align: center;
      }
      .w95-mixer-meter {
        width: 4px;
        height: 80px;
        background: #000;
        border: 1px solid #808080;
        position: relative;
        box-shadow: inset 1px 1px 0 #404040;
      }
      .w95-mixer-meter-fill {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        height: 0%;
        background: linear-gradient(180deg, #ff0000 0%, #ffff00 30%, #00ff00 100%);
        transition: height 0.06s linear;
      }
      .w95-mixer-master {
        border-left: 2px solid #000;
        background: #d4d0c8;
      }
      /* === Custom W95 scrollbar === */
      .w95-mixer-scrollbar {
        display: flex;
        height: 16px;
        background: #c0c0c0;
        border-top: 1px solid #808080;
      }
      .w95-mixer-sb-btn {
        width: 16px; height: 16px;
        background: #c0c0c0;
        border: 1px solid #000;
        box-shadow: inset -1px -1px 0 #808080, inset 1px 1px 0 #fff;
        font: bold 8px/14px "Tahoma",sans-serif;
        text-align: center; cursor: pointer; padding: 0; color: #000;
        flex: 0 0 16px;
      }
      .w95-mixer-sb-btn:active {
        box-shadow: inset 1px 1px 0 #808080, inset -1px -1px 0 #fff;
      }
      .w95-mixer-sb-track {
        flex: 1;
        background: repeating-conic-gradient(#c0c0c0 0% 25%, #a0a0a0 0% 50%) 50% / 2px 2px;
        position: relative;
        border-left: 1px solid #404040;
        border-right: 1px solid #404040;
      }
      .w95-mixer-sb-thumb {
        position: absolute; top: 0; height: 100%; min-width: 20px;
        background: #c0c0c0;
        border: 1px solid #000;
        box-shadow: inset -1px -1px 0 #808080, inset 1px 1px 0 #fff;
        cursor: pointer;
      }
      /* === W95 FX Panel === */
      .w95-fx-panel { display: none; border-top: 1px solid #808080; }
      .w95-fx-panel.w95-fx-open { display: block; }
      .w95-fx-titlebar {
        background: linear-gradient(90deg, #000080, #1084d0);
        color: #fff; font: bold 10px/1 "Tahoma","MS Sans Serif",sans-serif;
        padding: 2px 4px; display: flex; align-items: center; justify-content: space-between;
        user-select: none;
      }
      .w95-fx-body {
        background: #c0c0c0; overflow: hidden; position: relative;
      }
      .w95-fx-scroll-area {
        max-height: 360px; overflow-y: hidden;
      }
      /* W95 vertical scrollbar */
      .w95-fx-vscroll {
        position: absolute; right: 0; top: 0; bottom: 0; width: 16px;
        background: repeating-conic-gradient(#c0c0c0 0% 25%, #a0a0a0 0% 50%) 50% / 2px 2px;
        border-left: 1px solid #808080; display: none; flex-direction: column;
      }
      .w95-fx-vscroll.w95-fx-vs-show { display: flex; }
      .w95-fx-vs-btn {
        width: 16px; height: 16px; border: none; padding: 0;
        background: #c0c0c0; font: bold 8px/16px sans-serif; text-align: center;
        box-shadow: inset -1px -1px 0 #404040, inset 1px 1px 0 #fff;
        cursor: pointer; color: #000; flex: 0 0 16px;
      }
      .w95-fx-vs-btn:active { box-shadow: inset 1px 1px 0 #404040, inset -1px -1px 0 #fff; }
      .w95-fx-vs-track { flex: 1; position: relative; }
      .w95-fx-vs-thumb {
        position: absolute; left: 0; right: 0; min-height: 16px;
        background: #c0c0c0;
        box-shadow: inset -1px -1px 0 #404040, inset 1px 1px 0 #fff;
        cursor: pointer;
      }
      /* Slot */
      .w95-fx-slot {
        border-bottom: 1px solid #808080; user-select: none;
        margin: 2px 18px 0 2px;
        box-shadow: inset -1px -1px 0 #fff, inset 1px 1px 0 #404040;
      }
      .w95-fx-slot-header {
        display: flex; align-items: center; gap: 4px;
        padding: 2px 4px; background: #c0c0c0; cursor: pointer;
      }
      .w95-fx-slot-header:hover { background: #d0d0d0; }
      /* W95 power button */
      .fx-power-btn {
        width: 14px; height: 14px; flex: 0 0 14px; cursor: pointer;
        background: #c0c0c0;
        box-shadow: inset -1px -1px 0 #404040, inset 1px 1px 0 #fff;
        display: flex; align-items: center; justify-content: center;
        font: bold 9px/1 sans-serif; color: #808080;
      }
      .fx-power-btn::after { content: '\\25CF'; font-size: 7px; }
      .w95-fx-slot[data-on="1"] .fx-power-btn {
        background: #00aa44; color: #fff;
        box-shadow: inset 1px 1px 0 #404040, inset -1px -1px 0 #fff;
      }
      .w95-fx-slot-name {
        font: bold 10px/1 "Tahoma","MS Sans Serif",sans-serif; color: #404040; flex: 1;
      }
      .w95-fx-slot[data-on="1"] .w95-fx-slot-name { color: #000; }
      /* W95 preset combobox */
      .fx-preset-select {
        font: 9px/1 "Tahoma","MS Sans Serif",sans-serif;
        background: #fff; color: #000; border: 1px solid #404040;
        box-shadow: inset -1px -1px 0 #fff, inset 1px 1px 0 #808080;
        padding: 1px 2px; max-width: 72px; cursor: pointer;
      }
      .w95-fx-slot-arrow { font: 8px/1 sans-serif; color: #808080; transition: transform .15s; }
      .w95-fx-slot.w95-fx-expanded .w95-fx-slot-arrow { transform: rotate(90deg); }
      .w95-fx-controls {
        display: none; background: #c0c0c0; padding: 3px;
        border-top: 1px solid #808080;
      }
      .w95-fx-slot.w95-fx-expanded .w95-fx-controls { display: block; }
      /* === W95 rotary knob === */
      .fx-knob-wrap {
        display: inline-flex; flex-direction: column; align-items: center; gap: 1px;
        user-select: none;
      }
      .fx-knob-label { font: 8px/1 "Tahoma","MS Sans Serif",sans-serif; color: #404040; text-align: center; }
      .fx-knob-svg { cursor: ns-resize; }
      .fx-knob-val { font: 8px/1 "Tahoma","MS Sans Serif",sans-serif; color: #000; text-align: center; min-width: 30px; }
      /* === Per-effect panels (sunken W95 panels) === */
      .fx-effect-inner {
        background: #c0c0c0; padding: 4px;
      }
      .fx-sunken {
        box-shadow: inset 1px 1px 0 #808080, inset -1px -1px 0 #fff;
        background: #000; padding: 2px;
      }
      .fx-eq-canvas { width: 100%; height: 80px; display: block; background: #001020; cursor: crosshair; }
      .fx-eq-knobs { display: flex; gap: 4px; margin-top: 4px; justify-content: center; flex-wrap: wrap; }
      .fx-phaser-row, .fx-chorus-row, .fx-od-row { display: flex; gap: 14px; justify-content: center; align-items: flex-end; padding: 6px 4px; }
      .fx-reverb-inner { display: flex; gap: 8px; padding: 4px; }
      .fx-reverb-faders { display: flex; gap: 6px; flex: 0 0 auto; }
      .fx-rvb-fader { display: flex; flex-direction: column; align-items: center; gap: 2px; width: 22px; }
      .fx-rvb-fader-track {
        width: 6px; height: 50px; position: relative; cursor: ns-resize;
        box-shadow: inset 1px 1px 0 #808080, inset -1px -1px 0 #fff;
        background: #000;
      }
      .fx-rvb-fader-fill { position: absolute; bottom: 0; left: 0; right: 0; pointer-events: none; }
      .fx-rvb-fader-lbl { font: 7px/1 "Tahoma","MS Sans Serif",sans-serif; color: #404040; }
      .fx-reverb-knobs { display: flex; gap: 10px; align-items: flex-end; justify-content: center; flex: 1; }
      .fx-delay-sections { display: flex; gap: 3px; padding: 4px; }
      .fx-delay-sec {
        flex: 1; padding: 3px; display: flex; flex-direction: column; align-items: center; gap: 3px;
        box-shadow: inset 1px 1px 0 #808080, inset -1px -1px 0 #fff;
        background: #b8b8b8;
      }
      .fx-delay-sec-title { font: bold 7px/1 "Tahoma","MS Sans Serif",sans-serif; color: #000; text-transform: uppercase; }
      .fx-delay-fb-ring { width: 20px; height: 20px; border-radius: 50%; border: 3px solid #008800; transition: border-color .3s; }
      .w95-mixer-ch.w95-ch-selected { background: #d4d0c8; border-bottom: 2px solid #000080; }
      @media (max-width: 720px) {
        .w95-mixer { right: 8px; max-width: 284px; width: 284px; }
        .w95-fx-scroll-area { max-height: 260px; }
      }
    `;
    document.head.appendChild(st);
  }

  function createMixerPanel() {
    createMixerStyle();
    mixerPanel = document.createElement('div');
    mixerPanel.className = 'w95-mixer';
    mixerPanel.style.display = 'none';
    mixerPanel.style.top = '32px';
    // Title bar
    const titlebar = document.createElement('div');
    titlebar.className = 'w95-mixer-titlebar';
    const titleText = document.createElement('span');
    titleText.textContent = 'Mixer';
    titlebar.appendChild(titleText);
    const btns = document.createElement('div');
    btns.className = 'w95-mixer-titlebar-btns';
    const minBtn = document.createElement('button');
    minBtn.className = 'w95-mixer-titlebar-btn';
    minBtn.textContent = '_';
    minBtn.title = 'Minimize';
    minBtn.addEventListener('click', () => { mixerPanel.style.display = 'none'; });
    btns.appendChild(minBtn);
    titlebar.appendChild(btns);
    mixerPanel.appendChild(titlebar);
    // Body (channels go here)
    mixerChannelsEl = document.createElement('div');
    mixerChannelsEl.className = 'w95-mixer-body';
    mixerPanel.appendChild(mixerChannelsEl);
    // Custom W95 scrollbar
    createMixerScrollbar();
    // FX panel (hidden by default)
    createFxPanel();
    document.body.appendChild(mixerPanel);
  }

  // === W95 CUSTOM SCROLLBAR ===
  function createMixerScrollbar() {
    mixerScrollbar = document.createElement('div');
    mixerScrollbar.className = 'w95-mixer-scrollbar';
    mixerScrollbar.style.display = 'none';
    const leftBtn = document.createElement('button');
    leftBtn.className = 'w95-mixer-sb-btn';
    leftBtn.textContent = '\u25C0';
    leftBtn.addEventListener('mousedown', () => { mixerChannelsEl.scrollLeft -= MIXER_CHANNEL_W; });
    sbTrack = document.createElement('div');
    sbTrack.className = 'w95-mixer-sb-track';
    sbThumb = document.createElement('div');
    sbThumb.className = 'w95-mixer-sb-thumb';
    sbTrack.appendChild(sbThumb);
    const rightBtn = document.createElement('button');
    rightBtn.className = 'w95-mixer-sb-btn';
    rightBtn.textContent = '\u25B6';
    rightBtn.addEventListener('mousedown', () => { mixerChannelsEl.scrollLeft += MIXER_CHANNEL_W; });
    mixerScrollbar.appendChild(leftBtn);
    mixerScrollbar.appendChild(sbTrack);
    mixerScrollbar.appendChild(rightBtn);
    mixerPanel.appendChild(mixerScrollbar);
    // Thumb drag
    sbThumb.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const trackRect = sbTrack.getBoundingClientRect();
      const startX = e.clientX;
      const startLeft = sbThumb.offsetLeft;
      const maxScroll = mixerChannelsEl.scrollWidth - mixerChannelsEl.clientWidth;
      const trackW = trackRect.width - sbThumb.offsetWidth;
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const newLeft = Math.max(0, Math.min(trackW, startLeft + dx));
        mixerChannelsEl.scrollLeft = (newLeft / Math.max(1, trackW)) * maxScroll;
      };
      const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    mixerChannelsEl.addEventListener('scroll', updateScrollbarThumb);
  }
  function updateScrollbarThumb() {
    if (!sbThumb || !sbTrack || !mixerChannelsEl || !mixerScrollbar) return;
    const scrollW = mixerChannelsEl.scrollWidth;
    const clientW = mixerChannelsEl.clientWidth;
    if (scrollW <= clientW + 2) { mixerScrollbar.style.display = 'none'; return; }
    mixerScrollbar.style.display = 'flex';
    const trackW = sbTrack.offsetWidth;
    const thumbW = Math.max(20, (clientW / scrollW) * trackW);
    const maxLeft = trackW - thumbW;
    const ratio = mixerChannelsEl.scrollLeft / Math.max(1, scrollW - clientW);
    sbThumb.style.width = thumbW + 'px';
    sbThumb.style.left = (ratio * maxLeft) + 'px';
  }

  // === FX EFFECT PANEL ===
  const FX_ORDER = ['eq', 'phaser', 'reverb', 'delay', 'chorus', 'distortion'];
  const FX_LABELS = {
    eq: 'Parametric EQ 2', phaser: 'Phaser',
    reverb: 'Reeverb 2', delay: 'Delay 3',
    chorus: 'Chorus', distortion: 'Blood Overdrive'
  };

  // Presets per effect
  const FX_PRESETS = {
    eq: {
      'Default': { lowFreq: 200, lowGain: 0, midFreq: 1000, midGain: 0, midQ: 1, highFreq: 5000, highGain: 0 },
      'Bass Boost': { lowFreq: 150, lowGain: 8, midFreq: 800, midGain: -2, midQ: 1.2, highFreq: 6000, highGain: 1 },
      'Bright': { lowFreq: 200, lowGain: -2, midFreq: 2500, midGain: 3, midQ: 0.8, highFreq: 4000, highGain: 7 },
      'Warm': { lowFreq: 250, lowGain: 4, midFreq: 1200, midGain: 2, midQ: 1.5, highFreq: 5000, highGain: -4 },
      'Scoop': { lowFreq: 200, lowGain: 5, midFreq: 1000, midGain: -6, midQ: 1.0, highFreq: 4000, highGain: 5 }
    },
    phaser: {
      'Default': { rate: 0.5, depth: 0.7, stages: 4, feedback: 0.4 },
      'Slow Sweep': { rate: 0.15, depth: 0.8, stages: 6, feedback: 0.5 },
      'Fast': { rate: 3.0, depth: 0.5, stages: 4, feedback: 0.3 },
      'Deep': { rate: 0.4, depth: 1.0, stages: 8, feedback: 0.7 }
    },
    reverb: {
      'Default': { decay: 1.5, mix: 0.3, preDelay: 0.02, damping: 5000 },
      'Hall': { decay: 3.5, mix: 0.4, preDelay: 0.04, damping: 4000 },
      'Room': { decay: 0.6, mix: 0.25, preDelay: 0.01, damping: 7000 },
      'Cathedral': { decay: 5.0, mix: 0.5, preDelay: 0.06, damping: 3000 }
    },
    delay: {
      'Default': { time: 0.375, feedback: 0.35, mix: 0.3, filter: 4000 },
      '1/4 Note': { time: 0.5, feedback: 0.4, mix: 0.35, filter: 5000 },
      'Slapback': { time: 0.08, feedback: 0.1, mix: 0.4, filter: 8000 },
      'Dub': { time: 0.6, feedback: 0.7, mix: 0.35, filter: 2000 }
    },
    chorus: {
      'Default': { rate: 1.1, depth: 0.006, mix: 0.4 },
      'Subtle': { rate: 0.5, depth: 0.003, mix: 0.25 },
      'Wide': { rate: 0.8, depth: 0.015, mix: 0.55 },
      'Vibrato': { rate: 4.0, depth: 0.012, mix: 0.7 }
    },
    distortion: {
      'Default': { drive: 4, tone: 3000, mix: 0.5 },
      'Warm OD': { drive: 2, tone: 4000, mix: 0.4 },
      'Crunch': { drive: 8, tone: 2500, mix: 0.6 },
      'Fuzz': { drive: 18, tone: 1500, mix: 0.8 }
    }
  };

  function fmtVal(val, max) {
    if (max >= 1000) return (val / 1000).toFixed(1) + 'k';
    if (max > 20) return Math.round(val).toString();
    return val < 1 ? val.toFixed(val < 0.01 ? 3 : 2) : val.toFixed(1);
  }

  // === SVG Rotary Knob (realistic with arc track) ===
  function createFxKnob(label, min, max, initVal, onChange, accentColor) {
    const wrap = document.createElement('div');
    wrap.className = 'fx-knob-wrap';
    const lblEl = document.createElement('div');
    lblEl.className = 'fx-knob-label';
    lblEl.textContent = label;
    const sz = 36, cx = 18, cy = 18, r = 13;
    const accent = accentColor || '#55aadd';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', sz); svg.setAttribute('height', sz);
    svg.setAttribute('viewBox', '0 0 ' + sz + ' ' + sz);
    svg.classList.add('fx-knob-svg');
    // Background arc (track)
    const startAngle = 135, endAngle = 405; // 270 degree sweep
    function polarToXY(angle, rad) {
      const a = (angle - 90) * Math.PI / 180;
      return { x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) };
    }
    const bgStart = polarToXY(startAngle, r);
    const bgEnd = polarToXY(endAngle, r);
    const bgArc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    bgArc.setAttribute('d', 'M ' + bgStart.x + ' ' + bgStart.y + ' A ' + r + ' ' + r + ' 0 1 1 ' + bgEnd.x + ' ' + bgEnd.y);
    bgArc.setAttribute('fill', 'none');
    bgArc.setAttribute('stroke', '#808080');
    bgArc.setAttribute('stroke-width', '2.5');
    bgArc.setAttribute('stroke-linecap', 'round');
    svg.appendChild(bgArc);
    // Value arc (colored)
    const valArc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    valArc.setAttribute('fill', 'none');
    valArc.setAttribute('stroke', accent);
    valArc.setAttribute('stroke-width', '2.5');
    valArc.setAttribute('stroke-linecap', 'round');
    svg.appendChild(valArc);
    // Knob body circle
    const body = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    body.setAttribute('cx', cx); body.setAttribute('cy', cy); body.setAttribute('r', r - 3);
    body.setAttribute('fill', 'url(#knobGrad)');
    body.setAttribute('stroke', '#404040');
    body.setAttribute('stroke-width', '0.5');
    // Gradient def
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const grad = document.createElementNS('http://www.w3.org/2000/svg', 'radialGradient');
    grad.id = 'knobGrad_' + Math.random().toString(36).slice(2, 8);
    grad.setAttribute('cx', '40%'); grad.setAttribute('cy', '35%');
    const s1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    s1.setAttribute('offset', '0%'); s1.setAttribute('stop-color', '#d8d8d8');
    const s2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    s2.setAttribute('offset', '100%'); s2.setAttribute('stop-color', '#808080');
    grad.appendChild(s1); grad.appendChild(s2);
    defs.appendChild(grad);
    body.setAttribute('fill', 'url(#' + grad.id + ')');
    svg.appendChild(defs);
    svg.appendChild(body);
    // Indicator line
    const indicator = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    indicator.setAttribute('stroke', '#000');
    indicator.setAttribute('stroke-width', '2');
    indicator.setAttribute('stroke-linecap', 'round');
    svg.appendChild(indicator);
    const valEl = document.createElement('div');
    valEl.className = 'fx-knob-val';
    wrap.appendChild(lblEl);
    wrap.appendChild(svg);
    wrap.appendChild(valEl);
    let value = initVal;
    let throttleId = 0;
    function setVal(v, emit) {
      value = Math.max(min, Math.min(max, v));
      const norm = (value - min) / (max - min);
      const angle = startAngle + norm * 270;
      // Update value arc
      if (norm > 0.001) {
        const vs = polarToXY(startAngle, r);
        const ve = polarToXY(angle, r);
        const largeArc = norm * 270 > 180 ? 1 : 0;
        valArc.setAttribute('d', 'M ' + vs.x + ' ' + vs.y + ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' 1 ' + ve.x + ' ' + ve.y);
      } else {
        valArc.setAttribute('d', '');
      }
      // Update indicator
      const indEnd = polarToXY(angle, r - 4);
      const indStart = polarToXY(angle, r - 9);
      indicator.setAttribute('x1', indStart.x); indicator.setAttribute('y1', indStart.y);
      indicator.setAttribute('x2', indEnd.x); indicator.setAttribute('y2', indEnd.y);
      valEl.textContent = fmtVal(value, max);
      if (emit && onChange) {
        if (!throttleId) {
          throttleId = requestAnimationFrame(() => { throttleId = 0; onChange(value); });
        }
      }
    }
    setVal(value, false);
    function handleDrag(startY) {
      const startVal = value;
      const range = max - min;
      const sensitivity = range / 120;
      return (clientY) => {
        const dy = startY - clientY;
        setVal(startVal + dy * sensitivity, true);
      };
    }
    svg.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const update = handleDrag(e.clientY);
      const onMove = (ev) => update(ev.clientY);
      const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    svg.addEventListener('touchstart', (e) => {
      e.preventDefault(); e.stopPropagation();
      const update = handleDrag(e.touches[0].clientY);
      const onMove = (ev) => update(ev.touches[0].clientY);
      const onEnd = () => { window.removeEventListener('touchmove', onMove); window.removeEventListener('touchend', onEnd); };
      window.addEventListener('touchmove', onMove);
      window.addEventListener('touchend', onEnd);
    });
    return { el: wrap, setVal: (v) => setVal(v, false), getVal: () => value };
  }

  // === Vertical fader (for Reverb) ===
  function createVerticalFader(label, min, max, initVal, color, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'fx-rvb-fader';
    const lblEl = document.createElement('div');
    lblEl.className = 'fx-rvb-fader-lbl';
    lblEl.textContent = label;
    const track = document.createElement('div');
    track.className = 'fx-rvb-fader-track';
    const fill = document.createElement('div');
    fill.className = 'fx-rvb-fader-fill';
    fill.style.background = color;
    track.appendChild(fill);
    wrap.appendChild(lblEl);
    wrap.appendChild(track);
    let value = initVal;
    let throttleId = 0;
    function setVal(v, emit) {
      value = Math.max(min, Math.min(max, v));
      fill.style.height = ((value - min) / (max - min) * 100) + '%';
      if (emit && onChange) {
        if (!throttleId) { throttleId = requestAnimationFrame(() => { throttleId = 0; onChange(value); }); }
      }
    }
    setVal(value, false);
    function startDrag(e) {
      e.preventDefault(); e.stopPropagation();
      const rect = track.getBoundingClientRect();
      const update = (clientY) => {
        const norm = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        setVal(min + norm * (max - min), true);
      };
      return update;
    }
    track.addEventListener('mousedown', (e) => {
      const update = startDrag(e); update(e.clientY);
      const onMove = (ev) => update(ev.clientY);
      const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    });
    track.addEventListener('touchstart', (e) => {
      const update = startDrag(e); update(e.touches[0].clientY);
      const onMove = (ev) => update(ev.touches[0].clientY);
      const onEnd = () => { window.removeEventListener('touchmove', onMove); window.removeEventListener('touchend', onEnd); };
      window.addEventListener('touchmove', onMove); window.addEventListener('touchend', onEnd);
    });
    return { el: wrap, setVal: (v) => setVal(v, false) };
  }

  // === EQ: Parametric EQ 2 — canvas with draggable colored nodes ===
  const EQ_BANDS = [
    { param: 'lowGain', freqParam: 'lowFreq', color: '#ff4444', label: 'Low' },
    { param: 'midGain', freqParam: 'midFreq', color: '#44dd44', label: 'Mid' },
    { param: 'highGain', freqParam: 'highFreq', color: '#4488ff', label: 'High' }
  ];
  function freqToX(f, w) { return (Math.log10(f) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20)) * w; }
  function xToFreq(x, w) { return 20 * Math.pow(20000 / 20, x / w); }
  function gainToY(g, h) { return h / 2 - (g / 14) * (h / 2); }
  function yToGain(y, h) { return -((y - h / 2) / (h / 2)) * 14; }

  function drawEqCurve(canvas, params, hov) {
    const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#0a2030'; ctx.lineWidth = 1;
    for (let db = -12; db <= 12; db += 6) {
      ctx.globalAlpha = db === 0 ? 0.5 : 0.2;
      const y = gainToY(db, h);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    [100, 500, 1000, 5000, 10000].forEach(f => {
      ctx.globalAlpha = 0.15;
      const x = freqToX(f, w);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    });
    ctx.globalAlpha = 1;
    // Combined curve
    ctx.beginPath(); ctx.strokeStyle = '#6699dd'; ctx.lineWidth = 1.5;
    for (let px = 0; px < w; px++) {
      const freq = xToFreq(px, w);
      let gain = 0;
      if (freq < params.lowFreq * 2) gain += params.lowGain * Math.max(0, 1 - freq / (params.lowFreq * 2));
      const ml = Math.log2(freq / params.midFreq), bw = 1 / Math.max(0.1, params.midQ);
      gain += params.midGain * Math.exp(-ml * ml / (bw * bw * 0.5));
      if (freq > params.highFreq * 0.5) gain += params.highGain * Math.min(1, (freq - params.highFreq * 0.5) / (params.highFreq * 0.5));
      const y = gainToY(gain, h);
      px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
    }
    ctx.stroke();
    ctx.lineTo(w, h / 2); ctx.lineTo(0, h / 2); ctx.closePath();
    ctx.fillStyle = '#6699dd10'; ctx.fill();
    // Nodes
    EQ_BANDS.forEach((band, bi) => {
      const nx = freqToX(params[band.freqParam], w), ny = gainToY(params[band.param], h);
      const rad = hov === bi ? 7 : 5;
      ctx.beginPath(); ctx.arc(nx, ny, rad + 3, 0, Math.PI * 2);
      ctx.fillStyle = band.color + '30'; ctx.fill();
      ctx.beginPath(); ctx.arc(nx, ny, rad, 0, Math.PI * 2);
      ctx.fillStyle = band.color; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    });
  }

  function buildEqUI(params, onChange) {
    const body = document.createElement('div');
    body.className = 'fx-effect-inner';
    const sunken = document.createElement('div');
    sunken.className = 'fx-sunken';
    const canvas = document.createElement('canvas');
    canvas.className = 'fx-eq-canvas';
    canvas.width = 350; canvas.height = 80;
    sunken.appendChild(canvas);
    body.appendChild(sunken);
    let hovBand = -1, dragBand = -1;
    const knobRefs = [];
    function redraw() { drawEqCurve(canvas, params, hovBand); }
    redraw();
    function findBand(mx, my) {
      let best = -1, bestD = 16;
      EQ_BANDS.forEach((b, i) => {
        const d = Math.hypot(mx - freqToX(params[b.freqParam], canvas.width), my - gainToY(params[b.param], canvas.height));
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    }
    function canvasXY(e, rect) {
      const cX = (e.clientX || e.touches[0].clientX) - rect.left;
      const cY = (e.clientY || e.touches[0].clientY) - rect.top;
      return { mx: cX * (canvas.width / rect.width), my: cY * (canvas.height / rect.height) };
    }
    function startNodeDrag(band, rect, updateKnobs) {
      return (ev) => {
        const { mx, my } = canvasXY(ev.touches ? { clientX: ev.touches[0].clientX, clientY: ev.touches[0].clientY } : ev, rect);
        const nf = Math.max(20, Math.min(20000, xToFreq(mx, canvas.width)));
        const ng = Math.max(-12, Math.min(12, yToGain(my, canvas.height)));
        params[band.freqParam] = nf; params[band.param] = ng;
        onChange(band.freqParam, nf); onChange(band.param, ng);
        redraw();
        if (updateKnobs && knobRefs[dragBand]) {
          knobRefs[dragBand].freq.setVal(nf); knobRefs[dragBand].gain.setVal(ng);
        }
      };
    }
    canvas.addEventListener('mousemove', (e) => {
      if (dragBand >= 0) return;
      const rect = canvas.getBoundingClientRect();
      const { mx, my } = canvasXY(e, rect);
      const old = hovBand; hovBand = findBand(mx, my);
      if (hovBand !== old) redraw();
      canvas.style.cursor = hovBand >= 0 ? 'grab' : 'crosshair';
    });
    canvas.addEventListener('mouseleave', () => { if (dragBand < 0) { hovBand = -1; redraw(); } });
    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const rect = canvas.getBoundingClientRect();
      const { mx, my } = canvasXY(e, rect);
      dragBand = findBand(mx, my); if (dragBand < 0) return;
      canvas.style.cursor = 'grabbing';
      const update = startNodeDrag(EQ_BANDS[dragBand], rect, true);
      const onMove = (ev) => update(ev);
      const onUp = () => { dragBand = -1; canvas.style.cursor = 'crosshair'; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    });
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault(); e.stopPropagation();
      const rect = canvas.getBoundingClientRect();
      const { mx, my } = canvasXY({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY }, rect);
      dragBand = findBand(mx, my); if (dragBand < 0) return;
      const update = startNodeDrag(EQ_BANDS[dragBand], rect, true);
      const onMove = (ev) => update(ev);
      const onEnd = () => { dragBand = -1; window.removeEventListener('touchmove', onMove); window.removeEventListener('touchend', onEnd); };
      window.addEventListener('touchmove', onMove); window.addEventListener('touchend', onEnd);
    });
    // Knobs below canvas
    const knobRow = document.createElement('div');
    knobRow.className = 'fx-eq-knobs';
    EQ_BANDS.forEach((band, bi) => {
      const fk = createFxKnob(band.label + ' Hz', 20, 20000, params[band.freqParam], (v) => {
        params[band.freqParam] = v; onChange(band.freqParam, v); redraw();
      }, band.color);
      const gk = createFxKnob(band.label + ' dB', -12, 12, params[band.param], (v) => {
        params[band.param] = v; onChange(band.param, v); redraw();
      }, band.color);
      knobRow.appendChild(fk.el); knobRow.appendChild(gk.el);
      knobRefs.push({ freq: fk, gain: gk });
    });
    const qk = createFxKnob('Q', 0.1, 10, params.midQ, (v) => {
      params.midQ = v; onChange('midQ', v); redraw();
    }, '#44dd44');
    knobRow.appendChild(qk.el);
    body.appendChild(knobRow);
    return { el: body, redraw };
  }

  // === Phaser: dark grey, 4 knobs ===
  function buildPhaserUI(params, onChange) {
    const body = document.createElement('div');
    body.className = 'fx-effect-inner';
    const row = document.createElement('div');
    row.className = 'fx-phaser-row';
    [
      { label: 'Rate', param: 'rate', min: 0.1, max: 5, color: '#9966cc' },
      { label: 'Depth', param: 'depth', min: 0, max: 1, color: '#8855bb' },
      { label: 'Feedback', param: 'feedback', min: 0, max: 0.9, color: '#7744aa' },
      { label: 'Stages', param: 'stages', min: 2, max: 8, color: '#6633aa' }
    ].forEach(d => {
      row.appendChild(createFxKnob(d.label, d.min, d.max, params[d.param], (v) => {
        params[d.param] = v; onChange(d.param, v);
      }, d.color).el);
    });
    body.appendChild(row);
    return { el: body };
  }

  // === Reeverb 2: 3 faders left + 2 knobs right ===
  function buildReverbUI(params, onChange) {
    const body = document.createElement('div');
    body.className = 'fx-effect-inner fx-reverb-inner';
    const fadersDiv = document.createElement('div');
    fadersDiv.className = 'fx-reverb-faders';
    const dryF = createVerticalFader('DRY', 0, 1, 1 - params.mix, '#44aa88', (v) => {
      params.mix = 1 - v; onChange('mix', 1 - v); wetF.setVal(1 - v);
    });
    const erF = createVerticalFader('ER', 0, 0.1, params.preDelay, '#55bb99', (v) => {
      params.preDelay = v; onChange('preDelay', v);
    });
    const wetF = createVerticalFader('WET', 0, 1, params.mix, '#66ccaa', (v) => {
      params.mix = v; onChange('mix', v); dryF.setVal(1 - v);
    });
    fadersDiv.appendChild(dryF.el); fadersDiv.appendChild(erF.el); fadersDiv.appendChild(wetF.el);
    body.appendChild(fadersDiv);
    const knobsDiv = document.createElement('div');
    knobsDiv.className = 'fx-reverb-knobs';
    knobsDiv.appendChild(createFxKnob('Decay', 0.2, 5, params.decay, (v) => {
      params.decay = v; onChange('decay', v);
    }, '#44aa88').el);
    knobsDiv.appendChild(createFxKnob('Damp', 500, 10000, params.damping, (v) => {
      params.damping = v; onChange('damping', v);
    }, '#55bb99').el);
    body.appendChild(knobsDiv);
    return { el: body };
  }

  // === Delay 3: sectioned layout with feedback ring ===
  function buildDelayUI(params, onChange) {
    const body = document.createElement('div');
    body.className = 'fx-effect-inner';
    const secs = document.createElement('div');
    secs.className = 'fx-delay-sections';
    function sec(title, children) {
      const d = document.createElement('div'); d.className = 'fx-delay-sec';
      const t = document.createElement('div'); t.className = 'fx-delay-sec-title'; t.textContent = title;
      d.appendChild(t);
      children.forEach(c => d.appendChild(c));
      return d;
    }
    const timeK = createFxKnob('Time', 0.05, 1, params.time, (v) => { params.time = v; onChange('time', v); }, '#cc8833');
    const fbRing = document.createElement('div'); fbRing.className = 'fx-delay-fb-ring';
    function updRing() {
      const n = params.feedback / 0.85;
      fbRing.style.borderColor = 'rgb(' + Math.round(n * 220) + ',' + Math.round((1 - n) * 180) + ',50)';
    }
    updRing();
    const fbK = createFxKnob('FB', 0, 0.85, params.feedback, (v) => { params.feedback = v; onChange('feedback', v); updRing(); }, '#cc8833');
    const mixK = createFxKnob('Mix', 0, 1, params.mix, (v) => { params.mix = v; onChange('mix', v); }, '#cc8833');
    const filtK = createFxKnob('Filter', 500, 10000, params.filter, (v) => { params.filter = v; onChange('filter', v); }, '#aa7722');
    secs.appendChild(sec('TIME', [timeK.el]));
    secs.appendChild(sec('FEEDBACK', [fbRing, fbK.el]));
    secs.appendChild(sec('OUTPUT', [mixK.el, filtK.el]));
    body.appendChild(secs);
    return { el: body };
  }

  // === Chorus: 3 knobs ===
  function buildChorusUI(params, onChange) {
    const body = document.createElement('div');
    body.className = 'fx-effect-inner';
    const row = document.createElement('div');
    row.className = 'fx-chorus-row';
    [
      { label: 'Rate', param: 'rate', min: 0.1, max: 5, color: '#55aadd' },
      { label: 'Depth', param: 'depth', min: 0.001, max: 0.02, color: '#4499cc' },
      { label: 'Mix', param: 'mix', min: 0, max: 1, color: '#3388bb' }
    ].forEach(d => {
      row.appendChild(createFxKnob(d.label, d.min, d.max, params[d.param], (v) => {
        params[d.param] = v; onChange(d.param, v);
      }, d.color).el);
    });
    body.appendChild(row);
    return { el: body };
  }

  // === Blood Overdrive: red theme, 3 knobs ===
  function buildOverdriveUI(params, onChange) {
    const body = document.createElement('div');
    body.className = 'fx-effect-inner';
    const row = document.createElement('div');
    row.className = 'fx-od-row';
    [
      { label: 'Drive', param: 'drive', min: 1, max: 20, color: '#dd4444' },
      { label: 'Tone', param: 'tone', min: 500, max: 10000, color: '#cc3333' },
      { label: 'Mix', param: 'mix', min: 0, max: 1, color: '#bb2222' }
    ].forEach(d => {
      row.appendChild(createFxKnob(d.label, d.min, d.max, params[d.param], (v) => {
        params[d.param] = v; onChange(d.param, v);
      }, d.color).el);
    });
    body.appendChild(row);
    return { el: body };
  }

  const FX_BUILDERS = {
    eq: buildEqUI, phaser: buildPhaserUI, reverb: buildReverbUI,
    delay: buildDelayUI, chorus: buildChorusUI, distortion: buildOverdriveUI
  };

  // === Build individual FX slot ===
  function buildFxSlot(fxName, fxState, isMain, trackIdx, isDrum) {
    const slot = document.createElement('div');
    slot.className = 'w95-fx-slot';
    slot.dataset.on = fxState.enabled ? '1' : '0';
    // Header: power button + name + preset + arrow
    const header = document.createElement('div');
    header.className = 'w95-fx-slot-header';
    const powerBtn = document.createElement('div');
    powerBtn.className = 'fx-power-btn';
    const nameEl = document.createElement('span');
    nameEl.className = 'w95-fx-slot-name';
    nameEl.textContent = FX_LABELS[fxName];
    // Preset dropdown
    const presetSel = document.createElement('select');
    presetSel.className = 'fx-preset-select';
    const presets = FX_PRESETS[fxName];
    if (presets) {
      Object.keys(presets).forEach(name => {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        presetSel.appendChild(opt);
      });
    }
    const arrow = document.createElement('span');
    arrow.className = 'w95-fx-slot-arrow';
    arrow.textContent = '\u25B6';
    header.appendChild(powerBtn);
    header.appendChild(nameEl);
    header.appendChild(presetSel);
    header.appendChild(arrow);
    slot.appendChild(header);
    // Controls
    const controls = document.createElement('div');
    controls.className = 'w95-fx-controls';
    let uiRef = null;
    const builder = FX_BUILDERS[fxName];
    if (builder) {
      uiRef = builder(fxState.params, (paramName, value) => {
        if (isMain) setMainEffectParam(fxName, paramName, value);
        else setTrackEffectParam(trackIdx, isDrum, fxName, paramName, value);
      });
      controls.appendChild(uiRef.el);
    }
    slot.appendChild(controls);
    // Preset change
    presetSel.addEventListener('change', (e) => {
      e.stopPropagation();
      const p = presets[presetSel.value];
      if (!p) return;
      Object.keys(p).forEach(k => {
        fxState.params[k] = p[k];
        if (isMain) setMainEffectParam(fxName, k, p[k]);
        else setTrackEffectParam(trackIdx, isDrum, fxName, k, p[k]);
      });
      // Rebuild UI for this slot
      controls.innerHTML = '';
      const newBuilder = FX_BUILDERS[fxName];
      if (newBuilder) {
        uiRef = newBuilder(fxState.params, (paramName, value) => {
          if (isMain) setMainEffectParam(fxName, paramName, value);
          else setTrackEffectParam(trackIdx, isDrum, fxName, paramName, value);
        });
        controls.appendChild(uiRef.el);
      }
    });
    presetSel.addEventListener('mousedown', (e) => e.stopPropagation());
    // Header click: expand/collapse
    header.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target === presetSel || e.target.closest('.fx-preset-select')) return;
      slot.classList.toggle('w95-fx-expanded');
    });
    // Power button: on/off
    powerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nowOn = slot.dataset.on === '1';
      slot.dataset.on = nowOn ? '0' : '1';
      if (isMain) setMainEffectEnabled(fxName, !nowOn);
      else setTrackEffectEnabled(trackIdx, isDrum, fxName, !nowOn);
    });
    return { el: slot, updateFromState: (s) => { slot.dataset.on = s.enabled ? '1' : '0'; } };
  }

  let fxScrollArea = null, fxVScroll = null, fxVsThumb = null, fxVsTrack = null;

  function createFxPanel() {
    fxPanel = document.createElement('div');
    fxPanel.className = 'w95-fx-panel';
    const titlebar = document.createElement('div');
    titlebar.className = 'w95-fx-titlebar';
    fxPanelTitle = document.createElement('span');
    fxPanelTitle.textContent = 'INSERTS';
    titlebar.appendChild(fxPanelTitle);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'w95-mixer-titlebar-btn';
    closeBtn.textContent = 'x';
    closeBtn.style.fontSize = '9px';
    closeBtn.addEventListener('click', () => {
      fxPanel.classList.remove('w95-fx-open');
      selectedMixerTrack = null;
      mixerTrackData.forEach(ch => ch.el.classList.remove('w95-ch-selected'));
      const masterEl = mixerChannelsEl && mixerChannelsEl.querySelector('.w95-mixer-master');
      if (masterEl) masterEl.classList.remove('w95-ch-selected');
    });
    titlebar.appendChild(closeBtn);
    fxPanel.appendChild(titlebar);
    // Body with W95 custom vertical scrollbar
    const body = document.createElement('div');
    body.className = 'w95-fx-body';
    fxScrollArea = document.createElement('div');
    fxScrollArea.className = 'w95-fx-scroll-area';
    fxRack = fxScrollArea;
    body.appendChild(fxScrollArea);
    // W95 vertical scrollbar
    fxVScroll = document.createElement('div');
    fxVScroll.className = 'w95-fx-vscroll';
    const upBtn = document.createElement('button');
    upBtn.className = 'w95-fx-vs-btn';
    upBtn.textContent = '\u25B2';
    upBtn.addEventListener('mousedown', () => { fxScrollArea.scrollTop -= 40; });
    fxVsTrack = document.createElement('div');
    fxVsTrack.className = 'w95-fx-vs-track';
    fxVsThumb = document.createElement('div');
    fxVsThumb.className = 'w95-fx-vs-thumb';
    fxVsTrack.appendChild(fxVsThumb);
    const downBtn = document.createElement('button');
    downBtn.className = 'w95-fx-vs-btn';
    downBtn.textContent = '\u25BC';
    downBtn.addEventListener('mousedown', () => { fxScrollArea.scrollTop += 40; });
    fxVScroll.appendChild(upBtn);
    fxVScroll.appendChild(fxVsTrack);
    fxVScroll.appendChild(downBtn);
    body.appendChild(fxVScroll);
    fxPanel.appendChild(body);
    mixerPanel.appendChild(fxPanel);
    // Scrollbar logic
    fxScrollArea.style.overflowY = 'scroll';
    fxScrollArea.style.scrollbarWidth = 'none';
    fxScrollArea.style.msOverflowStyle = 'none';
    // Hide native scrollbar via inline style for webkit
    const hideNative = document.createElement('style');
    hideNative.textContent = '.w95-fx-scroll-area::-webkit-scrollbar{display:none}';
    document.head.appendChild(hideNative);
    function updateFxVScrollbar() {
      if (!fxVScroll || !fxScrollArea || !fxVsThumb || !fxVsTrack) return;
      const sH = fxScrollArea.scrollHeight;
      const cH = fxScrollArea.clientHeight;
      if (sH <= cH + 2) { fxVScroll.classList.remove('w95-fx-vs-show'); return; }
      fxVScroll.classList.add('w95-fx-vs-show');
      const trackH = fxVsTrack.offsetHeight;
      const thumbH = Math.max(16, (cH / sH) * trackH);
      const maxTop = trackH - thumbH;
      const ratio = fxScrollArea.scrollTop / Math.max(1, sH - cH);
      fxVsThumb.style.height = thumbH + 'px';
      fxVsThumb.style.top = (ratio * maxTop) + 'px';
    }
    fxScrollArea.addEventListener('scroll', updateFxVScrollbar);
    // Observe content changes
    const obs = new MutationObserver(updateFxVScrollbar);
    obs.observe(fxScrollArea, { childList: true, subtree: true });
    // Thumb drag
    fxVsThumb.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startTop = fxVsThumb.offsetTop;
      const trackH = fxVsTrack.offsetHeight;
      const thumbH = fxVsThumb.offsetHeight;
      const maxTop = trackH - thumbH;
      const maxScroll = fxScrollArea.scrollHeight - fxScrollArea.clientHeight;
      const onMove = (ev) => {
        const dy = ev.clientY - startY;
        const newTop = Math.max(0, Math.min(maxTop, startTop + dy));
        fxScrollArea.scrollTop = (newTop / Math.max(1, maxTop)) * maxScroll;
      };
      const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    // Wheel support
    fxScrollArea.addEventListener('wheel', () => {
      requestAnimationFrame(updateFxVScrollbar);
    });
    requestAnimationFrame(updateFxVScrollbar);
  }

  function updateFxPanelForTrack(trackIdx, isDrum, trackName, isMain) {
    if (!fxPanel || !fxRack) return;
    fxPanelTitle.textContent = 'INSERTS \u2014 ' + (trackName.length > 20 ? trackName.slice(0, 19) + '\u2026' : trackName);
    fxRack.innerHTML = '';
    fxPanelSlots = [];
    const effects = isMain ? getMainEffects() : getTrackEffects(trackIdx, isDrum);
    FX_ORDER.forEach(fxName => {
      const slotData = buildFxSlot(fxName, effects[fxName], isMain, trackIdx, isDrum);
      slotData.updateFromState(effects[fxName]);
      fxRack.appendChild(slotData.el);
      fxPanelSlots.push(slotData);
    });
  }

  function selectMixerTrack(trackIdx, isDrum, trackName, isMain) {
    mixerTrackData.forEach(ch => {
      if (ch.trackIdx === trackIdx && !isMain) ch.el.classList.add('w95-ch-selected');
      else ch.el.classList.remove('w95-ch-selected');
    });
    // Also highlight master channel if selecting it
    const masterEl = mixerChannelsEl && mixerChannelsEl.querySelector('.w95-mixer-master');
    if (masterEl) masterEl.classList.toggle('w95-ch-selected', !!isMain);
    selectedMixerTrack = { trackIdx, isDrum, name: trackName, isMain: !!isMain };
    if (!fxPanel) createFxPanel();
    updateFxPanelForTrack(trackIdx, isDrum, trackName, isMain);
    fxPanel.classList.add('w95-fx-open');
  }

  function positionMixerPanel() {
    if (!mixerPanel) return;
    const PANEL_GAP = 4;
    // Position below the MIDI float panel
    const fp = document.querySelector('.midi-float-panel');
    if (fp) {
      const rect = fp.getBoundingClientRect();
      mixerPanel.style.top = (rect.bottom + PANEL_GAP) + 'px';
    } else {
      mixerPanel.style.top = '32px';
    }
  }

  function buildMixerChannel(trackIdx, trackName, isDrum) {
    const ch = document.createElement('div');
    ch.className = 'w95-mixer-ch';
    // Track number + name
    const label = document.createElement('div');
    label.className = 'w95-mixer-ch-label';
    label.textContent = trackName.length > 7 ? trackName.slice(0, 6) + '…' : trackName;
    label.title = trackName;
    ch.appendChild(label);
    const tag = document.createElement('div');
    tag.className = 'w95-mixer-ch-tag';
    tag.textContent = isDrum ? 'DRUM' : ('CH ' + trackIdx);
    ch.appendChild(tag);
    // Fader + meter row
    const faderRow = document.createElement('div');
    faderRow.style.cssText = 'display:flex;gap:2px;align-items:flex-end;';
    // Fader (drag-based)
    const faderWrap = document.createElement('div');
    faderWrap.className = 'w95-mixer-fader-wrap';
    const faderFill = document.createElement('div');
    faderFill.className = 'w95-mixer-fader-fill';
    faderFill.style.height = '80%';
    faderWrap.appendChild(faderFill);
    const faderThumb = document.createElement('div');
    faderThumb.className = 'w95-mixer-fader-thumb';
    faderThumb.style.bottom = 'calc(80% - 3px)';
    faderWrap.appendChild(faderThumb);
    let faderVal = 80;
    function setFaderVal(v) {
      faderVal = Math.max(0, Math.min(100, v));
      faderFill.style.height = faderVal + '%';
      faderThumb.style.bottom = 'calc(' + faderVal + '% - 3px)';
      volVal.textContent = faderVal + '%';
      const vol = faderVal / 100;
      if (isDrum) {
        if (typeof setDrumTrackVolume === 'function') setDrumTrackVolume(trackIdx, vol);
      } else {
        if (typeof setTrackVolume === 'function') setTrackVolume(trackIdx, vol);
      }
    }
    faderWrap.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const rect = faderWrap.getBoundingClientRect();
      const updateFromY = (clientY) => {
        const pct = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        setFaderVal(Math.round(pct * 100));
      };
      updateFromY(e.clientY);
      const onMove = (ev) => updateFromY(ev.clientY);
      const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    faderRow.appendChild(faderWrap);
    // Meter
    const meter = document.createElement('div');
    meter.className = 'w95-mixer-meter';
    const meterFill = document.createElement('div');
    meterFill.className = 'w95-mixer-meter-fill';
    meter.appendChild(meterFill);
    faderRow.appendChild(meter);
    ch.appendChild(faderRow);
    // Vol value
    const volVal = document.createElement('div');
    volVal.className = 'w95-mixer-vol-val';
    volVal.textContent = '80%';
    ch.appendChild(volVal);
    // Pan knob
    const panInput = document.createElement('input');
    panInput.type = 'range';
    panInput.className = 'w95-mixer-pan-input';
    panInput.min = '-100';
    panInput.max = '100';
    panInput.value = '0';
    panInput.title = 'Pan';
    ch.appendChild(panInput);
    const panLabel = document.createElement('div');
    panLabel.className = 'w95-mixer-pan-label';
    panLabel.textContent = 'C';
    panLabel.style.textAlign = 'center';
    ch.appendChild(panLabel);

    // Pan event
    panInput.addEventListener('input', () => {
      const p = parseInt(panInput.value, 10);
      const panVal = p / 100;
      panLabel.textContent = p === 0 ? 'C' : (p < 0 ? 'L' + Math.abs(p) : 'R' + p);
      if (isDrum) {
        if (typeof setDrumTrackPan === 'function') setDrumTrackPan(trackIdx, panVal);
      } else {
        if (typeof setTrackPan === 'function') setTrackPan(trackIdx, panVal);
      }
    });

    // Click to select track for FX panel
    ch.addEventListener('click', (e) => {
      if (e.target.closest('.w95-mixer-fader-wrap') || e.target.closest('.w95-mixer-pan-input') || e.target.closest('.w95-mixer-fader-thumb')) return;
      const isMain = trackIdx === -1;
      selectMixerTrack(trackIdx, isDrum, trackName, isMain);
    });
    ch.style.cursor = 'pointer';

    return { el: ch, setFaderVal, faderFill, panInput, panLabel, volVal, meterFill, trackIdx, isDrum };
  }

  function highlightMixerChannel(trackIdx) {
    if (!mixerTrackData.length) return;
    mixerTrackData.forEach(ch => {
      ch.el.style.background = ch.trackIdx === trackIdx ? '#d4d0c8' : '';
    });
    // Auto-clear highlight after 1.5s
    setTimeout(() => {
      mixerTrackData.forEach(ch => { ch.el.style.background = ''; });
    }, 1500);
  }

  function rebuildMixer() {
    if (!mixerPanel) createMixerPanel();
    mixerChannelsEl.innerHTML = '';
    mixerTrackData = [];
    if (!parsedMidi || !parsedMidi.tracks) {
      mixerPanel.style.display = 'none';
      return;
    }
    parsedMidi.tracks.forEach((track, i) => {
      if (!track.notes || !track.notes.length) return;
      const name = (track.name && track.name.trim()) ? track.name.trim() : ('Track ' + i);
      const isDrum = isPercTrack(track, name);
      const chData = buildMixerChannel(i, name, isDrum);
      mixerChannelsEl.appendChild(chData.el);
      mixerTrackData.push(chData);
    });
    // Master channel
    const masterCh = buildMixerChannel(-1, 'Master', false);
    masterCh.el.classList.add('w95-mixer-master');
    masterCh.setFaderVal(80);
    mixerChannelsEl.appendChild(masterCh.el);
    mixerPanel.style.display = 'block';
    // Close FX panel on rebuild
    if (fxPanel) fxPanel.classList.remove('w95-fx-open');
    selectedMixerTrack = null;
    // Defer positioning + scrollbar update
    requestAnimationFrame(() => { positionMixerPanel(); updateScrollbarThumb(); });
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
  let sourceBeatsPerBar = 4;
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
    const cap = Math.max(64, maxCount || 2400);
    const twoBarSec = Math.min(12.0, Math.max(1.4, (60 / Math.max(40, sourceBpm || 120)) * 8));
    const lookbackSec = 2 * twoBarSec + 0.5;
    const lookaheadSec = 2 * twoBarSec + 0.75;
    const horizon = nowSec + lookaheadSec;
    for (let i = 0; i < src.length; i++) {
      const n = src[i];
      const start = typeof n.time === 'number' ? n.time : 0;
      const dur = Math.max(0.02, typeof n.duration === 'number' ? n.duration : 0.2);
      const end = start + dur;
      if (end < nowSec - lookbackSec) continue;
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
        bpm: sourceBpm,
        beatsPerBar: sourceBeatsPerBar,
        selectedTracks: selectedTrackCount,
        totalTracks: totalTrackCount,
        polyphony: lastPolyphony,
        notes: liveMidiNotes.slice(),
        preview: buildRollPreview(nowSec, 2400)
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
          polyHint: Math.max(1, polyEstimate + 1),
          trackIndex: note.trackIndex
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

    const headerTs = parsedMidi.header.timeSignatures && parsedMidi.header.timeSignatures[0];
    sourceBeatsPerBar = (headerTs && headerTs.timeSignature && headerTs.timeSignature[0]) || 4;

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
    positionMixerPanel();
  });

  function loadMidiFromBuffer(arrayBuffer, fileName) {
    clearPlayback();
    tapTimes = [];
    tapBpm = 0;
    try {
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
        label.addEventListener('click', () => {
          highlightMixerChannel(i);
        });

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
    rebuildMixer();
    emitTransport();
  }

  const fileInput = document.getElementById('midi-file-input');
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    loadMidiFromBuffer(buf, file.name);
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
  // Initialize mixer panel (shows when MIDI is loaded)
  createMixerPanel();
  positionMixerPanel();

  if (typeof api.registerMidiLoader === 'function') {
    api.registerMidiLoader(loadMidiFromBuffer);
  }
}
