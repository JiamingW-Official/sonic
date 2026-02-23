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
  var SVG_NS = 'http://www.w3.org/2000/svg';

  // Pixel emoji data: arrays of [x, y, w, h, color]
  var EMOJI_DATA = {
    heart: [
      [2,3,2,2,'#ff0000'],[4,2,2,2,'#ff0000'],[6,3,2,2,'#ff0000'],[8,2,2,2,'#ff0000'],
      [10,3,2,2,'#ff0000'],[12,3,2,2,'#ff0000'],[2,5,12,2,'#ff0000'],[3,7,10,2,'#ff0000'],
      [4,9,8,2,'#ff0000'],[5,11,6,2,'#ff0000'],[6,13,4,1,'#ff0000'],[7,14,2,1,'#ff0000'],
      [4,3,1,2,'#ff8080']
    ],
    happy: [
      [4,1,8,1,'#000'],[3,2,1,1,'#000'],[12,2,1,1,'#000'],[2,3,1,2,'#000'],[13,3,1,2,'#000'],
      [1,5,1,6,'#000'],[14,5,1,6,'#000'],[2,11,1,2,'#000'],[13,11,1,2,'#000'],
      [3,13,1,1,'#000'],[12,13,1,1,'#000'],[4,14,8,1,'#000'],
      [4,2,8,1,'#ffff00'],[3,3,10,2,'#ffff00'],[2,5,12,6,'#ffff00'],
      [3,11,10,2,'#ffff00'],[4,13,8,1,'#ffff00'],
      [5,5,2,2,'#000'],[9,5,2,2,'#000'],
      [4,9,1,1,'#000'],[5,10,6,1,'#000'],[11,9,1,1,'#000']
    ],
    cry: [
      [4,1,8,1,'#000'],[3,2,1,1,'#000'],[12,2,1,1,'#000'],[2,3,1,2,'#000'],[13,3,1,2,'#000'],
      [1,5,1,6,'#000'],[14,5,1,6,'#000'],[2,11,1,2,'#000'],[13,11,1,2,'#000'],
      [3,13,1,1,'#000'],[12,13,1,1,'#000'],[4,14,8,1,'#000'],
      [4,2,8,1,'#ffff00'],[3,3,10,2,'#ffff00'],[2,5,12,6,'#ffff00'],
      [3,11,10,2,'#ffff00'],[4,13,8,1,'#ffff00'],
      [4,5,3,1,'#000'],[9,5,3,1,'#000'],
      [4,7,1,3,'#4040ff'],[11,7,1,3,'#4040ff'],
      [4,10,1,2,'#6060ff'],[11,10,1,2,'#6060ff'],
      [5,11,1,1,'#000'],[6,10,4,1,'#000'],[10,11,1,1,'#000']
    ],
    skull: [
      [4,1,8,1,'#000'],[3,2,1,1,'#000'],[12,2,1,1,'#000'],
      [2,3,1,8,'#000'],[13,3,1,8,'#000'],
      [3,11,1,1,'#000'],[12,11,1,1,'#000'],[4,12,8,1,'#000'],
      [4,2,8,1,'#fff'],[3,3,10,8,'#fff'],[4,11,8,1,'#fff'],
      [4,4,1,1,'#000'],[6,4,1,1,'#000'],[5,5,1,1,'#000'],[4,6,1,1,'#000'],[6,6,1,1,'#000'],
      [9,4,1,1,'#000'],[11,4,1,1,'#000'],[10,5,1,1,'#000'],[9,6,1,1,'#000'],[11,6,1,1,'#000'],
      [5,9,6,1,'#000'],[5,10,1,1,'#000'],[7,10,1,1,'#000'],[9,10,1,1,'#000']
    ],
    fire: [
      [7,1,2,1,'#ff6000'],[6,2,3,1,'#ff6000'],[6,3,4,1,'#ff8000'],[5,4,5,1,'#ff8000'],
      [4,5,7,1,'#ff6000'],[4,6,8,1,'#ff8000'],[3,7,9,1,'#ff6000'],[3,8,10,1,'#ff8000'],
      [3,9,10,1,'#ff6000'],[3,10,10,1,'#ff4000'],[4,11,9,1,'#ff4000'],[4,12,8,1,'#ff2000'],
      [5,13,6,1,'#ff2000'],[6,14,4,1,'#c00000'],
      [7,5,2,1,'#ffff00'],[6,6,3,1,'#ffff00'],[6,7,4,1,'#ffff00'],[6,8,4,1,'#ffff80'],
      [6,9,4,1,'#ffff00'],[7,10,3,1,'#ffff00'],[7,11,2,1,'#ffff00']
    ],
    cool: [
      [4,1,8,1,'#000'],[3,2,1,1,'#000'],[12,2,1,1,'#000'],[2,3,1,2,'#000'],[13,3,1,2,'#000'],
      [1,5,1,6,'#000'],[14,5,1,6,'#000'],[2,11,1,2,'#000'],[13,11,1,2,'#000'],
      [3,13,1,1,'#000'],[12,13,1,1,'#000'],[4,14,8,1,'#000'],
      [4,2,8,1,'#ffff00'],[3,3,10,2,'#ffff00'],[2,5,12,6,'#ffff00'],
      [3,11,10,2,'#ffff00'],[4,13,8,1,'#ffff00'],
      [3,5,4,2,'#000'],[9,5,4,2,'#000'],[7,5,2,1,'#000'],
      [2,5,1,1,'#000'],[13,5,1,1,'#000'],
      [4,5,1,1,'#404080'],[10,5,1,1,'#404080'],
      [5,10,5,1,'#000'],[10,9,1,1,'#000']
    ],
    star: [
      [7,1,2,2,'#ffcc00'],[6,3,4,1,'#ffcc00'],[5,4,6,1,'#ffcc00'],[1,5,14,1,'#ffcc00'],
      [2,6,12,1,'#ffcc00'],[3,7,10,2,'#ffcc00'],
      [2,9,5,1,'#ffcc00'],[9,9,5,1,'#ffcc00'],
      [2,10,4,1,'#ffcc00'],[10,10,4,1,'#ffcc00'],
      [1,11,4,1,'#ffcc00'],[11,11,4,1,'#ffcc00'],
      [1,12,3,1,'#ffcc00'],[12,12,3,1,'#ffcc00'],
      [7,2,1,1,'#fff8c0'],[7,6,2,1,'#fff8c0'],
      [7,0,2,1,'#cc9900'],[0,5,1,1,'#cc9900'],[15,5,1,1,'#cc9900']
    ],
    angry: [
      [4,1,8,1,'#000'],[3,2,1,1,'#000'],[12,2,1,1,'#000'],[2,3,1,2,'#000'],[13,3,1,2,'#000'],
      [1,5,1,6,'#000'],[14,5,1,6,'#000'],[2,11,1,2,'#000'],[13,11,1,2,'#000'],
      [3,13,1,1,'#000'],[12,13,1,1,'#000'],[4,14,8,1,'#000'],
      [4,2,8,1,'#ff6040'],[3,3,10,2,'#ff6040'],[2,5,12,6,'#ff6040'],
      [3,11,10,2,'#ff6040'],[4,13,8,1,'#ff6040'],
      [3,4,1,1,'#000'],[4,5,2,1,'#000'],[12,4,1,1,'#000'],[10,5,2,1,'#000'],
      [5,7,2,2,'#000'],[9,7,2,2,'#000'],
      [6,11,4,1,'#000'],[5,12,1,1,'#000'],[10,12,1,1,'#000']
    ]
  };

  // Build SVG element properly using DOM API (not innerHTML)
  function buildEmojiSVG(id, size) {
    var data = EMOJI_DATA[id];
    if (!data) return null;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.style.imageRendering = 'pixelated';
    svg.setAttribute('shape-rendering', 'crispEdges');
    for (var i = 0; i < data.length; i++) {
      var d = data[i];
      var r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('x', d[0]);
      r.setAttribute('y', d[1]);
      r.setAttribute('width', d[2]);
      r.setAttribute('height', d[3]);
      r.setAttribute('fill', d[4]);
      svg.appendChild(r);
    }
    return svg;
  }

  function ensureEmojiStyles() {
    if (_emojiStyleInjected) return;
    var s = document.createElement('style');
    s.textContent = [
      '@keyframes emoji-pop{' +
        '0%{transform:translate(-50%,-50%) scale(0);opacity:0}' +
        '12%{transform:translate(-50%,-50%) scale(1.2);opacity:1}' +
        '22%{transform:translate(-50%,-50%) scale(0.9)}' +
        '32%{transform:translate(-50%,-50%) scale(1.05)}' +
        '42%{transform:translate(-50%,-50%) scale(1)}' +
        '82%{transform:translate(-50%,-50%) scale(1);opacity:1}' +
        '100%{transform:translate(-50%,-50%) scale(1.4);opacity:0}}',
      '.emoji-fullscreen{position:fixed;left:50%;top:45%;transform:translate(-50%,-50%);' +
        'z-index:9500;pointer-events:none;text-align:center;' +
        'animation:emoji-pop 4s ease-out forwards}',
      '.emoji-fullscreen-user{' +
        'font:bold 16px Tahoma,"MS Sans Serif",sans-serif;' +
        'color:#fff;text-shadow:2px 2px 4px #000,-2px -2px 4px #000,2px -2px 4px #000,-2px 2px 4px #000;' +
        'margin-top:12px;letter-spacing:1px}'
    ].join('\n');
    document.head.appendChild(s);
    _emojiStyleInjected = true;
  }

  function showEmojiFullscreen(username, emojiId) {
    ensureEmojiStyles();

    var svg = buildEmojiSVG(emojiId, 280);
    if (!svg) return;
    svg.style.filter = 'drop-shadow(0 6px 24px rgba(0,0,0,0.6))';

    var wrap = document.createElement('div');
    wrap.className = 'emoji-fullscreen';
    wrap.appendChild(svg);

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
