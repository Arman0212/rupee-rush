# Monopoly socket protocol

Transport: Socket.io 4, default namespace. The server serves the client library at
`/socket.io/socket.io.js`. Payloads above 16 KB are dropped by the transport.

## Conventions

- **Every client→server event takes an ack callback**, which is called once with
  `{ ok: true, ...extra }` or `{ ok: false, error: string }`. Errors are short,
  human-readable sentences (e.g. `"not your turn"`). An ack is optional; without
  one, the event still runs.
- A missing payload counts as `{}`. Any payload that isn't a plain object, or has a
  field of the wrong type, is refused with an error naming the field. Unknown
  fields are dropped. Unknown events are ignored.
- **Tokens** are secret. They appear only in the ack to `createRoom` / `joinRoom`,
  sent to that one socket, and never in any broadcast. Clients keep them in
  `localStorage` under `rr:token:<CODE>`.
- A socket is bound to at most one room. Creating or joining another room
  releases the old seat as if the socket had disconnected.
- Ids: player ids are 16 hex characters; room codes are 6 characters from
  `ROOM.codeAlphabet` (no 0/O/1/I) and are case-insensitive when joining.

### Rate limits (per socket)

| Events | Limit | Error |
|---|---|---|
| `action` | 20 per second | `rate limited` |
| `createRoom`, `joinRoom` | 10 per 10 s | `rate limited` |
| `listRooms` | 5 per 5 s | `rate limited` |
| everything else | 30 per second | `rate limited` |
| `chat` (also per player) | 5 per 5 s | `slow down: at most 5 messages every 5 seconds` |

---

## Client → server

### `createRoom` `{ name }`
Creates a room; the caller becomes host. The name is cleaned (control characters
stripped, whitespace collapsed, max 16 characters) and de-duplicated.

```js
socket.emit('createRoom', { name: 'Asha' }, (res) => {});
// res: { ok: true, code: 'KAQBL7', playerId: '9f2c…', token: 'x3V…', reconnected: false }
```

### `joinRoom` `{ code, name?, token? }`
Joins a lobby, or, with a valid `token`, reclaims that seat at any time (even
mid-game). If another socket holds the seat, it receives `replaced`. When reclaiming
a seat, `name` is ignored.

```js
socket.emit('joinRoom', { code: 'kaqbl7', name: 'Bilal', token: localStorage['rr:token:KAQBL7'] }, cb);
// { ok: true, code: 'KAQBL7', playerId, token, reconnected: true }
// errors: 'room not found' | 'game already started' | 'room is full' | 'already in this room'
```

### `listRooms` `{}`
Public lobbies only (not private, not started).
```js
// { ok: true, rooms: [{ code: 'KAQBL7', hostName: 'Asha', players: 2, maxPlayers: 6 }] }
```

### `leaveRoom` `{}`
Gives up the seat. In the lobby the seat is freed. Mid-game this is bankruptcy to
the bank (`game.removePlayer`). If the host leaves, the next player becomes host.

### `pickColor` `{ color }` (lobby only)
`color` must be one of `room.colors` and not taken by another player.
Errors: `unknown colour`, `colour already taken`, `colours are fixed once the game starts`.

### `updateSettings` `{ settings }` (host only, lobby only)
A partial settings object, merged into the current settings and passed through
`sanitizeSettings` (unknown keys dropped, numbers clamped and stepped). Room-only
settings: `allowBots` (default `true`) and `botChat` (default `true`).
`maxPlayers` is never set below the number of seated players.

`settings.mode` is `'classic'` or `'chaos'`. When the partial includes `mode`,
the feature flags are set from it (`modeSettings`): Classic turns off world
events, bounties, landmarks and teams; Chaos turns them on with the chaos tuning
(world events every 2 rounds incl. chaos-only events, bounty threshold ₹300,
landmarks on, auctions 8 s, Vacation jackpot on, ₹2,000 start, 2 free cities each).
The engine reads the individual flags, not `mode`. In Chaos, teams follow the
player count (on with exactly 4 or 6 players, off otherwise).

