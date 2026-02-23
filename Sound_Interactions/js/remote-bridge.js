/**
 * Sonic Remote Bridge — desktop-side WebSocket client.
 * Connects to Render relay server, manages admin panel, QR code, and command dispatch.
 */
(function () {
  'use strict';

  // ── Configuration ──
  var RELAY_URL = window.__SONIC_RELAY_URL || 'https://sonic-o6bm.onrender.com';

  var socket = null;
  var roomId = null;
  var connected = false;
  var adminPanel = null;
  var _topZ = 1600;
  var _meterInterval = null;

  // Slot state mirrors
  var slots = { instrument: null, mixer: null, fx: null, drums: null, keys: null };
  // Remote sustained voices (for keyboard controller)
  var _remoteVoices = {};
  var queue = [];

  // ── Helpers ──
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  // ── Connect to Relay ──
  function connect() {
    if (typeof io === 'undefined') {
      console.warn('[Sonic Remote] socket.io client not loaded');
      updateStatus('Error: socket.io not loaded');
      return;
    }
    console.log('[Sonic Remote] Connecting to', RELAY_URL);
    updateStatus('Connecting...');

    socket = io(RELAY_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionAttempts: Infinity,
      timeout: 15000
    });

    socket.on('connect', function () {
      connected = true;
      console.log('[Sonic Remote] Connected, socket id:', socket.id);
      updateStatus('Connected');
      socket.emit('host:create-room', {}, function (res) {
        console.log('[Sonic Remote] create-room response:', res);
        if (res && res.roomId) {
          roomId = res.roomId;
          updateRoomInfo();
          sendStateSync();
        } else {
          updateStatus('Error: no room ID returned');
        }
      });
    });

    socket.on('connect_error', function (err) {
      console.warn('[Sonic Remote] Connection error:', err.message);
      updateStatus('Connection error — retrying...');
    });

    socket.on('disconnect', function (reason) {
      connected = false;
      console.log('[Sonic Remote] Disconnected:', reason);
      updateStatus('Disconnected — reconnecting...');
    });

    socket.on('reconnect', function () {
      connected = true;
      console.log('[Sonic Remote] Reconnected');
      updateStatus('Reconnected');
      socket.emit('host:create-room', {}, function (res) {
        if (res && res.roomId) {
          roomId = res.roomId;
          updateRoomInfo();
          sendStateSync();
        }
      });
    });

    // ── Incoming events ──
    socket.on('room:client-joined', function (data) {
      console.log('[Sonic Remote] Client joined:', data.username);
      showToast(data.username + ' joined');
    });

    socket.on('room:client-left', function (data) {
      console.log('[Sonic Remote] Client left:', data.username);
      showToast(data.username + ' left');
    });

    socket.on('room:slot-changed', function (data) {
      slots = data.slots || slots;
      queue = data.queue || queue;
      renderSlots();
      if (data.requestSync) sendStateSync();
    });

    socket.on('room:control', function (data) {
      handleControl(data.slot, data.action, data.params);
    });

    socket.on('room:danmaku', function (data) {
      spawnDanmaku(data.username, data.text);
    });

    socket.on('room:emoji', function (data) {
      showEmojiFullscreen(data.username, data.id);
    });

    startMeterBroadcast();
  }

  // ── Send state sync ──
  function sendStateSync() {
    if (!socket || !connected) return;
    var api = window.__sonicRemoteAPI;
    var mixer = window.__sonicMixerAPI;
    if (!api) return;

    var state = {
      synth: {
        currentIndex: api.getCurrentSynthIndex(),
        presets: api.getSynthPresets(),
        variations: api.getSynthVariations(),
        currentVariation: api.getCurrentVariation()
      }
    };
    if (mixer) {
      state.mixer = { tracks: mixer.getMixerTrackData() };
      state.fx = { fxNames: mixer.getFxNames(), fxPresets: mixer.getFxPresets() };
    }
    if (api.getKeySignature) {
      state.keySignature = api.getKeySignature();
    }
    socket.emit('host:state-sync', state);
  }

  // ── VU Meter broadcast (~15fps) ──
  function startMeterBroadcast() {
    if (_meterInterval) clearInterval(_meterInterval);
    _meterInterval = setInterval(function () {
      if (!socket || !connected || !slots.mixer) return;
      var mixer = window.__sonicMixerAPI;
      if (!mixer) return;
      socket.emit('host:meter-update', mixer.getMeterLevels());
    }, 66);
  }

  // ── Handle remote control commands ──
  function handleControl(slot, action, params) {
    var api = window.__sonicRemoteAPI;
    var mixer = window.__sonicMixerAPI;
    if (!api) return;

    switch (action) {
      case 'synth:select':
        api.selectSynth(params.presetIndex); api.refreshSynthRack(); break;
      case 'synth:param':
        api.setSynthParam(params.presetIndex, params.path, params.value); api.refreshSynthEditor(); break;
      case 'synth:variation':
        api.applySynthVariation(params.presetIndex, params.varIndex); api.refreshSynthEditor(); break;
      case 'mixer:volume':
        if (params.isDrum) api.setDrumTrackVolume(params.trackIndex, params.value / 100);
        else if (params.trackIndex !== -1) api.setTrackVolume(params.trackIndex, params.value / 100);
        if (mixer) mixer.updateFaderUI(params.trackIndex, params.value); break;
      case 'mixer:pan':
        if (params.isDrum) api.setDrumTrackPan(params.trackIndex, params.value);
        else api.setTrackPan(params.trackIndex, params.value);
        if (mixer) mixer.updatePanUI(params.trackIndex, params.value); break;
      case 'mixer:master-volume':
        if (mixer) mixer.updateFaderUI(-1, params.value); break;
      case 'fx:toggle':
        api.setTrackEffectEnabled(params.trackIndex, params.isDrum, params.effectName, params.enabled); break;
      case 'fx:param':
        api.setTrackEffectParam(params.trackIndex, params.isDrum, params.effectName, params.paramName, params.value); break;
      case 'fx:main-toggle':
        api.setMainEffectEnabled(params.effectName, params.enabled); break;
      case 'fx:main-param':
        api.setMainEffectParam(params.effectName, params.paramName, params.value); break;
      case 'drum:play':
        api.initAudio();
        if (api.playDrum) api.playDrum(params.drumType, { velocity: params.velocity || 1.0 });
        if (api.triggerVisualsForDrum) api.triggerVisualsForDrum(params.drumIndex || 0);
        break;
      case 'keys:noteOn':
        api.initAudio();
        var voice = api.playNoteOn ? api.playNoteOn(params.midiNote, params.velocity) : null;
        if (voice) _remoteVoices[params.midiNote] = voice;
        if (api.triggerVisualsForMidi) api.triggerVisualsForMidi(params.midiNote);
        break;
      case 'keys:noteOff':
        var rv = _remoteVoices[params.midiNote];
        if (rv && rv.stop) { rv.stop(); delete _remoteVoices[params.midiNote]; }
        break;
      case 'keys:setKey':
        if (api.setKeySignature) api.setKeySignature(params.root, params.scale);
        break;
    }
  }

  // ── Toast ──
  function showToast(msg) {
    var toast = document.getElementById('mode-toast');
    if (toast) {
      toast.textContent = msg;
      toast.classList.remove('visible');
      void toast.offsetWidth;
      toast.classList.add('visible');
    }
  }

  // ═══════════════════════════════════════════════
  // ═══ Danmaku (Barrage Comments) Renderer ═══
  // ═══════════════════════════════════════════════

  var _danmakuOverlay = null;
  var _danmakuStyleInjected = false;

  function ensureDanmakuOverlay() {
    if (_danmakuOverlay) return;

    if (!_danmakuStyleInjected) {
      var s = document.createElement('style');
      s.textContent = [
        '.danmaku-overlay{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:999}',
        '.danmaku-item{position:absolute;white-space:nowrap;pointer-events:none;' +
          'font:bold 24px Tahoma,"MS Sans Serif",Arial,sans-serif;' +
          'color:#fff;text-shadow:1px 1px 2px #000,-1px -1px 2px #000,1px -1px 2px #000,-1px 1px 2px #000;' +
          'will-change:transform;line-height:1.2}'
      ].join('\n');
      document.head.appendChild(s);
      _danmakuStyleInjected = true;
    }

    _danmakuOverlay = document.createElement('div');
    _danmakuOverlay.className = 'danmaku-overlay';
    document.body.appendChild(_danmakuOverlay);
  }

  function spawnDanmaku(username, text) {
    ensureDanmakuOverlay();

    var item = document.createElement('div');
    item.className = 'danmaku-item';
    item.textContent = username + ': ' + text;

    // Random vertical position (top 10% to 80%)
    var topPct = 10 + Math.random() * 70;
    item.style.top = topPct + '%';
    item.style.right = '0';
    item.style.transform = 'translateX(100%)';

    _danmakuOverlay.appendChild(item);

    // Measure width for smooth scrolling
    var w = item.offsetWidth;
    var screenW = window.innerWidth;
    var totalDist = screenW + w + 40;
    var speed = 120; // px/s
    var duration = totalDist / speed;

    item.style.transition = 'transform ' + duration + 's linear';

    // Force reflow then start animation
    void item.offsetWidth;
    item.style.transform = 'translateX(-' + (screenW + 40) + 'px)';

    // Clean up after animation
    setTimeout(function () {
      if (item.parentNode) item.parentNode.removeChild(item);
    }, duration * 1000 + 200);
  }

  // ═══════════════════════════════════════════════
  // ═══ Fullscreen Emoji Sticker Display ═══
  // ═══════════════════════════════════════════════

  var _emojiStyleInjected = false;

  // Inline SVG data for each emoji (matching mobile-emoji.js)
  var EMOJI_SVGS = {
    heart: function () {
      return '<svg viewBox="0 0 16 16" shape-rendering="crispEdges">' +
        '<rect x="2" y="3" width="2" height="2" fill="#ff0000"/>' +
        '<rect x="4" y="2" width="2" height="2" fill="#ff0000"/>' +
        '<rect x="6" y="3" width="2" height="2" fill="#ff0000"/>' +
        '<rect x="8" y="2" width="2" height="2" fill="#ff0000"/>' +
        '<rect x="10" y="3" width="2" height="2" fill="#ff0000"/>' +
        '<rect x="12" y="3" width="2" height="2" fill="#ff0000"/>' +
        '<rect x="2" y="5" width="12" height="2" fill="#ff0000"/>' +
        '<rect x="3" y="7" width="10" height="2" fill="#ff0000"/>' +
        '<rect x="4" y="9" width="8" height="2" fill="#ff0000"/>' +
        '<rect x="5" y="11" width="6" height="2" fill="#ff0000"/>' +
        '<rect x="6" y="13" width="4" height="1" fill="#ff0000"/>' +
        '<rect x="7" y="14" width="2" height="1" fill="#ff0000"/>' +
        '<rect x="4" y="3" width="1" height="2" fill="#ff8080"/>' +
        '</svg>';
    },
    happy: function () {
      return '<svg viewBox="0 0 16 16" shape-rendering="crispEdges">' +
        '<rect x="4" y="1" width="8" height="1" fill="#000"/>' +
        '<rect x="3" y="2" width="1" height="1" fill="#000"/><rect x="12" y="2" width="1" height="1" fill="#000"/>' +
        '<rect x="2" y="3" width="1" height="2" fill="#000"/><rect x="13" y="3" width="1" height="2" fill="#000"/>' +
        '<rect x="1" y="5" width="1" height="6" fill="#000"/><rect x="14" y="5" width="1" height="6" fill="#000"/>' +
        '<rect x="2" y="11" width="1" height="2" fill="#000"/><rect x="13" y="11" width="1" height="2" fill="#000"/>' +
        '<rect x="3" y="13" width="1" height="1" fill="#000"/><rect x="12" y="13" width="1" height="1" fill="#000"/>' +
        '<rect x="4" y="14" width="8" height="1" fill="#000"/>' +
        '<rect x="4" y="2" width="8" height="1" fill="#ffff00"/>' +
        '<rect x="3" y="3" width="10" height="2" fill="#ffff00"/>' +
        '<rect x="2" y="5" width="12" height="6" fill="#ffff00"/>' +
        '<rect x="3" y="11" width="10" height="2" fill="#ffff00"/>' +
        '<rect x="4" y="13" width="8" height="1" fill="#ffff00"/>' +
        '<rect x="5" y="5" width="2" height="2" fill="#000"/>' +
        '<rect x="9" y="5" width="2" height="2" fill="#000"/>' +
        '<rect x="4" y="9" width="1" height="1" fill="#000"/>' +
        '<rect x="5" y="10" width="6" height="1" fill="#000"/>' +
        '<rect x="11" y="9" width="1" height="1" fill="#000"/>' +
        '</svg>';
    },
    cry: function () {
      return '<svg viewBox="0 0 16 16" shape-rendering="crispEdges">' +
        '<rect x="4" y="1" width="8" height="1" fill="#000"/>' +
        '<rect x="3" y="2" width="1" height="1" fill="#000"/><rect x="12" y="2" width="1" height="1" fill="#000"/>' +
        '<rect x="2" y="3" width="1" height="2" fill="#000"/><rect x="13" y="3" width="1" height="2" fill="#000"/>' +
        '<rect x="1" y="5" width="1" height="6" fill="#000"/><rect x="14" y="5" width="1" height="6" fill="#000"/>' +
        '<rect x="2" y="11" width="1" height="2" fill="#000"/><rect x="13" y="11" width="1" height="2" fill="#000"/>' +
        '<rect x="3" y="13" width="1" height="1" fill="#000"/><rect x="12" y="13" width="1" height="1" fill="#000"/>' +
        '<rect x="4" y="14" width="8" height="1" fill="#000"/>' +
        '<rect x="4" y="2" width="8" height="1" fill="#ffff00"/>' +
        '<rect x="3" y="3" width="10" height="2" fill="#ffff00"/>' +
        '<rect x="2" y="5" width="12" height="6" fill="#ffff00"/>' +
        '<rect x="3" y="11" width="10" height="2" fill="#ffff00"/>' +
        '<rect x="4" y="13" width="8" height="1" fill="#ffff00"/>' +
        '<rect x="4" y="5" width="3" height="1" fill="#000"/><rect x="9" y="5" width="3" height="1" fill="#000"/>' +
        '<rect x="4" y="7" width="1" height="3" fill="#4040ff"/><rect x="11" y="7" width="1" height="3" fill="#4040ff"/>' +
        '<rect x="4" y="10" width="1" height="2" fill="#6060ff"/><rect x="11" y="10" width="1" height="2" fill="#6060ff"/>' +
        '<rect x="5" y="11" width="1" height="1" fill="#000"/><rect x="6" y="10" width="4" height="1" fill="#000"/><rect x="10" y="11" width="1" height="1" fill="#000"/>' +
        '</svg>';
    },
    skull: function () {
      return '<svg viewBox="0 0 16 16" shape-rendering="crispEdges">' +
        '<rect x="4" y="1" width="8" height="1" fill="#000"/>' +
        '<rect x="3" y="2" width="1" height="1" fill="#000"/><rect x="12" y="2" width="1" height="1" fill="#000"/>' +
        '<rect x="2" y="3" width="1" height="8" fill="#000"/><rect x="13" y="3" width="1" height="8" fill="#000"/>' +
        '<rect x="3" y="11" width="1" height="1" fill="#000"/><rect x="12" y="11" width="1" height="1" fill="#000"/>' +
        '<rect x="4" y="12" width="8" height="1" fill="#000"/>' +
        '<rect x="4" y="2" width="8" height="1" fill="#fff"/><rect x="3" y="3" width="10" height="8" fill="#fff"/><rect x="4" y="11" width="8" height="1" fill="#fff"/>' +
        '<rect x="4" y="4" width="1" height="1" fill="#000"/><rect x="6" y="4" width="1" height="1" fill="#000"/><rect x="5" y="5" width="1" height="1" fill="#000"/><rect x="4" y="6" width="1" height="1" fill="#000"/><rect x="6" y="6" width="1" height="1" fill="#000"/>' +
        '<rect x="9" y="4" width="1" height="1" fill="#000"/><rect x="11" y="4" width="1" height="1" fill="#000"/><rect x="10" y="5" width="1" height="1" fill="#000"/><rect x="9" y="6" width="1" height="1" fill="#000"/><rect x="11" y="6" width="1" height="1" fill="#000"/>' +
        '<rect x="5" y="9" width="6" height="1" fill="#000"/><rect x="5" y="10" width="1" height="1" fill="#000"/><rect x="7" y="10" width="1" height="1" fill="#000"/><rect x="9" y="10" width="1" height="1" fill="#000"/>' +
        '</svg>';
    },
    fire: function () {
      return '<svg viewBox="0 0 16 16" shape-rendering="crispEdges">' +
        '<rect x="7" y="1" width="2" height="1" fill="#ff6000"/><rect x="6" y="2" width="3" height="1" fill="#ff6000"/>' +
        '<rect x="6" y="3" width="4" height="1" fill="#ff8000"/><rect x="5" y="4" width="5" height="1" fill="#ff8000"/>' +
        '<rect x="4" y="5" width="7" height="1" fill="#ff6000"/><rect x="4" y="6" width="8" height="1" fill="#ff8000"/>' +
        '<rect x="3" y="7" width="9" height="1" fill="#ff6000"/><rect x="3" y="8" width="10" height="1" fill="#ff8000"/>' +
        '<rect x="3" y="9" width="10" height="1" fill="#ff6000"/><rect x="3" y="10" width="10" height="1" fill="#ff4000"/>' +
        '<rect x="4" y="11" width="9" height="1" fill="#ff4000"/><rect x="4" y="12" width="8" height="1" fill="#ff2000"/>' +
        '<rect x="5" y="13" width="6" height="1" fill="#ff2000"/><rect x="6" y="14" width="4" height="1" fill="#c00000"/>' +
        '<rect x="7" y="5" width="2" height="1" fill="#ffff00"/><rect x="6" y="6" width="3" height="1" fill="#ffff00"/>' +
        '<rect x="6" y="7" width="4" height="1" fill="#ffff00"/><rect x="6" y="8" width="4" height="1" fill="#ffff80"/>' +
        '<rect x="6" y="9" width="4" height="1" fill="#ffff00"/><rect x="7" y="10" width="3" height="1" fill="#ffff00"/>' +
        '<rect x="7" y="11" width="2" height="1" fill="#ffff00"/>' +
        '</svg>';
    },
    cool: function () {
      return '<svg viewBox="0 0 16 16" shape-rendering="crispEdges">' +
        '<rect x="4" y="1" width="8" height="1" fill="#000"/>' +
        '<rect x="3" y="2" width="1" height="1" fill="#000"/><rect x="12" y="2" width="1" height="1" fill="#000"/>' +
        '<rect x="2" y="3" width="1" height="2" fill="#000"/><rect x="13" y="3" width="1" height="2" fill="#000"/>' +
        '<rect x="1" y="5" width="1" height="6" fill="#000"/><rect x="14" y="5" width="1" height="6" fill="#000"/>' +
        '<rect x="2" y="11" width="1" height="2" fill="#000"/><rect x="13" y="11" width="1" height="2" fill="#000"/>' +
        '<rect x="3" y="13" width="1" height="1" fill="#000"/><rect x="12" y="13" width="1" height="1" fill="#000"/>' +
        '<rect x="4" y="14" width="8" height="1" fill="#000"/>' +
        '<rect x="4" y="2" width="8" height="1" fill="#ffff00"/><rect x="3" y="3" width="10" height="2" fill="#ffff00"/>' +
        '<rect x="2" y="5" width="12" height="6" fill="#ffff00"/><rect x="3" y="11" width="10" height="2" fill="#ffff00"/>' +
        '<rect x="4" y="13" width="8" height="1" fill="#ffff00"/>' +
        '<rect x="3" y="5" width="4" height="2" fill="#000"/><rect x="9" y="5" width="4" height="2" fill="#000"/>' +
        '<rect x="7" y="5" width="2" height="1" fill="#000"/><rect x="2" y="5" width="1" height="1" fill="#000"/><rect x="13" y="5" width="1" height="1" fill="#000"/>' +
        '<rect x="4" y="5" width="1" height="1" fill="#404080"/><rect x="10" y="5" width="1" height="1" fill="#404080"/>' +
        '<rect x="5" y="10" width="5" height="1" fill="#000"/><rect x="10" y="9" width="1" height="1" fill="#000"/>' +
        '</svg>';
    },
    star: function () {
      return '<svg viewBox="0 0 16 16" shape-rendering="crispEdges">' +
        '<rect x="7" y="1" width="2" height="2" fill="#ffcc00"/><rect x="6" y="3" width="4" height="1" fill="#ffcc00"/>' +
        '<rect x="5" y="4" width="6" height="1" fill="#ffcc00"/><rect x="1" y="5" width="14" height="1" fill="#ffcc00"/>' +
        '<rect x="2" y="6" width="12" height="1" fill="#ffcc00"/><rect x="3" y="7" width="10" height="2" fill="#ffcc00"/>' +
        '<rect x="2" y="9" width="5" height="1" fill="#ffcc00"/><rect x="9" y="9" width="5" height="1" fill="#ffcc00"/>' +
        '<rect x="2" y="10" width="4" height="1" fill="#ffcc00"/><rect x="10" y="10" width="4" height="1" fill="#ffcc00"/>' +
        '<rect x="1" y="11" width="4" height="1" fill="#ffcc00"/><rect x="11" y="11" width="4" height="1" fill="#ffcc00"/>' +
        '<rect x="1" y="12" width="3" height="1" fill="#ffcc00"/><rect x="12" y="12" width="3" height="1" fill="#ffcc00"/>' +
        '<rect x="7" y="2" width="1" height="1" fill="#fff8c0"/><rect x="7" y="6" width="2" height="1" fill="#fff8c0"/>' +
        '<rect x="7" y="0" width="2" height="1" fill="#cc9900"/><rect x="0" y="5" width="1" height="1" fill="#cc9900"/><rect x="15" y="5" width="1" height="1" fill="#cc9900"/>' +
        '</svg>';
    },
    angry: function () {
      return '<svg viewBox="0 0 16 16" shape-rendering="crispEdges">' +
        '<rect x="4" y="1" width="8" height="1" fill="#000"/>' +
        '<rect x="3" y="2" width="1" height="1" fill="#000"/><rect x="12" y="2" width="1" height="1" fill="#000"/>' +
        '<rect x="2" y="3" width="1" height="2" fill="#000"/><rect x="13" y="3" width="1" height="2" fill="#000"/>' +
        '<rect x="1" y="5" width="1" height="6" fill="#000"/><rect x="14" y="5" width="1" height="6" fill="#000"/>' +
        '<rect x="2" y="11" width="1" height="2" fill="#000"/><rect x="13" y="11" width="1" height="2" fill="#000"/>' +
        '<rect x="3" y="13" width="1" height="1" fill="#000"/><rect x="12" y="13" width="1" height="1" fill="#000"/>' +
        '<rect x="4" y="14" width="8" height="1" fill="#000"/>' +
        '<rect x="4" y="2" width="8" height="1" fill="#ff6040"/><rect x="3" y="3" width="10" height="2" fill="#ff6040"/>' +
        '<rect x="2" y="5" width="12" height="6" fill="#ff6040"/><rect x="3" y="11" width="10" height="2" fill="#ff6040"/>' +
        '<rect x="4" y="13" width="8" height="1" fill="#ff6040"/>' +
        '<rect x="3" y="4" width="1" height="1" fill="#000"/><rect x="4" y="5" width="2" height="1" fill="#000"/>' +
        '<rect x="12" y="4" width="1" height="1" fill="#000"/><rect x="10" y="5" width="2" height="1" fill="#000"/>' +
        '<rect x="5" y="7" width="2" height="2" fill="#000"/><rect x="9" y="7" width="2" height="2" fill="#000"/>' +
        '<rect x="6" y="11" width="4" height="1" fill="#000"/><rect x="5" y="12" width="1" height="1" fill="#000"/><rect x="10" y="12" width="1" height="1" fill="#000"/>' +
        '</svg>';
    }
  };

  function ensureEmojiStyles() {
    if (_emojiStyleInjected) return;
    var s = document.createElement('style');
    s.textContent = [
      '@keyframes emoji-pop{0%{transform:translate(-50%,-50%) scale(0);opacity:0}15%{transform:translate(-50%,-50%) scale(1.15);opacity:1}25%{transform:translate(-50%,-50%) scale(0.95)}35%{transform:translate(-50%,-50%) scale(1.05)}45%{transform:translate(-50%,-50%) scale(1)}85%{transform:translate(-50%,-50%) scale(1);opacity:1}100%{transform:translate(-50%,-50%) scale(1.3);opacity:0}}',
      '.emoji-fullscreen{position:fixed;left:50%;top:45%;transform:translate(-50%,-50%);z-index:1000;pointer-events:none;text-align:center;animation:emoji-pop 4s ease-out forwards}',
      '.emoji-fullscreen svg{width:240px;height:240px;image-rendering:pixelated;filter:drop-shadow(0 4px 20px rgba(0,0,0,0.5))}',
      '.emoji-fullscreen-user{font:bold 14px Tahoma,"MS Sans Serif",sans-serif;color:#fff;text-shadow:1px 1px 3px #000,-1px -1px 3px #000;margin-top:8px;letter-spacing:1px}'
    ].join('\n');
    document.head.appendChild(s);
    _emojiStyleInjected = true;
  }

  function showEmojiFullscreen(username, emojiId) {
    ensureEmojiStyles();
    var svgFn = EMOJI_SVGS[emojiId];
    if (!svgFn) return;

    var wrap = document.createElement('div');
    wrap.className = 'emoji-fullscreen';
    wrap.innerHTML = svgFn();

    var userLabel = document.createElement('div');
    userLabel.className = 'emoji-fullscreen-user';
    userLabel.textContent = username;
    wrap.appendChild(userLabel);

    document.body.appendChild(wrap);

    setTimeout(function () {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }, 4200);
  }

  // ═══════════════════════════════════════════════
  // ═══ Admin Panel — Premium Apple TV Style ═══
  // ═══════════════════════════════════════════════

  function createAdminPanel() {
    if (adminPanel) return;

    // Inject styles
    var style = document.createElement('style');
    style.textContent = [
      '.sonic-remote-panel{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:380px;z-index:1600;font-family:Tahoma,"MS Sans Serif",Arial,sans-serif;transition:width 0.15s}',
      '.sonic-remote-panel .w95-window-body{padding:0;overflow:hidden}',
      '.sonic-remote-panel.collapsed .w95-window-body{display:none}',
      '.sonic-remote-panel.collapsed{width:200px}',
      // Hero section — dark gradient with QR
      '.srp-hero{background:linear-gradient(135deg,#0a0a2e 0%,#1a1a4e 50%,#0a1a3e 100%);padding:20px;text-align:center;position:relative}',
      '.srp-hero::after{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(16,132,208,0.08) 0%,transparent 70%);pointer-events:none}',
      '.srp-status{font-size:10px;color:#60a0d0;margin-bottom:12px;letter-spacing:0.5px}',
      '.srp-status.ok{color:#40d080}',
      '.srp-status.err{color:#d06040}',
      // QR
      '.srp-qr{width:160px;height:160px;margin:0 auto 14px;border:3px solid rgba(255,255,255,0.15);border-radius:8px;background:#fff;display:block;image-rendering:pixelated}',
      '.srp-qr-placeholder{width:160px;height:160px;margin:0 auto 14px;border:3px solid rgba(255,255,255,0.08);border-radius:8px;background:rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.2);font-size:28px}',
      // Room code — big Apple TV style
      '.srp-room-label{font-size:9px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:2px;margin-bottom:4px}',
      '.srp-room-code{font-size:32px;font-weight:bold;letter-spacing:8px;color:#fff;text-shadow:0 0 20px rgba(16,132,208,0.5);margin-bottom:10px;font-family:"Courier New",monospace;user-select:all}',
      // URL row
      '.srp-url-row{display:flex;align-items:center;gap:4px;background:rgba(0,0,0,0.3);border-radius:4px;padding:4px 8px;margin:0 auto;max-width:340px}',
      '.srp-url{flex:1;font-size:9px;color:rgba(255,255,255,0.6);word-break:break-all;cursor:pointer;text-decoration:underline;text-decoration-color:rgba(255,255,255,0.2)}',
      '.srp-url:hover{color:#fff}',
      '.srp-copy-btn{background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;font-size:9px;padding:2px 8px;border-radius:3px;cursor:pointer;white-space:nowrap;flex-shrink:0}',
      '.srp-copy-btn:hover{background:rgba(255,255,255,0.2)}',
      '.srp-copy-btn:active{background:rgba(16,132,208,0.4)}',
      // Slots section
      '.srp-slots{padding:8px 12px;background:#c0c0c0}',
      '.srp-slot-row{display:flex;align-items:center;justify-content:space-between;padding:4px 6px;margin-bottom:2px;background:#fff;border:1px solid #808080;box-shadow:inset -1px -1px 0 #dfdfdf,inset 1px 1px 0 #404040}',
      '.srp-slot-info{display:flex;align-items:center;gap:6px}',
      '.srp-slot-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}',
      '.srp-slot-dot.open{background:#808080}',
      '.srp-slot-dot.active{box-shadow:0 0 6px currentColor}',
      '.srp-slot-name{font-size:11px;font-weight:bold}',
      '.srp-slot-user{font-size:10px;color:#404040}',
      '.srp-kick-btn{font:9px Tahoma,sans-serif;padding:1px 8px;cursor:pointer;background:#c0c0c0;border:2px outset #ddd}',
      '.srp-kick-btn:active{border-style:inset}',
      // Queue
      '.srp-queue{padding:4px 12px 6px;background:#c0c0c0;border-top:1px solid #808080}',
      '.srp-queue-label{font:bold 9px Tahoma,sans-serif;color:#606060;margin-bottom:2px}',
      '.srp-queue-item{font-size:10px;color:#404040;padding:1px 0}'
    ].join('\n');
    document.head.appendChild(style);

    adminPanel = el('div', 'w95-window sonic-remote-panel');
    adminPanel.style.display = 'none';

    // Titlebar
    var titlebar = el('div', 'w95-titlebar');
    titlebar.innerHTML = '<span style="margin-right:4px">\uD83D\uDCE1</span> <span class="w95-titlebar-text">Remote Control</span>';
    var btnGroup = el('div', 'w95-titlebar-buttons');
    var minBtn = el('button', 'w95-titlebar-btn', '_');
    minBtn.title = 'Collapse';
    minBtn.onclick = function () {
      adminPanel.classList.toggle('collapsed');
      minBtn.textContent = adminPanel.classList.contains('collapsed') ? '\u25A1' : '_';
      minBtn.title = adminPanel.classList.contains('collapsed') ? 'Expand' : 'Collapse';
    };
    btnGroup.appendChild(minBtn);
    var closeBtn = el('button', 'w95-titlebar-btn', '\u00d7');
    closeBtn.onclick = function () { adminPanel.style.display = 'none'; };
    btnGroup.appendChild(closeBtn);
    titlebar.appendChild(btnGroup);
    adminPanel.appendChild(titlebar);

    // Dragging
    var dragging = false, dx = 0, dy = 0;
    titlebar.addEventListener('mousedown', function (e) {
      if (e.target.closest('.w95-titlebar-btn')) return;
      dragging = true;
      var rect = adminPanel.getBoundingClientRect();
      dx = e.clientX - rect.left;
      dy = e.clientY - rect.top;
      adminPanel.style.zIndex = ++_topZ;
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      adminPanel.style.left = (e.clientX - dx) + 'px';
      adminPanel.style.top = (e.clientY - dy) + 'px';
      adminPanel.style.transform = 'none';
    });
    document.addEventListener('mouseup', function () { dragging = false; });

    // Body
    var body = el('div', 'w95-window-body');

    // ── Hero section (dark, QR + code) ──
    var hero = el('div', 'srp-hero');

    var statusEl = el('div', 'srp-status');
    statusEl.id = 'srp-status';
    statusEl.textContent = 'CONNECTING...';
    hero.appendChild(statusEl);

    // QR placeholder (replaced when room created)
    var qrPlaceholder = el('div', 'srp-qr-placeholder');
    qrPlaceholder.id = 'srp-qr-wrap';
    qrPlaceholder.textContent = '?';
    hero.appendChild(qrPlaceholder);

    // Room code label
    var roomLabel = el('div', 'srp-room-label', 'ROOM CODE');
    hero.appendChild(roomLabel);

    // Room code (big)
    var roomCode = el('div', 'srp-room-code');
    roomCode.id = 'srp-room-code';
    roomCode.textContent = '- - - - - -';
    hero.appendChild(roomCode);

    // URL row
    var urlRow = el('div', 'srp-url-row');
    urlRow.id = 'srp-url-row';
    urlRow.style.display = 'none';
    var urlText = el('span', 'srp-url');
    urlText.id = 'srp-url-text';
    urlText.title = 'Click to open';
    urlText.addEventListener('click', function () {
      var url = urlText.dataset.url;
      if (url) window.open(url, '_blank');
    });
    var copyBtn = el('button', 'srp-copy-btn', 'Copy');
    copyBtn.addEventListener('click', function () {
      var url = urlText.dataset.url;
      if (url && navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () {
          copyBtn.textContent = 'Copied!';
          setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
        });
      }
    });
    urlRow.appendChild(urlText);
    urlRow.appendChild(copyBtn);
    hero.appendChild(urlRow);

    body.appendChild(hero);

    // ── Slots section ──
    var slotsSection = el('div', 'srp-slots');
    var slotsDiv = el('div');
    slotsDiv.id = 'srp-slots';
    slotsSection.appendChild(slotsDiv);
    body.appendChild(slotsSection);

    // ── Queue section ──
    var queueSection = el('div', 'srp-queue');
    var queueLabel = el('div', 'srp-queue-label', 'QUEUE');
    queueSection.appendChild(queueLabel);
    var queueDiv = el('div');
    queueDiv.id = 'srp-queue';
    queueDiv.textContent = '(empty)';
    queueDiv.style.cssText = 'color:#808080;font-size:10px;';
    queueSection.appendChild(queueDiv);
    body.appendChild(queueSection);

    adminPanel.appendChild(body);
    document.body.appendChild(adminPanel);
    renderSlots();
  }

  function updateStatus(msg) {
    var s = document.getElementById('srp-status');
    if (!s) return;
    s.textContent = msg.toUpperCase();
    s.className = 'srp-status' + (connected ? ' ok' : ' err');
  }

  function updateRoomInfo() {
    if (!roomId) return;
    var joinUrl = RELAY_URL + '/?room=' + roomId;

    // Room code
    var codeEl = document.getElementById('srp-room-code');
    if (codeEl) {
      // Display with spaces between chars for Apple TV look
      codeEl.textContent = roomId.toUpperCase().split('').join(' ');
    }

    // QR via API (100% reliable, no library needed)
    var qrWrap = document.getElementById('srp-qr-wrap');
    if (qrWrap) {
      var img = document.createElement('img');
      img.className = 'srp-qr';
      img.alt = 'Scan to connect';
      img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' +
        encodeURIComponent(joinUrl) + '&color=000080&bgcolor=ffffff&margin=8';
      img.onerror = function () {
        // Fallback: try Google Charts
        img.src = 'https://chart.googleapis.com/chart?cht=qr&chs=300x300&chl=' +
          encodeURIComponent(joinUrl) + '&chco=000080';
      };
      qrWrap.replaceWith(img);
      img.id = 'srp-qr-wrap';
    }

    // URL
    var urlRow = document.getElementById('srp-url-row');
    var urlText = document.getElementById('srp-url-text');
    if (urlRow && urlText) {
      urlRow.style.display = '';
      urlText.textContent = joinUrl;
      urlText.dataset.url = joinUrl;
    }
  }

  function renderSlots() {
    var slotsDiv = document.getElementById('srp-slots');
    if (!slotsDiv) return;
    slotsDiv.innerHTML = '';

    var slotDefs = [
      { key: 'instrument', label: 'Instrument', icon: '\uD83C\uDFB9', color: '#1084d0' },
      { key: 'mixer', label: 'Mixer', icon: '\uD83C\uDF9A\uFE0F', color: '#40a040' },
      { key: 'fx', label: 'FX', icon: '\uD83C\uDF9B\uFE0F', color: '#d04040' },
      { key: 'drums', label: 'Drums', icon: '\uD83E\uDD41', color: '#d0a040' },
      { key: 'keys', label: 'Keyboard', icon: '\uD83C\uDFB5', color: '#a040d0' }
    ];

    slotDefs.forEach(function (def) {
      var row = el('div', 'srp-slot-row');
      var info = el('div', 'srp-slot-info');

      var dot = el('div', 'srp-slot-dot');
      var occ = slots[def.key];
      if (occ) {
        dot.classList.add('active');
        dot.style.background = def.color;
        dot.style.color = def.color;
      } else {
        dot.classList.add('open');
      }
      info.appendChild(dot);

      var nameSpan = el('span', 'srp-slot-name');
      nameSpan.innerHTML = def.icon + ' ' + def.label;
      info.appendChild(nameSpan);

      if (occ) {
        var userSpan = el('span', 'srp-slot-user', occ.username);
        info.appendChild(userSpan);
      } else {
        var openSpan = el('span', 'srp-slot-user', '(open)');
        openSpan.style.color = '#aaa';
        info.appendChild(openSpan);
      }

      row.appendChild(info);

      if (occ) {
        var kickBtn = el('button', 'srp-kick-btn', 'Kick');
        kickBtn.onclick = (function (sid) {
          return function () {
            if (socket && connected) socket.emit('host:kick', { socketId: sid });
          };
        })(occ.socketId);
        row.appendChild(kickBtn);
      }

      slotsDiv.appendChild(row);
    });

    // Queue
    var queueDiv = document.getElementById('srp-queue');
    if (queueDiv) {
      if (queue.length === 0) {
        queueDiv.textContent = '(empty)';
        queueDiv.style.color = '#808080';
      } else {
        queueDiv.innerHTML = '';
        var slotNames = { instrument: 'Instrument', mixer: 'Mixer', fx: 'FX', drums: 'Drums', keys: 'Keyboard' };
        queue.forEach(function (q) {
          var qRow = el('div', 'srp-queue-item');
          qRow.textContent = q.username + ' \u2192 ' + (slotNames[q.requestedSlot] || q.requestedSlot);
          queueDiv.appendChild(qRow);
        });
        queueDiv.style.color = '#000';
      }
    }
  }

  // ═══ Public API ═══
  window.__sonicRemoteBridge = {
    open: function () {
      createAdminPanel();
      if (!socket) connect();
      adminPanel.style.display = '';
      adminPanel.style.zIndex = ++_topZ;
    },
    close: function () {
      if (adminPanel) adminPanel.style.display = 'none';
    },
    toggle: function () {
      createAdminPanel();
      if (!socket) connect();
      if (adminPanel.style.display === 'none') {
        adminPanel.style.display = '';
        adminPanel.style.zIndex = ++_topZ;
      } else {
        adminPanel.style.display = 'none';
      }
    },
    isConnected: function () { return connected; },
    getRoomId: function () { return roomId; },
    sendStateSync: sendStateSync,
    broadcastKeySignature: function (root, scale, name) {
      if (socket && connected) {
        socket.emit('host:state-update', { keySignature: { root: root, scale: scale, name: name } });
      }
    }
  };

})();
