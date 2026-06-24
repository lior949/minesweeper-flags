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

        const hashPortion = fullHashHex.substring(0, 8); // e.g., "a1b2c3d4"
        const decimalValue = parseInt(hashPortion, 16); // e.g., 2712845268

        const fiveDigitNumber = decimalValue % 100000;
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

  if (isAuthCallback) {
    return <AuthCallback />;
  }

  console.log("App component rendered (main application).");

  // === Lobby & Authentication State ===
  const [name, setName] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);
  const [isGuest, setIsGuest] = useState(false); // NEW: Track if logged in as guest
  const [playersList, setPlayersList] = useState([]);
  const [message, setMessage] = useState(""); // General message/error display

  const socketRef = useRef(null); 
  const [isSocketConnected, setIsSocketConnected] = useState(false); 

  const prevScoresRef = useRef({ 1: 0, 2: 0 });
  const prevRevealedCountRef = useRef(0);

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
  const [unfinishedGames, setUnfinishedGames] = useState([]); 
  const [observableGames, setObservableGames] = useState([]); 
  const [lastClickedTile, setLastClickedTile] = useState({ 1: null, 2: null, 3: null, 4: null }); 
  const [unrevealedMines, setUnrevealedMines] = useState(0); 
  const [observersInGame, setObserversInGame] = useState([]); 
  const [gamePlayerNames, setGamePlayerNames] = useState({ 1: '', 2: '' }); 
  const [gameType, setGameType] = useState('1v1'); 
  const [is2v2Mode, setIs2v2Mode] = useState(false); 
  const [selectedPartner, setSelectedPartner] = useState(null); 
  const [selectedRivals, setSelectedRivals] = useState([]); 
  const [invitationStage, setInvitationStage] = useState(0); 

  const [isBombHighlightActive, setIsBombHighlightActive] = useState(false); 
  const [highlightedBombArea, setHighlightedBombArea] = useState([]); 

  const WIDTH = 16;
  const HEIGHT = 16;

  // Chat states
  const [lobbyMessages, setLobbyMessages] = useState([]);
  const [gameMessages, setGameMessages] = useState([]);
  const [serverMessages, setServerMessages] = useState([]); 
  const [lobbyMessageInput, setLobbyMessageInput] = useState("");
  const [gameMessageInput, setGameMessageInput] = useState("");
  const lobbyChatEndRef = useRef(null);

  useEffect(() => {
    if (lobbyChatEndRef.current && loggedIn && !gameId) {
      lobbyChatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [lobbyMessages, loggedIn, gameId]);

  const getTileCoordinates = (event) => {
    const grid = event.currentTarget;
    const { left, top, width, height } = grid.getBoundingClientRect();

    const tileWidth = width / WIDTH;
    const tileHeight = height / HEIGHT;

    const mouseX = event.clientX - left;
    const mouseY = event.clientY - top;

    const x = Math.floor(mouseX / tileWidth);
    const y = Math.floor(mouseY / tileHeight);

    return { x, y };
  };

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

  const showMessage = (msg, isError = false) => {
    setMessage(msg);
    if (isError) {
      console.error(msg);
    } else {
      console.log(msg);
    }
    setTimeout(() => setMessage(""), 5000);
  };

  const addGameMessage = useCallback((sender, text, isError = false) => {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const newMessage = { sender, text, timestamp, isError };

    if (sender === "Server") { 
        setServerMessages(prevMessages => [...prevMessages, newMessage]);
    } else { 
        setGameMessages(prevMessages => [...prevMessages, newMessage]);
    }
  }, []);

  useEffect(() => {
    console.log("App useEffect: Running initial setup.");

    const checkAuthStatusAndConnectSocket = async () => {
      try {
        const response = await fetch("https://minesweeper-flags-backend.onrender.com/me", {
          method: "GET",
          credentials: "include",
        });

        let data = null;
        if (response.ok) {
          data = await response.json();
        }

        if (!data && localStorage.getItem('auth_success_user')) {
          try {
            const savedSession = JSON.parse(localStorage.getItem('auth_success_user'));
            if (savedSession && savedSession.user) {
              console.warn("Safari Cookie blocked: Recovering state from localStorage fallback.");
              data = savedSession; 
            }
          } catch (e) {
            console.error("Failed to parse fallback session data", e);
          }
        }

        if (data && data.user) {
          const currentUserName = data.user.displayName || data.user.name || `User_${data.user.id.substring(0, 8)}`;
          setName(currentUserName);
          setLoggedIn(true);
          setIsGuest(data.user.id.startsWith('guest_')); 
          console.log("App.jsx: Auth verification successful for:", currentUserName);

          if (!socketRef.current) {
            console.log("Frontend: Initializing Socket.IO connection...");
            socketRef.current = io("https://minesweeper-flags-backend.onrender.com", {
              withCredentials: true,
              query: {
                fallbackUserId: data.user.id,
                fallbackName: currentUserName
              }
            });

            socketRef.current.on('connect', () => {
                console.log("Socket.IO client: Connected!");
                setIsSocketConnected(true);
                socketRef.current.emit("join-lobby", currentUserName);
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
                socketRef.current.emit("join-lobby", currentUserName);
            });

            socketRef.current.on("join-error", (msg) => {
              showMessage(msg, true);
              if (gameId) addGameMessage("Server", msg, true);
              if (msg.includes("Authentication required") && !localStorage.getItem('auth_success_user')) {
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
                    .filter(p => p.userId !== inviteData.senderId && p.userId !== (data.user.id))
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
        if (socketRef.current) {
          socketRef.current.disconnect();
          socketRef.current = null;
          setIsSocketConnected(false);
        }
      }
    };

    checkAuthStatusAndConnectSocket();

    const handleAuthMessage = (event) => {
      if (event.origin !== "https://minesweeper-flags-backend.onrender.com") return;

      if (event.data && event.data.type === 'AUTH_SUCCESS') {
        const { user } = event.data;
        localStorage.setItem('auth_success_user', JSON.stringify({ user })); 
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

    const handleStorageChange = (event) => {
      if (event.key === 'auth_success_user' && event.newValue) {
        try {
          const { user } = JSON.parse(event.newValue);
          setName(user.displayName || `User_${user.id.substring(0, 8)}`);
          setLoggedIn(true);
          setIsGuest(user.id.startsWith('guest_'));
          showMessage("Login successful!");
        } catch (e) {
          console.error("Error parsing fallback configuration", e);
        }
      }
    };

    window.addEventListener('message', handleAuthMessage);
    window.addEventListener('storage', handleStorageChange);


    return () => {
      if (socketRef.current) {
        socketRef.current.removeAllListeners();
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      window.removeEventListener('message', handleAuthMessage);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, [loggedIn, name, addGameMessage, gameId]);

  useEffect(() => {
    if (!gameId || !board || board.length === 0 || !scores || playerNumber === null || playerNumber === 0) {
      return;
    }

    let currentRevealedCount = 0;
    board.forEach(row => {
      row.forEach(tile => {
        if (tile.revealed) currentRevealedCount++;
      });
    });

    let myScoreKey = playerNumber;
    if (gameType === '2v2') {
      myScoreKey = (playerNumber === 1 || playerNumber === 2) ? 1 : 2;
    }

    const currentScore = scores[myScoreKey] || 0;
    const previousScore = prevScoresRef.current[myScoreKey] || 0;
    const previousRevealedCount = prevRevealedCountRef.current;

    if (currentScore > previousScore) {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          const ctx = new AudioContext();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          
          osc.type = "triangle"; 
          const startTime = ctx.currentTime;
          osc.frequency.setValueAtTime(523.25, startTime); 
          osc.frequency.setValueAtTime(783.99, startTime + 0.08); 
          
          gain.gain.setValueAtTime(0.15, startTime);
          gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.3);
          
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(startTime);
          osc.stop(startTime + 0.3);
        }
      } catch (e) {
        console.error("Audio playback failed:", e);
      }
    } else if (currentRevealedCount > previousRevealedCount) {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          const ctx = new AudioContext();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          
          osc.type = "sine"; 
          const startTime = ctx.currentTime;
          
          osc.frequency.setValueAtTime(600, startTime);
          osc.frequency.exponentialRampToValueAtTime(150, startTime + 0.04);
          
          gain.gain.setValueAtTime(0.1, startTime); 
          gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.05); 
          
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(startTime);
          osc.stop(startTime + 0.05);
        }
      } catch (e) {
        console.error("Audio playback failed:", e);
      }
    }

    prevScoresRef.current = { ...scores };
    prevRevealedCountRef.current = currentRevealedCount;
  }, [board, scores, gameId, playerNumber, gameType]);

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
      guestId = `guest_fallback_${Date.now()}`;
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
        
        if (data.user) {
          localStorage.setItem('auth_success_user', JSON.stringify({ user: data.user }));
        }

        setName(data.user.displayName || displayName); 
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
      showMessage(`${player.name} is currently ${player.role === 'player' ? `in a game vs. ${player.opponentName}` : 'observing a game'}.`, true);
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
        showMessage(`Selected ${player.name} as your partner. Now double-click two rivals.`);
      } else if (invitationStage === 2) { 
        const isAlreadySelected = (selectedPartner && selectedPartner.id === player.id) ||
                                  selectedRivals.some(rival => rival.id === player.id);
        if (isAlreadySelected) {
          showMessage(`${player.name} is already selected.`, true);
          return;
        }

        const newRivals = [...selectedRivals, player];
        setSelectedRivals(newRivals);
        if (newRivals.length === 2) {
          showMessage(`Selected rivals: ${newRivals[0].name}, ${newRivals[1].name}. All players selected.`);
          sendTeamInvite(selectedPartner, newRivals);
        } else {
          showMessage(`Selected ${player.name} as a rival. Select one more rival.`);
        }
      }
    }
  };

  const invitePlayer = (targetSocketIds, type) => {
    if (loggedIn && socketRef.current && socketRef.current.connected) {
      socketRef.current.emit("invite-player", { targetSocketIds, gameType: type });
      showMessage("Invitation sent.");
    } else if (!socketRef.current || !socketRef.current.connected) {
        showMessage("Not connected to server. Please wait or refresh.", true);
    }
  };

  const sendTeamInvite = (partner, rivals) => {
    if (!partner || rivals.length !== 2) {
      showMessage("Please select one partner and two rivals.", true);
      return;
    }
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
      setMessage("");
      setSelectedPartner(null);
      setSelectedRivals([]);
      setIs2v2Mode(false);
      setInvitationStage(0);
    } else if (!socketRef.current || !socketRef.current.connected) {
        showMessage("Not connected to server. Cannot respond to invite.", true);
    }
  };

  const handleClick = (x, y) => {
    if (!gameId || gameOver || !isSocketConnected || playerNumber === 0) return;

    if (bombMode) { 
      const MIN_COORD = 2; 
      const MAX_COORD_X = WIDTH - 3; 
      const MAX_COORD_Y = HEIGHT - 3; 

      if (x < MIN_COORD || x > MAX_COORD_X || y < MIN_COORD || y > MAX_COORD_Y) { 
        addGameMessage("Server", "Bomb center must be within the 12x12 area.", true); 
        return;
      }

      let allTilesRevealed = true;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const checkX = x + dx;
          const checkY = y + dy;
          if (checkX >= 0 && checkX < WIDTH && checkY >= 0 && checkY < HEIGHT) { 
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
        addGameMessage("Server", "All tiles in the bomb's blast area are already revealed.", true); 
        return;
      }

      addGameMessage("Server", `Bomb selected at (${x},${y}).`, false); 
      socketRef.current.emit("bomb-center", { gameId, x, y });
      setBombMode(false); 
      setIsBombHighlightActive(false); 
      setHighlightedBombArea([]); 
    } else if (playerNumber === turn && !gameOver) {
      addGameMessage("Server", `Tile clicked at (${x},${y}).`, false); 
      socketRef.current.emit("tile-click", { gameId, x, y });
    } else if (playerNumber !== turn) {
        addGameMessage("Server", "It's not your turn!", true); 
    }
  };

  const handleUseBombClick = () => { 
    if (playerNumber === 0) {
        addGameMessage("Server", "Observers cannot use bombs.", true); 
        return;
    }

    if (!isSocketConnected || !gameId || gameOver || currentBombUsedStatus || !(gameType === '1v1' ? playerNumber === turn : true)) {
      if (currentBombUsedStatus) {
        addGameMessage("Server", "Your team has already used its bomb!", true); 
      } else if (gameOver) {
        addGameMessage("Server", "Game is over, cannot use bomb.", true); 
      } else if (!gameId) {
        addGameMessage("Server", "Not in a game to use bomb.", true); 
      } else if (gameType === '1v1' && playerNumber !== turn) {
        addGameMessage("Server", "It's not your turn to use the bomb!", true); 
      } else if (!isSocketConnected) {
        addGameMessage("Server", "Not connected to server. Please wait or refresh.", true); 
      }
      return;
    }

    if (currentPlayerScore < opponentPlayerOrTeamScore) { 
      socketRef.current.emit("use-bomb", { gameId });
      setIsBombHighlightActive(true); 
      addGameMessage("Server", "Bomb initiated. Select target.", false); 
    } else {
      addGameMessage("Server", "You can only use the bomb when your team is behind in score!", true); 
    }
  };

  const handleCancelBomb = () => { 
    setBombMode(false); 
    setIsBombHighlightActive(false); 
    setHighlightedBombArea([]); 
    addGameMessage("Server", "Bomb selection cancelled.", false); 
  };

  const backToLobby = () => {
    if (gameId && socketRef.current && socketRef.current.connected) {
        socketRef.current.emit("leave-game", { gameId });
    } else if (!isSocketConnected) {
        showMessage("Not connected to server. Cannot leave game.", true); 
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
    setMessage(""); 
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

      localStorage.removeItem('auth_success_user');

      setLoggedIn(false);
      setName("");
      setIsGuest(false);
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
    // CRITICAL FIX: Intercept hidden mines on game completion BEFORE checking tile visibility overrides
    if (gameOver && tile.isMine && !tile.revealed && !tile.ownerTeam) {
      return <div className="unrevealed-mine-cell" />;
    }

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
        showMessage("Attempting to resume game..."); 
    } else if (!isSocketConnected) {
        showMessage("Not connected to server. Please wait or refresh.", true); 
    }
  };

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
        addGameMessage("Server", "Not connected to server. Cannot send message.", true); 
    } else if (!gameId) {
        addGameMessage("Server", "Not in a game to send message.", true); 
    }
  };

  const handle2v2CheckboxChange = (e) => {
    const isChecked = e.target.checked;
    setIs2v2Mode(isChecked);
    if (isChecked) {
      setInvitationStage(1); 
      showMessage("2v2 mode enabled. Double-click your partner, then two rivals.", false);
    } else {
      setInvitationStage(0); 
      setSelectedPartner(null);
      setSelectedRivals([]);
      showMessage("2v2 mode disabled.", false);
    }
  };


  if (!loggedIn) {
    return (
      <div className="lobby">
        {message && <p className="app-message" style={{color: 'red'}}>{message}</p>}
        <h2>Login or Play as Guest</h2>
        <GoogleLogin
          onLogin={(googleName) => {
            console.log("Google Login completed via pop-up callback. State will update.");
          }}
        />
        <FacebookLogin
          onLogin={(facebookName) => {
            console.log("Facebook Login completed via pop-up callback. State will update.");
          }}
        />
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
        {message && !message.includes("Error") && <p className="app-message" style={{color: 'green'}}>{message}</p>}
        {message && message.includes("Error") && <p className="app-message" style={{color: 'red'}}>{message}</p>}

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
                  title={p.gameId ? `${p.name} is ${p.role === 'player' ? `in a game vs. ${p.opponentName}` : 'observing a game'}` : (is2v2Mode ? "Double-click to select" : "Double-click to invite for 1v1")}
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
                {invite.gameType === '2v2' ? (
                  <p>
                    2v2 Invitation from <b>{invite.senderName}</b>.<br/>
                    Invited: {invite.invitedPlayersInfo.map(p => p.name).join(', ')}
                  </p>
                ) : (
                  <p>
                    Invitation from <b>{invite.senderName}</b>
                  </p>
                )}
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
                                {game.gameType === '2v2' ? (
                                    <>
                                        Team 1 ({game.player1Name}, {game.player2Name}) vs Team 2 ({game.player3Name}, {game.player4Name})
                                        - Score: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="red" width="18px" height="18px" style={{verticalAlign: 'middle', marginLeft: '5px'}}>
                                          <path d="M0 0h24v24H0z" fill="none"/>
                                          <path d="M14.4 6L14 4H5V20h2v-7h5.6l.4 2h7V6z"/>
                                        </svg> {game.scores?.[1] || 0} | {game.scores?.[2] || 0} 
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="blue" width="18px" height="18px" style={{verticalAlign: 'middle', marginLeft: '5px'}}>
                                          <path d="M0 0h24v24H0z" fill="none"/>
                                          <path d="M14.4 6L14 4H5V20h2v-7h5.6l.4 2h7V6z"/>
                                        </svg>
                                    </>
                                ) : (
                                    <>
                                        {game.playerNumber === 1 ? `${name} vs ${game.opponentName}` : `${game.opponentName} vs ${name}`}
                                        - Score: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="red" width="18px" height="18px" style={{verticalAlign: 'middle', marginLeft: '5px'}}>
                                          <path d="M0 0h24v24H0z" fill="none"/>
                                          <path d="M14.4 6L14 4H5V20h2v-7h5.6l.4 2h7V6z"/>
                                        </svg> {game.scores?.[1] || 0} | {game.scores?.[2] || 0} 
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="blue" width="18px" height="18px" style={{verticalAlign: 'middle', marginLeft: '5px'}}>
                                          <path d="M0 0h24v24H0z" fill="none"/>
                                          <path d="M14.4 6L14 4H5V20h2v-7h5.6l.4 2h7V6z"/>
                                        </svg>
                                    </>
                                )}
                                - Last updated: {game.lastUpdated}
                                 <button onClick={() => resumeGame(game.gameId)} className="bomb-button">Resume</button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="observable-games-section">
                <h3>Observable Games</h3>
                {observableGames.length === 0 ? (
                    <p>No games currently available for observation.</p>
                ) : (
                    <ul className="observable-game-list">
                        {observableGames.map(game => (
                            <li key={game.gameId} className="observable-game-item">
                                {game.gameType === '2v2' ? (
                                    <>
                                        Team 1 ({game.player1Name}, {game.player2Name}) vs Team 2 ({game.player3Name}, {game.player4Name})
                                    </>
                                ) : (
                                    <>
                                        {game.player1Name} vs. {game.player2Name}
                                    </>
                                )}
                                - Score: {game.scores?.[1] || 0} : {game.scores?.[2] || 0} - Active participants: {game.activeParticipants}
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
                            {playerNumber !== 0 && ( 
                              !currentBombUsedStatus && 
                              currentPlayerScore < opponentPlayerOrTeamScore && 
                              !gameOver && (
                                <button className="bomb-button" onClick={handleUseBombClick} disabled={!isSocketConnected}>
                                    Use Bomb
                                </button>
                              ))}
                            {playerNumber !== 0 && bombMode && (
                              <button className="bomb-button" onClick={handleCancelBomb} disabled={!isSocketConnected}>
                                  Cancel Bomb
                              </button>
                            )}
                            <button className="bomb-button" onClick={backToLobby} disabled={!isSocketConnected}>
                                Back to Lobby
                            </button>
                            {gameOver && playerNumber !== 0 && ( 
                                <button className="bomb-button" onClick={() => socketRef.current.emit("restart-game", { gameId })} disabled={!isSocketConnected}>
                                    Restart Game
                                </button>
                            )}
                        </div>
                        <div className="game-info">
                            <h2>
                                {playerNumber === 0 ? "You are Observing" : `You are Player ${playerNumber}`}
                                {gameType === '1v1' ? ` (vs. ${opponentName})` : ` (Team ${ (playerNumber === 1 || playerNumber === 2) ? 1 : 2 })`}
                            </h2>
                            {gameType === '2v2' ? (
                                <div className="score-display">
                                    <p style={{ color: (turn === 1 || turn === 2) ? 'green' : 'inherit' }}>
                                        Team 1 ({gamePlayerNames[1]}, {gamePlayerNames[2]}): {scores[1]} <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="red" width="18px" height="18px" style={{verticalAlign: 'middle', marginLeft: '5px'}}>
                                          <path d="M0 0h24v24H0z" fill="none"/>
                                          <path d="M14.4 6L14 4H5V20h2v-7h5.6l.4 2h7V6z"/>
                                        </svg>
                                    </p>
                                    <p style={{ color: (turn === 3 || turn === 4) ? 'green' : 'inherit' }}>
                                        Team 2 ({gamePlayerNames[3]}, {gamePlayerNames[4]}): {scores[2]} 
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="blue" width="18px" height="18px" style={{verticalAlign: 'middle', marginLeft: '5px'}}>
                                          <path d="M0 0h24v24H0z" fill="none"/>
                                          <path d="M14.4 6L14 4H5V20h2v-7h5.6l.4 2h7V6z"/>
                                        </svg>
                                    </p>
                                </div>
                            ) : (
                                <div className="score-display">
                                    <p style={{ color: turn === 1 ? 'green' : 'inherit' }}>
                                    {gamePlayerNames[1]}: {scores[1]} <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="red" width="18px" height="18px" style={{verticalAlign: 'middle', marginLeft: '5px'}}>
                                          <path d="M0 0h24v24H0z" fill="none"/>
                                          <path d="M14.4 6L14 4H5V20h2v-7h5.6l.4 2h7V6z"/>
                                        </svg>
                                    </p>
                                    <p style={{ color: turn === 2 ? 'green' : 'inherit' }}>
                                    {gamePlayerNames[2]}: {scores[2]} 
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="blue" width="18px" height="18px" style={{verticalAlign: 'middle', marginLeft: '5px'}}>
                                      <path d="M0 0h24v24H0z" fill="none"/>
                                      <path d="M14.4 6L14 4H5V20h2v-7h5.6l.4 2h7V6z"/>
                                    </svg>
                                    </p>
                                </div>
                            )}

                            <p className="mine-count-display">
                                Unrevealed Mines: <span style={{ color: 'red', fontWeight: 'bold' }}>{unrevealedMines}</span>
                            </p>
                            {gameOver && playerNumber === 0 && ( 
                                <p style={{ fontWeight: 'bold', color: 'green' }}>Game Over!</p>
                            )}
                        </div>
                    </div> 

                    <div className="game-board-area">
                        <div
                            className="grid"
                            style={{
                              gridTemplateColumns: `repeat(${board[0]?.length || 0}, 40px)`,
                            }}
                            onMouseMove={playerNumber !== 0 && bombMode ? handleMouseMoveOnGrid : null}
                            onMouseLeave={playerNumber !== 0 && bombMode ? handleMouseLeaveGrid : null}
                        >
                            {board.flatMap((row, y) =>
                              row.map((tile, x) => {
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
                                    } ${
                                      gameType === '2v2' && lastClickedTile[3]?.x === x && lastClickedTile[3]?.y === y ? "last-clicked-p3" : ""
                                    } ${
                                      gameType === '2v2' && lastClickedTile[4]?.x === x && lastClickedTile[4]?.y === y ? "last-clicked-p4" : ""
                                    } ${isHighlighted ? "highlighted-bomb-area" : ""
                                    }`}
                                    onClick={playerNumber !== 0 ? () => handleClick(x, y) : null} 
                                  >
                                    {renderTile(tile)}
                                  </div>
                                );
                              })
                            )}
                        </div>
                    </div> 
                    
                    <div className="game-sidebar right-sidebar">
                    </div>

                    <div className="game-bottom-panel observer-list-panel">
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
                    </div>

                    <div className="game-bottom-panel game-chat-panel">
                        <div className="game-chat-container chat-container">
                            <h3>Game Chat</h3>
                            <div className="messages-display">
                                {gameMessages.map((msg, index) => (
                                    <div key={index} className={`message ${msg.sender === name ? 'my-message' : 'other-message'} ${msg.isError ? 'error-message' : ''}`}>
                                        <strong>{msg.sender}:</strong> {msg.text} <span className="timestamp">({msg.timestamp})</span>
                                    </div>
                                ))}
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

                    <div className="game-bottom-panel server-chat-panel">
                        <div className="server-chat-container chat-container"> 
                            <h3>Server Messages</h3>
                            <div className="messages-display">
                                {serverMessages.map((msg, index) => (
                                    <div key={index} className={`message ${msg.isError ? 'error-message' : 'server-message'}`}>
                                        <strong>{msg.sender}:</strong> {msg.text} <span className="timestamp">({msg.timestamp})</span>
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