### `setTeam` `{ playerId, team }` and `shuffleTeams` `{}` (host only, lobby, teams on)
Put a player on team `'A'`, `'B'` or neither (`null`), or deal everyone into two
even teams at random. Room event: `teamsChanged`.
```js
socket.emit('updateSettings', { settings: { startingCash: 2000, turnTimerSeconds: 60 } }, cb);
// { ok: true, settings: { ...all settings... } }
```

### `kick` `{ playerId }` (host only)
In the lobby: anyone except yourself. Mid-game: only a player who has been
disconnected for 60 s or more, which calls `game.removePlayer` (bankruptcy to the
bank). The kicked socket, if connected, receives `kicked`.

### `addBot` `{ difficulty? }` (host only, lobby only)
Seats a computer player. `difficulty` is `'easy'`, `'medium'` (the default) or
`'hard'`. The bot takes the next free colour and an unused name such as
`Bot Aria`, counts towards `maxPlayers`, is never host, has no socket or token, and
always shows as connected. Refused when `settings.allowBots` is off.
```js
socket.emit('addBot', { difficulty: 'hard' }, cb);
// { ok: true, playerId: '5be1…' }
// errors: 'only the host can do that', 'room is full', 'unknown difficulty',
//         'bots are turned off for this room', 'only possible while the room is in lobby'
```

### `removeBot` `{ playerId }` (host only, lobby only)
Frees a bot's seat (room event `seatLeft` with `reason: 'removed'`). Turning
`allowBots` off in `updateSettings` removes every bot in the lobby the same way.

### `replaceWithBot` `{ playerId, difficulty? }` (host only, mid-game)
A bot takes over the seat of a human who has disconnected (any time after the
disconnect, no 60 s wait): same id, name, colour, cash, cities and position. The
player's token stops working, so they can't reclaim the seat. Refused for connected
players, bots, bankrupt players, or when `allowBots` is off. Room event:
`seatReplacedByBot { playerId, difficulty }`.

### `startGame` `{}` (host only)
Needs 2+ players. Creates the engine game from the seats (ids, names, colours) and
the room settings; the engine shuffles turn order.

### `playAgain` `{}` (host only, after game over)
Everyone still seated returns to the lobby with the same settings.

### `action` `{ type, tileId?, amount?, tradeId?, toId?, give?, get? }`
Dispatched as `game.dispatch(yourPlayerId, action)`. The simplest correct client
sends back an entry of `you.legalActions` unchanged (with its own `amount` for bids
and its own offer for trades).

| type | fields | when |
|---|---|---|
| `roll`, `buy`, `decline`, `endTurn`, `payJailFine`, `useJailCard`, `bankrupt` | none | your turn (bankrupt: while in debt) |
| `build`, `sellHouse`, `mortgage`, `unmortgage` | `tileId` | your turn (sell/mortgage also while in debt) |
| `buildLandmark`, `sellLandmark` | `tileId` | landmarks mode; your turn (sell also while in debt) |
| `sendToTeammate` | `toId`, `give` | team mode; to a living teammate, not in an auction or while in debt |
| `bid` | `amount` | during an auction: ≥ high bid + ₹1, ≤ your cash, not while in debt |
| `pass` | none | during an auction, unless you hold the high bid |
| `proposeTrade` | `toId`, `give`, `get` | any time except auctions; not bankrupt or in debt; max 3 open |
| `acceptTrade`, `declineTrade` | `tradeId` | the player the trade was offered to |
| `counterTrade` | `tradeId`, optional `give`/`get` | the recipient; default is the mirror image |
| `cancelTrade` | `tradeId` | the proposer |

