/**
 * Sonic Mobile — Keyboard Controller (Slot 5)
 * 7×3 grid (drum-pad style) for triggering melodic notes.
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
  var FLAT_ROOTS = [1, 3, 5, 8, 10]; // Db, Eb, F, Ab, Bb

  // Current key state
  var currentRoot = 0;
  var currentScale = 'major';

  // Active touches for note-off tracking
  var activeNotes = {};

  // Palette: subtle colors per scale degree (1=tonic strongest)
  var DEGREE_COLORS = [
    '#1a3a7a', '#2a5090', '#306898', '#285080',
    '#2a5a90', '#2a4a78', '#304870'
  ];

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

  function buildUI(container) {
    container.innerHTML = '';
    container.style.cssText = 'padding:6px;display:flex;flex-direction:column;height:100%;';
    activeNotes = {};

    var intervals = getScaleIntervals();

    // Header with key display and cycle buttons
    var header = document.createElement('div');
    header.className = 'keys-header';

    var titleEl = document.createElement('div');
    titleEl.style.cssText = 'font:bold 11px Tahoma,sans-serif;color:#404040;';
    titleEl.textContent = 'KEYBOARD';
    header.appendChild(titleEl);

    var keyRow = document.createElement('div');
    keyRow.className = 'keys-key-selector';

    var prevBtn = document.createElement('button');
    prevBtn.className = 'w95-btn keys-nav-btn';
    prevBtn.textContent = '\u25C0';
    prevBtn.addEventListener('click', function () {
      currentRoot = (currentRoot - 1 + 12) % 12;
      sendControl('keys:setKey', { root: currentRoot, scale: currentScale });
      buildUI(container);
    });
    keyRow.appendChild(prevBtn);

    var keyLabel = document.createElement('div');
    keyLabel.className = 'keys-key-label';
    keyLabel.textContent = getKeyLabel();
    keyRow.appendChild(keyLabel);

    var nextBtn = document.createElement('button');
    nextBtn.className = 'w95-btn keys-nav-btn';
    nextBtn.textContent = '\u25B6';
    nextBtn.addEventListener('click', function () {
      currentRoot = (currentRoot + 1) % 12;
      sendControl('keys:setKey', { root: currentRoot, scale: currentScale });
      buildUI(container);
    });
    keyRow.appendChild(nextBtn);

    var scaleBtn = document.createElement('button');
    scaleBtn.className = 'w95-btn keys-scale-btn';
    scaleBtn.textContent = currentScale === 'minor' ? 'min' : 'Maj';
    scaleBtn.addEventListener('click', function () {
      currentScale = currentScale === 'minor' ? 'major' : 'minor';
      sendControl('keys:setKey', { root: currentRoot, scale: currentScale });
      buildUI(container);
    });
    keyRow.appendChild(scaleBtn);

    header.appendChild(keyRow);
    container.appendChild(header);

    // Grid: 7 columns × 3 rows, highest octave on top
    var grid = document.createElement('div');
    grid.className = 'keys-grid';

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
        pad.style.background = DEGREE_COLORS[di];

        var nameEl = document.createElement('div');
        nameEl.className = 'keys-pad-name';
        nameEl.textContent = noteName;
        pad.appendChild(nameEl);

        var octEl = document.createElement('div');
        octEl.className = 'keys-pad-oct';
        octEl.textContent = noteOct;
        pad.appendChild(octEl);

        // Touch events
        (function (m, p) {
          p.addEventListener('touchstart', function (e) {
            e.preventDefault();
            noteOn(m, p);
          }, { passive: false });
          p.addEventListener('touchend', function (e) {
            e.preventDefault();
            noteOff(m, p);
          }, { passive: false });
          p.addEventListener('touchcancel', function () {
            noteOff(m, p);
          });
          // Mouse fallback
          p.addEventListener('mousedown', function (e) {
            e.preventDefault();
            noteOn(m, p);
          });
          p.addEventListener('mouseup', function () {
            noteOff(m, p);
          });
          p.addEventListener('mouseleave', function () {
            if (activeNotes[m]) noteOff(m, p);
          });
        })(midi, pad);

        grid.appendChild(pad);
      }
    }

    container.appendChild(grid);

    // Footer
    var info = document.createElement('div');
    info.style.cssText = 'font-size:9px;color:#808080;text-align:center;margin-top:4px;flex-shrink:0;';
    info.textContent = 'Tap to play \u00B7 3 octaves \u00B7 diatonic';
    container.appendChild(info);
  }

  function noteOn(midi, padEl) {
    if (activeNotes[midi]) return;
    activeNotes[midi] = true;
    padEl.classList.add('active');
    sendControl('keys:noteOn', { midiNote: midi, velocity: 0.85 });
  }

  function noteOff(midi, padEl) {
    if (!activeNotes[midi]) return;
    delete activeNotes[midi];
    padEl.classList.remove('active');
    sendControl('keys:noteOff', { midiNote: midi });
  }

  // ── Public API ──
  window.__mobileInitKeys = function (container, sock, state) {
    socket = sock;
    bodyEl = container;
    activeNotes = {};
    // Pick up key signature from initial state
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
