import type {
  LobbyState, Player, TileState, ClientMessage, ServerMessage,
  PlayerColor, GravityWell
} from '../shared/types';
import {
  PLAYER_COLORS, ARENA_SIZE, PLAYER_SPEED, DASH_FORCE,
  TICK_RATE, TILES_PER_FALL, TILE_CRUMBLE_WARNING, TILE_PLAYER_CRUMBLE_DELAY, DASH_COOLDOWN_MS,
  MAX_ROUNDS, MAX_PLAYERS, BLAST_COOLDOWN_MS, BLAST_FORCE, BLAST_RADIUS,
  GRAVITY_WELL_PULL, GRAVITY_WELL_INFLUENCE_RADIUS, WALL_CELLS
} from '../shared/types';

interface PlayerSession {
  ws: WebSocket;
  playerId: string;
  keys: { w: boolean; a: boolean; s: boolean; d: boolean; space: boolean; shift: boolean };
  worldPos: { x: number; z: number }; // float world position
  velocity: { x: number; z: number };
  dashCooldown: number; // ms
  isDashing: boolean;   // true during active dash (for collision boost)
  dashActiveTimer: number; // ms remaining of dash-boost window
  blastCooldown: number; // ms
}

export class GameLobby {
  private state: DurableObjectState;
  private sessions: Map<string, PlayerSession> = new Map();
  private lobbyState: LobbyState;
  private gameInterval: ReturnType<typeof setInterval> | null = null;
  private lobbyId: string = '';
  private fallCount: number = 0;
  private countdownTimeouts: ReturnType<typeof setTimeout>[] = [];
  // Fast lookup: "x,z" → true for every impassable wall cell
  private readonly wallSet: Set<string> = new Set(WALL_CELLS.map(w => `${w.x},${w.z}`));

  constructor(state: DurableObjectState) {
    this.state = state;
    this.lobbyState = this.createInitialLobbyState();
  }

  private createInitialLobbyState(): LobbyState {
    return {
      lobbyId: this.lobbyId,
      players: [],
      status: 'waiting',
      tiles: this.initTiles(),
      gameTime: 0,
      winner: null,
      nextTileFallIn: 7000,
      gravityWells: [],
      currentRound: 0,
      maxRounds: MAX_ROUNDS,
      roundScores: {},
      roundWinnerId: null,
    };
  }

  private initTiles(): TileState[][] {
    const tiles: TileState[][] = [];
    for (let x = 0; x < ARENA_SIZE; x++) {
      tiles[x] = [];
      for (let z = 0; z < ARENA_SIZE; z++) {
        tiles[x][z] = { x, z, state: 'solid' };
      }
    }
    return tiles;
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

    return new Response(null, {
      status: 101,
      webSocket: client as WebSocket,
    });
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

    ws.addEventListener('close', () => {
      this.handleDisconnect(playerId);
    });

    ws.addEventListener('error', () => {
      this.handleDisconnect(playerId);
    });
  }

