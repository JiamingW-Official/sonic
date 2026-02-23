/**
 * Sonic Mobile — Keyboard Controller (Slot 5)
 * Win95-styled diatonic grid with touch glissando support.
 * Respects current key signature; no sharps/flats — diatonic only.
 */
(function () {
  'use strict';

  var socket = null;
  var bodyEl = null;

  // Scale patterns
  var MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
  var MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];
  var NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var NOTE_NAMES_FLAT  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  var KEY_ROOT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  var FLAT_ROOTS = [1, 3, 5, 8, 10];
  var DEGREE_LABELS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

  // Current key state
  var currentRoot = 0;
  var currentScale = 'major';

  // Active notes tracking
  var activeTouches = {};
  var activeNotes = {};

  function sendControl(action, params) {
    if (socket) socket.emit('client:control', { action: action, params: params });
  }

  function getScaleIntervals() {
    return currentScale === 'minor' ? MINOR_SCALE : MAJOR_SCALE;
  }

  function getNoteName(midi) {
    var names = FLAT_ROOTS.indexOf(currentRoot) >= 0 ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
    return names[midi % 12];
  }

  function getNoteOctave(midi) {
    return Math.floor(midi / 12) - 1;
  }

  function getKeyLabel() {
    return KEY_ROOT_NAMES[currentRoot] + ' ' + (currentScale === 'minor' ? 'min' : 'Maj');
  }

  // ── Note On/Off with reference counting for multi-touch ──
  function noteOn(midi, padEl, touchId) {
    activeTouches[touchId] = midi;
    if (!activeNotes[midi]) {
      activeNotes[midi] = { count: 0, padEl: padEl };
      sendControl('keys:noteOn', { midiNote: midi, velocity: 0.85 });
    }
    activeNotes[midi].count++;
    padEl.classList.add('active');
  }

  function noteOff(midi, touchId) {
    delete activeTouches[touchId];
    if (!activeNotes[midi]) return;
    activeNotes[midi].count--;
    if (activeNotes[midi].count <= 0) {
      var padEl = activeNotes[midi].padEl;
      delete activeNotes[midi];
      if (padEl) padEl.classList.remove('active');
      sendControl('keys:noteOff', { midiNote: midi });
    }
  }

  function noteOffAll() {
    var keys = Object.keys(activeNotes);
    for (var i = 0; i < keys.length; i++) {
      var midi = Number(keys[i]);
      var info = activeNotes[midi];
      if (info && info.padEl) info.padEl.classList.remove('active');
      sendControl('keys:noteOff', { midiNote: midi });
    }
    activeNotes = {};
    activeTouches = {};
  }

  // ── Find which pad a touch point is over ──
  function getPadAtPoint(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el) return null;
    while (el && !el.classList.contains('keys-pad')) {
      el = el.parentElement;
    }
    if (el && el.dataset.midi) {
      return { el: el, midi: Number(el.dataset.midi) };
    }
    return null;
  }

  // Win95 degree colors (subtle tinted grays)
  var DEGREE_BG = [
    '#000080', '#6868a0', '#7878a8', '#6060a0',
    '#7070a8', '#6868a0', '#5858a0'
  ];
  var DEGREE_BG_ACTIVE = [
    '#0000c0', '#8080c0', '#9090c8', '#7878c0',
    '#8888c8', '#8080c0', '#7070c0'
  ];

  function buildUI(container) {
    container.innerHTML = '';
    container.style.cssText = 'padding:0;display:flex;flex-direction:column;height:100%;';
    noteOffAll();

    var intervals = getScaleIntervals();

    // ── Header (Win95 groupbox style) ──
    var header = document.createElement('div');
    header.className = 'keys-header-w95';

    var titleEl = document.createElement('div');
    titleEl.className = 'keys-title-w95';
    titleEl.textContent = 'KEYBOARD';
    header.appendChild(titleEl);

    // Key selector row
    var keyRow = document.createElement('div');
    keyRow.className = 'keys-selector-w95';

    var prevBtn = document.createElement('button');
    prevBtn.className = 'w95-btn keys-nav-btn-w95';
    prevBtn.textContent = '\u25C0';
    prevBtn.addEventListener('click', function () {
      currentRoot = (currentRoot - 1 + 12) % 12;
      sendControl('keys:setKey', { root: currentRoot, scale: currentScale });
      buildUI(container);
    });
    keyRow.appendChild(prevBtn);

    var keyLabel = document.createElement('div');
    keyLabel.className = 'keys-key-display';
    keyLabel.textContent = getKeyLabel();
    keyRow.appendChild(keyLabel);

    var nextBtn = document.createElement('button');
    nextBtn.className = 'w95-btn keys-nav-btn-w95';
    nextBtn.textContent = '\u25B6';
    nextBtn.addEventListener('click', function () {
      currentRoot = (currentRoot + 1) % 12;
      sendControl('keys:setKey', { root: currentRoot, scale: currentScale });
      buildUI(container);
    });
    keyRow.appendChild(nextBtn);

    var scaleBtn = document.createElement('button');
    scaleBtn.className = 'w95-btn keys-scale-btn-w95';
    scaleBtn.textContent = currentScale === 'minor' ? 'min' : 'Maj';
    scaleBtn.addEventListener('click', function () {
      currentScale = currentScale === 'minor' ? 'major' : 'minor';
      sendControl('keys:setKey', { root: currentRoot, scale: currentScale });
      buildUI(container);
    });
    keyRow.appendChild(scaleBtn);

    header.appendChild(keyRow);
    container.appendChild(header);

    // ── Grid: 7 columns × 3 rows ──
    var grid = document.createElement('div');
    grid.className = 'keys-grid-w95';

    var octaves = [
      { label: '5', base: 72 + currentRoot },
      { label: '4', base: 60 + currentRoot },
      { label: '3', base: 48 + currentRoot }
    ];

    for (var oi = 0; oi < octaves.length; oi++) {
      var oct = octaves[oi];
      for (var di = 0; di < 7; di++) {
        var midi = oct.base + intervals[di];
        var noteName = getNoteName(midi);
        var noteOct = getNoteOctave(midi);

        var pad = document.createElement('div');
        pad.className = 'keys-pad';
        pad.dataset.midi = midi;

        var isTonic = (di === 0);
        if (isTonic) pad.classList.add('tonic');

        // Note name
        var nameEl = document.createElement('div');
        nameEl.className = 'keys-pad-name-w95';
        nameEl.textContent = noteName + noteOct;
        pad.appendChild(nameEl);

        // Degree label
        var degEl = document.createElement('div');
        degEl.className = 'keys-pad-deg-w95';
        degEl.textContent = DEGREE_LABELS[di];
        pad.appendChild(degEl);

        grid.appendChild(pad);
      }
    }

    // ── Touch glissando system ──
    grid.addEventListener('touchstart', function (e) {
      e.preventDefault();
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        var info = getPadAtPoint(t.clientX, t.clientY);
        if (info) noteOn(info.midi, info.el, t.identifier);
      }
    }, { passive: false });

    grid.addEventListener('touchmove', function (e) {
      e.preventDefault();
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        var tid = t.identifier;
        var info = getPadAtPoint(t.clientX, t.clientY);
        var prevMidi = activeTouches[tid];
        if (info && info.midi !== prevMidi) {
          if (prevMidi !== undefined) noteOff(prevMidi, tid);
          noteOn(info.midi, info.el, tid);
        } else if (!info && prevMidi !== undefined) {
          noteOff(prevMidi, tid);
        }
      }
    }, { passive: false });

    grid.addEventListener('touchend', function (e) {
      e.preventDefault();
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        var tid = t.identifier;
        var prevMidi = activeTouches[tid];
        if (prevMidi !== undefined) noteOff(prevMidi, tid);
      }
    }, { passive: false });

    grid.addEventListener('touchcancel', function (e) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        var tid = t.identifier;
        var prevMidi = activeTouches[tid];
        if (prevMidi !== undefined) noteOff(prevMidi, tid);
      }
    });

    // Mouse fallback
    var mouseDown = false;
    grid.addEventListener('mousedown', function (e) {
      mouseDown = true;
      var info = getPadAtPoint(e.clientX, e.clientY);
      if (info) noteOn(info.midi, info.el, 'mouse');
    });
    grid.addEventListener('mousemove', function (e) {
      if (!mouseDown) return;
      var info = getPadAtPoint(e.clientX, e.clientY);
      var prevMidi = activeTouches['mouse'];
      if (info && info.midi !== prevMidi) {
        if (prevMidi !== undefined) noteOff(prevMidi, 'mouse');
        noteOn(info.midi, info.el, 'mouse');
      } else if (!info && prevMidi !== undefined) {
        noteOff(prevMidi, 'mouse');
      }
    });
    grid.addEventListener('mouseup', function () {
      mouseDown = false;
      var prevMidi = activeTouches['mouse'];
      if (prevMidi !== undefined) noteOff(prevMidi, 'mouse');
    });
    grid.addEventListener('mouseleave', function () {
      if (mouseDown) {
        mouseDown = false;
        var prevMidi = activeTouches['mouse'];
        if (prevMidi !== undefined) noteOff(prevMidi, 'mouse');
      }
    });

    container.appendChild(grid);

    // Footer
    var info = document.createElement('div');
    info.className = 'keys-footer-w95';
    info.textContent = 'Slide to glissando \u00B7 3 octaves \u00B7 diatonic';
    container.appendChild(info);
  }

  // ── Public API ──
  window.__mobileInitKeys = function (container, sock, state) {
    socket = sock;
    bodyEl = container;
    noteOffAll();
    if (state && state.keySignature) {
      currentRoot = state.keySignature.root || 0;
      currentScale = state.keySignature.scale || 'major';
    }
    buildUI(container);
  };

  var origOnStateSync = window.__mobileOnStateSync;
  window.__mobileOnStateSync = function (slot, data) {
    if (data && data.keySignature) {
      currentRoot = data.keySignature.root || 0;
      currentScale = data.keySignature.scale || 'major';
      if (slot === 'keys' && bodyEl) buildUI(bodyEl);
    }
    if (origOnStateSync) origOnStateSync(slot, data);
  };

  var origOnStateUpdate = window.__mobileOnStateUpdate;
  window.__mobileOnStateUpdate = function (slot, data) {
    if (data && data.keySignature) {
      currentRoot = data.keySignature.root || 0;
      currentScale = data.keySignature.scale || 'major';
      if (slot === 'keys' && bodyEl) buildUI(bodyEl);
    }
    if (origOnStateUpdate) origOnStateUpdate(slot, data);
  };
})();
