// src/App.js
import React, { useEffect, useState, useCallback } from 'react';
import { BrowserRouter as Router, Routes, Route, useNavigate } from 'react-router-dom';
import io from 'socket.io-client';

// Import your components
import LoginScreen from './components/LoginScreen';
import LobbyScreen from './components/LobbyScreen';
import GameScreen from './components/GameScreen';
import AuthCallback from './components/AuthCallback';
import LoginFailedScreen from './components/LoginFailedScreen'; // A simple component for login failure

import './App.css'; // Your main CSS file

// Initialize Socket.IO connection.
const socket = io('https://minesweeper-flags-backend.onrender.com', {
  withCredentials: true, // Crucial for sending cookies with the handshake
});

function App() {
  const navigate = useNavigate(); // For programmatic navigation

  // === Authentication & Lobby State ===
  const [user, setUser] = useState(null); // Stores authenticated user data (id, displayName)
  const [loggedIn, setLoggedIn] = useState(false); // True if user is authenticated
  const [authChecked, setAuthChecked] = useState(false); // True once initial auth check is complete
  const [playersList, setPlayersList] = useState([]); // List of other players in the lobby
  const [invite, setInvite] = useState(null); // Stores incoming game invitation data
  const [unfinishedGames, setUnfinishedGames] = useState([]); // List of unfinished games from Firestore
  const [message, setMessage] = useState(''); // General UI messages (success, info, error)
  const [socketReady, setSocketReady] = useState(false); // True when socket is connected and authenticated context is loaded

  // === Game State ===
  const [gameId, setGameId] = useState(null);
  const [playerNumber, setPlayerNumber] = useState(null);
  const [board, setBoard] = useState([]);
  const [turn, setTurn] = useState(null);
  const [scores, setScores] = useState({ 1: 0, 2: 0 });
  const [bombsUsed, setBombsUsed] = useState({ 1: false, 2: false });
  const [bombMode, setBombMode] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [opponentName, setOpponentName] = useState("");
  const [lastClickedTile, setLastClickedTile] = useState({ 1: null, 2: null }); // To highlight last clicked tile for each player


  // Helper to display messages and clear them after a delay
  const showMessage = useCallback((msg, duration = 3000) => {
    setMessage(msg);
    if (duration > 0) {
      setTimeout(() => setMessage(''), duration);
    }
  }, []);

  // Resets all game-related state to return to the lobby view
  const resetGameState = useCallback(() => {
    setGameId(null);
    setPlayerNumber(null);
    setBoard([]);
    setTurn(null);
    setScores({ 1: 0, 2: 0 });
    setBombsUsed({ 1: false, 2: false });
    setBombMode(false);
    setGameOver(false);
    setOpponentName("");
    setInvite(null);
    setLastClickedTile({ 1: null, 2: null });
    // After resetting game state, request updated unfinished games and lobby list
    if (socketReady) {
        socket.emit("request-unfinished-games");
        socket.emit("join-lobby", user.displayName); // Re-emit join-lobby to update player's status in the list
    }
    navigate('/lobby');
  }, [socketReady, user?.displayName, navigate]);


  // --- Initial Authentication Status Check ---
  // This runs once on component mount to check if a user is already authenticated.
  useEffect(() => {
    const checkAuthStatus = async () => {
      try {
        const response = await fetch('https://minesweeper-flags-backend.onrender.com/me', {
          method: 'GET',
          credentials: 'include', // Crucial for sending session cookies
        });
        if (response.ok) {
          const data = await response.json();
          setUser(data.user);
          setLoggedIn(true);
          console.log('App.js: Initial auth check successful for:', data.user.displayName);
        } else {
          setUser(null);
          setLoggedIn(false);
          console.log('App.js: Initial auth check failed (not logged in).');
        }
      } catch (error) {
        console.error('App.js: Error checking auth status:', error);
        setUser(null);
        setLoggedIn(false);
      } finally {
        setAuthChecked(true); // Mark initial auth check as complete
      }
    };
    checkAuthStatus();
  }, []); // Empty dependency array means this runs once on mount

  // --- Socket.IO Event Handlers & Connection Logic ---
  // This useEffect handles all Socket.IO listeners and ensures actions are taken
  // only when the socket is fully ready (connected AND authenticated).
  useEffect(() => {
    socket.on('connect', () => {
      console.log('Socket.IO connected!');
      // Do NOT set socketReady here. Wait for explicit server confirmation.
    });

    socket.on('disconnect', () => {
      console.log('Socket.IO disconnected!');
      setSocketReady(false); // Reset socket readiness on disconnect
      showMessage('Disconnected from server. Please refresh.', 0); // Show persistent message
      setLoggedIn(false); // Assume logged out on disconnect
      setUser(null);
      resetGameState();
    });

    // Server sends this when the socket connection has its associated session/user context loaded
    socket.on('authenticated-socket-ready', () => {
      console.log('Frontend: Authenticated socket ready for game events!');
      setSocketReady(true);
      // Once socket is ready, if user is logged in, join lobby and request unfinished games.
      if (loggedIn && user) {
        socket.emit('join-lobby', user.displayName);
        socket.emit('request-unfinished-games');
      }
    });

    socket.on('join-error', (msg) => {
      showMessage(msg, 5000);
      console.error('Join Error:', msg);
      // If a join error occurs, especially if authentication is required, reset and navigate to login
      if (msg.includes("Authentication required")) {
          setLoggedIn(false);
          setUser(null);
          setAuthChecked(false); // Retrigger auth check on next load
          navigate('/login');
      }
    });

    socket.on('lobby-joined', (userName) => {
      setLoggedIn(true);
      if (user) setUser(prev => ({...prev, displayName: userName})); // Update user's displayName from server
      console.log(`Lobby joined as ${userName}!`);
      showMessage(`Welcome to the lobby, ${userName}!`);
    });

    socket.on('players-list', (players) => {
      setPlayersList(players);
    });

    socket.on('game-invite', (inviteData) => {
      setInvite(inviteData);
      showMessage(`Invitation from ${inviteData.fromName}!`);
    });

    socket.on('invite-rejected', ({ fromName, reason }) => {
      showMessage(`${fromName} rejected your invitation.${reason ? ` Reason: ${reason}` : ''}`, 5000);
      setInvite(null); // Clear the invite if rejected
    });

    socket.on('game-start', (data) => {
      setGameId(data.gameId);
      setPlayerNumber(data.playerNumber);
      setBoard(JSON.parse(data.board)); // Board is stringified on backend
      setTurn(data.turn);
      setScores(data.scores);
      setBombsUsed(data.bombsUsed);
      setGameOver(data.gameOver);
      setOpponentName(data.opponentName);
      setBombMode(false);
      setLastClickedTile(data.lastClickedTile || { 1: null, 2: null }); // Ensure it's initialized
      showMessage(`Game started! You are Player ${data.playerNumber}.`, 3000);
      setUnfinishedGames([]); // Clear unfinished games list as a game has started/resumed
      navigate(`/game/${data.gameId}`); // Navigate to game screen
    });

    socket.on('board-update', (game) => {
      setBoard(JSON.parse(game.board));
      setTurn(game.turn);
      setScores(game.scores);
      setBombsUsed(game.bombsUsed);
      setGameOver(game.gameOver);
      setBombMode(false);
      setLastClickedTile(game.lastClickedTile || { 1: null, 2: null }); // Update last clicked tile
    });

    socket.on('wait-bomb-center', () => {
      setBombMode(true);
      showMessage('Select a 5x5 bomb center.', 5000);
    });

    socket.on('bomb-error', (msg) => {
      showMessage(msg, 5000);
      setBombMode(false); // Exit bomb mode on error
    });

    socket.on('opponent-left', () => {
      showMessage('Opponent left the game. Returning to lobby.', 5000);
      resetGameState();
    });

    socket.on('game-restarted', (data) => {
      setBoard(JSON.parse(data.board));
      setTurn(data.turn);
      setScores(data.scores);
      setBombsUsed(data.bombsUsed);
      setGameOver(data.gameOver);
      setBombMode(false);
      setLastClickedTile(data.lastClickedTile || { 1: null, 2: null });
      showMessage('Game restarted!', 3000);
    });

    socket.on('opponent-reconnected', ({ name }) => {
      showMessage(`${name} has reconnected!`, 3000);
    });

    socket.on('receive-unfinished-games', (games) => {
      // Deserialize boards for display
      const deserializedGames = games.map(game => ({
        ...game,
        board: JSON.parse(game.board) // Deserialize board for each unfinished game
      }));
      setUnfinishedGames(deserializedGames);
    });

    // Cleanup function: unsubscribe from socket events
    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('authenticated-socket-ready');
      socket.off('join-error');
      socket.off('lobby-joined');
      socket.off('players-list');
      socket.off('game-invite');
      socket.off('invite-rejected');
      socket.off('game-start');
      socket.off('board-update');
      socket.off('wait-bomb-center');
      socket.off('bomb-error');
      socket.off('opponent-left');
      socket.off('game-restarted');
      socket.off('opponent-reconnected');
      socket.off('receive-unfinished-games');
    };
  }, [loggedIn, user, showMessage, resetGameState, navigate]); // Add dependencies


  // --- OAuth Pop-up Message Listener ---
  // This useEffect listens for messages coming from the AuthCallback pop-up window
  useEffect(() => {
    const handleAuthMessage = async (event) => {
      // Ensure the message comes from a trusted origin (your own frontend URL)
      if (event.origin !== 'https://minesweeper-flags-frontend.onrender.com') {
        console.warn('App.js: Message from untrusted origin:', event.origin);
        return;
      }

      const { type, payload } = event.data;

      if (type === 'authSuccess') {
        console.log('App.js: Authentication successful via pop-up:', payload);
        setUser(payload.user);
        setLoggedIn(true);
        // After successful login, ensure Socket.IO attempts to connect/re-authenticate
        // and then join the lobby (handled by the other useEffect when socketReady becomes true)
        showMessage(`Successfully logged in as ${payload.user.displayName}!`, 3000);
        navigate('/lobby'); // Navigate to lobby directly
      } else if (type === 'authFailure') {
        console.error('App.js: Authentication failed via pop-up:', payload.message);
        setLoggedIn(false);
        setUser(null);
        showMessage(`Login failed: ${payload.message}`, 5000);
        navigate('/login'); // Stay on login screen or navigate to a dedicated failure page
      }
    };

    window.addEventListener('message', handleAuthMessage);

    // Cleanup listener on component unmount
    return () => {
      window.removeEventListener('message', handleAuthMessage);
    };
  }, [navigate, showMessage]);


  // --- User Interaction Functions (Prop drilling to components) ---

  const handleGoogleLogin = () => {
    const authPopup = window.open(
      'https://minesweeper-flags-backend.onrender.com/auth/google',
      '_blank', // Open in a new tab/window
      'width=500,height=600,toolbar=no,menubar=no,location=no,status=no'
    );
    // Periodically check if the popup has closed
    const checkPopup = setInterval(() => {
      if (!authPopup || authPopup.closed) {
        clearInterval(checkPopup);
        console.log('Authentication pop-up closed (Google).');
        // If popup closes without message, it's either user cancelled or issue.
        // The main useEffect will eventually re-check auth status.
      }
    }, 500);
  };

  const handleFacebookLogin = () => {
    const authPopup = window.open(
      'https://minesweeper-flags-backend.onrender.com/auth/facebook',
      '_blank',
      'width=500,height=600,toolbar=no,menubar=no,location=no,status=no'
    );
    const checkPopup = setInterval(() => {
      if (!authPopup || authPopup.closed) {
        clearInterval(checkPopup);
        console.log('Authentication pop-up closed (Facebook).');
      }
    }, 500);
  };

  const handleLogout = async () => {
    try {
      const response = await fetch('https://minesweeper-flags-backend.onrender.com/logout', {
        method: 'GET',
        credentials: 'include',
      });
      if (response.ok) {
        setUser(null);
        setLoggedIn(false);
        resetGameState(); // Reset all game and lobby states
        showMessage('Logged out successfully.', 3000);
        navigate('/login'); // Navigate back to login
      } else {
        console.error('Logout failed.');
        showMessage('Logout failed. Please try again.', 5000);
      }
    } catch (error) {
      console.error('Error during logout:', error);
      showMessage('Error during logout. Please try again.', 5000);
    }
  };

  const invitePlayer = useCallback((id) => {
    if (loggedIn && user && socketReady && id !== socket.id) {
      socket.emit('invite-player', id);
      showMessage('Invitation sent.', 3000);
    } else {
      showMessage('Cannot send invite. Ensure you are logged in and socket is ready.', 5000);
    }
  }, [loggedIn, user, socketReady, showMessage]);

  const respondInvite = useCallback((accept) => {
    if (invite && socketReady) {
      socket.emit('respond-invite', { fromId: invite.fromId, accept });
      setInvite(null); // Clear the invitation popup
      showMessage(accept ? 'Accepted invitation!' : 'Rejected invitation.', 3000);
    }
  }, [invite, socketReady, showMessage]);

  const resumeGame = useCallback((gameIdToResume) => {
    if (gameIdToResume && socketReady) {
      socket.emit('resume-game', { gameId: gameIdToResume });
      showMessage('Attempting to resume game...', 3000);
    }
  }, [socketReady, showMessage]);

  const handleTileClick = useCallback((x, y) => {
    if (!gameId || !user || !socketReady) return; // Must be in a game, logged in, and socket ready

    if (bombMode) {
      // Client-side validation for bomb placement
      const MIN_COORD = 2; // For 3rd line/column (0-indexed)
      const MAX_COORD_X = 13; // For 14th column (16-1 - 2)
      const MAX_COORD_Y = 13; // For 14th line (16-1 - 2)

      if (x < MIN_COORD || x > MAX_COORD_X || y < MIN_COORD || y > MAX_COORD_Y) {
        showMessage('Bomb center must be within the highlighted 12x12 area.', 5000);
        return;
      }

      let allTilesRevealed = true;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const checkX = x + dx;
          const checkY = y + dy;
          if (checkX >= 0 && checkX < (board[0]?.length || 0) && checkY >= 0 && checkY < board.length) {
            if (!board[checkY][checkX].revealed) {
              allTilesRevealed = false;
              break;
            }
          } else {
            allTilesRevealed = false;
            break;
          }
        }
        if (!allTilesRevealed) break;
      }

      if (allTilesRevealed) {
        showMessage("All tiles in the bomb's blast area are already revealed.", 5000);
        return;
      }

      socket.emit('bomb-center', { gameId, x, y });
    } else if (playerNumber === turn && !gameOver) {
      socket.emit('tile-click', { gameId, x, y });
    }
  }, [gameId, user, socketReady, bombMode, playerNumber, turn, gameOver, board, showMessage]);


  const handleUseBomb = useCallback(() => {
    if (!gameId || !user || !socketReady) return;

    if (bombMode) {
      setBombMode(false); // Cancel bomb mode
      showMessage('Bomb mode cancelled.', 3000);
    } else if (!bombsUsed[playerNumber] && scores[playerNumber] < scores[playerNumber === 1 ? 2 : 1] && !gameOver) {
      socket.emit('use-bomb', { gameId });
    } else {
      if (bombsUsed[playerNumber]) {
        showMessage('You have already used your bomb!', 5000);
      } else if (scores[playerNumber] >= scores[playerNumber === 1 ? 2 : 1]) {
        showMessage('You can only use the bomb when you are behind in score!', 5000);
      }
    }
  }, [gameId, user, socketReady, bombMode, bombsUsed, playerNumber, scores, gameOver, showMessage]);

  const handleBackToLobby = useCallback(() => {
    if (gameId && socketReady) {
      socket.emit('leave-game', { gameId });
    }
    resetGameState();
    showMessage('Returned to lobby.', 3000);
    navigate('/lobby');
  }, [gameId, socketReady, resetGameState, showMessage, navigate]);

  const handleRestartGame = useCallback(() => {
    if (gameId && socketReady) {
      socket.emit('restart-game', { gameId });
      showMessage('Restarting game...', 3000);
    }
  }, [gameId, socketReady, showMessage]);


  // --- Conditional Rendering based on App State (using react-router-dom) ---
  // Ensure authChecked is true before rendering any main content to avoid flicker
  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        <p>Loading application...</p>
      </div>
    );
  }

  return (
    // <Router> is assumed to be in a parent component if App is not the root.
    // If App is the root, wrap everything inside <Router>.
    <div className="App">
      <Routes>
        <Route path="/login" element={
          <LoginScreen
            onGoogleLogin={handleGoogleLogin}
            onFacebookLogin={handleFacebookLogin}
            message={message}
          />
        } />
        <Route path="/lobby" element={
          <LobbyScreen
            user={user}
            playersList={playersList}
            onInvitePlayer={invitePlayer}
            invite={invite}
            onRespondInvite={respondInvite}
            onLogout={handleLogout}
            unfinishedGames={unfinishedGames}
            onResumeGame={resumeGame}
            message={message}
            socketId={socket.id} // Pass socket.id for filtering self from list
          />
        } />
        <Route path="/game/:gameId" element={
          <GameScreen
            gameId={gameId}
            playerNumber={playerNumber}
            board={board}
            turn={turn}
            scores={scores}
            bombsUsed={bombsUsed}
            bombMode={bombMode}
            gameOver={gameOver}
            opponentName={opponentName}
            onTileClick={handleTileClick}
            onUseBomb={handleUseBomb}
            onBackToLobby={handleBackToLobby}
            onRestartGame={handleRestartGame}
            message={message}
            lastClickedTile={lastClickedTile}
          />
        } />
        <Route path="/auth/callback-success" element={<AuthCallback type="success" />} />
        <Route path="/auth/callback-failure" element={<AuthCallback type="failure" />} />
        <Route path="/login-failed" element={<LoginFailedScreen />} />
        {/* Default route redirects to login if not logged in, or lobby if logged in */}
        <Route path="/" element={loggedIn ? <LobbyScreen user={user} playersList={playersList} onInvitePlayer={invitePlayer} invite={invite} onRespondInvite={respondInvite} onLogout={handleLogout} unfinishedGames={unfinishedGames} onResumeGame={resumeGame} message={message} socketId={socket.id} /> : <LoginScreen onGoogleLogin={handleGoogleLogin} onFacebookLogin={handleFacebookLogin} message={message} />} />
      </Routes>
    </div>
  );
}

// Export the App component wrapped with Router if it's the root component
// If App.js is already nested inside a Router in index.js, remove this wrap.
export default function AppWithRouter() {
  return (
    <Router>
      <App />
    </Router>
  );
}