`give` and `get` are `{ tileIds?: string[], cash?: number, jailCards?: string[] }`
(jail cards by card id, e.g. `'s-jailfree'`). `give` is what the proposer hands over.
While an auction runs, only `bid` and `pass` are accepted. Closing an auction is
server-only (its timer); there is no client action for it.
```js
socket.emit('action', { type: 'build', tileId: 'patna' }, cb);
// { ok: true, version: 57 }   the version of the state broadcast this action caused
// { ok: false, error: 'build evenly across the set' }
socket.emit('action', { type: 'proposeTrade', toId: 'b41…', give: { cash: 90 }, get: { tileIds: ['nagpur'] } }, cb);
```

### `chat` `{ text, team? }`
Works in the lobby and in the game. Text is cleaned and cut to 200 characters;
empty messages are refused. **Clients must render it as text, never as HTML.**
With `team: true` in team mode, the message reaches only the sender and their
teammates and is not kept in the shared history (it carries a `team` field).

---

## Server → client

### `state`
Broadcast to the whole room after anything changes. `version` increases by exactly
one per broadcast; a socket never sees it go backwards.
```js
{
  version: 57,
  serverNow: 1760389990000,          // server clock; offset = serverNow - Date.now() for countdowns
  room: {
    code: 'KAQBL7',
    status: 'lobby' | 'playing' | 'finished',
    hostId: '9f2c…',
    settings: { startingCash: 1500, goSalary: 200, maxPlayers: 6, ... },
    colors: ['#e63946', ...],                       // the palette for pickColor
    players: [{ id, name, color, connected, disconnectedAt, isHost, bot }],  // bot: null | 'easy' | 'medium' | 'hard'
  },
  publicState: null | { phase, turnNumber, currentPlayerId, winnerId, players, properties,
                        jackpot, turn, decks: { surprise: { remaining }, treasure: { remaining } },
                        auction: null | { tileId, highBid, highBidderId, bidders, startedBy, endsAt },
                        trades: [{ id, fromId, toId, give, get, status: 'open', createdAt }],
                        stats: null | { worth, landings, biggestRent },   // only at game over
                        ... },
  events: [ { type: 'rentPaid', from, to, amount, tileId, at }, ... ],  // what just happened
  deadline: null | 1760390000000,   // ms timestamp when the turn timer fires
}
```
`publicState` is `Game.publicState()`: the deck order, seed and RNG state are never
included. `events` holds the engine events from this change plus the room events below.

### `you`
Sent privately to each seated socket right after every `state`.
```js
{ version: 57, playerId: '9f2c…', isHost: false, legalActions: [{ type: 'roll' }, { type: 'mortgage', tileId: 'goa' }] }
```

### `chat`
`{ id: 12, playerId, name, text, ts, bot?, team? }`. Bots occasionally post a short
line (`bot: true`) when they complete a colour set, go bankrupt or win, unless
`settings.botChat` is off. A `team` field marks a team-only message (team mode).

### `chatHistory`
`{ messages: [chat, ...] }` (the last 100), sent to a socket when it joins or reconnects.

### `gameOver`
`{ winnerId, name }`, broadcast once, right after the `state` that ends the game.
In team mode the engine's `gameOver` event also carries `winnerTeam`.

### `replaced`
`{ code }`. Another socket reclaimed this seat with the same token. The socket is
no longer in the room and should not auto-rejoin.

### `kicked`
`{ code }`. The host removed you. Forget the token.

### `roomClosed`
`{ code, reason }`. `reason` is `expired` (6 h limit), `idle`, or `server shutting down`.

---

## Room events (inside `state.events`)

| type | fields | when |
|---|---|---|
| `seatJoined` | `playerId, name, bot?` | someone joined the lobby (`bot` is the difficulty for a bot) |
| `seatLeft` | `playerId, reason: 'left' \| 'kicked' \| 'timeout' \| 'removed'` | a seat was freed (`removed`: a bot) |
| `seatReplacedByBot` | `playerId, difficulty` | a bot took over a disconnected player's seat |
| `teamsChanged` | | the host changed team assignments (team mode) |
| `seatDisconnected` | `playerId` | socket dropped; seat kept |
| `seatReconnected` | `playerId` | seat reclaimed with its token |
| `hostChanged` | `playerId` | host was away 60 s mid-game |
| `settingsChanged` | `settings` | host changed settings |
| `backToLobby` | | host chose play again |
| `turnTimedOut` | `playerId` | the server played the rest of this turn |

