# Multiplayer Tag (2D Platformer)

Bright, sunny, realtime multiplayer 2D tag game. One player is "It" (the tagger) and can tag others on contact to pass the role. Slight speed boost for the tagger. Server authoritative physics + tagging, rooms via short codes.

## Features
- Create / join room with 6-char code
- Room leader (creator) explicit Start Game control (no auto start)
- Player list panel with dynamic badges (LEADER / TAGGER / YOU)
- Server authoritative physics loop @60Hz, snapshots default ~20Hz (configurable)
- Pre-game 3s countdown freeze showing randomly selected tagger
- 120s (configurable) match timer
- Tag transfer on proximity with per-pair cooldown (anti ping-pong spam)
- Advanced platformer physics:
	- Variable jump height (hold-to-sustain, short hop on release)
	- Coyote time & jump buffering for forgiving timing
	- Ceiling collision & solid platform edges (no pass-through)
	- Tuned jump arc (≈1.0s airtime, ~185u apex)
- Slight speed multiplier for tagger
- Client-side smoothing:
	- Interpolation buffer for remote players
	- Opt-in local prediction (horizontal & vertical) with soft reconciliation
	- Idle spawn stability (prediction activates only after first input)
- Bright, colorful UI (sky blue, greens, oranges) with overlay feedback

## Tech Stack
Frontend: HTML, CSS, JavaScript (Canvas)
Backend: Node.js, Express static server, Socket.IO realtime

## Run Locally

Install deps and start:
```bash
npm install
npm start
```
Open http://localhost:3000

Share the room code after creating for others to join.

## Controls
- Move: Arrow Keys or A / D
- Jump: Space / W / Up Arrow

## Configuration
Edit constants near top of `server.js`:
- Game flow: `GAME_DURATION_MS`, `PRE_GAME_COUNTDOWN_MS`
- Tag logic: `TAG_COOLDOWN_MS`, `TAGGER_SPEED_MULT`
- Physics core: `BASE_SPEED`, `JUMP_VELOCITY`, `GRAVITY`, `PLAYER_HEIGHT`
- Jump tuning: `JUMP_SUSTAIN_MS`, `JUMP_LOW_GRAVITY_FACTOR`, `JUMP_SHORT_HOP_FACTOR`, `COYOTE_MS`, `JUMP_BUFFER_MS`
- Networking cadence: `TICK_RATE` (simulation), snapshot interval (currently 50ms in `broadcastState` section; can tighten to 33ms for smoother remote motion)

Client-side interpolation delay & smoothing live in `public/client.js` (`INTERP_DELAY_MS`, thresholds for reconciliation). Reduce `INTERP_DELAY_MS` (e.g. 110 → 90) for snappier remote response if local network jitter is low.

To prevent initial flicker, local prediction only activates after first movement / jump input (`predictionActive`).

Platforms are defined in `PLATFORMS` (array of `{x,y,w,h}`) where `y` increases upward; ground at `y:0` with height representing thickness.

## Networking & Movement Model
- Server is authoritative: executes full physics + tagging and timestamps snapshots with `serverTime`.
- Client receives snapshots, interpolates remote players in the past (~110ms) to mask jitter.
- Local player prediction applies horizontal + advanced vertical physics; soft reconciliation only when error exceeds thresholds (X>6u, Y>12u) to avoid visible snapping.
- Initial idle period uses full authoritative position (no prediction) until player presses a movement or jump key (eliminates spawn flicker).

### Adjusting Smoothness
| Goal | Change |
|------|--------|
| Smoother remotes | Increase snapshot rate to 30–40Hz or reduce `INTERP_DELAY_MS` if packets stable |
| Lower bandwidth | Keep 20Hz but add velocity-based extrapolation (future enhancement) |
| Crisper local feel | Lower reconciliation thresholds slightly (e.g. X 4u, Y 8u) |
| More floaty jump | Lower `GRAVITY` or raise `JUMP_SUSTAIN_MS` |
| Tighter jump | Raise `GRAVITY` or reduce `JUMP_SUSTAIN_MS` / `JUMP_LOW_GRAVITY_FACTOR` |

## Troubleshooting
Issue | Cause | Fix
----- | ----- | ----
Idle spawn flicker | Prediction active before motion | Already mitigated (activate on first input)
Choppy remote players | Low snapshot rate | Increase snapshot frequency or lower interpolation delay
Rubberband on jump apex | Large correction threshold | Reduce vertical threshold (from 12 to 8) cautiously
Players clip platform edge | Platform overlap tolerance | Ensure `PLAYER_RADIUS` matches render radius (36/2)

## Development Tips
- Keep server/client physics constants in sync when adjusting movement.
- For debugging collisions, temporarily draw platform bounds and player AABB in the canvas.
- If adding new mechanics (e.g. dash), include velocity in state to keep prediction stable.

## Roadmap Ideas
- Camera & scrolling world
- Sprite animation & particle effects (jump dust, tag burst)
- Scoreboard (least cumulative tag time wins)
- Power-ups (speed pad, invuln bubble, double-jump pickup)
- Mobile touch / on‑screen controls
- Server delta compression & static data caching
- Lag compensated tag detection (historical rewind)
- Spectator mode & mid-round join as spectator
- Room inactivity auto-clean + TTL

## License
MIT
