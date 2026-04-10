import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, VignetteEffect } from 'postprocessing';
import { gsap } from 'gsap';
import type { LobbyState, Player, ClientMessage, Direction } from '@shared/types';
import { ARENA_SIZE, CELL_SIZE, PLAYER_COLORS } from '@shared/types';
import type { SoundManager } from './SoundManager';

const PLAYER_COLORS_HEX: Record<string, number> = {
  red:    0xff3333,
  green:  0x33ff44,
  yellow: 0xffee33,
  purple: 0xaa33ff,
  blue:   0x3377ff,
  cyan:   0x33ffee,
  orange: 0xff8833,
  pink:   0xff33aa,
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

interface BikeMesh {
  body: THREE.Mesh;
  light: THREE.PointLight;
  targetX: number;
  targetZ: number;
  alive: boolean;
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
      new BloomEffect({ intensity: 2.8, luminanceThreshold: 0.08, radius: 0.9 }),
      new VignetteEffect({ darkness: 0.5 }),
    ));

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
    this.scene.add(new THREE.AmbientLight(0x020218, 0.6));

    // Directional
    const dir = new THREE.DirectionalLight(0x334488, 0.5);
    dir.position.set(ARENA_HALF, 60, ARENA_HALF + 40);
    this.scene.add(dir);

    // Floor
    const W = ARENA_SIZE * CELL_SIZE;
    const floorGeo = new THREE.PlaneGeometry(W + 4, W + 4);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x000d1a, roughness: 0.95 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(ARENA_HALF, -0.02, ARENA_HALF);
    this.scene.add(floor);

    // Grid lines
    const grid = new THREE.GridHelper(W, ARENA_SIZE, 0x003355, 0x001122);
    grid.position.set(ARENA_HALF, 0.02, ARENA_HALF);
    this.scene.add(grid);

    // Arena border glow walls
    this.buildBorderWalls();

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
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.25, sizeAttenuation: true }),
    ));
  }

  private buildBorderWalls(): void {
    const W = ARENA_SIZE * CELL_SIZE;
    const H = 1.8;
    const T = 0.25;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x001833,
      emissive: 0x0055cc,
      emissiveIntensity: 1.8,
      roughness: 0.15,
      metalness: 0.9,
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
    const bodyGeo = new THREE.BoxGeometry(0.55 * CELL_SIZE, 0.22 * CELL_SIZE, 0.85 * CELL_SIZE);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: colorHex,
      emissive: colorHex,
      emissiveIntensity: 0.9,
      roughness: 0.18,
      metalness: 0.65,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    const wx = player.position.x * CELL_SIZE;
    const wz = player.position.z * CELL_SIZE;
    body.position.set(wx, 0.3, wz);
    this.orientBike(body, player.direction);
    this.scene.add(body);

    // Point light
    const light = new THREE.PointLight(colorHex, 2.5, CELL_SIZE * 4);
    light.position.set(wx, 0.6, wz);
    this.scene.add(light);

    this.bikeMeshes.set(player.id, {
      body, light,
      targetX: wx, targetZ: wz,
      alive: true,
    });
  }

  private orientBike(body: THREE.Mesh, dir: Direction): void {
    switch (dir) {
      case 'N': body.rotation.y = 0;              break;
      case 'S': body.rotation.y = Math.PI;        break;
      case 'E': body.rotation.y = -Math.PI / 2;  break;
      case 'W': body.rotation.y = Math.PI / 2;   break;
    }
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
        this.cameraShake.intensity = Math.max(this.cameraShake.intensity, 0.8);
      }

      // Respawn at new round start
      if (player.isAlive && !mesh.alive) {
        mesh.alive = true;
        mesh.body.visible = true;
        mesh.light.intensity = 2.5;
      }

      if (!player.isAlive) continue;

      const wx = player.position.x * CELL_SIZE;
      const wz = player.position.z * CELL_SIZE;
      mesh.targetX = wx;
      mesh.targetZ = wz;
      this.orientBike(mesh.body, player.direction);
    }

    // Update trail meshes (only changed cells)
    this.syncTrail(newState.trail);
  }

  private playCrashEffect(mesh: BikeMesh, colorName: string): void {
    mesh.alive = false;
    const colorHex = PLAYER_COLORS_HEX[colorName] ?? 0xffffff;

    // Flash then hide
    gsap.to((mesh.body.material as THREE.MeshStandardMaterial), {
      emissiveIntensity: 4,
      duration: 0.08,
      onComplete: () => {
        gsap.to((mesh.body.material as THREE.MeshStandardMaterial), {
          emissiveIntensity: 0,
          duration: 0.4,
          onComplete: () => { mesh.body.visible = false; },
        });
      },
    });
    gsap.to(mesh.light, { intensity: 0, duration: 0.4 });

    // Spawn short-lived debris particles
    const count = 12;
    for (let i = 0; i < count; i++) {
      const geo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
      const mat = new THREE.MeshStandardMaterial({
        color: colorHex, emissive: colorHex, emissiveIntensity: 2.0,
      });
      const debris = new THREE.Mesh(geo, mat);
      debris.position.copy(mesh.body.position);
      this.scene.add(debris);
      const angle = (i / count) * Math.PI * 2;
      const speed = 0.8 + Math.random() * 1.2;
      const vx = Math.cos(angle) * speed;
      const vz = Math.sin(angle) * speed;
      gsap.to(debris.position, {
        x: debris.position.x + vx * 2,
        y: debris.position.y + Math.random() * 1.2 + 0.3,
        z: debris.position.z + vz * 2,
        duration: 0.6,
        ease: 'power2.out',
      });
      gsap.to(debris.scale, {
        x: 0.01, y: 0.01, z: 0.01,
        duration: 0.6,
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
          const colorName = PLAYER_COLORS[cur - 1];
          const colorHex  = PLAYER_COLORS_HEX[colorName] ?? 0xffffff;
          const m = this.createTrailSegment(x, z, colorHex);
          this.scene.add(m);
          this.trailMeshes[x][z] = m;
        }
        this.prevTrail[x][z] = cur;
      }
    }
  }

  private createTrailSegment(x: number, z: number, colorHex: number): THREE.Mesh {
    const geo = new THREE.BoxGeometry(CELL_SIZE * 0.78, 1.1, CELL_SIZE * 0.78);
    const mat = new THREE.MeshStandardMaterial({
      color: colorHex,
      emissive: colorHex,
      emissiveIntensity: 1.6,
      roughness: 0.1,
      metalness: 0.8,
      transparent: true,
      opacity: 0.88,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x * CELL_SIZE, 0.55, z * CELL_SIZE);
    return mesh;
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

    // Smoothly interpolate bike positions
    for (const mesh of this.bikeMeshes.values()) {
      if (!mesh.alive) continue;
      const alpha = 1 - Math.pow(INTERP_BASE, dt * INTERP_TARGET_FPS);
      mesh.body.position.x += (mesh.targetX - mesh.body.position.x) * alpha;
      mesh.body.position.z += (mesh.targetZ - mesh.body.position.z) * alpha;
      mesh.light.position.x = mesh.body.position.x;
      mesh.light.position.z = mesh.body.position.z;
      mesh.light.position.y = 0.7;
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
    this.renderer.dispose();
  }
}
