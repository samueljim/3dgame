import type {
  LobbyState, Player, TileState, ClientMessage, ServerMessage,
  PlayerColor
} from '../shared/types';
import {
  PLAYER_COLORS, ARENA_SIZE, PLAYER_SPEED, DASH_FORCE,
  TICK_RATE, TILE_FALL_INTERVAL, TILES_PER_FALL
} from '../shared/types';

interface PlayerSession {
  ws: WebSocket;
  playerId: string;
  keys: { w: boolean; a: boolean; s: boolean; d: boolean; space: boolean };
  worldPos: { x: number; z: number }; // float world position
  velocity: { x: number; z: number };
  dashCooldown: number; // ms
}

export class GameLobby {
  private state: DurableObjectState;
  private sessions: Map<string, PlayerSession> = new Map();
  private lobbyState: LobbyState;
  private gameInterval: ReturnType<typeof setInterval> | null = null;
  private lobbyId: string = '';

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
      nextTileFallIn: TILE_FALL_INTERVAL,
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
      case 'start_game':
        this.handleStartGame(playerId);
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
    if (this.lobbyState.players.length >= 4) {
      this.send(ws, { type: 'error', message: 'Lobby is full' });
      return;
    }

    const colorIndex = this.lobbyState.players.length;
    const color: PlayerColor = PLAYER_COLORS[colorIndex];

    const startPositions = [
      { x: 1, z: 1 }, { x: 8, z: 8 }, { x: 1, z: 8 }, { x: 8, z: 1 }
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
      keys: { w: false, a: false, s: false, d: false, space: false },
      worldPos: { x: startPos.x, z: startPos.z },
      velocity: { x: 0, z: 0 },
      dashCooldown: 0,
    };
    this.sessions.set(playerId, session);

