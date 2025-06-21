// App.jsx
import React, { useEffect, useState, useRef } from "react";
import io from "socket.io-client";
import GoogleLogin from "./GoogleLogin"; // Assuming GoogleLogin component exists
import FacebookLogin from "./FacebookLogin"; // Assuming GoogleLogin component exists
import AuthCallback from "./AuthCallback"; // NEW: Import AuthCallback component
import "./App.css";

// Helper function: Converts an ArrayBuffer to a hexadecimal string.
const bufferToHex = (buffer) => {
    return Array.prototype.map.call(new Uint8Array(buffer), x => ('00' + x.toString(16)).slice(-2)).join('');
};

// Helper function: Hashes a message using SHA-256 and converts it into a 5-digit number.
// This function takes a portion of the SHA-256 hash, converts it to a decimal number,
// and then takes the modulo 100,000 to get a 5-digit number, padded with leading zeros.
const generate5DigitGuestId = async (message) => {
    try {
        const msgBuffer = new TextEncoder().encode(message); // Encode message as UTF-8
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer); // Hash the message
        const fullHashHex = bufferToHex(hashBuffer); // Convert full hash to hex string

        // Take a portion of the hash (e.g., first 8 characters) to convert to a number
        // Using a slice helps ensure enough entropy for the conversion
        const hashPortion = fullHashHex.substring(0, 8); // e.g., "a1b2c3d4"
        
        // Convert the hexadecimal portion to an integer
        const decimalValue = parseInt(hashPortion, 16); // e.g., 2712845268

        // Take modulo 100,000 to get a 5-digit number (0-99999)
        const fiveDigitNumber = decimalValue % 100000;

        // Pad with leading zeros to ensure it's always 5 digits
        return String(fiveDigitNumber).padStart(5, '0');

    } catch (err) {
        console.error("Error generating 5-digit guest ID:", err);
        throw new Error("Failed to generate 5-digit guest ID from UUID.");
    }
};

