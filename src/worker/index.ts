import { GameLobby } from './GameLobby';

export { GameLobby };

export interface Env {
  GAME_LOBBY: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for lobby connections
    if (url.pathname.startsWith('/ws/lobby/')) {
      const lobbyId = url.pathname.split('/ws/lobby/')[1];
      if (!lobbyId || lobbyId.length < 3) {
        return new Response('Invalid lobby ID', { status: 400 });
      }

      const id = env.GAME_LOBBY.idFromName(lobbyId);
      const stub = env.GAME_LOBBY.get(id);
      const wsUrl = new URL(request.url);
      wsUrl.searchParams.set('lobbyId', lobbyId);

      return stub.fetch(new Request(wsUrl.toString(), request));
    }

    // API: Create a new lobby
    if (url.pathname === '/api/lobby/create' && request.method === 'POST') {
      const lobbyId = generateLobbyId();
      return new Response(JSON.stringify({ lobbyId }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // API: Check if lobby exists
    if (url.pathname.startsWith('/api/lobby/') && request.method === 'GET') {
      const lobbyId = url.pathname.split('/api/lobby/')[1];
      return new Response(JSON.stringify({ exists: true, lobbyId }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Serve static assets (handled by Cloudflare Assets)
    return new Response('Not found', { status: 404 });
  },
};

function generateLobbyId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}
