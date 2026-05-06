# Ping Pong 3D — Specification

This document captures the functional and non-functional requirements of the Ping Pong 3D web application. It is intended as a single reference for understanding what the application does today and as the baseline for adding new features in the future.

Each requirement is given a stable identifier (`FR-###` or `NFR-###`) so future changes can reference, modify, or supersede them.

---

## 1. Overview

Ping Pong 3D is a fully client-side, browser-based table tennis game. The user plays as a single human player against a computer-controlled opponent. The 3D scene is rendered with WebGL via Three.js. The UI shell is built with React and TypeScript. There is no backend; all state lives in the browser.

A match consists of a single game played to a configurable target score (default: 11 points). Standard ping pong service and rally rules are enforced.

## 2. Goals and Non-Goals

### Goals

- Recreate the look-and-feel of classic Flash-era 3D ping pong games using modern web technologies.
- Provide responsive, mouse-driven gameplay with believable physics.
- Offer a single-player experience with a beatable but challenging AI.
- Keep the codebase small and easy to extend (sound, scoring, AI, visuals).

### Non-Goals (current version)

- Multiplayer, online play, leaderboards, or persistence.
- Full simulation of professional-level spin physics.
- Mobile-first input or accessibility for users without a pointing device.
- Asset pipeline for external textures or audio.

## 3. Glossary

| Term | Meaning |
| --- | --- |
| **Player** | The human user, controlling the front-facing red paddle. |
| **AI / CPU** | The computer opponent, controlling the back-facing green paddle. |
| **Server** | The side currently performing a serve. |
| **Receiver** | The side returning the serve. |
| **Rally** | The exchange of shots after a legal serve. |
| **Bounce queue** | Internal list of expected bounce sides since the last paddle contact. Used to enforce service and rally rules. |
| **Side** | Either `player` (positive z half of the table) or `ai` (negative z half). |
| **Volley** | Hitting the ball before it has bounced on the hitter's side. Always a fault under the current rules. |

---

## 4. Functional Requirements

### 4.1 Game initialization

- **FR-001** On page load, the application initializes a Three.js scene, lighting, the table, net, both paddles, the ball, and the HUD.
- **FR-002** The application starts in the **idle / serving** state with the player as the initial server and a "Click to serve" prompt visible.
- **FR-003** The game loop runs via `requestAnimationFrame`, computing per-frame physics and rendering a single WebGL frame.
- **FR-004** Scores are initialized to `0 – 0` and the bounce queue is empty.

### 4.2 Visual scene

- **FR-010** A wood-plank floor surrounds the table. The texture is procedurally generated on a `<canvas>` and tiled.
- **FR-011** The table is a green box with a white painted border, a white center line, and four dark legs at the corners.
- **FR-012** A net spans the table at the midline, including a translucent grid mesh, a white top tape, and two side posts.
- **FR-013** The player's paddle is a red disc with a white edge ring and a brown handle wrapped with a gold band, positioned near the front edge of the table and tilted slightly forward.
- **FR-014** The AI's paddle is identical in shape but colored green and positioned at the back edge of the table.
- **FR-015** The ball is a light-blue, slightly emissive sphere that casts a shadow on the table.
- **FR-016** A faint ring marker is rendered on the table directly under the ball; it scales up and fades as the ball rises in altitude, helping the player read the ball's `x` lane.
- **FR-017** The scene is lit by an ambient light, a directional key light that casts shadows, and a warm-toned rim light.
- **FR-018** A camera is positioned behind the player's side, angled down at the table, with a perspective FOV of 42°.

### 4.3 Player input and paddle control

- **FR-020** The player's paddle position is controlled by the mouse. The cursor is mapped via raycasting to a virtual plane at the player's baseline; the resulting world coordinates set the paddle's `x` and `y` (the `z` is fixed).
- **FR-021** Paddle `x` is clamped so the disc cannot move more than a small margin past the side edges of the table.
- **FR-022** Paddle `y` is clamped between just above the table top and a fixed maximum height.
- **FR-023** The player paddle snaps directly to the cursor target each frame (no smoothing) to ensure interception is reliable on fast rallies.
- **FR-024** Clicking (`pointerdown`) while the game is in the **idle / serving** state initiates the player's serve.
- **FR-025** Clicking while the game is in the **gameOver** state restarts the match.

### 4.4 AI opponent

