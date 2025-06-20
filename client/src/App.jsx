// App.jsx
import React, { useEffect, useState, useRef, useCallback } from "react";
import io from "socket.io-client";
import GoogleLogin from "./GoogleLogin"; // Assuming GoogleLogin component exists
import FacebookLogin from "./FacebookLogin"; // Assuming GoogleLogin component exists
import AuthCallback from "./AuthCallback"; // NEW: Import AuthCallback component
import "./App.css";

// Backend URL for API calls
const API_BASE_URL = "https://minesweeper-flags-backend.onrender.com";

function App() {
  // NEW: Determine if this is the OAuth callback window
  const isAuthCallback = window.location.pathname === '/auth/callback';

  // If this is the AuthCallback window, render only the AuthCallback component
  // and prevent the main App logic from running
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
  const [userId, setUserId] = useState(null); // Store userId from authenticated session
  const [showUnfinishedGames, setShowUnfinishedGames] = useState(false);
  const [unfinishedGames, setUnfinishedGames] = useState([]);
  const [isLobbyConnected, setIsLobbyConnected] = useState(false); // Track if socket is actively joined to lobby

  // NEW: State to manage the authentication pop-up window reference
  const authPopupRef = useRef(null);

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
  const [lastClickedTile, setLastClickedTile] = useState({ 1: null, 2: null }); // NEW: Track last clicked tile for each player


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

  // Function to check authentication status with the backend
  const checkAuthStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/me`, {
        method: "GET",
        credentials: "include", // IMPORTANT: Send cookies with this request
      });

      if (response.ok) {
        const data = await response.json();
        console.log("Auth check successful:", data);
        setLoggedIn(true);
        setName(data.user.displayName);
        setUserId(data.user.id); // Set the userId here
        setMessage("");

        // If authenticated, connect to socket.io (if not already connected)
        if (!socketRef.current || !socketRef.current.connected) {
          console.log("Auth check successful, attempting to connect Socket.IO.");
          connectSocket();
        } else {
          console.log("Socket.IO already connected.");
          // If socket is connected and user is logged in, join lobby
          if (data.user.displayName && !isLobbyConnected) {
             socketRef.current.emit("join-lobby", data.user.displayName);
             setIsLobbyConnected(true); // Mark lobby as joined
          }
        }
      } else {
        console.log("Auth check failed:", response.status);
        setLoggedIn(false);
        setName("");
        setUserId(null); // Clear userId if not authenticated
        setMessage("Please log in to play.");
        // Disconnect socket if authentication fails
        if (socketRef.current) {
          socketRef.current.disconnect();
          setIsSocketConnected(false);
        }
      }
    } catch (error) {
      console.error("Error checking auth status:", error);
      setLoggedIn(false);
      setName("");
      setUserId(null); // Clear userId on error
      setMessage("Failed to connect to authentication service.");
      if (socketRef.current) {
        socketRef.current.disconnect();
        setIsSocketConnected(false);
      }
    }
  }, [isLobbyConnected, name, loggedIn]); // Added name and loggedIn to dependencies

  // Function to handle opening the login pop-up
  const openLoginPopup = (url) => {
    const width = 600;
    const height = 700;
    const left = window.screen.width / 2 - width / 2;
    const top = window.screen.height / 2 - height / 2;
    authPopupRef.current = window.open(
      url,
      "AuthPopup",
      `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes,status=yes`
    );
  };

  // NEW: Message listener for postMessage from OAuth pop-up
  useEffect(() => {
    const handleAuthMessage = (event) => {
      // Ensure the message comes from the expected origin for security
      if (event.origin !== API_BASE_URL) { // Specify your backend origin
          console.warn("Received message from unknown origin:", event.origin);
          return;
      }
      
      console.log("App.jsx: Received message from authentication pop-up:", event.data);

      if (event.data.type === 'AUTH_SUCCESS' && event.data.user) {
        setLoggedIn(true);
        setName(event.data.user.displayName);
        setUserId(event.data.user.id);
        setMessage("Login successful! Welcome to the lobby.");
        
        // Explicitly re-check auth status to ensure session cookie is picked up by the main window
        // and Socket.IO connection is initiated with the authenticated session.
        checkAuthStatus();

      } else if (event.data.type === 'AUTH_FAILURE') {
        setLoggedIn(false);
        setName("");
        setUserId(null);
        setMessage(`Login failed: ${event.data.message || 'An unknown error occurred.'}`);
      }

      // Close the pop-up if it's still open (it should close itself but this is a fallback)
      if (authPopupRef.current && !authPopupRef.current.closed) {
        authPopupRef.current.close();
        authPopupRef.current = null;
      }
    };

    window.addEventListener('message', handleAuthMessage);

    // Clean up the event listener when the component unmounts
    return () => {
      window.removeEventListener('message', handleAuthMessage);
    };
  }, [checkAuthStatus]); // Re-run if checkAuthStatus changes (unlikely for useCallback)


  // Socket.IO Connection Logic
  const connectSocket = useCallback(() => {
    // Only connect if not already connected and `userId` is available
    if (!socketRef.current || !socketRef.current.connected) {
      console.log("Attempting to initialize Socket.IO connection...");
      const socket = io(API_BASE_URL, {
        withCredentials: true, // IMPORTANT: Send cookies for session
      });

      socket.on("connect", () => {
        console.log("Socket.IO connected:", socket.id);
        setIsSocketConnected(true);
        // NEW: Listen for 'authenticated-socket-ready' only after connection
        socket.on('authenticated-socket-ready', () => {
            console.log("Received authenticated-socket-ready from server.");
            // Once confirmed, join the lobby if logged in and not already in a game
            if (loggedIn && name && !gameId) {
                socket.emit("join-lobby", name);
                setIsLobbyConnected(true); // Mark lobby as joined
                setMessage("Connected to lobby!");
            }
        });
      });

      socket.on("disconnect", (reason) => {
        console.log("Socket.IO disconnected:", reason);
        setIsSocketConnected(false);
        setIsLobbyConnected(false); // No longer in lobby if disconnected
        // If the disconnection happened during a game, notify the user
        if (gameId && reason !== 'io client disconnect') { // 'io client disconnect' means voluntary client-side disconnect
            setMessage("Disconnected from game. Attempting to reconnect...");
        } else if (reason === 'transport close' || reason === 'ping timeout') {
            setMessage("Network issue or server restart. Attempting to reconnect...");
        } else {
            setMessage("Disconnected. Please refresh or re-login if needed.");
        }
        // Attempt to reconnect if not a deliberate disconnect and not already connected
        if (reason !== 'io client disconnect' && !socketRef.current.connected) {
            console.log("Attempting to auto-reconnect Socket.IO...");
            setTimeout(() => {
                connectSocket(); // Recursive call to attempt reconnection
            }, 3000); // Wait 3 seconds before trying to reconnect
        }
      });
      
      socket.on("connect_error", (error) => {
        console.error("Socket.IO connection error:", error);
        setMessage("Socket connection error. Please check server status.");
        setIsSocketConnected(false);
        setIsLobbyConnected(false);
      });

      socket.on("players-list", (list) => {
        setPlayersList(list.filter(p => p.id !== socket.id)); // Filter out self
      });

      socket.on("lobby-joined", (userName) => {
        console.log(`Joined lobby as ${userName}.`);
        setName(userName); // Confirm the name used to join lobby
        setMessage("Joined lobby. Waiting for opponent...");
        setIsLobbyConnected(true);
        socketRef.current.emit("request-unfinished-games"); // Request unfinished games on lobby join
      });

      socket.on("game-invite", ({ fromId, fromName }) => {
        setMessage(
          `${fromName} has invited you to a game! Accept?`
        );
        const confirmInvite = window.confirm(
          `${fromName} has invited you to a game! Accept?`
        );
        if (confirmInvite) {
          socket.emit("respond-invite", { fromId, accept: true });
          setMessage("Accepted invite. Starting game...");
        } else {
          socket.emit("respond-invite", { fromId, accept: false });
          setMessage("Invite rejected.");
        }
      });

      socket.on("invite-rejected", ({ fromName, reason }) => {
        setMessage(`${fromName} rejected your invite. ${reason ? `Reason: ${reason}` : ''}`);
      });

      socket.on("game-start", (data) => {
        console.log("Game started! Data:", data);
        setGameId(data.gameId);
        setPlayerNumber(data.playerNumber);
        setBoard(JSON.parse(data.board)); // Parse the board string back to an object
        setTurn(data.turn);
        setScores(data.scores);
        setBombsUsed(data.bombsUsed);
        setGameOver(data.gameOver);
        setLastClickedTile({ 1: null, 2: null }); // Reset last clicked tile
        setOpponentName(data.opponentName);
        setMessage(`Game started! It's Player ${data.turn}'s turn.`);
        setIsLobbyConnected(false); // No longer in lobby
      });

      socket.on("board-update", (data) => {
        console.log("Board updated! Data:", data);
        setBoard(JSON.parse(data.board));
        setTurn(data.turn);
        setScores(data.scores);
        setBombsUsed(data.bombsUsed);
        setGameOver(data.gameOver);
        setBombMode(false); // Exit bomb mode after update
        if (data.gameOver) {
            setMessage("Game Over!");
            if (data.scores[playerNumber] > data.scores[playerNumber === 1 ? 2 : 1]) {
                setMessage("Game Over! You Win!");
            } else if (data.scores[playerNumber] < data.scores[playerNumber === 1 ? 2 : 1]) {
                setMessage("Game Over! You Lose!");
            } else {
                setMessage("Game Over! It's a Tie!");
            }
        } else if (data.turn === playerNumber) {
            setMessage("Your turn!");
        } else {
            setMessage(`${opponentName}'s turn.`);
        }
      });

      socket.on("wait-bomb-center", () => {
        setMessage("Select a tile to drop your bomb (5x5 area).");
        setBombMode(true);
      });

      socket.on("bomb-error", (errorMsg) => {
        setMessage(`Bomb Error: ${errorMsg}`);
        setBombMode(false); // Exit bomb mode on error
      });

      socket.on("opponent-left", () => {
        setMessage("Your opponent has left the game. You win!");
        setGameOver(true);
        // Optionally, clear game state and return to lobby
        setGameId(null);
        setPlayerNumber(null);
        setBoard([]);
        setTurn(null);
        setScores({ 1: 0, 2: 0 });
        setBombsUsed({ 1: false, 2: false });
        setLastClickedTile({ 1: null, 2: null });
        setOpponentName("");
        setIsLobbyConnected(false); // Allow re-joining lobby
        // Trigger a re-join lobby to update player list
        if (loggedIn && name) {
            socket.emit("join-lobby", name);
            setIsLobbyConnected(true);
        }
      });
      
      socket.on("game-restarted", (data) => {
        console.log("Game restarted! Data:", data);
        setMessage("Game restarted due to first click on blank tile!", false);
        setGameId(data.gameId);
        setPlayerNumber(data.playerNumber);
        setBoard(JSON.parse(data.board)); // Parse the board string back to an object
        setTurn(data.turn);
        setScores(data.scores);
        setBombsUsed(data.bombsUsed);
        setGameOver(data.gameOver);
        setOpponentName(data.opponentName);
        setBombMode(false);
        setLastClickedTile({ 1: null, 2: null }); // Reset last clicked tile
      });

      socket.on("receive-unfinished-games", (games) => {
        const deserializedGames = games.map(game => ({
            ...game,
            board: JSON.parse(game.board) // Deserialize board for client-side use
        }));
        setUnfinishedGames(deserializedGames);
        console.log("Received unfinished games:", deserializedGames);
      });

      socket.on("opponent-reconnected", ({ name }) => {
          showMessage(`${name} has reconnected!`);
      });

      socketRef.current = socket; // Store the socket instance in the ref
    }
  }, [loggedIn, name, gameId, playerNumber, opponentName, isLobbyConnected]); // Added isLobbyConnected to deps

  // Initial auth check when component mounts
  useEffect(() => {
    checkAuthStatus();

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
    };
  }, [checkAuthStatus]); // Only re-run if checkAuthStatus changes

  // --- User Interaction Functions (using socketRef.current for emits) ---

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
      // --- Client-side validation before emitting bomb-center ---
      const MIN_COORD = 2; // For 3rd line/column (0-indexed)
      const MAX_COORD_X = 13; // For 14th column (16-1 - 2)
      const MAX_COORD_Y = 13; // For 14th line (16-1 - 2)

      if (x < MIN_COORD || x > MAX_COORD_X || y < MIN_COORD || y > MAX_COORD_Y) {
        showMessage("Bomb center must be within the 12x12 area.", true);
        return;
      }

      let allTilesRevealed = true;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const checkX = x + dx;
          const checkY = y + dy;
          if (checkX >= 0 && checkX < board[0].length && checkY >= 0 && checkY < board.length) {
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
        showMessage("All tiles in the bomb's blast area are already revealed.", true);
        return;
      }
      // --- END CLIENT-SIDE VALIDATION ---

      setMessage(""); // Clear message if validation passes
      socketRef.current.emit("bomb-center", { gameId, x, y });
    } else if (playerNumber === turn && !gameOver) {
      setMessage(""); // Clear message when clicking a regular tile
      socketRef.current.emit("tile-click", { gameId, x, y });
    }
    // Update last clicked tile for visual feedback
    setLastClickedTile(prev => ({ ...prev, [playerNumber]: { x, y } }));
  };

  const useBomb = () => {
    if (!socketRef.current || !gameId || gameOver || bombsUsed[playerNumber]) {
      if (bombsUsed[playerNumber]) {
        showMessage("You have already used your bomb!", true);
      } else if (!gameId || gameOver) {
        // Can add more specific message if not in game or game over
        showMessage("Cannot use bomb now.", true);
      }
      return;
    }

    // Logic for using bomb (if behind in score) or cancelling bomb mode
    if (bombMode) {
      setBombMode(false);
      setMessage("");
    } else if (scores[playerNumber] < scores[playerNumber === 1 ? 2 : 1]) {
      socketRef.current.emit("use-bomb", { gameId });
    } else {
      showMessage("You can only use the bomb when you are behind in score!", true);
    }
  };


  const backToLobby = () => {
    if (gameId && socketRef.current) {
        socketRef.current.emit("leave-game", { gameId });
    }

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
    if (socketRef.current && loggedIn && name) { // Ensure socket is still available and user is logged in
      socketRef.current.emit("join-lobby", name);
      setIsLobbyConnected(true);
    }
};

  const logout = async () => {
  try {
    await fetch("https://minesweeper-flags-backend.onrender.com/logout", {
      method: "GET",
      credentials: "include",
    });

    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    setLoggedIn(false);
    setName("");
    setUserId(null); // Clear userId on logout
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
    setIsLobbyConnected(false); // No longer in lobby
	// window.location.reload(); // Removed hard reload
  } catch (err) {
    console.error("Logout failed", err);
    showMessage("Logout failed. Please try again.", true);
  }
};

  const renderTile = (tile) => {
    if (!tile.revealed) return "";
    if (tile.isMine) {
      if (tile.owner === 1) return <span style={{ color: "red" }}>🔴</span>; // Changed flag emoji for consistency
      if (tile.owner === 2) return <span style={{ color: "blue" }}>🔵</span>; // Changed flag emoji for consistency
      return "";
    }
    // Corrected: Wrap the number in a span with the appropriate class for coloring
    if (tile.adjacentMines > 0) {
      return <span className={`number-${tile.adjacentMines}`}>{tile.adjacentMines}</span>;
    }
    return "";
  };

  const requestUnfinishedGames = () => {
    if (socketRef.current && loggedIn) {
      socketRef.current.emit("request-unfinished-games");
    } else {
      setMessage("Please log in to view unfinished games.");
    }
  };

  const resumeGame = (gameIdToResume) => {
    if (gameIdToResume && socketRef.current && loggedIn) {
        socketRef.current.emit("resume-game", { gameId: gameIdToResume });
        setMessage("Attempting to resume game...");
        setShowUnfinishedGames(false); // Hide the list once resume attempt is made
    } else {
        setMessage("Cannot resume game. Please ensure you are logged in and connected.", true);
    }
  };


  // --- Conditional Rendering based on App State ---

  return (
    <div className="app-container">
      {!loggedIn ? (
        <div className="login-screen">
          <h1>Minesweeper Flags</h1>
          <p>Login to play against other players!</p>
          <GoogleLogin onClick={() => openLoginPopup(`${API_BASE_URL}/auth/google`)} />
          <FacebookLogin onClick={() => openLoginPopup(`${API_BASE_URL}/auth/facebook`)} />
          {message && <p className="app-message">{message}</p>}
        </div>
      ) : (
        <div className="game-container">
          <div className="header-bar">
            <span className="welcome-text">Welcome, {name}!</span>
            <button onClick={logout} className="logout-button">Logout</button>
          </div>

          {!gameId ? (
            <div className="lobby">
              <h2>Lobby</h2>
              <p className="status-message">
                {isSocketConnected ? "Connected to server." : "Connecting to server..."}
                <br/>
                {isLobbyConnected ? "In lobby." : "Joining lobby..."}
              </p>
              {message && <p className="app-message">{message}</p>}
              
              <h3>Available Players ({playersList.length})</h3>
              {playersList.length > 0 ? (
                <ul className="player-list">
                  {playersList.map((player) => (
                    <li
                      key={player.id}
                      className="player-item"
                      onDoubleClick={() => {
                        if (socketRef.current && socketRef.current.connected) {
                          socketRef.current.emit("invite-player", player.id);
                          setMessage(`Invited ${player.name}. Waiting for response...`);
                        }
                      }}
                    >
                      {player.name}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No other players online yet. Invite a friend!</p>
              )}
              <button className="invite-button" onClick={() => { setShowUnfinishedGames(!showUnfinishedGames); if (!showUnfinishedGames) requestUnfinishedGames(); }}>
                {showUnfinishedGames ? "Hide Unfinished Games" : "Show Unfinished Games"}
              </button>

              {showUnfinishedGames && (
                <div className="unfinished-games-section">
                  <h3>Your Unfinished Games</h3>
                  {unfinishedGames.length > 0 ? (
                    <ul className="player-list"> {/* Reusing player-list style for now */}
                      {unfinishedGames.map((game) => (
                        <li key={game.gameId} className="player-item" onClick={() => resumeGame(game.gameId)}>
                          Game vs {game.opponentName} (Status: {game.status}) - Last Played: {game.lastUpdated}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No unfinished games found.</p>
                  )}
                  {/* Button to refresh the list */}
                  <button className="invite-button" onClick={requestUnfinishedGames}>
                    Refresh Unfinished Games
                  </button>
                </div>
              )}
              {invite && (
                <div className="invite-popup">
                  <p>
                    Invitation from <b>{invite.fromName}</b>
                  </p>
                  <button onClick={() => respondInvite(true)}>Accept</button>
                  <button onClick={() => respondInvite(false)}>Reject</button>
                </div>
              )}
            </div>
          ) : (
            <div className="game-board-area">
              <h2>Game in Progress!</h2>
              <p>Player {playerNumber} vs {opponentName}</p>
              <p>
                {turn && !gameOver ? `Current turn: Player ${turn}` : ""}
                {bombMode && " – Select 5x5 bomb center"}
              </p>
              {message && <p className="app-message" style={{ color: 'red', fontWeight: 'bold' }}>{message}</p>}
              <p>
                Score 🔴 {scores[1]} | 🔵 {scores[2]}
              </p>

              {gameOver && (
                <>
                    <button className="bomb-button" onClick={backToLobby}>
                      Back to Lobby
                    </button>
                    <button className="bomb-button" onClick={() => socketRef.current.emit("restart-game", { gameId })}>
                      Restart Game
                    </button>
                </>
              )}

              <div
                className="grid"
                style={{
                  gridTemplateColumns: `repeat(${board[0]?.length || 0}, 40px)`,
                }}
              >
                {board.flatMap((row, y) =>
                  row.map((tile, x) => (
                    <div
                      key={`${x}-${y}`}
                      className={`tile ${
                        tile.revealed ? "revealed" : "hidden"
                      } ${tile.isMine && tile.revealed ? "mine" : ""} ${
                        lastClickedTile[1]?.x === x && lastClickedTile[1]?.y === y ? "last-clicked-p1" : ""
                      } ${
                        lastClickedTile[2]?.x === x && lastClickedTile[2]?.y === y ? "last-clicked-p2" : ""
                      }`}
                      onClick={() => handleClick(x, y)}
                      onContextMenu={(e) => {
                        e.preventDefault(); // Prevent context menu on right-click
                        // Implement flag logic if desired, or ignore right-click
                      }}
                      data-adjacent-mines={
                        tile.revealed && !tile.isMine ? tile.adjacentMines : ""
                      }
                    >
                      {renderTile(tile)}
                    </div>
                  ))
                )}
              </div>
              
              {!gameOver && turn === playerNumber && (
                <button
                  className="bomb-button"
                  onClick={useBomb}
                  disabled={bombsUsed[playerNumber]}
                >
                  {bombsUsed[playerNumber] ? "Bomb Used!" : "Use Bomb (5x5)"}
                </button>
              )}
               {/* Add a button to leave the game */}
               {!gameOver && (
                <button
                    className="bomb-button"
                    onClick={backToLobby}
                    style={{ backgroundColor: '#dc3545', marginLeft: '10px' }} // Example style for a danger button
                >
                    Leave Game
                </button>
               )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
