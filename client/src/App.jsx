// App.jsx
import React, { useEffect, useState, useRef, useCallback } from "react";
import io from "socket.io-client";
// Removed Tone.js import as per request
import GoogleLogin from "./GoogleLogin"; // Assuming GoogleLogin component exists
import FacebookLogin from "./FacebookLogin"; // Corrected: Assuming FacebookLogin component exists
import AuthCallback from "./AuthCallback"; // NEW: Import AuthCallback component
import "./App.css"; // Ensure you have App.css for styling

// Helper function: Converts an ArrayBuffer to a hexadecimal string.
const bufferToHex = (buffer) => {
    return Array.prototype.map.call(new Uint8Array(buffer), x => ('00' + x.toString(16)).slice(-2)).join('');
};

// Helper function: Hashes a message using SHA-256 and converts it into a 5-digit number.
const generate5DigitGuestId = async (message) => {
    try {
        const msgBuffer = new TextEncoder().encode(message); // Encode message as UTF-8
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer); // Hash the message
        const fullHashHex = bufferToHex(hashBuffer); // Convert full hash to hex string

        // Take a portion of the hash (e.g., first 8 characters)...
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
  const [isSocketConnected, setIsSocketConnected] = useState(false); // New state to track connection status


  // === Game State ===
  const [gameId, setGameId] = useState(null);
  const [playerNumber, setPlayerNumber] = useState(null); // 1, 2 for players; 0 for observer (1,2,3,4 for 2v2)
  const [board, setBoard] = useState([]);
  const [turn, setTurn] = useState(null);
  const [scores, setScores] = useState({ 1: 0, 2: 0 }); // Team scores
  const [bombsUsed, setBombsUsed] = useState({ 1: false, 2: false }); // Team bombs
  const [bombMode, setBombMode] = useState(false); // Backend's waitingForBombCenter
  const [gameOver, setGameOver] = useState(false);
  const [opponentName, setOpponentName] = useState(""); // Relevant for 1v1
  const [invite, setInvite] = useState(null);
  const [unfinishedGames, setUnfinishedGames] = useState([]); // State for unfinished games
  const [observableGames, setObservableGames] = useState([]); // NEW: State for observable games
  const [lastClickedTile, setLastClickedTile] = useState({ 1: null, 2: null, 3: null, 4: null }); // Track last clicked tile
  const [unrevealedMines, setUnrevealedMines] = useState(0); // State to store unrevealed mines count
  const [observersInGame, setObserversInGame] = useState([]); // NEW: List of observers in the current game
  const [gamePlayerNames, setGamePlayerNames] = useState({ 1: '', 2: '' }); // Will extend for 2v2
  const [gameType, setGameType] = useState('1v1'); // '1v1' or '2v2'
  const [is2v2Mode, setIs2v2Mode] = useState(false); // Checkbox state for 2v2
  const [selectedPartner, setSelectedPartner] = useState(null); // For 2v2 invitation
  const [selectedRivals, setSelectedRivals] = useState([]); // For 2v2 invitation (max 2)
  const [invitationStage, setInvitationStage] = useState(0); // 0: no invite, 1: select partner, 2: select rivals

  // NEW: State for bomb highlighting
  const [isBombHighlightActive, setIsBombHighlightActive] = useState(false); // Controls visual indicator
  const [highlightedBombArea, setHighlightedBombArea] = useState([]); // Stores [x,y] coordinates

  // Constants for board dimensions
  const WIDTH = 16;
  const HEIGHT = 16;

  // Chat states
  const [lobbyMessages, setLobbyMessages] = useState([]);
  const [gameMessages, setGameMessages] = useState([]);
  const [serverMessages, setServerMessages] = useState([]); // NEW: State for server messages
  const [lobbyMessageInput, setLobbyMessageInput] = useState("");
  const [gameMessageInput, setGameMessageInput] = useState("");
  const lobbyChatEndRef = useRef(null);


  // Effect to scroll to the bottom of lobby chat
  useEffect(() => {
    if (lobbyChatEndRef.current && loggedIn && !gameId) {
      lobbyChatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [lobbyMessages, loggedIn, gameId]);

  // --- Utility Functions ---

  // Helper to get coordinates from a mouse event on grid
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

  // Helper function to calculate the 5x5 area around a center
  const calculateBombArea = useCallback((cx, cy) => {
    const area = [];
    const MIN_COORD = 2;
    const MAX_COORD_X = WIDTH - 3; 
    const MAX_COORD_Y = HEIGHT - 3; 

    if (cx < MIN_COORD || cx > MAX_COORD_X || cy < MIN_COORD || cy > MAX_COORD_Y) {
      return []; 
    }

    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) {
          area.push({ x, y });
        }
      }
    }
    return area;
  }, [WIDTH, HEIGHT]);


  // --- Helper to display messages ---
  const showMessage = (msg, isError = false) => {
    setMessage(msg);
    if (isError) {
      console.error(msg);
    } else {
      console.log(msg);
    }
    setTimeout(() => setMessage(""), 5000);
  };

  // --- Helper to add game messages to chat ---
  const addGameMessage = useCallback((sender, text, isError = false) => {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const newMessage = { sender, text, timestamp, isError };

    if (sender === "Server") { 
        setServerMessages(prevMessages => [...prevMessages, newMessage]);
    } else { 
        setGameMessages(prevMessages => [...prevMessages, newMessage]);
    }

    if (isError) {
      console.error(`Message Error: ${text}`);
    } else {
      console.log(`Message: ${text}`);
    }
  }, []);

  // --- Initial Authentication Check and Socket.IO Connection ---
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
          setIsGuest(data.user.id.startsWith('guest_')); 
          console.log("App.jsx: Initial auth check successful for:", data.user.displayName || data.user.name, "Is Guest:", data.user.id.startsWith('guest_'));

          // Initialize Socket.IO connection
          if (!socketRef.current) {
            console.log("Frontend: Initializing Socket.IO connection...");
            socketRef.current = io("https://minesweeper-flags-backend.onrender.com", {
              withCredentials: true,
            });

            // --- Attach Socket.IO Event Listeners ---
            socketRef.current.on('connect', () => {
                console.log("Socket.IO client: Connected!");
                setIsSocketConnected(true);
                if (loggedIn) { 
                  socketRef.current.emit("join-lobby", name); 
                } else {
                  console.log("Socket connected but not logged in yet. Waiting for login.");
                }
            });

            socketRef.current.on('disconnect', (reason) => {
                console.log(`Socket.IO client: Disconnected! Reason: ${reason}`);
                setIsSocketConnected(false);
                showMessage("Disconnected from server. Please refresh or try again."); 
                addGameMessage("Server", "Disconnected from server.", true); 
                setIsBombHighlightActive(false); 
                setHighlightedBombArea([]);
            });

            socketRef.current.on('connect_error', (error) => {
                console.error("Socket.IO client: Connection error!", error);
                showMessage(`Socket connection error: ${error.message}. Please check server logs.`, true); 
                addGameMessage("Server", `Connection error: ${error.message}`, true); 
                setIsSocketConnected(false);
                setIsBombHighlightActive(false); 
                setHighlightedBombArea([]);
            });

            socketRef.current.on('authenticated-socket-ready', () => {
                console.log("Frontend: Server confirmed authenticated socket ready!");
                if (loggedIn && name) { 
                  socketRef.current.emit("join-lobby", name);
                }
            });

            socketRef.current.on("join-error", (msg) => {
              showMessage(msg, true); 
              if (gameId) addGameMessage("Server", msg, true); 
              if (msg.includes("Authentication required")) {
                setLoggedIn(false);
                setName("");
                setIsGuest(false); 
              }
              setIsBombHighlightActive(false); 
              setHighlightedBombArea([]);
            });

            socketRef.current.on("lobby-joined", (userName) => {
              setLoggedIn(true);
              setName(userName);
              showMessage(`Lobby joined successfully as ${userName}!`);
              socketRef.current.emit("request-unfinished-games");
              socketRef.current.emit("request-observable-games"); 
            });

            socketRef.current.on("players-list", (players) => {
              setPlayersList(players);
            });

            socketRef.current.on("game-invite", (inviteData) => {
              setInvite(inviteData);
              if (inviteData.gameType === '2v2' && inviteData.invitedPlayersInfo) {
                const inviterName = inviteData.senderName;
                const otherPlayers = inviteData.invitedPlayersInfo
                    .filter(p => p.userId !== inviteData.senderId && p.userId !== (socketRef.current.request.session?.passport?.user?.id || null))
                    .map(p => p.name);

                let inviteMessage = `2v2 Invitation from ${inviterName}.`;
                if (otherPlayers.length === 3) { 
                    const partnerName = otherPlayers[0]; 
                    const rival1Name = otherPlayers[1];
                    const rival2Name = otherPlayers[2];
                    inviteMessage += ` You, ${partnerName}, ${rival1Name}, and ${rival2Name} are invited.`;
                } else {
                    inviteMessage += ` Invited players: ${otherPlayers.join(', ')}`;
                }
                showMessage(inviteMessage);
              } else {
                showMessage(`Invitation from ${inviteData.senderName}!`); 
              }
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
              setOpponentName(data.opponentName || ""); 
              setBombMode(false); 
              setIsBombHighlightActive(false); 
              setHighlightedBombArea([]); 
              setLastClickedTile(data.lastClickedTile || { 1: null, 2: null, 3: null, 4: null }); 
              setGameMessages(data.gameChat || []); 
              setObserversInGame(data.observers || []); 
              setServerMessages([]); 
              setGameType(data.gameType); 

              setGamePlayerNames({
                1: data.player1Name || "Player 1",
                2: data.player2Name || "Player 2",
                3: data.player3Name || "Player 3", 
                4: data.player4Name || "Player 4", 
              });

              setMessage(""); 
              addGameMessage("Server", `Game (${data.gameType}) started!`, false); 
              setUnfinishedGames([]); 
              setObservableGames([]); 
            });

            socketRef.current.on("board-update", (game) => {
              setBoard(JSON.parse(game.board));
              setTurn(game.turn);
              setScores(game.scores); 
              setBombsUsed(game.bombsUsed); 
              setGameOver(game.gameOver);
              setBombMode(false); 
              setIsBombHighlightActive(false); 
              setHighlightedBombArea([]); 
              setLastClickedTile(game.lastClickedTile || { 1: null, 2: null, 3: null, 4: null }); 
              setObserversInGame(game.observers || []); 
              setMessage(""); 
            });

            socketRef.current.on("wait-bomb-center", () => {
              setBombMode(true); 
              addGameMessage("Server", "Select 5x5 bomb center.", false); 
              setIsBombHighlightActive(true); 
            });

            socketRef.current.on("opponent-left", () => {
              addGameMessage("Server", "Opponent left the game.", true); 
              setBombMode(false); 
              setIsBombHighlightActive(false); 
              setHighlightedBombArea([]);
            });

            socketRef.current.on("bomb-error", (msg) => {
              addGameMessage("Server", msg, true); 
              setBombMode(false); 
              setIsBombHighlightActive(false); 
              setHighlightedBombArea([]);
            });

            socketRef.current.on("receive-unfinished-games", (games) => {
              const deserializedGames = games.map(game => ({
                  ...game,
                  board: JSON.parse(game.board) 
              }));
              setUnfinishedGames(deserializedGames);
            });

            socketRef.current.on("receive-observable-games", (games) => {
                setObservableGames(games);
            });

            socketRef.current.on("opponent-reconnected", ({ name }) => {
                addGameMessage("Server", `${name} has reconnected!`, false); 
            });

            socketRef.current.on("player-reconnected", ({ name, userId, role }) => {
              addGameMessage("Server", `${name} (${role}) reconnected to this game!`, false); 
              setObserversInGame(prev => prev.filter(o => o.userId !== userId));
            });

            socketRef.current.on("player-left", ({ name, userId, role }) => {
              addGameMessage("Server", `${name} (${role}) left the game!`, true); 
              setObserversInGame(prev => prev.filter(o => o.userId !== userId)); 
            });

            socketRef.current.on("observer-joined", ({ name, userId }) => {
                addGameMessage("Server", `${name} is now observing!`, false); 
                setObserversInGame(prev => {
                    const updated = prev.map(o => o.userId === userId ? { ...o, socketId: socketRef.current.id } : o);
                    return updated.some(o => o.userId === userId) ? updated : [...updated, { userId, name, socketId: socketRef.current.id }];
                });
            });

            socketRef.current.on("observer-left", ({ name, userId }) => {
                addGameMessage("Server", `${name} stopped observing.`, true); 
                setObserversInGame(prev => prev.filter(obs => obs.userId !== userId));
            });

            socketRef.current.on("game-over", ({ winnerPlayerNumber, winByScore, winningTeamName }) => {
                setGameOver(true);
                if (winningTeamName) {
                    addGameMessage("Server", `Game Over! Team ${winningTeamName} wins with score ${winByScore}!`, false);
                } else if (winnerPlayerNumber) {
                    addGameMessage("Server", `Game Over! Player ${winnerPlayerNumber} wins!`, false);
                } else {
                    addGameMessage("Server", "Game Over! It's a draw!", false);
                }
            });

            socketRef.current.on("game-restarted", (data) => {
              addGameMessage("Server", "Game restarted due to first click on blank tile!", false);
              setGameId(data.gameId);
              setPlayerNumber(data.playerNumber); 
              setBoard(JSON.parse(data.board));
              setTurn(data.turn);
              setScores(data.scores);
              setBombsUsed(data.bombsUsed);
              setGameOver(data.gameOver);
              setOpponentName(data.opponentName || ""); 
              setBombMode(false); 
              setIsBombHighlightActive(false); 
              setHighlightedBombArea([]); 
              setLastClickedTile(data.lastClickedTile || { 1: null, 2: null, 3: null, 4: null });
              setGameMessages(data.gameChat || []); 
              setObserversInGame(data.observers || []); 
              setServerMessages([]); 
              setGameType(data.gameType);

              setGamePlayerNames({
                1: data.player1Name || "Player 1",
                2: data.player2Name || "Player 2",
                3: data.player3Name || "Player 3", 
                4: data.player4Name || "Player 4", 
              });
            });

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
            if (loggedIn && name) { 
                socketRef.current.emit("join-lobby", name);
                socketRef.current.emit("request-unfinished-games"); 
                socketRef.current.emit("request-observable-games"); 
            }
          }

        } else {
          setLoggedIn(false);
          setName("");
          setIsGuest(false); 
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
        setIsGuest(false); 
        showMessage(`An error occurred: ${err.message}. Please refresh.`, true); 
        addGameMessage("Server", `Fatal error: ${err.message}. Please refresh.`, true); 
        if (socketRef.current) {
          socketRef.current.disconnect();
          socketRef.current = null;
          setIsSocketConnected(false);
        }
      }
    };

    checkAuthStatusAndConnectSocket();

    // Listener for messages from the OAuth pop-up window
    const handleAuthMessage = (event) => {
      if (event.origin !== "https://minesweeper-flags-backend.onrender.com") { 
        console.warn("Received message from untrusted origin:", event.origin);
        return;
      }

      if (event.data && event.data.type === 'AUTH_SUCCESS') {
        const { user } = event.data;
        setName(user.displayName || `User_${user.id.substring(0, 8)}`);
        setLoggedIn(true);
        setIsGuest(user.id.startsWith('guest_')); 
        showMessage("Login successful!");
        window.history.replaceState({}, document.title, window.location.pathname); 
      } else if (event.data && event.data.type === 'AUTH_FAILURE') {
        showMessage(`Login failed: ${event.data.message}`, true);
        setLoggedIn(false);
        setName("");
        setIsGuest(false); 
        window.history.replaceState({}, document.title, window.location.pathname); 
      }
    };

    // CRITICAL iOS FIX: Active Mount check + Real-time Storage fallback event handler
    const checkStorageAndListen = () => {
      // Check immediately on load if callback saved the login state before tab refresh
      const savedUser = localStorage.getItem('auth_success_user');
      if (savedUser) {
        try {
          const { user } = JSON.parse(savedUser);
          console.log("App.jsx: Restored authentication state from storage mount check.");
          setName(user.displayName || `User_${user.id.substring(0, 8)}`);
          setLoggedIn(true);
          setIsGuest(user.id.startsWith('guest_'));
          showMessage("Login successful!");
          localStorage.removeItem('auth_success_user'); // Evict immediately after consuming
        } catch (e) {
          console.error("Error reading saved user data from storage on mount", e);
        }
      }
    };

    const handleStorageChange = (event) => {
      if (event.key === 'auth_success_user' && event.newValue) {
        try {
          const { user } = JSON.parse(event.newValue);
          setName(user.displayName || `User_${user.id.substring(0, 8)}`);
          setLoggedIn(true);
          setIsGuest(user.id.startsWith('guest_'));
          showMessage("Login successful!");
          localStorage.removeItem('auth_success_user');
        } catch (e) {
          console.error("Error parsing real-time storage sync data", e);
        }
      }
    };

    checkStorageAndListen(); // Run active mount storage sync
    window.addEventListener('message', handleAuthMessage);
    window.addEventListener('storage', handleStorageChange); 

    return () => {
      console.log("App useEffect: Cleanup running.");
      if (socketRef.current) {
        socketRef.current.disconnect(); 
        socketRef.current = null; 
      }
      window.removeEventListener('message', handleAuthMessage); 
      window.removeEventListener('storage', handleStorageChange); 
    };
  }, [loggedIn, name, addGameMessage, gameId]); 

  // Track remaining mines
  useEffect(() => {
    if (board && board.length > 0) {
      let totalMines = 0;
      let revealedMines = 0;
      board.forEach(row => {
        row.forEach(tile => {
          if (tile.isMine) {
            totalMines++;
            if (tile.revealed) {
              revealedMines++;
            }
          }
        });
      });
      setUnrevealedMines(totalMines - revealedMines);
    } else {
      setUnrevealedMines(0); 
    }
  }, [board]);

  const loginAsGuest = async () => {
    let guestId;
    let displayName;
    try {
        const deviceUuid = getDeviceUuid();
        guestId = await generate5DigitGuestId(deviceUuid);
        guestId = `guest_${guestId}`;
        displayName = `Guest_${guestId.substring(6)}`; 
    } catch (error) {
      guestId = `guest_fallback_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`; 
      displayName = `Guest_Fallback`;
    }

    try {
      const response = await fetch("https://minesweeper-flags-backend.onrender.com/auth/guest", {
        method: "POST", 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId, name: displayName }), 
        credentials: "include",
      });

      if (response.ok) {
        const data = await response.json();
        setName(data.user.displayName); 
        setLoggedIn(true);
        setIsGuest(true);
        showMessage("Logged in as guest!");
      } else {
        setLoggedIn(false);
        setIsGuest(false);
      }
    } catch (error) {
      setLoggedIn(false);
      setIsGuest(false);
    }
  };

  const handlePlayerClick = (player) => {
    if (player.id === socketRef.current.id) {
      showMessage("You cannot invite yourself.", true);
      return;
    }
    if (player.gameId) {
      showMessage(`${player.name} is currently busy.`, true);
      return;
    }

    if (!is2v2Mode) { 
      invitePlayer([player.id], '1v1'); 
    } else { 
      if (invitationStage === 0) {
        showMessage("Please select 2v2 mode first.", true);
      } else if (invitationStage === 1) { 
        setSelectedPartner(player);
        setInvitationStage(2);
      } else if (invitationStage === 2) { 
        const isAlreadySelected = (selectedPartner && selectedPartner.id === player.id) ||
                                  selectedRivals.some(rival => rival.id === player.id);
        if (isAlreadySelected) return;

        const newRivals = [...selectedRivals, player];
        setSelectedRivals(newRivals);
        if (newRivals.length === 2) {
          sendTeamInvite(selectedPartner, newRivals);
        }
      }
    }
  };

  const invitePlayer = (targetSocketIds, type) => {
    if (loggedIn && socketRef.current && socketRef.current.connected) {
      socketRef.current.emit("invite-player", { targetSocketIds, gameType: type });
      showMessage("Invitation sent.");
    }
  };

  const sendTeamInvite = (partner, rivals) => {
    if (!partner || rivals.length !== 2) return;
    const allPlayerIds = [partner.id, rivals[0].id, rivals[1].id]; 
    invitePlayer(allPlayerIds, '2v2');
    setSelectedPartner(null);
    setSelectedRivals([]);
    setIs2v2Mode(false); 
    setInvitationStage(0);
  };

  const respondInvite = (accept) => {
    if (invite && socketRef.current && socketRef.current.connected) {
      socketRef.current.emit("respond-invite", { inviteId: invite.inviteId, gameIdFromClient: null, accept });
      setInvite(null);
      setSelectedPartner(null);
      setSelectedRivals([]);
      setIs2v2Mode(false);
      setInvitationStage(0);
    }
  };

  const handleClick = (x, y) => {
    if (!gameId || gameOver || !isSocketConnected || playerNumber === 0) return;

    if (bombMode) { 
      const MIN_COORD = 2; 
      const MAX_COORD_X = WIDTH - 3; 
      const MAX_COORD_Y = HEIGHT - 3; 

      if (x < MIN_COORD || x > MAX_COORD_X || y < MIN_COORD || y > MAX_COORD_Y) return;

      socketRef.current.emit("bomb-center", { gameId, x, y });
      setBombMode(false); 
      setIsBombHighlightActive(false); 
      setHighlightedBombArea([]); 
    } else if (playerNumber === turn && !gameOver) {
      socketRef.current.emit("tile-click", { gameId, x, y });
    }
  };

  const handleUseBombClick = () => { 
    if (playerNumber === 0) return;

    if (!isSocketConnected || !gameId || gameOver || currentBombUsedStatus || !(gameType === '1v1' ? playerNumber === turn : true)) {
      return;
    }

    if (currentPlayerScore < opponentPlayerOrTeamScore) { 
      socketRef.current.emit("use-bomb", { gameId });
      setIsBombHighlightActive(true); 
      addGameMessage("Server", "Bomb initiated. Select target.", false); 
    }
  };

  const handleCancelBomb = () => { 
    setBombMode(false); 
    setIsBombHighlightActive(false); 
    setHighlightedBombArea([]); 
  };

  const backToLobby = () => {
    if (gameId && socketRef.current && socketRef.current.connected) {
        socketRef.current.emit("leave-game", { gameId });
    }

    setGameId(null);
    setPlayerNumber(null); 
    setBoard([]);
    setTurn(null);
    setScores({ 1: 0, 2: 0 });
    setBombsUsed({ 1: false, 2: false });
    setBombMode(false); 
    setIsBombHighlightActive(false); 
    setHighlightedBombArea([]); 
    setGameOver(false);
    setOpponentName("");
    setInvite(null);
    setUnfinishedGames([]);
    setObservableGames([]); 
    setLastClickedTile({ 1: null, 2: null, 3: null, 4: null }); 
    setLobbyMessages([]); 
    setGameMessages([]); 
    setServerMessages([]); 
    setObserversInGame([]); 
    setGamePlayerNames({ 1: '', 2: '', 3: '', 4: '' }); 
    setGameType('1v1'); 

    setSelectedPartner(null);
    setSelectedRivals([]);
    setIs2v2Mode(false);
    setInvitationStage(0);

    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit("request-unfinished-games");
      socketRef.current.emit("request-observable-games"); 
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
        setIsSocketConnected(false); 
      }

      setLoggedIn(false);
      setName("");
      setIsGuest(false); 
      localStorage.removeItem('guestDeviceId'); 
      setGameId(null);
      setBoard([]);
      setGameOver(false);
    } catch (err) {
      console.error("Logout failed", err);
    }
  };

  const handleMouseMoveOnGrid = useCallback((event) => {
    if (!isBombHighlightActive || !board.length || !Array.isArray(board[0])) {
      setHighlightedBombArea([]); 
      return;
    }
    const { x, y } = getTileCoordinates(event);
    setHighlightedBombArea(calculateBombArea(x, y));
  }, [isBombHighlightActive, board.length, board, calculateBombArea]); 

  const handleMouseLeaveGrid = useCallback(() => {
    if (isBombHighlightActive) {
      setHighlightedBombArea([]); 
    }
  }, [isBombHighlightActive]);

  const renderTile = (tile) => {
    if (!tile.revealed) return "";
    if (tile.isMine && tile.ownerTeam) {
      return (
        <div className="tile hidden"> 
          {tile.ownerTeam === 1 && (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="red" width="24px" height="24px">
              <path d="M0 0h24v24H0z" fill="none"/>
              <path d="M14.4 6L14 4H5V20h2v-7h5.6l.4 2h7V6z"/>
            </svg>
          )}
          {tile.ownerTeam === 2 && (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="blue" width="24px" height="24px">
              <path d="M0 0h24v24H0z" fill="none"/>
              <path d="M14.4 6L14 4H5V20h2v-7h5.6l.4 2h7V6z"/>
            </svg>
          )}
        </div>
      );
    }
    if (tile.adjacentMines > 0) {
      return <span className={`number-${tile.adjacentMines}`}>{tile.adjacentMines}</span>;
    }
    return "";
  };

  const resumeGame = (gameIdToResume) => {
    if (gameIdToResume && socketRef.current && socketRef.current.connected) {
        socketRef.current.emit("resume-game", { gameId: gameIdToResume });
    }
  };

  const observeGame = (gameIdToObserve) => {
    if (gameIdToObserve && socketRef.current && socketRef.current.connected) {
        socketRef.current.emit("observe-game", { gameId: gameIdToObserve });
    }
  };

  const sendLobbyMessage = (e) => {
    e.preventDefault();
    if (socketRef.current && socketRef.current.connected && lobbyMessageInput.trim()) {
      socketRef.current.emit("send-lobby-message", lobbyMessageInput);
      setLobbyMessageInput("");
    }
  };

  const sendGameMessage = (e) => {
    e.preventDefault();
    if (socketRef.current && socketRef.current.connected && gameId && gameMessageInput.trim()) {
      socketRef.current.emit("send-game-message", { gameId, message: gameMessageInput });
      setGameMessageInput("");
    }
  };

  const handle2v2CheckboxChange = (e) => {
    const isChecked = e.target.checked;
    setIs2v2Mode(isChecked);
    if (isChecked) {
      setInvitationStage(1); 
    } else {
      setInvitationStage(0); 
      setSelectedPartner(null);
      setSelectedRivals([]);
    }
  };

  if (!loggedIn) {
    return (
      <div className="lobby">
        {message && <p className="app-message" style={{color: 'red'}}>{message}</p>}
        <h2>Login or Play as Guest</h2>
        <GoogleLogin onLogin={() => console.log("Google redirect completed.")} />
        <FacebookLogin onLogin={() => console.log("Facebook redirect completed.")} />
        <button className="guest-login-button" onClick={loginAsGuest}>
          Play as Guest
        </button>
      </div>
    );
  }

  let currentPlayerScore = 0;
  let opponentPlayerOrTeamScore = 0;
  let currentBombUsedStatus = false;

  if (gameId && playerNumber !== null && scores) {
      if (gameType === '1v1') {
          currentPlayerScore = scores[playerNumber];
          opponentPlayerOrTeamScore = scores[playerNumber === 1 ? 2 : 1]; 
          currentBombUsedStatus = bombsUsed[playerNumber];
      } else if (gameType === '2v2') {
          const myTeamNumber = (playerNumber === 1 || playerNumber === 2) ? 1 : 2;
          const opponentTeamNumber = myTeamNumber === 1 ? 2 : 1;
          currentPlayerScore = scores[myTeamNumber];
          opponentPlayerOrTeamScore = scores[opponentTeamNumber];
          currentBombUsedStatus = bombsUsed[myTeamNumber];
      }
  }

  return (
    <div className="lobby">
        {message && <p className="app-message" style={{color: message.includes("Error") ? 'red' : 'green'}}>{message}</p>}

        {!gameId && (
            <>
            <h2>Lobby - Online Players</h2>
            <p>Logged in as: <b>{name} {isGuest && "(Guest)"}</b></p>
            <button onClick={logout} className="bomb-button">Logout</button>

            <div className="game-mode-selection">
              <label>
                <input
                  type="checkbox"
                  checked={is2v2Mode}
                  onChange={handle2v2CheckboxChange}
                  disabled={!!selectedPartner || selectedRivals.length > 0} 
                />
                2v2 Game Mode
              </label>
            </div>
            {is2v2Mode && invitationStage === 1 && <p>Double-click to select your partner:</p>}
            {is2v2Mode && invitationStage === 2 && <p>Double-click to select rivals (2 needed): <br/>Selected: {selectedRivals.map(r => r.name).join(', ')}</p>}
            {is2v2Mode && selectedPartner && <p>Your Partner: <b>{selectedPartner.name}</b></p>}

            {playersList.length === 0 && <p>No other players online</p>}
            <ul className="player-list">
              {playersList.map((p) => (
                <li
                  key={p.id}
                  className={`player-item 
                              ${socketRef.current && p.id === socketRef.current.id ? 'self-player' : ''} 
                              ${selectedPartner && selectedPartner.id === p.id ? 'selected-partner' : ''}
                              ${selectedRivals.some(r => r.id === p.id) ? 'selected-rival' : ''}
                              `}
                  onDoubleClick={() => handlePlayerClick(p)}
                >
                  {p.name}
                  {p.gameId && (
                    <span className={`player-status ${p.role}`}>
                      {p.role === 'player' ? ` (In Game vs. ${p.opponentName})` : ` (Observing: ${p.opponentName})`}
                    </span>
                  )}
                  {socketRef.current && p.id !== socketRef.current.id && !p.gameId && ( 
                    <button 
                      className="invite-button" 
                      onClick={(e) => {
                        e.stopPropagation(); 
                        handlePlayerClick(p);
                      }}
                      disabled={is2v2Mode && (invitationStage === 1 && selectedPartner) || (invitationStage === 2 && selectedRivals.length === 2)}
                    >
                      {is2v2Mode ? "Select" : "Invite"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {invite && (
              <div className="invite-popup">
                <p>Invitation from <b>{invite.senderName}</b></p>
                <button onClick={() => respondInvite(true)}>Accept</button>
                <button onClick={() => respondInvite(false)}>Reject</button>
              </div>
            )}

            <div className="unfinished-games-section">
                <h3>Your Unfinished Games</h3>
                {unfinishedGames.length === 0 ? <p>No unfinished games found.</p> : (
                    <ul className="unfinished-game-list">
                        {unfinishedGames.map(game => (
                            <li key={game.gameId} className="unfinished-game-item">
                                Game ID: {game.gameId.substring(0, 8)} - Score: {game.scores?.[1] || 0} | {game.scores?.[2] || 0}
                                <button onClick={() => resumeGame(game.gameId)} className="bomb-button">Resume</button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="observable-games-section">
                <h3>Observable Games</h3>
                {observableGames.length === 0 ? <p>No games currently available for observation.</p> : (
                    <ul className="observable-game-list">
                        {observableGames.map(game => (
                            <li key={game.gameId} className="observable-game-item">
                                {game.player1Name} vs. {game.player2Name} - Active: {game.activeParticipants}
                                <button onClick={() => observeGame(game.gameId)} className="bomb-button">Observe</button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

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
                <div className="game-layout-grid">
                    <div className="game-sidebar left-sidebar">
                        <h1 className="game-title">Minesweeper Flags</h1>
                        <div className="game-controls">
                            {playerNumber !== 0 && !currentBombUsedStatus && currentPlayerScore < opponentPlayerOrTeamScore && !gameOver && (
                                <button className="bomb-button" onClick={handleUseBombClick} disabled={!isSocketConnected}>Use Bomb</button>
                            )}
                            {playerNumber !== 0 && bombMode && (
                              <button className="bomb-button" onClick={handleCancelBomb} disabled={!isSocketConnected}>Cancel Bomb</button>
                            )}
                            <button className="bomb-button" onClick={backToLobby} disabled={!isSocketConnected}>Back to Lobby</button>
                            {gameOver && playerNumber !== 0 && ( 
                                <button className="bomb-button" onClick={() => socketRef.current.emit("restart-game", { gameId })} disabled={!isSocketConnected}>Restart Game</button>
                            )}
                        </div>
                        <div className="game-info">
                            <h2>{playerNumber === 0 ? "You are Observing" : `You are Player ${playerNumber}`}</h2>
                            <div className="score-display">
                                <p style={{ color: (turn === 1 || turn === 2) ? 'green' : 'inherit' }}>Team 1: {scores[1]}</p>
                                <p style={{ color: (turn === 3 || turn === 4) ? 'green' : 'inherit' }}>Team 2: {scores[2]}</p>
                            </div>
                            <p className="mine-count-display">Unrevealed Mines: <span style={{ color: 'red', fontWeight: 'bold' }}>{unrevealedMines}</span></p>
                        </div>
                    </div>

                    <div className="game-board-area">
                        <div
                            className="grid"
                            style={{ gridTemplateColumns: `repeat(${board[0]?.length || 0}, 40px)` }}
                            onMouseMove={playerNumber !== 0 && bombMode ? handleMouseMoveOnGrid : null}
                            onMouseLeave={playerNumber !== 0 && bombMode ? handleMouseLeaveGrid : null}
                        >
                            {board.flatMap((row, y) =>
                              row.map((tile, x) => {
                                const isHighlighted = highlightedBombArea.some((coord) => coord.x === x && coord.y === y);
                                return (
                                  <div
                                    key={`${x}-${y}`}
                                    className={`tile ${tile.revealed ? "revealed" : "hidden"} ${tile.isMine && tile.revealed ? "mine" : ""} ${isHighlighted ? "highlighted-bomb-area" : ""}`}
                                    onClick={playerNumber !== 0 ? () => handleClick(x, y) : null}
                                  >
                                    {renderTile(tile)}
                                  </div>
                                );
                              })
                            )}
                        </div>
                    </div>
                    
                    <div className="game-sidebar right-sidebar"></div>

                    <div className="game-bottom-panel observer-list-panel">
                        {observersInGame.length > 0 && (
                            <div className="observers-list">
                                <h4>Observers:</h4>
                                <ul>{observersInGame.map((obs, idx) => <li key={idx}>{obs.name}</li>)}</ul>
                            </div>
                        )}
                    </div>

                    <div className="game-bottom-panel game-chat-panel">
                        <div className="game-chat-container chat-container">
                            <h3>Game Chat</h3>
                            <div className="messages-display">
                                {gameMessages.map((msg, index) => (
                                    <div key={index} className={`message ${msg.sender === name ? 'my-message' : 'other-message'}`}>
                                        <strong>{msg.sender}:</strong> {msg.text}
                                    </div>
                                ))}
                            </div>
                            <form onSubmit={sendGameMessage} className="message-input-form">
                                <input type="text" value={gameMessageInput} onChange={(e) => setGameMessageInput(e.target.value)} placeholder="Type a game message..." className="message-input" disabled={!isSocketConnected} />
                                <button type="submit" className="send-message-button" disabled={!isSocketConnected}>Send</button>
                            </form>
                        </div>
                    </div>

                    <div className="game-bottom-panel server-chat-panel">
                        <div className="server-chat-container chat-container">
                            <h3>Server Messages</h3>
                            <div className="messages-display">
                                {serverMessages.map((msg, index) => (
                                    <div key={index} className="message server-message">
                                        <strong>{msg.sender}:</strong> {msg.text}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        )}
    </div>
  );
}

export default App;