Engine events are listed at the top of `server/game/Game.js`. All money events carry
`{ from, to, amount }`, where `null` is the bank and `'jackpot'` is the Vacation pot.
Auction events: `auctionStarted { tileId, startedBy }`, `bidPlaced { playerId, tileId, amount }`,
`auctionPassed { playerId, tileId }`, `auctionClosed { tileId, winnerId, from?, to?, amount? }`.
Trade events: `tradeProposed { tradeId, fromId, toId, give, get }`, `tradeAccepted`,
`tradeDeclined { countered? }`, `tradeCancelled { reason }` (`'withdrawn'` when the
proposer cancels), plus the money events `tradePayment` and `mortgageFee` (10% of the
mortgage value, paid to the bank by whoever receives a mortgaged tile). Open trades
that stop being valid (a tile changed hands, a player went bankrupt, buildings went
up in a set, cash ran short) are cancelled automatically with a reason.

Game-mode events (only when the matching mode is on):
`worldEventStarted { eventId, anchorId }`, `worldEventEnded { eventId }`;
`bountyPlaced { playerId, value, triggers, reason }`,
`bountyClaimed { from: null, to, amount, holderId, tileId }` (the bank pays the owner);
`landmarkBuilt`/`landmarkSold { tileId, group, from, to, amount }`;
`teammateGift { from, to, amount }` (a fee-free send between teammates);
`rentReversed { from, to, amount, tileId }` (Rent Reversal: the owner pays the lander).
`publicState.world` carries `{ activeEvent, nextInRounds }` and `publicState.bounties`
carries `{ onPlayer, rivalry }` when those modes are on; players carry `team`.

## Timers

- **Auction timer**: `settings.auctionSeconds` (default 10), restarted by every valid
  bid and broadcast as `publicState.auction.endsAt`. When it fires the server closes
  the auction. Disconnected players are treated as having passed. The turn timer is
  paused while an auction runs and resumes afterwards with what was left (at least
  5 s). If a timed-out turn declined into an auction, the server finishes that turn
  as soon as the auction closes.

- **Turn timer** (`settings.turnTimerSeconds > 0`): one deadline per turn, broadcast as
  `state.deadline`. Acting within the turn does not reset it. When it fires, the server
  plays out the rest of the turn: `roll`, else `decline`, else `endTurn`. It never buys.
  A player in debt is first liquidated with legal actions only, one step at a time,
  stopping as soon as cash is back to ₹0 or more: (1) mortgage unbuilt tiles in sets
  with no buildings, cheapest first; (2) sell buildings evenly, cheapest set first;
  (3) mortgage tiles as their sets become bare. Only if that can't clear the debt is
  the player declared bankrupt.
- **Away timer**: a disconnected player keeps a lobby seat for 60 s. Mid-game the seat
  is kept; after 60 s the host may kick them, and a disconnected host hands hosting to
  the next connected player. If the timer setting is off and the current player is
  disconnected, their turn is auto-played after 60 s so the game never stalls.
- **Bot moves**: after every change the room arms one timer for the bots: 600–1500 ms
  (300–700 ms during an auction), so they feel like people thinking. Any newer change
  cancels it and arms a fresh one. When it fires, the first bot that wants to act
  (auction bidders and off-turn bots answering trades or raising cash, then the bot
  whose turn it is) makes one move, chosen from `publicState` and its legal actions
  only. Bots are never timed out, never auto-passed in auctions and never kicked for
  being away; while no human is connected they wait.
- Rooms are deleted after 30 minutes with no connected humans (bots don't count), or
  6 hours in total. A room whose last human leaves is deleted at once, bots and all.

## HTTP

- `GET /`: the client. `GET /r/:code`: the same page (invite link).
- `GET /health`: `{ ok: true, rooms, players }`, where `players` counts seats in all rooms.
