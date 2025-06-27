// App.jsx
import React, { useEffect, useState, useRef, useCallback } from "react";
import io from "socket.io-client";
import GoogleLogin from "./GoogleLogin"; // Assuming GoogleLogin component exists
import FacebookLogin from "./FacebookLogin"; // Assuming GoogleLogin component exists
import AuthCallback from "./AuthCallback"; // NEW: Import AuthCallback component
import "./App.css"; // Ensure you have App.css for styling

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
  const [playerNumber, setPlayerNumber] = useState(null); // 1, 2 for players; 0 for observer
  const [board, setBoard] = useState([]);
  const [turn, setTurn] = useState(null);
  const [scores, setScores] = useState({ 1: 0, 2: 0 });
  const [bombsUsed, setBombsUsed] = useState({ 1: false, 2: false });
  const [bombMode, setBombMode] = useState(false); // Backend's waitingForBombCenter
  const [gameOver, setGameOver] = useState(false);
  const [opponentName, setOpponentName] = useState(""); // Only relevant for players
  const [invite, setInvite] = useState(null);
  const [unfinishedGames, setUnfinishedGames] = useState([]); // State for unfinished games (player's games)
  const [observableGames, setObservableGames] = useState([]); // NEW: State for observable games
  const [lastClickedTile, setLastClickedTile] = useState({ 1: null, 2: null });
  const [unrevealedMines, setUnrevealedMines] = useState(0); // State to store unrevealed mines count
  const [observersInGame, setObserversInGame] = useState([]); // NEW: List of observers in the current game
  // NEW: States for player display names (from server's game data)
  const [player1DisplayName, setPlayer1DisplayName] = useState("");
  const [player2DisplayName, setPlayer2DisplayName] = useState("");

  // NEW: State for bomb highlighting
  const [isBombHighlightActive, setIsBombHighlightActive] = useState(false); // Controls if bomb area should be highlighted visually
  const [highlightedBombArea, setHighlightedBombArea] = useState([]); // Stores [x,y] coordinates for highlighted tiles

  // Constants for board dimensions
  const WIDTH = 16;
  const HEIGHT = 16;

  // Chat states
  const [lobbyMessages, setLobbyMessages] = useState([]);
  const [gameMessages, setGameMessages] = useState([]);
  const [lobbyMessageInput, setLobbyMessageInput] = useState("");
  const [gameMessageInput, setGameMessageInput] = useState("");
  const lobbyChatEndRef = useRef(null);
  const gameChatEndRef = useRef(null);

  // Effect to scroll to the bottom of chat
  useEffect(() => {
    if (lobbyChatEndRef.current && loggedIn && !gameId) {
      lobbyChatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [lobbyMessages, loggedIn, gameId]);

  useEffect(() => {
    if (gameChatEndRef.current && gameId) {
      gameChatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [gameMessages, gameId]);


  // --- Utility Functions ---

  // Helper to get coordinates from a mouse event (e.g., click or move on grid)
  const getTileCoordinates = (event) => {
    const grid = event.currentTarget;
    const { left, top, width, height } = grid.getBoundingClientRect();

    // Calculate tile size dynamically
    const tileWidth = width / WIDTH;
    const tileHeight = height / HEIGHT;

    // Calculate mouse position relative to the grid
    const mouseX = event.clientX - left;
    const mouseY = event.clientY - top;

    // Calculate tile coordinates
    const x = Math.floor(mouseX / tileWidth);
    const y = Math.floor(mouseY / tileHeight);

    return { x, y };
  };

  // Helper function to calculate the 5x5 area around a center (cx, cy)
  // Ensures the area stays within board boundaries (0 to WIDTH/HEIGHT - 1)
  const calculateBombArea = useCallback((cx, cy) => {
    const area = [];
    // Bomb center must be between 3rd and 14th row and column (0-indexed: 2 to 13)
    const MIN_COORD = 2;
    const MAX_COORD_X = WIDTH - 3; // 16 - 3 = 13
    const MAX_COORD_Y = HEIGHT - 3; // 16 - 3 = 13

    if (cx < MIN_COORD || cx > MAX_COORD_X || cy < MIN_COORD || cy > MAX_COORD_Y) {
      return []; // Return empty if center is out of valid range for a 5x5 blast
    }

    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        // Ensure calculated tile is within actual board boundaries
        if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) {
          area.push({ x, y });
        }
      }
    }
    return area;
  }, [WIDTH, HEIGHT]); // Depend on WIDTH and HEIGHT if they can change dynamically


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
                setIsBombHighlightActive(false); // Clear bomb highlight on disconnect
                setHighlightedBombArea([]);
            });

            socketRef.current.on('connect_error', (error) => {
                console.error("Socket.IO client: Connection error!", error);
                setMessage(`Socket connection error: ${error.message}. Please check server logs.`, true);
                setIsSocketConnected(false);
                setIsBombHighlightActive(false); // Clear bomb highlight on error
                setHighlightedBombArea([]);
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
              }
              setIsBombHighlightActive(false); // Clear bomb highlight on error
              setHighlightedBombArea([]);
            });

            socketRef.current.on("lobby-joined", (userName) => {
              setLoggedIn(true);
              setName(userName);
              showMessage(`Lobby joined successfully as ${userName}!`);
              // After joining lobby, request unfinished games and observable games
              socketRef.current.emit("request-unfinished-games");
              socketRef.current.emit("request-observable-games"); // NEW: Request observable games
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
              setPlayerNumber(data.playerNumber); // Will be 0 for observers
              setBoard(JSON.parse(data.board)); // Parse the board string back to an object
              setTurn(data.turn);
              setScores(data.scores);
              setBombsUsed(data.bombsUsed);
              setGameOver(data.gameOver);
              setOpponentName(data.opponentName); // N/A for observers
              setPlayer1DisplayName(game.playerNumber === 1 ? name : data.opponentName); // NEW: Get Player 1's name
              setPlayer2DisplayName(game.playerNumber === 2 ? name : data.opponentName); // NEW: Get Player 2's name
              setBombMode(false); // Reset backend's bombMode state
              setIsBombHighlightActive(false); // Ensure bomb highlighting is off
              setHighlightedBombArea([]); // Clear highlights
              setLastClickedTile(data.lastClickedTile || { 1: null, 2: null });
              setGameMessages(data.gameChat || []); // Load initial game messages
              setObserversInGame(data.observers || []); // NEW: Load initial observers
              setMessage("");
              console.log("Frontend: Game started! My player number:", data.playerNumber);
              setUnfinishedGames([]); // Clear unfinished games list once a game starts
              setObservableGames([]); // Clear observable games list once a game starts
            });

            socketRef.current.on("board-update", (game) => {
              setBoard(JSON.parse(game.board));
              setTurn(game.turn);
              setScores(game.scores);
              setBombsUsed(game.bombsUsed);
              setGameOver(game.gameOver);
              setBombMode(false); // Reset backend's bombMode state
              setIsBombHighlightActive(false); // Exit bomb highlighting mode
              setHighlightedBombArea([]); // Clear highlights
              setLastClickedTile(game.lastClickedTile || { 1: null, 2: null });
              setObserversInGame(game.observers || []); // NEW: Update observers list on board update
              setPlayer1DisplayName(game.playerNumber === 1 ? name : data.opponentName); // NEW: Get Player 1's name
              setPlayer2DisplayName(game.playerNumber === 2 ? name : data.opponentName); // NEW: Get Player 2's name
              setMessage("");
            });

            socketRef.current.on("wait-bomb-center", () => {
              setBombMode(true); // Backend signals to wait for center
              setMessage("Select 5x5 bomb center.");
              setIsBombHighlightActive(true); // Activate bomb highlighting for mouse movement
            });

            socketRef.current.on("opponent-left", () => {
              showMessage("Opponent left the game.", true);
              console.log("Opponent left. Player remains in game state.");
              setBombMode(false); // Reset backend's bombMode state
              setIsBombHighlightActive(false); // Clear bomb highlight on opponent left
              setHighlightedBombArea([]);
            });

            socketRef.current.on("bomb-error", (msg) => {
              showMessage(msg, true);
              setBombMode(false); // Reset backend's bombMode state
              setIsBombHighlightActive(false); // Clear bomb highlight on error
              setHighlightedBombArea([]);
            });

            socketRef.current.on("receive-unfinished-games", (games) => {
              const deserializedGames = games.map(game => ({
                  ...game,
                  board: JSON.parse(game.board) // Deserialize board for client-side use/preview
              }));
              setUnfinishedGames(deserializedGames);
              console.log("Received unfinished games:", deserializedGames);
            });

            // NEW: Listener for observable games list
            socketRef.current.on("receive-observable-games", (games) => {
                setObservableGames(games);
                console.log("Received observable games:", games);
            });

            socketRef.current.on("opponent-reconnected", ({ name }) => {
                showMessage(`${name} has reconnected!`);
            });

            // NEW: Player reconnected notification (for observers)
            socketRef.current.on("player-reconnected", ({ name, userId, role }) => {
              showMessage(`${name} (${role}) reconnected to this game!`);
              // If a player reconnects, ensure they are NOT in the observersInGame list
              setObserversInGame(prev => prev.filter(o => o.userId !== userId));
            });

            // NEW: Player left notification (for observers)
            socketRef.current.on("player-left", ({ name, userId, role }) => {
              showMessage(`${name} (${role}) left the game!`);
              // Remove player from observersInGame list (if they were somehow there, or if this is relevant for displaying current players)
              setObserversInGame(prev => prev.filter(o => o.userId !== userId)); 
            });

            // NEW: Observer joined notification
            socketRef.current.on("observer-joined", ({ name, userId }) => {
                showMessage(`${name} is now observing!`);
                setObserversInGame(prev => {
                    const updated = prev.map(o => o.userId === userId ? { ...o, socketId: socketRef.current.id } : o);
                    return updated.some(o => o.userId === userId) ? updated : [...updated, { userId, name, socketId: socketRef.current.id }];
                });
            });

            // NEW: Observer left notification
            socketRef.current.on("observer-left", ({ name, userId }) => {
                showMessage(`${name} stopped observing.`);
                setObserversInGame(prev => prev.filter(obs => obs.userId !== userId));
            });


            socketRef.current.on("game-restarted", (data) => {
              showMessage("Game restarted due to first click on blank tile!", false);
              setGameId(data.gameId);
              setPlayerNumber(data.playerNumber); // Will be 0 for observers
              setBoard(JSON.parse(data.board));
              setTurn(data.turn);
              setScores(data.scores);
              setBombsUsed(data.bombsUsed);
              setGameOver(data.gameOver);
              setOpponentName(data.opponentName); // N/A for observers
              setPlayer1DisplayName(game.playerNumber === 1 ? name : data.opponentName); // NEW: Get Player 1's name
              setPlayer2DisplayName(game.playerNumber === 2 ? name : data.opponentName); // NEW: Get Player 2's name
              setBombMode(false); // Reset backend's bombMode state
              setIsBombHighlightActive(false); // Clear bomb highlight on restart
              setHighlightedBombArea([]); // Clear highlights
              setLastClickedTile(data.lastClickedTile || { 1: null, 2: null });
              setGameMessages(data.gameChat || []); // Load cleared game chat messages
              setObserversInGame(data.observers || []); // NEW: Update observers list on restart
            });

            // Chat specific listeners
            socketRef.current.on("initial-lobby-messages", (messages) => {
              setLobbyMessages(messages);
            });

            socketRef.current.on("receive-lobby-message", (message) => {
              setLobbyMessages((prevMessages) => [...prevMessages, message]);
            });

            socketRef.current.on("receive-game-message", (message) => {
              setGameMessages((prevMessages) => [...prevMessages, message]);
            });

          } else {
            console.log("Frontend: Socket.IO already initialized. Re-emitting join-lobby.");
            // If already initialized, just re-emit join-lobby to ensure backend registers current socket
            if (loggedIn && name) { // Only re-emit if already logged in and name is set
                socketRef.current.emit("join-lobby", name);
                socketRef.current.emit("request-unfinished-games"); // Re-request on re-lobby join
                socketRef.current.emit("request-observable-games"); // Re-request on re-lobby join
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
      // Ensure the message is from a trusted origin (your backend's domain)
      if (event.origin !== "https://minesweeper-flags-backend.onrender.com") { // Adjust this to your backend's URL
        console.warn("Received message from untrusted origin:", event.origin);
        return;
      }

      if (event.data && event.data.type === 'AUTH_SUCCESS') {
        const { user } = event.data;
        console.log("App.jsx: Received AUTH_SUCCESS from pop-up:", user);
        setName(user.displayName || `User_${user.id.substring(0, 8)}`);
        setLoggedIn(true);
        setIsGuest(user.id.startsWith('guest_')); // Set guest status based on received user ID
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
        socketRef.current.off("receive-observable-games"); // NEW: Cleanup for observable games
        socketRef.current.off("opponent-reconnected");
        socketRef.current.off("player-reconnected"); // NEW: Cleanup for player reconnected
        socketRef.current.off("player-left"); // NEW: Cleanup for player left
        socketRef.current.off("observer-joined"); // NEW: Cleanup for observer joined
        socketRef.current.off("observer-left"); // NEW: Cleanup for observer left
        socketRef.current.off("game-restarted");
        socketRef.current.off("initial-lobby-messages"); // New cleanup for chat
        socketRef.current.off("receive-lobby-message");    // New cleanup for chat
        socketRef.current.off("receive-game-message");     // New cleanup for chat

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
    let displayName;
    try {
        const deviceUuid = getDeviceUuid();
        guestId = await generate5DigitGuestId(deviceUuid);
        // Prepend 'guest_' to distinguish from other user IDs on the backend
        guestId = `guest_${guestId}`;
        displayName = `Guest_${guestId.substring(6)}`; // Use the 5-digit part for display name
        
    } catch (error) {
      console.error("Error generating guest ID based on device UUID:", error);
      // Fallback: If ID generation fails, use a simple timestamp-based ID
      guestId = `guest_fallback_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`; // Simple unique ID
      displayName = `Guest_Fallback`;
      showMessage(`Could not generate consistent guest ID. Using fallback ID: ${guestId}`, true);
    }

    try {
      // Call your backend guest login endpoint
      const response = await fetch("https://minesweeper-flags-backend.onrender.com/auth/guest", {
        method: "POST", // Use POST for login actions
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ guestId, name: displayName }), // Send generated name to backend
        credentials: "include",
      });

      if (response.ok) {
        const data = await response.json();
        setName(data.user.displayName); // Backend will provide a guest name (should be the displayName we sent)
        setLoggedIn(true);
        setIsGuest(true);
        showMessage("Logged in as guest!");
        // The useEffect for socket connection will handle joining the lobby
      } else {
        const errorData = await response.json();
        showMessage(`Guest login failed: ${errorData.message || response.statusText}`, true);
        setLoggedIn(false);
        setIsGuest(false);
      }
    } catch (error) {
      console.error("Guest login fetch error:", error);
      showMessage(`Guest login failed: ${error.message}`, true);
      setLoggedIn(false);
      setIsGuest(false);
    }
  };


  // --- User Interaction Functions (using socketRef.current for emits) ---

  const invitePlayer = (id) => {
    if (loggedIn && socketRef.current && socketRef.current.connected && id !== socketRef.current.id) {
      socketRef.current.emit("invite-player", id);
      showMessage("Invitation sent.");
    } else if (!socketRef.current || !socketRef.current.connected) {
        showMessage("Not connected to server. Please wait or refresh.", true);
    } else {
        console.warn("Invite failed: Not logged in or inviting self.");
    }
  };

  const respondInvite = (accept) => {
    if (invite && socketRef.current && socketRef.current.connected) {
      socketRef.current.emit("respond-invite", { fromId: invite.fromId, accept });
      setInvite(null);
      setMessage("");
    } else if (!socketRef.current || !socketRef.current.connected) {
        showMessage("Not connected to server. Cannot respond to invite.", true);
    }
  };

  const handleClick = (x, y) => {
    // Only players (playerNumber 1 or 2) can click tiles
    if (!gameId || gameOver || !socketRef.current || !socketRef.current.connected || playerNumber === 0) return;

    // If waiting for bomb center, emit bomb-center event
    if (bombMode) { // bombMode is true when backend sent 'wait-bomb-center'
      const MIN_COORD = 2; // Hardcoded in original, keep for now
      const MAX_COORD_X = WIDTH - 3; // Use WIDTH constant
      const MAX_COORD_Y = HEIGHT - 3; // Use HEIGHT constant

      if (x < MIN_COORD || x > MAX_COORD_X || y < MIN_COORD || y > MAX_COORD_Y) {
        showMessage("Bomb center must be within the 12x12 area.", true);
        return;
      }

      // Check if bomb area is already fully revealed (client-side check for user feedback)
      let allTilesRevealed = true;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const checkX = x + dx;
          const checkY = y + dy;
          if (checkX >= 0 && checkX < WIDTH && checkY >= 0 && checkY < HEIGHT) { // Use WIDTH/HEIGHT constants
            if (!board[checkY][checkX].revealed) {
              allTilesRevealed = false;
              break;
            }
          } else {
              allTilesRevealed = false; // Treat out-of-bounds as not fully revealed for bomb purpose
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
      setBombMode(false); // Exit bomb selection mode
      setIsBombHighlightActive(false); // Turn off highlighting after selection
      setHighlightedBombArea([]); // Clear highlights
    } else if (playerNumber === turn && !gameOver) {
      setMessage("");
      socketRef.current.emit("tile-click", { gameId, x, y });
    } else if (playerNumber !== turn) {
        showMessage("It's not your turn!", true);
    }
  };

  const handleUseBombClick = () => { // Renamed from useBomb to distinguish from "cancel bomb"
    // Only players (not observers) can use bombs
    if (playerNumber === 0) {
        showMessage("Observers cannot use bombs.", true);
        return;
    }

    if (!socketRef.current || !socketRef.current.connected || !gameId || gameOver || bombsUsed[playerNumber] || playerNumber !== turn) {
      if (bombsUsed[playerNumber]) {
        showMessage("You have already used your bomb!", true);
      } else if (gameOver) {
        showMessage("Game is over, cannot use bomb.", true);
      } else if (!gameId) {
        showMessage("Not in a game to use bomb.", true);
      } else if (playerNumber !== turn) {
        showMessage("It's not your turn to use the bomb!", true);
      } else if (!isSocketConnected) {
        showMessage("Not connected to server. Please wait or refresh.", true);
      }
      return;
    }

    // Only allow bomb usage if player is behind in score
    if (scores[playerNumber] < scores[playerNumber === 1 ? 2 : 1]) {
      socketRef.current.emit("use-bomb", { gameId });
      // When 'use-bomb' is emitted, we immediately activate visual highlighting
      setIsBombHighlightActive(true); 
    } else {
      showMessage("You can only use the bomb when you are behind in score!", true);
    }
  };

  const handleCancelBomb = () => { // New function for cancelling bomb mode
    setBombMode(false); // Reset backend's waitingForBombCenter state
    setIsBombHighlightActive(false); // Deactivate visual bomb highlighting
    setHighlightedBombArea([]); // Clear highlights
    setMessage("Bomb selection cancelled.");
  };

  const backToLobby = () => {
    if (gameId && socketRef.current && socketRef.current.connected) {
        socketRef.current.emit("leave-game", { gameId });
    } else if (!isSocketConnected) {
        showMessage("Not connected to server. Cannot leave game.", true);
    }

    setGameId(null);
    setPlayerNumber(null); // Reset player number
    setBoard([]);
    setTurn(null);
    setScores({ 1: 0, 2: 0 });
    setBombsUsed({ 1: false, 2: false });
    setBombMode(false); // Reset backend's bombMode state
    setIsBombHighlightActive(false); // Clear bomb highlight on leaving game
    setHighlightedBombArea([]); // Clear highlights
    setGameOver(false);
    setOpponentName("");
    setInvite(null);
    setMessage("");
    setUnfinishedGames([]);
    setObservableGames([]); // Clear observable games
    setLastClickedTile({ 1: null, 2: null });
    setLobbyMessages([]); // Clear lobby chat on returning to lobby (will be re-fetched)
    setGameMessages([]); // Clear game chat
    setObserversInGame([]); // Clear observers list in game
    setPlayer1DisplayName(""); // Clear player names
    setPlayer2DisplayName(""); // Clear player names


    // Request unfinished games and observable games again to refresh the list in the lobby
    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit("request-unfinished-games");
      socketRef.current.emit("request-observable-games"); // NEW: Re-request observable games
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
        setIsSocketConnected(false); // Set socket connected status to false
      }

      setLoggedIn(false);
      setName("");
      setIsGuest(false); // Reset guest status on logout
      localStorage.removeItem('guestDeviceId'); // Clear persistent guest ID (was 'guestId')
      setGameId(null);
      setPlayerNumber(null); // Reset player number
      setBoard([]);
      setTurn(null);
      setScores({ 1: 0, 2: 0 });
      setBombsUsed({ 1: false, 2: false });
      setBombMode(false); // Reset backend's bombMode state
      setIsBombHighlightActive(false); // Clear bomb highlight on logout
      setHighlightedBombArea([]); // Clear highlights
      setGameOver(false);
      setOpponentName("");
      setInvite(null);
      setLastClickedTile({ 1: null, 2: null });
      setLobbyMessages([]); // Clear chat history on logout
      setGameMessages([]);
      setUnfinishedGames([]);
      setObservableGames([]); // Clear observable games
      setObserversInGame([]); // Clear observers list in game
      setPlayer1DisplayName(""); // Clear player names
      setPlayer2DisplayName(""); // Clear player names
    } catch (err) {
      console.error("Logout failed", err);
      showMessage("Logout failed. Please try again.", true);
    }
  };

  // NEW: Mouse movement handler for bomb highlighting
  const handleMouseMoveOnGrid = useCallback((event) => {
    // Only highlight if bomb mode is active and board data is loaded
    if (!isBombHighlightActive || !board.length || !Array.isArray(board[0])) {
      setHighlightedBombArea([]); // Ensure no highlights if mode is off or board is not ready
      return;
    }
    const { x, y } = getTileCoordinates(event);
    setHighlightedBombArea(calculateBombArea(x, y));
  }, [isBombHighlightActive, board.length, board, calculateBombArea]); // Add board to dependencies

  // NEW: Mouse leave handler for grid
  const handleMouseLeaveGrid = useCallback(() => {
    if (isBombHighlightActive) {
      setHighlightedBombArea([]); // Clear highlights when mouse leaves grid
    }
  }, [isBombHighlightActive]);


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
    if (gameIdToResume && socketRef.current && socketRef.current.connected) {
        socketRef.current.emit("resume-game", { gameId: gameIdToResume });
        showMessage("Attempting to resume game...");
    } else if (!isSocketConnected) {
        showMessage("Not connected to server. Please wait or refresh.", true);
    }
  };

  // NEW: Function to observe a game
  const observeGame = (gameIdToObserve) => {
    if (gameIdToObserve && socketRef.current && socketRef.current.connected) {
        socketRef.current.emit("observe-game", { gameId: gameIdToObserve });
        showMessage("Attempting to observe game...");
    } else if (!isSocketConnected) {
        showMessage("Not connected to server. Please wait or refresh.", true);
    }
  };

  const sendLobbyMessage = (e) => {
    e.preventDefault();
    if (socketRef.current && socketRef.current.connected && lobbyMessageInput.trim()) {
      socketRef.current.emit("send-lobby-message", lobbyMessageInput);
      setLobbyMessageInput("");
    } else if (!isSocketConnected) {
        showMessage("Not connected to server. Cannot send message.", true);
    }
  };

  const sendGameMessage = (e) => {
    e.preventDefault();
    if (socketRef.current && socketRef.current.connected && gameId && gameMessageInput.trim()) {
      socketRef.current.emit("send-game-message", { gameId, message: gameMessageInput });
      setGameMessageInput("");
    } else if (!isSocketConnected) {
        showMessage("Not connected to server. Cannot send message.", true);
    } else if (!gameId) {
        showMessage("Not in a game to send message.", true);
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
                  onDoubleClick={() => {
                    // Only allow inviting if player is not in a game and not self
                    if (!p.gameId && p.id !== socketRef.current.id) {
                      invitePlayer(p.id);
                    } else if (p.id === socketRef.current.id) {
                      showMessage("You cannot invite yourself.", true);
                    } else {
                      showMessage(`${p.name} is currently ${p.role === 'player' ? `in a game vs. ${p.opponentName}` : 'observing a game'}.`, true);
                    }
                  }}
                  title={p.gameId ? `${p.name} is ${p.role === 'player' ? `in a game vs. ${p.opponentName}` : 'observing a game'}` : "Double-click to invite"}
                >
                  {p.name}
                  {p.gameId && (
                    <span className={`player-status ${p.role}`}>
                      {p.role === 'player' ? ` (In Game vs. ${p.opponentName})` : ` (Observing: ${p.opponentName})`}
                    </span>
                  )}
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
                                score: 🔴 {game.playerNumber === 1 ? `${name} ${game.scores?.[1] || 0} | ${game.scores?.[2] || 0} ${game.opponentName}` : `${game.opponentName} ${game.scores?.[1] || 0} | ${game.scores?.[2] || 0} ${name}`} 🔵 - Last updated: {game.lastUpdated}
                                 <button onClick={() => resumeGame(game.gameId)} className="bomb-button">Resume</button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* NEW: Observable Games Section */}
            <div className="observable-games-section">
                <h3>Observable Games</h3>
                {observableGames.length === 0 ? (
                    <p>No games currently available for observation.</p>
                ) : (
                    <ul className="observable-game-list">
                        {observableGames.map(game => (
                            <li key={game.gameId} className="observable-game-item">
                                {game.player1Name} vs. {game.player2Name} - Score: {game.scores?.[1] || 0} : {game.scores?.[2] || 0} - Active participants: {game.activeParticipants}
                                <button onClick={() => observeGame(game.gameId)} className="bomb-button">Observe</button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* Lobby Chat Section */}
            <div className="lobby-chat-container chat-container">
              <h3>Lobby Chat</h3>
              <div className="messages-display">
                {lobbyMessages.map((msg, index) => (
                  <div key={index} className={`message ${msg.sender === name ? 'my-message' : 'other-message'}`}>
                        <strong>{msg.sender}:</strong> {msg.text} <span className="timestamp">({msg.timestamp})</span>
                  </div>
                ))}
                <div ref={lobbyChatEndRef} />
              </div>
              <form onSubmit={sendLobbyMessage} className="message-input-form">
                <input
                  type="text"
                  value={lobbyMessageInput}
                  onChange={(e) => setLobbyMessageInput(e.target.value)}
                  placeholder="Type a lobby message..."
                  className="message-input"
                  disabled={!isSocketConnected}
                />
                <button type="submit" className="send-message-button" disabled={!isSocketConnected}>Send</button>
              </form>
            </div>

		      </>
)}

        {gameId && (
            <div className="app-game-container">
                <div className="header">
                    <h1>Minesweeper Flags</h1>
                    {/* Only show 'Use Bomb' button if player, not observer */}
                    {playerNumber !== 0 && playerNumber &&
                      !bombsUsed[playerNumber] &&
                      scores[playerNumber] < scores[playerNumber === 1 ? 2 : 1] &&
                      !gameOver && (
                        <button className="bomb-button" onClick={handleUseBombClick} disabled={!isSocketConnected}>
                            Use Bomb
                        </button>
                      )}
                    {/* Display Cancel Bomb button if bombMode is active for selection (only for players) */}
                    {playerNumber !== 0 && bombMode && (
                      <button className="bomb-button" onClick={handleCancelBomb} disabled={!isSocketConnected}>
                          Cancel Bomb
                      </button>
                    )}
                </div>

                   
                        <p style={{ fontWeight: 'bold', margin: '5px 0' }}>
                            <span style={{ color: turn === 1 ? 'green' : 'inherit' }}>{player1DisplayName || "Player 1"}: {scores[1]} </span>🚩
                        </p>
                        <p style={{ fontWeight: 'bold', margin: '5px 0' }}>
                            <span style={{ color: turn === 2 ? 'green' : 'inherit' }}>{player2DisplayName || "Player 2"}: {scores[2]} </span>🚩
                        </p>
                {message && <p className="app-message" style={{ color: 'red', fontWeight: 'bold' }}>{message}</p>}
                {playerNumber !== 0 && bombMode && <p className="app-message">— Select 5x5 bomb center</p>}


		            {/* Display unrevealed mines count */}
                <p className="mine-count-display">
                    Unrevealed Mines: <span style={{ color: 'red', fontWeight: 'bold' }}>{unrevealedMines}</span>
                </p>

                {/* List of observers in the game */}
                {observersInGame.length > 0 && (
                  <div className="observers-list">
                    <h4>Observers:</h4>
                    <ul>
                      {observersInGame.map((obs, index) => (
                        <li key={index}>{obs.name}</li>
                      ))}
                    </ul>
                  </div>
                )}


		            {/* Back to Lobby button always visible when in game */}
                <button className="bomb-button" onClick={backToLobby} disabled={!isSocketConnected}>
                    Back to Lobby
                </button>

                {gameOver && playerNumber !== 0 && ( // Only players can restart
                    <>
                        <button className="bomb-button" onClick={() => socketRef.current.emit("restart-game", { gameId })} disabled={!isSocketConnected}>
                            Restart Game
                        </button>
                    </>
                )}
                {gameOver && playerNumber === 0 && ( // Observer sees game over message
                    <p style={{ fontWeight: 'bold', color: 'green' }}>Game Over!</p>
                )}


                <div
                    className="grid"
                    style={{
                      gridTemplateColumns: `repeat(${board[0]?.length || 0}, 40px)`,
                    }}
                    // Only attach mouse events for players in bomb mode
                    onMouseMove={playerNumber !== 0 && bombMode ? handleMouseMoveOnGrid : null}
                    onMouseLeave={playerNumber !== 0 && bombMode ? handleMouseLeaveGrid : null}
                >
                    {board.flatMap((row, y) =>
                      row.map((tile, x) => {
                        // Check if the current tile is part of the highlighted bomb area
                        const isHighlighted = highlightedBombArea.some(
                            (coord) => coord.x === x && coord.y === y
                        );
                        return (
                          <div
                            key={`${x}-${y}`}
                            className={`tile ${
                              tile.revealed ? "revealed" : "hidden"
                            } ${tile.isMine && tile.revealed ? "mine" : ""} ${
                              lastClickedTile[1]?.x === x && lastClickedTile[1]?.y === y ? "last-clicked-p1" : ""
                            } ${
                              lastClickedTile[2]?.x === x && lastClickedTile[2]?.y === y ? "last-clicked-p2" : ""
                            } ${isHighlighted ? "highlighted-bomb-area" : "" /* Apply highlight class */
                            }`}
                            onClick={playerNumber !== 0 ? () => handleClick(x, y) : null} // Only players can click
                          >
                            {renderTile(tile)}
                          </div>
                        );
                      })
                    )}
                </div>

                {/* Game Chat Section */}
                <div className="game-chat-container chat-container">
                  <h3>Game Chat</h3>
                  <div className="messages-display">
                    {gameMessages.map((msg, index) => (
                      <div key={index} className={`message ${msg.sender === name ? 'my-message' : 'other-message'}`}>
                        <strong>{msg.sender}:</strong> {msg.text} <span className="timestamp">({msg.timestamp})</span>
                      </div>
                    ))}
                    <div ref={gameChatEndRef} />
                  </div>
                  <form onSubmit={sendGameMessage} className="message-input-form">
                    <input
                      type="text"
                      value={gameMessageInput}
                      onChange={(e) => setGameMessageInput(e.target.value)}
                      placeholder="Type a game message..."
                      className="message-input"
                      disabled={!isSocketConnected}
                    />
                    <button type="submit" className="send-message-button" disabled={!isSocketConnected}>Send</button>
                  </form>
                </div>
            </div>
        )}
    </div>
  );
}

export default App;
