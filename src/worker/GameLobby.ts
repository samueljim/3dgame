import type {
  LobbyState, Player, ClientMessage, ServerMessage,
  PlayerColor, Direction, InputKeys, TrailSegment,
} from '../shared/types';
import {
  PLAYER_COLORS, ARENA_WORLD_SIZE, TICK_RATE,
  BIKE_SPEEDS, BIKE_RADIUS, TRAIL_SELF_GRACE,
  JUMP_DURATION, BOOST_SPEED_MULT, BOOST_DRAIN_RATE,
  SPEED_LEVEL_THRESHOLDS, MAX_ROUNDS, MAX_PLAYERS,
} from '../shared/types';

function turnLeft(dir: Direction): Direction {
  switch (dir) {
    case 'N': return 'W';
    case 'W': return 'S';
    case 'S': return 'E';
    case 'E': return 'N';
  }
}

function turnRight(dir: Direction): Direction {
  switch (dir) {
    case 'N': return 'E';
    case 'E': return 'S';
    case 'S': return 'W';
    case 'W': return 'N';
  }
}

/** Direction unit vectors in XZ plane. */
function dirVec(dir: Direction): { dx: number; dz: number } {
  switch (dir) {
    case 'N': return { dx:  0, dz: -1 };
    case 'S': return { dx:  0, dz:  1 };
    case 'E': return { dx:  1, dz:  0 };
    case 'W': return { dx: -1, dz:  0 };
  }
}

/** Squared distance from point (px,pz) to line segment (x1,z1)→(x2,z2). */
function pointSegDistSq(
  px: number, pz: number,
  x1: number, z1: number, x2: number, z2: number,
): number {
  const dx = x2 - x1, dz = z2 - z1;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-10) {
    const ex = px - x1, ez = pz - z1;
    return ex * ex + ez * ez;
  }
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (pz - z1) * dz) / lenSq));
  const nx = px - (x1 + t * dx);
  const nz = pz - (z1 + t * dz);
  return nx * nx + nz * nz;
}

/**
 * Squared distance from point (px,pz) to line segment (x1,z1)→(x2,z2),
 * but only testing the parameter range [0, tMax].
 * Used to skip the last TRAIL_SELF_GRACE world-units of an own segment.
 */
function pointSegDistSqClamped(
  px: number, pz: number,
  x1: number, z1: number, x2: number, z2: number,
  tMax: number,
): number {
  const dx = x2 - x1, dz = z2 - z1;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-10) {
    const ex = px - x1, ez = pz - z1;
    return ex * ex + ez * ez;
  }
  const t = Math.max(0, Math.min(tMax, ((px - x1) * dx + (pz - z1) * dz) / lenSq));
  const nx = px - (x1 + t * dx);
  const nz = pz - (z1 + t * dz);
  return nx * nx + nz * nz;
}

const MAX_JUMP_POWERUPS  = 3;
const MAX_BOOST_POWERUPS = 3;
const POWERUP_SPAWN_CHANCE   = 0.35;
const POWERUP_SPAWN_INTERVAL = 1.2;  // seconds between spawn attempts
const MAX_JUMP_CHARGES  = 3;
const MAX_BOOST_CHARGES = 2;
const PICKUP_RADIUS     = 2.8;  // world units

// Start positions & facing directions for up to 8 players (world coordinates)
function getStartConfigs(): Array<{ x: number; z: number; dir: Direction }> {
  const mid  = ARENA_WORLD_SIZE / 2;
  const q1   = ARENA_WORLD_SIZE * 0.25;
  const q3   = ARENA_WORLD_SIZE * 0.75;
  const low  = 5;
  const high = ARENA_WORLD_SIZE - 5;
  return [
    { x: low,  z: mid, dir: 'E' },
    { x: high, z: mid, dir: 'W' },
    { x: mid,  z: low, dir: 'S' },
    { x: mid,  z: high, dir: 'N' },
    { x: low,  z: q1,  dir: 'E' },
    { x: high, z: q1,  dir: 'W' },
    { x: low,  z: q3,  dir: 'E' },
    { x: high, z: q3,  dir: 'W' },
  ];
}

