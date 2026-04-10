import { useState } from 'react';

interface HomePageProps {
  onCreateLobby: (name: string) => Promise<string | null>;
  onJoinLobby: (name: string, lobbyId: string) => void;
}

export default function HomePage({ onCreateLobby, onJoinLobby }: HomePageProps) {
  const [playerName, setPlayerName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    if (!playerName.trim()) { setError('Please enter your name'); return; }
    setLoading(true);
    setError('');
    const id = await onCreateLobby(playerName.trim());
    if (!id) setError('Failed to create lobby. Try again.');
    setLoading(false);
  };

  const handleJoin = () => {
    if (!playerName.trim()) { setError('Please enter your name'); return; }
    if (!joinCode.trim() || joinCode.trim().length < 4) { setError('Enter a valid lobby code'); return; }
    setError('');
    onJoinLobby(playerName.trim(), joinCode.trim().toUpperCase());
  };

  return (
    <div className="home-page">
      <div className="title-container">
        <h1 className="game-title">LIGHT CYCLES</h1>
        <p className="game-subtitle">Ride · Trail · Survive</p>
      </div>

      <div className="menu-card">
        <div className="form-group">
          <label className="form-label">Your Name</label>
          <input
            className="form-input"
            type="text"
            placeholder="Enter your name..."
            value={playerName}
            onChange={e => setPlayerName(e.target.value)}
            maxLength={16}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
          />
        </div>

        {error && (
          <p style={{ color: '#ff6666', fontSize: '0.85rem', marginBottom: '1rem' }}>{error}</p>
        )}

        <button
          className="btn btn-primary"
          onClick={handleCreate}
          disabled={loading}
          style={{ marginBottom: '1rem' }}
        >
          {loading ? 'Creating...' : '⚡ Create New Lobby'}
        </button>

        <div className="divider">OR JOIN</div>

        <div className="form-group">
          <label className="form-label">Lobby Code</label>
          <input
            className="form-input"
            type="text"
            placeholder="Enter 6-character code..."
            value={joinCode}
            onChange={e => setJoinCode(e.target.value.toUpperCase())}
            maxLength={6}
            style={{ textTransform: 'uppercase', letterSpacing: '0.3em' }}
            onKeyDown={e => e.key === 'Enter' && handleJoin()}
          />
        </div>

        <button
          className="btn btn-secondary"
          onClick={handleJoin}
        >
          → Join Lobby
        </button>

        <div style={{ marginTop: '2rem', padding: '1rem', background: 'rgba(0,255,255,0.03)', borderRadius: '8px', border: '1px solid rgba(0,255,255,0.1)' }}>
          <p style={{ fontSize: '0.8rem', color: 'rgba(200,200,255,0.5)', lineHeight: '1.6', textAlign: 'center' }}>
            🏍 Ride your light cycle — leave a wall behind<br />
            WASD / Arrows to steer<br />
            Don't crash into walls or other trails!
          </p>
        </div>
      </div>
    </div>
  );
}
