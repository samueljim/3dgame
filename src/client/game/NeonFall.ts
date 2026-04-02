import * as THREE from 'three';
import type { LobbyState, Player, ClientMessage } from '@shared/types';
import { ARENA_SIZE, TILE_SIZE } from '@shared/types';

const PLAYER_COLORS_HEX: Record<string, number> = {
  red: 0xff3333,
  green: 0x33ff44,
  yellow: 0xffee33,
  purple: 0xaa33ff,
};

interface PlayerMesh {
  sphere: THREE.Mesh;
  light: THREE.PointLight;
  trail: THREE.Points;
  trailPositions: Float32Array;
  trailIndex: number;
}

export class NeonFallGame {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private animFrameId: number = 0;
  private tileMeshes: (THREE.Mesh | null)[][] = [];
  private playerMeshes: Map<string, PlayerMesh> = new Map();
  private ws: WebSocket;
  private myPlayerId: string;
  private lobbyState: LobbyState;
  private keys: { w: boolean; a: boolean; s: boolean; d: boolean; space: boolean } = {
    w: false, a: false, s: false, d: false, space: false
  };
  private lastInputSent = 0;
  private eliminationCallbacks: Array<(playerName: string) => void> = [];
  private clock: THREE.Clock;

  private ambientParticles!: THREE.Points;
  private starField!: THREE.Points;

  constructor(canvas: HTMLCanvasElement, ws: WebSocket, myPlayerId: string, initialState: LobbyState) {
    this.ws = ws;
    this.myPlayerId = myPlayerId;
    this.lobbyState = initialState;
    this.clock = new THREE.Clock();

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
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

    this.setupScene();
    this.buildArena();
    this.setupPlayers();
    this.setupInputHandlers();

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
    mesh.userData = { gridX: x, gridZ: z };
    return mesh;
  }

  private addArenaEdges(): void {
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.5 });

    const arenaW = ARENA_SIZE * TILE_SIZE;
    const y = 0.2;
    const offset = TILE_SIZE / 2 - TILE_SIZE / 2;

    const points = [
      new THREE.Vector3(-TILE_SIZE / 2 + offset, y, -TILE_SIZE / 2 + offset),
      new THREE.Vector3(arenaW - TILE_SIZE / 2 + offset, y, -TILE_SIZE / 2 + offset),
      new THREE.Vector3(arenaW - TILE_SIZE / 2 + offset, y, arenaW - TILE_SIZE / 2 + offset),
      new THREE.Vector3(-TILE_SIZE / 2 + offset, y, arenaW - TILE_SIZE / 2 + offset),
      new THREE.Vector3(-TILE_SIZE / 2 + offset, y, -TILE_SIZE / 2 + offset),
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

    this.playerMeshes.set(player.id, { sphere, light, trail, trailPositions, trailIndex: 0 });
  }

  public updateState(newState: LobbyState): void {
    this.lobbyState = newState;

    // Update tiles
    for (let x = 0; x < ARENA_SIZE; x++) {
      for (let z = 0; z < ARENA_SIZE; z++) {
        const tileState = newState.tiles[x]?.[z];
        const mesh = this.tileMeshes[x]?.[z];

        if (tileState?.state === 'fallen' && mesh) {
          this.animateTileFall(mesh, x, z);
          this.tileMeshes[x][z] = null;
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

      if (!player.isAlive) {
        if (playerMesh.sphere.visible) {
          this.animatePlayerDeath(playerMesh, player.color);
        }
        continue;
      }

      // Smooth position interpolation
      const targetX = player.position.x * TILE_SIZE;
      const targetZ = player.position.z * TILE_SIZE;
      playerMesh.sphere.position.x += (targetX - playerMesh.sphere.position.x) * 0.3;
      playerMesh.sphere.position.z += (targetZ - playerMesh.sphere.position.z) * 0.3;
      playerMesh.light.position.copy(playerMesh.sphere.position);

      // Update trail
      const idx = playerMesh.trailIndex * 3;
      playerMesh.trailPositions[idx] = playerMesh.sphere.position.x;
      playerMesh.trailPositions[idx + 1] = playerMesh.sphere.position.y;
      playerMesh.trailPositions[idx + 2] = playerMesh.sphere.position.z;
      playerMesh.trailIndex = (playerMesh.trailIndex + 1) % 30;
      (playerMesh.trail.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }

    // Camera follows my player
    const myPlayer = newState.players.find(p => p.id === this.myPlayerId);
    if (myPlayer?.isAlive) {
      const targetX = myPlayer.position.x * TILE_SIZE;
      const targetZ = myPlayer.position.z * TILE_SIZE;
      const camTargetX = targetX;
      const camTargetZ = targetZ + 12;
      this.camera.position.x += (camTargetX - this.camera.position.x) * 0.05;
      this.camera.position.z += (camTargetZ - this.camera.position.z) * 0.05;
      this.camera.lookAt(targetX, 0, targetZ);
    }
  }

  private animateTileFall(mesh: THREE.Mesh, _x: number, _z: number): void {
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
    if (e.key === 'w' || e.key === 'ArrowUp') this.keys.w = true;
    if (e.key === 's' || e.key === 'ArrowDown') this.keys.s = true;
    if (e.key === 'a' || e.key === 'ArrowLeft') this.keys.a = true;
    if (e.key === 'd' || e.key === 'ArrowRight') this.keys.d = true;
    if (e.key === ' ') { this.keys.space = true; e.preventDefault(); }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'w' || e.key === 'ArrowUp') this.keys.w = false;
    if (e.key === 's' || e.key === 'ArrowDown') this.keys.s = false;
    if (e.key === 'a' || e.key === 'ArrowLeft') this.keys.a = false;
    if (e.key === 'd' || e.key === 'ArrowRight') this.keys.d = false;
    if (e.key === ' ') this.keys.space = false;
  };

  public onElimination(cb: (playerName: string) => void): void {
    this.eliminationCallbacks.push(cb);
  }

  public notifyElimination(playerName: string): void {
    for (const cb of this.eliminationCallbacks) cb(playerName);
  }

  private animate = (): void => {
    this.animFrameId = requestAnimationFrame(this.animate);
    const delta = this.clock.getDelta();
    const time = this.clock.getElapsedTime();

    // Send input at ~20Hz
    const now = Date.now();
    if (now - this.lastInputSent > 50) {
      const msg: ClientMessage = { type: 'input', keys: { ...this.keys } };
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      }
      this.lastInputSent = now;
    }

    // Animate tiles - subtle pulse
    for (let x = 0; x < ARENA_SIZE; x++) {
      for (let z = 0; z < ARENA_SIZE; z++) {
        const mesh = this.tileMeshes[x]?.[z];
        if (!mesh) continue;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        const phase = (x + z) * 0.3 + time * 0.5;
        mat.emissiveIntensity = 0.3 + Math.sin(phase) * 0.15;
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

    // Animate player spheres (bobbing)
    for (const [id, mesh] of this.playerMeshes) {
      const player = this.lobbyState.players.find(p => p.id === id);
      if (!player?.isAlive) continue;
      mesh.sphere.position.y = 0.7 + Math.sin(time * 2 + id.charCodeAt(0)) * 0.08;
      mesh.light.position.copy(mesh.sphere.position);
      mesh.sphere.rotation.y += delta * 1.5;
    }

    this.renderer.render(this.scene, this.camera);
  };

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  public destroy(): void {
    cancelAnimationFrame(this.animFrameId);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
  }
}
