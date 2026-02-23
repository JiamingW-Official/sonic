/**
 * Sonic Mobile — main app logic.
 * Handles connection, username entry, role selection, and view routing.
 */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var socket = null;
  var username = '';
  var roomId = '';
  var currentSlot = null;
  var serverState = null; // last state-sync from host

  // Parse room from URL
  var params = new URLSearchParams(window.location.search);
  roomId = params.get('room') || '';

  // ── Helpers ──
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function clearApp() { app.innerHTML = ''; }

  // ── Screen: Connect ──
  function showConnectScreen() {
    clearApp();
    var win = el('div', 'w95-window');
    var tb = el('div', 'w95-titlebar');
    tb.innerHTML = '<span>📡</span> <span class="w95-titlebar-text">Sonic Remote</span>';
    win.appendChild(tb);

    var body = el('div', 'w95-window-body');
    var screen = el('div', 'connect-screen');

    var logo = el('div', 'connect-logo', 'Sonic');
    screen.appendChild(logo);
    screen.appendChild(el('div', '', 'Multi-Device Remote Control'));

    var form = el('div', 'connect-form');
    var nameInput = el('input', 'w95-input');
    nameInput.type = 'text';
    nameInput.placeholder = '输入用户名...';
    nameInput.maxLength = 20;
    nameInput.autocomplete = 'off';
    form.appendChild(nameInput);

    if (!roomId) {
      var roomInput = el('input', 'w95-input');
      roomInput.type = 'text';
      roomInput.placeholder = 'Room ID...';
      roomInput.maxLength = 10;
      form.appendChild(roomInput);
    }

    var connectBtn = el('button', 'w95-btn primary', '连接');
    var statusMsg = el('div');
    statusMsg.style.cssText = 'font-size:10px;color:#808080;min-height:16px;margin-top:4px;';
    form.appendChild(connectBtn);
    form.appendChild(statusMsg);
    screen.appendChild(form);
    body.appendChild(screen);
    win.appendChild(body);
    app.appendChild(win);

    // Auto-focus
    nameInput.focus();

    connectBtn.addEventListener('click', function () {
      var name = nameInput.value.trim();
      if (!name) { statusMsg.textContent = '请输入用户名'; return; }
      var rid = roomId || (roomInput ? roomInput.value.trim() : '');
      if (!rid) { statusMsg.textContent = '请输入 Room ID'; return; }
      username = name;
      roomId = rid;
      statusMsg.textContent = '正在连接...';
      connectBtn.disabled = true;
      doConnect(function (err) {
        if (err) {
          statusMsg.textContent = '连接失败: ' + err;
          connectBtn.disabled = false;
        }
      });
    });

    nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') connectBtn.click();
    });
  }

  // ── Connect to relay ──
  function doConnect(cb) {
    var relayUrl = window.location.origin;
    socket = io(relayUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000
    });

    socket.on('connect', function () {
      socket.emit('client:join-room', { roomId: roomId, username: username }, function (res) {
        if (res && res.error) {
          cb(res.error);
          return;
        }
        showRoleScreen();
      });
    });

    socket.on('connect_error', function () {
      cb('无法连接到服务器');
    });

    socket.on('client:room-state', function (data) {
      updateRoleScreen(data);
    });

    socket.on('client:slot-granted', function (data) {
      currentSlot = data.slot;
      showControlScreen(data.slot);
    });

    socket.on('client:slot-denied', function (data) {
      if (typeof window.__mobileShowToast === 'function')
        window.__mobileShowToast('槽位已满，排队中 #' + data.queuePos);
    });

    socket.on('client:kicked', function (data) {
      currentSlot = null;
      showRoleScreen();
      if (typeof window.__mobileShowToast === 'function')
        window.__mobileShowToast(data.reason || '已被移出');
    });

    socket.on('client:state-sync', function (data) {
      serverState = data;
      if (currentSlot && typeof window.__mobileOnStateSync === 'function') {
        window.__mobileOnStateSync(currentSlot, data);
      }
    });

    socket.on('client:state-update', function (data) {
      if (currentSlot && typeof window.__mobileOnStateUpdate === 'function') {
        window.__mobileOnStateUpdate(currentSlot, data);
      }
    });

    socket.on('client:meter-update', function (data) {
      if (currentSlot === 'mixer' && typeof window.__mobileOnMeterUpdate === 'function') {
        window.__mobileOnMeterUpdate(data);
      }
    });

    socket.on('disconnect', function () {
      if (typeof window.__mobileShowToast === 'function')
        window.__mobileShowToast('连接已断开，重连中...');
    });
  }

  // ── Screen: Role Selection ──
  var roleScreenSlots = null;
  function showRoleScreen() {
    clearApp();
    currentSlot = null;
    var win = el('div', 'w95-window');
    var tb = el('div', 'w95-titlebar');
    tb.innerHTML = '<span>📡</span> <span class="w95-titlebar-text">Sonic — ' + escHtml(username) + '</span>';
    var dcBtn = el('button', 'w95-titlebar-btn', '×');
    dcBtn.onclick = function () {
      if (socket) { socket.emit('client:leave'); socket.disconnect(); }
      showConnectScreen();
    };
    var btnG = el('div', 'w95-titlebar-buttons');
    btnG.appendChild(dcBtn);
    tb.appendChild(btnG);
    win.appendChild(tb);

    var body = el('div', 'w95-window-body');
    body.appendChild(el('div', '', '选择你的角色:'));
    body.style.padding = '12px';

    var grid = el('div', 'role-grid');
    var slotDefs = [
      { key: 'instrument', icon: '🎹', label: '乐器', desc: '选择合成器 · 调整音色参数' },
      { key: 'mixer', icon: '🎚️', label: '混音', desc: '控制每轨音量 · Pan · VU 表' },
      { key: 'fx', icon: '🎛️', label: '效果器', desc: '选择轨道 · 添加/调整效果' }
    ];

    roleScreenSlots = {};
    slotDefs.forEach(function (def) {
      var card = el('div', 'role-card');
      card.dataset.slot = def.key;
      card.innerHTML =
        '<div class="role-card-icon">' + def.icon + '</div>' +
        '<div class="role-card-info">' +
          '<div class="role-card-name">' + def.label + '</div>' +
          '<div class="role-card-status" id="role-status-' + def.key + '">' + def.desc + '</div>' +
        '</div>';
      card.addEventListener('click', function () {
        if (card.classList.contains('occupied')) return;
        socket.emit('client:request-slot', { slot: def.key });
      });
      grid.appendChild(card);
      roleScreenSlots[def.key] = card;
    });

    body.appendChild(grid);

    // Toast area
    var toast = el('div');
    toast.id = 'mobile-toast';
    toast.style.cssText = 'text-align:center;color:#808080;font-size:10px;margin-top:8px;min-height:16px;';
    body.appendChild(toast);

    win.appendChild(body);

    var statusbar = el('div', 'w95-statusbar');
    statusbar.textContent = 'Room: ' + roomId;
    win.appendChild(statusbar);

    app.appendChild(win);
  }

  function updateRoleScreen(data) {
    if (!roleScreenSlots) return;
    var slotDefs = {
      instrument: { desc: '选择合成器 · 调整音色参数' },
      mixer: { desc: '控制每轨音量 · Pan · VU 表' },
      fx: { desc: '选择轨道 · 添加/调整效果' }
    };
    ['instrument', 'mixer', 'fx'].forEach(function (key) {
      var card = roleScreenSlots[key];
      if (!card) return;
      var statusEl = document.getElementById('role-status-' + key);
      var occ = data.slots[key];
      if (occ) {
        card.classList.add('occupied');
        if (statusEl) {
          statusEl.textContent = occ.username + ' 使用中';
          statusEl.className = 'role-card-status';
        }
      } else {
        card.classList.remove('occupied');
        if (statusEl) {
          statusEl.textContent = slotDefs[key].desc;
          statusEl.className = 'role-card-status active';
        }
      }
    });
  }

  // ── Screen: Control view ──
  function showControlScreen(slot) {
    clearApp();
    var win = el('div', 'w95-window');

    // Titlebar
    var slotNames = { instrument: '🎹 乐器控制', mixer: '🎚️ 混音控制', fx: '🎛️ 效果器控制' };
    var tb = el('div', 'w95-titlebar');
    tb.style.position = 'relative';
    tb.innerHTML = '<span class="w95-titlebar-text">' + (slotNames[slot] || slot) + ' — ' + escHtml(username) + '</span>';
    var exitBtn = el('button', 'w95-titlebar-btn exit-btn', '←');
    exitBtn.title = '退出角色';
    exitBtn.onclick = function () {
      socket.emit('client:release-slot');
      currentSlot = null;
      showRoleScreen();
    };
    tb.appendChild(exitBtn);
    win.appendChild(tb);

    // Body
    var body = el('div', 'w95-window-body');
    body.id = 'control-body';
    win.appendChild(body);

    // Statusbar
    var statusbar = el('div', 'w95-statusbar');
    statusbar.id = 'control-statusbar';
    statusbar.textContent = 'Room: ' + roomId + ' | ' + username;
    win.appendChild(statusbar);

    app.appendChild(win);

    // Initialize the correct controller
    if (slot === 'instrument' && typeof window.__mobileInitInstrument === 'function') {
      window.__mobileInitInstrument(body, socket, serverState);
    } else if (slot === 'mixer' && typeof window.__mobileInitMixer === 'function') {
      window.__mobileInitMixer(body, socket, serverState);
    } else if (slot === 'fx' && typeof window.__mobileInitFx === 'function') {
      window.__mobileInitFx(body, socket, serverState);
    } else {
      body.textContent = '加载控制界面: ' + slot + '...';
    }
  }

  // ── Utilities ──
  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  window.__mobileShowToast = function (msg) {
    var t = document.getElementById('mobile-toast');
    if (t) t.textContent = msg;
  };

  window.__mobileGetSocket = function () { return socket; };
  window.__mobileGetState = function () { return serverState; };

  // ── Init ──
  showConnectScreen();
})();
