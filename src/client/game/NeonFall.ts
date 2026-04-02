import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, VignetteEffect } from 'postprocessing';
import { gsap } from 'gsap';
import * as CANNON from 'cannon-es';
import type { LobbyState, Player, ClientMessage } from '@shared/types';
import { ARENA_SIZE, TILE_SIZE } from '@shared/types';
import type { SoundManager } from './SoundManager';

const PLAYER_COLORS_HEX: Record<string, number> = {
  red: 0xff3333,
  green: 0x33ff44,
  yellow: 0xffee33,
  purple: 0xaa33ff,
  blue: 0x3377ff,
  cyan: 0x33ffee,
  orange: 0xff8833,
  pink: 0xff33aa,
};

interface PlayerMesh {
  sphere: THREE.Mesh;
  ring: THREE.Mesh;
  light: THREE.PointLight;
  trail: THREE.Points;
  trailPositions: Float32Array;
  trailIndex: number;
  prevX: number;
  prevZ: number;
}

interface DebrisParticle {
  mesh: THREE.Mesh;
  body: CANNON.Body;
  life: number;
}

interface GravityWellMesh {
  id: string;
  sphere: THREE.Mesh;
  ring1: THREE.Mesh;
  ring2: THREE.Mesh;
  light: THREE.PointLight;
}

export class NeonFallGame {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private animFrameId: number = 0;
  private tileMeshes: (THREE.Mesh | null)[][] = [];
  private playerMeshes: Map<string, PlayerMesh> = new Map();
  private ws: WebSocket;
  private myPlayerId: string;
  private lobbyState: LobbyState;
  private keys: { w: boolean; a: boolean; s: boolean; d: boolean; space: boolean; shift: boolean } = {
    w: false, a: false, s: false, d: false, space: false, shift: false
  };
  private lastInputSent = 0;
  private clock: THREE.Clock;
  private soundManager: SoundManager;

  private ambientParticles!: THREE.Points;
  private starField!: THREE.Points;

  // Camera shake
  private cameraShake = { intensity: 0, decay: 0.88 };
  private cameraBasePos = new THREE.Vector3();

  // Physics world for debris
  private physicsWorld: CANNON.World;
  private debrisParticles: DebrisParticle[] = [];

  // Track previous tile states for change detection
  private prevTileStates: Map<string, 'solid' | 'crumbling' | 'fallen'> = new Map();

  // Gravity well meshes
  private gravityWellMeshes: Map<string, GravityWellMesh> = new Map();

  constructor(
    canvas: HTMLCanvasElement,
    ws: WebSocket,
    myPlayerId: string,
    initialState: LobbyState,
    soundManager: SoundManager
  ) {
    this.ws = ws;
    this.myPlayerId = myPlayerId;
    this.lobbyState = initialState;
    this.clock = new THREE.Clock();
    this.soundManager = soundManager;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x020208);
    this.scene.fog = new THREE.FogExp2(0x020208, 0.015);

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
    this.camera.position.set(ARENA_SIZE * TILE_SIZE * 0.5, 18, ARENA_SIZE * TILE_SIZE * 0.5 + 15);
    this.camera.lookAt(ARENA_SIZE * TILE_SIZE * 0.5, 0, ARENA_SIZE * TILE_SIZE * 0.5);
    this.cameraBasePos.copy(this.camera.position);

    // Post-processing
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(
      new EffectPass(
        this.camera,
        new BloomEffect({ intensity: 3.0, luminanceThreshold: 0.1, radius: 0.7 }),
        new VignetteEffect({ darkness: 0.4 })
      )
    );

    // Physics
    this.physicsWorld = new CANNON.World();
    this.physicsWorld.gravity.set(0, -20, 0);

    this.setupScene();
    this.buildArena();
    this.setupPlayers();
    this.setupInputHandlers();

    // Init tile state tracking
    for (let x = 0; x < ARENA_SIZE; x++) {
      for (let z = 0; z < ARENA_SIZE; z++) {
        const t = initialState.tiles[x]?.[z];
        if (t) this.prevTileStates.set(`${x},${z}`, t.state);
      }
    }

