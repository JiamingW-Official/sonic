/**
 * Sonic Mobile — Drum Pad Controller (Slot 4)
 * Launchpad-style 4x3 grid for triggering drum sounds.
 */
(function () {
  'use strict';

  var socket = null;
  var bodyEl = null;

  // Drum pad definitions — matches DRUM_KEYS in main.js
  var PADS = [
    { type: 'kick',      label: 'KICK',     key: 'A', color: '#d04040' },
    { type: 'snare',     label: 'SNARE',    key: 'S', color: '#d07040' },
    { type: '808',       label: '808',      key: 'D', color: '#d0a040' },
    { type: 'clap',      label: 'CLAP',     key: 'F', color: '#a0d040' },
    { type: 'hatClosed', label: 'HI-HAT',   key: 'G', color: '#40d060' },
    { type: 'hatOpen',   label: 'OPEN HH',  key: 'H', color: '#40d0a0' },
    { type: 'rim',       label: 'RIM',      key: 'J', color: '#40a0d0' },
    { type: 'snap',      label: 'SNAP',     key: 'K', color: '#4060d0' },
    { type: 'tomLow',    label: 'TOM LO',   key: 'L', color: '#8040d0' },
    { type: 'tomMid',    label: 'TOM MID',  key: ';', color: '#d040d0' },
    { type: 'ride',      label: 'RIDE',     key: "'", color: '#d04080' },
    { type: 'crash',     label: 'CRASH',    key: '\\', color: '#d06060' }
  ];

  function sendControl(action, params) {
    if (socket) socket.emit('client:control', { action: action, params: params });
  }

  function buildUI(container) {
    container.innerHTML = '';
    container.style.cssText = 'padding:8px;';

    // Header
    var header = document.createElement('div');
    header.style.cssText = 'font:bold 11px Tahoma,sans-serif;color:#404040;padding:0 0 8px;text-align:center;';
    header.textContent = 'DRUM MACHINE';
    container.appendChild(header);

    // Launchpad grid
    var grid = document.createElement('div');
    grid.className = 'drum-grid';

    PADS.forEach(function (pad, idx) {
      var cell = document.createElement('div');
      cell.className = 'drum-pad';
      cell.dataset.type = pad.type;
      cell.dataset.idx = idx;

      // Color indicator bar at top
      var bar = document.createElement('div');
      bar.className = 'drum-pad-bar';
      bar.style.background = pad.color;
      cell.appendChild(bar);

      // Pad label
      var label = document.createElement('div');
      label.className = 'drum-pad-label';
      label.textContent = pad.label;
      cell.appendChild(label);

      // Key hint
      var keyHint = document.createElement('div');
      keyHint.className = 'drum-pad-key';
      keyHint.textContent = pad.key;
      cell.appendChild(keyHint);

      // Touch events
      cell.addEventListener('touchstart', function (e) {
        e.preventDefault();
        cell.classList.add('active');
        sendControl('drum:play', { drumType: pad.type, drumIndex: idx, velocity: 1.0 });
      }, { passive: false });

      cell.addEventListener('touchend', function () {
        cell.classList.remove('active');
      });

      cell.addEventListener('touchcancel', function () {
        cell.classList.remove('active');
      });

      // Mouse events (for testing on desktop)
      cell.addEventListener('mousedown', function (e) {
        e.preventDefault();
        cell.classList.add('active');
        sendControl('drum:play', { drumType: pad.type, drumIndex: idx, velocity: 1.0 });
      });

      cell.addEventListener('mouseup', function () {
        cell.classList.remove('active');
      });

      cell.addEventListener('mouseleave', function () {
        cell.classList.remove('active');
      });

      grid.appendChild(cell);
    });

    container.appendChild(grid);

    // Info footer
    var info = document.createElement('div');
    info.style.cssText = 'font-size:9px;color:#808080;text-align:center;margin-top:8px;';
    info.textContent = 'Tap pads to trigger drums on the host';
    container.appendChild(info);
  }

  // ── Public API ──
  window.__mobileInitDrums = function (container, sock, state) {
    socket = sock;
    bodyEl = container;
    buildUI(container);
  };

  // Handle state sync (drums don't need state, but keep the pattern)
  var origOnStateSync = window.__mobileOnStateSync;
  window.__mobileOnStateSync = function (slot, data) {
    if (slot === 'drums' && bodyEl) {
      buildUI(bodyEl);
    }
    if (origOnStateSync) origOnStateSync(slot, data);
  };
})();
