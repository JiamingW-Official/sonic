/**
 * Sonic Mobile — FX Controller (Slot 3)
 * Track selection, 6 effect types with params, presets.
 */
(function () {
  'use strict';

  var socket = null;
  var bodyEl = null;
  var fxNames = ['eq', 'phaser', 'reverb', 'delay', 'chorus', 'distortion'];
  var fxLabels = {
    eq: 'Parametric EQ',
    phaser: 'Phaser',
    reverb: 'Reverb',
    delay: 'Stereo Delay',
    chorus: 'Chorus',
    distortion: 'Blood Overdrive'
  };
  var fxPresets = {};
  var tracks = [];
  var selectedTrack = null; // { trackIdx, isDrum, name, isMain }

  function sendControl(action, params) {
    if (socket) socket.emit('client:control', { action: action, params: params });
  }

  // ── Knob (shared with instrument, but simplified here) ──
  function createKnob(label, min, max, initVal, onChange) {
    var wrap = document.createElement('div');
    wrap.className = 'mobile-knob-wrap';
    var lblEl = document.createElement('div');
    lblEl.className = 'mobile-knob-label';
    lblEl.textContent = label;
    wrap.appendChild(lblEl);

    var sz = 48, cx = 24, cy = 24, r = 18;
    var value = initVal;

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + sz + ' ' + sz);
    svg.className.baseVal = 'mobile-knob-svg';

    // Track arc (background)
    var trackPath = describeArc(cx, cy, r, -135, 135);
    var trackEl = createSvgPath(trackPath, 'none', '#808080', 3);
    svg.appendChild(trackEl);

    // Value arc
    var valueArc = createSvgPath(trackPath, 'none', '#d04040', 3);
    svg.appendChild(valueArc);

    // Center
    var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', cx); circle.setAttribute('cy', cy);
    circle.setAttribute('r', r - 4);
    circle.setAttribute('fill', '#c0c0c0');
    circle.setAttribute('stroke', '#808080');
    circle.setAttribute('stroke-width', '1');
    svg.appendChild(circle);

    // Pointer
    var pointer = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    pointer.setAttribute('x1', cx); pointer.setAttribute('y1', cy);
    pointer.setAttribute('stroke', '#d04040');
    pointer.setAttribute('stroke-width', '2');
    pointer.setAttribute('stroke-linecap', 'round');
    svg.appendChild(pointer);

    wrap.appendChild(svg);

    var valEl = document.createElement('div');
    valEl.className = 'mobile-knob-value';
    wrap.appendChild(valEl);

    function update() {
      var pct = (value - min) / (max - min);
      var angle = -135 + pct * 270;
      var rad = (angle - 90) * Math.PI / 180;
      pointer.setAttribute('x2', cx + Math.cos(rad) * (r - 5));
      pointer.setAttribute('y2', cy + Math.sin(rad) * (r - 5));
      var arcPath = describeArc(cx, cy, r, -135, angle);
      valueArc.setAttribute('d', arcPath);
      if (max >= 1000) valEl.textContent = (value / 1000).toFixed(1) + 'k';
      else if (max > 20) valEl.textContent = Math.round(value);
      else valEl.textContent = value < 1 ? value.toFixed(2) : value.toFixed(1);
    }

    var dragging = false, startY = 0, startVal = 0;
    svg.addEventListener('touchstart', function (e) {
      e.preventDefault();
      dragging = true;
      startY = e.touches[0].clientY;
      startVal = value;
    }, { passive: false });

    document.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      var dy = startY - e.touches[0].clientY;
      var delta = (dy / 150) * (max - min);
      value = Math.max(min, Math.min(max, startVal + delta));
      update();
      if (onChange) onChange(value);
    }, { passive: true });

    document.addEventListener('touchend', function () { dragging = false; });

    update();
    return wrap;
  }

  function describeArc(cx, cy, r, startDeg, endDeg) {
    var s = (startDeg - 90) * Math.PI / 180;
    var e = (endDeg - 90) * Math.PI / 180;
    var x1 = cx + r * Math.cos(s), y1 = cy + r * Math.sin(s);
    var x2 = cx + r * Math.cos(e), y2 = cy + r * Math.sin(e);
    var large = (endDeg - startDeg) > 180 ? 1 : 0;
    return 'M ' + x1 + ' ' + y1 + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x2 + ' ' + y2;
  }

  function createSvgPath(d, fill, stroke, sw) {
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', fill || 'none');
    p.setAttribute('stroke', stroke || '#000');
    p.setAttribute('stroke-width', sw || 1);
    p.setAttribute('stroke-linecap', 'round');
    return p;
  }

  // ── Build UI ──
  function buildUI(container, state) {
    container.innerHTML = '';
    if (state) {
      if (state.mixer) tracks = state.mixer.tracks || [];
      if (state.fx) {
        fxPresets = state.fx.fxPresets || {};
        if (state.fx.fxNames) fxNames = state.fx.fxNames;
      }
    }

    if (!tracks.length) {
      container.textContent = 'Waiting for MIDI file...';
      container.style.cssText = 'display:flex;align-items:center;justify-content:center;color:#808080;';
      return;
    }
    container.style.cssText = '';

    // Track select buttons
    var trackLabel = document.createElement('div');
    trackLabel.style.cssText = 'font:bold 10px Tahoma,sans-serif;color:#404040;padding:4px 0;';
    trackLabel.textContent = 'Select Track:';
    container.appendChild(trackLabel);

    var trackRow = document.createElement('div');
    trackRow.className = 'track-btn-row';
    trackRow.id = 'fx-track-row';

    tracks.forEach(function (t) {
      var btn = document.createElement('button');
      btn.className = 'track-btn';
      btn.textContent = t.name.length > 7 ? t.name.slice(0, 6) + '…' : t.name;
      btn.title = t.name;
      btn.dataset.trackIdx = t.trackIdx;
      btn.addEventListener('click', function () {
        selectedTrack = {
          trackIdx: t.trackIdx,
          isDrum: t.isDrum,
          name: t.name,
          isMain: t.trackIdx === -1
        };
        highlightTrackBtn(t.trackIdx);
        buildFxCards();
      });
      trackRow.appendChild(btn);
    });

    container.appendChild(trackRow);

    // FX cards container
    var fxContainer = document.createElement('div');
    fxContainer.id = 'fx-cards';
    fxContainer.style.marginTop = '8px';
    container.appendChild(fxContainer);

    // Auto-select Master bus by default
    if (tracks.length && !selectedTrack) {
      var mainTrack = null;
      for (var ti = 0; ti < tracks.length; ti++) {
        if (tracks[ti].trackIdx === -1) { mainTrack = tracks[ti]; break; }
      }
      if (!mainTrack) mainTrack = tracks[0];
      selectedTrack = {
        trackIdx: mainTrack.trackIdx,
        isDrum: mainTrack.isDrum,
        name: mainTrack.name,
        isMain: mainTrack.trackIdx === -1
      };
      highlightTrackBtn(mainTrack.trackIdx);
      buildFxCards();
    }
  }

  function highlightTrackBtn(trackIdx) {
    var btns = document.querySelectorAll('#fx-track-row .track-btn');
    btns.forEach(function (b) {
      b.classList.toggle('active', parseInt(b.dataset.trackIdx) === trackIdx);
    });
  }

  function buildFxCards() {
    var container = document.getElementById('fx-cards');
    if (!container || !selectedTrack) return;
    container.innerHTML = '';

    fxNames.forEach(function (fxName) {
      var card = document.createElement('div');
      card.className = 'fx-card';

      // Header
      var header = document.createElement('div');
      header.className = 'fx-card-header';
      var headerLabel = document.createElement('span');
      headerLabel.textContent = fxLabels[fxName] || fxName;
      header.appendChild(headerLabel);

      // Toggle button
      var toggleBtn = document.createElement('button');
      toggleBtn.className = 'fx-card-toggle';
      toggleBtn.textContent = 'OFF';
      toggleBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var isOn = toggleBtn.classList.toggle('on');
        toggleBtn.textContent = isOn ? 'ON' : 'OFF';
        if (selectedTrack.isMain) {
          sendControl('fx:main-toggle', { effectName: fxName, enabled: isOn });
        } else {
          sendControl('fx:toggle', {
            trackIndex: selectedTrack.trackIdx,
            isDrum: selectedTrack.isDrum,
            effectName: fxName,
            enabled: isOn
          });
        }
      });
      header.appendChild(toggleBtn);

      // Click header to expand/collapse
      header.addEventListener('click', function () {
        card.classList.toggle('expanded');
      });

      card.appendChild(header);

      // Body with knobs
      var body = document.createElement('div');
      body.className = 'fx-card-body';

      // Preset selector
      var presetMap = fxPresets[fxName];
      if (presetMap && Object.keys(presetMap).length > 0) {
        var presetRow = document.createElement('div');
        presetRow.style.cssText = 'margin-bottom:6px;';
        var presetLabel = document.createElement('span');
        presetLabel.style.cssText = 'font-size:10px;color:#404040;margin-right:4px;';
        presetLabel.textContent = 'Preset:';
        presetRow.appendChild(presetLabel);

        var presetSelect = document.createElement('select');
        presetSelect.style.cssText = 'font:10px Tahoma,sans-serif;background:#fff;border:2px inset #808080;padding:2px 4px;';
        Object.keys(presetMap).forEach(function (pName) {
          var opt = document.createElement('option');
          opt.value = pName;
          opt.textContent = pName;
          presetSelect.appendChild(opt);
        });
        presetSelect.addEventListener('change', function () {
          var preset = presetMap[presetSelect.value];
          if (!preset) return;
          // Send all params at once
          Object.keys(preset).forEach(function (paramName) {
            if (selectedTrack.isMain) {
              sendControl('fx:main-param', {
                effectName: fxName,
                paramName: paramName,
                value: preset[paramName]
              });
            } else {
              sendControl('fx:param', {
                trackIndex: selectedTrack.trackIdx,
                isDrum: selectedTrack.isDrum,
                effectName: fxName,
                paramName: paramName,
                value: preset[paramName]
              });
            }
          });
        });
        presetRow.appendChild(presetSelect);
        body.appendChild(presetRow);
      }

      // Param knobs
      var knobRow = document.createElement('div');
      knobRow.className = 'fx-card-knobs';

      var defaultPreset = presetMap ? presetMap[Object.keys(presetMap)[0]] : {};
      if (defaultPreset) {
        Object.keys(defaultPreset).forEach(function (paramName) {
          var val = defaultPreset[paramName];
          var minV = 0, maxV = val * 4 || 1;
          // Heuristic ranges based on param name
          if (paramName === 'mix') { minV = 0; maxV = 1; }
          else if (paramName === 'feedback' || paramName === 'depth') { minV = 0; maxV = 1; }
          else if (paramName === 'rate') { minV = 0.05; maxV = 10; }
          else if (paramName === 'decay') { minV = 0.1; maxV = 8; }
          else if (paramName === 'time') { minV = 0.01; maxV = 2; }
          else if (paramName === 'drive') { minV = 0.5; maxV = 30; }
          else if (paramName.indexOf('Freq') >= 0 || paramName === 'filter' || paramName === 'tone' || paramName === 'damping') { minV = 100; maxV = 12000; }
          else if (paramName.indexOf('Gain') >= 0) { minV = -12; maxV = 12; }
          else if (paramName === 'Q' || paramName === 'midQ') { minV = 0.1; maxV = 10; }
          else if (paramName === 'stages') { minV = 2; maxV = 12; }
          else if (paramName === 'preDelay') { minV = 0; maxV = 0.2; }

          var knob = createKnob(paramName, minV, maxV, val, function (v) {
            if (selectedTrack.isMain) {
              sendControl('fx:main-param', {
                effectName: fxName,
                paramName: paramName,
                value: v
              });
            } else {
              sendControl('fx:param', {
                trackIndex: selectedTrack.trackIdx,
                isDrum: selectedTrack.isDrum,
                effectName: fxName,
                paramName: paramName,
                value: v
              });
            }
          });
          knobRow.appendChild(knob);
        });
      }

      body.appendChild(knobRow);
      card.appendChild(body);
      container.appendChild(card);
    });
  }

  // ── Public API ──
  window.__mobileInitFx = function (container, sock, state) {
    socket = sock;
    bodyEl = container;
    selectedTrack = null;
    buildUI(container, state);
  };

  // Handle state sync
  var origOnStateSync = window.__mobileOnStateSync;
  window.__mobileOnStateSync = function (slot, data) {
    if (slot === 'fx' && bodyEl) {
      buildUI(bodyEl, data);
    }
    if (origOnStateSync) origOnStateSync(slot, data);
  };
})();
