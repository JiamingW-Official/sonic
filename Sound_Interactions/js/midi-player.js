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
  const { createSynthVoice, triggerVisualsForMidi, initAudio, getAudioContext } = api;
  let parsedMidi = null;
  let activeVoices = [];
  let visualIntervalId = null;
  let endTimeoutId = null;

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
  transposeLabel.appendChild(transposeSelect);
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

  document.body.appendChild(container);

  const fileInput = document.getElementById('midi-file-input');

  function clearPlayback() {
    if (visualIntervalId != null) clearInterval(visualIntervalId);
    visualIntervalId = null;
    if (endTimeoutId != null) clearTimeout(endTimeoutId);
    endTimeoutId = null;
    activeVoices.forEach(v => { try { v.stop(); } catch (_) {} });
    activeVoices = [];
  }

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
        const name = (track.name && track.name.trim()) ? track.name : ('Track ' + i);
        label.appendChild(cb);
        label.appendChild(document.createTextNode(' ' + name));
        trackList.appendChild(label);
      });
    }
    updateInfo();
    playBtn.disabled = !parsedMidi || !parsedMidi.tracks.length;
  });

  playBtn.addEventListener('click', () => {
    if (!parsedMidi) return;
    const ctx = getAudioContext();
    clearPlayback();
    const transpose = parseInt(transposeSelect.value, 10) || 0;
    const indices = getSelectedTrackIndices();
    if (indices.length === 0) return;
    const notes = mergeNotesFromTracks(parsedMidi, indices);
    if (notes.length === 0) return;

    const startTime = ctx.currentTime;
    stopBtn.disabled = false;
    playBtn.disabled = true;

    // Schedule all notes on the audio context (sample-accurate, no setTimeout jitter)
    notes.forEach(note => {
      const durationSec = Math.min(MAX_NOTE_DURATION_SEC, Math.max(0.02, note.duration));
      const midi = Math.max(0, Math.min(127, note.midi + transpose));
      const voice = createSynthVoice(midi, {
        sustained: true,
        velocity: note.velocity,
        fromMIDI: true,
        snapPitch: false,
        startTime: startTime + note.time,
        duration: durationSec
      });
      activeVoices.push(voice);
    });

    // Visuals: tick in sync with audio time
    const triggered = new Set();
    visualIntervalId = setInterval(() => {
      const t = ctx.currentTime;
      notes.forEach((note, i) => {
        const triggerAt = startTime + note.time;
        if (!triggered.has(i) && t >= triggerAt - 0.008) {
          triggered.add(i);
          const midi = Math.max(0, Math.min(127, note.midi + transpose));
          triggerVisualsForMidi(midi);
        }
      });
    }, 12);

    const totalDur = notes.reduce((max, n) => Math.max(max, n.time + Math.min(MAX_NOTE_DURATION_SEC, n.duration)), 0);
    endTimeoutId = setTimeout(() => {
      if (visualIntervalId != null) clearInterval(visualIntervalId);
      visualIntervalId = null;
      endTimeoutId = null;
      stopBtn.disabled = true;
      playBtn.disabled = false;
    }, (totalDur + 0.5) * 1000);
  });

  stopBtn.addEventListener('click', () => {
    clearPlayback();
    stopBtn.disabled = true;
    playBtn.disabled = parsedMidi && parsedMidi.tracks.length ? false : true;
  });
}
