import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, VignetteEffect } from 'postprocessing';
import { gsap } from 'gsap';
import type { LobbyState, Player, ClientMessage, Direction, PowerUp } from '@shared/types';
import { ARENA_SIZE, CELL_SIZE, PLAYER_COLORS, SPEED_LEVEL_THRESHOLDS } from '@shared/types';
import type { SoundManager } from './SoundManager';

const PLAYER_COLORS_HEX: Record<string, number> = {
  red:    0xff2222,
  green:  0x22ff44,
  yellow: 0xffee22,
  purple: 0xbb22ff,
  blue:   0x2266ff,
  cyan:   0x22ffee,
  orange: 0xff8822,
  pink:   0xff22aa,
};

/** CSS colours used on the minimap (must match PLAYER_COLORS_HEX). */
const MINIMAP_COLORS: Record<string, string> = {
  red:    '#ff2222',
  green:  '#22ff44',
  yellow: '#ffee22',
  purple: '#bb22ff',
  blue:   '#2266ff',
  cyan:   '#22ffee',
  orange: '#ff8822',
  pink:   '#ff22aa',
};

const ARENA_HALF = (ARENA_SIZE * CELL_SIZE) / 2;

/** Milliseconds between input messages sent to the server (~25 per second). */
const INPUT_THROTTLE_MS = 40;

/**
 * Frame-rate independent position interpolation.
 * Formula: alpha = 1 - BASE^(dt * TARGET_FPS)  where BASE=0.05, TARGET_FPS=60.
 */
const INTERP_BASE = 0.05;
const INTERP_TARGET_FPS = 60;

/** Rotation interpolation — faster than position for snappy feel. */
const ROT_INTERP_BASE = 0.008;
const CAMERA_INTERP_BASE = 0.03;
const CAMERA_FOLLOW_DISTANCE = CELL_SIZE * 5.2;
const CAMERA_HEIGHT = CELL_SIZE * 2.3;
const CAMERA_LOOK_AHEAD = CELL_SIZE * 2.8;
const POWERUP_SIZE_RATIO = 0.23;
const POWERUP_EMISSIVE_INTENSITY = 2.7;
const POWERUP_BASE_HEIGHT = 0.9;
const POWERUP_FLOAT_SPEED = 4;
const POWERUP_FLOAT_PHASE_SCALE = 0.07;
const POWERUP_FLOAT_AMPLITUDE = 0.12;

/** Trail wall heights per speed level (taller = more dramatic). */
const TRAIL_HEIGHTS = [1.2, 2.0, 3.2, 5.0] as const;
/** Y centre position for trail mesh at each speed level (height / 2). */
const TRAIL_Y_CENTERS = [0.6, 1.0, 1.6, 2.5] as const;
/** Target camera FOV per speed level — wider at higher speeds. */
const SPEED_FOV = [55, 62, 70, 80] as const;

/** Map direction → Y rotation (radians) for bike mesh. */
const DIR_TO_ROT: Record<Direction, number> = {
  N: 0,
  S: Math.PI,
  E: -Math.PI / 2,
  W: Math.PI / 2,
};

interface BikeMesh {
  body: THREE.Mesh;
  light: THREE.PointLight;
  targetX: number;
  targetZ: number;
  targetRotY: number;
  alive: boolean;
}

/** Shortest angular distance from `a` to `b` (both in radians). */
function shortestAngleDelta(a: number, b: number): number {
  const angleDelta = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return angleDelta;
}

export class TronBikesGame {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private animFrameId = 0;
  private clock: THREE.Clock;
  private ws: WebSocket;
  private myPlayerId: string;
  private lobbyState: LobbyState;
  private soundManager: SoundManager;

  private bikeMeshes: Map<string, BikeMesh> = new Map();
  private powerUpMeshes: Map<string, THREE.Mesh> = new Map();

  // Trail mesh grid — one slot per cell
  private trailMeshes: (THREE.Mesh | null)[][] = [];
  private prevTrail: number[][] = [];