interface PlayerSession {
  ws: WebSocket;
  playerId: string;
  colorIndex: number;
  keys: InputKeys;
  /** Buffered next turn — set immediately when a direction key fires. */
  pendingTurn: 'left' | 'right' | null;
  /** Seconds of jump invincibility remaining. */
  jumpTimeLeft: number;
  /** Fractional boost-charge drain accumulator. */
  boostDrain: number;
  /**
   * ID of the most-recently-frozen segment for this player.
   * That segment gets a grace zone near its end so the bike doesn't
   * immediately self-collide after turning.
   */
  gracedSegmentId: string | null;
}

export class GameLobby {
  private state: DurableObjectState;
  private sessions: Map<string, PlayerSession> = new Map();
  private lobbyState: LobbyState;
  private gameInterval: ReturnType<typeof setInterval> | null = null;
  private lobbyId: string = '';
  private countdownTimeouts: ReturnType<typeof setTimeout>[] = [];
  private powerUpSpawnTimer = 0;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.lobbyState = this.createInitialLobbyState();
  }

  private createInitialLobbyState(): LobbyState {
    return {
      lobbyId: this.lobbyId,
      players: [],
      status: 'waiting',
      trailSegments: [],
      gameTime: 0,
      winner: null,
      speedLevel: 0,
      currentRound: 0,
      maxRounds: MAX_ROUNDS,
      roundScores: {},
      roundWinnerId: null,
      powerUps: [],
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.lobbyId = url.searchParams.get('lobbyId') || this.lobbyId;
    this.lobbyState.lobbyId = this.lobbyId;

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.handleWebSocket(server as WebSocket);

    return new Response(null, { status: 101, webSocket: client as WebSocket });
  }

  private handleWebSocket(ws: WebSocket): void {
    ws.accept();
    const playerId = crypto.randomUUID();

    ws.addEventListener('message', (event: MessageEvent) => {
      try {
        const msg: ClientMessage = JSON.parse(event.data as string);
        this.handleMessage(ws, playerId, msg);
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    });

    ws.addEventListener('close', () => this.handleDisconnect(playerId));
    ws.addEventListener('error', () => this.handleDisconnect(playerId));
  }

  private handleMessage(ws: WebSocket, playerId: string, msg: ClientMessage): void {
    switch (msg.type) {
      case 'join':         this.handleJoin(ws, playerId, msg.playerName); break;
      case 'rename':       this.handleRename(playerId, msg.playerName); break;
      case 'start_game':   this.handleStartGame(playerId); break;
      case 'restart_game': this.handleRestartGame(playerId); break;
      case 'input':        this.handleInput(playerId, msg.keys); break;
      case 'ping':         this.send(ws, { type: 'pong' }); break;
    }
  }

  private handleJoin(ws: WebSocket, playerId: string, playerName: string): void {
    if (this.lobbyState.status === 'playing') {
      this.send(ws, { type: 'error', message: 'Game already in progress' });
      return;
    }
    if (this.lobbyState.players.length >= MAX_PLAYERS) {
      this.send(ws, { type: 'error', message: 'Lobby is full' });
      return;
    }

    const colorIndex = this.lobbyState.players.length;
    const color: PlayerColor = PLAYER_COLORS[colorIndex];
    const cfg = getStartConfigs()[colorIndex];

    const player: Player = {
      id: playerId,
      name: playerName.trim().substring(0, 16) || `Player ${colorIndex + 1}`,
      color,
      isHost: this.lobbyState.players.length === 0,
      isReady: false,
      isAlive: true,
      position: { x: cfg.x, z: cfg.z },
      direction: cfg.dir,
      trailStart: { x: cfg.x, z: cfg.z },
      jumpCharges: 0,
      isJumping: false,
      boostCharges: 0,
      isBoosting: false,
      score: 0,
    };

    this.lobbyState.players.push(player);
    this.sessions.set(playerId, {
      ws, playerId, colorIndex,
      keys: { left: false, right: false, space: false, shift: false },
      pendingTurn: null,
      jumpTimeLeft: 0,
      boostDrain: 0,
      gracedSegmentId: null,
    });

    this.send(ws, { type: 'joined', playerId, lobbyState: this.lobbyState });
    this.broadcast({ type: 'lobby_update', lobbyState: this.lobbyState }, playerId);
  }

  private handleRename(playerId: string, playerName: string): void {
    if (this.lobbyState.status !== 'waiting') return;
    const player = this.lobbyState.players.find(p => p.id === playerId);
    if (!player) return;
    const newName = playerName.trim().substring(0, 16) || player.name;
    player.name = newName;
    this.broadcastAll({ type: 'player_renamed', playerId, playerName: newName });
    this.broadcastAll({ type: 'lobby_update', lobbyState: this.lobbyState });
  }

  private handleStartGame(playerId: string): void {
    const player = this.lobbyState.players.find(p => p.id === playerId);
    if (!player?.isHost) return;
    if (this.lobbyState.players.length < 1) return;
    if (this.lobbyState.status !== 'waiting') return;

    const roundScores: Record<string, number> = {};
    this.lobbyState.players.forEach(p => { roundScores[p.id] = 0; });
    this.lobbyState.roundScores = roundScores;
    this.lobbyState.currentRound = 1;
    this.lobbyState.roundWinnerId = null;
    this.lobbyState.winner = null;

    this.startRound();
  }

  private startRound(): void {
    this.lobbyState.status = 'playing';
    this.lobbyState.trailSegments = [];
    this.lobbyState.powerUps = [];
    this.lobbyState.gameTime = 0;
    this.lobbyState.speedLevel = 0;
    this.powerUpSpawnTimer = 0;

    this.lobbyState.players.forEach((p, i) => {
      const cfg = getStartConfigs()[i];
      p.isAlive = true;
      p.position   = { x: cfg.x, z: cfg.z };
      p.trailStart = { x: cfg.x, z: cfg.z };
      p.direction  = cfg.dir;
      p.jumpCharges = 0;
      p.isJumping   = false;
      p.boostCharges = 0;
      p.isBoosting   = false;
    });

    for (const session of this.sessions.values()) {
      session.jumpTimeLeft  = 0;
      session.boostDrain    = 0;
      session.gracedSegmentId = null;
      session.pendingTurn   = null;
    }

    // Countdown: 3 → 2 → 1 → GO
    for (const t of this.countdownTimeouts) clearTimeout(t);
    this.countdownTimeouts = [];

    this.lobbyState.countdown = 3;
    this.broadcastAll({ type: 'game_state', lobbyState: this.lobbyState });

    const t1 = setTimeout(() => {
      this.lobbyState.countdown = 2;
      this.broadcastAll({ type: 'game_state', lobbyState: this.lobbyState });
    }, 1000);
    const t2 = setTimeout(() => {
      this.lobbyState.countdown = 1;
      this.broadcastAll({ type: 'game_state', lobbyState: this.lobbyState });
    }, 2000);
    const t3 = setTimeout(() => {
      this.lobbyState.countdown = 0;
      this.broadcastAll({ type: 'game_state', lobbyState: this.lobbyState });
      this.startGameLoop();
    }, 3000);

    this.countdownTimeouts.push(t1, t2, t3);
  }

  private startGameLoop(): void {
    let lastTick = Date.now();

    this.gameInterval = setInterval(() => {
      const now = Date.now();
      const dt  = (now - lastTick) / 1000; // seconds
      lastTick  = now;

      this.lobbyState.gameTime += dt;

      // Advance speed level
      let newLevel = 0;
      for (let i = SPEED_LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
        if (this.lobbyState.gameTime >= SPEED_LEVEL_THRESHOLDS[i]) {
          newLevel = i;
          break;
        }
      }
      this.lobbyState.speedLevel = Math.min(newLevel, BIKE_SPEEDS.length - 1);

      this.advanceBikes(dt);

      if (this.lobbyState.status === 'playing') {
        this.maybeSpawnPowerUps(dt);
        this.broadcastAll({ type: 'game_state', lobbyState: this.lobbyState });
      }
    }, TICK_RATE);
  }

  // ─── Core Physics ─────────────────────────────────────────────────────────

  private advanceBikes(dt: number): void {
    const toEliminate = new Set<string>();
    const r2 = BIKE_RADIUS * BIKE_RADIUS;

    for (const [playerId, session] of this.sessions) {
      const player = this.lobbyState.players.find(p => p.id === playerId);
      if (!player || !player.isAlive) continue;

      // ── Timers ─────────────────────────────────────────────────────────
      if (session.jumpTimeLeft > 0) {
        session.jumpTimeLeft = Math.max(0, session.jumpTimeLeft - dt);
        player.isJumping = session.jumpTimeLeft > 0;
      } else {
        player.isJumping = false;
      }

      // Jump activation
      if (session.keys.space && player.jumpCharges > 0 && session.jumpTimeLeft <= 0) {
        session.jumpTimeLeft = JUMP_DURATION;
        player.jumpCharges--;
        player.isJumping = true;
      }

      // Boost
      if (session.keys.shift && player.boostCharges > 0) {
        player.isBoosting = true;
        session.boostDrain += BOOST_DRAIN_RATE * dt;
        if (session.boostDrain >= 1) {
          session.boostDrain -= 1;
          player.boostCharges = Math.max(0, player.boostCharges - 1);
        }
      } else {
        player.isBoosting = false;
      }

      // ── Turn ───────────────────────────────────────────────────────────
      if (session.pendingTurn !== null) {
        const newDir = session.pendingTurn === 'left'
          ? turnLeft(player.direction)
          : turnRight(player.direction);
        session.pendingTurn = null;
        if (newDir !== player.direction) {
          this.freezeSegment(player, session);
          player.direction = newDir;
        }
      }

      // ── Movement ───────────────────────────────────────────────────────
      const speed = BIKE_SPEEDS[this.lobbyState.speedLevel] *
        (player.isBoosting ? BOOST_SPEED_MULT : 1);
      const { dx, dz } = dirVec(player.direction);
      const nx = player.position.x + dx * speed * dt;
      const nz = player.position.z + dz * speed * dt;

      // Arena boundary (hard walls)
      if (nx < 0 || nx > ARENA_WORLD_SIZE || nz < 0 || nz > ARENA_WORLD_SIZE) {
        toEliminate.add(playerId);
        continue;
      }

      // Trail collision (skipped while jumping)
      if (!player.isJumping && this.collidesWithTrail(playerId, nx, nz, session)) {
        toEliminate.add(playerId);
        continue;
      }

      player.position = { x: nx, z: nz };
      this.applyPickup(player);
    }

    // Head-on collision: two bikes within 2× BIKE_RADIUS of each other
    const alive = this.lobbyState.players.filter(p => p.isAlive && !toEliminate.has(p.id));
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const dx = a.position.x - b.position.x;
        const dz = a.position.z - b.position.z;
        if (dx * dx + dz * dz < (BIKE_RADIUS * 2) ** 2) {
          toEliminate.add(a.id);
          toEliminate.add(b.id);
        }
      }
    }

    // Eliminate
    for (const playerId of toEliminate) {
      const player = this.lobbyState.players.find(p => p.id === playerId);
      if (player && player.isAlive) {
        player.isAlive = false;
        const session = this.sessions.get(playerId);
        if (session) this.freezeSegment(player, session);
        this.broadcastAll({ type: 'player_eliminated', playerId, playerName: player.name });
      }
    }

    // Round-end check
    const stillAlive = this.lobbyState.players.filter(p => p.isAlive);
    if (stillAlive.length <= 1) {
      if (this.gameInterval) { clearInterval(this.gameInterval); this.gameInterval = null; }
      this.endRound(stillAlive[0] ?? null);
    }
  }

  /**
   * Test whether position (px, pz) collides with any trail segment.
   * Own active segment is never tested (bike is its own tip).
   * Most-recently-frozen own segment gets a grace zone near its end.
   * All other players' segments (active + frozen) are tested fully.
   */
  private collidesWithTrail(
    playerId: string,
    px: number, pz: number,
    session: PlayerSession,
  ): boolean {
    const r2 = BIKE_RADIUS * BIKE_RADIUS;
    const player = this.lobbyState.players.find(p => p.id === playerId)!;

    // ── Frozen segments ───────────────────────────────────────────────────
    for (const seg of this.lobbyState.trailSegments) {
      if (seg.playerId === playerId && seg.id === session.gracedSegmentId) {
        // Own most-recently-frozen segment: skip the last TRAIL_SELF_GRACE world-units
        const sdx = seg.x2 - seg.x1, sdz = seg.z2 - seg.z1;
        const segLen = Math.sqrt(sdx * sdx + sdz * sdz);
        if (segLen < 1e-6) continue;
        const tMax = Math.max(0, 1 - TRAIL_SELF_GRACE / segLen);
        if (tMax <= 0) continue;
        if (pointSegDistSqClamped(px, pz, seg.x1, seg.z1, seg.x2, seg.z2, tMax) < r2) {
          return true;
        }
      } else {
        if (pointSegDistSq(px, pz, seg.x1, seg.z1, seg.x2, seg.z2) < r2) {
          return true;
        }
      }
    }

    // ── Active segments of OTHER players ─────────────────────────────────
    for (const other of this.lobbyState.players) {
      if (other.id === playerId || !other.isAlive) continue;
      if (pointSegDistSq(
        px, pz,
        other.trailStart.x, other.trailStart.z,
        other.position.x, other.position.z,
      ) < r2) {
        return true;
      }
    }

    // Own active segment is intentionally NOT checked
    // (the bike IS at its own tip — distance would always be 0).

    void player; // suppress unused variable warning
    return false;
  }

  /**
   * Freeze the player's current growing segment into trailSegments,
   * then reset trailStart to the current position.
   */
  private freezeSegment(player: Player, session: PlayerSession): void {
    const dx = player.position.x - player.trailStart.x;
    const dz = player.position.z - player.trailStart.z;
    if (dx * dx + dz * dz < 1e-10) return; // zero-length — skip

    const seg: TrailSegment = {
      id: crypto.randomUUID(),
      playerId: player.id,
      colorIndex: session.colorIndex,
      x1: player.trailStart.x, z1: player.trailStart.z,
      x2: player.position.x,   z2: player.position.z,
    };
    this.lobbyState.trailSegments.push(seg);
    session.gracedSegmentId = seg.id;
    player.trailStart = { x: player.position.x, z: player.position.z };
  }

  // ─── Power-ups ────────────────────────────────────────────────────────────

  private applyPickup(player: Player): void {
    const r2 = PICKUP_RADIUS * PICKUP_RADIUS;
    const idx = this.lobbyState.powerUps.findIndex(pu => {
      const dx = pu.position.x - player.position.x;
      const dz = pu.position.z - player.position.z;
      return dx * dx + dz * dz < r2;
    });
    if (idx < 0) return;
    const pu = this.lobbyState.powerUps[idx];
    if (pu.type === 'jump')  player.jumpCharges  = Math.min(MAX_JUMP_CHARGES,  player.jumpCharges  + 1);
    if (pu.type === 'boost') player.boostCharges = Math.min(MAX_BOOST_CHARGES, player.boostCharges + 1);
    this.lobbyState.powerUps.splice(idx, 1);
  }

  private maybeSpawnPowerUps(dt: number): void {
    this.powerUpSpawnTimer += dt;
    if (this.powerUpSpawnTimer < POWERUP_SPAWN_INTERVAL) return;
    this.powerUpSpawnTimer = 0;
    if (Math.random() > POWERUP_SPAWN_CHANCE) return;

    const jumpCount  = this.lobbyState.powerUps.filter(p => p.type === 'jump').length;
    const boostCount = this.lobbyState.powerUps.filter(p => p.type === 'boost').length;
    const canJ = jumpCount  < MAX_JUMP_POWERUPS;
    const canB = boostCount < MAX_BOOST_POWERUPS;
    if (!canJ && !canB) return;
    const spawnType = (!canJ || (canB && Math.random() < 0.4)) ? 'boost' : 'jump';

    const margin = 6;
    for (let attempt = 0; attempt < 60; attempt++) {
      const x = margin + Math.random() * (ARENA_WORLD_SIZE - margin * 2);
      const z = margin + Math.random() * (ARENA_WORLD_SIZE - margin * 2);
      // Not too close to any player
      const tooClose = this.lobbyState.players.some(p => {
        if (!p.isAlive) return false;
        const dx = p.position.x - x, dz = p.position.z - z;
        return dx * dx + dz * dz < 100; // 10 w/u clearance
      });
      if (tooClose) continue;
      // Not too close to existing power-ups
      const overlap = this.lobbyState.powerUps.some(pu => {
        const dx = pu.position.x - x, dz = pu.position.z - z;
        return dx * dx + dz * dz < 100;
      });
      if (overlap) continue;
      this.lobbyState.powerUps.push({ id: crypto.randomUUID(), type: spawnType, position: { x, z } });
      return;
    }
  }

  // ─── Round / Match ────────────────────────────────────────────────────────

  private endRound(roundWinner: Player | null): void {
    if (this.gameInterval) { clearInterval(this.gameInterval); this.gameInterval = null; }

    if (roundWinner) {
      this.lobbyState.roundScores[roundWinner.id] =
        (this.lobbyState.roundScores[roundWinner.id] ?? 0) + 1;
      this.lobbyState.roundWinnerId = roundWinner.id;
    } else {
      this.lobbyState.roundWinnerId = null;
    }

    const maxWins = Math.ceil(this.lobbyState.maxRounds / 2);
    const someoneWon = roundWinner &&
      (this.lobbyState.roundScores[roundWinner.id] ?? 0) >= maxWins;
    const allRoundsPlayed = this.lobbyState.currentRound >= this.lobbyState.maxRounds;

    if (someoneWon || allRoundsPlayed) {
      let matchWinner: Player | null = null;
      let topWins = -1;
      for (const p of this.lobbyState.players) {
        const wins = this.lobbyState.roundScores[p.id] ?? 0;
        if (wins > topWins) { topWins = wins; matchWinner = p; }
      }
      this.lobbyState.winner = matchWinner?.id ?? null;
      this.lobbyState.status = 'finished';
      this.broadcastAll({ type: 'game_over', winner: matchWinner || null, lobbyState: this.lobbyState });
    } else {
      this.lobbyState.status = 'round_over';
      this.broadcastAll({ type: 'game_state', lobbyState: this.lobbyState });
      const nextRound = setTimeout(() => {
        this.lobbyState.currentRound += 1;
        this.startRound();
      }, 4000);
      this.countdownTimeouts.push(nextRound);
    }
  }

  private handleRestartGame(playerId: string): void {
    const player = this.lobbyState.players.find(p => p.id === playerId);
    if (!player?.isHost) return;
    if (this.lobbyState.status !== 'finished') return;

    if (this.gameInterval) { clearInterval(this.gameInterval); this.gameInterval = null; }
    for (const t of this.countdownTimeouts) clearTimeout(t);
    this.countdownTimeouts = [];

    this.lobbyState.status = 'waiting';
    this.lobbyState.trailSegments = [];
    this.lobbyState.powerUps = [];
    this.lobbyState.gameTime = 0;
    this.lobbyState.winner = null;
    this.lobbyState.countdown = undefined;
    this.lobbyState.speedLevel = 0;
    this.lobbyState.currentRound = 0;
    this.lobbyState.roundScores = {};
    this.lobbyState.roundWinnerId = null;

    this.lobbyState.players.forEach((p, i) => {
      const cfg = getStartConfigs()[i];
      p.isAlive    = true;
      p.score      = 0;
      p.position   = { x: cfg.x, z: cfg.z };
      p.trailStart = { x: cfg.x, z: cfg.z };
      p.direction  = cfg.dir;
      p.jumpCharges  = 0;
      p.isJumping    = false;
      p.boostCharges = 0;
      p.isBoosting   = false;
    });

    this.broadcastAll({ type: 'lobby_update', lobbyState: this.lobbyState });
  }

  private handleInput(playerId: string, keys: InputKeys): void {
    const session = this.sessions.get(playerId);
    if (!session) return;
    const leftPressed  = keys.left  && !session.keys.left;
    const rightPressed = keys.right && !session.keys.right;
    if (leftPressed)  session.pendingTurn = 'left';
    if (rightPressed) session.pendingTurn = 'right';
    session.keys = keys;
  }

  private handleDisconnect(playerId: string): void {
    this.sessions.delete(playerId);
    const idx = this.lobbyState.players.findIndex(p => p.id === playerId);
    if (idx === -1) return;

    this.lobbyState.players.splice(idx, 1);

    if (this.lobbyState.players.length > 0 && !this.lobbyState.players.some(p => p.isHost)) {
      this.lobbyState.players[0].isHost = true;
    }

    if (this.lobbyState.status === 'playing') {
      const alive = this.lobbyState.players.filter(p => p.isAlive);
      if (alive.length <= 1) {
        if (this.gameInterval) { clearInterval(this.gameInterval); this.gameInterval = null; }
        this.endRound(alive[0] ?? null);
        return;
      }
    }

    this.broadcastAll({ type: 'lobby_update', lobbyState: this.lobbyState });
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* connection closed */ }
  }

  private broadcast(msg: ServerMessage, excludeId?: string): void {
    for (const session of this.sessions.values()) {
      if (session.playerId !== excludeId) this.send(session.ws, msg);
    }
  }

  private broadcastAll(msg: ServerMessage): void {
    for (const session of this.sessions.values()) this.send(session.ws, msg);
  }
}
