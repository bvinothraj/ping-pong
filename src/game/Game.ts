import * as THREE from "three";
import { SoundManager } from "./Sound";

// --- Dimensions (loosely based on real ping-pong proportions) ---
const TABLE_W = 16;
const TABLE_L = 30;
const TABLE_TOP_Y = 8;
const TABLE_THICKNESS = 0.4;
const NET_H = 1.5;
const NET_THICKNESS = 0.08;
const NET_OVERHANG = 0.6;

const BALL_R = 0.28;
const PADDLE_R = 1.9;
const PADDLE_HIT_R = 3.0; // slightly larger than visual disc for forgiveness
const PADDLE_T = 0.22;
const DEBUG = false;
const PADDLE_HANDLE_W = 0.5;
const PADDLE_HANDLE_H = 1.4;
const PADDLE_HANDLE_T = 0.35;

const PLAYER_Z = TABLE_L / 2 - 1.2;
const AI_Z = -TABLE_L / 2 + 1.2;

// --- Physics ---
const GRAVITY = -28;
const TABLE_RESTITUTION = 0.86;
const NET_RESTITUTION = 0.35;
const PADDLE_RESTITUTION = 0.97;

// --- Gameplay ---
const WIN_SCORE = 11;
const AI_BASE_SPEED = 14;
const AI_REACTION_NOISE = 0.6;

export type GameState = "idle" | "serving" | "playing" | "gameOver";

export interface ScoreSnapshot {
  player: number;
  ai: number;
  state: GameState;
  message: string;
  winner: "player" | "ai" | null;
  muted: boolean;
}