- **FR-030** When the ball is moving toward the AI's side, the AI predicts the ball's `x` position at its baseline using linear extrapolation of the current ball velocity.
- **FR-031** A bounded random noise term is added to the predicted `x` and refreshed periodically, so the AI is not pixel-perfect and can be beaten.
- **FR-032** The AI paddle moves toward the predicted `x` at a configurable maximum speed.
- **FR-033** The AI paddle's `y` tracks the ball's `y` (clamped to a sane range) while the ball is approaching, and lerps toward a neutral resting height between rallies.
- **FR-034** Between rallies (when no shot is incoming) the AI's `x` target drifts back toward the center of the table.
- **FR-035** When it is the AI's turn to serve, the AI auto-serves after a brief fixed delay (~900 ms).

### 4.5 Ball physics and collisions

- **FR-040** Gravity is applied to the ball each frame (`vy += GRAVITY * dt`) before position integration.
- **FR-041** **Table bounces**: when the ball descends below the table top while within the table's `x` and `z` bounds, it bounces with a coefficient of restitution; horizontal velocity is slightly damped.
- **FR-042** **Net collisions**: when the ball crosses the `z = 0` plane below the net's top height and within the net's width, it bounces back with reduced energy and is given a small upward push to prevent it sticking.
- **FR-043** **Paddle collisions**: detected by sign change of the ball's `z` relative to the paddle's `z` plane while the ball moves toward the paddle. A hit registers when the ball's `(x, y)` distance from the paddle center is within the configured hit radius.
- **FR-044** On a paddle hit, the ball's `z` velocity is reflected with a configurable forward floor (`fwdSpeed`) so the return reliably clears the net and lands on the opponent's side.
- **FR-045** Off-center hits impart "english" (lateral velocity proportional to the offset between the ball and the paddle center).
- **FR-046** Dead-center hits give a small overall speed boost.
- **FR-047** Total ball speed is capped to a maximum value to keep collision detection stable.

### 4.6 Service and rally rules

- **FR-050** A **bounce queue** records the sides where the ball is expected to bounce next.
  - On serve: queue = `[server_side, receiver_side]`.
  - On a rally hit: queue = `[opponent_side]`.
- **FR-051** Each table bounce consumes the head of the queue if the bounce side matches; if it does not, the last hitter loses the point (**wrong-side fault**).
- **FR-052** If a paddle attempts to hit while the head of the queue still expects a bounce on its own side, the hitter loses the point (**volley fault**).
- **FR-053** A second consecutive bounce after the queue has been emptied awards the point to the previous hitter (**double-bounce fault**, i.e., the receiver failed to return).
- **FR-054** When the ball passes either baseline (`z` outside the table by a margin):
  - If the queue is non-empty, the last hitter loses (their shot did not complete its required bounces).
  - If the queue is empty, the player on that side loses (failed to return a legal shot).
- **FR-055** When the ball falls off the side of the table (`y` drops below a threshold while not over the table):
  - If the queue is non-empty, the last hitter loses.
  - Otherwise, the receiver loses.

### 4.7 Match flow and scoring

- **FR-060** A point is awarded by `awardPoint(side)`, which:
  1. Increments the scoring side's score.
  2. Plays the appropriate score sound effect.
  3. Resets state for the next serve, with the **scoring side** serving next.
- **FR-061** The first side to reach `WIN_SCORE` (default `11`) wins the match.
- **FR-062** On match end, the game enters the **gameOver** state, plays a win or loss fanfare, and displays a game-over overlay with the final score and a "Play again" button.
- **FR-063** The "Play again" button resets all state and returns the game to the **idle / serving** state with the player serving.

### 4.8 HUD and UI

- **FR-070** A scoreboard is displayed at the top center of the screen showing the player's score (red), the CPU's score (green), and a "First to 11 WINS" divider label.
- **FR-071** When either side scores, the corresponding score box briefly scales up and pulses with a white background flash.
- **FR-072** A Sound on / off toggle button is displayed in the top-right corner.
- **FR-073** During the **idle / serving** state, a center prompt displays `"Click to serve"` plus a hint line (`"Move with mouse · click to serve"`).
- **FR-074** During the **gameOver** state, an overlay is displayed with `"You win!"` or `"AI wins"`, the final score, and a `Play again` button.
- **FR-075** The HUD uses pointer-events pass-through except on interactive controls, so the HUD never blocks gameplay input.

### 4.9 Audio

- **FR-080** All sound effects are synthesized at runtime via the Web Audio API; no audio files are bundled.
- **FR-081** Distinct sound effects are produced for: paddle hit, table bounce, net hit, score (per side), and match win (per side).
- **FR-082** Paddle and table bounce sounds scale in volume / pitch with the impact intensity.
- **FR-083** A user-controllable mute toggle silences all sounds. Mute state is reflected in the HUD button's label.
- **FR-084** The audio context is created lazily on first user interaction and resumed if suspended (browser autoplay-policy compliant).

