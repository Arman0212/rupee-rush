# Monopoly

A multiplayer property-trading board game for friends.
Node.js, Express, Socket.io and plain HTML/CSS/JS.

## Running

```sh
npm install
npm start          # http://localhost:3000 (PORT from the environment)
npm run dev        # restarts on file changes
```

Open the page, create a room, and share the invite link `/r/CODE`. The client is
plain HTML, CSS and ES modules in `public/`, with no build step. The bare protocol
test client from Phase 3 still lives at `/debug.html`.

## Checks

```sh
npm run validate   # board, cards and rules data
npm test           # engine and room unit tests (node:test)
npm run simulate   # random-bot games with invariant checks; -- --games 200 for a quick run
npm run smoke      # real server + 4 socket.io clients, end to end
npm run ui-check   # headless Chromium (playwright): 3 pages play ~30 turns through
                   # the real UI; screenshots in screenshots/, fails on console errors
                   # (first run: npx playwright install chromium)
npm run images     # re-render public/og-image.png and the PNG icons
```

## Layout

| Path | What |
|---|---|
| `shared/` | board, cards and rules data: UMD, `require`d by Node and served at `/shared` as `window.RR` |
| `public/` | the client: `js/net.js` (socket), `js/store.js` (state), `js/screens/`, `js/board/`, `js/ui/`, `css/` |
| `server/game/` | the pure game engine (no I/O), authoritative for every rule; `trades.js` validates offers |
| `server/rooms/` | rooms, lobby, seats and tokens, reconnection, turn timers |
| `server/net/` | Socket.io handlers, payload validation, rate limits |
| `docs/protocol.md` | every socket event and payload |

## Deploying

The server is a single Node process holding all rooms in memory. Any host that runs
`npm start` and passes `PORT` works. Production installs skip dev dependencies
(Playwright and socket.io-client), so the build stays small.

### Environment variables

| Variable | Default | What |
|---|---|---|
| `PORT` | `3000` | Port to listen on. Render and Railway set it for you. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug`. |
| `NODE_ENV` | | Set to `production` to cache the rendered `index.html`. |

### Render

1. Push the repo to GitHub (or GitLab).
2. In the Render dashboard choose **New → Blueprint** and pick the repo. Render reads
   `render.yaml`: a Node web service, build `npm ci --omit=dev`, start `npm start`,
   health check `/health`, Node 22.
3. Click **Apply**. The first deploy takes a minute or two; your game is at
   `https://<service-name>.onrender.com`.

Without the blueprint: **New → Web Service**, connect the repo, runtime *Node*,
build command `npm ci --omit=dev`, start command `npm start`, and under *Advanced*
set the health check path to `/health`.

### Railway

1. **New Project → Deploy from GitHub repo** and pick the repo.
2. Railway detects Node and runs `npm ci` and `npm start`. To skip dev dependencies,
   set the build command to `npm ci --omit=dev` in *Settings → Build*.
3. In *Settings → Deploy*, set the health check path to `/health`.
4. In *Settings → Networking*, click **Generate Domain** to get a public URL.
5. Optionally add `LOG_LEVEL` under *Variables*.

### Things to know

- **Room state lives in memory only.** Any restart or redeploy ends every running
  game and invalidates every invite link and token. Players see "the server
  restarted" and go back home.
- **Free tiers sleep.** Render's free web services spin down after about 15 minutes
  without traffic and take 30-60 seconds to wake on the next visit; a sleeping
  server has also lost its rooms. Railway's trial and hobby plans have usage limits
  and may restart services. For a game night, open the site a minute early.
- **One instance only.** Don't scale horizontally without adding shared state and
  a Socket.io adapter, or players in the same room will land on different servers.
- WebSockets are used where possible, with long-polling as a fallback; both work
  behind Render's and Railway's proxies (`trust proxy` is on).
- The server shuts down gracefully on `SIGTERM`: rooms are closed (clients get
  `roomClosed`) and sockets are disconnected before exit.
- `GET /health` returns `{ ok, rooms, players }`.
