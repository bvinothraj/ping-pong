# Developer Notes — High-level Technical Overview

This document describes how Ping Pong 3D is implemented at a technical level: the rendering layers, the game loop, physics, AI, audio, and the build pipeline. It is meant for new contributors who want to understand the architecture before diving into the source.

For functional and non-functional requirements, see [spec.md](spec.md).
For setup and play instructions, see [README.md](README.md).

---

## 1. Topology

```
┌──────────────────────────────────────────────────────┐
│  Browser tab                                         │
│  ┌────────────────────────────────────────────────┐  │
│  │ React tree (z-index 10)                        │  │
│  │   <App> → <GameCanvas> → <div className="hud"> │  │
│  │     • Scoreboard, mute btn, overlays           │  │
│  └────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────┐  │
│  │ Three.js <canvas> (z-index 1)                  │  │
│  │   • Floor / table / net / paddles / ball       │  │
│  │   • Lights + shadows                           │  │
│  │   • Rendered by Game.ts each rAF tick          │  │
│  └────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────┐  │
│  │ Web Audio graph (no DOM)                       │  │
│  │   AudioContext → master Gain → speakers        │  │
│  │   ephemeral Oscillators / BufferSources        │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

**No backend.** Everything runs in the browser; the production build is static files.

## 2. Rendering: HTML on top of Three.js

The Three.js renderer creates a `<canvas>` element and draws the 3D scene into it using WebGL. The React HUD (score, buttons, overlays) is plain HTML rendered as a sibling DOM element.

```
<div class="game-shell">      ← positioned container
  <div class="hud">           ← React HUD,  z-index: 10
  <canvas class="game-canvas">  ← Three.js, z-index:  1
</div>
```

Both children are `position: absolute; inset: 0`. The canvas paints the 3D world; the HUD paints UI chrome over it. Two important details:

- **`z-index`** decides who wins the painting order. Without it the canvas (appended later in `useEffect`) would render on top.
- **`pointer-events: none`** on the HUD lets clicks fall through to the canvas, which is what listens for `pointermove` / `pointerdown`. Interactive HUD elements (mute button, "Play again") opt back in with `pointer-events: auto`.

This pattern is standard for HTML5 games: do gameplay rendering in WebGL and UI in HTML/CSS, because each is far better at its own job.

## 3. Game loop and state ownership

Two parallel "loops" coexist:

1. **The render/physics loop** — driven by `requestAnimationFrame` inside `Game.ts`. Runs every frame (~60 Hz). Reads/writes per-frame mutable state directly on the `Game` instance (vectors for ball position/velocity, paddle positions, etc.). Never calls React.
2. **The React update loop** — driven by `setState` in the React HUD. Triggered only on **discrete events** (a point is scored, the state machine transitions, mute is toggled). The game calls `onChange(snapshot)` and React re-renders.

```ts
private notify() {
  this.onChange({
    player: this.playerScore,
    ai: this.aiScore,
    state: this.state,
    message: this.message,
    winner: this.winner,
    muted: this.sound.isMuted(),
  });
}
```

This split is essential: re-rendering React 60 times per second to move a paddle would torch performance. Mutable state stays in JS objects; React only sees the slow-changing summary.

## 4. 3D scene construction

[`src/game/Game.ts`](src/game/Game.ts) builds the scene once in the constructor:

| Object | Three.js primitive | Notes |
| --- | --- | --- |
| Floor | `PlaneGeometry` | Wood texture, receives shadows |
| Table body | `BoxGeometry` | Solid green, casts and receives shadows |
| Table top markings | `PlaneGeometry` + `CanvasTexture` | White border + center line painted in 2D |
| Table legs | 4× `BoxGeometry` | Decorative |
| Net mesh | `PlaneGeometry` + `CanvasTexture` (alpha) | Grid pattern |
| Net tape | `BoxGeometry` | White top stripe |
| Net posts | 2× `CylinderGeometry` | Side mounts |
| Ball | `SphereGeometry` | Emissive material so it glows faintly |
| Paddle (each) | `Group` of `CylinderGeometry` (head) + `TorusGeometry` (rim) + `BoxGeometry` (handle) | Tilted forward |
| Ball marker | `RingGeometry` | Floating just above table top, scales with ball altitude |

**Lighting:** an `AmbientLight` for fill, a shadow-casting `DirectionalLight` as the key, and a warm-toned rim `DirectionalLight` for separation. Shadow map is `PCFSoftShadowMap` at 2048².

**Materials:** mostly `MeshStandardMaterial` (PBR) with `roughness` / `metalness` tweaks per surface.

### Procedural textures

There are zero external image files. The wood floor, table top, and net mesh are all painted onto offscreen `<canvas>` elements at startup and wrapped in `THREE.CanvasTexture`:

```ts
function makeWoodTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  // draw plank stripes, grain bezier curves, edges...
  return new THREE.CanvasTexture(c);
}
```

This keeps the bundle small and avoids any asset pipeline.

## 5. Physics and collision detection

The "physics engine" is hand-rolled — about 80 lines. Each frame:

```
ball.prev = ball.pos
ball.vel.y += GRAVITY * dt
ball.pos += ball.vel * dt
check table bounce
check net collision
check player paddle hit
check AI paddle hit
check out-of-bounds
```

Three different collision techniques are used:

- **Table**: AABB-style — if `ball.y - radius < tableTopY` and the ball is over the table in `x` and `z`, reflect `vy` and damp horizontal speed.
- **Net**: plane crossing — when `prev.z` and `curr.z` straddle `z = 0` *and* the ball is below the net's top, treat it as a wall and bounce.
- **Paddle**: also plane crossing, on the paddle's `z` plane. If the ball crosses the plane *moving toward* it and the `(x,y)` distance to the paddle center is within `PADDLE_HIT_R`, register a hit.

Sign-change detection avoids the classic "tunneling" bug where a fast ball passes a thin collider between frames:

```ts
const prevSide = prevPos.z - paddle.z;
const currSide = currPos.z - paddle.z;
if (Math.sign(prevSide) !== Math.sign(currSide)) {
  // ball crossed the paddle plane this frame
}
```

`dt` is also clamped at ~33 ms to prevent giant jumps after a tab regains focus.

## 6. Mouse → 3D paddle (raycasting)

The player's mouse must move a paddle that lives at `z ≈ 13.8` in world space. Three.js solves this with a `Raycaster` + a virtual `Plane`:

```ts
const paddlePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -PLAYER_Z);
// on pointermove:
pointer.x = (clientX / width) * 2 - 1;   // NDC
pointer.y = -(clientY / height) * 2 + 1;
raycaster.setFromCamera(pointer, camera);
raycaster.ray.intersectPlane(paddlePlane, hoverPoint);
// hoverPoint is the world position where the cursor "hits" the paddle plane
```

Resulting `(x, y)` is clamped to a sane range and assigned to `playerPos`. The paddle group's position is then **snapped** (not lerped) to that target each frame — lerping was adding ~30 ms of input lag and causing missed swings.

## 7. AI opponent

The AI is a simple linear predictor:

```ts
const t = (AI_Z - ball.pos.z) / ball.vel.z;
const predictedX = ball.pos.x + ball.vel.x * t;
aiTargetX = clamp(predictedX + noise, -TABLE_W/2, TABLE_W/2);
```

It ignores bounces (which only damp `vx` slightly) and never solves the parabola — it just extrapolates linearly to the AI baseline. A bounded random `noise` term, refreshed every 0.25 s, means the AI doesn't aim perfectly. Difficulty knobs:

| Constant | Effect |
| --- | --- |
| `AI_BASE_SPEED` | Max paddle travel (units/s) |
| `AI_REACTION_NOISE` | Prediction error magnitude |

The AI's `y` lerps toward the ball's `y` so it tracks high lobs vs. low drives.

## 8. Audio: Web Audio synthesis

There are no `.wav` / `.mp3` files. Every sound is built at call time from oscillators and short noise buffers:

```ts
paddleHit() {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(460, t);
  osc.frequency.exponentialRampToValueAtTime(170, t + 0.06);  // pitch drop = "tock"
  gain.gain.setValueAtTime(0.45, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);    // fast decay
  osc.connect(gain).connect(masterGain);
  osc.start(t);
  osc.stop(t + 0.11);
}
```

Each sound is a small ADSR-shaped envelope on top of an oscillator (paddle / table / score / win) or a filtered noise burst (net thud). They're scheduled through a single master `GainNode` so the mute toggle is just `master.gain.value = 0`.

The `AudioContext` is created **lazily** on first interaction (browser autoplay policies suspend it until a user gesture), and `ctx.resume()` is called every time a sound plays in case the browser suspends it again.

## 9. Game state machine and rules

Four states: `idle | serving | playing | gameOver`. Transitions:

```
   ┌──────────┐  init  ┌──────────┐  click/AI auto  ┌──────────┐
   │  idle    ├───────▶│ serving  ├────────────────▶│ playing  │
   └──────────┘        └──────────┘                 └────┬─────┘
                            ▲                            │ point awarded
                            └────────────────────────────┘
                                                         │ score = 11
                                                         ▼
                                                   ┌──────────┐
                                                   │ gameOver │
                                                   └────┬─────┘
                                                        │ "Play again"
                                                        ▼
                                                    (restart)