### 4.10 Game states

- **FR-090** The game has four states: `idle`, `serving`, `playing`, `gameOver`.
- **FR-091** State transitions:
  - `idle` → `serving` on initialization (`resetForServe`).
  - `serving` → `playing` when the server initiates the serve (player click or AI auto-serve).
  - `playing` → `serving` on a point being awarded (and the score has not reached the win threshold).
  - `playing` → `gameOver` when one side reaches the win threshold.
  - `gameOver` → `serving` on `restart()` (player click on overlay).
- **FR-092** Each state change triggers a `notify()` call that publishes a `ScoreSnapshot` to React for re-rendering the HUD.

---

## 5. Non-Functional Requirements

### 5.1 Performance

- **NFR-001** The application targets a steady 60 frames per second on a modern desktop browser at 1080p with default settings.
- **NFR-002** Per-frame work is bounded by physics updates for one ball plus two paddles plus a single Three.js render call.
- **NFR-003** The renderer's pixel ratio is capped at 2 to avoid excessive GPU load on high-DPI displays.
- **NFR-004** `dt` is clamped to a maximum of ~33 ms per frame to prevent tunneling through colliders after tab-switch pauses.

### 5.2 Browser compatibility

- **NFR-010** The application targets evergreen desktop browsers with WebGL 1.0+ support (Chrome, Firefox, Safari, Edge — current and previous major versions).
- **NFR-011** The application gracefully handles browsers that suspend the AudioContext until a user gesture.
- **NFR-012** No browser polyfills are bundled; the build assumes ES2020 baseline.

### 5.3 Architecture

- **NFR-020** UI shell and game engine are separated:
  - `Game.ts` owns the Three.js scene, physics, AI, and game-state machine.
  - `GameCanvas.tsx` is a thin React wrapper that mounts the game and renders the HUD.
- **NFR-021** Per-frame mutable state is held in instance fields and refs, not in React state, to avoid unnecessary re-renders.
- **NFR-022** React state updates are driven by a single `onChange(snapshot)` callback emitted only on meaningful state transitions (score, state, mute, etc.).
- **NFR-023** Sound generation is encapsulated in a single `SoundManager` class with no external dependencies.

### 5.4 Code quality

- **NFR-030** The project compiles under TypeScript `strict` mode with `noUnusedLocals` and `noUnusedParameters` enabled.
- **NFR-031** Magic numbers controlling physics, gameplay, and AI are defined as named constants at the top of `Game.ts`.
- **NFR-032** A `DEBUG` flag in `Game.ts` toggles verbose `console.log` instrumentation for hits, misses, bounces, faults, and out-of-bounds events.

### 5.5 Build and deployment

- **NFR-040** The project uses Vite for development and production builds.
- **NFR-041** `npm run dev` starts a hot-module-reload dev server on port 5173.
- **NFR-042** `npm run build` runs `tsc -b` followed by `vite build`, producing a static `dist/` directory containing `index.html`, JS, and CSS bundles.
- **NFR-043** The production output is fully static and can be hosted on any static file server or CDN.
- **NFR-044** No backend, database, or external service is required at runtime.

### 5.6 Responsiveness

- **NFR-050** The renderer reacts to window resize events: canvas size and camera aspect ratio are updated together.
- **NFR-051** The HUD uses viewport units and flex layout so it remains positioned correctly across resolutions.

### 5.7 Accessibility

- **NFR-060** The mute button exposes an `aria-label` and `title` reflecting the current mute state.
- **NFR-061** Visual feedback (score flash, color-coded scores, on-screen messages) reinforces audio cues for users who play with sound off.
- **NFR-062** The application does not currently support keyboard or touch input; this is a known limitation (see §6).

### 5.8 Extensibility and tunability

- **NFR-070** Difficulty can be adjusted by tweaking `AI_BASE_SPEED`, `AI_REACTION_NOISE`, and rally `fwdSpeed` constants without touching gameplay logic.
- **NFR-071** Visual appearance is controlled by procedural texture functions (`makeWoodTexture`, `makeTableTopTexture`, `makeNetTexture`) and material colors at the call sites; replacing them does not require changes to the physics.
- **NFR-072** Rules are enforced by a single `bounceQueue` mechanism, so additional rule variants (e.g., expedite system, doubles) can be expressed by altering how the queue is populated.
- **NFR-073** Sound effects are generated programmatically; new effects can be added by extending `SoundManager` without changing asset pipelines.

