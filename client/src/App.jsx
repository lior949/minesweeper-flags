// App.jsx
import React, { useEffect, useState, useRef, useCallback } from "react";
import io from "socket.io-client";
// We no longer need to import GoogleLogin and FacebookLogin components directly
// because their logic is now integrated into App.jsx's handleLogin.
// import GoogleLogin from "./GoogleLogin";
// import FacebookLogin from "./FacebookLogin";
import AuthCallback from "./AuthCallback"; // AuthCallback component for pop-up redirects
import "./App.css"; // Stylesheet for the application

// Ensure the Render backend URL is correctly set.
const BACKEND_URL = "https://minesweeper-flags-backend.onrender.com";

// Game constants (must match backend)
const WIDTH = 16;
const HEIGHT = 16;

function App() {
  // NEW: Determine if this is the OAuth callback window
  // If this is the AuthCallback window, render only the AuthCallback component
  // and prevent the main App logic from running. This must be at the very top.
  const isAuthCallback = window.location.pathname === '/auth/callback';
  if (isAuthCallback) {
    return <AuthCallback />;
  }

  // If not the AuthCallback window, proceed with the main App logic
  console.log("App component rendered (main application).");

  // === Lobby & Authentication State ===
  const [name, setName] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);
  const [playersList, setPlayersList] = useState([]);
  const [message, setMessage] = useState(""); // General message/error display

  // NEW: State and ref for Socket.IO instance
  const socketRef = useRef(null); // Use useRef to hold the mutable socket object
  const [isSocketConnected, setIsSocketConnected] = useState(false); // New state to track actual socket.io connection status


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
  const [invite, setInvite] = useState(null);
  const [unfinishedGames, setUnfinishedGames] = useState([]); // NEW: State for unfinished games
  const [lastClickedTile, setLastClickedTile] = useState({ 1: null, 2: null }); // NEW: Track last clicked tile for each player

  // State to manage the authentication popup window reference
  const [authPopup, setAuthPopup] = useState(null);

  // --- Helper to display messages (replaces alert) ---
  const showMessage = (msg, isError = false) => {
    setMessage(msg);
    if (isError) {
      console.error(msg);
    } else {
      console.log(msg);
    }
    // Clear message after some time (e.g., 5 seconds)
    setTimeout(() => setMessage(""), 5000);
  };

  // --- Initial Authentication Check and Socket.IO Connection ---
  // This useEffect will run once on mount for the main App component.
  // It handles initial auth check and setting up the Socket.IO client.
  useEffect(() => {
    console.log("App useEffect: Running initial setup.");

    const checkAuthStatusAndConnectSocket = async () => {
      try {
        const response = await fetch(`${BACKEND_URL}/me`, { // Use BACKEND_URL constant
          method: "GET",
          credentials: "include",
        });

        if (response.ok) {
          const data = await response.json();
          // Ensure user has an ID and displayName
          const userDisplayName = data.user.displayName || `User_${data.user.id.substring(0, 8)}`;
          setName(userDisplayName);
          setLoggedIn(true);
          console.log("App.jsx: Initial auth check successful for:", userDisplayName);

          // NEW: Initialize Socket.IO connection ONLY once per component mount
          // and manage connection status
          if (!socketRef.current) {
            console.log("Frontend: Initializing Socket.IO connection...");
            socketRef.current = io(BACKEND_URL, { // Use BACKEND_URL constant
              withCredentials: true,
            });

            // --- Attach Socket.IO Event Listeners after connection ---
            socketRef.current.on('connect', () => {
                console.log("Socket.IO client: Connected!");
                setIsSocketConnected(true);
                // After successful connection, the backend will send 'authenticated-socket-ready'
                // if the session is properly loaded. Wait for that to emit join-lobby.
            });

            socketRef.current.on('disconnect', (reason) => {
                console.log(`Socket.IO client: Disconnected! Reason: ${reason}`);
                setIsSocketConnected(false);
                setMessage("Disconnected from server. Reconnecting...");
            });

            socketRef.current.on('connect_error', (error) => {
                console.error("Socket.IO client: Connection error!", error);
                setMessage(`Socket connection error: ${error.message}. Please check server logs.`, true);
                setIsSocketConnected(false);
            });

            // The 'authenticated-socket-ready' event from the server means Passport session is loaded
            socketRef.current.on('authenticated-socket-ready', () => {
                console.log("Frontend: Server confirmed authenticated socket ready!");
                // Now it's truly safe to emit things that rely on server-side session.
                // Only emit join-lobby if already logged in and name is set, and not already joined.
                if (loggedIn && name && !sessionStorage.getItem('isJoinedLobby')) {
                  console.log("Frontend: Emitting join-lobby after authenticated-socket-ready.");
                  socketRef.current.emit("join-lobby", name);
                  sessionStorage.setItem('isJoinedLobby', 'true'); // Prevent re-joining on every reconnect
                }
            });

            socketRef.current.on("join-error", (msg) => {
              showMessage(msg, true);
              if (msg.includes("Authentication required")) {
                setLoggedIn(false);
                setName("");
                sessionStorage.removeItem('isJoinedLobby'); // Clear flag if auth failed
              }
            });

            socketRef.current.on("lobby-joined", (userName) => {
              setLoggedIn(true); // Should already be true if this is called, but confirm
              setName(userName); // Update name, potentially with the server-validated name.
              showMessage(`Lobby joined successfully as ${userName}!`);
              sessionStorage.setItem('isJoinedLobby', 'true'); // Ensure flag is set on successful join
              socketRef.current.emit("request-unfinished-games");
            });

            socketRef.current.on("players-list", (players) => {
              setPlayersList(players);
            });

            socketRef.current.on("game-invite", (inviteData) => {
              setInvite(inviteData);
              showMessage(`Invitation from ${inviteData.fromName}!`);
            });

            socketRef.current.on("invite-rejected", ({ fromName, reason }) => {
              showMessage(`${fromName} rejected your invitation. ${reason ? `Reason: ${reason}` : ''}`, true);
            });

            socketRef.current.on("game-start", (data) => {
              setGameId(data.gameId);
              setPlayerNumber(data.playerNumber);
              setBoard(JSON.parse(data.board));
              setTurn(data.turn);
              setScores(data.scores);
              setBombsUsed(data.bombsUsed);
              setGameOver(data.gameOver);
              setOpponentName(data.opponentName);
              setBombMode(false);
              setLastClickedTile(data.lastClickedTile || { 1: null, 2: null });
              setMessage("");
              console.log("Frontend: Game started! My player number:", data.playerNumber);
              setUnfinishedGames([]);
              sessionStorage.setItem('isJoinedLobby', 'true'); // Stay in game state
            });

            socketRef.current.on("board-update", (game) => {
              setBoard(JSON.parse(game.board));
              setTurn(game.turn);
              setScores(game.scores);
              setBombsUsed(game.bombsUsed);
              setGameOver(game.gameOver);
              setBombMode(false);
              setLastClickedTile(game.lastClickedTile || { 1: null, 2: null });
              setMessage("");
            });

            socketRef.current.on("wait-bomb-center", () => {
              setBombMode(true);
              setMessage("Select 5x5 bomb center.");
            });

            socketRef.current.on("opponent-left", () => {
              showMessage("Opponent left the game. Returning to lobby.", true);
              setGameId(null);
              setPlayerNumber(null);
              setBoard([]);
              setTurn(null);
              setScores({ 1: 0, 2: 0 });
              setBombsUsed({ 1: false, 2: false });
              setGameOver(false);
              setOpponentName("");
              setBombMode(false);
              setLastClickedTile({ 1: null, 2: null });
              sessionStorage.removeItem('isJoinedLobby'); // Allow re-joining lobby
              if (socketRef.current) {
                socketRef.current.emit("request-unfinished-games");
              }
            });

            socketRef.current.on("bomb-error", (msg) => {
              showMessage(msg, true);
              setBombMode(false);
            });

            socketRef.current.on("receive-unfinished-games", (games) => {
              const deserializedGames = games.map(game => ({
                  ...game,
                  board: JSON.parse(game.board) // Ensure board is parsed for display
              }));
              setUnfinishedGames(deserializedGames);
              console.log("Received unfinished games:", deserializedGames);
            });

            socketRef.current.on("opponent-reconnected", ({ name }) => {
                showMessage(`${name} has reconnected!`);
            });

            socketRef.current.on("game-restarted", (data) => {
              showMessage("Game restarted due to first click on blank tile!", false);
              setGameId(data.gameId);
              setPlayerNumber(data.playerNumber);
              setBoard(JSON.parse(data.board));
              setTurn(data.turn);
              setScores(data.scores);
              setBombsUsed(data.bombsUsed);
              setGameOver(data.gameOver);
              setOpponentName(data.opponentName);
              setBombMode(false);
              setLastClickedTile(data.lastClickedTile || { 1: null, 2: null });
            });
          } else {
            console.log("Frontend: Socket.IO already initialized. Re-checking lobby join.");
            // If already initialized and connected, and not in game, try to re-join lobby.
            if (loggedIn && name && isSocketConnected && !sessionStorage.getItem('isJoinedLobby')) {
                console.log("Frontend: Re-emitting join-lobby from already connected socket.");
                socketRef.current.emit("join-lobby", name);
                sessionStorage.setItem('isJoinedLobby', 'true');
            }
          }

        } else {
          setLoggedIn(false);
          setName("");
          console.log("Frontend: Auth check failed (response not ok).");
          if (socketRef.current) {
            socketRef.current.disconnect();
            socketRef.current = null;
            setIsSocketConnected(false);
          }
          sessionStorage.removeItem('isJoinedLobby'); // Clear flag if not logged in
        }
      } catch (err) {
        console.error("Frontend: Error during auth check or socket setup:", err);
        setLoggedIn(false);
        setName("");
        setMessage(`An error occurred: ${err.message}. Please refresh.`, true);
        if (socketRef.current) {
          socketRef.current.disconnect();
          socketRef.current = null;
          setIsSocketConnected(false);
        }
        sessionStorage.removeItem('isJoinedLobby'); // Clear flag on error
      }
    };

    checkAuthStatusAndConnectSocket();

    // NEW: Listener for messages from the OAuth pop-up window
    const handleAuthMessage = (event) => {
      // Ensure the message is from a trusted origin (your frontend's exact origin).
      // IMPORTANT: event.origin must match the URL of your frontend, NOT the backend.
      // The backend redirects the popup *to the frontend* with data in the hash.
      if (event.origin !== "https://minesweeper-flags-frontend.onrender.com") { // Your frontend URL
        console.warn("Received message from untrusted origin:", event.origin);
        return;
      }

      if (event.data && event.data.type === 'AUTH_SUCCESS') {
        const { user } = event.data;
        console.log("App.jsx: Received AUTH_SUCCESS from pop-up:", user);
        // Set main app's authentication state
        setName(user.displayName || `User_${user.id.substring(0, 8)}`);
        setLoggedIn(true);
        showMessage("Login successful!");
        sessionStorage.removeItem('isJoinedLobby'); // Force re-join lobby on successful new login
        if (authPopup) { // Close the popup if it's still open
          authPopup.close();
          setAuthPopup(null);
        }
        // Clean up URL hash in the main window if it was used for redirect data
        window.history.replaceState({}, document.title, window.location.pathname);
      } else if (event.data && event.data.type === 'AUTH_FAILURE') {
        console.error("App.jsx: Received AUTH_FAILURE from pop-up:", event.data.message);
        showMessage(`Login failed: ${event.data.message}`, true);
        setLoggedIn(false);
        setName("");
        sessionStorage.removeItem('isJoinedLobby'); // Clear flag on login failure
        if (authPopup) {
          authPopup.close();
          setAuthPopup(null);
        }
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    };

    window.addEventListener('message', handleAuthMessage);


    // Cleanup function for useEffect: disconnect socket and remove listeners
    return () => {
      console.log("App useEffect: Cleanup running.");
      if (socketRef.current) {
        console.log("App useEffect: Disconnecting socket and removing listeners.");
        socketRef.current.off('connect');
        socketRef.current.off('disconnect');
        socketRef.current.off('connect_error');
        socketRef.current.off('authenticated-socket-ready');
        socketRef.current.off("join-error");
        socketRef.current.off("lobby-joined");
        socketRef.current.off("players-list");
        socketRef.current.off("game-invite");
        socketRef.current.off("invite-rejected");
        socketRef.current.off("game-start");
        socketRef.current.off("board-update");
        socketRef.current.off("wait-bomb-center");
        socketRef.current.off("opponent-left");
        socketRef.current.off("bomb-error");
        socketRef.current.off("receive-unfinished-games");
        socketRef.current.off("opponent-reconnected");
        socketRef.current.off("game-restarted");

        socketRef.current.disconnect(); // Disconnect the socket
        socketRef.current = null; // Clear the ref
      }
      window.removeEventListener('message', handleAuthMessage); // Clean up message listener
      sessionStorage.removeItem('isJoinedLobby'); // Clear flag on unmount
    };
  }, [loggedIn, name, authPopup]); // Added authPopup to dependencies to ensure message listener setup

  // --- User Interaction Functions (using socketRef.current for emits) ---

  // Login functions to open OAuth pop-up
  const handleLogin = (provider) => {
    // Redirect the pop-up to your backend's auth endpoint (e.g., /auth/google or /auth/facebook)
    const authUrl = `${BACKEND_URL}/auth/${provider}`;
    // Open a new window for the OAuth flow. 'noopener' and 'noreferrer' are security best practices.
    const popup = window.open(authUrl, '_blank', 'width=500,height=600,noopener,noreferrer');
    setAuthPopup(popup); // Store reference to the popup window

    // Check if the popup was blocked by the browser's popup blocker.
    if (!popup || popup.closed || typeof popup.closed == 'undefined') {
      showMessage('Popup blocked! Please allow popups for this site to log in.', true);
    }
  };


  const invitePlayer = (id) => {
    if (loggedIn && socketRef.current && id !== socketRef.current.id) {
      socketRef.current.emit("invite-player", id);
      showMessage("Invitation sent.");
    } else {
        console.warn("Invite failed: Not logged in or socket not ready, or inviting self.");
    }
  };

  const respondInvite = (accept) => {
    if (invite && socketRef.current) {
      socketRef.current.emit("respond-invite", { fromId: invite.fromId, accept });
      setInvite(null);
      setMessage("");
    }
  };

  const handleClick = (x, y) => {
    if (!gameId || !socketRef.current) return;
    if (bombMode) {
      // Bomb mode logic: check coordinates for 5x5 area
      const MIN_COORD = 2;
      const MAX_COORD_X = WIDTH - 3; // Use WIDTH and HEIGHT constants
      const MAX_COORD_Y = HEIGHT - 3;

      if (x < MIN_COORD || x > MAX_COORD_X || y < MIN_COORD || y > MAX_COORD_Y) {
        showMessage("Bomb center must be within the 12x12 area.", true);
        return;
      }

      // Check if all tiles in the bomb area are already revealed
      let allTilesRevealed = true;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const checkX = x + dx;
          const checkY = y + dy;
          // Ensure coordinates are within board bounds before checking revealed status
          if (checkX >= 0 && checkX < WIDTH && checkY >= 0 && checkY < HEIGHT) {
            if (!board[checkY][checkX].revealed) {
              allTilesRevealed = false;
              break;
            }
          } else {
            // If any part of the 5x5 area is outside the board, it's not "all revealed"
            allTilesRevealed = false;
            break;
          }
        }
        if (!allTilesRevealed) break;
      }

      if (allTilesRevealed) {
        showMessage("All tiles in the bomb's blast area are already revealed.", true);
        return;
      }

      setMessage(""); // Clear any previous messages
      socketRef.current.emit("bomb-center", { gameId, x, y });
    } else if (playerNumber === turn && !gameOver) {
      // Normal tile click logic
      setMessage(""); // Clear any previous messages
      socketRef.current.emit("tile-click", { gameId, x, y });
    }
  };

  const useBomb = () => {
    // Check if bomb can be used (socket connected, in game, not game over, bomb not used, and it's player's turn)
    if (!socketRef.current || !gameId || gameOver || bombsUsed[playerNumber] || turn !== playerNumber) {
      if (bombsUsed[playerNumber]) {
        showMessage("You have already used your bomb!", true);
      } else if (!gameId || gameOver) {
        showMessage("Cannot use bomb now.", true);
      } else if (turn !== playerNumber) {
        showMessage("It's not your turn to use the bomb!", true);
      }
      return;
    }

    // Toggle bomb mode or use bomb if behind in score
    if (bombMode) {
      setBombMode(false); // Cancel bomb selection mode
      setMessage("");
    } else if (scores[playerNumber] < scores[playerNumber === 1 ? 2 : 1]) {
      // Only allow bomb usage if the current player is behind in score
      socketRef.current.emit("use-bomb", { gameId });
    } else {
      showMessage("You can only use the bomb when you are behind in score!", true);
    }
  };


  const backToLobby = () => {
    if (gameId && socketRef.current) {
        socketRef.current.emit("leave-game", { gameId });
    }

    // Reset all game-related state variables
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
    setMessage("");
    setUnfinishedGames([]);
    setLastClickedTile({ 1: null, 2: null });
    sessionStorage.removeItem('isJoinedLobby'); // Reset lobby flag so user can re-join
    if (socketRef.current) {
      socketRef.current.emit("request-unfinished-games"); // Request updated list of games
    }
};

  const logout = async () => {
  try {
    // Call backend logout endpoint
    await fetch(`${BACKEND_URL}/logout`, { // Use BACKEND_URL constant
      method: "GET",
      credentials: "include", // Send session cookie
    });

    // Disconnect socket gracefully
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
      setIsSocketConnected(false); // Update socket connection status
    }

    // Reset all authentication and game states
    setLoggedIn(false);
    setName("");
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
    setMessage("Logged out successfully.");
    sessionStorage.removeItem('isJoinedLobby'); // Clear flag on logout
  } catch (err) {
    console.error("Logout failed", err);
    showMessage("Logout failed. Please try again.", true);
  }
};

  // Helper function to render content inside a tile.
  const renderTile = (tile) => {
    if (!tile.revealed) return ""; // If tile is not revealed, show nothing
    if (tile.isMine) {
      // Display bomb emoji, colored by the player who revealed it
      if (tile.owner === 1) return <span className="text-red-500">💣</span>; // Player 1's bomb (red)
      if (tile.owner === 2) return <span className="text-blue-500">💣</span>; // Player 2's bomb (blue)
      return <span className="text-white">💣</span>; // Default bomb color if no owner (shouldn't happen with logic)
    }
    // If it's a revealed non-mine tile with adjacent mines, display the number
    if (tile.adjacentMines > 0) {
      // Apply the number-specific color class using Tailwind CSS classes
      return <span className={`font-bold ${getNumberColorClass(tile.adjacentMines)}`}>{tile.adjacentMines}</span>;
    }
    return ""; // Empty for revealed blank tiles
  };

  // Function to determine the color class for revealed numbers
  // This uses Tailwind's default color palette for simplicity.
  const getNumberColorClass = useCallback((adjacentMines) => {
    switch (adjacentMines) {
      case 1: return 'text-blue-700';
      case 2: return 'text-green-700';
      case 3: return 'text-red-700';
      case 4: return 'text-purple-700';
      case 5: return 'text-yellow-700'; // Using yellow for a distinct light brown-ish feel, adjust if needed
      case 6: return 'text-teal-700';
      case 7: return 'text-black'; // Black
      case 8: return 'text-gray-900'; // Darker gray for dark brown, adjust if needed
      default: return ''; // For 0 adjacent mines, no text, no color
    }
  }, []);

  const resumeGame = (gameIdToResume) => {
    if (gameIdToResume && socketRef.current) {
        socketRef.current.emit("resume-game", { gameId: gameIdToResume });
        showMessage("Attempting to resume game...");
    }
  };


  // --- Conditional Rendering based on App State ---

  if (!loggedIn) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 text-gray-100 font-inter flex flex-col items-center justify-center p-4">
        {message && <p className="app-message text-red-500 font-bold mb-4">{message}</p>}
        <h2 className="text-3xl font-bold mb-6 text-center text-white">Login to Join the Minesweeper Flags Lobby</h2>
        <div className="flex flex-col space-y-4">
          <button
            onClick={() => handleLogin('google')}
            className="px-8 py-4 bg-blue-600 text-white rounded-lg text-xl font-bold hover:bg-blue-700 transition duration-300 shadow-xl flex items-center justify-center space-x-3 transform hover:scale-105"
          >
            <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12.24 10.285V14.4h6.88c-.28 1.48-1.59 4.31-6.88 4.31-4.14 0-7.5-3.36-7.5-7.5s3.36-7.5 7.5-7.5c2.23 0 3.84 0.96 4.79 1.845l3.1-3.1C18.41 1.715 15.82 0 12.24 0 5.46 0 0 5.46 0 12.24s5.46 12.24 12.24 12.24c7.34 0 12.01-5.31 12.01-11.96 0-.79-.06-1.46-.17-2.125h-11.84z"/>
            </svg>
            <span>Login with Google</span>
          </button>
          <button
            onClick={() => handleLogin('facebook')}
            className="px-8 py-4 bg-indigo-600 text-white rounded-lg text-xl font-bold hover:bg-indigo-700 transition duration-300 shadow-xl flex items-center justify-center space-x-3 transform hover:scale-105"
          >
            <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M14 12h-1v5h1v-5zm3-2h-1.5a2.5 2.5 0 00-2.5 2.5V17h4V12.5a2.5 2.5 0 00-2.5-2.5zM12 2C6.477 2 2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.873V14.89h-2.54V12h2.54V9.77c0-2.535 1.554-3.926 3.792-3.926 1.095 0 2.19.195 2.19.195V8.5h-1.397c-1.259 0-1.638.775-1.638 1.56V12h2.773l-.443 2.89h-2.33V22h5.532c4.781-.745 8.438-4.882 8.438-9.873C22 6.477 17.523 2 12 2z" />
            </svg>
            <span>Login with Facebook</span>
          </button>
        </div>
      </div>
    );
  }

  // Lobby View
  if (!gameId) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 text-gray-100 font-inter flex flex-col items-center p-4">
        <div className="w-full max-w-4xl bg-gray-700 p-4 rounded-lg shadow-xl mb-6 flex justify-between items-center">
            <span className="text-lg font-semibold">Welcome, {name}!</span>
            <button onClick={logout} className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition duration-200 shadow-md">Logout</button>
        </div>

        {message && !message.includes("Error") && <p className="app-message text-green-400">{message}</p>}
        {message && message.includes("Error") && <p className="app-message text-red-500">{message}</p>}

        <h2 className="text-3xl font-bold mb-6 text-center text-white">Minesweeper Flags Lobby</h2>

        {/* Unfinished Games Section */}
        <div className="w-full max-w-xl bg-gray-700 p-6 rounded-lg shadow-xl mb-6">
          <h3 className="text-2xl font-semibold mb-4 text-white text-center">Your Games</h3>
            {unfinishedGames.length === 0 ? (
                <p className="text-gray-400 text-center">No active or unfinished games found. Start a new one!</p>
            ) : (
                <ul className="grid grid-cols-1 gap-3">
                    {unfinishedGames.map(game => (
                        <li key={game.gameId} className="bg-gray-800 p-4 rounded-md flex flex-col sm:flex-row justify-between items-center shadow-md">
                            <div>
                                <p className="text-white text-lg font-semibold">Game ID: {game.gameId.substring(0, 8)}...</p>
                                <p className="text-gray-300 text-sm">Opponent: {game.opponentName}</p>
                                <p className="text-gray-300 text-sm">Status: {game.status === 'active' ? 'Active' : 'Waiting for opponent'}</p>
                                <p className="text-gray-300 text-sm">Last updated: {game.lastUpdated}</p>
                            </div>
                            <button
                                onClick={() => resumeGame(game.gameId)}
                                className="mt-3 sm:mt-0 px-5 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition duration-200 shadow-md transform hover:scale-105"
                            >
                                Resume Game
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>

        {/* Online Players Section */}
        <div className="w-full max-w-xl bg-gray-700 p-6 rounded-lg shadow-xl">
          <h3 className="text-2xl font-semibold mb-4 text-white text-center">Other Online Players</h3>
          {playersList.length === 0 ? (
            <p className="text-gray-400 text-center">No other players online. Invite a friend or wait for others to join!</p>
          ) : (
            <ul className="grid grid-cols-1 gap-3">
              {playersList.map((p) => (
                <li
                  key={p.id}
                  className="bg-gray-800 p-4 rounded-md flex justify-between items-center shadow-md"
                >
                  <span className="text-lg text-white">{p.name}</span>
                  <button
                    onClick={() => invitePlayer(p.id)}
                    className="px-5 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition duration-200 shadow-md transform hover:scale-105"
                  >
                    Invite to Game
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Game Invite Popup */}
        {invite && (
          <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
            <div className="bg-gray-800 p-8 rounded-lg shadow-lg text-center">
              <p className="text-xl font-semibold text-white mb-4">
                Invitation from <b>{invite.fromName}</b>
              </p>
              <div className="flex justify-center space-x-4">
                <button
                  onClick={() => respondInvite(true)}
                  className="px-6 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition duration-200"
                >
                  Accept
                </button>
                <button
                  onClick={() => respondInvite(false)}
                  className="px-6 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition duration-200"
                >
                  Reject
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // In-Game View
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 text-gray-100 font-inter flex flex-col items-center p-4">
      <div className="w-full max-w-4xl bg-gray-700 p-4 rounded-lg shadow-xl mb-6 flex justify-between items-center">
        <span className="text-lg font-semibold">Welcome, {name}!</span>
        <button
          onClick={logout}
          className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition duration-200 shadow-md"
        >
          Logout
        </button>
      </div>

      <h1 className="text-3xl font-bold mb-4 text-white">Minesweeper Flags</h1>

      <p className="text-lg mb-2 text-yellow-300">
        You are Player {playerNumber} (vs. {opponentName})
      </p>
      <p className="text-lg mb-2 text-white">
        {turn && !gameOver ? `Current turn: Player ${turn}` : ""}
        {bombMode && " – Select 5x5 bomb center"}
      </p>
      {message && <p className="app-message text-red-500 font-bold mb-2">{message}</p>}
      <p className="text-xl mb-4 text-white">
        Score <span className="text-red-500">🔴 {scores[1]}</span> | <span className="text-blue-500">🔵 {scores[2]}</span>
      </p>

      <div className="flex space-x-4 mb-6">
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
          onClick={() => socketRef.current.emit("restart-game", { gameId })}
          className="px-6 py-3 bg-orange-600 text-white rounded-md text-xl font-bold hover:bg-orange-700 transition duration-200 shadow-lg"
        >
          Restart Game
        </button>
        <button
          onClick={backToLobby}
          className="px-6 py-3 bg-red-600 text-white rounded-md text-xl font-bold hover:bg-red-700 transition duration-200 shadow-lg"
        >
          Leave Game
        </button>
      </div>

      <div
        className="grid bg-gray-700 p-4 rounded-lg shadow-xl overflow-auto"
        style={{
          gridTemplateColumns: `repeat(${WIDTH}, 40px)`, // Fixed tile size for consistent display
          gridTemplateRows: `repeat(${HEIGHT}, 40px)`,
          width: `${WIDTH * 40 + 2 * (WIDTH - 1)}px`, // Calculate grid width + gaps
          height: `${HEIGHT * 40 + 2 * (HEIGHT - 1)}px`, // Calculate grid height + gaps
          maxWidth: '100%', // Ensure it's responsive
          maxHeight: '80vh', // Prevent very tall boards
          margin: '0 auto', // Center the grid
        }}
      >
        {board.flatMap((row, y) =>
          row.map((tile, x) => (
            <div
              key={`${x}-${y}`}
              onClick={() => handleClick(x, y)}
              className={`
                w-10 h-10 border border-gray-600 flex items-center justify-center text-lg md:text-xl font-bold rounded-sm
                ${
                  tile.revealed
                    ? tile.isMine
                      ? tile.owner === playerNumber
                        ? 'bg-red-800 text-white'
                        : 'bg-red-600 text-white'
                      : 'bg-gray-300'
                    : 'bg-gray-500 hover:bg-gray-400 cursor-pointer'
                }
                ${bombMode ? 'ring-2 ring-yellow-400 ring-offset-2 ring-offset-gray-700' : ''}
                ${lastClickedTile[1]?.x === x && lastClickedTile[1]?.y === y ? "last-clicked-p1" : ""}
                ${lastClickedTile[2]?.x === x && lastClickedTile[2]?.y === y ? "last-clicked-p2" : ""}
              `}
            >
              {renderTile(tile)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default App;
