/**
 * Sonic Mobile — Mixer Controller (Slot 2)
 * Per-track faders, pan, and VU meters.
 */
(function () {
  'use strict';

  var socket = null;
  var tracks = [];
  var bodyEl = null;
  var channelEls = [];

  function sendControl(action, params) {
    if (socket) socket.emit('client:control', { action: action, params: params });
  }

  // ── Build mixer UI ──
  function buildUI(container, state) {
    container.innerHTML = '';
    channelEls = [];
    if (state && state.mixer) tracks = state.mixer.tracks || [];
    if (!tracks.length) {
      container.textContent = 'Waiting for MIDI file...';
      container.style.cssText = 'display:flex;align-items:center;justify-content:center;color:#808080;';
      return;
    }
    container.style.cssText = '';

    var label = document.createElement('div');
    label.style.cssText = 'font:bold 10px Tahoma,sans-serif;color:#404040;padding:4px 8px;';
    label.textContent = 'Mixer \u2014 ' + tracks.length + ' tracks';
    container.appendChild(label);

    var row = document.createElement('div');
    row.className = 'mixer-channels-row';

    tracks.forEach(function (t) {
      var ch = buildChannel(t);
      row.appendChild(ch.el);
      channelEls.push(ch);
    });

    container.appendChild(row);
  }

  function buildChannel(trackInfo) {
    var el = document.createElement('div');
    el.className = 'mobile-fader-wrap';
    el.style.cssText = 'padding:4px;background:#d4d0c8;border:1px solid #808080;';

    // Track name
    var nameEl = document.createElement('div');
    nameEl.className = 'mobile-fader-label';
    nameEl.textContent = trackInfo.name.length > 6 ? trackInfo.name.slice(0, 5) + '…' : trackInfo.name;
    nameEl.title = trackInfo.name;
    el.appendChild(nameEl);

    // Tag
    var tag = document.createElement('div');
    tag.style.cssText = 'font-size:8px;color:#808080;text-align:center;';
    tag.textContent = trackInfo.isDrum ? 'DRUM' : (trackInfo.trackIdx === -1 ? 'MST' : 'CH ' + trackInfo.trackIdx);
    el.appendChild(tag);

    // Fader + meter row
    var fRow = document.createElement('div');
    fRow.style.cssText = 'display:flex;gap:2px;margin:4px 0;';

    // Fader track
    var faderTrack = document.createElement('div');
    faderTrack.className = 'mobile-fader-track';
    var faderFill = document.createElement('div');
    faderFill.className = 'mobile-fader-fill';
    var initPct = trackInfo.volume || 80;
    faderFill.style.height = initPct + '%';
    faderTrack.appendChild(faderFill);
    var faderThumb = document.createElement('div');
    faderThumb.className = 'mobile-fader-thumb';
    faderThumb.style.bottom = 'calc(' + initPct + '% - 4px)';
    faderTrack.appendChild(faderThumb);

    var faderVal = initPct;

    function setFader(v) {
      faderVal = Math.max(0, Math.min(100, Math.round(v)));
      faderFill.style.height = faderVal + '%';
      faderThumb.style.bottom = 'calc(' + faderVal + '% - 4px)';
      valEl.textContent = faderVal + '%';
    }

    // Touch drag for fader
    var fDragging = false, fStartY = 0, fStartVal = 0;
    var _throttleTimer = null;
    faderTrack.addEventListener('touchstart', function (e) {
      e.preventDefault();
      fDragging = true;
      fStartY = e.touches[0].clientY;
      fStartVal = faderVal;
    }, { passive: false });

    document.addEventListener('touchmove', function (e) {
      if (!fDragging) return;
      var rect = faderTrack.getBoundingClientRect();
      var pct = 1 - Math.max(0, Math.min(1, (e.touches[0].clientY - rect.top) / rect.height));
      setFader(pct * 100);
      // Throttle sends
      if (!_throttleTimer) {
        _throttleTimer = setTimeout(function () {
          _throttleTimer = null;
          if (trackInfo.trackIdx === -1) {
            sendControl('mixer:master-volume', { value: faderVal });
          } else {
            sendControl('mixer:volume', {
              trackIndex: trackInfo.trackIdx,
              isDrum: trackInfo.isDrum,
              value: faderVal
            });
          }
        }, 33);
      }
    }, { passive: true });

    document.addEventListener('touchend', function () { fDragging = false; });

    fRow.appendChild(faderTrack);

    // Meter
    var meter = document.createElement('div');
    meter.className = 'mobile-meter';
    var meterFill = document.createElement('div');
    meterFill.className = 'mobile-meter-fill';
    meterFill.style.height = '0%';
    meter.appendChild(meterFill);
    fRow.appendChild(meter);

    el.appendChild(fRow);

    // Volume value
    var valEl = document.createElement('div');
    valEl.className = 'mobile-fader-val';
    valEl.textContent = Math.round(initPct) + '%';
    el.appendChild(valEl);

    // Pan slider
    var panSlider = document.createElement('input');
    panSlider.type = 'range';
    panSlider.className = 'mobile-pan';
    panSlider.min = '-100';
    panSlider.max = '100';
    panSlider.value = trackInfo.pan || 0;
    el.appendChild(panSlider);

    var panLabel = document.createElement('div');
    panLabel.style.cssText = 'font-size:8px;text-align:center;color:#404040;';
    var pv = parseInt(panSlider.value);
    panLabel.textContent = pv === 0 ? 'C' : (pv < 0 ? 'L' + Math.abs(pv) : 'R' + pv);
    el.appendChild(panLabel);

    panSlider.addEventListener('input', function () {
      var p = parseInt(panSlider.value);
      panLabel.textContent = p === 0 ? 'C' : (p < 0 ? 'L' + Math.abs(p) : 'R' + p);
      sendControl('mixer:pan', {
        trackIndex: trackInfo.trackIdx,
        isDrum: trackInfo.isDrum,
        value: p / 100
      });
    });

    return {
      el: el,
      trackIdx: trackInfo.trackIdx,
      isDrum: trackInfo.isDrum,
      meterFill: meterFill,
      faderFill: faderFill,
      setFader: setFader,
      faderVal: function () { return faderVal; }
    };
  }

  // ── Meter update from host ──
  window.__mobileOnMeterUpdate = function (levels) {
    if (!channelEls.length) return;
    for (var i = 0; i < channelEls.length; i++) {
      var ch = channelEls[i];
      var lvl = levels[ch.trackIdx] || 0;
      var cappedPct = Math.min(lvl * 100, ch.faderVal());
      ch.meterFill.style.height = cappedPct + '%';
    }
  };

  // ── Public API ──
  window.__mobileInitMixer = function (container, sock, state) {
    socket = sock;
    bodyEl = container;
    buildUI(container, state);
  };

  // Handle state sync
  var origOnStateSync = window.__mobileOnStateSync;
  window.__mobileOnStateSync = function (slot, data) {
    if (slot === 'mixer' && bodyEl) {
      buildUI(bodyEl, data);
    }
    if (origOnStateSync) origOnStateSync(slot, data);
  };
})();
