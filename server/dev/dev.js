(function () {
  'use strict';

  let socket = null;
  let currentRooms = [];
  let currentRoomState = null;
  let selectedCode = null;
  let selectedPlayerId = null;
  let toastTimer = null;

  // DOM Elements
  const authModal = document.getElementById('authModal');
  const keyInput = document.getElementById('keyInput');
  const authError = document.getElementById('authError');
  const saveKeyBtn = document.getElementById('saveKeyBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const connStatus = document.getElementById('connStatus');
  const refreshBtn = document.getElementById('refreshBtn');
  const roomSelect = document.getElementById('roomSelect');
  const noRoomNotice = document.getElementById('noRoomNotice');
  const roomView = document.getElementById('roomView');
  const toast = document.getElementById('toast');

  // Summary Elements
  const sumCode = document.getElementById('sumCode');
  const sumStatus = document.getElementById('sumStatus');
  const sumTurn = document.getElementById('sumTurn');
  const sumCurrentPlayer = document.getElementById('sumCurrentPlayer');
  const sumPhase = document.getElementById('sumPhase');

  // Auction Elements
  const auctionCard = document.getElementById('auctionCard');
  const aucTile = document.getElementById('aucTile');
  const aucBid = document.getElementById('aucBid');
  const aucBidder = document.getElementById('aucBidder');
  const aucTime = document.getElementById('aucTime');
  const extendAuc10Btn = document.getElementById('extendAuc10Btn');
  const extendAuc30Btn = document.getElementById('extendAuc30Btn');
  const endAucBtn = document.getElementById('endAucBtn');

  // Player Elements
  const playerTabs = document.getElementById('playerTabs');
  const pName = document.getElementById('pName');
  const pCash = document.getElementById('pCash');
  const pPosition = document.getElementById('pPosition');
  const pJail = document.getElementById('pJail');
  const customCashInput = document.getElementById('customCashInput');
  const applyCashBtn = document.getElementById('applyCashBtn');

  // Dice Elements
  const die1Select = document.getElementById('die1Select');
  const die2Select = document.getElementById('die2Select');
  const setRollBtn = document.getElementById('setRollBtn');
  const queueRollBtn = document.getElementById('queueRollBtn');
  const queuedRollsBox = document.getElementById('queuedRollsBox');
  const queueList = document.getElementById('queueList');
  const clearControlsBtn = document.getElementById('clearControlsBtn');

  // Policy Elements
  const polButtons = document.querySelectorAll('.btn-toggle');
  const polAvoidPlayerSelect = document.getElementById('polAvoidPlayerSelect');
  const polAimTileSelect = document.getElementById('polAimTileSelect');

  // Deck Elements
  const topSurpriseText = document.getElementById('topSurpriseText');
  const topTreasureText = document.getElementById('topTreasureText');
  const surpriseSelect = document.getElementById('surpriseSelect');
  const treasureSelect = document.getElementById('treasureSelect');
  const setSurpriseBtn = document.getElementById('setSurpriseBtn');
  const setTreasureBtn = document.getElementById('setTreasureBtn');

  // Board Elements
  const boardList = document.getElementById('boardList');

  function showToast(text = '✓ Applied') {
    toast.textContent = text;
    toast.classList.remove('hidden');
    // Restart animation
    toast.style.animation = 'none';
    toast.offsetHeight; // trigger reflow
    toast.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.add('hidden');
    }, 1200);
  }

  function getKey() {
    return localStorage.getItem('dev_key') || '';
  }

  function setKey(k) {
    if (k) localStorage.setItem('dev_key', k.trim());
    else localStorage.removeItem('dev_key');
  }

  function checkAuth() {
    const key = getKey();
    if (!key || key.length < 32) {
      authModal.classList.remove('hidden');
      keyInput.focus();
    } else {
      authModal.classList.add('hidden');
      initSocket(key);
    }
  }

  saveKeyBtn.addEventListener('click', () => {
    const val = keyInput.value.trim();
    if (val.length < 32) {
      authError.textContent = 'Key must be at least 32 characters.';
      authError.classList.remove('hidden');
      return;
    }
    authError.classList.add('hidden');
    setKey(val);
    authModal.classList.add('hidden');
    initSocket(val);
  });

  logoutBtn.addEventListener('click', () => {
    setKey('');
    if (socket) socket.disconnect();
    connStatus.className = 'status-dot offline';
    authModal.classList.remove('hidden');
    keyInput.value = '';
  });

  function initSocket(token) {
    if (socket) {
      socket.disconnect();
    }

    const nsp = window.location.pathname;
    socket = io(nsp, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
    });

    socket.on('connect', () => {
      connStatus.className = 'status-dot online';
      authError.classList.add('hidden');
      authModal.classList.add('hidden');
      if (selectedCode) {
        socket.emit('watchRoom', { code: selectedCode }, (res) => {
          if (res && res.ok) updateRoomState(res.state);
        });
      }
    });

    socket.on('connect_error', (err) => {
      connStatus.className = 'status-dot offline';
      authModal.classList.remove('hidden');
      authError.textContent = 'Connection failed / unauthorized. Please check DEV_KEY.';
      authError.classList.remove('hidden');
    });

    socket.on('disconnect', () => {
      connStatus.className = 'status-dot offline';
    });

    socket.on('rooms', (rooms) => {
      currentRooms = rooms || [];
      renderRoomPicker();
    });

    socket.on('roomState', (state) => {
      if (state && state.code === selectedCode) {
        updateRoomState(state);
      }
    });
  }

  function renderRoomPicker() {
    const prevVal = roomSelect.value;
    roomSelect.innerHTML = '<option value="">Select a live room...</option>';
    for (const r of currentRooms) {
      const opt = document.createElement('option');
      opt.value = r.code;
      const names = r.players.map((p) => p.name).join(', ') || 'empty';
      opt.textContent = `${r.code} (${r.status}, turn ${r.turnNumber}) — ${names}`;
      roomSelect.appendChild(opt);
    }
    if (selectedCode && currentRooms.some((r) => r.code === selectedCode)) {
      roomSelect.value = selectedCode;
    } else if (prevVal && currentRooms.some((r) => r.code === prevVal)) {
      roomSelect.value = prevVal;
    }
  }

  roomSelect.addEventListener('change', () => {
    const code = roomSelect.value;
    if (!code) {
      selectedCode = null;
      noRoomNotice.classList.remove('hidden');
      roomView.classList.add('hidden');
      return;
    }
    selectedCode = code;
    noRoomNotice.classList.add('hidden');
    roomView.classList.remove('hidden');
    if (socket) {
      socket.emit('watchRoom', { code }, (res) => {
        if (res && res.ok) {
          updateRoomState(res.state);
        }
      });
    }
  });

  refreshBtn.addEventListener('click', () => {
    if (socket) {
      socket.emit('getRooms', (res) => {
        if (res && res.ok) {
          currentRooms = res.rooms || [];
          renderRoomPicker();
        }
      });
      if (selectedCode) {
        socket.emit('watchRoom', { code: selectedCode }, (res) => {
          if (res && res.ok) updateRoomState(res.state);
        });
      }
      showToast('Refreshed');
    }
  });

  function updateRoomState(state) {
    currentRoomState = state;
    if (!state) return;

    sumCode.textContent = state.code;
    sumStatus.textContent = state.status;
    sumStatus.className = `badge ${state.status === 'playing' ? 'badge-info' : 'badge-subtle'}`;
    sumTurn.textContent = state.turnNumber;
    const curP = state.players.find((p) => p.id === state.currentPlayerId);
    sumCurrentPlayer.textContent = curP ? curP.name : 'None';
    sumPhase.textContent = state.phase || 'N/A';

    // Auction
    if (state.auction) {
      auctionCard.classList.remove('hidden');
      const tile = state.board.find((t) => t.id === state.auction.tileId);
      aucTile.textContent = tile ? tile.name : state.auction.tileId;
      aucBid.textContent = `₹${state.auction.highBid || 0}`;
      const bidder = state.players.find((p) => p.id === state.auction.highBidderId);
      aucBidder.textContent = bidder ? bidder.name : 'None';
      if (state.auction.endsAt) {
        const leftSec = Math.max(0, Math.round((state.auction.endsAt - Date.now()) / 1000));
        aucTime.textContent = `${leftSec}s`;
      } else {
        aucTime.textContent = 'Running';
      }
    } else {
      auctionCard.classList.add('hidden');
    }

    // Players
    if (!selectedPlayerId || !state.players.some((p) => p.id === selectedPlayerId)) {
      selectedPlayerId = state.currentPlayerId || (state.players[0] ? state.players[0].id : null);
    }

    renderPlayerTabs(state.players);
    renderPlayerDetails(state.players.find((p) => p.id === selectedPlayerId));
    renderDeckControls(state.cards);
    renderBoard(state.board, state.players);
  }

  function renderPlayerTabs(players) {
    playerTabs.innerHTML = '';
    for (const p of players) {
      const btn = document.createElement('button');
      btn.className = `tab-btn ${p.id === selectedPlayerId ? 'active' : ''}`;
      btn.textContent = `${p.name} (₹${p.cash})`;
      btn.style.borderLeft = `4px solid ${p.color || '#3b82f6'}`;
      btn.addEventListener('click', () => {
        selectedPlayerId = p.id;
        renderPlayerTabs(currentRoomState.players);
        renderPlayerDetails(currentRoomState.players.find((x) => x.id === p.id));
      });
      playerTabs.appendChild(btn);
    }
  }

  function renderPlayerDetails(p) {
    if (!p) return;

    pName.textContent = p.name;
    pCash.textContent = `₹${p.cash}`;
    const tile = currentRoomState && currentRoomState.board.find((t) => t.index === p.position);
    pPosition.textContent = tile ? `${p.position}: ${tile.name}` : `Pos ${p.position}`;
    pJail.classList.toggle('hidden', !p.inJail);

    // Queued Rolls
    const q = p.queuedRolls || [];
    if (q.length > 0) {
      queuedRollsBox.classList.remove('hidden');
      queueList.textContent = q.map((pair) => `[${pair[0]},${pair[1]}]`).join(' → ');
    } else {
      queuedRollsBox.classList.add('hidden');
    }

    // Policies
    const pols = p.policies || {};
    polButtons.forEach((btn) => {
      const polKey = btn.dataset.pol;
      if (pols[polKey]) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Avoid Player Select
    polAvoidPlayerSelect.innerHTML = '<option value="">Off (none)</option>';
    if (currentRoomState) {
      for (const other of currentRoomState.players) {
        if (other.id !== p.id) {
          const opt = document.createElement('option');
          opt.value = other.id;
          opt.textContent = other.name;
          if (pols.avoidPlayer === other.id) opt.selected = true;
          polAvoidPlayerSelect.appendChild(opt);
        }
      }
    }

    // Aim Tile Select
    polAimTileSelect.innerHTML = '<option value="">Off (none)</option>';
    if (currentRoomState) {
      for (const t of currentRoomState.board) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `${t.index}: ${t.name}`;
        if (pols.aimTile === t.id || String(pols.aimTile) === String(t.index)) opt.selected = true;
        polAimTileSelect.appendChild(opt);
      }
    }
  }

  // Quick Cash Handlers (1-tap)
  document.querySelectorAll('.cash-quick').forEach((btn) => {
    btn.addEventListener('click', () => {
      const amt = Number(btn.dataset.amount);
      if (!selectedCode || !selectedPlayerId || !amt) return;
      socket.emit('adjustCash', { code: selectedCode, playerId: selectedPlayerId, amount: amt }, (res) => {
        if (res && res.ok) showToast();
      });
    });
  });

  applyCashBtn.addEventListener('click', () => {
    const val = Number(customCashInput.value);
    if (!selectedCode || !selectedPlayerId || !val) return;
    socket.emit('adjustCash', { code: selectedCode, playerId: selectedPlayerId, amount: val }, (res) => {
      if (res && res.ok) {
        customCashInput.value = '';
        showToast();
      }
    });
  });

  // Dice Handlers
  setRollBtn.addEventListener('click', () => {
    const d1 = Number(die1Select.value);
    const d2 = Number(die2Select.value);
    if (!selectedCode || !selectedPlayerId) return;
    socket.emit('setRoll', { code: selectedCode, playerId: selectedPlayerId, dice: [d1, d2] }, (res) => {
      if (res && res.ok) showToast();
    });
  });

  queueRollBtn.addEventListener('click', () => {
    const d1 = Number(die1Select.value);
    const d2 = Number(die2Select.value);
    if (!selectedCode || !selectedPlayerId || !currentRoomState) return;
    const p = currentRoomState.players.find((x) => x.id === selectedPlayerId);
    const currentQ = p && p.queuedRolls ? [...p.queuedRolls] : [];
    currentQ.push([d1, d2]);
    socket.emit('queueRolls', { code: selectedCode, playerId: selectedPlayerId, rolls: currentQ }, (res) => {
      if (res && res.ok) showToast();
    });
  });

  // Policy Toggles (1-tap)
  polButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!selectedCode || !selectedPlayerId || !currentRoomState) return;
      const polKey = btn.dataset.pol;
      const p = currentRoomState.players.find((x) => x.id === selectedPlayerId);
      const curVal = p && p.policies && p.policies[polKey];
      const newVal = !curVal;
      socket.emit('setPolicy', { code: selectedCode, playerId: selectedPlayerId, policy: polKey, value: newVal }, (res) => {
        if (res && res.ok) showToast();
      });
    });
  });

  polAvoidPlayerSelect.addEventListener('change', () => {
    if (!selectedCode || !selectedPlayerId) return;
    const val = polAvoidPlayerSelect.value;
    socket.emit('setPolicy', { code: selectedCode, playerId: selectedPlayerId, policy: 'avoidPlayer', value: val || null }, (res) => {
      if (res && res.ok) showToast();
    });
  });

  polAimTileSelect.addEventListener('change', () => {
    if (!selectedCode || !selectedPlayerId) return;
    const val = polAimTileSelect.value;
    socket.emit('setPolicy', { code: selectedCode, playerId: selectedPlayerId, policy: 'aimTile', value: val || null }, (res) => {
      if (res && res.ok) showToast();
    });
  });

  clearControlsBtn.addEventListener('click', () => {
    if (!selectedCode || !selectedPlayerId) return;
    socket.emit('clearControls', { code: selectedCode, playerId: selectedPlayerId }, (res) => {
      if (res && res.ok) showToast('Controls Cleared');
    });
  });

  // Auction Handlers
  extendAuc10Btn.addEventListener('click', () => {
    if (!selectedCode) return;
    socket.emit('extendAuction', { code: selectedCode, seconds: 10 }, (res) => {
      if (res && res.ok) showToast();
    });
  });

  extendAuc30Btn.addEventListener('click', () => {
    if (!selectedCode) return;
    socket.emit('extendAuction', { code: selectedCode, seconds: 30 }, (res) => {
      if (res && res.ok) showToast();
    });
  });

  endAucBtn.addEventListener('click', () => {
    if (!selectedCode) return;
    socket.emit('endAuction', { code: selectedCode }, (res) => {
      if (res && res.ok) showToast();
    });
  });

  // Deck Controls Handlers
  function renderDeckControls(cards) {
    if (!cards) return;
    if (cards.surprise && cards.surprise[0]) {
      topSurpriseText.textContent = cards.surprise[0].text;
    }
    if (cards.treasure && cards.treasure[0]) {
      topTreasureText.textContent = cards.treasure[0].text;
    }

    if (cards.allSurprise && surpriseSelect.children.length === 0) {
      for (const c of cards.allSurprise) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `${c.id}: ${c.text.slice(0, 38)}...`;
        surpriseSelect.appendChild(opt);
      }
    }

    if (cards.allTreasure && treasureSelect.children.length === 0) {
      for (const c of cards.allTreasure) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `${c.id}: ${c.text.slice(0, 38)}...`;
        treasureSelect.appendChild(opt);
      }
    }
  }

  setSurpriseBtn.addEventListener('click', () => {
    const cardId = surpriseSelect.value;
    if (!selectedCode || !cardId) return;
    socket.emit('setNextCard', { code: selectedCode, deck: 'surprise', cardId }, (res) => {
      if (res && res.ok) showToast();
    });
  });

  setTreasureBtn.addEventListener('click', () => {
    const cardId = treasureSelect.value;
    if (!selectedCode || !cardId) return;
    socket.emit('setNextCard', { code: selectedCode, deck: 'treasure', cardId }, (res) => {
      if (res && res.ok) showToast();
    });
  });

  // Board List
  function renderBoard(board, players) {
    if (!board) return;
    boardList.innerHTML = '';
    for (const t of board) {
      const row = document.createElement('div');
      row.className = 'board-tile-row';

      const left = document.createElement('div');
      left.style.display = 'flex';
      left.style.alignItems = 'center';

      const idx = document.createElement('span');
      idx.className = 'tile-idx';
      idx.textContent = t.index;

      const name = document.createElement('span');
      name.className = 'tile-name';
      name.textContent = t.name;

      left.appendChild(idx);
      left.appendChild(name);

      const right = document.createElement('div');
      right.style.display = 'flex';
      right.style.alignItems = 'center';

      if (t.ownerId) {
        const owner = players.find((p) => p.id === t.ownerId);
        const obadge = document.createElement('span');
        obadge.className = 'tile-owner-badge';
        obadge.style.backgroundColor = owner ? owner.color : '#475569';
        obadge.style.color = '#fff';
        obadge.textContent = owner ? owner.name : 'Owned';
        right.appendChild(obadge);
      }

      if (t.buildings > 0) {
        const bbadge = document.createElement('span');
        bbadge.className = 'tile-build-badge';
        bbadge.textContent = t.buildings === 5 ? '🏨' : `🏠×${t.buildings}`;
        right.appendChild(bbadge);
      }

      if (t.mortgaged) {
        const mbadge = document.createElement('span');
        mbadge.className = 'badge badge-danger';
        mbadge.textContent = 'MORT';
        right.appendChild(mbadge);
      }

      row.appendChild(left);
      row.appendChild(right);
      boardList.appendChild(row);
    }
  }

  // Init
  checkAuth();
})();
