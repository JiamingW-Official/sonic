/**
 * MIDI file playback: load file, select tracks, transpose, play/stop.
 * Drives existing createSynthVoice and triggerVisualsForMidi from main.js.
 */
import { Midi } from '@tonejs/midi';

const MAX_NOTE_DURATION_SEC = 10;
const IS_MOBILE = /iPad|iPhone|Android/i.test(navigator.userAgent);
const LOOKAHEAD_SEC = IS_MOBILE ? 0.14 : 0.2;
const CHUNK_MS = IS_MOBILE ? 32 : 24;
const MIDI_POLY_LIMIT = IS_MOBILE ? 10 : 14;
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function expressiveVelocity(note, overPoly) {
  const base = clamp01(typeof note.velocity === 'number' ? note.velocity : 0.8);
  // Keep MIDI dynamics natural, but reduce loudness jumps between notes/chords.
  const shaped = 0.2 + Math.pow(base, 0.9) * 0.76;
  return overPoly ? Math.max(0.06, shaped * 0.9) : shaped;
}

/**
 * @param {object} api
 * @param {function(number, object)} api.createSynthVoice
 * @param {function(number)} api.triggerVisualsForMidi
 * @param {function()} api.initAudio
 * @param {function()} api.getAudioContext
 */
export function initMidiPlayer(api) {
  const { createSynthVoice, triggerVisualsForMidi, initAudio, getAudioContext, updateKeyDisplayFromMidi } = api;
  let parsedMidi = null;
  let activeVoices = [];
  let playbackIntervalId = null;
  let endTimeoutId = null;
  let progressWrap = null;
  let progressBar = null;
  let waveCanvas = null;

  const container = document.createElement('div');
  container.setAttribute('aria-label', 'MIDI player');
  container.className = 'midi-player';

  const fileLabel = document.createElement('label');
  fileLabel.className = 'midi-player-label';
  fileLabel.innerHTML = 'MIDI: <input type="file" accept=".mid,.midi" id="midi-file-input" class="midi-player-file">';
  container.appendChild(fileLabel);

  const trackList = document.createElement('div');
  trackList.id = 'midi-track-list';
  trackList.className = 'midi-player-tracks';
  container.appendChild(trackList);

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

  transposeSelect.addEventListener('change', () => {
    currentTranspose = parseInt(transposeSelect.value, 10) || 0;
    if (isPlaying && currentNotes.length) {
      const seekTime = getCurrentTime();
      clearPlayback();
      playbackStartOffset = seekTime;
      startPlayback(seekTime);
    }
  });
  container.appendChild(transposeLabel);

  const infoDiv = document.createElement('div');
  infoDiv.id = 'midi-info';
  infoDiv.className = 'midi-player-info';
  container.appendChild(infoDiv);

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

  const barRoot = document.getElementById('player-bar-root');
  if (!barRoot) {
    const floatPanel = document.createElement('div');
    floatPanel.className = 'midi-float-panel';
    floatPanel.appendChild(container);
    document.body.appendChild(floatPanel);
    progressWrap = document.createElement('div');
    progressWrap.className = 'midi-progress-wrap midi-progress-float';
    progressWrap.dataset.orientation = 'horizontal';
    progressBar = document.createElement('div');
    progressBar.className = 'midi-progress-bar';
    progressBar.setAttribute('aria-label', 'Playback position');
    waveCanvas = document.createElement('canvas');
    waveCanvas.className = 'midi-progress-wave';
    const progressFill0 = document.createElement('div');
    progressFill0.className = 'midi-progress-fill';
    progressBar.appendChild(waveCanvas);
    progressBar.appendChild(progressFill0);
    progressWrap.appendChild(progressBar);
    progressWrap.style.display = 'none';
    document.body.appendChild(progressWrap);
  } else {
    const playerBar = document.createElement('div');
    playerBar.className = 'player-bar';
    const barInner = document.createElement('div');
    barInner.className = 'player-bar-inner';
    progressWrap = document.createElement('div');
    progressWrap.className = 'midi-progress-wrap midi-progress-float';
    progressWrap.dataset.orientation = 'horizontal';
    progressBar = document.createElement('div');
    progressBar.className = 'midi-progress-bar';
    progressBar.setAttribute('aria-label', 'Playback position');
    waveCanvas = document.createElement('canvas');
    waveCanvas.className = 'midi-progress-wave';
    const progressFill = document.createElement('div');
    progressFill.className = 'midi-progress-fill';
    progressBar.appendChild(waveCanvas);
    progressBar.appendChild(progressFill);
    progressWrap.appendChild(progressBar);
    progressWrap.style.display = 'none';
    document.body.appendChild(progressWrap);
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
  }

  const BAR_BINS = 256;
  if (!progressWrap) progressWrap = document.querySelector('.midi-progress-wrap');
  if (!progressBar) progressBar = document.querySelector('.midi-progress-bar');
  if (!waveCanvas && progressBar) waveCanvas = progressBar.querySelector('.midi-progress-wave');
  const progressFill = document.querySelector('.midi-progress-fill');
  const isVerticalProgress = () => !!(progressWrap && progressWrap.dataset && progressWrap.dataset.orientation === 'vertical');

  let complexityBins = [];
  let totalDuration = 0;
  let playbackStartOffset = 0;
  let segmentStartTime = 0;
  let isPlaying = false;
  let currentNotes = [];
  let currentTranspose = 0;
  let rafId = null;

  function buildComplexity(notes) {
    if (!notes.length) return;
    totalDuration = notes.reduce((max, n) => Math.max(max, n.time + Math.min(MAX_NOTE_DURATION_SEC, n.duration)), 0);
    if (totalDuration < 0.01) return;
    const bins = new Float32Array(BAR_BINS);
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const startBin = Math.floor((n.time / totalDuration) * BAR_BINS);
      const endBin = Math.min(BAR_BINS - 1, Math.ceil((n.time + n.duration) / totalDuration * BAR_BINS));
      const activity = (n.velocity || 0.8) * (1 + 0.3 * Math.min(3, endBin - startBin + 1));
      for (let b = startBin; b <= endBin; b++) {
        bins[b] += activity;
      }
    }
    let max = 0;
    for (let i = 0; i < BAR_BINS; i++) if (bins[i] > max) max = bins[i];
    if (max > 0) for (let i = 0; i < BAR_BINS; i++) bins[i] /= max;
    complexityBins = Array.from(bins);
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
        const lineW = Math.max(2, w * (0.18 + 0.82 * v));
        const x = (w - lineW) * 0.5;
        ctx.fillStyle = `rgba(150,235,255,${0.05 + 0.38 * v})`;
        ctx.fillRect(x, y, lineW, Math.ceil(stepH) + 0.5);
      }
    } else {
      const barW = w / BAR_BINS;
      const midY = h / 2;
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      for (let i = 0; i < BAR_BINS; i++) {
        const v = complexityBins[i] || 0;
        const barH = Math.max(1, (h * 0.4) * (0.2 + 0.8 * v));
        ctx.fillRect(i * barW, midY - barH / 2, Math.ceil(barW) + 0.5, barH);
      }
    }
  }

  function getCurrentTime() {
    if (!isPlaying) return playbackStartOffset;
    const ctx = getAudioContext();
    return playbackStartOffset + (ctx.currentTime - segmentStartTime);
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

  function showProgressBar(show) {
    progressWrap.style.display = show ? 'block' : 'none';
    if (show) requestAnimationFrame(() => { drawWave(); updateProgressDisplay(); });
  }

  const fileInput = document.getElementById('midi-file-input');

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
    if (updateKeyDisplayFromMidi) updateKeyDisplayFromMidi([]);
    isPlaying = false;
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
    const prepared = [];
    for (let i = 0; i < currentNotes.length; i++) {
      const n = currentNotes[i];
      const rawDur = Math.min(MAX_NOTE_DURATION_SEC, Math.max(0.02, n.duration));
      const noteStart = n.time;
      const noteEnd = n.time + rawDur;
      if (noteEnd <= fromTime - 0.001) continue;
      const relStart = Math.max(0, noteStart - fromTime);
      const relEnd = Math.max(relStart + 0.02, noteEnd - fromTime);
      prepared.push({
        on: relStart,
        off: relEnd,
        midi: Math.max(0, Math.min(127, n.midi + currentTranspose)),
        velocity: typeof n.velocity === 'number' ? n.velocity : 0.8,
        drop: false
      });
    }
    if (!prepared.length) {
      isPlaying = false;
      stopBtn.disabled = true;
      playBtn.disabled = false;
      playbackStartOffset = totalDuration;
      updateProgressDisplay();
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
        if (overPoly && note.velocity < 0.2) {
          note.drop = true;
          continue;
        }
        const velocity = expressiveVelocity(note, overPoly);
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
        const cur = (activeMidiCounts.get(note.midi) || 0) + 1;
        activeMidiCounts.set(note.midi, cur);
        activePoly++;
        if (visualsBudget > 0) {
          triggerVisualsForMidi(note.midi);
          visualsBudget--;
        }
      }
      while (offIdx < offEvents.length && offEvents[offIdx].off <= relNow) {
        const evt = offEvents[offIdx++];
        if (evt.note && evt.note.drop) continue;
        const midi = evt.midi;
        const cur = (activeMidiCounts.get(midi) || 0) - 1;
        if (cur <= 0) activeMidiCounts.delete(midi);
        else activeMidiCounts.set(midi, cur);
        activePoly = Math.max(0, activePoly - 1);
      }

      if (updateKeyDisplayFromMidi) {
        const sounding = [];
        activeMidiCounts.forEach((count, midi) => { if (count > 0) sounding.push(midi); });
        sounding.sort((a, b) => a - b);
        updateKeyDisplayFromMidi(sounding);
      }

      cleanupVoices(ctx.currentTime);
    }
    function progressLoop() {
      updateProgressDisplay();
      rafId = requestAnimationFrame(progressLoop);
    }
    tick();
    playbackIntervalId = setInterval(tick, CHUNK_MS);
    rafId = requestAnimationFrame(progressLoop);

    const segmentDur = totalDuration - fromTime;
    endTimeoutId = setTimeout(() => {
      if (playbackIntervalId != null) clearInterval(playbackIntervalId);
      playbackIntervalId = null;
      if (rafId != null) cancelAnimationFrame(rafId);
      rafId = null;
      endTimeoutId = null;
      isPlaying = false;
      stopBtn.disabled = true;
      playBtn.disabled = false;
      playbackStartOffset = totalDuration;
      updateProgressDisplay();
      if (updateKeyDisplayFromMidi) updateKeyDisplayFromMidi([]);
    }, (segmentDur + 0.5) * 1000);
  }

  progressBar.addEventListener('click', (e) => {
    if (totalDuration <= 0) return;
    const rect = progressBar.getBoundingClientRect();
    const pct = isVerticalProgress()
      ? Math.max(0, Math.min(1, 1 - ((e.clientY - rect.top) / rect.height)))
      : Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const seekTime = pct * totalDuration;
    playbackStartOffset = seekTime;
    updateProgressDisplay();
    if (isPlaying) startPlayback(seekTime);
  });

  window.addEventListener('resize', () => { drawWave(); });

  function getSelectedTrackIndices() {
    const checkboxes = trackList.querySelectorAll('input[type="checkbox"]');
    const indices = [];
    checkboxes.forEach((cb, i) => { if (cb.checked) indices.push(i); });
    return indices;
  }

  function mergeNotesFromTracks(midi, trackIndices) {
    const notes = [];
    trackIndices.forEach(idx => {
      const track = midi.tracks[idx];
      if (track && track.notes) {
        track.notes.forEach(n => {
          notes.push({
            time: n.time,
            duration: typeof n.duration === 'number' ? n.duration : 0.2,
            midi: n.midi,
            velocity: typeof n.velocity === 'number' ? n.velocity : 0.8
          });
        });
      }
    });
    notes.sort((a, b) => a.time - b.time);
    return notes;
  }

  function updateInfo() {
    if (!parsedMidi) {
      infoDiv.textContent = 'Load a .mid file';
      return;
    }
    const bpm = parsedMidi.header.tempos && parsedMidi.header.tempos[0] ? Math.round(parsedMidi.header.tempos[0].bpm) : '—';
    let maxEnd = 0;
    parsedMidi.tracks.forEach(tr => {
      if (tr.notes && tr.notes.length) {
        tr.notes.forEach(n => {
          const end = n.time + (typeof n.duration === 'number' ? n.duration : 0.2);
          if (end > maxEnd) maxEnd = end;
        });
      }
    });
    const dur = maxEnd > 0 ? (Math.round(maxEnd * 10) / 10) + ' s' : '—';
    infoDiv.textContent = 'BPM: ' + bpm + ' · Duration: ' + dur;
  }

  function rebuildWaveFromSelection() {
    if (!parsedMidi) return;
    const indices = getSelectedTrackIndices();
    if (indices.length === 0) return;
    const notes = mergeNotesFromTracks(parsedMidi, indices);
    if (notes.length === 0) return;
    buildComplexity(notes);
    drawWave();
  }

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
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
        const name = (track.name && track.name.trim()) ? track.name : ('Track ' + i);
        label.appendChild(cb);
        label.appendChild(document.createTextNode(' ' + name));
        trackList.appendChild(label);
      });
    }
    updateInfo();
    playBtn.disabled = !parsedMidi || !parsedMidi.tracks.length;
    playbackStartOffset = 0;
    rebuildWaveFromSelection();
    showProgressBar(!!parsedMidi);
  });

  playBtn.addEventListener('click', () => {
    if (!parsedMidi) return;
    const indices = getSelectedTrackIndices();
    if (indices.length === 0) return;
    const notes = mergeNotesFromTracks(parsedMidi, indices);
    if (notes.length === 0) return;
    currentNotes = notes;
    currentTranspose = parseInt(transposeSelect.value, 10) || 0;
    buildComplexity(notes);
    drawWave();
    showProgressBar(true);
    startPlayback(playbackStartOffset >= totalDuration ? 0 : playbackStartOffset);
  });

  stopBtn.addEventListener('click', () => {
    clearPlayback();
    if (updateKeyDisplayFromMidi) updateKeyDisplayFromMidi([]);
    stopBtn.disabled = true;
    playBtn.disabled = parsedMidi && parsedMidi.tracks.length ? false : true;
    updateProgressDisplay();
  });
}