```

### The bounce queue

The most interesting bit is how rules are enforced. Instead of a tangle of `if`s, there's a single `Side[]` queue of *expected next bounce sides*:

| Event | Queue becomes |
| --- | --- |
| Player serves | `["player", "ai"]` |
| AI serves | `["ai", "player"]` |
| Player rally hit | `["ai"]` |
| AI rally hit | `["player"]` |

Then on each table bounce:

```ts
if (queue.length > 0) {
  if (bounceSide !== queue[0]) {
    // wrong side → last hitter loses
    awardPoint(opponent);
  } else {
    queue.shift();   // legal bounce, pop expectation
  }
} else {
  // queue empty + another bounce = double bounce, receiver loses
  awardPoint(lastHitter);
}
```

And on each paddle attempt:

```ts
if (queue.length > 0 && queue[0] === side) {
  // next bounce was supposed to be on the hitter's side, so this is a volley
  awardPoint(opponent);
}
```

This single mechanism handles serve faults, short shots, volleys, and double bounces without any special-case code.

## 10. Build pipeline

| Stage | Tool |
| --- | --- |
| TypeScript checking | `tsc --build` |
| Dev server / HMR | Vite |
| Production bundle | Vite (Rollup under the hood) |
| Output | `dist/` — `index.html`, one JS bundle (~620 KB / 167 KB gzipped, mostly Three.js), one tiny CSS file |

The bundle is fully static. You can drop `dist/` on any web server, S3 bucket, or CDN — no Node runtime needed in production.

## TL;DR

The game is a thin React HUD + a Three.js scene + ~500 lines of hand-rolled physics and rules, all running in a single `requestAnimationFrame` loop. React only re-renders when something the player should *see in the HUD* changes; everything else is direct mesh manipulation. Audio is synthesized on the fly in the Web Audio graph. The whole thing is one static bundle with no backend, no network, and no asset files.
