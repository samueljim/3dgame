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
/** Bloom intensity to restore to (base) and what to spike to on speed-up. */
const BLOOM_BASE = 3.2;
const BLOOM_SPIKE = 9.0;
const BLOOM_DECAY_RATE = 5;

/** Bike lean (bank) constants. */
const LEAN_MAX = 0.38;   // radians (~22°)
const LEAN_DECAY = 5.8;  // exponential decay rate (per second)
const LEAN_ALPHA = 8.0;  // spring speed for body.rotation.z → leanZ

/** Trail-cell spawn flash light constants. */
const TRAIL_FLASH_INTENSITY = 7.5;
const TRAIL_FLASH_DURATION  = 0.22; // seconds
const TRAIL_FLASH_CAP       = 4;    // max concurrent flash lights (WebGL budget)

/** Near-miss detection throttle (ms). */
const NEAR_MISS_COOLDOWN_MS = 300;

/** Power-up animation constants. */
const POWERUP_ROTATION_SPEED    = 2.8;
const POWERUP_GEOMETRY_DETAIL   = 0;

/** FOV interpolation rate (per second). */
const FOV_INTERP_RATE = 2.5;

/** Spectator camera constants. */
const SPECTATOR_ORBIT_SPEED     = 0.07;
const SPECTATOR_ORBIT_RADIUS_MULT = 0.7;
const SPECTATOR_CAMERA_INTERP   = 0.012;

/** Minimap rendering constants. */
const MINIMAP_CELL_OVERLAP        = 0.5;  // prevents sub-pixel gaps between cells
const MINIMAP_POWERUP_HALF_SIZE   = 1.5;
const MINIMAP_POWERUP_SIZE        = 3;
const MINIMAP_MY_PLAYER_RADIUS    = 3.5;
const MINIMAP_OTHER_PLAYER_RADIUS = 2.2;

/** Map direction → Y rotation (radians) for bike mesh. */
const DIR_TO_ROT: Record<Direction, number> = {
  N: 0,
  S: Math.PI,
  E: -Math.PI / 2,
  W: Math.PI / 2,
};

interface BikeMesh {
  /** Root transform — all position/rotation/lean is applied here. */
  group: THREE.Group;
  /** The hull mesh — kept for material access. */
  body: THREE.Mesh;
  light: THREE.PointLight;
  /** A downward glow spot parked inside the group. */
  underGlow: THREE.PointLight;
  targetX: number;
  targetZ: number;
  targetRotY: number;
  /** Previous targetRotY — used to detect turns and kick the lean. */
  prevTargetRotY: number;
  /** Current lean target angle (radians, springs toward 0). */
  leanZ: number;
  alive: boolean;
}

interface TrailFlash {
  light: THREE.PointLight;
  life: number;
  maxLife: number;
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
  private bloomEffect!: BloomEffect;
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

  // Trail-cell spawn flash lights
  private trailFlashes: TrailFlash[] = [];

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

  // Speed level tracking for level-up effects
  private prevSpeedLevel = 0;

  // Near-miss cooldown
  private lastNearMissTime = 0;

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
    this.bloomEffect = new BloomEffect({ intensity: BLOOM_BASE, luminanceThreshold: 0.06, radius: 0.95 });
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new EffectPass(
      this.camera,
      this.bloomEffect,
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
    const wx = player.position.x * CELL_SIZE;
    const wz = player.position.z * CELL_SIZE;
    const targetRotY = DIR_TO_ROT[player.direction] ?? 0;

    const bodyMat = new THREE.MeshStandardMaterial({
      color: colorHex,
      emissive: colorHex,
      emissiveIntensity: 1.1,
      roughness: 0.15,
      metalness: 0.7,
    });

    // ── Hull: slightly lower profile than before ─────────────────────────────
    const bodyGeo = new THREE.BoxGeometry(0.46 * CELL_SIZE, 0.18 * CELL_SIZE, 0.88 * CELL_SIZE);
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.3; // local Y inside the group

    // ── Rear fin (iconic Tron silhouette) ─────────────────────────────────────
    // Thin, tall blade at the rear of the hull
    const finGeo = new THREE.BoxGeometry(0.055 * CELL_SIZE, 0.46 * CELL_SIZE, 0.26 * CELL_SIZE);
    const fin = new THREE.Mesh(finGeo, bodyMat);
    fin.position.set(0, 0.5, -0.3 * CELL_SIZE); // above + behind hull centre (local space)

    // ── Group ────────────────────────────────────────────────────────────────
    const group = new THREE.Group();
    group.position.set(wx, 0, wz);
    group.rotation.y = targetRotY;
    group.add(body, fin);
    this.scene.add(group);

    // ── Point light — wide enough to glow on nearby trail ────────────────────
    const light = new THREE.PointLight(colorHex, 3.0, CELL_SIZE * 5.5);
    light.position.set(wx, 0.6, wz);
    this.scene.add(light);

    // ── Under-carriage glow ──────────────────────────────────────────────────
    // A dim coloured pool cast downward from below the bike
    const underGlow = new THREE.PointLight(colorHex, 1.2, CELL_SIZE * 2.2);
    underGlow.position.set(wx, 0.05, wz);
    this.scene.add(underGlow);

    this.bikeMeshes.set(player.id, {
      group, body, light, underGlow,
      targetX: wx, targetZ: wz,
      targetRotY,
      prevTargetRotY: targetRotY,
      leanZ: 0,
      alive: true,
    });
  }