    window.addEventListener('resize', this.onResize);
    this.animate();
  }

  private setupScene(): void {
    const ambient = new THREE.AmbientLight(0x0a0a1a, 1.0);
    this.scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0x6688aa, 0.8);
    dirLight.position.set(10, 20, 10);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 80;
    dirLight.shadow.camera.left = -25;
    dirLight.shadow.camera.right = 25;
    dirLight.shadow.camera.top = 25;
    dirLight.shadow.camera.bottom = -25;
    this.scene.add(dirLight);

    const hemi = new THREE.HemisphereLight(0x0022aa, 0x001100, 0.3);
    this.scene.add(hemi);

    const arenaLight = new THREE.PointLight(0x004488, 2.0, 30);
    arenaLight.position.set(ARENA_SIZE * TILE_SIZE * 0.5, 5, ARENA_SIZE * TILE_SIZE * 0.5);
    this.scene.add(arenaLight);

    // Starfield
    const starCount = 800;
    const starGeo = new THREE.BufferGeometry();
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      starPositions[i * 3] = (Math.random() - 0.5) * 200;
      starPositions[i * 3 + 1] = Math.random() * 80 + 10;
      starPositions[i * 3 + 2] = (Math.random() - 0.5) * 200;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.15, sizeAttenuation: true });
    this.starField = new THREE.Points(starGeo, starMat);
    this.scene.add(this.starField);

    // Ambient floating particles
    const particleCount = 200;
    const particleGeo = new THREE.BufferGeometry();
    const particlePos = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      particlePos[i * 3] = Math.random() * ARENA_SIZE * TILE_SIZE * 1.5 - 2;
      particlePos[i * 3 + 1] = Math.random() * 8;
      particlePos[i * 3 + 2] = Math.random() * ARENA_SIZE * TILE_SIZE * 1.5 - 2;
    }
    particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePos, 3));
    const particleMat = new THREE.PointsMaterial({
      color: 0x00ffff, size: 0.06, sizeAttenuation: true, transparent: true, opacity: 0.6
    });
    this.ambientParticles = new THREE.Points(particleGeo, particleMat);
    this.scene.add(this.ambientParticles);
  }

  private buildArena(): void {
    const tileGeo = new THREE.BoxGeometry(TILE_SIZE - 0.1, 0.3, TILE_SIZE - 0.1);

    for (let x = 0; x < ARENA_SIZE; x++) {
      this.tileMeshes[x] = [];
      for (let z = 0; z < ARENA_SIZE; z++) {
        const tileState = this.lobbyState.tiles[x]?.[z];
        if (!tileState || tileState.state === 'fallen') {
          this.tileMeshes[x][z] = null;
          continue;
        }
        const tile = this.createTileMesh(tileGeo, x, z);
        this.scene.add(tile);
        this.tileMeshes[x][z] = tile;
      }
    }

    const baseGeo = new THREE.BoxGeometry(
      ARENA_SIZE * TILE_SIZE + 1,
      0.1,
      ARENA_SIZE * TILE_SIZE + 1
    );
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x000820,
      transparent: true,
      opacity: 0.5,
    });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.set(
      (ARENA_SIZE * TILE_SIZE) / 2 - TILE_SIZE / 2,
      -0.2,
      (ARENA_SIZE * TILE_SIZE) / 2 - TILE_SIZE / 2
    );
    this.scene.add(base);

    this.addArenaEdges();
  }

  private createTileMesh(geo: THREE.BoxGeometry, x: number, z: number): THREE.Mesh {
    const isEven = (x + z) % 2 === 0;
    const mat = new THREE.MeshStandardMaterial({
      color: isEven ? 0x002244 : 0x001833,
      emissive: isEven ? 0x001122 : 0x000d1a,
      emissiveIntensity: 0.5,
      roughness: 0.3,
      metalness: 0.8,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x * TILE_SIZE, 0, z * TILE_SIZE);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.userData = { gridX: x, gridZ: z, originalX: x * TILE_SIZE, originalZ: z * TILE_SIZE };
    return mesh;
  }

  private addArenaEdges(): void {
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.5 });
    const arenaW = ARENA_SIZE * TILE_SIZE;
    const y = 0.2;
    const half = TILE_SIZE / 2;
    const points = [
      new THREE.Vector3(-half, y, -half),
      new THREE.Vector3(arenaW - half, y, -half),
      new THREE.Vector3(arenaW - half, y, arenaW - half),
      new THREE.Vector3(-half, y, arenaW - half),
      new THREE.Vector3(-half, y, -half),
    ];
    const edgeGeo = new THREE.BufferGeometry().setFromPoints(points);
    const edge = new THREE.Line(edgeGeo, edgeMat);
    this.scene.add(edge);
  }

  private setupPlayers(): void {
    for (const player of this.lobbyState.players) {
      this.createPlayerMesh(player);
    }
  }

  private createPlayerMesh(player: Player): void {
    const color = PLAYER_COLORS_HEX[player.color] ?? 0xffffff;

    const geo = new THREE.SphereGeometry(0.45, 16, 16);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.6,
      roughness: 0.2,
      metalness: 0.5,
    });
    const sphere = new THREE.Mesh(geo, mat);
    sphere.position.set(
      player.position.x * TILE_SIZE,
      0.7,
      player.position.z * TILE_SIZE
    );
    sphere.castShadow = true;
    this.scene.add(sphere);

    // Orbital ring
    const ringGeo = new THREE.TorusGeometry(0.62, 0.04, 8, 32);
    const ringMat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 1.2,
      roughness: 0.1,
      metalness: 0.9,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 3;
    ring.position.copy(sphere.position);
    this.scene.add(ring);

    const light = new THREE.PointLight(color, 1.5, 4);
    light.position.copy(sphere.position);
    this.scene.add(light);

    // Trail particles
    const trailCount = 30;
    const trailGeo = new THREE.BufferGeometry();
    const trailPositions = new Float32Array(trailCount * 3);
    for (let i = 0; i < trailCount; i++) {
      trailPositions[i * 3] = sphere.position.x;
      trailPositions[i * 3 + 1] = sphere.position.y;
      trailPositions[i * 3 + 2] = sphere.position.z;
    }
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
    const trailMat = new THREE.PointsMaterial({
      color,
      size: 0.15,
      transparent: true,
      opacity: 0.4,
      sizeAttenuation: true,
    });
    const trail = new THREE.Points(trailGeo, trailMat);
    this.scene.add(trail);

    this.playerMeshes.set(player.id, {
      sphere, ring, light, trail, trailPositions, trailIndex: 0,
      prevX: sphere.position.x, prevZ: sphere.position.z,
    });
  }

  public shakeCamera(intensity: number): void {
    this.cameraShake.intensity = Math.max(this.cameraShake.intensity, intensity);
  }

  private spawnTileDebris(wx: number, wz: number): void {
    const debrisGeo = new THREE.BoxGeometry(0.15, 0.15, 0.15);
    for (let i = 0; i < 10; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x334466,
        emissive: 0x001133,
        emissiveIntensity: 0.5,
      });
      const mesh = new THREE.Mesh(debrisGeo, mat);
      mesh.position.set(
        wx + (Math.random() - 0.5) * TILE_SIZE,
        0.5,
        wz + (Math.random() - 0.5) * TILE_SIZE
      );
      this.scene.add(mesh);

      const body = new CANNON.Body({
        mass: 0.1,
        shape: new CANNON.Box(new CANNON.Vec3(0.075, 0.075, 0.075)),
        position: new CANNON.Vec3(mesh.position.x, mesh.position.y, mesh.position.z),
      });
      body.velocity.set(
        (Math.random() - 0.5) * 8,
        Math.random() * 8 + 3,
        (Math.random() - 0.5) * 8
      );
      body.angularVelocity.set(
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10
      );
      this.physicsWorld.addBody(body);
      this.debrisParticles.push({ mesh, body, life: 1.5 });
    }
  }

  public updateState(newState: LobbyState): void {
    const prevPlayers = new Map(this.lobbyState.players.map(p => [p.id, p]));
    this.lobbyState = newState;

    // Update tiles — detect state changes
    for (let x = 0; x < ARENA_SIZE; x++) {
      for (let z = 0; z < ARENA_SIZE; z++) {
        const tileState = newState.tiles[x]?.[z];
        if (!tileState) continue;
        const key = `${x},${z}`;
        const prev = this.prevTileStates.get(key) ?? 'solid';
        const curr = tileState.state;

        if (curr !== prev) {
          if (curr === 'solid' && prev !== 'solid') {
            // Tile was reset (new round start)
            const existingMesh = this.tileMeshes[x]?.[z];
            if (!existingMesh) {
              // Was fallen — create a fresh mesh
              const tileGeo = new THREE.BoxGeometry(TILE_SIZE - 0.1, 0.3, TILE_SIZE - 0.1);
              const mesh = this.createTileMesh(tileGeo, x, z);
              this.scene.add(mesh);
              this.tileMeshes[x][z] = mesh;
            } else {
              // Was crumbling — reset the material and transform back to normal
              const isEven = (x + z) % 2 === 0;
              const mat = existingMesh.material as THREE.MeshStandardMaterial;
              mat.color.setHex(isEven ? 0x002244 : 0x001833);
              mat.emissive.setHex(isEven ? 0x001122 : 0x000d1a);
              mat.emissiveIntensity = 0.5;
              mat.opacity = 1;
              mat.transparent = false;
              existingMesh.position.y = 0;
              existingMesh.position.x = existingMesh.userData.originalX as number;
              existingMesh.position.z = existingMesh.userData.originalZ as number;
              existingMesh.rotation.set(0, 0, 0);
            }
          } else if (curr === 'crumbling' && prev === 'solid') {
            const mesh = this.tileMeshes[x]?.[z];
            if (mesh) {
              this.animateCrumblingTile(mesh);
              this.soundManager.playTileCrumble();
            }
          } else if (curr === 'fallen') {
            const mesh = this.tileMeshes[x]?.[z];
            if (mesh) {
              this.spawnTileDebris(x * TILE_SIZE, z * TILE_SIZE);
              this.animateTileFall(mesh);
              this.tileMeshes[x][z] = null;
            }
            this.soundManager.playTileFall();
            this.shakeCamera(0.5);
          }
          this.prevTileStates.set(key, curr);
        }
      }
    }

    // Update players
    for (const player of newState.players) {
      let playerMesh = this.playerMeshes.get(player.id);

      if (!playerMesh) {
        this.createPlayerMesh(player);
        playerMesh = this.playerMeshes.get(player.id);
      }

      if (!playerMesh) continue;

      const prevPlayer = prevPlayers.get(player.id);
      if (prevPlayer?.isAlive && !player.isAlive) {
        this.animatePlayerDeath(playerMesh, player.color);
        this.soundManager.playExplosion();
        this.shakeCamera(1.0);
      }

      // Restore visibility when a player respawns (new round)
      if (player.isAlive && !playerMesh.sphere.visible) {
        playerMesh.sphere.visible = true;
        playerMesh.ring.visible = true;
        playerMesh.trail.visible = true;
        playerMesh.light.intensity = 1.5;
      }

      if (!player.isAlive) continue;

      const targetX = player.position.x * TILE_SIZE;
      const targetZ = player.position.z * TILE_SIZE;

      const dx = targetX - playerMesh.prevX;
      const dz = targetZ - playerMesh.prevZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > 1.5) {
        this.soundManager.playDash();
        this.spawnDashLines(playerMesh.sphere.position, dx, dz);
      }
      playerMesh.prevX = playerMesh.sphere.position.x;
      playerMesh.prevZ = playerMesh.sphere.position.z;

      playerMesh.sphere.position.x += (targetX - playerMesh.sphere.position.x) * 0.3;
      playerMesh.sphere.position.z += (targetZ - playerMesh.sphere.position.z) * 0.3;
      playerMesh.ring.position.x = playerMesh.sphere.position.x;
      playerMesh.ring.position.z = playerMesh.sphere.position.z;
      playerMesh.light.position.copy(playerMesh.sphere.position);

      const idx = playerMesh.trailIndex * 3;
      playerMesh.trailPositions[idx] = playerMesh.sphere.position.x;
      playerMesh.trailPositions[idx + 1] = playerMesh.sphere.position.y;
      playerMesh.trailPositions[idx + 2] = playerMesh.sphere.position.z;
      playerMesh.trailIndex = (playerMesh.trailIndex + 1) % 30;
      (playerMesh.trail.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

      // Blast wave visual
      if (player.blastActive) {
        this.spawnBlastWave(playerMesh.sphere.position, player.color);
      }
    }

    // Update gravity well meshes
    for (const well of newState.gravityWells) {
      let wellMesh = this.gravityWellMeshes.get(well.id);
      if (!wellMesh) {
        wellMesh = this.createGravityWellMesh(well.id);
      }
      const wx = well.position.x * TILE_SIZE;
      const wz = well.position.z * TILE_SIZE;
      wellMesh.sphere.position.x += (wx - wellMesh.sphere.position.x) * 0.2;
      wellMesh.sphere.position.z += (wz - wellMesh.sphere.position.z) * 0.2;
      wellMesh.ring1.position.copy(wellMesh.sphere.position);
      wellMesh.ring2.position.copy(wellMesh.sphere.position);
      wellMesh.light.position.copy(wellMesh.sphere.position);
    }

    // Remove gravity well meshes that no longer exist
    for (const [id, wellMesh] of this.gravityWellMeshes) {
      if (!newState.gravityWells.find(w => w.id === id)) {
        this.scene.remove(wellMesh.sphere, wellMesh.ring1, wellMesh.ring2, wellMesh.light);
        this.gravityWellMeshes.delete(id);
      }
    }

    const myPlayer = newState.players.find(p => p.id === this.myPlayerId);
    if (myPlayer?.isAlive) {
      const targetX = myPlayer.position.x * TILE_SIZE;
      const targetZ = myPlayer.position.z * TILE_SIZE;
      this.cameraBasePos.x += (targetX - this.cameraBasePos.x) * 0.05;
      this.cameraBasePos.z += (targetZ + 12 - this.cameraBasePos.z) * 0.05;
      this.cameraBasePos.y = 18;
    }
  }

  private animateCrumblingTile(mesh: THREE.Mesh): void {
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.emissive.setHex(0xff4400);
    mat.emissiveIntensity = 1.5;
    mat.color.setHex(0x882200);

    const origX = mesh.userData.originalX as number;
    const origZ = mesh.userData.originalZ as number;
    gsap.to(mesh.position, {
      x: origX + (Math.random() - 0.5) * 0.12,
      duration: 0.08,
      repeat: 24,
      yoyo: true,
      ease: 'none',
      onComplete: () => {
        mesh.position.x = origX;
      },
    });
    gsap.to(mesh.position, {
      z: origZ + (Math.random() - 0.5) * 0.12,
      duration: 0.1,
      repeat: 20,
      yoyo: true,
      ease: 'none',
      onComplete: () => {
        mesh.position.z = origZ;
      },
    });
  }

  private animateTileFall(mesh: THREE.Mesh): void {
    const startY = mesh.position.y;
    const startTime = performance.now();
    const duration = 800;

    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.emissive.setHex(0xff2200);
    mat.emissiveIntensity = 2.0;
    mat.color.setHex(0x440000);

    const tick = () => {
      const elapsed = performance.now() - startTime;
      const t = elapsed / duration;

      if (t < 0.3) {
        mat.emissiveIntensity = 2.0 + Math.sin(t * 40) * 1.0;
      } else {
        const fallT = (t - 0.3) / 0.7;
        mesh.position.y = startY - fallT * fallT * 8;
        mesh.rotation.x += 0.05;
        mesh.rotation.z += 0.03;
        mat.opacity = 1 - fallT;
        mat.transparent = true;
      }

      if (t < 1.0) {
        requestAnimationFrame(tick);
      } else {
        this.scene.remove(mesh);
      }
    };
    requestAnimationFrame(tick);
  }

  private spawnDashLines(pos: THREE.Vector3, dx: number, dz: number): void {
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.001) return;
    const nx = dx / len;
    const nz = dz / len;

    for (let i = 0; i < 6; i++) {
      const lineGeo = new THREE.BufferGeometry();
      const spread = (Math.random() - 0.5) * 1.2;
      const perpX = -nz * spread;
      const perpZ = nx * spread;
      const lineLength = 1.0 + Math.random() * 1.5;
      const positions = new Float32Array([
        pos.x + perpX,
        pos.y,
        pos.z + perpZ,
        pos.x - nx * lineLength + perpX,
        pos.y,
        pos.z - nz * lineLength + perpZ,
      ]);
      lineGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const lineMat = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.8,
      });
      const line = new THREE.Line(lineGeo, lineMat);
      this.scene.add(line);

      gsap.to(lineMat, {
        opacity: 0,
        duration: 0.3,
        ease: 'power2.out',
        onComplete: () => {
          this.scene.remove(line);
          lineGeo.dispose();
          lineMat.dispose();
        },
      });
    }
  }

  private createGravityWellMesh(id: string): GravityWellMesh {
    const sphereGeo = new THREE.SphereGeometry(0.6, 20, 20);
    const sphereMat = new THREE.MeshStandardMaterial({
      color: 0x220033,
      emissive: 0x8800cc,
      emissiveIntensity: 1.4,
      roughness: 0.1,
      metalness: 0.9,
      transparent: true,
      opacity: 0.85,
    });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.position.y = 1.5;
    this.scene.add(sphere);

    const ring1Geo = new THREE.TorusGeometry(1.0, 0.05, 8, 48);
    const ring1Mat = new THREE.MeshStandardMaterial({
      color: 0xcc00ff,
      emissive: 0xcc00ff,
      emissiveIntensity: 1.8,
      roughness: 0.1,
      metalness: 0.9,
    });
    const ring1 = new THREE.Mesh(ring1Geo, ring1Mat);
    ring1.rotation.x = Math.PI / 4;
    ring1.position.copy(sphere.position);
    this.scene.add(ring1);

    const ring2Geo = new THREE.TorusGeometry(1.2, 0.04, 8, 48);
    const ring2Mat = new THREE.MeshStandardMaterial({
      color: 0x8800ff,
      emissive: 0x8800ff,
      emissiveIntensity: 1.4,
      roughness: 0.1,
      metalness: 0.9,
    });
    const ring2 = new THREE.Mesh(ring2Geo, ring2Mat);
    ring2.rotation.x = -Math.PI / 3;
    ring2.rotation.y = Math.PI / 6;
    ring2.position.copy(sphere.position);
    this.scene.add(ring2);

    const light = new THREE.PointLight(0xcc00ff, 2.0, 8);
    light.position.copy(sphere.position);
    this.scene.add(light);

    const wellMesh: GravityWellMesh = { id, sphere, ring1, ring2, light };
    this.gravityWellMeshes.set(id, wellMesh);
    return wellMesh;
  }

  private spawnBlastWave(pos: THREE.Vector3, color: string): void {
    const colorHex = PLAYER_COLORS_HEX[color] ?? 0xffffff;
    const ringGeo = new THREE.TorusGeometry(0.2, 0.08, 8, 32);
    const ringMat = new THREE.MeshStandardMaterial({
      color: colorHex,
      emissive: colorHex,
      emissiveIntensity: 2.5,
      transparent: true,
      opacity: 1.0,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(pos);
    this.scene.add(ring);

    gsap.to(ring.scale, {
      x: 14,
      y: 14,
      z: 14,
      duration: 0.45,
      ease: 'power2.out',
    });
    gsap.to(ringMat, {
      opacity: 0,
      duration: 0.45,
      ease: 'power2.in',
      onComplete: () => {
        this.scene.remove(ring);
        ringGeo.dispose();
        ringMat.dispose();
      },
    });
    this.shakeCamera(0.6);
  }

  private animatePlayerDeath(playerMesh: PlayerMesh, color: string): void {
    const colorHex = PLAYER_COLORS_HEX[color] ?? 0xffffff;

    const count = 40;
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const pos = playerMesh.sphere.position;

    for (let i = 0; i < count; i++) {
      positions[i * 3] = pos.x;
      positions[i * 3 + 1] = pos.y;
      positions[i * 3 + 2] = pos.z;
      velocities[i * 3] = (Math.random() - 0.5) * 0.3;
      velocities[i * 3 + 1] = Math.random() * 0.4;
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color: colorHex, size: 0.25, transparent: true, opacity: 1.0 });
    const particles = new THREE.Points(geo, mat);
    this.scene.add(particles);

    playerMesh.sphere.visible = false;
    playerMesh.ring.visible = false;
    playerMesh.trail.visible = false;
    playerMesh.light.intensity = 0;

    const startTime = performance.now();
    const tick = () => {
      const t = (performance.now() - startTime) / 1200;
      const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
      const posArray = posAttr.array as Float32Array;
      for (let i = 0; i < count; i++) {
        posArray[i * 3] += velocities[i * 3];
        posArray[i * 3 + 1] += velocities[i * 3 + 1] - 0.01;
        posArray[i * 3 + 2] += velocities[i * 3 + 2];
      }
      posAttr.needsUpdate = true;
      mat.opacity = 1 - t;
      if (t < 1.0) requestAnimationFrame(tick);
      else this.scene.remove(particles);
    };
    requestAnimationFrame(tick);
  }

  private setupInputHandlers(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    this.soundManager.init();
    if (e.key === 'w' || e.key === 'ArrowUp') this.keys.w = true;
    if (e.key === 's' || e.key === 'ArrowDown') this.keys.s = true;
    if (e.key === 'a' || e.key === 'ArrowLeft') this.keys.a = true;
    if (e.key === 'd' || e.key === 'ArrowRight') this.keys.d = true;
    if (e.key === ' ') { this.keys.space = true; e.preventDefault(); }
    if (e.key === 'Shift') { this.keys.shift = true; e.preventDefault(); }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'w' || e.key === 'ArrowUp') this.keys.w = false;
    if (e.key === 's' || e.key === 'ArrowDown') this.keys.s = false;
    if (e.key === 'a' || e.key === 'ArrowLeft') this.keys.a = false;
    if (e.key === 'd' || e.key === 'ArrowRight') this.keys.d = false;
    if (e.key === ' ') this.keys.space = false;
    if (e.key === 'Shift') this.keys.shift = false;
  };

  public notifyElimination(_playerName: string): void {
    // sound is handled via updateState detecting isAlive change
  }

  public setKeys(keys: Partial<{ w: boolean; a: boolean; s: boolean; d: boolean; space: boolean; shift: boolean }>): void {
    Object.assign(this.keys, keys);
  }

  private animate = (): void => {
    this.animFrameId = requestAnimationFrame(this.animate);
    const delta = this.clock.getDelta();
    const time = this.clock.getElapsedTime();

    const now = Date.now();
    if (now - this.lastInputSent > 50) {
      const msg: ClientMessage = { type: 'input', keys: { ...this.keys } };
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      }
      this.lastInputSent = now;
    }

    // Camera shake
    if (this.cameraShake.intensity > 0.001) {
      const shakeX = (Math.random() - 0.5) * 2 * this.cameraShake.intensity;
      const shakeY = (Math.random() - 0.5) * 2 * this.cameraShake.intensity;
      const shakeZ = (Math.random() - 0.5) * 2 * this.cameraShake.intensity;
      this.camera.position.set(
        this.cameraBasePos.x + shakeX,
        this.cameraBasePos.y + shakeY,
        this.cameraBasePos.z + shakeZ
      );
      this.cameraShake.intensity *= this.cameraShake.decay;
    } else {
      this.camera.position.copy(this.cameraBasePos);
    }

    const myPlayer = this.lobbyState.players.find(p => p.id === this.myPlayerId);
    if (myPlayer?.isAlive) {
      this.camera.lookAt(myPlayer.position.x * TILE_SIZE, 0, myPlayer.position.z * TILE_SIZE);
    } else {
      this.camera.lookAt(ARENA_SIZE * TILE_SIZE * 0.5, 0, ARENA_SIZE * TILE_SIZE * 0.5);
    }

    // Physics step
    this.physicsWorld.step(1 / 60, delta, 3);

    // Update debris
    for (let i = this.debrisParticles.length - 1; i >= 0; i--) {
      const d = this.debrisParticles[i];
      d.life -= delta;
      const p = d.body.position;
      const q = d.body.quaternion;
      d.mesh.position.set(p.x, p.y, p.z);
      d.mesh.quaternion.set(q.x, q.y, q.z, q.w);
      const mat = d.mesh.material as THREE.MeshStandardMaterial;
      mat.opacity = Math.max(0, d.life / 1.5);
      mat.transparent = true;
      if (d.life <= 0) {
        this.scene.remove(d.mesh);
        this.physicsWorld.removeBody(d.body);
        this.debrisParticles.splice(i, 1);
      }
    }

    // Animate tiles
    for (let x = 0; x < ARENA_SIZE; x++) {
      for (let z = 0; z < ARENA_SIZE; z++) {
        const mesh = this.tileMeshes[x]?.[z];
        if (!mesh) continue;
        const tileState = this.lobbyState.tiles[x]?.[z];
        if (tileState?.state === 'crumbling') {
          const mat = mesh.material as THREE.MeshStandardMaterial;
          mat.emissiveIntensity = 1.0 + Math.sin(time * 20) * 0.8;
        } else {
          const mat = mesh.material as THREE.MeshStandardMaterial;
          const phase = (x + z) * 0.3 + time * 0.5;
          mat.emissiveIntensity = 0.3 + Math.sin(phase) * 0.15;
        }
      }
    }

    // Animate ambient particles
    const particlePosAttr = this.ambientParticles.geometry.getAttribute('position') as THREE.BufferAttribute;
    const particleArray = particlePosAttr.array as Float32Array;
    for (let i = 0; i < 200; i++) {
      particleArray[i * 3 + 1] += 0.01;
      if (particleArray[i * 3 + 1] > 10) {
        particleArray[i * 3 + 1] = 0;
      }
    }
    particlePosAttr.needsUpdate = true;

    // Animate player spheres
    for (const [id, mesh] of this.playerMeshes) {
      const player = this.lobbyState.players.find(p => p.id === id);
      if (!player?.isAlive) continue;
      mesh.sphere.position.y = 0.7 + Math.sin(time * 2 + id.charCodeAt(0)) * 0.08;
      mesh.ring.position.y = mesh.sphere.position.y;
      mesh.light.position.copy(mesh.sphere.position);
      mesh.sphere.rotation.y += delta * 1.5;
      mesh.ring.rotation.z += delta * 2.0;

      const moveDz = mesh.sphere.position.z - mesh.prevZ;
      mesh.ring.rotation.x = Math.PI / 3 + moveDz * 2;
      mesh.ring.rotation.y += delta * 2.0;
    }

    // Animate gravity wells
    for (const [, wellMesh] of this.gravityWellMeshes) {
      wellMesh.sphere.position.y = 1.5 + Math.sin(time * 1.2) * 0.2;
      wellMesh.ring1.position.y = wellMesh.sphere.position.y;
      wellMesh.ring2.position.y = wellMesh.sphere.position.y;
      wellMesh.light.position.copy(wellMesh.sphere.position);
      wellMesh.sphere.rotation.y += delta * 0.8;
      wellMesh.ring1.rotation.z += delta * 1.5;
      wellMesh.ring2.rotation.z -= delta * 1.0;
      wellMesh.ring2.rotation.y += delta * 0.7;
      // Pulse the light
      wellMesh.light.intensity = 1.8 + Math.sin(time * 3.0) * 0.5;
    }

    this.composer.render(delta);
  };

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  };

  public destroy(): void {
    cancelAnimationFrame(this.animFrameId);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('resize', this.onResize);
    this.soundManager.stopAmbient();
    this.renderer.dispose();
  }
}
