import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, VignetteEffect } from 'postprocessing';
import { gsap } from 'gsap';
import type { LobbyState, Player, ClientMessage, Direction, PowerUp, InputKeys, TrailSegment } from '@shared/types';
import {
  ARENA_WORLD_SIZE,
  PLAYER_COLORS,
  SPEED_LEVEL_THRESHOLDS,
  BIKE_SPEEDS,
  TICK_RATE,
} from '@shared/types';
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

const ARENA_HALF = ARENA_WORLD_SIZE / 2;

/** Milliseconds between input messages sent to the server (~25 per second). */
const INPUT_THROTTLE_MS = 40;

/** Rotation interpolation spring. */
const ROT_INTERP_BASE    = 0.008;
const INTERP_TARGET_FPS  = 60;
const CAMERA_INTERP_BASE = 0.03;

const CAMERA_FOLLOW_DISTANCE = 12.6;
const CAMERA_HEIGHT          = 4.65;
const CAMERA_LOOK_AHEAD      = 5.85;

const POWERUP_SIZE           = 0.34;
const POWERUP_EMISSIVE       = 2.7;
const POWERUP_BASE_HEIGHT    = 0.9;
const POWERUP_FLOAT_SPEED    = 4;
const POWERUP_FLOAT_AMP      = 0.12;
const POWERUP_ROT_SPEED      = 2.8;

/** Trail wall visual dimensions. */
const TRAIL_WIDTH    = 0.12; // world units — thin ribbon
const TRAIL_HEIGHT   = 1.05;
const TRAIL_Y_CENTER = TRAIL_HEIGHT / 2;

/** Target camera FOV per speed level. */
const SPEED_FOV = [55, 62, 70, 80] as const;
const FOV_INTERP_RATE = 2.5;

/** Bloom constants. */
const BLOOM_BASE       = 3.2;
const BLOOM_SPIKE      = 9.0;
const BLOOM_DECAY_RATE = 5;

/** Bike lean constants. */
const LEAN_MAX   = 0.38;
const LEAN_DECAY = 5.8;
const LEAN_ALPHA = 8.0;

/** Spectator camera. */
const SPECTATOR_ORBIT_SPEED  = 0.07;
const SPECTATOR_ORBIT_RADIUS = ARENA_HALF * 0.7;
const SPECTATOR_CAM_INTERP   = 0.012;

/** Map direction → Y rotation (radians) for the bike mesh. */
const DIR_TO_ROT: Record<Direction, number> = {
  N: 0,
  S: Math.PI,
  E: -Math.PI / 2,
  W:  Math.PI / 2,
};