  // ─── State Update ────────────────────────────────────────────────────────────

  public updateState(newState: LobbyState): void {
    const prevPlayers = new Map(this.lobbyState.players.map(p => [p.id, p]));

    // Speed level-up effect (before overwriting lobbyState)
    if (newState.speedLevel > this.prevSpeedLevel) {
      this.prevSpeedLevel = newState.speedLevel;
      this.bloomEffect.intensity = BLOOM_SPIKE;
      this.cameraShake.intensity = Math.max(this.cameraShake.intensity, 0.45);
      this.soundManager.playSpeedUp();
    }
    this.prevSpeedLevel = newState.speedLevel;

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
        mesh.group.visible = true;
        (mesh.body.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.1;
        mesh.light.intensity = 3.0;
        mesh.underGlow.intensity = 1.2;
      }

      // Detect power-up pickup (charges increased) — play sound for local player
      if (player.id === this.myPlayerId && prev) {
        if (player.jumpCharges > prev.jumpCharges || player.boostCharges > prev.boostCharges) {
          this.soundManager.playPickup();
        }
        if (player.isBoosting && !prev.isBoosting) {
          this.soundManager.playBoost();
        }
        // Turn crackle: direction changed
        if (prev.direction !== player.direction) {
          this.soundManager.playTurn();
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
          onComplete: () => { mesh.group.visible = false; },
        });
      },
    });
    gsap.to(mesh.light, { intensity: 0, duration: 0.35 });
    gsap.to(mesh.underGlow, { intensity: 0, duration: 0.35 });

    // Debris ring
    const count = 16;
    for (let i = 0; i < count; i++) {
      const geo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
      const mat = new THREE.MeshStandardMaterial({
        color: colorHex, emissive: colorHex, emissiveIntensity: 2.5,
      });
      const debris = new THREE.Mesh(geo, mat);
      debris.position.set(
        mesh.group.position.x,
        mesh.group.position.y + 0.3,
        mesh.group.position.z,
      );
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

            // Spawn a brief coloured flash light at the new cell (capped for perf)
            if (this.trailFlashes.length < TRAIL_FLASH_CAP) {
              const colorName = PLAYER_COLORS[colorIdx];
              const colorHex = PLAYER_COLORS_HEX[colorName] ?? 0xffffff;
              const fl = new THREE.PointLight(colorHex, TRAIL_FLASH_INTENSITY, CELL_SIZE * 3.5);
              fl.position.set(x * CELL_SIZE, yCenter, z * CELL_SIZE);
              this.scene.add(fl);
              this.trailFlashes.push({ light: fl, life: TRAIL_FLASH_DURATION, maxLife: TRAIL_FLASH_DURATION });
            }
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
      const geo = new THREE.OctahedronGeometry(CELL_SIZE * POWERUP_SIZE_RATIO, POWERUP_GEOMETRY_DETAIL);
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
        ctx.fillRect(x * scale, z * scale, scale + MINIMAP_CELL_OVERLAP, scale + MINIMAP_CELL_OVERLAP);
      }
    }

    // Power-ups
    for (const pu of this.lobbyState.powerUps) {
      ctx.fillStyle = pu.type === 'boost' ? '#ffcc00' : '#ff66ff';
      const cx = pu.position.x * scale + scale * 0.5;
      const cz = pu.position.z * scale + scale * 0.5;
      ctx.fillRect(cx - MINIMAP_POWERUP_HALF_SIZE, cz - MINIMAP_POWERUP_HALF_SIZE, MINIMAP_POWERUP_SIZE, MINIMAP_POWERUP_SIZE);
    }

    // Players
    for (const player of this.lobbyState.players) {
      if (!player.isAlive) continue;
      const isMe = player.id === this.myPlayerId;
      ctx.fillStyle = MINIMAP_COLORS[player.color] ?? '#ffffff';
      const px = player.position.x * scale + scale * 0.5;
      const pz = player.position.z * scale + scale * 0.5;
      const r = isMe ? MINIMAP_MY_PLAYER_RADIUS : MINIMAP_OTHER_PLAYER_RADIUS;
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

    const posAlpha    = 1 - Math.pow(INTERP_BASE, dt * INTERP_TARGET_FPS);
    const rotAlpha    = 1 - Math.pow(ROT_INTERP_BASE, dt * INTERP_TARGET_FPS);
    const cameraAlpha = 1 - Math.pow(CAMERA_INTERP_BASE, dt * INTERP_TARGET_FPS);
    const playerById  = new Map(this.lobbyState.players.map(p => [p.id, p]));

    // ── Bike interpolation, lean, under-glow, boost pulse ──────────────────
    for (const [playerId, mesh] of this.bikeMeshes) {
      if (!mesh.alive) continue;

      // Position
      mesh.group.position.x += (mesh.targetX - mesh.group.position.x) * posAlpha;
      mesh.group.position.z += (mesh.targetZ - mesh.group.position.z) * posAlpha;
      const player = playerById.get(playerId);
      const jumpY = player?.isJumping ? 0.65 : 0;
      mesh.group.position.y += (jumpY - mesh.group.position.y) * Math.min(1, posAlpha * 2.4);

      // Rotation (Y) — shortest path to avoid spinning the wrong way
      const rotDelta = shortestAngleDelta(mesh.group.rotation.y, mesh.targetRotY);
      mesh.group.rotation.y += rotDelta * rotAlpha;

      // Lean (Z) — kick when a new target rotation is registered, spring back to 0
      const turnDelta = shortestAngleDelta(mesh.prevTargetRotY, mesh.targetRotY);
      if (Math.abs(turnDelta) > 0.01) {
        // A turn was just registered — kick the lean in the turn direction
        mesh.leanZ = turnDelta > 0 ? LEAN_MAX : -LEAN_MAX;
      }
      mesh.prevTargetRotY = mesh.targetRotY;
      // Spring body.rotation.z toward leanZ, then decay leanZ toward 0
      mesh.group.rotation.z += (-mesh.leanZ - mesh.group.rotation.z) * Math.min(1, dt * LEAN_ALPHA);
      mesh.leanZ *= Math.max(0, 1 - dt * LEAN_DECAY);

      // Lights follow group
      mesh.light.position.x = mesh.group.position.x;
      mesh.light.position.z = mesh.group.position.z;
      mesh.light.position.y = mesh.group.position.y + 0.65;
      mesh.underGlow.position.x = mesh.group.position.x;
      mesh.underGlow.position.z = mesh.group.position.z;
      mesh.underGlow.position.y = mesh.group.position.y + 0.04;

      // Boost visual pulse
      if (player?.isBoosting) {
        (mesh.body.material as THREE.MeshStandardMaterial).emissiveIntensity = 4.5;
        mesh.light.intensity = 8.0;
        mesh.underGlow.intensity = 3.5;
      } else {
        const mat = mesh.body.material as THREE.MeshStandardMaterial;
        if (mat.emissiveIntensity > 1.1) mat.emissiveIntensity *= 0.88;
        if (mesh.light.intensity > 3.0) mesh.light.intensity *= 0.88;
        if (mesh.underGlow.intensity > 1.2) mesh.underGlow.intensity *= 0.88;
      }
    }

    // ── Trail flash lights ─────────────────────────────────────────────────
    for (let i = this.trailFlashes.length - 1; i >= 0; i--) {
      const fl = this.trailFlashes[i];
      fl.life -= dt;
      if (fl.life <= 0) {
        this.scene.remove(fl.light);
        this.trailFlashes.splice(i, 1);
      } else {
        fl.light.intensity = TRAIL_FLASH_INTENSITY * (fl.life / fl.maxLife);
      }
    }

    // ── Power-up float / spin ──────────────────────────────────────────────
    const t = performance.now() * 0.001;
    for (const mesh of this.powerUpMeshes.values()) {
      mesh.rotation.y += dt * POWERUP_ROTATION_SPEED;
      mesh.position.y = POWERUP_BASE_HEIGHT + Math.sin(
        t * POWERUP_FLOAT_SPEED +
        mesh.position.x * POWERUP_FLOAT_PHASE_SCALE +
        mesh.position.z * POWERUP_FLOAT_PHASE_SCALE,
      ) * POWERUP_FLOAT_AMPLITUDE;
    }

    // ── Bloom decay after speed-up spike ──────────────────────────────────
    if (this.bloomEffect.intensity > BLOOM_BASE) {
      this.bloomEffect.intensity += (BLOOM_BASE - this.bloomEffect.intensity) * Math.min(1, dt * BLOOM_DECAY_RATE);
    }

    // ── FOV interpolation ─────────────────────────────────────────────────
    const speedLevel = Math.min(this.lobbyState.speedLevel, SPEED_FOV.length - 1);
    const targetFov = SPEED_FOV[speedLevel];
    this.currentFov += (targetFov - this.currentFov) * Math.min(1, dt * FOV_INTERP_RATE);
    if (Math.abs(this.currentFov - this.camera.fov) > 0.05) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }

    // ── Camera: follow behind when alive, orbit when spectating ──────────
    const myBike = this.bikeMeshes.get(this.myPlayerId);
    const iAmAlive = myBike?.alive === true;

    if (iAmAlive) {
      const rot  = myBike!.group.rotation.y;
      const dirX = -Math.sin(rot);
      const dirZ = -Math.cos(rot);
      const desiredX = myBike!.group.position.x - dirX * CAMERA_FOLLOW_DISTANCE;
      const desiredY = myBike!.group.position.y + CAMERA_HEIGHT;
      const desiredZ = myBike!.group.position.z - dirZ * CAMERA_FOLLOW_DISTANCE;
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
        myBike!.group.position.x + dirX * CAMERA_LOOK_AHEAD,
        myBike!.group.position.y + 0.5,
        myBike!.group.position.z + dirZ * CAMERA_LOOK_AHEAD,
      );

      // ── Near-miss detection ─────────────────────────────────────────────
      const nowMs = performance.now();
      if (nowMs - this.lastNearMissTime > NEAR_MISS_COOLDOWN_MS) {
        const myPlayer = this.lobbyState.players.find(p => p.id === this.myPlayerId);
        if (myPlayer?.isAlive) {
          const { x, z } = myPlayer.position;
          const myColorIdx = PLAYER_COLORS.indexOf(myPlayer.color) + 1; // 1-based
          const dir = myPlayer.direction;
          // Check the two cells perpendicular to the heading direction
          const sides: Array<[number, number]> = (dir === 'N' || dir === 'S')
            ? [[x - 1, z], [x + 1, z]]
            : [[x, z - 1], [x, z + 1]];
          for (const [nx, nz] of sides) {
            if (nx < 0 || nx >= ARENA_SIZE || nz < 0 || nz >= ARENA_SIZE) continue;
            const cell = this.lobbyState.trail[nx]?.[nz] ?? 0;
            if (cell !== 0 && cell !== myColorIdx) {
              this.lastNearMissTime = nowMs;
              this.cameraShake.intensity = Math.max(this.cameraShake.intensity, 0.18);
              this.soundManager.playNearMiss();
              break;
            }
          }
        }
      }
    } else {
      // Spectator: slowly orbit top-down so eliminated players can watch
      const orbitT = t * SPECTATOR_ORBIT_SPEED;
      const orbitR = ARENA_HALF * SPECTATOR_ORBIT_RADIUS_MULT;
      const spectX = ARENA_HALF + Math.cos(orbitT) * orbitR;
      const spectY = ARENA_HALF * 1.4;
      const spectZ = ARENA_HALF + Math.sin(orbitT) * orbitR;
      this.camera.position.x += (spectX - this.camera.position.x) * SPECTATOR_CAMERA_INTERP;
      this.camera.position.y += (spectY - this.camera.position.y) * SPECTATOR_CAMERA_INTERP;
      this.camera.position.z += (spectZ - this.camera.position.z) * SPECTATOR_CAMERA_INTERP;
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
      this.scene.remove(mesh.group, mesh.light, mesh.underGlow);
      // Dispose per-bike body material (fin shares it)
      (mesh.body.material as THREE.MeshStandardMaterial).dispose();
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
    for (const fl of this.trailFlashes) {
      this.scene.remove(fl.light);
    }
    this.powerUpMeshes.clear();
    this.trailFlashes.length = 0;
    for (const geo of this.trailGeos) geo.dispose();
    for (const mat of this.trailMats) mat.dispose();
    this.renderer.dispose();
  }
}