// Helper function: Generates or retrieves a persistent UUID for the device/browser.
const getDeviceUuid = () => {
    let deviceUuid = localStorage.getItem('guestDeviceId');
    if (!deviceUuid) {
        // Generate a new UUID if one doesn't exist
        deviceUuid = crypto.randomUUID(); 
        localStorage.setItem('guestDeviceId', deviceUuid); // Store it for future use
        console.log("Generated new guestDeviceId:", deviceUuid);
    } else {
        console.log("Using existing guestDeviceId:", deviceUuid);
    }
    return deviceUuid;
};

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
  const [isGuest, setIsGuest] = useState(false); // NEW: Track if logged in as guest
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
  const [unrevealedMines, setUnrevealedMines] = useState(0); // NEW: State to store unrevealed mines count

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
        const response = await fetch("https://minesweeper-flags-backend.onrender.com/me", {
          method: "GET",
          credentials: "include",
        });

        if (response.ok) {
          const data = await response.json();
          setName(data.user.displayName || data.user.name || `User_${data.user.id.substring(0, 8)}`);
          setLoggedIn(true);
          // Check if the user ID indicates a guest (e.g., starts with 'guest_')
          setIsGuest(data.user.id.startsWith('guest_')); 
          console.log("App.jsx: Initial auth check successful for:", data.user.displayName || data.user.name, "Is Guest:", data.user.id.startsWith('guest_'));

          // NEW: Initialize Socket.IO connection ONLY once per component mount
          // and manage connection status
          if (!socketRef.current) {
            console.log("Frontend: Initializing Socket.IO connection...");
            socketRef.current = io("https://minesweeper-flags-backend.onrender.com", {
              withCredentials: true,
              // Optional: To help debug socket connection issues by forcing specific transports
              // transports: ['websocket', 'polling'], 
            });

            // --- Attach Socket.IO Event Listeners after connection ---
            socketRef.current.on('connect', () => {
                console.log("Socket.IO client: Connected!");
                setIsSocketConnected(true);
                // After successful connection and potentially authentication
                // we can trigger the join-lobby
                // Only emit join-lobby if loggedIn is true (from initial auth check or pop-up)
                if (loggedIn) { // Check loggedIn state
                  socketRef.current.emit("join-lobby", name); // Use current state `name`
                } else {
                  console.log("Socket connected but not logged in yet. Waiting for login.");
                }
            });

            socketRef.current.on('disconnect', (reason) => {
                console.log(`Socket.IO client: Disconnected! Reason: ${reason}`);
                setIsSocketConnected(false);
                setMessage("Disconnected from server. Please refresh or try again.");
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
                // Re-emit join-lobby just in case to ensure backend registers current socket with session.
                if (loggedIn && name) { // Ensure loggedIn state and name exist
                  socketRef.current.emit("join-lobby", name);
                }
            });

            socketRef.current.on("join-error", (msg) => {
              showMessage(msg, true);
              // Only reload if it's an unrecoverable auth issue or specific error
              if (msg.includes("Authentication required")) {
                setLoggedIn(false);
                setName("");
                setIsGuest(false); // Reset guest status on auth error
                // window.location.reload(); // Hard reload for unauthenticated state - consider removing
              }
            });

            socketRef.current.on("lobby-joined", (userName) => {
              setLoggedIn(true);
              setName(userName);
              showMessage(`Lobby joined successfully as ${userName}!`);
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
              showMessage("Opponent left the game.", true);
              // setGameId(null);
              // setPlayerNumber(null);
              // setBoard([]);
              // setTurn(null);
              // setScores({ 1: 0, 2: 0 });
              // setBombsUsed({ 1: false, 2: false });
              // setGameOver(false);
              // setOpponentName("");
              // setBombMode(false);
              // setLastClickedTile({ 1: null, 2: null });
              // if (socketRef.current) { // Ensure socket is still connected before emitting
              //   socketRef.current.emit("request-unfinished-games");
              // }
		console.log("Opponent left. Player remains in game state.");
            });

            socketRef.current.on("bomb-error", (msg) => {
              showMessage(msg, true);
              setBombMode(false);
            });

            socketRef.current.on("receive-unfinished-games", (games) => {
              const deserializedGames = games.map(game => ({
                  ...game,
                  board: JSON.parse(game.board)
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
            console.log("Frontend: Socket.IO already initialized. Re-emitting join-lobby.");
            // If already initialized, just re-emit join-lobby to ensure backend registers current socket
            if (loggedIn && name) { // Only re-emit if already logged in and name is set
                socketRef.current.emit("join-lobby", name);
            }
          }

        } else {
          setLoggedIn(false);
          setName("");
          setIsGuest(false); // Ensure guest status is reset on failed auth check
          console.log("Frontend: Auth check failed (response not ok).");
          // If auth fails, ensure no socket is connected from a previous attempt
          if (socketRef.current) {
            socketRef.current.disconnect();
            socketRef.current = null;
            setIsSocketConnected(false);
          }
        }
      } catch (err) {
        console.error("Frontend: Error during auth check or socket setup:", err);
        setLoggedIn(false);
        setName("");
        setIsGuest(false); // Reset guest status on error
        setMessage(`An error occurred: ${err.message}. Please refresh.`, true);
        if (socketRef.current) {
          socketRef.current.disconnect();
          socketRef.current = null;
          setIsSocketConnected(false);
        }
      }
    };

    checkAuthStatusAndConnectSocket();

    // NEW: Listener for messages from the OAuth pop-up window
    const handleAuthMessage = (event) => {
      // Ensure the message is from a trusted origin (your backend/frontend)
      // For production, replace '*' with your frontend's exact origin.
      if (event.origin !== "https://minesweeper-flags-frontend.onrender.com") { // Specify your frontend origin
        console.warn("Received message from untrusted origin:", event.origin);
        return;
      }

      if (event.data && event.data.type === 'AUTH_SUCCESS') {
        const { user } = event.data;
        console.log("App.jsx: Received AUTH_SUCCESS from pop-up:", user);
        setName(user.displayName || `User_${user.id.substring(0, 8)}`);
        setLoggedIn(true);
        setIsGuest(user.id.startsWith('guest_')); // Set guest status based on received user ID
        // At this point, the initial useEffect will re-run due to loggedIn/name state change
        // and trigger the socket connection/join-lobby if conditions are met.
        showMessage("Login successful!");
        window.history.replaceState({}, document.title, window.location.pathname); // Clean up URL
      } else if (event.data && event.data.type === 'AUTH_FAILURE') {
        console.error("App.jsx: Received AUTH_FAILURE from pop-up:", event.data.message);
        showMessage(`Login failed: ${event.data.message}`, true);
        setLoggedIn(false);
        setName("");
        setIsGuest(false); // Reset guest status on failure
        window.history.replaceState({}, document.title, window.location.pathname); // Clean up URL
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
    };
  }, [loggedIn, name]); // Dependencies for socket listeners. Re-run if loggedIn or name changes.

  // NEW useEffect to calculate unrevealed mines whenever the board changes
  useEffect(() => {
    if (board && board.length > 0) {
      let totalMines = 0;
      let revealedMines = 0;
      board.forEach(row => {
        row.forEach(tile => {
          if (tile.isMine) {
            totalMines++;
            // A mine is "revealed" if it's visible on the board (e.g., clicked or part of an explosion)
            // The `tile.revealed` property indicates if the tile state has been changed to revealed.
            if (tile.revealed) {
              revealedMines++;
            }
          }
        });
      });
      // The number of unrevealed mines is the total minus those that have been revealed.
      // This implies that flags are not explicitly tracked as "revealed" for this count,
      // only actual mine exposure.
      setUnrevealedMines(totalMines - revealedMines);
    } else {
      setUnrevealedMines(0); // Reset if board is empty or game not started
    }
  }, [board]);

  // NEW: Function to handle Guest Login
  const loginAsGuest = async () => {
    let guestId;
try {
      // Attempt to get a 5-digit guest ID based on IP
      const deviceUuid = getDeviceUuid();
      guestId = await generate5DigitGuestId(deviceUuid);
      // Prepend 'guest_' to distinguish from other user IDs on the backend if needed
      guestId = `guest_${guestId}`;
      
      // Store the generated guest ID in localStorage for persistence across sessions
      //localStorage.setItem('guestId', guestId);

    } catch (error) {
      console.error("Error generating guest ID based on IP:", error);
      // Fallback: If IP-based ID generation fails, use a simple timestamp-based ID
      guestId = `guest_fallback_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`; // Simple unique ID
      //localStorage.setItem('guestId', guestId);
showMessage(`Could not generate IP-based guest ID. Using fallback ID: ${guestId}`, true);
    }

    try {
      // Call your backend guest login endpoint
      const response = await fetch("https://minesweeper-flags-backend.onrender.com/auth/guest", {
        method: "POST", // Use POST for login actions
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ guestId }),
        credentials: "include",
      });

      if (response.ok) {
        const data = await response.json();
        setName(data.user.displayName); // Backend will provide a guest name
        setLoggedIn(true);
        setIsGuest(true);
        showMessage("Logged in as guest!");
        // The useEffect for socket connection will handle joining the lobby
      } else {
        const errorData = await response.json();
        showMessage(`Guest login failed: ${errorData.message || response.statusText}`, true);
        setLoggedIn(false);
        setIsGuest(false);
        localStorage.removeItem('guestId'); // Clear invalid guest ID
      }
    } catch (error) {
      console.error("Guest login fetch error:", error);
      showMessage(`Guest login failed: ${error.message}`, true);
      setLoggedIn(false);
      setIsGuest(false);
      localStorage.removeItem('guestId');
    }
  };


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
      const MIN_COORD = 2;
      const MAX_COORD_X = 13;
      const MAX_COORD_Y = 13;

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

      setMessage("");
      socketRef.current.emit("bomb-center", { gameId, x, y });
    } else if (playerNumber === turn && !gameOver) {
      setMessage("");
      socketRef.current.emit("tile-click", { gameId, x, y });
    }
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
    if (socketRef.current) { // Ensure socket is still available before emitting
      socketRef.current.emit("request-unfinished-games");
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
    setIsGuest(false); // Reset guest status on logout
    localStorage.removeItem('guestId'); // Clear persistent guest ID
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
	// window.location.reload();
  } catch (err) {
    console.error("Logout failed", err);
    showMessage("Logout failed. Please try again.", true);
  }
};

  const renderTile = (tile) => {
    if (!tile.revealed) return "";
    if (tile.isMine) {
      if (tile.owner === 1) return <span style={{ color: "red" }}>🚩</span>;
      if (tile.owner === 2) return <span style={{ color: "blue" }}>🏴</span>;
      return "";
    }
    // Corrected: Wrap the number in a span with the appropriate class for coloring
    if (tile.adjacentMines > 0) {
      return <span className={`number-${tile.adjacentMines}`}>{tile.adjacentMines}</span>;
    }
    return "";
  };

  const resumeGame = (gameIdToResume) => {
    if (gameIdToResume && socketRef.current) {
        socketRef.current.emit("resume-game", { gameId: gameIdToResume });
        showMessage("Attempting to resume game...");
    }
  };


  // --- Conditional Rendering based on App State ---

  if (!loggedIn) {
    return (
      <div className="lobby">
        {message && <p className="app-message" style={{color: 'red'}}>{message}</p>}
        <h2>Login or Play as Guest</h2>
        <GoogleLogin
          onLogin={(googleName) => {
            // This onLogin callback is now triggered by AuthCallback pop-up postMessage.
            // No direct socket.emit("join-lobby") here anymore.
            // The state update (setName, setLoggedIn) will trigger the socket useEffect.
            console.log("Google Login completed via pop-up callback. State will update.");
          }}
        />
		    <FacebookLogin
          onLogin={(facebookName) => {
            // This onLogin callback is now triggered by AuthCallback pop-up postMessage.
            // No direct socket.emit("join-lobby") here anymore.
            // The state update (setName, setLoggedIn) will trigger the socket useEffect.
            console.log("Facebook Login completed via pop-up callback. State will update.");
          }}
        />
        <button className="guest-login-button" onClick={loginAsGuest}>
          Play as Guest
        </button>
      </div>
    );
  }

  return (
    <div className="lobby">
        {message && !message.includes("Error") && <p className="app-message" style={{color: 'green'}}>{message}</p>}
        {message && message.includes("Error") && <p className="app-message" style={{color: 'red'}}>{message}</p>}

	    {!gameId && ( // Only show lobby elements if not in a game
          <>
        <h2>Lobby - Online Players</h2>
        <p>Logged in as: <b>{name} {isGuest && "(Guest)"}</b></p>
		<button onClick={logout} className="bomb-button">Logout</button>
        {playersList.length === 0 && <p>No other players online</p>}
        <ul className="player-list">
          {playersList.map((p) => (
            <li
              key={p.id}
              className="player-item"
              onDoubleClick={() => invitePlayer(p.id)}
              title="Double-click to invite"
            >
              {p.name}
            </li>
          ))}
        </ul>
        {invite && (
          <div className="invite-popup">
            <p>
              Invitation from <b>{invite.fromName}</b>
            </p>
            <button onClick={() => respondInvite(true)}>Accept</button>
            <button onClick={() => respondInvite(false)}>Reject</button>
          </div>
        )}

        <div className="unfinished-games-section">
            <h3>Your Unfinished Games</h3>
            {unfinishedGames.length === 0 ? (
                <p>No unfinished games found.</p>
            ) : (
                <ul className="unfinished-game-list">
                    {unfinishedGames.map(game => (
                        <li key={game.gameId} className="unfinished-game-item">
                            Game vs. {game.opponentName} ({game.status === 'active' ? 'Active' : 'Abandoned'}) - Last updated: {game.lastUpdated}
                            <button onClick={() => resumeGame(game.gameId)} className="bomb-button">Resume</button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
		  </>
)}

        {gameId && (
            <div className="app-game-container">
                <div className="header">
                    <h1>Minesweeper Flags</h1>
                    {playerNumber &&
                      !bombsUsed[playerNumber] &&
                      scores[playerNumber] < scores[playerNumber === 1 ? 2 : 1] &&
                      !gameOver && (
                        <button className="bomb-button" onClick={useBomb}>
                            {bombMode ? "Cancel Bomb" : "Use Bomb"}
                        </button>
                      )}
                </div>

                <h2>
                    You are Player {playerNumber} (vs. {opponentName})
                </h2>
                <p>
                    {turn && !gameOver ? `Current turn: Player ${turn}` : ""}
                    {bombMode && " – Select 5x5 bomb center"}
                </p>
                {message && <p className="app-message" style={{ color: 'red', fontWeight: 'bold' }}>{message}</p>}
                <p>
                    Score 🔴 {scores[1]} | 🔵 {scores[2]}
                </p>
		{/* NEW: Display unrevealed mines count */}
                <p className="mine-count-display">
                    Unrevealed Mines: <span style={{ color: 'red', fontWeight: 'bold' }}>{unrevealedMines}</span>
                </p>

		{/* NEW: Back to Lobby button always visible when in game */}
                <button className="bomb-button" onClick={backToLobby}>
                    Back to Lobby
                </button>

                {gameOver && (
                    <>
                        <button className="bomb-button" onClick={() => socketRef.current.emit("restart-game", { gameId })}> {/* Use socketRef.current */}
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
                        >
                          {renderTile(tile)}
                        </div>
                      ))
                    )}
                </div>
            </div>
        )}
    </div>
  );
}

export default App;
