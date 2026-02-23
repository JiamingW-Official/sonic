/**
 * Sonic Mobile — Keyboard Controller (Slot 5)
 * 3-octave piano grid for triggering melodic notes.
 */
(function () {
  'use strict';

  var socket = null;
  var bodyEl = null;

  // Note names for display
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  // 3 octaves: C3-B5, all 12 semitones per octave
  // Build chromatic scale: MIDI 48 (C3) to 83 (B5)
  var OCTAVES = [
    { label: 'Oct 3', start: 48 },
    { label: 'Oct 4', start: 60 },
    { label: 'Oct 5', start: 72 }
  ];

  // White keys only for the grid (natural notes)
  // C=0, D=2, E=4, F=5, G=7, A=9, B=11
  var WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];
  var WHITE_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

  // Active touches for note-off tracking
  var activeNotes = {};

  function sendControl(action, params) {
    if (socket) socket.emit('client:control', { action: action, params: params });
  }

  function midiToName(midi) {
    var oct = Math.floor(midi / 12) - 1;
    return NOTE_NAMES[midi % 12] + oct;
  }

  function isBlackKey(offset) {
    return [1, 3, 6, 8, 10].indexOf(offset) >= 0;
  }

  function buildUI(container) {
    container.innerHTML = '';
    container.style.cssText = 'padding:6px;';

    // Header
    var header = document.createElement('div');
    header.style.cssText = 'font:bold 11px Tahoma,sans-serif;color:#404040;padding:0 0 6px;text-align:center;';
    header.textContent = 'KEYBOARD';
    container.appendChild(header);

    // Build piano rows — one per octave, highest octave on top
    for (var oi = OCTAVES.length - 1; oi >= 0; oi--) {
      var oct = OCTAVES[oi];
      var rowWrap = document.createElement('div');
      rowWrap.className = 'keys-octave-row';

      // Octave label
      var label = document.createElement('div');
      label.className = 'keys-oct-label';
      label.textContent = oct.label;
      rowWrap.appendChild(label);

      // Keys container
      var keysRow = document.createElement('div');
      keysRow.className = 'keys-row';

      // White keys
      for (var wi = 0; wi < WHITE_OFFSETS.length; wi++) {
        var midi = oct.start + WHITE_OFFSETS[wi];
        var key = createKey(midi, WHITE_NAMES[wi], false);
        keysRow.appendChild(key);
      }

      rowWrap.appendChild(keysRow);

      // Black keys overlay
      var blackRow = document.createElement('div');
      blackRow.className = 'keys-black-row';
      // Black keys at positions: C#, D#, (gap), F#, G#, A#
      var blackPositions = [
        { offset: 1, name: 'C#', slot: 0 },
        { offset: 3, name: 'D#', slot: 1 },
        { offset: 6, name: 'F#', slot: 3 },
        { offset: 8, name: 'G#', slot: 4 },
        { offset: 10, name: 'A#', slot: 5 }
      ];

      for (var bi = 0; bi < blackPositions.length; bi++) {
        var bp = blackPositions[bi];
        var bmidi = oct.start + bp.offset;
        var bkey = createKey(bmidi, bp.name, true);
        // Position based on white key slot
        bkey.style.left = 'calc(' + ((bp.slot + 0.5) / 7 * 100) + '% + 2px)';
        blackRow.appendChild(bkey);
      }

      rowWrap.appendChild(blackRow);
      container.appendChild(rowWrap);
    }

    // Info footer
    var info = document.createElement('div');
    info.style.cssText = 'font-size:9px;color:#808080;text-align:center;margin-top:6px;';
    info.textContent = 'Tap keys to play notes on the host';
    container.appendChild(info);
  }

  function createKey(midi, name, isBlack) {
    var key = document.createElement('div');
    key.className = isBlack ? 'piano-key black' : 'piano-key white';
    key.dataset.midi = midi;

    var nameEl = document.createElement('div');
    nameEl.className = 'piano-key-name';
    nameEl.textContent = name;
    key.appendChild(nameEl);

    // Touch events
    key.addEventListener('touchstart', function (e) {
      e.preventDefault();
      noteOn(midi, key);
    }, { passive: false });

    key.addEventListener('touchend', function (e) {
      e.preventDefault();
      noteOff(midi, key);
    }, { passive: false });

    key.addEventListener('touchcancel', function () {
      noteOff(midi, key);
    });

    // Mouse fallback
    key.addEventListener('mousedown', function (e) {
      e.preventDefault();
      noteOn(midi, key);
    });

    key.addEventListener('mouseup', function () {
      noteOff(midi, key);
    });

    key.addEventListener('mouseleave', function () {
      if (activeNotes[midi]) noteOff(midi, key);
    });

    return key;
  }

  function noteOn(midi, keyEl) {
    if (activeNotes[midi]) return;
    activeNotes[midi] = true;
    keyEl.classList.add('active');
    sendControl('keys:noteOn', { midiNote: midi, velocity: 0.85 });
  }

  function noteOff(midi, keyEl) {
    if (!activeNotes[midi]) return;
    delete activeNotes[midi];
    keyEl.classList.remove('active');
    sendControl('keys:noteOff', { midiNote: midi });
  }

  // ── Public API ──
  window.__mobileInitKeys = function (container, sock, state) {
    socket = sock;
    bodyEl = container;
    activeNotes = {};
    buildUI(container);
  };

  var origOnStateSync = window.__mobileOnStateSync;
  window.__mobileOnStateSync = function (slot, data) {
    if (slot === 'keys' && bodyEl) {
      activeNotes = {};
      buildUI(bodyEl);
    }
    if (origOnStateSync) origOnStateSync(slot, data);
  };
})();
