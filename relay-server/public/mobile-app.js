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
  var serverState = null;

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

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  // ── Screen: Connect ──
  function showConnectScreen() {
    clearApp();
    var win = el('div', 'w95-window');
    var tb = el('div', 'w95-titlebar');
    tb.innerHTML = '<span>\uD83D\uDCE1</span> <span class="w95-titlebar-text">Sonic Remote</span>';
    win.appendChild(tb);

    var body = el('div', 'w95-window-body');
    var screen = el('div', 'connect-screen');

    var logo = el('div', 'connect-logo', 'Sonic');
    screen.appendChild(logo);
    var subtitle = el('div', 'connect-subtitle', 'Multi-Device Remote Control');
    screen.appendChild(subtitle);

    var form = el('div', 'connect-form');
    var nameInput = el('input', 'w95-input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Enter username...';
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

    var connectBtn = el('button', 'w95-btn primary', 'Connect');
    var statusMsg = el('div', 'connect-status');
    form.appendChild(connectBtn);
    form.appendChild(statusMsg);
    screen.appendChild(form);
    body.appendChild(screen);
    win.appendChild(body);
    app.appendChild(win);

    nameInput.focus();

    connectBtn.addEventListener('click', function () {
      var name = nameInput.value.trim();
      if (!name) { statusMsg.textContent = 'Please enter a username'; return; }
      var rid = roomId || (roomInput ? roomInput.value.trim() : '');
      if (!rid) { statusMsg.textContent = 'Please enter Room ID'; return; }
      username = name;
      roomId = rid;
      statusMsg.textContent = 'Connecting...';
      connectBtn.disabled = true;
      doConnect(function (err) {
        if (err) {
          statusMsg.textContent = 'Connection failed: ' + err;
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
        if (res && res.error) { cb(res.error); return; }
        showRoleScreen();
      });
    });

    socket.on('connect_error', function () {
      cb('Unable to connect to server');
    });

    socket.on('client:room-state', function (data) {
      updateRoleScreen(data);
    });

    socket.on('client:slot-granted', function (data) {
      currentSlot = data.slot;
      showControlScreen(data.slot);
    });

    socket.on('client:slot-denied', function (data) {
      showToast('Slot full \u2014 queued #' + data.queuePos);
    });

    socket.on('client:kicked', function () {
      currentSlot = null;
      showKickModal();
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
      showToast('Disconnected \u2014 reconnecting...');
    });
  }

  // ── Kick Modal (Win95 dialog) ──
  function showKickModal() {
    // Remove any existing modal
    var existing = document.getElementById('kick-modal-overlay');
    if (existing) existing.remove();

    var overlay = el('div', 'kick-overlay');
    overlay.id = 'kick-modal-overlay';

    var dialog = el('div', 'w95-window kick-dialog');

    var tb = el('div', 'w95-titlebar');
    tb.innerHTML = '<span class="w95-titlebar-text">\u26A0 Session Ended</span>';
    dialog.appendChild(tb);

    var body = el('div', 'w95-window-body kick-dialog-body');

    var iconRow = el('div', 'kick-icon-row');
    var icon = el('div', 'kick-icon', '\u26D4');
    iconRow.appendChild(icon);
    var msgCol = el('div', 'kick-msg-col');
    msgCol.appendChild(el('div', 'kick-title', 'You have been removed'));
    msgCol.appendChild(el('div', 'kick-subtitle', 'The host has ended your session. You will be returned to the home screen.'));
    iconRow.appendChild(msgCol);
    body.appendChild(iconRow);

    var btnRow = el('div', 'kick-btn-row');
    var okBtn = el('button', 'w95-btn primary kick-ok-btn', 'OK');
    okBtn.addEventListener('click', function () {
      overlay.remove();
      showConnectScreen();
    });
    btnRow.appendChild(okBtn);
    body.appendChild(btnRow);

    dialog.appendChild(body);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  // ── Screen: Role Selection ──
  var roleScreenSlots = null;
  function showRoleScreen() {
    clearApp();
    currentSlot = null;
    var win = el('div', 'w95-window');

    var tb = el('div', 'w95-titlebar');
    tb.innerHTML = '<span>\uD83D\uDCE1</span> <span class="w95-titlebar-text">Sonic \u2014 ' + escHtml(username) + '</span>';
    var dcBtn = el('button', 'w95-titlebar-btn', '\u00D7');
    dcBtn.onclick = function () {
      if (socket) { socket.emit('client:leave'); socket.disconnect(); }
      showConnectScreen();
    };
    var btnG = el('div', 'w95-titlebar-buttons');
    btnG.appendChild(dcBtn);
    tb.appendChild(btnG);
    win.appendChild(tb);

    var body = el('div', 'w95-window-body');
    body.style.padding = '12px';

    var header = el('div', 'role-header', 'Select your role:');
    body.appendChild(header);

    var grid = el('div', 'role-grid');
    var slotDefs = [
      { key: 'instrument', icon: '\uD83C\uDFB9', label: 'Instrument', desc: 'Select synth \u00B7 Adjust tone params' },
      { key: 'mixer', icon: '\uD83C\uDF9A\uFE0F', label: 'Mixer', desc: 'Track volume \u00B7 Pan \u00B7 VU meters' },
      { key: 'fx', icon: '\uD83C\uDF9B\uFE0F', label: 'FX', desc: 'Select track \u00B7 Add/adjust effects' },
      { key: 'drums', icon: '\uD83E\uDD41', label: 'Drum Pad', desc: 'Launchpad \u00B7 Tap to trigger drums' },
      { key: 'keys', icon: '\uD83C\uDFB5', label: 'Keyboard', desc: '3 octaves \u00B7 Play melodic notes' }
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

    // ── Danmaku (barrage) input ──
    var danmakuBox = el('div', 'w95-groupbox');
    danmakuBox.style.marginTop = '8px';
    var danmakuLabel = el('div', 'w95-groupbox-label', 'Danmaku');
    danmakuBox.appendChild(danmakuLabel);

    var danmakuRow = el('div', 'danmaku-input-row');
    var danmakuInput = el('input', 'w95-input danmaku-input');
    danmakuInput.type = 'text';
    danmakuInput.placeholder = 'Type a comment...';
    danmakuInput.maxLength = 100;
    danmakuInput.autocomplete = 'off';
    danmakuRow.appendChild(danmakuInput);

    var danmakuSendBtn = el('button', 'w95-btn danmaku-send-btn', 'Send');
    danmakuRow.appendChild(danmakuSendBtn);
    danmakuBox.appendChild(danmakuRow);

    var danmakuStatus = el('div', 'danmaku-status');
    danmakuStatus.textContent = 'Send comments to the main screen';
    danmakuBox.appendChild(danmakuStatus);

    function sendDanmaku() {
      var text = danmakuInput.value.trim();
      if (!text || !socket) return;
      socket.emit('client:danmaku', { text: text }, function (res) {
        if (res && res.error) {
          danmakuStatus.textContent = res.error;
          danmakuStatus.style.color = '#c00';
        } else {
          danmakuStatus.textContent = 'Sent!';
          danmakuStatus.style.color = '#008000';
          danmakuInput.value = '';
        }
        setTimeout(function () {
          danmakuStatus.textContent = 'Send comments to the main screen';
          danmakuStatus.style.color = '';
        }, 2000);
      });
    }

    danmakuSendBtn.addEventListener('click', sendDanmaku);
    danmakuInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') sendDanmaku();
    });

    body.appendChild(danmakuBox);

    // ── Emoji Stickers Grid (2×4) ──
    if (window.__sonicEmojis) {
      var emojiBox = el('div', 'w95-groupbox');
      emojiBox.style.marginTop = '8px';
      var emojiLabel = el('div', 'w95-groupbox-label', 'Stickers');
      emojiBox.appendChild(emojiLabel);

      var emojiGrid = el('div', 'emoji-grid');
      var emojis = window.__sonicEmojis;
      for (var ei = 0; ei < emojis.length; ei++) {
        (function (emoji) {
          var btn = el('button', 'emoji-btn');
          btn.title = emoji.title;
          btn.innerHTML = emoji.svg();
          btn.addEventListener('click', function () {
            if (!socket) return;
            socket.emit('client:emoji', { id: emoji.id }, function (res) {
              if (res && res.error) {
                showToast(res.error);
              } else {
                btn.classList.add('sent');
                setTimeout(function () { btn.classList.remove('sent'); }, 600);
              }
            });
          });
          emojiGrid.appendChild(btn);
        })(emojis[ei]);
      }
      emojiBox.appendChild(emojiGrid);
      body.appendChild(emojiBox);
    }

    var toast = el('div');
    toast.id = 'mobile-toast';
    toast.className = 'mobile-toast';
    body.appendChild(toast);

    win.appendChild(body);

    var statusbar = el('div', 'w95-statusbar');
    statusbar.textContent = 'Room: ' + roomId;
    win.appendChild(statusbar);

    app.appendChild(win);
  }

  function updateRoleScreen(data) {
    if (!roleScreenSlots) return;
    var slotDescs = {
      instrument: 'Select synth \u00B7 Adjust tone params',
      mixer: 'Track volume \u00B7 Pan \u00B7 VU meters',
      fx: 'Select track \u00B7 Add/adjust effects',
      drums: 'Launchpad \u00B7 Tap to trigger drums',
      keys: '3 octaves \u00B7 Play melodic notes'
    };
    ['instrument', 'mixer', 'fx', 'drums', 'keys'].forEach(function (key) {
      var card = roleScreenSlots[key];
      if (!card) return;
      var statusEl = document.getElementById('role-status-' + key);
      var occ = data.slots[key];
      if (occ) {
        card.classList.add('occupied');
        if (statusEl) {
          statusEl.textContent = occ.username + ' \u2014 in use';
          statusEl.className = 'role-card-status';
        }
      } else {
        card.classList.remove('occupied');
        if (statusEl) {
          statusEl.textContent = slotDescs[key];
          statusEl.className = 'role-card-status active';
        }
      }
    });
  }

  // ── Screen: Control view ──
  function showControlScreen(slot) {
    clearApp();
    var win = el('div', 'w95-window');

    var slotNames = {
      instrument: '\uD83C\uDFB9 Instrument',
      mixer: '\uD83C\uDF9A\uFE0F Mixer',
      fx: '\uD83C\uDF9B\uFE0F FX',
      drums: '\uD83E\uDD41 Drum Pad',
      keys: '\uD83C\uDFB5 Keyboard'
    };
    var tb = el('div', 'w95-titlebar');
    tb.style.position = 'relative';
    tb.innerHTML = '<span class="w95-titlebar-text">' + (slotNames[slot] || slot) + ' \u2014 ' + escHtml(username) + '</span>';
    var exitBtn = el('button', 'w95-titlebar-btn exit-btn', '\u2190');
    exitBtn.title = 'Exit';
    exitBtn.onclick = function () {
      socket.emit('client:release-slot');
      currentSlot = null;
      showRoleScreen();
    };
    tb.appendChild(exitBtn);
    win.appendChild(tb);

    var body = el('div', 'w95-window-body');
    body.id = 'control-body';
    win.appendChild(body);

    var statusbar = el('div', 'w95-statusbar');
    statusbar.id = 'control-statusbar';
    statusbar.textContent = 'Room: ' + roomId + ' | ' + username;
    win.appendChild(statusbar);

    app.appendChild(win);

    if (slot === 'instrument' && typeof window.__mobileInitInstrument === 'function') {
      window.__mobileInitInstrument(body, socket, serverState);
    } else if (slot === 'mixer' && typeof window.__mobileInitMixer === 'function') {
      window.__mobileInitMixer(body, socket, serverState);
    } else if (slot === 'fx' && typeof window.__mobileInitFx === 'function') {
      window.__mobileInitFx(body, socket, serverState);
    } else if (slot === 'drums' && typeof window.__mobileInitDrums === 'function') {
      window.__mobileInitDrums(body, socket, serverState);
    } else if (slot === 'keys' && typeof window.__mobileInitKeys === 'function') {
      window.__mobileInitKeys(body, socket, serverState);
    } else {
      body.textContent = 'Loading controller: ' + slot + '...';
    }
  }

  // ── Toast ──
  function showToast(msg) {
    var t = document.getElementById('mobile-toast');
    if (t) {
      t.textContent = msg;
      t.classList.add('visible');
      setTimeout(function () { t.classList.remove('visible'); }, 3000);
    }
  }

  window.__mobileShowToast = showToast;
  window.__mobileGetSocket = function () { return socket; };
  window.__mobileGetState = function () { return serverState; };

  // ── Init ──
  showConnectScreen();
})();