function shortestAngleDelta(a: number, b: number): number {
  return ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

interface BikeMesh {
  group: THREE.Group;
  body:  THREE.Mesh;
  light: THREE.PointLight;
  underGlow: THREE.PointLight;
  targetX: number;
  targetZ: number;
  targetRotY: number;
  prevTargetRotY: number;
  leanZ: number;
  startX: number;
  startZ: number;
  moveStartAt: number;
  /** Duration (ms) to interpolate over — updated to actual inter-update interval. */
  moveDuration: number;
  alive: boolean;
}

export class TronBikesGame {
  private renderer: THREE.WebGLRenderer;
  private scene:    THREE.Scene;
  private camera:   THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloomEffect!: BloomEffect;
  private animFrameId = 0;
  private clock: THREE.Clock;
  private ws: WebSocket;
  private myPlayerId: string;
  private lobbyState: LobbyState;
  private soundManager: SoundManager;

  private bikeMeshes:   Map<string, BikeMesh>    = new Map();
  private powerUpMeshes: Map<string, THREE.Mesh> = new Map();

  // Trail rendering
  /** One shared unit-length (Z=1) box geometry for all trail meshes. */
  private trailUnitGeo!: THREE.BoxGeometry;
  /** One MeshStandardMaterial per player colour. */
  private trailMats: THREE.MeshStandardMaterial[] = [];
  /** Meshes for completed (frozen) segments, keyed by segment ID. */
  private trailSegMeshes: Map<string, THREE.Mesh> = new Map();
  /** Meshes for each player's currently-growing active segment, keyed by player ID. */
  private activeSegMeshes: Map<string, THREE.Mesh> = new Map();

  // Input
  private keys: InputKeys = { left: false, right: false, space: false, shift: false };
  private lastInputSent = 0;
  private keyDownHandler!: (e: KeyboardEvent) => void;
  private keyUpHandler!:   (e: KeyboardEvent) => void;

  // Camera shake
  private cameraShake = { intensity: 0, decay: 0.88 };

  // Current interpolated FOV
  private currentFov = 55;

  // Speed level tracking
  private prevSpeedLevel = 0;

  /** Timestamp of the last received server state update (ms). */
  private lastStateUpdateAt = 0;

  constructor(
    canvas: HTMLCanvasElement,
    ws: WebSocket,
    myPlayerId: string,
    initialState: LobbyState,
    soundManager: SoundManager,
    _minimapCanvas?: HTMLCanvasElement, // kept for API compatibility, not used
  ) {
    this.ws           = ws;
    this.myPlayerId   = myPlayerId;
    this.lobbyState   = initialState;
    this.clock        = new THREE.Clock();
    this.soundManager = soundManager;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.4;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000510);
    this.scene.fog = new THREE.FogExp2(0x000510, 0.003);

    // Camera
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 800);
    this.camera.position.set(ARENA_HALF, CAMERA_HEIGHT * 1.8, ARENA_HALF + CAMERA_FOLLOW_DISTANCE);
    this.camera.lookAt(ARENA_HALF, 0, ARENA_HALF);

    // Post-processing
    this.bloomEffect = new BloomEffect({ intensity: BLOOM_BASE, luminanceThreshold: 0.06, radius: 0.95 });
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new EffectPass(this.camera, this.bloomEffect, new VignetteEffect({ darkness: 0.55 })));

    // Shared trail geometry (unit length along Z, scaled per segment)
    this.trailUnitGeo = new THREE.BoxGeometry(TRAIL_WIDTH, TRAIL_HEIGHT, 1);

    // One material per player colour
    for (const colorName of PLAYER_COLORS) {
      const hex = PLAYER_COLORS_HEX[colorName] ?? 0xffffff;
      this.trailMats.push(new THREE.MeshStandardMaterial({
        color: hex,
        emissive: hex,
        emissiveIntensity: 2.4,
        roughness: 0.12,
        metalness: 0.5,
      }));
    }

    this.setupScene();
    this.setupBikes();
    this.setupInputHandlers();
    window.addEventListener('resize', this.onResize);
    this.animate();
  }

  // ─── Scene Setup ─────────────────────────────────────────────────────────

  private setupScene(): void {
    this.scene.add(new THREE.AmbientLight(0x020220, 0.5));

    const dir = new THREE.DirectionalLight(0x4466bb, 0.45);
    dir.position.set(ARENA_HALF, 60, ARENA_HALF + 40);
    this.scene.add(dir);

    const under = new THREE.DirectionalLight(0x002244, 0.3);
    under.position.set(ARENA_HALF, -20, ARENA_HALF);
    this.scene.add(under);

    // Floor
    const W = ARENA_WORLD_SIZE;
    const floorSpan = Math.max(W * 12, 1600);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(floorSpan, floorSpan),
      new THREE.MeshStandardMaterial({ color: 0x000c18, roughness: 0.98 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(ARENA_HALF, -0.02, ARENA_HALF);
    this.scene.add(floor);

    const glowLight = new THREE.PointLight(0x0033aa, 1.2, floorSpan * 0.6);
    glowLight.position.set(ARENA_HALF, -1, ARENA_HALF);
    this.scene.add(glowLight);

    // Arena border walls
    this.buildBorderWalls();

    // Stars
    const starCount = 700;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      starPos[i * 3]     = (Math.random() - 0.5) * 2400;
      starPos[i * 3 + 1] = Math.random() * 100 + 25;
      starPos[i * 3 + 2] = (Math.random() - 0.5) * 2400;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.22, sizeAttenuation: true })));
  }

  private buildBorderWalls(): void {
    const W = ARENA_WORLD_SIZE;
    const H = 2.0, T = 0.3;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x001833, emissive: 0x0066ff, emissiveIntensity: 2.2, roughness: 0.1, metalness: 0.95,
    });
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

  // ─── Bikes ───────────────────────────────────────────────────────────────

  private setupBikes(): void {
    for (const player of this.lobbyState.players) this.createBikeMesh(player);
  }

  private createBikeMesh(player: Player): void {
    const colorHex = PLAYER_COLORS_HEX[player.color] ?? 0xffffff;
    const wx = player.position.x;
    const wz = player.position.z;
    const targetRotY = DIR_TO_ROT[player.direction] ?? 0;

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xdbe7ff, emissive: colorHex, emissiveIntensity: 0.62, roughness: 0.11, metalness: 0.94,
    });
    const bodyGeo  = new THREE.CapsuleGeometry(0.24, 0.87, 6, 14);
    const body     = new THREE.Mesh(bodyGeo, bodyMat);
    body.rotation.x = Math.PI / 2;
    body.position.y = 0.27;

    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(0.21, 14, 10),
      new THREE.MeshStandardMaterial({ color: 0x99c3ff, emissive: colorHex, emissiveIntensity: 0.38, roughness: 0.06, metalness: 0.86 }),
    );
    canopy.scale.set(1.3, 0.6, 1.05);
    canopy.position.set(0, 0.39, 0.11);

    const stripMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: colorHex, emissiveIntensity: 1.6, roughness: 0.2, metalness: 0.55 });
    const stripGeo = new THREE.BoxGeometry(0.045, 0.10, 1.38);
    const stripL   = new THREE.Mesh(stripGeo, stripMat);
    const stripR   = new THREE.Mesh(stripGeo, stripMat);
    stripL.position.set(-0.285, 0.24, 0);
    stripR.position.set( 0.285, 0.24, 0);

    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0d1020, emissive: colorHex, emissiveIntensity: 0.72, roughness: 0.24, metalness: 0.92 });
    const wheelGeo = new THREE.TorusGeometry(0.21, 0.039, 8, 22);
    const rearWheel = new THREE.Mesh(wheelGeo, wheelMat);
    rearWheel.rotation.y = Math.PI / 2;
    rearWheel.position.set(0, 0.18, -0.465);

    const noseMat = bodyMat;
    const noseGeo = new THREE.ConeGeometry(0.165, 0.42, 12);
    const nose    = new THREE.Mesh(noseGeo, noseMat);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0.24, 0.66);

    const group = new THREE.Group();
    group.position.set(wx, 0, wz);
    group.rotation.y = targetRotY;
    group.add(body, canopy, stripL, stripR, rearWheel, nose);
    this.scene.add(group);

    const light = new THREE.PointLight(colorHex, 3.0, 8.25);
    light.position.set(wx, 0.6, wz);
    this.scene.add(light);

    const underGlow = new THREE.PointLight(colorHex, 1.2, 3.3);
    underGlow.position.set(wx, 0.05, wz);
    this.scene.add(underGlow);

    this.bikeMeshes.set(player.id, {
      group, body, light, underGlow,
      targetX: wx, targetZ: wz,
      targetRotY, prevTargetRotY: targetRotY,
      leanZ: 0,
      startX: wx, startZ: wz,
      moveStartAt: performance.now(),
      moveDuration: TICK_RATE,
      alive: true,
    });

    this.ensureActiveSegMesh(player);
  }

  // ─── State Update ────────────────────────────────────────────────────────

  public updateState(newState: LobbyState): void {
    const prevPlayers = new Map(this.lobbyState.players.map(p => [p.id, p]));

    // Measure actual inter-update interval for accurate interpolation
    const now = performance.now();
    const actualInterval = this.lastStateUpdateAt > 0
      ? Math.min(now - this.lastStateUpdateAt, TICK_RATE * 4) // cap at 4× to handle pauses
      : TICK_RATE;
    this.lastStateUpdateAt = now;

    if (newState.speedLevel > this.prevSpeedLevel) {
      this.prevSpeedLevel = newState.speedLevel;
      this.bloomEffect.intensity = BLOOM_SPIKE;
      this.cameraShake.intensity = Math.max(this.cameraShake.intensity, 0.45);
      this.soundManager.playSpeedUp();
    }
    this.prevSpeedLevel = newState.speedLevel;

    this.lobbyState = newState;

    for (const player of newState.players) {
      let mesh = this.bikeMeshes.get(player.id);
      if (!mesh) {
        this.createBikeMesh(player);
        mesh = this.bikeMeshes.get(player.id)!;
      }

      const prev = prevPlayers.get(player.id);

      if (prev?.isAlive && !player.isAlive) {
        this.playCrashEffect(mesh, player.color);
        this.soundManager.playExplosion();
        this.cameraShake.intensity = Math.max(this.cameraShake.intensity, 0.9);
        const aSeg = this.activeSegMeshes.get(player.id);
        if (aSeg) { this.scene.remove(aSeg); this.activeSegMeshes.delete(player.id); }
      }

      if (player.isAlive && !mesh.alive) {
        mesh.alive = true;
        mesh.group.visible = true;
        (mesh.body.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.1;
        mesh.light.intensity = 3.0;
        mesh.underGlow.intensity = 1.2;
        this.ensureActiveSegMesh(player);
      }

      if (player.id === this.myPlayerId && prev) {
        if (player.jumpCharges > prev.jumpCharges || player.boostCharges > prev.boostCharges)
          this.soundManager.playPickup();
        if (player.isBoosting && !prev.isBoosting)
          this.soundManager.playBoost();
        if (prev.direction !== player.direction)
          this.soundManager.playTurn();
      }

      if (!player.isAlive) continue;

      const wx = player.position.x;
      const wz = player.position.z;
      if (wx !== mesh.targetX || wz !== mesh.targetZ) {
        mesh.startX = mesh.group.position.x;
        mesh.startZ = mesh.group.position.z;
        mesh.moveStartAt = now;
        mesh.moveDuration = actualInterval;
      }
      mesh.targetX = wx;
      mesh.targetZ = wz;
      mesh.targetRotY = DIR_TO_ROT[player.direction] ?? mesh.targetRotY;
    }

    this.syncTrailSegments(newState.trailSegments);
    this.syncPowerUps(newState.powerUps ?? []);
  }

  // ─── Trail Segment Rendering ─────────────────────────────────────────────

  private ensureActiveSegMesh(player: Player): void {
    if (this.activeSegMeshes.has(player.id)) return;
    const colorIdx = PLAYER_COLORS.indexOf(player.color);
    const mat = this.trailMats[colorIdx];
    if (!mat) return;
    const mesh = new THREE.Mesh(this.trailUnitGeo, mat);
    mesh.visible = false;
    this.scene.add(mesh);
    this.activeSegMeshes.set(player.id, mesh);
  }

  private syncTrailSegments(segments: TrailSegment[]): void {
    const currentIds = new Set(segments.map(s => s.id));
    for (const [id, mesh] of this.trailSegMeshes) {
      if (!currentIds.has(id)) {
        this.scene.remove(mesh);
        this.trailSegMeshes.delete(id);
      }
    }

    for (const seg of segments) {
      if (this.trailSegMeshes.has(seg.id)) continue;
      const mat = this.trailMats[seg.colorIndex];
      if (!mat) continue;
      const mesh = new THREE.Mesh(this.trailUnitGeo, mat);
      this.applySegmentTransform(mesh, seg.x1, seg.z1, seg.x2, seg.z2);
      this.scene.add(mesh);
      this.trailSegMeshes.set(seg.id, mesh);
    }
  }

  private applySegmentTransform(
    mesh: THREE.Mesh,
    x1: number, z1: number,
    x2: number, z2: number,
  ): void {
    const dx  = x2 - x1;
    const dz  = z2 - z1;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.01) { mesh.visible = false; return; }
    mesh.visible = true;
    mesh.scale.z = len;
    mesh.position.set((x1 + x2) * 0.5, TRAIL_Y_CENTER, (z1 + z2) * 0.5);
    mesh.rotation.y = Math.atan2(dx, dz);
  }

  // ─── Power-ups ────────────────────────────────────────────────────────────

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
    for (const pu of powerUps) {
      if (this.powerUpMeshes.has(pu.id)) continue;
      const isBoost = pu.type === 'boost';
      const mat = new THREE.MeshStandardMaterial({
        color:    isBoost ? 0xffcc00 : 0xff66ff,
        emissive: isBoost ? 0xffaa00 : 0xff22ee,
        emissiveIntensity: POWERUP_EMISSIVE,
        roughness: 0.15, metalness: 0.75,
      });
      const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(POWERUP_SIZE, 0), mat);
      mesh.position.set(pu.position.x, POWERUP_BASE_HEIGHT, pu.position.z);
      this.powerUpMeshes.set(pu.id, mesh);
      this.scene.add(mesh);
    }
  }

  // ─── Crash Effect ─────────────────────────────────────────────────────────

  private playCrashEffect(mesh: BikeMesh, colorName: string): void {
    mesh.alive = false;
    const colorHex = PLAYER_COLORS_HEX[colorName] ?? 0xffffff;

    gsap.to((mesh.body.material as THREE.MeshStandardMaterial), {
      emissiveIntensity: 5, duration: 0.07,
      onComplete: () => {
        gsap.to((mesh.body.material as THREE.MeshStandardMaterial), {
          emissiveIntensity: 0, duration: 0.35,
          onComplete: () => { mesh.group.visible = false; },
        });
      },
    });
    gsap.to(mesh.light,     { intensity: 0, duration: 0.35 });
    gsap.to(mesh.underGlow, { intensity: 0, duration: 0.35 });

    const count = 16;
    for (let i = 0; i < count; i++) {
      const geo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
      const mat = new THREE.MeshStandardMaterial({ color: colorHex, emissive: colorHex, emissiveIntensity: 2.5 });
      const debris = new THREE.Mesh(geo, mat);
      debris.position.set(mesh.group.position.x, mesh.group.position.y + 0.3, mesh.group.position.z);
      this.scene.add(debris);
      const angle = (i / count) * Math.PI * 2;
      const speed = 1.0 + Math.random() * 1.5;
      gsap.to(debris.position, { x: debris.position.x + Math.cos(angle) * speed * 2, y: debris.position.y + Math.random() * 1.5 + 0.2, z: debris.position.z + Math.sin(angle) * speed * 2, duration: 0.55, ease: 'power2.out' });
      gsap.to(debris.scale, {
        x: 0.01, y: 0.01, z: 0.01, duration: 0.55,
        onComplete: () => { this.scene.remove(debris); geo.dispose(); mat.dispose(); },
      });
    }
  }

  public notifyElimination(_playerName: string): void { /* handled in updateState */ }

  // ─── Input ────────────────────────────────────────────────────────────────

  public setKeys(partial: Partial<typeof this.keys>): void {
    Object.assign(this.keys, partial);
  }

  private setupInputHandlers(): void {
    this.keyDownHandler = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyA': case 'ArrowLeft':           this.keys.left  = true;  e.preventDefault(); break;
        case 'KeyD': case 'ArrowRight':          this.keys.right = true;  e.preventDefault(); break;
        case 'Space':                            this.keys.space = true;  e.preventDefault(); break;
        case 'ShiftLeft': case 'ShiftRight':     this.keys.shift = true;  e.preventDefault(); break;
      }
    };
    this.keyUpHandler = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyA': case 'ArrowLeft':           this.keys.left  = false; break;
        case 'KeyD': case 'ArrowRight':          this.keys.right = false; break;
        case 'Space':                            this.keys.space = false; break;
        case 'ShiftLeft': case 'ShiftRight':     this.keys.shift = false; break;
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
      this.ws.send(JSON.stringify({ type: 'input', keys: { ...this.keys } } as ClientMessage));
    }
  }

  // ─── Render Loop ──────────────────────────────────────────────────────────

  /** Returns the current interpolated world position for a bike, falling back to server position. */
  private getInterpolatedBikePos(playerId: string, player: Player): { x: number; z: number } {
    const bikeMesh = this.bikeMeshes.get(playerId);
    if (bikeMesh) return { x: bikeMesh.group.position.x, z: bikeMesh.group.position.z };
    return { x: player.position.x, z: player.position.z };
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  };

  private animate = (): void => {
    this.animFrameId = requestAnimationFrame(this.animate);
    const dt  = this.clock.getDelta();
    const now = performance.now();

    const rotAlpha    = 1 - Math.pow(ROT_INTERP_BASE,    dt * INTERP_TARGET_FPS);
    const cameraAlpha = 1 - Math.pow(CAMERA_INTERP_BASE, dt * INTERP_TARGET_FPS);
    const playerById  = new Map(this.lobbyState.players.map(p => [p.id, p]));

    // ── Bike interpolation ──────────────────────────────────────────────
    for (const [playerId, mesh] of this.bikeMeshes) {
      if (!mesh.alive) continue;

      const moveT = Math.min(1, (now - mesh.moveStartAt) / Math.max(1, mesh.moveDuration));
      mesh.group.position.x = mesh.startX + (mesh.targetX - mesh.startX) * moveT;
      mesh.group.position.z = mesh.startZ + (mesh.targetZ - mesh.startZ) * moveT;

      const player = playerById.get(playerId);
      const jumpY  = player?.isJumping ? 0.65 : 0;
      mesh.group.position.y += (jumpY - mesh.group.position.y) * Math.min(1, dt * 12);

      const rotDelta = shortestAngleDelta(mesh.group.rotation.y, mesh.targetRotY);
      mesh.group.rotation.y += rotDelta * rotAlpha;

      const turnDelta = shortestAngleDelta(mesh.prevTargetRotY, mesh.targetRotY);
      if (Math.abs(turnDelta) > 0.01) mesh.leanZ = turnDelta > 0 ? LEAN_MAX : -LEAN_MAX;
      mesh.prevTargetRotY = mesh.targetRotY;
      mesh.group.rotation.z += (-mesh.leanZ - mesh.group.rotation.z) * Math.min(1, dt * LEAN_ALPHA);
      mesh.leanZ *= Math.max(0, 1 - dt * LEAN_DECAY);

      mesh.light.position.set(mesh.group.position.x, mesh.group.position.y + 0.65, mesh.group.position.z);
      mesh.underGlow.position.set(mesh.group.position.x, mesh.group.position.y + 0.04, mesh.group.position.z);

      if (player?.isBoosting) {
        (mesh.body.material as THREE.MeshStandardMaterial).emissiveIntensity = 4.5;
        mesh.light.intensity = 8.0;
        mesh.underGlow.intensity = 3.5;
      } else {
        const mat = mesh.body.material as THREE.MeshStandardMaterial;
        if (mat.emissiveIntensity > 1.1) mat.emissiveIntensity *= 0.88;
        if (mesh.light.intensity    > 3.0) mesh.light.intensity    *= 0.88;
        if (mesh.underGlow.intensity > 1.2) mesh.underGlow.intensity *= 0.88;
      }
    }

    // ── Active trail segment meshes (update every frame) ────────────────
    for (const [playerId, mesh] of this.activeSegMeshes) {
      const player = playerById.get(playerId);
      if (!player?.isAlive) {
        mesh.visible = false;
        continue;
      }
      const { x: bx, z: bz } = this.getInterpolatedBikePos(playerId, player);
      this.applySegmentTransform(mesh, player.trailStart.x, player.trailStart.z, bx, bz);
    }

    // ── Power-up float / spin ────────────────────────────────────────────
    const t = performance.now() * 0.001;
    for (const mesh of this.powerUpMeshes.values()) {
      mesh.rotation.y += dt * POWERUP_ROT_SPEED;
      mesh.position.y  = POWERUP_BASE_HEIGHT + Math.sin(t * POWERUP_FLOAT_SPEED + mesh.position.x * 0.07 + mesh.position.z * 0.07) * POWERUP_FLOAT_AMP;
    }

    // ── Bloom decay ──────────────────────────────────────────────────────
    if (this.bloomEffect.intensity > BLOOM_BASE) {
      this.bloomEffect.intensity += (BLOOM_BASE - this.bloomEffect.intensity) * Math.min(1, dt * BLOOM_DECAY_RATE);
    }

    // ── FOV interpolation ────────────────────────────────────────────────
    const speedLevel = Math.min(this.lobbyState.speedLevel, SPEED_FOV.length - 1);
    this.currentFov += (SPEED_FOV[speedLevel] - this.currentFov) * Math.min(1, dt * FOV_INTERP_RATE);
    if (Math.abs(this.currentFov - this.camera.fov) > 0.05) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }

    // ── Camera ───────────────────────────────────────────────────────────
    const myBike    = this.bikeMeshes.get(this.myPlayerId);
    const iAmAlive  = myBike?.alive === true;

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

      if (this.cameraShake.intensity > 0.001) {
        const s = this.cameraShake.intensity;
        this.camera.position.x += (Math.random() - 0.5) * s;
        this.camera.position.y += (Math.random() - 0.5) * s * 0.35;
        this.camera.position.z += (Math.random() - 0.5) * s;
        this.cameraShake.intensity *= this.cameraShake.decay;
      }

      this.camera.lookAt(
        myBike!.group.position.x + dirX * CAMERA_LOOK_AHEAD,
        myBike!.group.position.y + 0.5,
        myBike!.group.position.z + dirZ * CAMERA_LOOK_AHEAD,
      );
    } else {
      const orbitT = t * SPECTATOR_ORBIT_SPEED;
      this.camera.position.x += (ARENA_HALF + Math.cos(orbitT) * SPECTATOR_ORBIT_RADIUS - this.camera.position.x) * SPECTATOR_CAM_INTERP;
      this.camera.position.y += (ARENA_HALF * 1.4 - this.camera.position.y) * SPECTATOR_CAM_INTERP;
      this.camera.position.z += (ARENA_HALF + Math.sin(orbitT) * SPECTATOR_ORBIT_RADIUS - this.camera.position.z) * SPECTATOR_CAM_INTERP;
      this.camera.lookAt(ARENA_HALF, 0, ARENA_HALF);
    }

    this.sendInput();
    this.composer.render();
  };

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  public destroy(): void {
    cancelAnimationFrame(this.animFrameId);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.keyDownHandler);
    window.removeEventListener('keyup',   this.keyUpHandler);

    for (const mesh of this.bikeMeshes.values()) {
      this.scene.remove(mesh.group, mesh.light, mesh.underGlow);
      (mesh.body.material as THREE.MeshStandardMaterial).dispose();
    }
    for (const mesh of this.trailSegMeshes.values()) this.scene.remove(mesh);
    for (const mesh of this.activeSegMeshes.values()) this.scene.remove(mesh);
    for (const mesh of this.powerUpMeshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.trailUnitGeo.dispose();
    for (const mat of this.trailMats) mat.dispose();
    this.renderer.dispose();
  }
}