    this.send(ws, { type: 'joined', playerId, lobbyState: this.lobbyState });
    this.broadcast({ type: 'lobby_update', lobbyState: this.lobbyState }, playerId);
  }

  private handleStartGame(playerId: string): void {
    const player = this.lobbyState.players.find(p => p.id === playerId);
    if (!player?.isHost) return;
    if (this.lobbyState.players.length < 1) return;
    if (this.lobbyState.status !== 'waiting') return;

    this.lobbyState.status = 'playing';
    this.lobbyState.tiles = this.initTiles();
    this.lobbyState.gameTime = 0;
    this.lobbyState.winner = null;

    // Reset player positions
    const startPositions = [
      { x: 1, z: 1 }, { x: 8, z: 8 }, { x: 1, z: 8 }, { x: 8, z: 1 }
    ];
    this.lobbyState.players.forEach((p, i) => {
      p.isAlive = true;
      p.position = startPositions[i];
      const session = this.sessions.get(p.id);
      if (session) {
        session.worldPos = { x: startPositions[i].x, z: startPositions[i].z };
        session.velocity = { x: 0, z: 0 };
        session.dashCooldown = 0;
      }
    });

    this.broadcastAll({ type: 'game_state', lobbyState: this.lobbyState });

    // Start game loop
    let lastTick = Date.now();
    let tileFallAccumulator = 0;

    this.gameInterval = setInterval(() => {
      const now = Date.now();
      const dt = now - lastTick;
      lastTick = now;

      this.lobbyState.gameTime += dt / 1000;
      tileFallAccumulator += dt;

      // Process player movement
      this.processMovement(dt);

      // Tile falling logic
      if (tileFallAccumulator >= TILE_FALL_INTERVAL) {
        tileFallAccumulator = 0;
        this.dropRandomTiles();
      }
      this.lobbyState.nextTileFallIn = TILE_FALL_INTERVAL - tileFallAccumulator;

      // Check eliminations
      this.checkEliminations();

      // Check win condition
      const alivePlayers = this.lobbyState.players.filter(p => p.isAlive);
      if (alivePlayers.length <= 1) {
        const winner = alivePlayers[0] || null;
        this.lobbyState.winner = winner?.id || null;
        this.lobbyState.status = 'finished';
        this.broadcastAll({ type: 'game_over', winner: winner || null, lobbyState: this.lobbyState });

        if (this.gameInterval) {
          clearInterval(this.gameInterval);
          this.gameInterval = null;
        }
        return;
      }

      // Broadcast game state
      this.broadcastAll({ type: 'game_state', lobbyState: this.lobbyState });
    }, TICK_RATE);
  }

  private processMovement(dt: number): void {
    const speed = PLAYER_SPEED * (dt / TICK_RATE);

    for (const [playerId, session] of this.sessions) {
      const player = this.lobbyState.players.find(p => p.id === playerId);
      if (!player || !player.isAlive) continue;

      // Update dash cooldown
      if (session.dashCooldown > 0) {
        session.dashCooldown -= dt;
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
        session.dashCooldown = 1200; // 1.2 second cooldown
      }

      // Add movement to velocity
      session.velocity.x += inputX * speed;
      session.velocity.z += inputZ * speed;

      // Apply friction
      session.velocity.x *= 0.85;
      session.velocity.z *= 0.85;

      // Clamp velocity
      const maxVel = 0.5;
      session.velocity.x = Math.max(-maxVel, Math.min(maxVel, session.velocity.x));
      session.velocity.z = Math.max(-maxVel, Math.min(maxVel, session.velocity.z));

      // Update position
      session.worldPos.x += session.velocity.x;
      session.worldPos.z += session.velocity.z;

      // Clamp to arena bounds
      session.worldPos.x = Math.max(-0.5, Math.min(ARENA_SIZE - 0.5, session.worldPos.x));
      session.worldPos.z = Math.max(-0.5, Math.min(ARENA_SIZE - 0.5, session.worldPos.z));

      // Update grid position
      player.position.x = Math.round(session.worldPos.x);
      player.position.z = Math.round(session.worldPos.z);

      // Clamp grid position
      player.position.x = Math.max(0, Math.min(ARENA_SIZE - 1, player.position.x));
      player.position.z = Math.max(0, Math.min(ARENA_SIZE - 1, player.position.z));

      // Check collision with other players
      for (const [otherId, otherSession] of this.sessions) {
        if (otherId === playerId) continue;
        const otherPlayer = this.lobbyState.players.find(p => p.id === otherId);
        if (!otherPlayer || !otherPlayer.isAlive) continue;

        const dx = session.worldPos.x - otherSession.worldPos.x;
        const dz = session.worldPos.z - otherSession.worldPos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < 0.8 && dist > 0.001) {
          // Collision response
          const nx = dx / dist;
          const nz = dz / dist;
          const overlap = 0.8 - dist;

          session.worldPos.x += nx * overlap * 0.5;
          session.worldPos.z += nz * overlap * 0.5;
          otherSession.worldPos.x -= nx * overlap * 0.5;
          otherSession.worldPos.z -= nz * overlap * 0.5;

          // Transfer momentum
          const velTransfer = 0.3;
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
  }

  private dropRandomTiles(): void {
    const solidTiles: Array<{ x: number; z: number }> = [];
    for (let x = 0; x < ARENA_SIZE; x++) {
      for (let z = 0; z < ARENA_SIZE; z++) {
        if (this.lobbyState.tiles[x][z].state === 'solid') {
          solidTiles.push({ x, z });
        }
      }
    }

    if (solidTiles.length === 0) return;

    // Shuffle and pick tiles to fall
    for (let i = solidTiles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [solidTiles[i], solidTiles[j]] = [solidTiles[j], solidTiles[i]];
    }

    const tilesToFall = Math.min(TILES_PER_FALL, solidTiles.length);
    for (let i = 0; i < tilesToFall; i++) {
      const tile = solidTiles[i];
      this.lobbyState.tiles[tile.x][tile.z] = { x: tile.x, z: tile.z, state: 'fallen' };
    }
  }

  private checkEliminations(): void {
    for (const [playerId, session] of this.sessions) {
      const player = this.lobbyState.players.find(p => p.id === playerId);
      if (!player || !player.isAlive) continue;

      // Check if player is out of bounds
      if (
        session.worldPos.x < -0.4 || session.worldPos.x > ARENA_SIZE - 0.6 ||
        session.worldPos.z < -0.4 || session.worldPos.z > ARENA_SIZE - 0.6
      ) {
        this.eliminatePlayer(player);
        continue;
      }

      // Check if player is on a fallen tile
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
    keys: { w: boolean; a: boolean; s: boolean; d: boolean; space: boolean }
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
        // Reassign host if needed
        if (player.isHost && this.lobbyState.players.length > 0) {
          this.lobbyState.players[0].isHost = true;
        }
        // Reassign colors
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
    } catch (_e) {
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