type Side = "player" | "ai";

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private rafId = 0;

  private ball!: THREE.Mesh;
  private ballMarker!: THREE.Mesh;
  private playerPaddle!: THREE.Group;
  private aiPaddle!: THREE.Group;

  private ballVel = new THREE.Vector3();
  private ballPos = new THREE.Vector3();
  private prevBallPos = new THREE.Vector3();

  private playerPos = new THREE.Vector3(0, TABLE_TOP_Y + 2, PLAYER_Z);
  private aiPos = new THREE.Vector3(0, TABLE_TOP_Y + 2, AI_Z);
  private aiTargetX = 0;
  private aiNoiseTimer = 0;
  private aiNoiseOffset = 0;

  private state: GameState = "idle";
  private playerScore = 0;
  private aiScore = 0;
  private message = "Click to serve";
  private winner: Side | null = null;
  private lastHitter: Side | null = null;
  private servingSide: Side = "player";

  // Expected sequence of bounce sides since last paddle contact / serve.
  // - Serve: ["server_side", "receiver_side"] (must bounce on own side first, then opponent)
  // - Rally: ["opponent_side"] (must bounce on opponent's side after a hit)
  // Empty = ball is "in play"; opponent should hit before any further bounce.
  private bounceQueue: Side[] = [];
  // True between serve() and the serve's second table bounce — used to enforce
  // the diagonal-serve rule (first/second bounce must be on opposite x-halves).
  private inServe = false;
  private serveFirstBounceX = 0;
  private sound = new SoundManager();

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private paddlePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -PLAYER_Z);
  private hoverPoint = new THREE.Vector3();

  private container: HTMLElement;
  private onChange: (snapshot: ScoreSnapshot) => void;

  constructor(container: HTMLElement, onChange: (s: ScoreSnapshot) => void) {
    this.container = container;
    this.onChange = onChange;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add("game-canvas");

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x2b1a0c);
    this.scene.fog = new THREE.Fog(0x2b1a0c, 50, 120);

    this.camera = new THREE.PerspectiveCamera(
      42,
      container.clientWidth / container.clientHeight,
      0.1,
      200
    );
    this.camera.position.set(0, 14, 23);
    this.camera.lookAt(0, TABLE_TOP_Y, -2);

    this.buildLights();
    this.buildFloor();
    this.buildTable();
    this.buildNet();
    this.buildPaddles();
    this.buildBall();

    this.resetForServe("player");

    window.addEventListener("resize", this.handleResize);
    container.addEventListener("pointermove", this.handlePointerMove);
    container.addEventListener("pointerdown", this.handlePointerDown);

    this.notify();
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.handleResize);
    this.container.removeEventListener("pointermove", this.handlePointerMove);
    this.container.removeEventListener("pointerdown", this.handlePointerDown);
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mat = obj.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    });
  }

  restart = () => {
    this.playerScore = 0;
    this.aiScore = 0;
    this.winner = null;
    this.lastHitter = null;
    this.bounceQueue = [];
    this.inServe = false;
    this.servingSide = "player";
    this.state = "idle";
    this.message = "Click to serve";
    this.resetForServe("player");
    this.notify();
  };

  toggleMute = () => {
    this.sound.setMuted(!this.sound.isMuted());
    this.notify();
  };

  // --- Build helpers ---

  private buildLights() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(ambient);

    const dir = new THREE.DirectionalLight(0xffffff, 0.95);
    dir.position.set(8, 24, 12);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -20;
    dir.shadow.camera.right = 20;
    dir.shadow.camera.top = 20;
    dir.shadow.camera.bottom = -20;
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 60;
    dir.shadow.bias = -0.0005;
    this.scene.add(dir);

    const rim = new THREE.DirectionalLight(0xffe2b8, 0.25);
    rim.position.set(-12, 8, -10);
    this.scene.add(rim);
  }

  private buildFloor() {
    const tex = makeWoodTexture();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 4);
    const geo = new THREE.PlaneGeometry(140, 140);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.85,
      metalness: 0.05,
    });
    const floor = new THREE.Mesh(geo, mat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  private buildTable() {
    // Body
    const bodyGeo = new THREE.BoxGeometry(TABLE_W, TABLE_TOP_Y, TABLE_L);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x0a6b35,
      roughness: 0.6,
      metalness: 0.05,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = TABLE_TOP_Y / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    this.scene.add(body);

    // Top with painted lines
    const topTex = makeTableTopTexture();
    const topGeo = new THREE.PlaneGeometry(TABLE_W, TABLE_L);
    const topMat = new THREE.MeshStandardMaterial({
      map: topTex,
      roughness: 0.45,
      metalness: 0.05,
    });
    const top = new THREE.Mesh(topGeo, topMat);
    top.rotation.x = -Math.PI / 2;
    top.position.y = TABLE_TOP_Y + 0.005;
    top.receiveShadow = true;
    this.scene.add(top);

    // Legs (decorative)
    const legGeo = new THREE.BoxGeometry(0.6, TABLE_TOP_Y, 0.6);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
    const legPositions: [number, number][] = [
      [-TABLE_W / 2 + 0.6, -TABLE_L / 2 + 0.6],
      [TABLE_W / 2 - 0.6, -TABLE_L / 2 + 0.6],
      [-TABLE_W / 2 + 0.6, TABLE_L / 2 - 0.6],
      [TABLE_W / 2 - 0.6, TABLE_L / 2 - 0.6],
    ];
    for (const [x, z] of legPositions) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(x, TABLE_TOP_Y / 2 - TABLE_THICKNESS, z);
      leg.castShadow = true;
      this.scene.add(leg);
    }
  }

  private buildNet() {
    const group = new THREE.Group();

    const meshTex = makeNetTexture();
    meshTex.wrapS = meshTex.wrapT = THREE.RepeatWrapping;
    meshTex.repeat.set(8, 1);
    const meshGeo = new THREE.PlaneGeometry(TABLE_W + NET_OVERHANG * 2, NET_H);
    const meshMat = new THREE.MeshStandardMaterial({
      map: meshTex,
      transparent: true,
      side: THREE.DoubleSide,
      roughness: 0.95,
      alphaTest: 0.05,
    });
    const front = new THREE.Mesh(meshGeo, meshMat);
    front.position.set(0, TABLE_TOP_Y + NET_H / 2, 0);
    front.castShadow = true;
    group.add(front);

    // Top tape
    const tapeGeo = new THREE.BoxGeometry(
      TABLE_W + NET_OVERHANG * 2,
      0.12,
      NET_THICKNESS + 0.05
    );
    const tapeMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const tape = new THREE.Mesh(tapeGeo, tapeMat);
    tape.position.set(0, TABLE_TOP_Y + NET_H, 0);
    tape.castShadow = true;
    group.add(tape);

    // Side posts
    const postGeo = new THREE.CylinderGeometry(0.08, 0.08, NET_H + 0.2, 12);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
    for (const x of [-TABLE_W / 2 - NET_OVERHANG, TABLE_W / 2 + NET_OVERHANG]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(x, TABLE_TOP_Y + NET_H / 2, 0);
      post.castShadow = true;
      group.add(post);
    }

    this.scene.add(group);
  }

  private buildPaddles() {
    this.playerPaddle = makePaddle(0xc83232, 0x402020);
    this.playerPaddle.position.copy(this.playerPos);
    this.playerPaddle.rotation.y = Math.PI; // face -z (toward AI)
    this.playerPaddle.rotation.x = -0.15;
    this.scene.add(this.playerPaddle);

    this.aiPaddle = makePaddle(0x1f6f1f, 0x224022);
    this.aiPaddle.position.copy(this.aiPos);
    this.aiPaddle.rotation.x = 0.15;
    this.scene.add(this.aiPaddle);
  }

  private buildBall() {
    const geo = new THREE.SphereGeometry(BALL_R, 24, 16);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xc8eaff,
      emissive: 0x4a90c8,
      emissiveIntensity: 0.25,
      roughness: 0.35,
      metalness: 0.0,
    });
    this.ball = new THREE.Mesh(geo, mat);
    this.ball.castShadow = true;
    this.scene.add(this.ball);

    // Faint marker on the table tracking ball x/z — helps the player read
    // where the ball is when it's high in flight.
    const markerGeo = new THREE.RingGeometry(0.25, 0.45, 24);
    const markerMat = new THREE.MeshBasicMaterial({
      color: 0xc8eaff,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.ballMarker = new THREE.Mesh(markerGeo, markerMat);
    this.ballMarker.rotation.x = -Math.PI / 2;
    this.ballMarker.position.y = TABLE_TOP_Y + 0.012;
    this.ballMarker.renderOrder = 2;
    this.scene.add(this.ballMarker);
  }

  // --- Input ---

  private handleResize = () => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private handlePointerMove = (e: PointerEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.paddlePlane, this.hoverPoint);
    if (!hit) return;
    const halfW = TABLE_W / 2 + 1.5;
    this.playerPos.x = THREE.MathUtils.clamp(this.hoverPoint.x, -halfW, halfW);
    this.playerPos.y = THREE.MathUtils.clamp(
      this.hoverPoint.y,
      TABLE_TOP_Y + 0.4,
      TABLE_TOP_Y + 8
    );
  };

  private handlePointerDown = () => {
    if (this.state === "idle" || this.state === "serving") {
      this.serve();
    } else if (this.state === "gameOver") {
      this.restart();
    }
  };

  // --- Game flow ---

  private resetForServe(side: Side, faultReason?: string) {
    this.servingSide = side;
    this.state = "serving";
    this.lastHitter = null;
    this.bounceQueue = [];
    this.inServe = false;
    if (side === "player") {
      this.ballPos.set(this.playerPos.x, TABLE_TOP_Y + 3, PLAYER_Z - 0.6);
      this.message = faultReason
        ? `${faultReason} — click to serve`
        : "Click to serve";
    } else {
      // Pick a court so a constant-vx serve can travel diagonally — from x=0 a
      // straight-line trajectory can't bounce on opposite x-halves.
      const aiCourt = Math.random() < 0.5 ? 1 : -1;
      const aiServeX = aiCourt * 3;
      this.aiPos.x = aiServeX;
      this.aiTargetX = aiServeX;
      this.ballPos.set(aiServeX, TABLE_TOP_Y + 3, AI_Z + 0.6);
      this.message = faultReason ?? "Get ready…";
      setTimeout(() => {
        if (this.state === "serving" && this.servingSide === "ai") this.serve();
      }, 900);
    }
    this.ballVel.set(0, 0, 0);
    this.prevBallPos.copy(this.ballPos);
  }

  private serve() {
    if (this.state !== "serving") return;
    this.state = "playing";
    this.message = "";
    // Serve arcs up so ball bounces on server's own side first, then opponent's.
    // Velocities are tuned so first bounce is well clear of the net (~z=2.7) and
    // second bounce lands solidly on opponent side (~z=-9).
    const vyServe = 8 + Math.random() * 0.6;
    const vzServe = 13 + Math.random() * 0.8;
    // Diagonal serve: -0.9 * serveX puts the first bounce on the server's
    // x-half and the second roughly mirrored across x=0. Range derived from
    // flight times (~0.81s to first bounce, ~1.7s to second): vx in
    // (-1.235*x, -0.588*x) keeps x1 same-sign as x_start and flips x2's sign.
    const vxServe =
      -0.9 * this.ballPos.x + THREE.MathUtils.randFloatSpread(0.4);
    if (this.servingSide === "player") {
      this.ballVel.set(vxServe, vyServe, -vzServe);
      this.lastHitter = "player";
      this.bounceQueue = ["player", "ai"];
    } else {
      this.ballVel.set(vxServe, vyServe, vzServe);
      this.lastHitter = "ai";
      this.bounceQueue = ["ai", "player"];
    }
    this.inServe = true;
    this.serveFirstBounceX = NaN;
    if (DEBUG) {
      console.log(
        `[serve] ${this.servingSide} | pos=`, this.ballPos.toArray(),
        `vel=`, this.ballVel.toArray(),
        `queue=`, this.bounceQueue
      );
    }
    this.sound.paddleHit(0.7);
    this.notify();
  }

  private awardPoint(to: Side, faultReason?: string) {
    if (to === "player") this.playerScore++;
    else this.aiScore++;

    if (this.playerScore >= WIN_SCORE || this.aiScore >= WIN_SCORE) {
      this.winner = this.playerScore > this.aiScore ? "player" : "ai";
      this.state = "gameOver";
      this.message = this.winner === "player" ? "You win!" : "AI wins";
      this.sound.win(this.winner === "player");
      this.notify();
      return;
    }
    this.sound.score(to === "player");
    this.resetForServe(to, faultReason);
    this.notify();
  }

  // --- Loop ---

  private loop = () => {
    this.rafId = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.033);
    this.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private update(dt: number) {
    // Player paddle: snap directly to mouse target — lerp adds visible lag
    // that makes interception unreliable on fast rallies.
    this.playerPaddle.position.copy(this.playerPos);

    // AI paddle update — aiPos is already smoothed inside updateAI, so snap
    // the visual paddle directly to it (avoid double lerp lag).
    this.updateAI(dt);
    this.aiPaddle.position.copy(this.aiPos);

    if (this.state === "serving") {
      // Ball hovers at a fixed height during serve so trajectory is consistent
      // regardless of where the cursor is — only x is set from the paddle.
      if (this.servingSide === "player") {
        this.ballPos.set(
          this.playerPaddle.position.x,
          TABLE_TOP_Y + 3,
          PLAYER_Z - 0.5
        );
      } else {
        this.ballPos.set(this.aiPos.x, TABLE_TOP_Y + 3, AI_Z + 0.5);
      }
      this.syncBallMesh();
      this.prevBallPos.copy(this.ballPos);
      return;
    }

    if (this.state !== "playing") {
      this.syncBallMesh();
      return;
    }

    this.prevBallPos.copy(this.ballPos);
    this.ballVel.y += GRAVITY * dt;
    this.ballPos.addScaledVector(this.ballVel, dt);

    // --- Collisions ---

    // Table top
    if (
      this.ballPos.y - BALL_R < TABLE_TOP_Y &&
      this.ballVel.y < 0 &&
      Math.abs(this.ballPos.x) < TABLE_W / 2 + 0.4 &&
      Math.abs(this.ballPos.z) < TABLE_L / 2 + 0.4
    ) {
      this.ballPos.y = TABLE_TOP_Y + BALL_R;
      const impactSpeed = Math.abs(this.ballVel.y);
      this.ballVel.y = -this.ballVel.y * TABLE_RESTITUTION;
      this.ballVel.x *= 0.985;
      this.ballVel.z *= 0.985;
      this.sound.tableBounce(THREE.MathUtils.clamp(impactSpeed / 12, 0.3, 1.2));

      // Enforce bounce-side rules
      const bounceSide: Side = this.ballPos.z < 0 ? "ai" : "player";
      if (DEBUG) {
        console.log(
          `[bounce] side=${bounceSide} at z=${this.ballPos.z.toFixed(2)} y=${this.ballPos.y.toFixed(2)} ` +
            `lastHitter=${this.lastHitter} queue=`, [...this.bounceQueue]
        );
      }
      if (this.lastHitter) {
        if (this.bounceQueue.length > 0) {
          const expected = this.bounceQueue[0];
          if (bounceSide !== expected) {
            if (DEBUG) console.log(`[fault wrong-side] expected=${expected} got=${bounceSide}`);
            this.awardPoint(this.lastHitter === "player" ? "ai" : "player");
            return;
          }
          if (this.inServe) {
            if (this.bounceQueue.length === 2) {
              // First bounce of a serve — remember which x-half it landed on.
              this.serveFirstBounceX = this.ballPos.x;
            } else if (this.bounceQueue.length === 1) {
              // Second bounce of a serve — must land on the opposite x-half.
              // x exactly on the centerline counts as either court (lenient,
              // matches real-world rule), so only fault on a clear same-half hit.
              const firstSign = Math.sign(this.serveFirstBounceX);
              const secondSign = Math.sign(this.ballPos.x);
              if (firstSign !== 0 && secondSign !== 0 && firstSign === secondSign) {
                if (DEBUG) {
                  console.log(
                    `[serve fault not-diagonal] first_x=${this.serveFirstBounceX.toFixed(2)} ` +
                      `second_x=${this.ballPos.x.toFixed(2)}`
                  );
                }
                this.awardPoint(
                  this.lastHitter === "player" ? "ai" : "player",
                  "Serve fault: not diagonal"
                );
                return;
              }
              this.inServe = false;
            }
          }
          this.bounceQueue.shift();
        } else {
          if (DEBUG) console.log(`[double bounce] lastHitter=${this.lastHitter} wins`);
          this.awardPoint(this.lastHitter);
          return;
        }
      }
    }

    // Net (z plane = 0)
    if (
      Math.sign(this.prevBallPos.z) !== Math.sign(this.ballPos.z) &&
      this.ballPos.y < TABLE_TOP_Y + NET_H + BALL_R &&
      Math.abs(this.ballPos.x) < TABLE_W / 2 + NET_OVERHANG
    ) {
      this.ballPos.z = this.prevBallPos.z > 0 ? 0.01 : -0.01;
      this.ballVel.z = -this.ballVel.z * NET_RESTITUTION;
      this.ballVel.x *= 0.5;
      this.ballVel.y = Math.max(this.ballVel.y, 1.5);
      this.sound.netHit();
    }

    // Paddles
    if (this.tryPaddleHit(this.playerPaddle.position, "player")) return;
    if (this.tryPaddleHit(this.aiPaddle.position, "ai")) return;

    // Out of bounds — score
    if (this.ballPos.z > PLAYER_Z + 2.5 || this.ballPos.z < AI_Z - 2.5) {
      if (DEBUG) {
        console.log(
          `[out z] z=${this.ballPos.z.toFixed(2)} queue=`, [...this.bounceQueue],
          `lastHitter=${this.lastHitter}`
        );
      }
      if (this.bounceQueue.length > 0 && this.lastHitter) {
        this.awardPoint(this.lastHitter === "player" ? "ai" : "player");
      } else {
        this.awardPoint(this.ballPos.z > 0 ? "ai" : "player");
      }
      return;
    }
    if (this.ballPos.y < TABLE_TOP_Y - 6) {
      if (DEBUG) {
        console.log(
          `[fell off] pos=(${this.ballPos.x.toFixed(2)},${this.ballPos.y.toFixed(2)},${this.ballPos.z.toFixed(2)}) ` +
            `queue=`, [...this.bounceQueue], `lastHitter=${this.lastHitter}`
        );
      }
      if (this.bounceQueue.length > 0 && this.lastHitter) {
        this.awardPoint(this.lastHitter === "player" ? "ai" : "player");
      } else if (this.lastHitter) {
        this.awardPoint(this.lastHitter);
      } else {
        this.awardPoint("ai");
      }
      return;
    }

    this.syncBallMesh();
  }

  private syncBallMesh() {
    this.ball.position.copy(this.ballPos);
    this.ballMarker.position.x = this.ballPos.x;
    this.ballMarker.position.z = this.ballPos.z;
    // Marker grows and fades as the ball gets higher off the table.
    const heightAbove = Math.max(0, this.ballPos.y - TABLE_TOP_Y - BALL_R);
    const scale = 1 + heightAbove * 0.18;
    this.ballMarker.scale.setScalar(scale);
    const mat = this.ballMarker.material as THREE.MeshBasicMaterial;
    mat.opacity = THREE.MathUtils.clamp(0.65 - heightAbove * 0.05, 0.18, 0.65);
  }

  private tryPaddleHit(paddle: THREE.Vector3, side: Side): boolean {
    const prevSide = this.prevBallPos.z - paddle.z;
    const currSide = this.ballPos.z - paddle.z;
    // For player paddle (positive z), hit when ball is moving +z and crosses paddle plane.
    // For AI paddle (negative z), hit when ball is moving -z and crosses paddle plane.
    const movingTowardPaddle =
      (side === "player" && this.ballVel.z > 0) ||
      (side === "ai" && this.ballVel.z < 0);
    if (!movingTowardPaddle) return false;
    if (Math.sign(prevSide) === Math.sign(currSide)) return false;

    const dx = this.ballPos.x - paddle.x;
    const dy = this.ballPos.y - paddle.y;
    const dist = Math.hypot(dx, dy);
    if (dist > PADDLE_HIT_R) {
      if (DEBUG) {
        console.log(
          `[miss ${side}] ball=(${this.ballPos.x.toFixed(2)},${this.ballPos.y.toFixed(2)},${this.ballPos.z.toFixed(2)}) ` +
            `paddle=(${paddle.x.toFixed(2)},${paddle.y.toFixed(2)},${paddle.z.toFixed(2)}) ` +
            `dx=${dx.toFixed(2)} dy=${dy.toFixed(2)} dist=${dist.toFixed(2)} (need ≤${PADDLE_HIT_R})`
        );
      }
      return false;
    }

    // Volley fault: hitter is hitting before the ball has bounced on their own side
    // (queue still expects a bounce on their side first).
    if (this.bounceQueue.length > 0 && this.bounceQueue[0] === side) {
      if (DEBUG) console.log(`[volley fault ${side}] queue=`, this.bounceQueue);
      this.awardPoint(side === "player" ? "ai" : "player");
      return true;
    }

    // Reflect z velocity with enough forward speed to clear the net and bounce
    // past it onto opponent's side. With vz≈22 and vy≈11, the ball arcs over the
    // net (~y 10.5 at z=0) and lands ~5–6 units into opponent's half.
    this.ballPos.z = paddle.z + (side === "player" ? -BALL_R : BALL_R);
    const baseReturn = side === "player" ? -1 : 1;
    const fwdSpeed = Math.max(Math.abs(this.ballVel.z) * PADDLE_RESTITUTION, 22);
    this.ballVel.z = baseReturn * fwdSpeed;
    this.ballVel.y = 11 + (dy > 0 ? 1.8 : -1);
    this.ballVel.x = dx * 3.5 + this.ballVel.x * 0.3 + THREE.MathUtils.randFloatSpread(1.0);
    if (dist < PADDLE_R * 0.4) {
      this.ballVel.multiplyScalar(1.05);
    }
    const cap = 34;
    if (this.ballVel.length() > cap) this.ballVel.setLength(cap);

    // Rally hit: must bounce on opponent's side before opponent returns.
    this.lastHitter = side;
    this.bounceQueue = [side === "player" ? "ai" : "player"];
    this.inServe = false;
    this.sound.paddleHit(THREE.MathUtils.clamp(this.ballVel.length() / 22, 0.6, 1.2));
    if (DEBUG) {
      console.log(
        `[hit ${side}] dist=${dist.toFixed(2)} dx=${dx.toFixed(2)} dy=${dy.toFixed(2)} ` +
          `outVel=`, this.ballVel.toArray().map((v) => +v.toFixed(2))
      );
    }
    return false;
  }

  private updateAI(dt: number) {
    // Track ball — predict landing x at AI plane if heading toward AI
    this.aiNoiseTimer -= dt;
    if (this.aiNoiseTimer <= 0) {
      this.aiNoiseTimer = 0.25;
      this.aiNoiseOffset = THREE.MathUtils.randFloatSpread(AI_REACTION_NOISE * 2);
    }

    if (this.state === "playing" && this.ballVel.z < 0 && this.ballPos.z > AI_Z) {
      const t = (AI_Z - this.ballPos.z) / this.ballVel.z;
      const predictedX = this.ballPos.x + this.ballVel.x * t;
      this.aiTargetX = THREE.MathUtils.clamp(
        predictedX + this.aiNoiseOffset,
        -TABLE_W / 2,
        TABLE_W / 2
      );
    } else if (this.state !== "serving") {
      // drift back to center between rallies (hold the chosen serve x while serving)
      this.aiTargetX = THREE.MathUtils.lerp(this.aiTargetX, 0, dt * 1.5);
    }

    const step = AI_BASE_SPEED * dt;
    const dx = this.aiTargetX - this.aiPos.x;
    if (Math.abs(dx) > step) this.aiPos.x += Math.sign(dx) * step;
    else this.aiPos.x = this.aiTargetX;

    // y tracks ball height when ball is approaching. Faster lerp so it keeps
    // up through the ball's bounces; otherwise dy at impact can exceed hit zone.
    if (this.state === "playing" && this.ballVel.z < 0) {
      const targetY = THREE.MathUtils.clamp(
        this.ballPos.y,
        TABLE_TOP_Y + 0.6,
        TABLE_TOP_Y + 4
      );
      this.aiPos.y = THREE.MathUtils.lerp(this.aiPos.y, targetY, Math.min(1, dt * 14));
    } else {
      this.aiPos.y = THREE.MathUtils.lerp(this.aiPos.y, TABLE_TOP_Y + 1.6, Math.min(1, dt * 4));
    }
  }

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
}

