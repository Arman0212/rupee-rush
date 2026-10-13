# Rupee Rush

An original multiplayer property-trading board game set in Indian cities.
Node.js, Express, Socket.io and plain HTML/CSS/JS.

## Running

```sh
npm install
npm start          # http://localhost:3000 (PORT from the environment)
npm run dev        # restarts on file changes
```

Open the page, create a room, and share the invite link `/r/CODE`. The client in
`public/` is a temporary debug client for testing the protocol; the real UI comes
in Phase 4.

## Checks

```sh
npm run validate   # board, cards and rules data
npm test           # engine and room unit tests (node:test)
npm run simulate   # random-bot games with invariant checks; -- --games 200 for a quick run
npm run smoke      # real server + 4 socket.io clients, end to end
```

## Layout

| Path | What |
|---|---|
| `shared/` | board, cards and rules data, shared with clients |
| `server/game/` | the pure game engine (no I/O), authoritative for every rule |
| `server/rooms/` | rooms, lobby, seats and tokens, reconnection, turn timers |
| `server/net/` | Socket.io handlers, payload validation, rate limits |
| `docs/protocol.md` | every socket event and payload |

## Deployment notes

- **Room state lives in memory only.** A restart or redeploy on Render, Railway or
  similar ends every running game and invalidates every invite link and token.
  It also means a single instance: don't scale horizontally without adding shared
  state and a Socket.io adapter.
- The server shuts down gracefully on `SIGTERM`: rooms are closed (clients get
  `roomClosed`) and sockets are disconnected before exit.
- `GET /health` returns `{ ok, rooms, players }` for health checks.