  // Per-speed-level trail geometries; one material per player colour
  private trailGeos!: THREE.BoxGeometry[];
  private trailMats: THREE.MeshStandardMaterial[] = [];

  // Minimap
  private minimapCanvas: HTMLCanvasElement | null = null;
  private minimapCtx: CanvasRenderingContext2D | null = null;

  // Input state
  private keys = { w: false, a: false, s: false, d: false, space: false, shift: false };
  private lastInputSent = 0;
  private keyDownHandler!: (e: KeyboardEvent) => void;
  private keyUpHandler!: (e: KeyboardEvent) => void;

  // Camera shake
  private cameraShake = { intensity: 0, decay: 0.88 };

  // Current interpolated FOV
  private currentFov = 55;

  constructor(
    canvas: HTMLCanvasElement,
    ws: WebSocket,
    myPlayerId: string,
    initialState: LobbyState,
    soundManager: SoundManager,
    minimapCanvas?: HTMLCanvasElement,
  ) {
    this.ws = ws;
    this.myPlayerId = myPlayerId;
    this.lobbyState = initialState;
    this.clock = new THREE.Clock();
    this.soundManager = soundManager;
    this.minimapCanvas = minimapCanvas ?? null;
    this.minimapCtx = minimapCanvas?.getContext('2d') ?? null;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.4;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000510);
    this.scene.fog = new THREE.FogExp2(0x000510, 0.003);

    // Camera — smooth third-person follow
    this.camera = new THREE.PerspectiveCamera(
      55, window.innerWidth / window.innerHeight, 0.1, 500,
    );
    this.camera.position.set(ARENA_HALF, CAMERA_HEIGHT * 1.8, ARENA_HALF + CAMERA_FOLLOW_DISTANCE);
    this.camera.lookAt(ARENA_HALF, 0, ARENA_HALF);

