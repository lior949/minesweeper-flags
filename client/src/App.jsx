import React, { useState, useEffect, useRef, useCallback } from 'react';
import io from 'socket.io-client';

// Ensure the Render backend URL is correctly set.
// This should match the URL of your deployed backend service.
const BACKEND_URL = 'https://minesweeper-flags-backend.onrender.com';

// Tailwind CSS is automatically included in the Canvas environment
// No explicit import for Tailwind is needed here.

// Game constants (must match backend)
const WIDTH = 16;
const HEIGHT = 16;

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState(null); // Stores { id, displayName }
  const [playerName, setPlayerName] = useState('');
  const [socket, setSocket] = useState(null);
  const [lobbyPlayers, setLobbyPlayers] = useState([]); // { id: socketId, name: playerName }
  const [statusMessage, setStatusMessage] = useState('');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authProvider, setAuthProvider] = useState(null); // 'google' or 'facebook'
  const [authPopup, setAuthPopup] = useState(null);

  // Game state
  const [gameId, setGameId] = useState(null);
  const [board, setBoard] = useState([]);
  const [playerNumber, setPlayerNumber] = useState(null); // 1 or 2
  const [turn, setTurn] = useState(null); // Current turn: 1 or 2
  const [scores, setScores] = useState({ 1: 0, 2: 0 }); // Scores for player 1 and 2
  const [bombsUsed, setBombsUsed] = useState({ 1: false, 2: false }); // Bomb usage status
  const [gameOver, setGameOver] = useState(false);
  const [opponentName, setOpponentName] = useState('Opponent');
  const [bombSelectionMode, setBombSelectionMode] = useState(false); // New state for bomb
  const [isJoinedLobby, setIsJoinedLobby] = useState(false); // To prevent re-joining lobby on reconnect
  const [showUnfinishedGamesModal, setShowUnfinishedGamesModal] = useState(false);
  const [unfinishedGames, setUnfinishedGames] = useState([]);

  // Ref for the socket instance to be accessible across renders
  const socketRef = useRef(null);

  // Function to determine the color class for revealed numbers
  const getNumberColorClass = useCallback((adjacentMines) => {
    switch (adjacentMines) {
      case 1: return 'text-blue-700'; // Blue
      case 2: return 'text-green-700'; // Green
      case 3: return 'text-red-700'; // Red
      case 4: return 'text-purple-700'; // Dark Blue / Purple
      case 5: return 'text-maroon-700'; // Maroon (defined in custom CSS if needed, otherwise use a dark red)
      case 6: return 'text-teal-700'; // Teal
      case 7: return 'text-black'; // Black
      case 8: return 'text-gray-700'; // Gray
      default: return ''; // For 0 or other cases, no special color
    }
  }, []);

  // Effect to manage authentication status and fetch user data
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch(`${BACKEND_URL}/me`, { credentials: 'include' });
        if (response.ok) {
          const data = await response.json();
          setUser(data.user);
          setIsAuthenticated(true);
          setPlayerName(data.user.displayName || `User_${data.user.id.substring(0, 8)}`);
          setStatusMessage(`Logged in as ${data.user.displayName}`);
          console.log("Authentication check successful. User:", data.user);
        } else {
          setIsAuthenticated(false);
          setUser(null);
          setPlayerName('');
          setStatusMessage('Not authenticated');
          console.log("Authentication check failed.");
        }
      } catch (error) {
        console.error('Error checking authentication status:', error);
        setIsAuthenticated(false);
        setUser(null);
        setPlayerName('');
        setStatusMessage('Error checking authentication status.');
      }
    };
    checkAuth();
  }, []); // Run only once on component mount

  // Effect to manage WebSocket connection and events
  useEffect(() => {
    if (!isAuthenticated) {
        console.log("Not authenticated, skipping socket connection setup.");
        if (socketRef.current) {
            socketRef.current.disconnect();
            socketRef.current = null;
        }
        return;
    }

    console.log("Attempting to connect to socket.io...");
    const newSocket = io(BACKEND_URL, {
        withCredentials: true,
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
    });
    socketRef.current = newSocket; // Store in ref
    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('Socket connected:', newSocket.id);
      setStatusMessage('Connected to server.');
      // Only join lobby or resume game *after* server confirms authentication via 'authenticated-socket-ready'
    });

    newSocket.on('authenticated-socket-ready', () => {
        console.log("Server confirmed authenticated socket ready.");
        // If the user isn't already in a game (checked by userGameMap on backend)
        // and hasn't explicitly joined the lobby yet (isJoinedLobby state)
        if (!isJoinedLobby && user) {
            console.log(`Authenticated user ${user.displayName} is now ready, joining lobby...`);
            newSocket.emit("join-lobby", user.displayName); // Pass the displayName from the user object
            setIsJoinedLobby(true);
        }
        // Request unfinished games on re-authentication/reconnection
        newSocket.emit("request-unfinished-games");
    });

    newSocket.on('disconnect', () => {
      console.log('Socket disconnected.');
      setStatusMessage('Disconnected from server. Reconnecting...');
      setIsJoinedLobby(false); // Allow re-joining lobby on next connect
    });

    newSocket.on('connect_error', (error) => {
      console.error('Socket connection error:', error);
      setStatusMessage(`Connection error: ${error.message}`);
    });

    newSocket.on('players-list', (players) => {
      console.log('Received players list:', players);
      // Filter out self from the list for inviting purposes
      setLobbyPlayers(players.filter(p => p.id !== newSocket.id));
    });

    newSocket.on('lobby-joined', (name) => {
        setStatusMessage(`Joined lobby as ${name}.`);
    });

    newSocket.on('join-error', (message) => {
      console.error('Join error:', message);
      setStatusMessage(`Error: ${message}`);
      // If there's a join error, it implies the lobby wasn't successfully joined
      setIsJoinedLobby(false);
      // If the error indicates not authenticated, update auth state
      if (message.includes("Authentication required")) {
          setIsAuthenticated(false);
          setUser(null);
      }
    });

    newSocket.on('game-invite', ({ fromId, fromName }) => {
      if (gameId) { // Already in a game, reject automatically
        newSocket.emit('respond-invite', { fromId, accept: false });
        setStatusMessage(`Rejected invite from ${fromName}: Already in a game.`);
        return;
      }
      const acceptInvite = window.confirm(`You have been invited to a game by ${fromName}. Do you accept?`);
      newSocket.emit('respond-invite', { fromId, accept: acceptInvite });
      if (acceptInvite) {
        setStatusMessage(`Accepted invite from ${fromName}. Starting game...`);
      } else {
        setStatusMessage(`Rejected invite from ${fromName}.`);
      }
    });

    newSocket.on('invite-rejected', ({ fromName, reason }) => {
      setStatusMessage(`Invite to ${fromName} rejected. ${reason || ''}`);
    });

    newSocket.on('game-start', (gameData) => {
      console.log('Game started:', gameData);
      setGameId(gameData.gameId);
      setBoard(JSON.parse(gameData.board)); // Parse the board string back to object
      setPlayerNumber(gameData.playerNumber);
      setTurn(gameData.turn);
      setScores(gameData.scores);
      setBombsUsed(gameData.bombsUsed);
      setGameOver(gameData.gameOver);
      setOpponentName(gameData.opponentName);
      setStatusMessage(`Game ${gameData.gameId} started! It's Player ${gameData.turn}'s turn.`);
      setIsJoinedLobby(true); // Indicate that we are now in a game
      setShowUnfinishedGamesModal(false); // Close if open
    });

    newSocket.on('board-update', (gameData) => {
      console.log('Board update:', gameData);
      setBoard(JSON.parse(gameData.board)); // Parse the board string back to object
      setTurn(gameData.turn);
      setScores(gameData.scores);
      setBombsUsed(gameData.bombsUsed);
      setGameOver(gameData.gameOver);
      if (gameData.gameOver) {
        const winner = gameData.scores[gameData.playerNumber] > gameData.scores[gameData.playerNumber === 1 ? 2 : 1] ? 'You' : opponentName;
        const result = gameData.scores[gameData.playerNumber] > gameData.scores[gameData.playerNumber === 1 ? 2 : 1] ? 'won' : 'lost';
        setStatusMessage(`Game Over! ${winner} ${result}! Final Scores - You: ${gameData.scores[gameData.playerNumber]}, ${opponentName}: ${gameData.scores[gameData.playerNumber === 1 ? 2 : 1]}`);
      } else {
        setStatusMessage(`It's Player ${gameData.turn}'s turn.`);
      }
    });

    newSocket.on('game-restarted', (gameData) => {
        console.log('Game restarted:', gameData);
        setGameId(gameData.gameId);
        setBoard(JSON.parse(gameData.board)); // Parse the board string back to object
        setPlayerNumber(gameData.playerNumber);
        setTurn(gameData.turn);
        setScores(gameData.scores);
        setBombsUsed(gameData.bombsUsed);
        setGameOver(gameData.gameOver);
        setOpponentName(gameData.opponentName);
        setStatusMessage(`Game ${gameData.gameId} restarted! It's Player ${gameData.turn}'s turn.`);
        setBombSelectionMode(false); // Exit bomb selection mode on restart
    });

    newSocket.on('wait-bomb-center', () => {
      setStatusMessage('Select a tile to drop your bomb (5x5 area).');
      setBombSelectionMode(true);
    });

    newSocket.on('bomb-error', (message) => {
      setStatusMessage(`Bomb error: ${message}`);
      setBombSelectionMode(false); // Exit bomb selection on error
    });

    newSocket.on('opponent-left', () => {
      setStatusMessage(`${opponentName} has left the game. You can leave the game or wait for them to reconnect.`);
    });

    newSocket.on('opponent-reconnected', ({ name }) => {
        setStatusMessage(`${name} has reconnected!`);
    });

    newSocket.on('receive-unfinished-games', (gamesList) => {
        setUnfinishedGames(gamesList);
        // Automatically show modal if there are unfinished games
        if (gamesList.length > 0) {
            setShowUnfinishedGamesModal(true);
        }
    });


    return () => {
      console.log('Cleaning up socket connection...');
      newSocket.off('connect');
      newSocket.off('authenticated-socket-ready');
      newSocket.off('disconnect');
      newSocket.off('connect_error');
      newSocket.off('players-list');
      newSocket.off('lobby-joined');
      newSocket.off('join-error');
      newSocket.off('game-invite');
      newSocket.off('invite-rejected');
      newSocket.off('game-start');
      newSocket.off('board-update');
      newSocket.off('game-restarted');
      newSocket.off('wait-bomb-center');
      newSocket.off('bomb-error');
      newSocket.off('opponent-left');
      newSocket.off('opponent-reconnected');
      newSocket.off('receive-unfinished-games');
      newSocket.disconnect();
    };
  }, [isAuthenticated, user, isJoinedLobby, opponentName]); // Re-run if auth state or user changes

  // Handler for authentication popup
  useEffect(() => {
    const handleMessage = (event) => {
      // Ensure the message is from the expected origin for security
      if (event.origin !== "https://minesweeper-flags-frontend.onrender.com") {
        return;
      }
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'AUTH_SUCCESS' && data.user) {
          setUser(data.user);
          setIsAuthenticated(true);
          setPlayerName(data.user.displayName || `User_${data.user.id.substring(0, 8)}`);
          setStatusMessage(`Logged in as ${data.user.displayName}`);
          setShowAuthModal(false); // Close modal
          if (authPopup) {
            authPopup.close(); // Close the pop-up
            setAuthPopup(null);
          }
          console.log("Received AUTH_SUCCESS message:", data.user);
        } else if (data.type === 'AUTH_ERROR') {
          setStatusMessage(`Authentication failed: ${data.message}`);
          console.error("Received AUTH_ERROR message:", data.message);
          setShowAuthModal(false);
          if (authPopup) {
            authPopup.close();
            setAuthPopup(null);
          }
        }
      } catch (e) {
        console.error("Error parsing message from auth popup:", e);
      }
    };

    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [authPopup]);


  // Login functions
  const handleLogin = (provider) => {
    setAuthProvider(provider);
    setShowAuthModal(true); // Show the modal
    const authUrl = `${BACKEND_URL}/auth/${provider}`;
    const popup = window.open(authUrl, '_blank', 'width=500,height=600');
    setAuthPopup(popup); // Store popup reference
  };

  const handleLogout = async () => {
    try {
      const response = await fetch(`${BACKEND_URL}/logout`, { credentials: 'include' });
      if (response.ok) {
        setIsAuthenticated(false);
        setUser(null);
        setPlayerName('');
        setGameId(null);
        setBoard([]);
        setPlayerNumber(null);
        setTurn(null);
        setScores({ 1: 0, 2: 0 });
        setBombsUsed({ 1: false, 2: false });
        setGameOver(false);
        setOpponentName('Opponent');
        setStatusMessage('Logged out successfully.');
        setIsJoinedLobby(false);
        setLobbyPlayers([]); // Clear lobby players on logout
        setShowUnfinishedGamesModal(false); // Close games modal
        setUnfinishedGames([]);
        if (socketRef.current) {
            socketRef.current.disconnect(); // Disconnect socket on logout
            socketRef.current = null;
        }
      } else {
        setStatusMessage('Logout failed.');
      }
    } catch (error) {
      console.error('Error during logout:', error);
      setStatusMessage('Error during logout.');
    }
  };

  const joinLobby = () => {
    if (socket && user && !isJoinedLobby) { // Only join if socket is ready and not already joined
        socket.emit("join-lobby", user.displayName); // Use display name from auth
        setIsJoinedLobby(true);
    } else {
        setStatusMessage("Not connected to server or already in lobby.");
    }
  };

  const invitePlayer = (targetSocketId) => {
    if (socket && gameId === null) {
      socket.emit('invite-player', targetSocketId);
      setStatusMessage('Invite sent. Waiting for response...');
    } else {
      setStatusMessage('Cannot send invite: Already in a game or not connected.');
    }
  };

  const handleTileClick = (x, y) => {
    if (!socket || gameOver || turn !== playerNumber) {
      setStatusMessage("It's not your turn, game is over, or not connected.");
      return;
    }
    if (bombSelectionMode) {
      socket.emit('bomb-center', { gameId, x, y });
      setBombSelectionMode(false);
    } else {
      socket.emit('tile-click', { gameId, x, y });
    }
  };

  const useBomb = () => {
    if (!socket || gameOver || bombsUsed[playerNumber] || turn !== playerNumber) {
      setStatusMessage(`Cannot use bomb. Game over: ${gameOver}, Bomb used: ${bombsUsed[playerNumber]}, Your turn: ${turn === playerNumber}`);
      return;
    }
    socket.emit('use-bomb', { gameId });
  };

  const restartGame = () => {
    if (socket && gameId) {
      socket.emit('restart-game', { gameId });
      setStatusMessage('Requesting game restart...');
      setBombSelectionMode(false); // Exit bomb selection mode on restart
    }
  };

  const leaveGame = () => {
    if (socket && gameId) {
      socket.emit('leave-game', { gameId });
      // Reset local game state
      setGameId(null);
      setBoard([]);
      setPlayerNumber(null);
      setTurn(null);
      setScores({ 1: 0, 2: 0 });
      setBombsUsed({ 1: false, 2: false });
      setGameOver(false);
      setOpponentName('Opponent');
      setStatusMessage('You have left the game. Join the lobby to play again!');
      setIsJoinedLobby(false); // Allow joining lobby again
      setBombSelectionMode(false); // Exit bomb selection mode
    }
  };

  const resumeGame = (selectedGameId) => {
    if (socket && user) {
        socket.emit('resume-game', { gameId: selectedGameId });
        setStatusMessage(`Attempting to resume game ${selectedGameId}...`);
    } else {
        setStatusMessage('Not connected or not authenticated to resume game.');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 text-gray-100 font-inter flex flex-col items-center p-4">
      {/* Auth/User Info Header */}
      <div className="w-full max-w-4xl bg-gray-700 p-4 rounded-lg shadow-xl mb-6 flex justify-between items-center">
        {isAuthenticated ? (
          <div className="flex items-center space-x-4">
            <span className="text-lg font-semibold">Welcome, {user?.displayName || 'Player'}!</span>
            {user?.id && <span className="text-sm text-gray-400">(ID: {user.id})</span>} {/* Display user ID */}
            <button
              onClick={handleLogout}
              className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition duration-200 shadow-md"
            >
              Logout
            </button>
          </div>
        ) : (
          <div className="flex space-x-4">
            <button
              onClick={() => handleLogin('google')}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition duration-200 shadow-md"
            >
              Login with Google
            </button>
            <button
              onClick={() => handleLogin('facebook')}
              className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition duration-200 shadow-md"
            >
              Login with Facebook
            </button>
          </div>
        )}
      </div>

      {/* Status Message */}
      <p className="text-lg mb-4 text-center text-yellow-300">{statusMessage}</p>

      {/* Lobby / Game Controls */}
      <div className="w-full max-w-4xl bg-gray-700 p-6 rounded-lg shadow-xl mb-6">
        {!gameId ? (
          // Lobby View
          <>
            <h2 className="text-2xl font-bold mb-4 text-center text-white">Lobby</h2>
            <div className="flex flex-col md:flex-row justify-center items-center md:space-x-4 space-y-4 md:space-y-0">
              {!isJoinedLobby && isAuthenticated && (
                  <button
                      onClick={joinLobby}
                      className="px-6 py-3 bg-green-600 text-white rounded-md text-xl font-bold hover:bg-green-700 transition duration-200 shadow-lg w-full md:w-auto"
                  >
                      Join Lobby
                  </button>
              )}
              {isAuthenticated && (
                <button
                  onClick={() => socket.emit("request-unfinished-games")}
                  className="px-6 py-3 bg-blue-600 text-white rounded-md text-xl font-bold hover:bg-blue-700 transition duration-200 shadow-lg w-full md:w-auto"
                >
                  View My Games
                </button>
              )}
            </div>

            {lobbyPlayers.length > 0 && (
              <div className="mt-8">
                <h3 className="text-xl font-semibold mb-3 text-white text-center">Players Online:</h3>
                <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {lobbyPlayers.map((p) => (
                    <li key={p.id} className="bg-gray-800 p-4 rounded-md flex justify-between items-center shadow-md">
                      <span className="text-lg text-white">{p.name}</span>
                      <button
                        onClick={() => invitePlayer(p.id)}
                        className="px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 transition duration-200 shadow-md"
                      >
                        Invite to Game
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          // In-Game View
          <div className="text-center">
            <h2 className="text-2xl font-bold mb-4 text-white">Game in Progress: {gameId.substring(0, 8)}...</h2>
            <div className="flex justify-around text-lg font-semibold mb-4">
              <span className={`p-2 rounded-md ${playerNumber === 1 ? 'bg-blue-500' : 'bg-gray-600'} text-white`}>
                You (P1): {scores[1]} {playerNumber === 1 && turn === 1 && <span className="ml-2 text-yellow-300">👑</span>}
              </span>
              <span className={`p-2 rounded-md ${playerNumber === 2 ? 'bg-red-500' : 'bg-gray-600'} text-white`}>
                {opponentName} (P2): {scores[2]} {playerNumber === 2 && turn === 2 && <span className="ml-2 text-yellow-300">👑</span>}
              </span>
            </div>
            <div className="flex justify-center space-x-4 mb-4">
              <button
                onClick={useBomb}
                disabled={bombsUsed[playerNumber] || gameOver || turn !== playerNumber}
                className={`px-6 py-3 rounded-md text-xl font-bold shadow-lg transition duration-200 ${
                  bombsUsed[playerNumber] || gameOver || turn !== playerNumber
                    ? 'bg-gray-500 cursor-not-allowed'
                    : 'bg-yellow-600 hover:bg-yellow-700 text-white'
                }`}
              >
                Use Bomb {!bombsUsed[playerNumber] && '(1 remaining)'}
              </button>
              <button
                onClick={restartGame}
                className="px-6 py-3 bg-orange-600 text-white rounded-md text-xl font-bold hover:bg-orange-700 transition duration-200 shadow-lg"
              >
                Restart Game
              </button>
              <button
                onClick={leaveGame}
                className="px-6 py-3 bg-red-600 text-white rounded-md text-xl font-bold hover:bg-red-700 transition duration-200 shadow-lg"
              >
                Leave Game
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Minesweeper Board */}
      {gameId && (
        <div className="w-full max-w-2xl bg-gray-700 p-4 rounded-lg shadow-xl overflow-auto">
          <div
            className="grid mx-auto"
            style={{
              gridTemplateColumns: `repeat(${WIDTH}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${HEIGHT}, minmax(0, 1fr))`,
              width: 'fit-content', // Ensure content fits
              minWidth: '100%', // Allow grid to stretch
            }}
          >
            {board.map((row, y) =>
              row.map((tile, x) => (
                <div
                  key={`${x}-${y}`}
                  onClick={() => handleTileClick(x, y)}
                  className={`
                    w-8 h-8 md:w-10 md:h-10 border border-gray-600 flex items-center justify-center text-lg md:text-xl font-bold rounded-sm
                    ${
                      tile.revealed
                        ? tile.isMine
                          ? tile.owner === playerNumber
                            ? 'bg-red-800 text-white' // Mine revealed by self
                            : 'bg-red-600 text-white' // Mine revealed by opponent
                          : 'bg-gray-300' // Revealed non-mine
                        : 'bg-gray-500 hover:bg-gray-400 cursor-pointer' // Unrevealed
                    }
                    ${bombSelectionMode ? 'ring-2 ring-yellow-400 ring-offset-2 ring-offset-gray-700' : ''}
                  `}
                >
                  {tile.revealed ? (
                    tile.isMine ? (
                      <span role="img" aria-label="mine">
                        💣
                      </span>
                    ) : tile.adjacentMines > 0 ? (
                      <span className={`${getNumberColorClass(tile.adjacentMines)}`}>
                        {tile.adjacentMines}
                      </span>
                    ) : (
                      ''
                    ) // Empty for 0 adjacent mines
                  ) : (
                    ''
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Auth Modal */}
      {showAuthModal && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-gray-800 p-8 rounded-lg shadow-lg text-center">
            <h3 className="text-2xl font-bold mb-4 text-white">Authenticate with {authProvider === 'google' ? 'Google' : 'Facebook'}</h3>
            <p className="text-gray-300 mb-6">Please complete the authentication in the pop-up window.</p>
            <button
              onClick={() => {
                if (authPopup) authPopup.close();
                setShowAuthModal(false);
                setAuthPopup(null);
              }}
              className="px-6 py-2 bg-red-600 text-white rounded-md hover:bg-red-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Unfinished Games Modal */}
      {showUnfinishedGamesModal && unfinishedGames.length > 0 && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-gray-800 p-8 rounded-lg shadow-lg text-left w-full max-w-md">
            <h3 className="text-2xl font-bold mb-4 text-white text-center">Your Unfinished Games</h3>
            <ul className="space-y-3">
              {unfinishedGames.map((game) => (
                <li key={game.gameId} className="bg-gray-700 p-4 rounded-md flex flex-col sm:flex-row justify-between items-center">
                  <div>
                    <p className="text-white text-lg font-semibold">Game ID: {game.gameId.substring(0, 8)}...</p>
                    <p className="text-gray-300 text-sm">Opponent: {game.opponentName}</p>
                    <p className="text-gray-300 text-sm">Status: {game.status}</p>
                    <p className="text-gray-300 text-sm">Last Updated: {game.lastUpdated}</p>
                  </div>
                  <button
                    onClick={() => resumeGame(game.gameId)}
                    className="mt-3 sm:mt-0 px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition duration-200 shadow-md"
                  >
                    Resume Game
                  </button>
                </li>
              ))}
            </ul>
            <div className="text-center mt-6">
              <button
                onClick={() => setShowUnfinishedGamesModal(false)}
                className="px-6 py-2 bg-red-600 text-white rounded-md hover:bg-red-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
