/**
 * MIDI file playback: load file, select tracks, transpose, play/stop.
 * Drives existing createSynthVoice and triggerVisualsForMidi from main.js.
 */
import { Midi } from '@tonejs/midi';

const MAX_NOTE_DURATION_SEC = 10;

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
    progressWrap.className = 'midi-progress-wrap';
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
    const controlsRow = document.createElement('div');
    controlsRow.className = 'player-controls-row';
    const midiToggle = document.createElement('button');
    midiToggle.type = 'button';
    midiToggle.className = 'player-midi-toggle';
    midiToggle.setAttribute('aria-expanded', 'false');
    midiToggle.textContent = 'MIDI';
    controlsRow.appendChild(btnWrap);
    controlsRow.appendChild(midiToggle);
    barInner.appendChild(progressWrap);
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
    const barW = w / BAR_BINS;
    const midY = h / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    for (let i = 0; i < BAR_BINS; i++) {
      const v = complexityBins[i] || 0;
      const barH = Math.max(1, (h * 0.4) * (0.2 + 0.8 * v));
      ctx.fillRect(i * barW, midY - barH / 2, Math.ceil(barW) + 0.5, barH);
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
    progressFill.style.width = (pct * 100) + '%';
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
    activeVoices.forEach(v => { try { v.stop(); } catch (_) {} });
    activeVoices = [];
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
    const notes = currentNotes.filter(n => n.time >= fromTime - 0.001);
    const scheduledIndices = new Set();
    const LOOKAHEAD = 0.4;
    const CHUNK_MS = 50;

    function scheduleChunk() {
      const t = ctx.currentTime - segmentStartTime;
      for (let i = 0; i < notes.length; i++) {
        if (scheduledIndices.has(i)) continue;
        const note = notes[i];
        const noteTime = note.time - fromTime;
        if (noteTime > t + LOOKAHEAD) break;
        if (noteTime < t - 0.02) continue;
        scheduledIndices.add(i);
        const durationSec = Math.min(MAX_NOTE_DURATION_SEC, Math.max(0.02, note.duration));
        const midi = Math.max(0, Math.min(127, note.midi + currentTranspose));
        const voice = createSynthVoice(midi, {
          sustained: true,
          velocity: note.velocity,
          fromMIDI: true,
          snapPitch: false,
          startTime: segmentStartTime + noteTime,
          duration: durationSec
        });
        activeVoices.push(voice);
      }
    }
    const triggered = new Set();
    const sounding = [];
    function tick() {
      scheduleChunk();
      const t = ctx.currentTime;
      sounding.length = 0;
      for (let i = 0; i < notes.length; i++) {
        const note = notes[i];
        const triggerAt = segmentStartTime + (note.time - fromTime);
        const dur = Math.min(MAX_NOTE_DURATION_SEC, Math.max(0.02, note.duration));
        if (t >= triggerAt - 0.01 && t < triggerAt + dur)
          sounding.push(Math.max(0, Math.min(127, note.midi + currentTranspose)));
        if (!triggered.has(i) && t >= triggerAt - 0.01) {
          triggered.add(i);
          triggerVisualsForMidi(Math.max(0, Math.min(127, note.midi + currentTranspose)));
        }
      }
      if (updateKeyDisplayFromMidi) updateKeyDisplayFromMidi(sounding.slice());
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
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
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