    // Post-processing
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new EffectPass(
      this.camera,
      new BloomEffect({ intensity: 3.2, luminanceThreshold: 0.06, radius: 0.95 }),
      new VignetteEffect({ darkness: 0.55 }),
    ));

    // Per-speed-level trail geometries
    this.trailGeos = TRAIL_HEIGHTS.map(h => new THREE.BoxGeometry(CELL_SIZE * 0.82, h, CELL_SIZE * 0.82));

    // One material per player colour
    for (const colorName of PLAYER_COLORS) {
      const colorHex = PLAYER_COLORS_HEX[colorName] ?? 0xffffff;
      this.trailMats.push(new THREE.MeshStandardMaterial({
        color: colorHex,
        emissive: colorHex,
        emissiveIntensity: 2.0,
        roughness: 0.08,
        metalness: 0.85,
        transparent: true,
        opacity: 0.92,
      }));
    }

    // Init trail tracking arrays
    for (let x = 0; x < ARENA_SIZE; x++) {
      this.trailMeshes[x] = new Array<THREE.Mesh | null>(ARENA_SIZE).fill(null);
      this.prevTrail[x]   = new Array<number>(ARENA_SIZE).fill(0);
    }

    this.setupScene();
    this.setupBikes();
    this.setupInputHandlers();
    window.addEventListener('resize', this.onResize);
    this.animate();
  }

  // ─── Scene Setup ────────────────────────────────────────────────────────────

  private setupScene(): void {
    // Ambient
    this.scene.add(new THREE.AmbientLight(0x020220, 0.5));

    // Directional (cool blue tint)
    const dir = new THREE.DirectionalLight(0x4466bb, 0.45);
    dir.position.set(ARENA_HALF, 60, ARENA_HALF + 40);
    this.scene.add(dir);

    // Subtle under-lighting to make trail walls readable
    const under = new THREE.DirectionalLight(0x002244, 0.3);
    under.position.set(ARENA_HALF, -20, ARENA_HALF);
    this.scene.add(under);

    // Floor
    const W = ARENA_SIZE * CELL_SIZE;
    const floorGeo = new THREE.PlaneGeometry(W + 4, W + 4);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x000c18, roughness: 0.98 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(ARENA_HALF, -0.02, ARENA_HALF);
    this.scene.add(floor);

    // Grid lines — slightly brighter for visibility
    const grid = new THREE.GridHelper(W, ARENA_SIZE, 0x004466, 0x001c2e);
    grid.position.set(ARENA_HALF, 0.02, ARENA_HALF);
    this.scene.add(grid);

    // Arena border glow walls
    this.buildBorderWalls();

    // Subtle arena floor glow at centre
    const glowLight = new THREE.PointLight(0x0033aa, 1.2, W * 0.8);
    glowLight.position.set(ARENA_HALF, -1, ARENA_HALF);
    this.scene.add(glowLight);

    // Stars
    const starCount = 700;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      starPos[i * 3]     = (Math.random() - 0.5) * 300;
      starPos[i * 3 + 1] = Math.random() * 100 + 25;
      starPos[i * 3 + 2] = (Math.random() - 0.5) * 300;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.scene.add(new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.22, sizeAttenuation: true }),
    ));
  }

  private buildBorderWalls(): void {
    const W = ARENA_SIZE * CELL_SIZE;
    const H = 2.0;
    const T = 0.3;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x001833,
      emissive: 0x0066ff,
      emissiveIntensity: 2.2,
      roughness: 0.1,
      metalness: 0.95,
    });
    // N, S, W, E walls
    const panels = [
      { w: W + T * 2, h: H, d: T, x: ARENA_HALF, z: -T / 2 },
      { w: W + T * 2, h: H, d: T, x: ARENA_HALF, z: W + T / 2 },
      { w: T, h: H, d: W, x: -T / 2, z: ARENA_HALF },
      { w: T, h: H, d: W, x: W + T / 2, z: ARENA_HALF },
    ];
    for (const p of panels) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(p.w, p.h, p.d), mat);
      mesh.position.set(p.x, H / 2, p.z);
      this.scene.add(mesh);
    }
  }

  // ─── Bikes ──────────────────────────────────────────────────────────────────

  private setupBikes(): void {
    for (const player of this.lobbyState.players) {
      this.createBikeMesh(player);
    }
  }

  private createBikeMesh(player: Player): void {
    const colorHex = PLAYER_COLORS_HEX[player.color] ?? 0xffffff;

    // Bike body — elongated box
    const bodyGeo = new THREE.BoxGeometry(0.52 * CELL_SIZE, 0.24 * CELL_SIZE, 0.9 * CELL_SIZE);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: colorHex,
      emissive: colorHex,
      emissiveIntensity: 1.1,
      roughness: 0.15,
      metalness: 0.7,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    const wx = player.position.x * CELL_SIZE;
    const wz = player.position.z * CELL_SIZE;
    body.position.set(wx, 0.3, wz);
    const targetRotY = DIR_TO_ROT[player.direction] ?? 0;
    body.rotation.y = targetRotY;
    this.scene.add(body);

    // Point light — wide enough to glow on nearby trail
    const light = new THREE.PointLight(colorHex, 3.0, CELL_SIZE * 5.5);
    light.position.set(wx, 0.6, wz);
    this.scene.add(light);

    this.bikeMeshes.set(player.id, {
      body, light,
      targetX: wx, targetZ: wz,
      targetRotY,
      alive: true,
    });
  }

  // ─── State Update ────────────────────────────────────────────────────────────

  public updateState(newState: LobbyState): void {
    const prevPlayers = new Map(this.lobbyState.players.map(p => [p.id, p]));
    this.lobbyState = newState;

    // Sync bikes
    for (const player of newState.players) {
      let mesh = this.bikeMeshes.get(player.id);

      // Respawn / new player
      if (!mesh) {
        this.createBikeMesh(player);
        mesh = this.bikeMeshes.get(player.id)!;
      }

      const prev = prevPlayers.get(player.id);
      // Just eliminated — play crash effect
      if (prev?.isAlive && !player.isAlive) {
        this.playCrashEffect(mesh, player.color);
        this.soundManager.playExplosion();
        this.cameraShake.intensity = Math.max(this.cameraShake.intensity, 0.9);
      }

      // Respawn at new round start
      if (player.isAlive && !mesh.alive) {
        mesh.alive = true;
        mesh.body.visible = true;
        (mesh.body.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.1;
        mesh.light.intensity = 3.0;
      }

      // Detect power-up pickup (charges increased) — play sound for local player
      if (player.id === this.myPlayerId && prev) {
        if (player.jumpCharges > prev.jumpCharges || player.boostCharges > prev.boostCharges) {
          this.soundManager.playPickup();
        }
        if (player.isBoosting && !prev.isBoosting) {
          this.soundManager.playBoost();
        }
      }

      if (!player.isAlive) continue;

      const wx = player.position.x * CELL_SIZE;
      const wz = player.position.z * CELL_SIZE;
      mesh.targetX = wx;
      mesh.targetZ = wz;
      mesh.targetRotY = DIR_TO_ROT[player.direction] ?? mesh.targetRotY;
    }

    // Update trail meshes (only changed cells)
    this.syncTrail(newState.trail);
    this.syncPowerUps(newState.powerUps ?? []);
  }

  private playCrashEffect(mesh: BikeMesh, colorName: string): void {
    mesh.alive = false;
    const colorHex = PLAYER_COLORS_HEX[colorName] ?? 0xffffff;

    // Flash then hide
    gsap.to((mesh.body.material as THREE.MeshStandardMaterial), {
      emissiveIntensity: 5,
      duration: 0.07,
      onComplete: () => {
        gsap.to((mesh.body.material as THREE.MeshStandardMaterial), {
          emissiveIntensity: 0,
          duration: 0.35,
          onComplete: () => { mesh.body.visible = false; },
        });
      },
    });
    gsap.to(mesh.light, { intensity: 0, duration: 0.35 });

    // Debris ring
    const count = 16;
    for (let i = 0; i < count; i++) {
      const geo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
      const mat = new THREE.MeshStandardMaterial({
        color: colorHex, emissive: colorHex, emissiveIntensity: 2.5,
      });
      const debris = new THREE.Mesh(geo, mat);
      debris.position.copy(mesh.body.position);
      this.scene.add(debris);
      const angle = (i / count) * Math.PI * 2;
      const speed = 1.0 + Math.random() * 1.5;
      gsap.to(debris.position, {
        x: debris.position.x + Math.cos(angle) * speed * 2,
        y: debris.position.y + Math.random() * 1.5 + 0.2,
        z: debris.position.z + Math.sin(angle) * speed * 2,
        duration: 0.55,
        ease: 'power2.out',
      });
      gsap.to(debris.scale, {
        x: 0.01, y: 0.01, z: 0.01,
        duration: 0.55,
        onComplete: () => {
          this.scene.remove(debris);
          geo.dispose();
          mat.dispose();
        },
      });
    }
  }

  private syncTrail(trail: number[][]): void {
    const speedLevel = Math.min(this.lobbyState.speedLevel, TRAIL_HEIGHTS.length - 1);
    for (let x = 0; x < ARENA_SIZE; x++) {
      const row = trail[x];
      if (!row) continue;
      for (let z = 0; z < ARENA_SIZE; z++) {
        const cur  = row[z] ?? 0;
        const prev = this.prevTrail[x][z];
        if (cur === prev) continue;

        // Remove old mesh if any
        const old = this.trailMeshes[x][z];
        if (old) { this.scene.remove(old); this.trailMeshes[x][z] = null; }

        if (cur !== 0) {
          const colorIdx = cur - 1; // 0-based
          const mat = this.trailMats[colorIdx];
          if (mat) {
            const geo = this.trailGeos[speedLevel];
            const yCenter = TRAIL_Y_CENTERS[speedLevel];
            const m = new THREE.Mesh(geo, mat);
            m.position.set(x * CELL_SIZE, yCenter, z * CELL_SIZE);
            // Snappy pop-in animation
            m.scale.set(0.01, 0.01, 0.01);
            this.scene.add(m);
            gsap.to(m.scale, { x: 1, y: 1, z: 1, duration: 0.14, ease: 'back.out(2)' });
            this.trailMeshes[x][z] = m;
          }
        }
        this.prevTrail[x][z] = cur;
      }
    }
  }

  private syncPowerUps(powerUps: PowerUp[]): void {
    const currentIds = new Set(powerUps.map(pu => pu.id));
    for (const [id, mesh] of this.powerUpMeshes) {
      if (!currentIds.has(id)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        this.powerUpMeshes.delete(id);
      }
    }

    for (const powerUp of powerUps) {
      if (this.powerUpMeshes.has(powerUp.id)) continue;
      const isBoost = powerUp.type === 'boost';
      const geo = new THREE.OctahedronGeometry(CELL_SIZE * POWERUP_SIZE_RATIO, 0);
      const mat = new THREE.MeshStandardMaterial({
        color:    isBoost ? 0xffcc00 : 0xff66ff,
        emissive: isBoost ? 0xffaa00 : 0xff22ee,
        emissiveIntensity: POWERUP_EMISSIVE_INTENSITY,
        roughness: 0.15,
        metalness: 0.75,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(powerUp.position.x * CELL_SIZE, POWERUP_BASE_HEIGHT, powerUp.position.z * CELL_SIZE);
      this.powerUpMeshes.set(powerUp.id, mesh);
      this.scene.add(mesh);
    }
  }

  public notifyElimination(_playerName: string): void {
    /* sound already played in updateState */
  }

  // ─── Input ────────────────────────────────────────────────────────────────────

  public setKeys(partial: Partial<typeof this.keys>): void {
    Object.assign(this.keys, partial);
  }

  private setupInputHandlers(): void {
    this.keyDownHandler = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp':    this.keys.w = true;  e.preventDefault(); break;
        case 'KeyS': case 'ArrowDown':  this.keys.s = true;  e.preventDefault(); break;
        case 'KeyA': case 'ArrowLeft':  this.keys.a = true;  e.preventDefault(); break;
        case 'KeyD': case 'ArrowRight': this.keys.d = true;  e.preventDefault(); break;
        case 'Space':                   this.keys.space = true; e.preventDefault(); break;
        case 'ShiftLeft': case 'ShiftRight': this.keys.shift = true; e.preventDefault(); break;
      }
    };
    this.keyUpHandler = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp':    this.keys.w = false; break;
        case 'KeyS': case 'ArrowDown':  this.keys.s = false; break;
        case 'KeyA': case 'ArrowLeft':  this.keys.a = false; break;
        case 'KeyD': case 'ArrowRight': this.keys.d = false; break;
        case 'Space':                   this.keys.space = false; break;
        case 'ShiftLeft': case 'ShiftRight': this.keys.shift = false; break;
      }
    };
    window.addEventListener('keydown', this.keyDownHandler);
    window.addEventListener('keyup',   this.keyUpHandler);
  }

  private sendInput(): void {
    const now = performance.now();
    if (now - this.lastInputSent < INPUT_THROTTLE_MS) return;
    this.lastInputSent = now;
    if (this.ws.readyState === WebSocket.OPEN) {
      const msg: ClientMessage = { type: 'input', keys: { ...this.keys } };
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ─── Minimap ─────────────────────────────────────────────────────────────────

  private drawMinimap(): void {
    const canvas = this.minimapCanvas;
    const ctx = this.minimapCtx;
    if (!canvas || !ctx) return;

    const size = canvas.width;
    const scale = size / ARENA_SIZE;

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(0, 5, 20, 0.88)';
    ctx.fillRect(0, 0, size, size);

    // Trail cells
    for (let x = 0; x < ARENA_SIZE; x++) {
      const row = this.lobbyState.trail[x];
      if (!row) continue;
      for (let z = 0; z < ARENA_SIZE; z++) {
        const t = row[z];
        if (!t) continue;
        const colorName = PLAYER_COLORS[t - 1];
        ctx.fillStyle = MINIMAP_COLORS[colorName] ?? '#ffffff';
        ctx.fillRect(x * scale, z * scale, scale + 0.5, scale + 0.5);
      }
    }

    // Power-ups
    for (const pu of this.lobbyState.powerUps) {
      ctx.fillStyle = pu.type === 'boost' ? '#ffcc00' : '#ff66ff';
      const cx = pu.position.x * scale + scale * 0.5;
      const cz = pu.position.z * scale + scale * 0.5;
      ctx.fillRect(cx - 1.5, cz - 1.5, 3, 3);
    }

    // Players
    for (const player of this.lobbyState.players) {
      if (!player.isAlive) continue;
      const isMe = player.id === this.myPlayerId;
      ctx.fillStyle = MINIMAP_COLORS[player.color] ?? '#ffffff';
      const px = player.position.x * scale + scale * 0.5;
      const pz = player.position.z * scale + scale * 0.5;
      const r = isMe ? 3.5 : 2.2;
      ctx.beginPath();
      ctx.arc(px, pz, r, 0, Math.PI * 2);
      ctx.fill();
      if (isMe) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Border
    ctx.strokeStyle = 'rgba(0, 100, 255, 0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
  }

  // ─── Render Loop ─────────────────────────────────────────────────────────────

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  };

  private animate = (): void => {
    this.animFrameId = requestAnimationFrame(this.animate);
    const dt = this.clock.getDelta();

    const posAlpha = 1 - Math.pow(INTERP_BASE, dt * INTERP_TARGET_FPS);
    const rotAlpha = 1 - Math.pow(ROT_INTERP_BASE, dt * INTERP_TARGET_FPS);
    const cameraAlpha = 1 - Math.pow(CAMERA_INTERP_BASE, dt * INTERP_TARGET_FPS);
    const playerById = new Map(this.lobbyState.players.map(p => [p.id, p]));

    // Smoothly interpolate bike positions and rotations
    for (const [playerId, mesh] of this.bikeMeshes) {
      if (!mesh.alive) continue;
      mesh.body.position.x += (mesh.targetX - mesh.body.position.x) * posAlpha;
      mesh.body.position.z += (mesh.targetZ - mesh.body.position.z) * posAlpha;
      const player = playerById.get(playerId);
      const jumpY = player?.isJumping ? 0.95 : 0.3;
      mesh.body.position.y += (jumpY - mesh.body.position.y) * Math.min(1, posAlpha * 2.4);
      mesh.light.position.x = mesh.body.position.x;
      mesh.light.position.z = mesh.body.position.z;
      mesh.light.position.y = mesh.body.position.y + 0.35;

      // Smooth rotation — take the shortest angular path to avoid spinning the wrong way
      const delta = shortestAngleDelta(mesh.body.rotation.y, mesh.targetRotY);
      mesh.body.rotation.y += delta * rotAlpha;

      // Pulse emissive intensity when player is boosting
      if (player?.isBoosting) {
        (mesh.body.material as THREE.MeshStandardMaterial).emissiveIntensity = 4.5;
        mesh.light.intensity = 8.0;
      } else {
        const mat = mesh.body.material as THREE.MeshStandardMaterial;
        if (mat.emissiveIntensity > 1.1) mat.emissiveIntensity *= 0.88;
        if (mesh.light.intensity > 3.0) mesh.light.intensity *= 0.88;
      }
    }

    // Power-up float / spin
    const t = performance.now() * 0.001;
    for (const mesh of this.powerUpMeshes.values()) {
      mesh.rotation.y += dt * 2.8;
      mesh.position.y = POWERUP_BASE_HEIGHT + Math.sin(
        t * POWERUP_FLOAT_SPEED +
        mesh.position.x * POWERUP_FLOAT_PHASE_SCALE +
        mesh.position.z * POWERUP_FLOAT_PHASE_SCALE,
      ) * POWERUP_FLOAT_AMPLITUDE;
    }

    // Interpolate FOV toward target for current speed level
    const speedLevel = Math.min(this.lobbyState.speedLevel, SPEED_FOV.length - 1);
    const targetFov = SPEED_FOV[speedLevel];
    this.currentFov += (targetFov - this.currentFov) * Math.min(1, dt * 2.5);
    if (Math.abs(this.currentFov - this.camera.fov) > 0.05) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }

    // Camera: follow-behind when alive; slow top-down orbit when spectating
    const myBike = this.bikeMeshes.get(this.myPlayerId);
    const iAmAlive = myBike?.alive === true;

    if (iAmAlive) {
      const rot = myBike!.body.rotation.y;
      const dirX = -Math.sin(rot);
      const dirZ = -Math.cos(rot);
      const desiredX = myBike!.body.position.x - dirX * CAMERA_FOLLOW_DISTANCE;
      const desiredY = myBike!.body.position.y + CAMERA_HEIGHT;
      const desiredZ = myBike!.body.position.z - dirZ * CAMERA_FOLLOW_DISTANCE;
      this.camera.position.x += (desiredX - this.camera.position.x) * cameraAlpha;
      this.camera.position.y += (desiredY - this.camera.position.y) * cameraAlpha;
      this.camera.position.z += (desiredZ - this.camera.position.z) * cameraAlpha;

      let shakeX = 0, shakeY = 0, shakeZ = 0;
      if (this.cameraShake.intensity > 0.001) {
        const s = this.cameraShake.intensity;
        shakeX = (Math.random() - 0.5) * s;
        shakeY = (Math.random() - 0.5) * s * 0.35;
        shakeZ = (Math.random() - 0.5) * s;
        this.cameraShake.intensity *= this.cameraShake.decay;
      }
      this.camera.position.x += shakeX;
      this.camera.position.y += shakeY;
      this.camera.position.z += shakeZ;
      this.camera.lookAt(
        myBike!.body.position.x + dirX * CAMERA_LOOK_AHEAD,
        myBike!.body.position.y + 0.5,
        myBike!.body.position.z + dirZ * CAMERA_LOOK_AHEAD,
      );
    } else {
      // Spectator: slowly orbit top-down so eliminated players can watch
      const orbitT = t * 0.07;
      const orbitR = ARENA_HALF * 0.7;
      const spectX = ARENA_HALF + Math.cos(orbitT) * orbitR;
      const spectY = ARENA_HALF * 1.4;
      const spectZ = ARENA_HALF + Math.sin(orbitT) * orbitR;
      this.camera.position.x += (spectX - this.camera.position.x) * 0.012;
      this.camera.position.y += (spectY - this.camera.position.y) * 0.012;
      this.camera.position.z += (spectZ - this.camera.position.z) * 0.012;
      this.camera.lookAt(ARENA_HALF, 0, ARENA_HALF);
    }

    this.drawMinimap();
    this.sendInput();
    this.composer.render();
  };

  // ─── Cleanup ─────────────────────────────────────────────────────────────────

  public destroy(): void {
    cancelAnimationFrame(this.animFrameId);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.keyDownHandler);
    window.removeEventListener('keyup',   this.keyUpHandler);

    for (const mesh of this.bikeMeshes.values()) {
      this.scene.remove(mesh.body, mesh.light);
    }
    for (let x = 0; x < ARENA_SIZE; x++) {
      for (let z = 0; z < ARENA_SIZE; z++) {
        const m = this.trailMeshes[x]?.[z];
        if (m) this.scene.remove(m);
      }
    }
    for (const powerUpMesh of this.powerUpMeshes.values()) {
      this.scene.remove(powerUpMesh);
      powerUpMesh.geometry.dispose();
      (powerUpMesh.material as THREE.Material).dispose();
    }
    this.powerUpMeshes.clear();
    for (const geo of this.trailGeos) geo.dispose();
    for (const mat of this.trailMats) mat.dispose();
    this.renderer.dispose();
  }
}
