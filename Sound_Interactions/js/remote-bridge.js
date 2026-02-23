/**
 * Sonic Remote Bridge — desktop-side WebSocket client.
 * Connects to Render relay server, manages admin panel, QR code, and command dispatch.
 */
(function () {
  'use strict';

  // ── Configuration ──
  // Set this to your Render deployment URL (wss:// for production)
  var RELAY_URL = window.__SONIC_RELAY_URL || 'http://localhost:4000';

  var socket = null;
  var roomId = null;
  var connected = false;
  var adminPanel = null;
  var _topZ = 1600;
  var _meterInterval = null;

  // Slot state mirrors
  var slots = { instrument: null, mixer: null, fx: null };
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
      console.warn('[Remote] socket.io not loaded');
      return;
    }
    socket = io(RELAY_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionAttempts: Infinity
    });

    socket.on('connect', function () {
      connected = true;
      updateStatus('已连接');
      // Create room
      socket.emit('host:create-room', {}, function (res) {
        if (res && res.roomId) {
          roomId = res.roomId;
          updateRoomInfo();
          sendStateSync();
        }
      });
    });

    socket.on('disconnect', function () {
      connected = false;
      updateStatus('已断开 — 重连中...');
    });

    socket.on('reconnect', function () {
      connected = true;
      updateStatus('已重连');
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
      showToast(data.username + ' 已加入');
    });

    socket.on('room:client-left', function (data) {
      showToast(data.username + ' 已离开');
    });

    socket.on('room:slot-changed', function (data) {
      slots = data.slots || slots;
      queue = data.queue || queue;
      renderSlots();
      // If requestSync, send state to the newly joined slot
      if (data.requestSync) {
        sendStateSync();
      }
    });

    socket.on('room:control', function (data) {
      handleControl(data.slot, data.action, data.params);
    });

    // Start meter broadcast loop
    startMeterBroadcast();
  }

  // ── Send state sync to all clients ──
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
      state.fx = {
        fxNames: mixer.getFxNames(),
        fxPresets: mixer.getFxPresets()
      };
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
    }, 66); // ~15fps
  }

  // ── Handle remote control commands ──
  function handleControl(slot, action, params) {
    var api = window.__sonicRemoteAPI;
    var mixer = window.__sonicMixerAPI;
    if (!api) return;

    switch (action) {
      // ── Instrument ──
      case 'synth:select':
        api.selectSynth(params.presetIndex);
        api.refreshSynthRack();
        break;
      case 'synth:param':
        api.setSynthParam(params.presetIndex, params.path, params.value);
        api.refreshSynthEditor();
        break;
      case 'synth:variation':
        api.applySynthVariation(params.presetIndex, params.varIndex);
        api.refreshSynthEditor();
        break;

      // ── Mixer ──
      case 'mixer:volume':
        if (params.isDrum) {
          api.setDrumTrackVolume(params.trackIndex, params.value / 100);
        } else if (params.trackIndex === -1) {
          // Master handled via UI only
        } else {
          api.setTrackVolume(params.trackIndex, params.value / 100);
        }
        if (mixer) mixer.updateFaderUI(params.trackIndex, params.value);
        break;
      case 'mixer:pan':
        if (params.isDrum) {
          api.setDrumTrackPan(params.trackIndex, params.value);
        } else {
          api.setTrackPan(params.trackIndex, params.value);
        }
        if (mixer) mixer.updatePanUI(params.trackIndex, params.value);
        break;
      case 'mixer:master-volume':
        if (mixer) mixer.updateFaderUI(-1, params.value);
        break;

      // ── FX ──
      case 'fx:toggle':
        api.setTrackEffectEnabled(params.trackIndex, params.isDrum, params.effectName, params.enabled);
        break;
      case 'fx:param':
        api.setTrackEffectParam(params.trackIndex, params.isDrum, params.effectName, params.paramName, params.value);
        break;
      case 'fx:main-toggle':
        api.setMainEffectEnabled(params.effectName, params.enabled);
        break;
      case 'fx:main-param':
        api.setMainEffectParam(params.effectName, params.paramName, params.value);
        break;
    }
  }

  // ── Toast notification ──
  function showToast(msg) {
    var toast = document.getElementById('mode-toast');
    if (toast) {
      toast.textContent = msg;
      toast.classList.remove('visible');
      void toast.offsetWidth;
      toast.classList.add('visible');
    }
  }

  // ═══ Admin Panel UI (Win95 window) ═══
  function createAdminPanel() {
    if (adminPanel) return;

    adminPanel = el('div', 'w95-window sonic-admin-panel');
    adminPanel.style.cssText = 'position:fixed;right:12px;top:28px;width:310px;z-index:1600;display:none;';

    // Titlebar
    var titlebar = el('div', 'w95-titlebar');
    titlebar.innerHTML = '<span style="margin-right:4px">📡</span> <span class="w95-titlebar-text">Remote Control</span>';
    var btnGroup = el('div', 'w95-titlebar-buttons');
    var closeBtn = el('button', 'w95-titlebar-btn', '×');
    closeBtn.onclick = function () { adminPanel.style.display = 'none'; };
    btnGroup.appendChild(closeBtn);
    titlebar.appendChild(btnGroup);
    adminPanel.appendChild(titlebar);

    // Dragging
    var dragging = false, dx = 0, dy = 0;
    titlebar.addEventListener('mousedown', function (e) {
      if (e.target.closest('.w95-titlebar-btn')) return;
      dragging = true;
      dx = e.clientX - adminPanel.offsetLeft;
      dy = e.clientY - adminPanel.offsetTop;
      adminPanel.style.zIndex = ++_topZ;
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      adminPanel.style.left = (e.clientX - dx) + 'px';
      adminPanel.style.right = 'auto';
      adminPanel.style.top = (e.clientY - dy) + 'px';
    });
    document.addEventListener('mouseup', function () { dragging = false; });

    // Body
    var body = el('div', 'w95-window-body');
    body.style.cssText = 'padding:8px;font:11px Tahoma,sans-serif;';

    // Status
    var statusRow = el('div', 'sonic-admin-status');
    statusRow.id = 'sonic-admin-status';
    statusRow.textContent = '正在连接...';
    statusRow.style.cssText = 'margin-bottom:6px;color:#808080;';
    body.appendChild(statusRow);

    // Room info
    var roomRow = el('div', 'sonic-admin-room');
    roomRow.id = 'sonic-admin-room';
    roomRow.style.cssText = 'display:flex;gap:10px;align-items:flex-start;margin-bottom:8px;';
    // QR canvas
    var qrWrap = el('div');
    qrWrap.style.cssText = 'flex-shrink:0;';
    var qrCanvas = document.createElement('canvas');
    qrCanvas.id = 'sonic-admin-qr';
    qrCanvas.width = 128; qrCanvas.height = 128;
    qrCanvas.style.cssText = 'width:128px;height:128px;border:1px solid #808080;background:#fff;';
    qrWrap.appendChild(qrCanvas);
    roomRow.appendChild(qrWrap);
    // Room details
    var roomDetails = el('div');
    roomDetails.id = 'sonic-admin-room-details';
    roomDetails.style.cssText = 'font:10px Tahoma,sans-serif;word-break:break-all;color:#000;';
    roomDetails.textContent = '等待创建房间...';
    roomRow.appendChild(roomDetails);
    body.appendChild(roomRow);

    // Separator
    body.appendChild(createSeparator('槽位状态'));

    // Slots
    var slotsDiv = el('div');
    slotsDiv.id = 'sonic-admin-slots';
    body.appendChild(slotsDiv);

    // Separator
    body.appendChild(createSeparator('排队'));

    // Queue
    var queueDiv = el('div');
    queueDiv.id = 'sonic-admin-queue';
    queueDiv.textContent = '(暂无)';
    queueDiv.style.cssText = 'color:#808080;font-size:10px;margin-bottom:4px;';
    body.appendChild(queueDiv);

    adminPanel.appendChild(body);
    document.body.appendChild(adminPanel);

    renderSlots();
  }

  function createSeparator(label) {
    var wrap = el('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:4px;margin:6px 0 4px;';
    var line1 = el('div');
    line1.style.cssText = 'flex:1;height:1px;background:#808080;box-shadow:0 1px 0 #fff;';
    var txt = el('span', '', label);
    txt.style.cssText = 'font:bold 10px Tahoma,sans-serif;color:#404040;white-space:nowrap;';
    var line2 = el('div');
    line2.style.cssText = 'flex:1;height:1px;background:#808080;box-shadow:0 1px 0 #fff;';
    wrap.appendChild(line1);
    wrap.appendChild(txt);
    wrap.appendChild(line2);
    return wrap;
  }

  function updateStatus(msg) {
    var s = document.getElementById('sonic-admin-status');
    if (s) {
      s.textContent = msg;
      s.style.color = connected ? '#008000' : '#808080';
    }
  }

  function updateRoomInfo() {
    var details = document.getElementById('sonic-admin-room-details');
    if (details && roomId) {
      var joinUrl = RELAY_URL.replace(/^http/, 'http') + '/?room=' + roomId;
      details.innerHTML = '<strong>Room:</strong> ' + roomId +
        '<br><span style="font-size:9px;color:#606060;">' + joinUrl + '</span>';
      // Generate QR
      var qrCanvas = document.getElementById('sonic-admin-qr');
      if (qrCanvas && typeof QRCode !== 'undefined') {
        QRCode.toCanvas(qrCanvas, joinUrl, {
          width: 128, margin: 1,
          color: { dark: '#000080', light: '#ffffff' }
        });
      }
    }
  }

  function renderSlots() {
    var slotsDiv = document.getElementById('sonic-admin-slots');
    if (!slotsDiv) return;
    slotsDiv.innerHTML = '';

    var slotDefs = [
      { key: 'instrument', label: '🎹 乐器', color: '#1084d0' },
      { key: 'mixer', label: '🎚️ 混音', color: '#40a040' },
      { key: 'fx', label: '🎛️ 效果器', color: '#d04040' }
    ];

    slotDefs.forEach(function (def) {
      var row = el('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:3px 4px;margin-bottom:2px;border:1px solid #808080;background:#fff;';
      var left = el('span');
      var occ = slots[def.key];
      if (occ) {
        left.innerHTML = '<span style="color:' + def.color + '">' + def.label + ':</span> <strong>' + escHtml(occ.username) + '</strong>';
      } else {
        left.innerHTML = '<span style="color:' + def.color + '">' + def.label + ':</span> <span style="color:#aaa">(空闲)</span>';
      }
      row.appendChild(left);

      if (occ) {
        var kickBtn = el('button', '', '踢出');
        kickBtn.style.cssText = 'font:10px Tahoma,sans-serif;padding:1px 6px;cursor:pointer;background:#c0c0c0;border:2px outset #ddd;';
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
    var queueDiv = document.getElementById('sonic-admin-queue');
    if (queueDiv) {
      if (queue.length === 0) {
        queueDiv.textContent = '(暂无)';
        queueDiv.style.color = '#808080';
      } else {
        queueDiv.innerHTML = '';
        queue.forEach(function (q) {
          var qRow = el('div');
          qRow.textContent = q.username + ' → ' + slotLabel(q.requestedSlot);
          qRow.style.cssText = 'font-size:10px;padding:1px 0;';
          queueDiv.appendChild(qRow);
        });
        queueDiv.style.color = '#000';
      }
    }
  }

  function slotLabel(key) {
    var map = { instrument: '乐器', mixer: '混音', fx: '效果器' };
    return map[key] || key;
  }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
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
    sendStateSync: sendStateSync
  };

})();