  private handleMessage(ws: WebSocket, playerId: string, msg: ClientMessage): void {
    switch (msg.type) {
      case 'join':
        this.handleJoin(ws, playerId, msg.playerName);
        break;
      case 'rename':
        this.handleRename(playerId, msg.playerName);
        break;
      case 'start_game':
        this.handleStartGame(playerId);
        break;
      case 'restart_game':
        this.handleRestartGame(playerId);
        break;
      case 'input':
        this.handleInput(playerId, msg.keys);
        break;
      case 'ping':
        this.send(ws, { type: 'pong' });
        break;
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

    const startPositions = [
      { x: 1, z: 1 }, { x: 18, z: 1 }, { x: 18, z: 18 }, { x: 1, z: 18 },
      { x: 9, z: 1 }, { x: 18, z: 9 }, { x: 9, z: 18 }, { x: 1, z: 9 },
    ];
    const startPos = startPositions[colorIndex];

    const player: Player = {
      id: playerId,
      name: playerName.trim().substring(0, 16) || `Player ${colorIndex + 1}`,
      color,
      isHost: this.lobbyState.players.length === 0,
      isReady: false,
      isAlive: true,
      position: startPos,
      score: 0,
    };

    this.lobbyState.players.push(player);

    const session: PlayerSession = {
      ws,
      playerId,
      keys: { w: false, a: false, s: false, d: false, space: false, shift: false },
      worldPos: { x: startPos.x, z: startPos.z },
      velocity: { x: 0, z: 0 },
      dashCooldown: 0,
      isDashing: false,
      dashActiveTimer: 0,
      blastCooldown: 0,
    };
    this.sessions.set(playerId, session);

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

    // Initialise round scores for all current players
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
    this.lobbyState.tiles = this.initTiles();
    this.lobbyState.gameTime = 0;
    this.fallCount = 0;

    // Reset player positions and state
    const startPositions = [
      { x: 1, z: 1 }, { x: 18, z: 1 }, { x: 18, z: 18 }, { x: 1, z: 18 },
      { x: 9, z: 1 }, { x: 18, z: 9 }, { x: 9, z: 18 }, { x: 1, z: 9 },
    ];
    this.lobbyState.players.forEach((p, i) => {
      p.isAlive = true;
      p.position = startPositions[i];
      p.blastCooldown = 0;
      p.blastActive = false;
      const session = this.sessions.get(p.id);
      if (session) {
        session.worldPos = { x: startPositions[i].x, z: startPositions[i].z };
        session.velocity = { x: 0, z: 0 };
        session.dashCooldown = 0;
        session.isDashing = false;
        session.dashActiveTimer = 0;
        session.blastCooldown = 0;
      }
    });

    // Spleef: no gravity wells — open flat floor
    this.lobbyState.gravityWells = [];

    // Countdown: 3 -> 2 -> 1 -> GO
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
    let tileFallAccumulator = 0;

    const INITIAL_FALL_INTERVAL = 9000;
    const MIN_FALL_INTERVAL = 3000;
    const FALLS_PER_ACCELERATION = 4;
    const INTERVAL_DECREASE = 200;
    const getCurrentInterval = () =>
      Math.max(MIN_FALL_INTERVAL, INITIAL_FALL_INTERVAL - Math.floor(this.fallCount / FALLS_PER_ACCELERATION) * INTERVAL_DECREASE);

    this.gameInterval = setInterval(() => {
      const now = Date.now();
      const dt = now - lastTick;
      lastTick = now;

      this.lobbyState.gameTime += dt / 1000;
      tileFallAccumulator += dt;

      // Process player movement
      this.processMovement(dt);

      // Tile falling logic
      const currentInterval = getCurrentInterval();
      if (tileFallAccumulator >= currentInterval) {
        tileFallAccumulator = 0;
        this.dropRandomTiles();
        this.fallCount++;
      }
      this.lobbyState.nextTileFallIn = currentInterval - tileFallAccumulator;

      // Check eliminations
      this.checkEliminations();

      // Check round win condition
      const alivePlayers = this.lobbyState.players.filter(p => p.isAlive);
      if (alivePlayers.length <= 1) {
        const roundWinner = alivePlayers[0] || null;

        if (this.gameInterval) {
          clearInterval(this.gameInterval);
          this.gameInterval = null;
        }

        // Award round point
        if (roundWinner) {
          this.lobbyState.roundScores[roundWinner.id] =
            (this.lobbyState.roundScores[roundWinner.id] ?? 0) + 1;
          this.lobbyState.roundWinnerId = roundWinner.id;
        } else {
          this.lobbyState.roundWinnerId = null;
        }

        // Check if match is over (best of MAX_ROUNDS)
        const maxWins = Math.ceil(this.lobbyState.maxRounds / 2);
        const someoneWonMatch = roundWinner &&
          (this.lobbyState.roundScores[roundWinner.id] ?? 0) >= maxWins;
        const allRoundsPlayed = this.lobbyState.currentRound >= this.lobbyState.maxRounds;

        if (someoneWonMatch || allRoundsPlayed) {
          // Determine overall match winner (most round wins)
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
          // Show round-over screen, then start the next round after a delay
          this.lobbyState.status = 'round_over';
          this.broadcastAll({ type: 'game_state', lobbyState: this.lobbyState });

          const nextRoundTimeout = setTimeout(() => {
            this.lobbyState.currentRound += 1;
            this.startRound();
          }, 4000);
          this.countdownTimeouts.push(nextRoundTimeout);
        }
        return;
      }

      // Broadcast game state
      this.broadcastAll({ type: 'game_state', lobbyState: this.lobbyState });
    }, TICK_RATE);
  }

  private handleRestartGame(playerId: string): void {
    const player = this.lobbyState.players.find(p => p.id === playerId);
    if (!player?.isHost) return;
    if (this.lobbyState.status !== 'finished') return;

    // Stop game loop if running
    if (this.gameInterval) {
      clearInterval(this.gameInterval);
      this.gameInterval = null;
    }
    for (const t of this.countdownTimeouts) clearTimeout(t);
    this.countdownTimeouts = [];

    // Reset to waiting state
    this.lobbyState.status = 'waiting';
    this.lobbyState.tiles = this.initTiles();
    this.lobbyState.gameTime = 0;
    this.lobbyState.winner = null;
    this.lobbyState.nextTileFallIn = 7000;
    this.lobbyState.countdown = undefined;
    this.lobbyState.gravityWells = [];
    this.lobbyState.currentRound = 0;
    this.lobbyState.roundScores = {};
    this.lobbyState.roundWinnerId = null;
    this.fallCount = 0;

    const startPositions = [
      { x: 1, z: 1 }, { x: 18, z: 1 }, { x: 18, z: 18 }, { x: 1, z: 18 },
      { x: 9, z: 1 }, { x: 18, z: 9 }, { x: 9, z: 18 }, { x: 1, z: 9 },
    ];
    this.lobbyState.players.forEach((p, i) => {
      p.isAlive = true;
      p.score = 0;
      p.blastCooldown = 0;
      p.blastActive = false;
      p.position = startPositions[i];
      const session = this.sessions.get(p.id);
      if (session) {
        session.worldPos = { x: startPositions[i].x, z: startPositions[i].z };
        session.velocity = { x: 0, z: 0 };
        session.dashCooldown = 0;
        session.isDashing = false;
        session.dashActiveTimer = 0;
        session.blastCooldown = 0;
      }
    });

    this.broadcastAll({ type: 'lobby_update', lobbyState: this.lobbyState });
  }

  private processMovement(dt: number): void {
    const speed = PLAYER_SPEED * (dt / TICK_RATE);
    const DASH_ACTIVE_WINDOW = 350; // ms that a dash counts as "active" for boosted collisions

    // Reset per-tick flags
    for (const player of this.lobbyState.players) {
      player.blastActive = false;
    }

    for (const [playerId, session] of this.sessions) {
      const player = this.lobbyState.players.find(p => p.id === playerId);
      if (!player || !player.isAlive) continue;

      // Update dash cooldown and active timer
      if (session.dashCooldown > 0) {
        session.dashCooldown -= dt;
      }
      if (session.dashActiveTimer > 0) {
        session.dashActiveTimer -= dt;
        if (session.dashActiveTimer <= 0) session.isDashing = false;
      }

      // Update blast cooldown
      if (session.blastCooldown > 0) {
        session.blastCooldown -= dt;
      }

      // Apply input to velocity
      let inputX = 0;
      let inputZ = 0;
      if (session.keys.w) inputZ -= 1;
      if (session.keys.s) inputZ += 1;
      if (session.keys.a) inputX -= 1;
      if (session.keys.d) inputX += 1;

      // Normalize diagonal movement
      if (inputX !== 0 && inputZ !== 0) {
        inputX *= 0.707;
        inputZ *= 0.707;
      }

      // Dash
      if (session.keys.space && session.dashCooldown <= 0 && (inputX !== 0 || inputZ !== 0)) {
        session.velocity.x += inputX * DASH_FORCE;
        session.velocity.z += inputZ * DASH_FORCE;
        session.dashCooldown = DASH_COOLDOWN_MS;
        session.isDashing = true;
        session.dashActiveTimer = DASH_ACTIVE_WINDOW;
      }

      // Blast (Shift): omnidirectional shockwave pushing nearby players and gravity wells
      if (session.keys.shift && session.blastCooldown <= 0) {
        session.blastCooldown = BLAST_COOLDOWN_MS;
        player.blastActive = true;

        // Push nearby players
        for (const [otherId, otherSession] of this.sessions) {
          if (otherId === playerId) continue;
          const otherPlayer = this.lobbyState.players.find(p => p.id === otherId);
          if (!otherPlayer || !otherPlayer.isAlive) continue;

          const dx = otherSession.worldPos.x - session.worldPos.x;
          const dz = otherSession.worldPos.z - session.worldPos.z;
          const dist = Math.sqrt(dx * dx + dz * dz);

          if (dist < BLAST_RADIUS && dist > 0.01) {
            const force = BLAST_FORCE * (1 - dist / BLAST_RADIUS);
            otherSession.velocity.x += (dx / dist) * force;
            otherSession.velocity.z += (dz / dist) * force;
          }
        }

        // Push nearby gravity wells
        for (const well of this.lobbyState.gravityWells) {
          const dx = well.position.x - session.worldPos.x;
          const dz = well.position.z - session.worldPos.z;
          const dist = Math.sqrt(dx * dx + dz * dz);

          if (dist < BLAST_RADIUS && dist > 0.01) {
            const force = 1.8 * (1 - dist / BLAST_RADIUS);
            well.velocity.x += (dx / dist) * force;
            well.velocity.z += (dz / dist) * force;
          }
        }
      }

      // Add movement to velocity
      session.velocity.x += inputX * speed;
      session.velocity.z += inputZ * speed;

      // Apply friction
      session.velocity.x *= 0.85;
      session.velocity.z *= 0.85;

      // Clamp velocity (higher cap during dash for more satisfying pushes)
      const maxVel = session.isDashing ? 0.9 : 0.65;
      session.velocity.x = Math.max(-maxVel, Math.min(maxVel, session.velocity.x));
      session.velocity.z = Math.max(-maxVel, Math.min(maxVel, session.velocity.z));

      // Update position
      session.worldPos.x += session.velocity.x;
      session.worldPos.z += session.velocity.z;

      // Clamp to arena bounds
      session.worldPos.x = Math.max(-0.5, Math.min(ARENA_SIZE - 0.5, session.worldPos.x));
      session.worldPos.z = Math.max(-0.5, Math.min(ARENA_SIZE - 0.5, session.worldPos.z));

      // Wall collision (AABB: wall half = 0.5, player radius = 0.42)
      const WALL_COMBINED = 0.5 + 0.42; // wall half-width + player collision radius
      for (const wall of WALL_CELLS) {
        const wdx = session.worldPos.x - wall.x;
        const wdz = session.worldPos.z - wall.z;
        const ovX = WALL_COMBINED - Math.abs(wdx);
        const ovZ = WALL_COMBINED - Math.abs(wdz);
        if (ovX > 0 && ovZ > 0) {
          if (ovX <= ovZ) {
            session.worldPos.x += wdx >= 0 ? ovX : -ovX;
            session.velocity.x = 0;
          } else {
            session.worldPos.z += wdz >= 0 ? ovZ : -ovZ;
            session.velocity.z = 0;
          }
        }
      }

      // Update grid position
      player.position.x = Math.round(session.worldPos.x);
      player.position.z = Math.round(session.worldPos.z);

      // Clamp grid position
      player.position.x = Math.max(0, Math.min(ARENA_SIZE - 1, player.position.x));
      player.position.z = Math.max(0, Math.min(ARENA_SIZE - 1, player.position.z));

      // Expose cooldowns to player
      player.dashCooldown = Math.max(0, session.dashCooldown);
      player.blastCooldown = Math.max(0, session.blastCooldown);

      // Spleef: tile under the player begins crumbling (3-second grace period at round start)
      if (this.lobbyState.gameTime >= 3.0) {
        const tx = player.position.x;
        const tz = player.position.z;
        if (
          tx >= 0 && tx < ARENA_SIZE &&
          tz >= 0 && tz < ARENA_SIZE &&
          this.lobbyState.tiles[tx][tz].state === 'solid'
        ) {
          this.lobbyState.tiles[tx][tz] = { x: tx, z: tz, state: 'crumbling' };
          setTimeout(() => {
            if (this.lobbyState.tiles[tx][tz].state === 'crumbling') {
              this.lobbyState.tiles[tx][tz] = { x: tx, z: tz, state: 'fallen' };
            }
          }, TILE_PLAYER_CRUMBLE_DELAY);
        }
      }

      // Check collision with other players
      for (const [otherId, otherSession] of this.sessions) {
        if (otherId === playerId) continue;
        const otherPlayer = this.lobbyState.players.find(p => p.id === otherId);
        if (!otherPlayer || !otherPlayer.isAlive) continue;

        const dx = session.worldPos.x - otherSession.worldPos.x;
        const dz = session.worldPos.z - otherSession.worldPos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < 1.0 && dist > 0.001) {
          const nx = dx / dist;
          const nz = dz / dist;
          const overlap = 1.0 - dist;

          session.worldPos.x += nx * overlap * 0.5;
          session.worldPos.z += nz * overlap * 0.5;
          otherSession.worldPos.x -= nx * overlap * 0.5;
          otherSession.worldPos.z -= nz * overlap * 0.5;

          // Boosted velocity transfer when the attacker is actively dashing
          const velTransfer = session.isDashing ? 0.55 : 0.3;
          const relVelX = session.velocity.x - otherSession.velocity.x;
          const relVelZ = session.velocity.z - otherSession.velocity.z;
          const relVelDotN = relVelX * nx + relVelZ * nz;

          if (relVelDotN > 0) {
            otherSession.velocity.x -= nx * relVelDotN * velTransfer;
            otherSession.velocity.z -= nz * relVelDotN * velTransfer;
            session.velocity.x -= nx * relVelDotN * velTransfer * 0.5;
            session.velocity.z -= nz * relVelDotN * velTransfer * 0.5;
          }
        }
      }
    }

    // Process gravity wells: pull players, handle player collisions, move wells
    const WELL_BOUND_MIN = 0.8;
    const WELL_BOUND_MAX = ARENA_SIZE - 0.8;
    for (const well of this.lobbyState.gravityWells) {
      // Apply gravity pull to each alive player
      for (const [playerId, session] of this.sessions) {
        const player = this.lobbyState.players.find(p => p.id === playerId);
        if (!player || !player.isAlive) continue;

        const dx = well.position.x - session.worldPos.x;
        const dz = well.position.z - session.worldPos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < GRAVITY_WELL_INFLUENCE_RADIUS && dist > 0.8) {
          const pullFactor = GRAVITY_WELL_PULL * (1 - dist / GRAVITY_WELL_INFLUENCE_RADIUS);
          session.velocity.x += (dx / dist) * pullFactor;
          session.velocity.z += (dz / dist) * pullFactor;
        }

        // Player dashes into well — push well away
        if (dist < 0.9 && dist > 0.001 && session.isDashing) {
          const nx = dx / dist;
          const nz = dz / dist;
          well.velocity.x -= nx * 0.5;
          well.velocity.z -= nz * 0.5;
          // Small bounce-back on the player
          session.velocity.x += nx * 0.2;
          session.velocity.z += nz * 0.2;
        }
      }

      // Move the well
      well.position.x += well.velocity.x;
      well.position.z += well.velocity.z;
      well.velocity.x *= 0.93;
      well.velocity.z *= 0.93;

      // Bounce off arena boundaries
      if (well.position.x < WELL_BOUND_MIN) {
        well.position.x = WELL_BOUND_MIN;
        well.velocity.x = Math.abs(well.velocity.x) * 0.7;
      } else if (well.position.x > WELL_BOUND_MAX) {
        well.position.x = WELL_BOUND_MAX;
        well.velocity.x = -Math.abs(well.velocity.x) * 0.7;
      }
      if (well.position.z < WELL_BOUND_MIN) {
        well.position.z = WELL_BOUND_MIN;
        well.velocity.z = Math.abs(well.velocity.z) * 0.7;
      } else if (well.position.z > WELL_BOUND_MAX) {
        well.position.z = WELL_BOUND_MAX;
        well.velocity.z = -Math.abs(well.velocity.z) * 0.7;
      }

      // Bounce gravity wells off wall cells (wall half = 0.5, well collision radius = 0.7)
      const WELL_WALL_COMBINED = 0.5 + 0.7; // wall half-width + well radius
      for (const wall of WALL_CELLS) {
        const wdx = well.position.x - wall.x;
        const wdz = well.position.z - wall.z;
        const ovX = WELL_WALL_COMBINED - Math.abs(wdx);
        const ovZ = WELL_WALL_COMBINED - Math.abs(wdz);
        if (ovX > 0 && ovZ > 0) {
          if (ovX <= ovZ) {
            well.position.x += wdx >= 0 ? ovX : -ovX;
            well.velocity.x *= -0.7;
          } else {
            well.position.z += wdz >= 0 ? ovZ : -ovZ;
            well.velocity.z *= -0.7;
          }
        }
      }
    }
  }

  private dropRandomTiles(): void {
    const solidTiles: Array<{ x: number; z: number }> = [];
    for (let x = 0; x < ARENA_SIZE; x++) {
      for (let z = 0; z < ARENA_SIZE; z++) {
        if (this.lobbyState.tiles[x][z].state === 'solid' && !this.wallSet.has(`${x},${z}`)) {
          solidTiles.push({ x, z });
        }
      }
    }

    if (solidTiles.length === 0) return;

    for (let i = solidTiles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [solidTiles[i], solidTiles[j]] = [solidTiles[j], solidTiles[i]];
    }

    const tilesToFall = Math.min(TILES_PER_FALL, solidTiles.length);
    for (let i = 0; i < tilesToFall; i++) {
      const tile = solidTiles[i];
      // Mark as crumbling first
      this.lobbyState.tiles[tile.x][tile.z] = { x: tile.x, z: tile.z, state: 'crumbling' };
      // Schedule transition to fallen after TILE_CRUMBLE_WARNING ms
      const tx = tile.x;
      const tz = tile.z;
      setTimeout(() => {
        if (this.lobbyState.tiles[tx][tz].state === 'crumbling') {
          this.lobbyState.tiles[tx][tz] = { x: tx, z: tz, state: 'fallen' };
        }
      }, TILE_CRUMBLE_WARNING);
    }
  }

  private checkEliminations(): void {
    for (const [playerId, session] of this.sessions) {
      const player = this.lobbyState.players.find(p => p.id === playerId);
      if (!player || !player.isAlive) continue;

      if (
        session.worldPos.x < -0.4 || session.worldPos.x > ARENA_SIZE - 0.6 ||
        session.worldPos.z < -0.4 || session.worldPos.z > ARENA_SIZE - 0.6
      ) {
        this.eliminatePlayer(player);
        continue;
      }

      const tileX = Math.round(session.worldPos.x);
      const tileZ = Math.round(session.worldPos.z);
      if (
        tileX >= 0 && tileX < ARENA_SIZE &&
        tileZ >= 0 && tileZ < ARENA_SIZE &&
        this.lobbyState.tiles[tileX][tileZ].state === 'fallen'
      ) {
        this.eliminatePlayer(player);
      }
    }
  }

  private eliminatePlayer(player: Player): void {
    player.isAlive = false;
    this.broadcastAll({ type: 'player_eliminated', playerId: player.id, playerName: player.name });
  }

  private handleInput(
    playerId: string,
    keys: { w: boolean; a: boolean; s: boolean; d: boolean; space: boolean; shift: boolean }
  ): void {
    const session = this.sessions.get(playerId);
    if (session) {
      session.keys = keys;
    }
  }

  private handleDisconnect(playerId: string): void {
    this.sessions.delete(playerId);
    const playerIndex = this.lobbyState.players.findIndex(p => p.id === playerId);
    if (playerIndex !== -1) {
      const player = this.lobbyState.players[playerIndex];
      player.isAlive = false;

      if (this.lobbyState.status === 'waiting') {
        this.lobbyState.players.splice(playerIndex, 1);
        if (player.isHost && this.lobbyState.players.length > 0) {
          this.lobbyState.players[0].isHost = true;
        }
        this.lobbyState.players.forEach((p, i) => {
          p.color = PLAYER_COLORS[i];
        });
      }

      this.broadcastAll({ type: 'lobby_update', lobbyState: this.lobbyState });
    }

    if (this.sessions.size === 0 && this.gameInterval) {
      clearInterval(this.gameInterval);
      this.gameInterval = null;
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      // WebSocket might be closed
    }
  }

  private broadcast(msg: ServerMessage, excludeId?: string): void {
    for (const [id, session] of this.sessions) {
      if (id !== excludeId) {
        this.send(session.ws, msg);
      }
    }
  }

  private broadcastAll(msg: ServerMessage): void {
    for (const session of this.sessions.values()) {
      this.send(session.ws, msg);
    }
  }
}