// --- Asset helpers ---

function makePaddle(faceColor: number, handleColor: number): THREE.Group {
  const group = new THREE.Group();

  const headGeo = new THREE.CylinderGeometry(PADDLE_R, PADDLE_R, PADDLE_T, 32);
  const headMat = new THREE.MeshStandardMaterial({
    color: faceColor,
    roughness: 0.55,
    metalness: 0.05,
  });
  const head = new THREE.Mesh(headGeo, headMat);
  head.rotation.x = Math.PI / 2; // flat face faces +z
  head.castShadow = true;
  group.add(head);

  // White edge ring
  const ringGeo = new THREE.TorusGeometry(PADDLE_R, 0.06, 8, 48);
  const ringMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.z = PADDLE_T / 2;
  group.add(ring);
  const ringBack = new THREE.Mesh(ringGeo, ringMat);
  ringBack.position.z = -PADDLE_T / 2;
  group.add(ringBack);

  // Handle
  const handleGeo = new THREE.BoxGeometry(
    PADDLE_HANDLE_W,
    PADDLE_HANDLE_H,
    PADDLE_HANDLE_T
  );
  const handleMat = new THREE.MeshStandardMaterial({
    color: handleColor,
    roughness: 0.7,
  });
  const handle = new THREE.Mesh(handleGeo, handleMat);
  handle.position.y = -PADDLE_R - PADDLE_HANDLE_H / 2 + 0.1;
  handle.castShadow = true;
  group.add(handle);

  // Handle wrap (gold band)
  const bandGeo = new THREE.BoxGeometry(
    PADDLE_HANDLE_W * 1.05,
    0.2,
    PADDLE_HANDLE_T * 1.05
  );
  const bandMat = new THREE.MeshStandardMaterial({
    color: 0xc69e3a,
    roughness: 0.5,
    metalness: 0.4,
  });
  const band = new THREE.Mesh(bandGeo, bandMat);
  band.position.y = handle.position.y + PADDLE_HANDLE_H / 2;
  group.add(band);

  return group;
}

function makeWoodTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#8b5a2b";
  ctx.fillRect(0, 0, 512, 512);
  // Plank stripes
  for (let i = 0; i < 8; i++) {
    const y = i * 64;
    ctx.fillStyle = i % 2 === 0 ? "#7a4a23" : "#965f2f";
    ctx.fillRect(0, y, 512, 64);
    // grain lines
    ctx.strokeStyle = "rgba(60, 30, 10, 0.35)";
    ctx.lineWidth = 1;
    for (let g = 0; g < 6; g++) {
      ctx.beginPath();
      const gy = y + 8 + g * 9 + Math.random() * 3;
      ctx.moveTo(0, gy);
      ctx.bezierCurveTo(170, gy + 2, 340, gy - 2, 512, gy + Math.random() * 2);
      ctx.stroke();
    }
    // plank edges
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.fillRect(0, y, 512, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeTableTopTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  // Aspect of table top: width(x) : length(z). We orient texture so v runs along z.
  c.width = 512;
  c.height = 1024;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#0a6b35";
  ctx.fillRect(0, 0, c.width, c.height);

  // Subtle gradient sheen
  const grad = ctx.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, "rgba(255,255,255,0.05)");
  grad.addColorStop(0.5, "rgba(0,0,0,0.05)");
  grad.addColorStop(1, "rgba(255,255,255,0.05)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, c.width, c.height);

  // White border
  const border = 16;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, border);
  ctx.fillRect(0, c.height - border, c.width, border);
  ctx.fillRect(0, 0, border, c.height);
  ctx.fillRect(c.width - border, 0, border, c.height);

  // Center line (lengthwise)
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(c.width / 2 - 3, 0, 6, c.height);

  // Net line (across the middle)
  ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
  ctx.fillRect(0, c.height / 2 - 1, c.width, 2);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function makeNetTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, c.width, c.height);
  // Background tint
  ctx.fillStyle = "rgba(40, 25, 10, 0.55)";
  ctx.fillRect(0, 0, c.width, c.height);
  // Grid
  ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
  ctx.lineWidth = 1.5;
  const cols = 32;
  const rows = 8;
  for (let i = 0; i <= cols; i++) {
    const x = (i / cols) * c.width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, c.height);
    ctx.stroke();
  }
  for (let j = 0; j <= rows; j++) {
    const y = (j / rows) * c.height;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(c.width, y);
    ctx.stroke();
  }
  // Holes (transparency where the mesh is open) — simulate with subtle alpha cutouts
  const img = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    // make non-line pixels semi-transparent
    if (img.data[i + 3] < 200) {
      img.data[i + 3] = 90;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
