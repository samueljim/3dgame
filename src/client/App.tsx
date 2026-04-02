import { useState, useEffect } from 'react';
import HomePage from './components/HomePage';
import LobbyPage from './components/LobbyPage';
import GameCanvas from './components/GameCanvas';
import type { LobbyState, ServerMessage } from '@shared/types';

type AppState = 'home' | 'lobby' | 'game';

export default function App() {
  const [appState, setAppState] = useState<AppState>('home');
  const [lobbyId, setLobbyId] = useState<string>('');
  const [playerId, setPlayerId] = useState<string>('');
  const [playerName, setPlayerName] = useState<string>('');
  const [lobbyState, setLobbyState] = useState<LobbyState | null>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);

  // Check URL for lobby join link
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const joinLobby = params.get('lobby');
    if (joinLobby) {
      setLobbyId(joinLobby.toUpperCase());
      setAppState('lobby');
    }
  }, []);

  // Handle WebSocket messages
  useEffect(() => {
    if (!ws) return;

    const handleMessage = (event: MessageEvent) => {
      const msg: ServerMessage = JSON.parse(event.data);

      switch (msg.type) {
        case 'joined':
          setPlayerId(msg.playerId);
          setLobbyState(msg.lobbyState);
          break;
        case 'lobby_update':
          setLobbyState(msg.lobbyState);
          break;
        case 'game_state':
          setLobbyState(msg.lobbyState);
          if (msg.lobbyState.status === 'playing' && appState !== 'game') {
            setAppState('game');
          }
          break;
        case 'game_over':
          setLobbyState(msg.lobbyState);
          break;
        case 'player_eliminated':
          // Handled in GameCanvas
          break;
      }
    };

    ws.addEventListener('message', handleMessage);
    return () => ws.removeEventListener('message', handleMessage);
  }, [ws, appState]);

  const handleCreateLobby = async (name: string) => {
    try {
      const res = await fetch('/api/lobby/create', { method: 'POST' });
      const data = await res.json() as { lobbyId: string };
      setPlayerName(name);
      setLobbyId(data.lobbyId);
      setAppState('lobby');
      window.history.pushState({}, '', `?lobby=${data.lobbyId}`);
      return data.lobbyId;
    } catch (e) {
      console.error('Failed to create lobby:', e);
      return null;
    }
  };

  const handleJoinLobby = (name: string, id: string) => {
    setPlayerName(name);
    setLobbyId(id.toUpperCase());
    setAppState('lobby');
  };

  const handleConnected = (websocket: WebSocket) => {
    setWs(websocket);
  };

  const handleBackToHome = () => {
    if (ws) {
      ws.close();
      setWs(null);
    }
    setLobbyState(null);
    setLobbyId('');
    setPlayerId('');
    setAppState('home');
    window.history.pushState({}, '', '/');
  };

  return (
    <div className="app">
      {appState === 'home' && (
        <HomePage
          onCreateLobby={handleCreateLobby}
          onJoinLobby={handleJoinLobby}
        />
      )}
      {(appState === 'lobby' || appState === 'game') && lobbyId && (
        <>
          {appState === 'lobby' && (
            <LobbyPage
              lobbyId={lobbyId}
              playerName={playerName}
              playerId={playerId}
              lobbyState={lobbyState}
              ws={ws}
              onConnected={handleConnected}
              onBack={handleBackToHome}
            />
          )}
          {appState === 'game' && lobbyState && ws && (
            <GameCanvas
              lobbyState={lobbyState}
              playerId={playerId}
              ws={ws}
              onGameOver={handleBackToHome}
            />
          )}
        </>
      )}
    </div>
  );
}
