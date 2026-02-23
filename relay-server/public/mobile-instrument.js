/**
 * Sonic Mobile — Instrument Controller (Slot 1)
 * Synth selection, variation buttons, and parameter knobs.
 */
(function () {
  'use strict';

  var socket = null;
  var presets = [];
  var variations = [];
  var currentIndex = 0;
  var currentVar = [];
  var bodyEl = null;

  // ── SVG Touch Knob ──
  function createMobileKnob(label, min, max, initVal, onChange, accentColor) {
    var wrap = document.createElement('div');
    wrap.className = 'mobile-knob-wrap';
    var lblEl = document.createElement('div');
    lblEl.className = 'mobile-knob-label';
    lblEl.textContent = label;
    wrap.appendChild(lblEl);

    var sz = 48, cx = 24, cy = 24, r = 18;
    var accent = accentColor || '#1084d0';
    var value = initVal;
    var startAngle = -135, endAngle = 135, range = 270;

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + sz + ' ' + sz);
    svg.className.baseVal = 'mobile-knob-svg';

    // Track arc
    var trackPath = describeArc(cx, cy, r, startAngle, endAngle);
    var track = createSvgPath(trackPath, 'none', '#808080', 3);
    svg.appendChild(track);

    // Value arc
    var valueArc = createSvgPath(trackPath, 'none', accent, 3);
    svg.appendChild(valueArc);

    // Center circle
    var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', r - 4);
    circle.setAttribute('fill', '#c0c0c0');
    circle.setAttribute('stroke', '#808080');
    circle.setAttribute('stroke-width', '1');
    svg.appendChild(circle);

    // Pointer line
    var pointer = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    pointer.setAttribute('x1', cx);
    pointer.setAttribute('y1', cy);
    pointer.setAttribute('stroke', accent);
    pointer.setAttribute('stroke-width', '2');
    pointer.setAttribute('stroke-linecap', 'round');
    svg.appendChild(pointer);

    wrap.appendChild(svg);

    var valEl = document.createElement('div');
    valEl.className = 'mobile-knob-value';
    wrap.appendChild(valEl);

    function updateVisual() {
      var pct = (value - min) / (max - min);
      var angle = startAngle + pct * range;
      var rad = angle * Math.PI / 180;
      pointer.setAttribute('x2', cx + Math.cos(rad) * (r - 5));
      pointer.setAttribute('y2', cy + Math.sin(rad) * (r - 5));
      // Update value arc
      var arcPath = describeArc(cx, cy, r, startAngle, angle);
      valueArc.setAttribute('d', arcPath);
      // Display
      if (max >= 1000) valEl.textContent = (value / 1000).toFixed(1) + 'k';
      else if (max > 20) valEl.textContent = Math.round(value);
      else if (value < 0.01 && value !== 0) valEl.textContent = value.toFixed(3);
      else if (Math.abs(value) < 1) valEl.textContent = value.toFixed(2);
      else valEl.textContent = value.toFixed(1);
    }

    // Touch drag
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
      updateVisual();
      if (onChange) onChange(value);
    }, { passive: true });

    document.addEventListener('touchend', function () {
      dragging = false;
    });

    updateVisual();

    wrap.__setValue = function (v) {
      value = Math.max(min, Math.min(max, v));
      updateVisual();
    };

    return wrap;
  }

  function describeArc(cx, cy, r, startAngleDeg, endAngleDeg) {
    var s = (startAngleDeg - 90) * Math.PI / 180;
    var e = (endAngleDeg - 90) * Math.PI / 180;
    var x1 = cx + r * Math.cos(s);
    var y1 = cy + r * Math.sin(s);
    var x2 = cx + r * Math.cos(e);
    var y2 = cy + r * Math.sin(e);
    var large = (endAngleDeg - startAngleDeg) > 180 ? 1 : 0;
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

  // ── Cycle button ──
  function createCycleButton(label, options, initIdx, onChange) {
    var idx = initIdx || 0;
    var btn = document.createElement('button');
    btn.className = 'mobile-cycle-btn';
    btn.textContent = options[idx] || options[0];
    btn.addEventListener('click', function () {
      idx = (idx + 1) % options.length;
      btn.textContent = options[idx];
      if (onChange) onChange(options[idx], idx);
    });
    btn.__setIndex = function (i) {
      idx = i % options.length;
      btn.textContent = options[idx];
    };
    return btn;
  }

  // ── Send control command ──
  function sendControl(action, params) {
    if (socket) socket.emit('client:control', { action: action, params: params });
  }

  // ── Build UI ──
  function buildUI(container, state) {
    container.innerHTML = '';
    if (state && state.synth) {
      presets = state.synth.presets || [];
      variations = state.synth.variations || [];
      currentIndex = state.synth.currentIndex || 0;
      currentVar = state.synth.currentVariation || [];
    }

    // Synth list
    var listBox = document.createElement('div');
    listBox.className = 'w95-groupbox';
    var listLabel = document.createElement('div');
    listLabel.className = 'w95-groupbox-label';
    listLabel.textContent = 'Synthesizer';
    listBox.appendChild(listLabel);

    var list = document.createElement('ul');
    list.className = 'synth-list';
    list.id = 'synth-list';
    presets.forEach(function (p, i) {
      var li = document.createElement('li');
      li.className = 'synth-list-item' + (i === currentIndex ? ' selected' : '');
      li.dataset.idx = i;
      var icon = document.createElement('span');
      icon.className = 'synth-list-icon';
      icon.textContent = p.ui ? p.ui.icon : '●';
      li.appendChild(icon);
      var name = document.createElement('span');
      name.className = 'synth-list-name';
      name.textContent = p.name;
      li.appendChild(name);
      li.addEventListener('click', function () {
        currentIndex = i;
        sendControl('synth:select', { presetIndex: i });
        highlightSynth(i);
        buildVariationButtons();
        buildParamKnobs();
      });
      list.appendChild(li);
    });
    listBox.appendChild(list);
    container.appendChild(listBox);

    // Variation buttons
    var varBox = document.createElement('div');
    varBox.className = 'w95-groupbox';
    varBox.id = 'var-box';
    var varLabel = document.createElement('div');
    varLabel.className = 'w95-groupbox-label';
    varLabel.textContent = 'Variations';
    varBox.appendChild(varLabel);
    var varRow = document.createElement('div');
    varRow.className = 'var-btn-row';
    varRow.id = 'var-btn-row';
    varBox.appendChild(varRow);
    container.appendChild(varBox);

    // Params
    var paramBox = document.createElement('div');
    paramBox.id = 'param-box';
    container.appendChild(paramBox);

    buildVariationButtons();
    buildParamKnobs();
  }

  function highlightSynth(idx) {
    var items = document.querySelectorAll('.synth-list-item');
    items.forEach(function (li) {
      li.classList.toggle('selected', parseInt(li.dataset.idx) === idx);
    });
  }

  function buildVariationButtons() {
    var row = document.getElementById('var-btn-row');
    if (!row) return;
    row.innerHTML = '';
    var vars = variations[currentIndex] || [];
    var curV = (currentVar && currentVar[currentIndex]) || 0;
    vars.forEach(function (v, vi) {
      var btn = document.createElement('button');
      btn.className = 'var-btn' + (vi === curV ? ' active' : '');
      btn.textContent = v.name;
      btn.addEventListener('click', function () {
        currentVar[currentIndex] = vi;
        sendControl('synth:variation', { presetIndex: currentIndex, varIndex: vi });
        // Highlight
        row.querySelectorAll('.var-btn').forEach(function (b, bi) {
          b.classList.toggle('active', bi === vi);
        });
        // Rebuild knobs (variation changes params)
        setTimeout(buildParamKnobs, 50);
      });
      row.appendChild(btn);
    });
  }

  function buildParamKnobs() {
    var box = document.getElementById('param-box');
    if (!box) return;
    box.innerHTML = '';
    var p = presets[currentIndex];
    if (!p) return;
    var accent = (p.ui && p.ui.accent) || '#1084d0';

    // OSC group
    var oscBox = createGroupBox('OSC');
    var oscRow = document.createElement('div');
    oscRow.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;';

    // OscA Wave
    var waveTypes = ['sine', 'sawtooth', 'square', 'triangle'];
    var waveAIdx = waveTypes.indexOf(p.oscA.type);
    var waveA = createCycleButton('A: ' + p.oscA.type, waveTypes, waveAIdx >= 0 ? waveAIdx : 0, function (val) {
      sendControl('synth:param', { presetIndex: currentIndex, path: 'oscA.type', value: val });
    });
    oscRow.appendChild(wrapWithLabel('A Wave', waveA));

    oscRow.appendChild(createMobileKnob('A Det', -24, 24, p.oscA.detuneCenter, function (v) {
      sendControl('synth:param', { presetIndex: currentIndex, path: 'oscA.detuneCenter', value: v });
    }, accent));

    oscRow.appendChild(createMobileKnob('A Gain', 0, 1, p.oscA.gain, function (v) {
      sendControl('synth:param', { presetIndex: currentIndex, path: 'oscA.gain', value: v });
    }, accent));

    if (p.oscB) {
      var waveBIdx = waveTypes.indexOf(p.oscB.type);
      var waveB = createCycleButton('B: ' + p.oscB.type, waveTypes, waveBIdx >= 0 ? waveBIdx : 0, function (val) {
        sendControl('synth:param', { presetIndex: currentIndex, path: 'oscB.type', value: val });
      });
      oscRow.appendChild(wrapWithLabel('B Wave', waveB));

      oscRow.appendChild(createMobileKnob('B Det', -24, 24, p.oscB.detuneCenter, function (v) {
        sendControl('synth:param', { presetIndex: currentIndex, path: 'oscB.detuneCenter', value: v });
      }, accent));

      oscRow.appendChild(createMobileKnob('B Gain', 0, 1, p.oscB.gain, function (v) {
        sendControl('synth:param', { presetIndex: currentIndex, path: 'oscB.gain', value: v });
      }, accent));
    }

    oscBox.appendChild(oscRow);
    box.appendChild(oscBox);

    // FILTER group
    var filterBox = createGroupBox('FILTER');
    var filterRow = document.createElement('div');
    filterRow.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;';
    filterRow.appendChild(createMobileKnob('Cutoff', 200, 8000, p.lowpass.baseFreq, function (v) {
      sendControl('synth:param', { presetIndex: currentIndex, path: 'lowpass.baseFreq', value: v });
    }, accent));
    filterRow.appendChild(createMobileKnob('Reso', 0.1, 3.0, p.lowpass.Q, function (v) {
      sendControl('synth:param', { presetIndex: currentIndex, path: 'lowpass.Q', value: v });
    }, accent));
    filterBox.appendChild(filterRow);
    box.appendChild(filterBox);

    // DRIVE group
    var driveBox = createGroupBox('DRIVE');
    var driveRow = document.createElement('div');
    driveRow.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;';
    driveRow.appendChild(createMobileKnob('Amount', 0.1, 5.0, p.drive.amount, function (v) {
      sendControl('synth:param', { presetIndex: currentIndex, path: 'drive.amount', value: v });
    }, accent));
    var driveTypes = ['tanh', 'foldback', 'softclip'];
    var dtIdx = driveTypes.indexOf(p.drive.type);
    var driveTypeBtn = createCycleButton(p.drive.type, driveTypes, dtIdx >= 0 ? dtIdx : 0, function (val) {
      sendControl('synth:param', { presetIndex: currentIndex, path: 'drive.type', value: val });
    });
    driveRow.appendChild(wrapWithLabel('Type', driveTypeBtn));
    driveBox.appendChild(driveRow);
    box.appendChild(driveBox);

    // ENVELOPE group
    var envBox = createGroupBox('ENVELOPE');
    var envRow = document.createElement('div');
    envRow.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;';
    envRow.appendChild(createMobileKnob('Attack', 0.001, 0.5, p.env.atkSust, function (v) {
      sendControl('synth:param', { presetIndex: currentIndex, path: 'env.atkSust', value: v });
    }, accent));
    envRow.appendChild(createMobileKnob('Decay', 0.01, 1.0, p.env.decSust, function (v) {
      sendControl('synth:param', { presetIndex: currentIndex, path: 'env.decSust', value: v });
    }, accent));
    envRow.appendChild(createMobileKnob('Sustain', 0.0, 1.0, p.env.susSust, function (v) {
      sendControl('synth:param', { presetIndex: currentIndex, path: 'env.susSust', value: v });
    }, accent));
    envRow.appendChild(createMobileKnob('Release', 0.01, 2.0, p.env.relSust, function (v) {
      sendControl('synth:param', { presetIndex: currentIndex, path: 'env.relSust', value: v });
    }, accent));
    envBox.appendChild(envRow);
    box.appendChild(envBox);
  }

  function createGroupBox(label) {
    var box = document.createElement('div');
    box.className = 'w95-groupbox';
    var lbl = document.createElement('div');
    lbl.className = 'w95-groupbox-label';
    lbl.textContent = label;
    box.appendChild(lbl);
    return box;
  }

  function wrapWithLabel(label, element) {
    var w = document.createElement('div');
    w.className = 'mobile-knob-wrap';
    var l = document.createElement('div');
    l.className = 'mobile-knob-label';
    l.textContent = label;
    w.appendChild(l);
    w.appendChild(element);
    return w;
  }

  // ── Public API ──
  window.__mobileInitInstrument = function (container, sock, state) {
    socket = sock;
    bodyEl = container;
    buildUI(container, state);
  };

  // Handle state sync
  var origOnStateSync = window.__mobileOnStateSync;
  window.__mobileOnStateSync = function (slot, data) {
    if (slot === 'instrument' && bodyEl) {
      buildUI(bodyEl, data);
    }
    if (origOnStateSync) origOnStateSync(slot, data);
  };
})();
