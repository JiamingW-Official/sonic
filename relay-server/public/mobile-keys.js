/**
 * Sonic Mobile — Keyboard Controller (Slot 5)
 * Premium diatonic grid with touch glissando support.
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

  // Active notes tracking - maps touchId -> midi note
  var activeTouches = {};
  // Maps midi -> { count, padEl }
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
    // Walk up to find .keys-pad
    while (el && !el.classList.contains('keys-pad')) {
      el = el.parentElement;
    }
    if (el && el.dataset.midi) {
      return { el: el, midi: Number(el.dataset.midi) };
    }
    return null;
  }

  function buildUI(container) {
    container.innerHTML = '';
    container.style.cssText = 'padding:0;display:flex;flex-direction:column;height:100%;background:#1a1a2e;';
    noteOffAll();

    var intervals = getScaleIntervals();

    // ── Header ──
    var header = document.createElement('div');
    header.className = 'keys-header-v2';

    var titleBlock = document.createElement('div');
    titleBlock.className = 'keys-title-block';
    var titleEl = document.createElement('div');
    titleEl.className = 'keys-title';
    titleEl.textContent = 'KEYS';
    var subtitleEl = document.createElement('div');
    subtitleEl.className = 'keys-subtitle';
    subtitleEl.textContent = '3 OCT \u00B7 DIATONIC';
    titleBlock.appendChild(titleEl);
    titleBlock.appendChild(subtitleEl);
    header.appendChild(titleBlock);

    // Key selector
    var keyRow = document.createElement('div');
    keyRow.className = 'keys-selector-v2';

    var prevBtn = document.createElement('button');
    prevBtn.className = 'keys-arrow-btn';
    prevBtn.textContent = '\u25C0';
    prevBtn.addEventListener('click', function () {
      currentRoot = (currentRoot - 1 + 12) % 12;
      sendControl('keys:setKey', { root: currentRoot, scale: currentScale });
      buildUI(container);
    });
    keyRow.appendChild(prevBtn);

    var keyLabel = document.createElement('div');
    keyLabel.className = 'keys-current-key';
    keyLabel.textContent = getKeyLabel();
    keyRow.appendChild(keyLabel);

    var nextBtn = document.createElement('button');
    nextBtn.className = 'keys-arrow-btn';
    nextBtn.textContent = '\u25B6';
    nextBtn.addEventListener('click', function () {
      currentRoot = (currentRoot + 1) % 12;
      sendControl('keys:setKey', { root: currentRoot, scale: currentScale });
      buildUI(container);
    });
    keyRow.appendChild(nextBtn);

    var scaleBtn = document.createElement('button');
    scaleBtn.className = 'keys-scale-toggle';
    scaleBtn.textContent = currentScale === 'minor' ? 'min' : 'MAJ';
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
    grid.className = 'keys-grid-v2';

    var octaves = [
      { label: '5', base: 72 + currentRoot },
      { label: '4', base: 60 + currentRoot },
      { label: '3', base: 48 + currentRoot }
    ];

    // Degree colors — gradient from warm to cool
    var DEGREE_HUE = [220, 200, 180, 250, 210, 190, 240];
    var DEGREE_SAT = [70, 55, 45, 65, 60, 50, 58];
    var DEGREE_LIT = [38, 34, 32, 36, 35, 33, 30];

    for (var oi = 0; oi < octaves.length; oi++) {
      var oct = octaves[oi];
      for (var di = 0; di < 7; di++) {
        var midi = oct.base + intervals[di];
        var noteName = getNoteName(midi);
        var noteOct = getNoteOctave(midi);

        var pad = document.createElement('div');
        pad.className = 'keys-pad';
        pad.dataset.midi = midi;

        // Tonic pads get special highlight
        var isTonic = (di === 0);
        var h = DEGREE_HUE[di];
        var s = DEGREE_SAT[di];
        var l = DEGREE_LIT[di];
        if (isTonic) { s = 80; l = 42; }
        // Higher octaves slightly brighter
        l = l + (2 - oi) * 3;
        pad.style.background = 'hsl(' + h + ',' + s + '%,' + l + '%)';

        // Note name
        var nameEl = document.createElement('div');
        nameEl.className = 'keys-pad-note';
        nameEl.textContent = noteName + noteOct;
        pad.appendChild(nameEl);

        // Degree label
        var degEl = document.createElement('div');
        degEl.className = 'keys-pad-degree';
        degEl.textContent = DEGREE_LABELS[di];
        pad.appendChild(degEl);

        // Tonic marker
        if (isTonic) {
          pad.classList.add('tonic');
        }

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
          // Finger moved to a different pad
          if (prevMidi !== undefined) noteOff(prevMidi, tid);
          noteOn(info.midi, info.el, tid);
        } else if (!info && prevMidi !== undefined) {
          // Finger moved off all pads
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

    // Mouse fallback for desktop testing
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

    // ── Footer hint ──
    var footer = document.createElement('div');
    footer.className = 'keys-footer-v2';
    footer.textContent = 'Slide finger across pads to glissando';
    container.appendChild(footer);
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

  // Chain state sync handlers
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
