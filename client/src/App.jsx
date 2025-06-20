// src/App.jsx
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, useNavigate } from 'react-router-dom';
import io from 'socket.io-client';

// Import your components with .jsx suffix
import LoginScreen from './components/LoginScreen.jsx';
import LobbyScreen from './components/LobbyScreen.jsx';
import GameScreen from './components/GameScreen.jsx';
import AuthCallback from './components/AuthCallback.jsx';
import LoginFailedScreen from './components/LoginFailedScreen.jsx';

import './App.css'; // Your main CSS file

// Main App Component (will be wrapped by Router in AppWithRouter)
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

  // Use useRef to hold the mutable socket object
  const socketRef = useRef(null);

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
    if (socketRef.current && socketReady && user) { // Ensure socket is ready before emitting
        socketRef.current.emit("request-unfinished-games");
        socketRef.current.emit("join-lobby", user.displayName); // Re-emit join-lobby to update player's status in the list
    }
    navigate('/lobby');
  }, [socketReady, user?.displayName, navigate]);


  // --- Initial Authentication Status Check and Socket.IO Connection/Listeners ---
  useEffect(() => {
    const checkAuthStatusAndConnectSocket = async () => {
      try {
        const response = await fetch('https://minesweeper-flags-backend.onrender.com/me', {
          method: 'GET',
          credentials: 'include', // Crucial for sending session cookies
        });
        if (response.ok) {
          const data = await response.json();
          setUser(data.user);
          setLoggedIn(true);
          console.log('App.jsx: Initial auth check successful for:', data.user.displayName);

          // Initialize Socket.IO connection ONLY after successful authentication
          if (!socketRef.current) {
            console.log("Frontend: Initializing Socket.IO connection...");
            socketRef.current = io('https://minesweeper-flags-backend.onrender.com', {
              withCredentials: true, // Crucial for sending cookies with the handshake
            });

            // --- Attach Socket.IO Event Listeners ---
            socketRef.current.on('connect', () => {
              console.log('Socket.IO connected!');
              // Do NOT set socketReady here. Wait for explicit server confirmation.
            });

            socketRef.current.on('disconnect', () => {
              console.log('Socket.IO disconnected!');
              setSocketReady(false); // Reset socket readiness on disconnect
              showMessage('Disconnected from server. Please refresh.', 0); // Show persistent message
              setLoggedIn(false); // Assume logged out on disconnect
              setUser(null);
              resetGameState();
            });

            // Server sends this when the socket connection has its associated session/user context loaded
            socketRef.current.on('authenticated-socket-ready', () => {
              console.log('Frontend: Authenticated socket ready for game events!');
              setSocketReady(true);
              // Once socket is ready, if user is logged in, join lobby and request unfinished games.
              if (loggedIn && user) {
                socketRef.current.emit('join-lobby', user.displayName);
                socketRef.current.emit('request-unfinished-games');
              }
            });

            socketRef.current.on('join-error', (msg) => {
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

            socketRef.current.on('lobby-joined', (userName) => {
              setLoggedIn(true);
              if (user) setUser(prev => ({...prev, displayName: userName})); // Update user's displayName from server
              console.log(`Lobby joined as ${userName}!`);
              showMessage(`Welcome to the lobby, ${userName}!`);
            });

            socketRef.current.on('players-list', (players) => {
              setPlayersList(players);
            });

            socketRef.current.on('game-invite', (inviteData) => {
              setInvite(inviteData);
              showMessage(`Invitation from ${inviteData.fromName}!`);
            });

            socketRef.current.on('invite-rejected', ({ fromName, reason }) => {
              showMessage(`${fromName} rejected your invitation.${reason ? ` Reason: ${reason}` : ''}`, 5000);
              setInvite(null); // Clear the invite if rejected
            });

            socketRef.current.on('game-start', (data) => {
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

            socketRef.current.on('board-update', (game) => {
              setBoard(JSON.parse(game.board));
              setTurn(game.turn);
              setScores(game.scores);
              setBombsUsed(game.bombsUsed);
              setGameOver(game.gameOver);
              setBombMode(false);
              setLastClickedTile(game.lastClickedTile || { 1: null, 2: null }); // Update last clicked tile
            });

            socketRef.current.on('wait-bomb-center', () => {
              setBombMode(true);
              showMessage('Select a 5x5 bomb center.', 5000);
            });

            socketRef.current.on('bomb-error', (msg) => {
              showMessage(msg, 5000);
              setBombMode(false); // Exit bomb mode on error
            });

            socketRef.current.on('opponent-left', () => {
              showMessage('Opponent left the game. Returning to lobby.', 5000);
              resetGameState();
            });

            socketRef.current.on('game-restarted', (data) => {
              setBoard(JSON.parse(data.board));
              setTurn(data.turn);
              setScores(data.scores);
              setBombsUsed(data.bombsUsed);
              setGameOver(data.gameOver);
              setBombMode(false);
              setLastClickedTile(data.lastClickedTile || { 1: null, 2: null });
              showMessage('Game restarted!', 3000);
            });

            socketRef.current.on('opponent-reconnected', ({ name }) => {
              showMessage(`${name} has reconnected!`, 3000);
            });

            socketRef.current.on('receive-unfinished-games', (games) => {
              // Deserialize boards for display
              const deserializedGames = games.map(game => ({
                ...game,
                board: JSON.parse(game.board) // Deserialize board for each unfinished game
              }));
              setUnfinishedGames(deserializedGames);
            });
          }

        } else {
          setUser(null);
          setLoggedIn(false);
          console.log('App.jsx: Initial auth check failed (not logged in).');
        }
      } catch (error) {
        console.error('App.jsx: Error checking auth status:', error);
        setUser(null);
        setLoggedIn(false);
      } finally {
        setAuthChecked(true); // Mark initial auth check as complete
      }
    };

    checkAuthStatusAndConnectSocket();

    // --- OAuth Pop-up Message Listener (always active regardless of socket connection) ---
    const handleAuthMessage = async (event) => {
      // Ensure the message comes from a trusted origin (your own frontend URL or backend for callback)
      // The backend directly sends the HTML with postMessage now.
      if (event.origin !== 'https://minesweeper-flags-frontend.onrender.com' &&
          event.origin !== 'https://minesweeper-flags-backend.onrender.com') {
        console.warn('App.jsx: Message from untrusted origin:', event.origin);
        return;
      }

      const { type, payload } = event.data;

      if (type === 'authSuccess') {
        console.log('App.jsx: Authentication successful via pop-up:', payload);
        setUser(payload.user);
        setLoggedIn(true);
        showMessage(`Successfully logged in as ${payload.user.displayName}!`, 3000);
        // After successful login, the existing useEffect will handle joining lobby
        // once `loggedIn` state updates and `socketReady` becomes true.
        navigate('/lobby'); // Navigate to lobby directly
      } else if (type === 'authFailure') {
        console.error('App.jsx: Authentication failed via pop-up:', payload.message);
        setLoggedIn(false);
        setUser(null);
        showMessage(`Login failed: ${payload.message}`, 5000);
        navigate('/login'); // Stay on login screen or navigate to a dedicated failure page
      }
    };

    window.addEventListener('message', handleAuthMessage);


    // Cleanup function: unsubscribe from socket events and window message listener
    return () => {
      if (socketRef.current) {
        socketRef.current.off('connect');
        socketRef.current.off('disconnect');
        socketRef.current.off('authenticated-socket-ready');
        socketRef.current.off('join-error');
        socketRef.current.off('lobby-joined');
        socketRef.current.off('players-list');
        socketRef.current.off('game-invite');
        socketRef.current.off('invite-rejected');
        socketRef.current.off('game-start');
        socketRef.current.off('board-update');
        socketRef.current.off('wait-bomb-center');
        socketRef.current.off('bomb-error');
        socketRef.current.off('opponent-left');
        socketRef.current.off('game-restarted');
        socketRef.current.off('opponent-reconnected');
        socketRef.current.off('receive-unfinished-games');
        
        // Disconnect the socket when component unmounts
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      window.removeEventListener('message', handleAuthMessage);
    };
  }, [loggedIn, user, showMessage, resetGameState, navigate, socketReady]); // Add socketReady to dependencies

  // --- User Interaction Functions (Prop drilling to components) ---

  const handleGoogleLogin = () => {
    // Open the backend's Google auth URL in a new pop-up window
    const authPopup = window.open(
      'https://minesweeper-flags-backend.onrender.com/auth/google',
      '_blank', // Open in a new tab/window
      'width=500,height=600,toolbar=no,menubar=no,location=no,status=no'
    );

    // Optional: Periodically check if the popup has closed
    const checkPopup = setInterval(() => {
      if (!authPopup || authPopup.closed) {
        clearInterval(checkPopup);
        console.log('Authentication pop-up closed.');
        // The window.postMessage from the backend callback will handle updating state.
        // If it closed without message, we can't assume success/failure.
        // The `useEffect` listening for `authSuccess` or `authFailure` will catch it.
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
        console.log('Authentication pop-up closed.');
      }
    }, 500);
  };

  const handleLogout = useCallback(async () => {
    try {
      const response = await fetch('https://minesweeper-flags-backend.onrender.com/logout', {
        method: 'GET',
        credentials: 'include',
      });
      if (response.ok) {
        // Disconnect Socket.IO gracefully before reloading
        if (socketRef.current) {
          socketRef.current.disconnect();
          socketRef.current = null;
        }
        setUser(null);
        setLoggedIn(false);
        resetGameState(); // Reset all game and lobby states
        showMessage('Logged out successfully.', 3000);
        navigate('/login');
      } else {
        console.error('Logout failed.');
        showMessage('Logout failed. Please try again.', 5000);
      }
    } catch (error) {
      console.error('Error during logout:', error);
      showMessage('Error during logout. Please try again.', 5000);
    }
  }, [resetGameState, showMessage, navigate]);

  const invitePlayer = useCallback((id) => {
    if (loggedIn && user && socketRef.current && socketReady && id !== socketRef.current.id) {
      socketRef.current.emit('invite-player', id);
      showMessage('Invitation sent.', 3000);
    } else {
      showMessage('Cannot send invite. Ensure you are logged in and socket is ready.', 5000);
    }
  }, [loggedIn, user, socketReady, showMessage]);

  const respondInvite = useCallback((accept) => {
    if (invite && socketRef.current && socketReady) {
      socketRef.current.emit('respond-invite', { fromId: invite.fromId, accept });
      setInvite(null); // Clear the invitation popup
      showMessage(accept ? 'Accepted invitation!' : 'Rejected invitation.', 3000);
    }
  }, [invite, socketReady, showMessage]);

  const resumeGame = useCallback((gameIdToResume) => {
    if (gameIdToResume && socketRef.current && socketReady) {
      socketRef.current.emit('resume-game', { gameId: gameIdToResume });
      showMessage('Attempting to resume game...', 3000);
    }
  }, [socketReady, showMessage]);

  const handleTileClick = useCallback((x, y) => {
    if (!gameId || !user || !socketRef.current || !socketReady) return; // Must be in a game, logged in, and socket ready

    if (bombMode) {
      // Client-side validation for bomb placement
      const MIN_COORD = 2; // For 3rd column (0-indexed)
      const MAX_COORD_X = 13; // For 14th column (16-1 - 2 = 13)
      const MAX_COORD_Y = 13; // For 14th row (16-1 - 2 = 13)

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

      socketRef.current.emit('bomb-center', { gameId, x, y });
    } else if (playerNumber === turn && !gameOver) {
      socketRef.current.emit('tile-click', { gameId, x, y });
    }
  }, [gameId, user, socketReady, bombMode, playerNumber, turn, gameOver, board, showMessage]);


  const handleUseBomb = useCallback(() => {
    if (!gameId || !user || !socketRef.current || !socketReady) return;

    if (bombMode) {
      setBombMode(false); // Cancel bomb mode
      showMessage('Bomb mode cancelled.', 3000);
    } else if (!bombsUsed[playerNumber] && scores[playerNumber] < scores[playerNumber === 1 ? 2 : 1] && !gameOver) {
      socketRef.current.emit('use-bomb', { gameId });
    } else {
      if (bombsUsed[playerNumber]) {
        showMessage('You have already used your bomb!', 5000);
      } else if (scores[playerNumber] >= scores[playerNumber === 1 ? 2 : 1]) {
        showMessage('You can only use the bomb when you are behind in score!', 5000);
      }
    }
  }, [gameId, user, socketReady, bombMode, bombsUsed, playerNumber, scores, gameOver, showMessage]);

  const handleBackToLobby = useCallback(() => {
    if (gameId && socketRef.current && socketReady) {
      socketRef.current.emit('leave-game', { gameId });
    }
    resetGameState();
    showMessage('Returned to lobby.', 3000);
    navigate('/lobby');
  }, [gameId, socketReady, resetGameState, showMessage, navigate]);

  const handleRestartGame = useCallback(() => {
    if (gameId && socketRef.current && socketReady) {
      socketRef.current.emit('restart-game', { gameId });
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
            socketId={socketRef.current?.id} // Pass socket.id from ref for filtering self from list
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
        {/* AuthCallback and LoginFailedScreen are now handled by the backend's HTML response
            which uses window.opener.postMessage. These routes are mostly for direct access
            or if a failure redirect from backend leads here directly. */}
        <Route path="/auth/callback-success" element={<AuthCallback type="success" />} />
        <Route path="/auth/callback-failure" element={<AuthCallback type="failure" />} />
        <Route path="/login-failed" element={<LoginFailedScreen />} />
        {/* Default route redirects to login if not logged in, or lobby if logged in */}
        <Route path="/" element={loggedIn ? <LobbyScreen user={user} playersList={playersList} onInvitePlayer={invitePlayer} invite={invite} onRespondInvite={respondInvite} onLogout={handleLogout} unfinishedGames={unfinishedGames} onResumeGame={resumeGame} message={message} socketId={socketRef.current?.id} /> : <LoginScreen onGoogleLogin={handleGoogleLogin} onFacebookLogin={handleFacebookLogin} message={message} />} />
      </Routes>
    </div>
  );
}

// Export the App component wrapped with Router as it's the root component in your setup
export default function AppWithRouter() {
  return (
    <Router>
      <App />
    </Router>
  );
}