---

## 6. Constraints and Known Limitations

- **L-001** Single-player only. No multiplayer or online play.
- **L-002** No spin physics beyond simple lateral english from off-center hits; the ball does not curve in flight.
- **L-003** No mobile or touch tuning. Pointer events technically work but the camera, HUD, and hit zones are sized for a desktop mouse.
- **L-004** No persistence — closing the tab loses match state.
- **L-005** No internationalization; all UI text is in English.
- **L-006** AI does not adapt over the course of a match; difficulty is constant.

## 7. Out of Scope (current version)

- Online or local multiplayer
- Match formats beyond first-to-N (e.g., best of 7 games)
- Player profiles, accounts, or stats history
- Tournament or bracket modes
- Replays or shot-by-shot analysis
- Custom paddle skins, tables, or environments
- Server-side anti-cheat or telemetry

## 8. Future Enhancements (candidate backlog)

The following are not implemented today but the architecture is intended to support them:

- **F-001** Difficulty selection in the HUD (Easy / Medium / Hard) wired to `AI_BASE_SPEED` and `AI_REACTION_NOISE`.
- **F-002** Local two-player mode (split keyboard / two pointers).
- **F-003** Online multiplayer via an Express + WebSocket server.
- **F-004** Persistent best-of-N match scoring with a "next game" transition.
- **F-005** Touch / mobile input scheme with on-screen swipe area for paddle movement.
- **F-006** Customizable paddle skins (texture map on the disc face).
- **F-007** Spin physics: track angular velocity on the ball and curve flight accordingly.
- **F-008** Match replay recording (serialize ball/paddle positions per frame, play back on demand).
- **F-009** Pause menu with resume / restart / quit options.
- **F-010** Localization (i18n) of HUD text.
- **F-011** Color-blind-friendly palette option for paddle colors.
- **F-012** Optional in-rally hint UI showing predicted bounce position.

## 9. Acceptance Criteria

The current implementation is considered complete with respect to this specification when:

- **AC-001** A player can serve, rally, score points, and finish a match to 11 without errors.
- **AC-002** All four faults (wrong-side bounce, volley, double bounce, out of bounds) are detected and produce correct point awards under the rules in §4.6.
- **AC-003** Scores update visibly in the HUD, including the flash animation, and persist until match end.
- **AC-004** The mute button silences and re-enables all audio without affecting gameplay.
- **AC-005** Resizing the browser window keeps the scene and HUD correctly positioned.
- **AC-006** `npm run build` completes with no TypeScript errors and produces a runnable static bundle.
- **AC-007** With `DEBUG = true`, every bounce, hit, miss, fault, and out-of-bounds event is logged with sufficient detail to diagnose mis-scoring.

---

## Appendix A — File responsibilities

| File | Responsibility |
| --- | --- |
| `src/main.tsx` | React entry point; mounts `<App />` into `#root`. |
| `src/App.tsx` | Top-level shell; renders `<GameCanvas />`. |
| `src/App.css` | Global styles, HUD layout, scoreboard styling, score-flash animation. |
| `src/components/GameCanvas.tsx` | React host: mounts a `Game` instance, subscribes to its snapshots, renders the HUD. |
| `src/game/Game.ts` | Three.js scene, render loop, ball physics, paddle hit detection, bounce-side rules, AI controller, scoring, state machine. |
| `src/game/Sound.ts` | Web Audio sound manager; generates and plays paddle / bounce / net / score / win effects. |
| `index.html` | HTML entry point; mounts the Vite-bundled JS. |

## Appendix B — Configuration constants

The following constants in `src/game/Game.ts` collectively define almost all tunable behavior:

| Constant | Purpose |
| --- | --- |
| `TABLE_W`, `TABLE_L`, `TABLE_TOP_Y` | Table dimensions in world units |
| `NET_H`, `NET_OVERHANG`, `NET_THICKNESS` | Net geometry |
| `BALL_R` | Ball radius |
| `PADDLE_R`, `PADDLE_HIT_R` | Paddle visual radius and hit-zone radius |
| `PLAYER_Z`, `AI_Z` | Paddle baseline `z` positions |
| `GRAVITY` | World gravity for the ball |
| `TABLE_RESTITUTION`, `NET_RESTITUTION`, `PADDLE_RESTITUTION` | Energy retained on each kind of collision |
| `WIN_SCORE` | Match target score |
| `AI_BASE_SPEED` | AI paddle max travel speed |
| `AI_REACTION_NOISE` | AI prediction error magnitude |
| `DEBUG` | Verbose console logging toggle |
