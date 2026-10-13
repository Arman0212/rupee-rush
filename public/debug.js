/* Rupee Rush debug client. Temporary: Phase 4 replaces it.
 * Every bit of user-supplied text goes through textContent, never innerHTML. */
'use strict';

(() => {
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const AWAY_GRACE_MS = 60_000;

  let code = null; // room we are in (or trying to rejoin)
  let room = null; // last 'state'.room
  let lastState = null; // last 'state', re-rendered when 'you' arrives
  let you = null; // last 'you'
  let deadline = null;
  let lastVersion = 0;

  // --- storage (may be blocked; never fatal) ---------------------------------
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const tokenKey = (c) => `rr:token:${c}`;

  // --- tiny DOM helpers --------------------------------------------------------
  function el(tag, text, props = {}) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    return Object.assign(node, props);
  }
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
  const showError = (msg) => { $('error').textContent = msg || ''; };
  const showNotice = (msg) => { $('notice').textContent = msg || ''; };
  const nameOf = (id) => (room && room.players.find((p) => p.id === id) || {}).name || id;

  /** Emit with an ack; surface errors. */
  function send(event, payload) {
    return new Promise((resolve) => {
      socket.timeout(5000).emit(event, payload, (err, res) => {
        const result = err ? { ok: false, error: 'no response from server' } : res;
        if (!result.ok) showError(`${event}: ${result.error}`);
        else showError('');
        resolve(result);
      });
    });
  }

  // --- home ----------------------------------------------------------------------
  $('name').value = store.get('rr:name') || '';
  $('name').addEventListener('change', () => store.set('rr:name', $('name').value));

  function joined(result) {
    if (!result.ok) return;
    code = result.code;
    store.set(tokenKey(code), result.token);
    history.replaceState(null, '', `/r/${code}`);
    $('home').hidden = true;
    $('room').hidden = false;
  }

  $('create').onclick = () => send('createRoom', { name: $('name').value }).then(joined);
  $('join').onclick = () => joinCode($('code').value.trim().toUpperCase());
  $('refresh').onclick = refreshRooms;

  function joinCode(c) {
    if (!c) return;
    const token = store.get(tokenKey(c));
    send('joinRoom', { code: c, name: $('name').value, ...(token ? { token } : {}) }).then((r) => {
      if (!r.ok && token && r.error === 'game already started') store.del(tokenKey(c));
      joined(r);
    });
  }

  function refreshRooms() {
    send('listRooms').then((r) => {
      const list = $('rooms');
      clear(list);
      if (!r.ok) return;
      if (!r.rooms.length) list.append(el('li', 'No open rooms.'));
      for (const info of r.rooms) {
        const li = el('li', `${info.code}: ${info.hostName}'s room, ${info.players}/${info.maxPlayers} `);
        li.append(el('button', 'Join', { onclick: () => joinCode(info.code) }));
        list.append(li);
      }
    });
  }

  function leaveToHome(message) {
    code = null;
    room = null;
    lastState = null;
    you = null;
    deadline = null;
    lastVersion = 0;
    history.replaceState(null, '', '/');
    $('room').hidden = true;
    $('home').hidden = false;
    showNotice(message);
    refreshRooms();
  }

  $('leave').onclick = () => {
    const c = code;
    send('leaveRoom').then((r) => {
      if (r.ok) {
        store.del(tokenKey(c));
        leaveToHome('You left the room.');
      }
    });
  };

  // --- socket events -----------------------------------------------------------
  socket.on('connect', () => {
    showNotice('');
    lastVersion = 0; // versions are checked per connection
    // Rejoin automatically after a network blip, or on /r/CODE with a stored token.
    const fromPath = location.pathname.match(/^\/r\/([A-Za-z0-9]{6})$/);
    const target = code || (fromPath && fromPath[1].toUpperCase());
    if (target && store.get(tokenKey(target))) joinCode(target);
    else if (target) $('code').value = target;
    refreshRooms();
  });
  socket.on('disconnect', () => showNotice('Disconnected: reconnecting…'));

  socket.on('state', (s) => {
    if (s.version <= lastVersion) console.warn('state version went backwards', s.version, lastVersion);
    lastVersion = s.version;
    room = s.room;
    lastState = s;
    deadline = s.deadline;
    renderRoom(s);
    for (const e of s.events) logEvent(e);
  });

  // 'you' follows each 'state'; who "you" are affects the whole view (host controls, "(you)").
  socket.on('you', (y) => {
    you = y;
    if (lastState) renderRoom(lastState);
  });

  socket.on('chatHistory', ({ messages }) => {
    clear($('chat'));
    messages.forEach(addChat);
  });
  socket.on('chat', addChat);

  socket.on('gameOver', ({ name }) => showNotice(`Game over: ${name || 'nobody'} wins!`));
  socket.on('replaced', () => {
    code = null; // don't fight the other tab
    leaveToHome('This seat was opened in another tab.');
  });
  socket.on('kicked', ({ code: c }) => {
    store.del(tokenKey(c));
    leaveToHome('The host removed you from the room.');
  });
  socket.on('roomClosed', ({ code: c, reason }) => {
    store.del(tokenKey(c));
    leaveToHome(`Room closed (${reason}).`);
  });

  // --- rendering -----------------------------------------------------------------
  function renderRoom(s) {
    $('roomCode').textContent = room.code;
    $('roomStatus').textContent = `(${room.status})`;
    const link = `${location.origin}/r/${room.code}`;
    $('invite').textContent = link;
    $('invite').href = link;
    $('version').textContent = `version ${s.version}`;
    $('state').textContent = s.publicState ? JSON.stringify(s.publicState, null, 2) : '(lobby: no game yet)';
    $('lobby').hidden = room.status !== 'lobby';
    $('game').hidden = room.status === 'lobby';
    renderPlayers(s.publicState);
    if (room.status === 'lobby') {
      renderColours();
      renderSettings();
    }
    renderActions();
  }

  function renderPlayers(publicState) {
    const list = $('players');
    clear(list);
    const amHost = you && you.isHost;
    for (const p of room.players) {
      const li = el('li');
      li.append(el('span', '', { className: 'swatch', style: `background:${p.color}` }));
      const engine = publicState && publicState.players.find((x) => x.id === p.id);
      const bits = [p.name];
      if (p.isHost) bits.push('[host]');
      if (you && p.id === you.playerId) bits.push('(you)');
      if (!p.connected) bits.push('(disconnected)');
      if (engine) bits.push(`₹${engine.cash} @${engine.position}${engine.inJail ? ' jail' : ''}${engine.bankrupt ? ' BANKRUPT' : ''}`);
      if (publicState && publicState.currentPlayerId === p.id) bits.push('<- turn');
      li.append(el('span', bits.join(' ')));
      const kickable = room.status !== 'playing' || (!p.connected && Date.now() - p.disconnectedAt >= AWAY_GRACE_MS);
      if (amHost && !p.isHost && kickable) {
        li.append(' ', el('button', 'Kick', { onclick: () => send('kick', { playerId: p.id }) }));
      }
      list.append(li);
    }
  }

  function renderColours() {
    const box = $('colours');
    clear(box);
    const mine = you && room.players.find((p) => p.id === you.playerId);
    const taken = new Set(room.players.filter((p) => p !== mine).map((p) => p.color));
    for (const colour of room.colors) {
      const button = el('button', '', {
        className: `colour${mine && mine.color === colour ? ' mine' : ''}`,
        style: `background:${colour}`,
        title: colour,
        disabled: taken.has(colour),
        onclick: () => send('pickColor', { color: colour }),
      });
      box.append(button);
    }
  }

  function renderSettings() {
    const form = $('settings');
    if (form.contains(document.activeElement)) return; // don't clobber what the host is typing
    clear(form);
    const isHost = you && you.isHost;
    $('settingsHint').textContent = isHost ? '(you are host)' : '(host only)';
    for (const [key, value] of Object.entries(room.settings)) {
      const label = el('label', `${key} `);
      const input = el('input', null, { name: key, disabled: !isHost });
      if (typeof value === 'boolean') {
        input.type = 'checkbox';
        input.checked = value;
      } else {
        input.type = 'number';
        input.value = value;
      }
      label.append(input);
      form.append(label);
    }
    if (isHost) form.append(el('button', 'Save settings'));
    $('start').disabled = !isHost;
  }

  $('settings').onsubmit = (e) => {
    e.preventDefault();
    const settings = {};
    for (const input of $('settings').querySelectorAll('input')) {
      settings[input.name] = input.type === 'checkbox' ? input.checked : Number(input.value);
    }
    send('updateSettings', { settings });
  };
  $('start').onclick = () => send('startGame');
  $('playAgain').onclick = () => send('playAgain');

  function renderActions() {
    const box = $('actions');
    clear(box);
    $('playAgain').hidden = !(room && room.status === 'finished' && you && you.isHost);
    if (!you) return;
    $('youInfo').textContent = `(state v${you.version})`;
    if (!you.legalActions.length) box.append(el('span', room && room.status === 'playing' ? 'Nothing to do right now.' : ''));
    for (const action of you.legalActions) {
      const label = action.tileId ? `${action.type} ${action.tileId}` : action.type;
      box.append(el('button', label, { onclick: () => send('action', action) }));
    }
  }

  function logEvent(e) {
    const log = $('log');
    const { type, at, ...rest } = e;
    const who = rest.playerId ? `${nameOf(rest.playerId)}: ` : '';
    log.append(el('li', `${who}${type} ${JSON.stringify(rest)}`));
    while (log.children.length > 300) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  function addChat(m) {
    const li = el('li');
    li.append(el('b', `${m.name}: `), el('span', m.text)); // textContent: never HTML
    $('chat').append(li);
    $('chat').scrollTop = $('chat').scrollHeight;
  }

  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chatText').value;
    send('chat', { text }).then((r) => { if (r.ok) $('chatText').value = ''; });
  };

  setInterval(() => {
    $('deadline').textContent = deadline ? `Turn timer: ${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}s` : '';
  }, 500);
})();
