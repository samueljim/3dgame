import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, VignetteEffect } from 'postprocessing';
import { gsap } from 'gsap';
import type { LobbyState, Player, ClientMessage, Direction } from '@shared/types';
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

  // Trail mesh grid — one slot per cell
  private trailMeshes: (THREE.Mesh | null)[][] = [];
  private prevTrail: number[][] = [];

  // Shared geometry and per-colour materials for trail segments (avoids geometry churn)
  private trailGeo!: THREE.BoxGeometry;
  private trailMats: THREE.MeshStandardMaterial[] = [];

  // Input state
  private keys = { w: false, a: false, s: false, d: false, space: false, shift: false };
  private lastInputSent = 0;
  private keyDownHandler!: (e: KeyboardEvent) => void;
  private keyUpHandler!: (e: KeyboardEvent) => void;

  // Camera shake
  private cameraShake = { intensity: 0, decay: 0.88 };

  constructor(
    canvas: HTMLCanvasElement,
    ws: WebSocket,
    myPlayerId: string,
    initialState: LobbyState,
    soundManager: SoundManager,
  ) {
    this.ws = ws;
    this.myPlayerId = myPlayerId;
    this.lobbyState = initialState;
    this.clock = new THREE.Clock();
    this.soundManager = soundManager;

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

    // Camera — angled top-down
    this.camera = new THREE.PerspectiveCamera(
      55, window.innerWidth / window.innerHeight, 0.1, 500,
    );
    const camHeight = ARENA_SIZE * CELL_SIZE * 0.95;
    const camZOff  = ARENA_SIZE * CELL_SIZE * 0.22;
    this.camera.position.set(ARENA_HALF, camHeight, ARENA_HALF + camZOff);
    this.camera.lookAt(ARENA_HALF, 0, ARENA_HALF);

    // Post-processing
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new EffectPass(
      this.camera,
      new BloomEffect({ intensity: 3.2, luminanceThreshold: 0.06, radius: 0.95 }),
      new VignetteEffect({ darkness: 0.55 }),
    ));

    // Pre-build shared trail geometry and one material per player colour
    this.trailGeo = new THREE.BoxGeometry(CELL_SIZE * 0.82, 1.2, CELL_SIZE * 0.82);
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

    // Subtle under-lighting to make trail walls readable from top-down
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

      if (!player.isAlive) continue;

      const wx = player.position.x * CELL_SIZE;
      const wz = player.position.z * CELL_SIZE;
      mesh.targetX = wx;
      mesh.targetZ = wz;
      mesh.targetRotY = DIR_TO_ROT[player.direction] ?? mesh.targetRotY;
    }

    // Update trail meshes (only changed cells)
    this.syncTrail(newState.trail);
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
            const m = new THREE.Mesh(this.trailGeo, mat);
            m.position.set(x * CELL_SIZE, 0.6, z * CELL_SIZE);
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
        case 'ShiftLeft': case 'ShiftRight': this.keys.shift = true; break;
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

    // Smoothly interpolate bike positions and rotations
    for (const mesh of this.bikeMeshes.values()) {
      if (!mesh.alive) continue;
      mesh.body.position.x += (mesh.targetX - mesh.body.position.x) * posAlpha;
      mesh.body.position.z += (mesh.targetZ - mesh.body.position.z) * posAlpha;
      mesh.light.position.x = mesh.body.position.x;
      mesh.light.position.z = mesh.body.position.z;
      mesh.light.position.y = 0.7;

      // Smooth rotation — take the shortest angular path to avoid spinning the wrong way
      const delta = shortestAngleDelta(mesh.body.rotation.y, mesh.targetRotY);
      mesh.body.rotation.y += delta * rotAlpha;
    }

    // Camera shake
    if (this.cameraShake.intensity > 0.001) {
      const s = this.cameraShake.intensity;
      const camH = ARENA_SIZE * CELL_SIZE * 0.95;
      const camZ = ARENA_HALF + ARENA_SIZE * CELL_SIZE * 0.22;
      this.camera.position.set(
        ARENA_HALF + (Math.random() - 0.5) * s,
        camH       + (Math.random() - 0.5) * s * 0.4,
        camZ       + (Math.random() - 0.5) * s,
      );
      this.cameraShake.intensity *= this.cameraShake.decay;
    }

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
    this.trailGeo.dispose();
    for (const mat of this.trailMats) mat.dispose();
    this.renderer.dispose();
  }
}
