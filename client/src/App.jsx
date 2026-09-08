import React, { useEffect, useState, useRef, useCallback } from "react";
import io from "socket.io-client";

const bufferToHex = (buffer) => {
    return Array.prototype.map.call(new Uint8Array(buffer), x => ('00' + x.toString(16)).slice(-2)).join('');
};

const generate5DigitGuestId = async (message) => {
    try {
        const msgBuffer = new TextEncoder().encode(message); 
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer); 
        const fullHashHex = bufferToHex(hashBuffer); 

        const hashPortion = fullHashHex.substring(0, 8); 
        const decimalValue = parseInt(hashPortion, 16); 

        const fiveDigitNumber = decimalValue % 100000;
        return String(fiveDigitNumber).padStart(5, '0');

    } catch (err) {
        console.error("Error generating 5-digit guest ID:", err);
        throw new Error("Failed to generate 5-digit guest ID from UUID.");
    }
};

const getDeviceUuid = () => {
    let deviceUuid = localStorage.getItem('guestDeviceId');
    if (!deviceUuid) {
        deviceUuid = crypto.randomUUID(); 
        localStorage.setItem('guestDeviceId', deviceUuid); 
    }
    return deviceUuid;
};

function AuthCallback() {
  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl max-w-md w-full text-center space-y-4">
        <h2 className="text-xl font-bold text-emerald-400">Authenticating...</h2>
        <p className="text-sm text-slate-400">Please wait while we complete your login.</p>
      </div>
    </div>
  );
}

function App() {
  const isAuthCallback = window.location.pathname === '/auth/callback';

  if (isAuthCallback) {
    return <AuthCallback />;
  }

  const [name, setName] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);
  const [isGuest, setIsGuest] = useState(false); 
  const [playersList, setPlayersList] = useState([]);
  const [message, setMessage] = useState(""); 

  const socketRef = useRef(null); 
  const [isSocketConnected, setIsSocketConnected] = useState(false); 

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
  const [gamePlayerNames, setGamePlayerNames] = useState({ 1: '', 2: '', 3: '', 4: '' }); 
  const [gameType, setGameType] = useState('1v1'); 
  const [is2v2Mode, setIs2v2Mode] = useState(false); 
  const [selectedPartner, setSelectedPartner] = useState(null); 
  const [selectedRivals, setSelectedRivals] = useState([]); 
  const [invitationStage, setInvitationStage] = useState(0); 

  const [isBombHighlightActive, setIsBombHighlightActive] = useState(false); 
  const [highlightedBombArea, setHighlightedBombArea] = useState([]); 

  const WIDTH = 16;
  const HEIGHT = 16;

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
    if (isError) console.error(msg);
    setTimeout(() => setMessage(""), 5000);
  };

  const clientRevealRecursive = (boardCopy, startX, startY) => {
    const height = boardCopy.length;
    const width = boardCopy[0].length;
    const startTile = boardCopy[startY][startX];
    if (!startTile || startTile.revealed) return;

    startTile.revealed = true;
    startTile.owner = playerNumber;
    startTile.ownerTeam = (gameType === '2v2' ? ((playerNumber === 1 || playerNumber === 2) ? 1 : 2) : playerNumber);

    if (startTile.isMine) return;

    const queue = [{ x: startX, y: startY }];
    const visited = new Set();

    while (queue.length > 0) {
      const { x, y } = queue.shift();
      const key = `${x},${y}`;
      if (visited.has(key)) continue;
      visited.add(key);

      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const tile = boardCopy[y][x];

      if (tile.revealed || tile.isMine) continue;

      tile.revealed = true;
      tile.owner = playerNumber;
      tile.ownerTeam = (gameType === '2v2' ? ((playerNumber === 1 || playerNumber === 2) ? 1 : 2) : playerNumber);

      if (tile.adjacentMines === 0) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx !== 0 || dy !== 0) {
              queue.push({ x: x + dx, y: y + dy });
            }
          }
        }
      }
    }
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

          if (!socketRef.current) {
            socketRef.current = io("https://minesweeper-flags-backend.onrender.com", {
              withCredentials: true,
              query: {
                fallbackUserId: data.user.id,
                fallbackName: currentUserName
              }
            });

            socketRef.current.on('connect', () => {
                setIsSocketConnected(true);
                socketRef.current.emit("join-lobby", currentUserName);
            });

            socketRef.current.on('disconnect', () => {
                setIsSocketConnected(false);
                showMessage("Disconnected from server.", true);
                addGameMessage("Server", "Disconnected from server.", true);
            });

            socketRef.current.on('connect_error', (error) => {
                showMessage(`Connection error: ${error.message}`, true);
                setIsSocketConnected(false);
            });

            socketRef.current.on('authenticated-socket-ready', () => {
                socketRef.current.emit("join-lobby", currentUserName);
            });

            socketRef.current.on("join-error", (msg) => {
              showMessage(msg, true);
              if (gameId) addGameMessage("Server", msg, true);
            });

            socketRef.current.on("lobby-joined", (userName) => {
              setLoggedIn(true);
              setName(userName);
              socketRef.current.emit("request-unfinished-games");
              socketRef.current.emit("request-observable-games");
            });

            socketRef.current.on("players-list", (players) => {
              setPlayersList(players);
            });

            socketRef.current.on("game-invite", (inviteData) => {
              setInvite(inviteData);
              showMessage(`Invitation from ${inviteData.senderName}!`);
            });

            socketRef.current.on("invite-rejected", ({ fromName }) => {
              showMessage(`${fromName} rejected your invitation.`, true);
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
              addGameMessage("Server", `Game started!`, false);
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

            socketRef.current.on("initial-lobby-messages", (messages) => {
              setLobbyMessages(messages);
            });

            socketRef.current.on("receive-lobby-message", (message) => {
              setLobbyMessages((prevMessages) => [...prevMessages, message]);
            });

            socketRef.current.on("receive-game-message", (message) => {
              setGameMessages((prevMessages) => [...prevMessages, message]);
            });
          }
        }
      } catch (err) {
        setLoggedIn(false);
      }
    };

    checkAuthStatusAndConnectSocket();
  }, [loggedIn, name, addGameMessage, gameId]);

  useEffect(() => {
    if (board && board.length > 0) {
      let totalMines = 0;
      let revealedMines = 0;
      board.forEach(row => {
        row.forEach(tile => {
          if (tile.isMine) {
            totalMines++;
            if (tile.revealed) revealedMines++;
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
      }
    } catch (error) {
      setLoggedIn(false);
    }
  };

  const handlePlayerClick = (player) => {
    if (player.id === socketRef.current.id) {
      showMessage("You cannot invite yourself.", true);
      return;
    }
    if (player.gameId) {
      showMessage(`${player.name} is currently in a game.`, true);
      return;
    }
    if (!is2v2Mode) { 
      invitePlayer([player.id], '1v1'); 
    } else { 
      if (invitationStage === 1) { 
        setSelectedPartner(player);
        setInvitationStage(2);
        showMessage(`Selected ${player.name} as partner. Select two rivals.`);
      } else if (invitationStage === 2) { 
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
    invitePlayer([partner.id, rivals[0].id, rivals[1].id], '2v2');
    setSelectedPartner(null);
    setSelectedRivals([]);
    setIs2v2Mode(false); 
    setInvitationStage(0);
  };

  const respondInvite = (accept) => {
    if (invite && socketRef.current && socketRef.current.connected) {
      socketRef.current.emit("respond-invite", { inviteId: invite.inviteId, accept });
      setInvite(null);
    }
  };

  const handleClick = (x, y) => {
    if (!gameId || gameOver || !isSocketConnected || playerNumber === 0) return;

    if (bombMode) { 
      socketRef.current.emit("bomb-center", { gameId, x, y });
      setBombMode(false); 
      setIsBombHighlightActive(false); 
      setHighlightedBombArea([]); 
    } else if (playerNumber === turn && !gameOver) {
      setBoard(prevBoard => {
        const newBoard = prevBoard.map(row => row.map(tile => ({ ...tile })));
        if (newBoard[y] && newBoard[y][x]) {
          clientRevealRecursive(newBoard, x, y);
        }
        return newBoard;
      });
      setLastClickedTile(prev => ({ ...prev, [playerNumber]: { x, y } }));
      socketRef.current.emit("tile-click", { gameId, x, y });
    }
  };

  const handleUseBombClick = () => { 
    if (playerNumber === 0) return;
    socketRef.current.emit("use-bomb", { gameId });
    setIsBombHighlightActive(true); 
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
    setGameOver(false);
  };

  const logout = async () => {
    try {
      await fetch("https://minesweeper-flags-backend.onrender.com/logout", { credentials: "include" });
      if (socketRef.current) socketRef.current.disconnect();
      localStorage.removeItem('auth_success_user');
      setLoggedIn(false);
      setName("");
      setGameId(null);
    } catch (err) {
      console.error("Logout failed", err);
    }
  };

  const handleMouseMoveOnGrid = useCallback((event) => {
    if (!isBombHighlightActive || !board.length) return;
    const { x, y } = getTileCoordinates(event);
    setHighlightedBombArea(calculateBombArea(x, y));
  }, [isBombHighlightActive, board.length, calculateBombArea]); 

  const handleMouseLeaveGrid = useCallback(() => {
    if (isBombHighlightActive) setHighlightedBombArea([]); 
  }, [isBombHighlightActive]);

  const renderTile = (tile) => {
    if (gameOver && tile.isMine && !tile.revealed && !tile.ownerTeam) return "";
    if (!tile.revealed) return "";
    
    if (tile.isMine && tile.ownerTeam) {
      return (
        <div className="tile hidden"> 
          {tile.ownerTeam === 1 && (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#f87171" width="22px" height="22px">
              <path d="M0 0h24v24H0z" fill="none"/>
              <path d="M14.4 6L14 4H5V20h2v-7h5.6l.4 2h7V6z"/>
            </svg>
          )}
          {tile.ownerTeam === 2 && (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#60a5fa" width="22px" height="22px">
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
    if (gameIdToResume && socketRef.current) socketRef.current.emit("resume-game", { gameId: gameIdToResume });
  };

  const observeGame = (gameIdToObserve) => {
    if (gameIdToObserve && socketRef.current) socketRef.current.emit("observe-game", { gameId: gameIdToObserve });
  };

  const sendGameMessage = (e) => {
    e.preventDefault();
    if (socketRef.current && gameId && gameMessageInput.trim()) {
      socketRef.current.emit("send-game-message", { gameId, message: gameMessageInput });
      setGameMessageInput("");
    }
  };

  if (!loggedIn) {
    return (
      <div className="lobby min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6">
        {message && <div className="mb-4 p-3 bg-slate-900 border border-slate-800 text-rose-400 rounded-xl text-center font-medium shadow">{message}</div>}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl max-w-md w-full text-center">
          <div className="mb-6 flex justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-20 h-20 text-emerald-400 drop-shadow-[0_0_12px_rgba(16,185,129,0.5)]">
              <path d="M14.4 6L14 4H5V20h2v-7h5.6l.4 2h7V6z"/>
            </svg>
          </div>
          <h2 className="text-2xl font-bold tracking-wide text-emerald-400 mb-6">Minesweeper Flags</h2>
          <div className="space-y-4">
            <button className="w-full py-3 bg-blue-600 hover:bg-blue-500 font-semibold rounded-xl text-white shadow-lg transition duration-200" onClick={() => window.location.href='https://minesweeper-flags-backend.onrender.com/auth/google'}>
              Sign in with Google
            </button>
            <button className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 font-semibold rounded-xl text-white shadow-lg transition duration-200" onClick={() => window.location.href='https://minesweeper-flags-backend.onrender.com/auth/facebook'}>
              Sign in with Facebook
            </button>
            <button className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 font-semibold rounded-xl text-white shadow-lg transition duration-200" onClick={loginAsGuest}>
              Play as Guest
            </button>
          </div>
        </div>
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
    <div className="lobby min-h-screen bg-slate-950 text-slate-100 p-4">
        {message && <div className="mb-4 p-3 bg-slate-900 border border-slate-800 text-emerald-400 rounded-xl text-center font-medium shadow">{message}</div>}

        {!gameId && ( 
            <div className="max-w-4xl mx-auto space-y-6">
              <div className="flex justify-between items-center bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow-lg">
                <div>
                  <h2 className="text-xl font-bold text-emerald-400">Online Lobby</h2>
                  <p className="text-sm text-slate-400">Logged in as: <span className="text-white font-medium">{name} {isGuest && "(Guest)"}</span></p>
                </div>
                <button onClick={logout} className="px-4 py-2 bg-rose-600 hover:bg-rose-500 rounded-xl font-semibold text-sm transition shadow">Logout</button>
              </div>

              <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow-lg space-y-4">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={is2v2Mode}
                      onChange={(e) => {
                        setIs2v2Mode(e.target.checked);
                        setInvitationStage(e.target.checked ? 1 : 0);
                      }}
                      className="w-4 h-4 accent-emerald-500 rounded"
                    />
                    <span className="font-semibold text-slate-200">Enable 2v2 Match Mode</span>
                  </label>
                </div>
                {is2v2Mode && (
                  <p className="text-xs text-emerald-400 font-medium bg-emerald-950/40 p-2.5 rounded-lg border border-emerald-900">
                    {invitationStage === 1 ? "Step 1: Double-click a player to select your partner." : "Step 2: Double-click two players to select rivals."}
                  </p>
                )}
              </div>

              <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow-lg">
                <h3 className="text-lg font-bold text-slate-200 mb-3">Online Players ({playersList.length})</h3>
                <ul className="space-y-2">
                  {playersList.map((p) => (
                    <li
                      key={p.id}
                      className={`flex items-center justify-between p-3 rounded-xl border transition ${
                        p.id === socketRef.current?.id ? 'bg-slate-800/80 border-slate-700' : 'bg-slate-950/40 border-slate-800/60 hover:border-slate-700'
                      }`}
                      onDoubleClick={() => handlePlayerClick(p)}
                    >
                      <span className="font-medium text-slate-200">{p.name} {p.id === socketRef.current?.id && '(You)'}</span>
                      {p.gameId ? (
                        <span className="text-xs px-2.5 py-1 bg-amber-500/20 text-amber-300 rounded-full font-medium">In Game</span>
                      ) : (
                        p.id !== socketRef.current?.id && (
                          <button 
                            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold rounded-lg text-white transition"
                            onClick={() => handlePlayerClick(p)}
                          >
                            {is2v2Mode ? "Select" : "Challenge"}
                          </button>
                        )
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              {invite && (
                <div className="bg-emerald-950/80 border border-emerald-500/40 p-5 rounded-2xl shadow-2xl flex items-center justify-between">
                  <div>
                    <h4 className="font-bold text-emerald-300">Match Invitation!</h4>
                    <p className="text-sm text-emerald-100/80">From {invite.senderName} ({invite.gameType} battle)</p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => respondInvite(true)} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 font-semibold rounded-xl text-white text-sm shadow">Accept</button>
                    <button onClick={() => respondInvite(false)} className="px-4 py-2 bg-rose-600 hover:bg-rose-500 font-semibold rounded-xl text-white text-sm shadow">Decline</button>
                  </div>
                </div>
              )}

              {unfinishedGames.length > 0 && (
                <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow-lg">
                  <h3 className="text-lg font-bold text-slate-200 mb-3">Unfinished Matches</h3>
                  <div className="space-y-2">
                    {unfinishedGames.map(game => (
                      <div key={game.gameId} className="flex items-center justify-between p-3 bg-slate-950/40 border border-slate-800 rounded-xl">
                        <span className="text-sm font-medium">Match vs {game.opponentName}</span>
                        <button onClick={() => resumeGame(game.gameId)} className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-xs font-semibold rounded-lg text-white transition">Resume</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {observableGames.length > 0 && (
                <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow-lg">
                  <h3 className="text-lg font-bold text-slate-200 mb-3">Observable Matches</h3>
                  <div className="space-y-2">
                    {observableGames.map(game => (
                      <div key={game.gameId} className="flex items-center justify-between p-3 bg-slate-950/40 border border-slate-800 rounded-xl">
                        <span className="text-sm font-medium">Match #{game.gameId.substring(0, 6)}</span>
                        <button onClick={() => observeGame(game.gameId)} className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold rounded-lg text-white transition">Observe</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
        )}

        {gameId && (
            <div className="max-w-7xl mx-auto">
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-6"> 
                    
                    {/* SIMPLIFIED, HIGH-CONTRAST SCORECARD PANEL */}
                    <div className="lg:col-span-1 bg-slate-900 border border-slate-700/60 rounded-2xl p-5 shadow-2xl flex flex-col justify-between space-y-6">
                        <div>
                          <div className="flex items-center justify-between mb-5">
                            <h1 className="text-lg font-bold text-white tracking-wide">Minesweeper</h1>
                            <button onClick={backToLobby} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 rounded-xl border border-slate-600 transition">Lobby</button>
                          </div>

                          <div className="space-y-3">
                            <div className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-2">Players & Score</div>
                            
                            {gameType === '2v2' ? (
                              <>
                                <div className={`p-4 rounded-xl border transition-all ${
                                  turn === 1 || turn === 2 
                                    ? 'bg-emerald-950/80 border-emerald-500 shadow-lg ring-1 ring-emerald-500' 
                                    : 'bg-slate-950/60 border-slate-800'
                                }`}>
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="text-sm font-bold text-white">Team 1 ({gamePlayerNames[1]} & {gamePlayerNames[2]})</span>
                                    {(turn === 1 || turn === 2) && (
                                      <span className="text-[10px] bg-emerald-500 text-slate-950 font-black px-2 py-0.5 rounded uppercase tracking-wider animate-pulse">
                                        Turn
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center justify-between text-xs text-slate-300">
                                    <span>Team Flags:</span>
                                    <span className="text-lg font-black text-rose-400">{scores[1] || 0}</span>
                                  </div>
                                </div>

                                <div className={`p-4 rounded-xl border transition-all ${
                                  turn === 3 || turn === 4 
                                    ? 'bg-emerald-950/80 border-emerald-500 shadow-lg ring-1 ring-emerald-500' 
                                    : 'bg-slate-950/60 border-slate-800'
                                }`}>
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="text-sm font-bold text-white">Team 2 ({gamePlayerNames[3]} & {gamePlayerNames[4]})</span>
                                    {(turn === 3 || turn === 4) && (
                                      <span className="text-[10px] bg-emerald-500 text-slate-950 font-black px-2 py-0.5 rounded uppercase tracking-wider animate-pulse">
                                        Turn
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center justify-between text-xs text-slate-300">
                                    <span>Team Flags:</span>
                                    <span className="text-lg font-black text-sky-400">{scores[2] || 0}</span>
                                  </div>
                                </div>
                              </>
                            ) : (
                              <>
                                <div className={`p-4 rounded-xl border transition-all ${
                                  turn === 1 
                                    ? 'bg-emerald-950/80 border-emerald-500 shadow-lg ring-1 ring-emerald-500' 
                                    : 'bg-slate-950/60 border-slate-800'
                                }`}>
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="text-sm font-bold text-white truncate max-w-[120px]">{gamePlayerNames[1] || "Player 1"}</span>
                                    {turn === 1 && (
                                      <span className="text-[10px] bg-emerald-500 text-slate-950 font-black px-2 py-0.5 rounded uppercase tracking-wider animate-pulse">
                                        Turn
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center justify-between text-xs text-slate-300">
                                    <span>Flags:</span>
                                    <span className="text-lg font-black text-rose-400">{scores[1] || 0}</span>
                                  </div>
                                </div>

                                <div className={`p-4 rounded-xl border transition-all ${
                                  turn === 2 
                                    ? 'bg-emerald-950/80 border-emerald-500 shadow-lg ring-1 ring-emerald-500' 
                                    : 'bg-slate-950/60 border-slate-800'
                                }`}>
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="text-sm font-bold text-white truncate max-w-[120px]">{gamePlayerNames[2] || "Player 2"}</span>
                                    {turn === 2 && (
                                      <span className="text-[10px] bg-emerald-500 text-slate-950 font-black px-2 py-0.5 rounded uppercase tracking-wider animate-pulse">
                                        Turn
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center justify-between text-xs text-slate-300">
                                    <span>Flags:</span>
                                    <span className="text-lg font-black text-sky-400">{scores[2] || 0}</span>
                                  </div>
                                </div>
                              </>
                            )}
                          </div>

                          <div className="mt-5 p-3.5 bg-slate-950 rounded-xl border border-slate-800 flex items-center justify-between">
                              <span className="text-xs font-semibold text-slate-400">Unrevealed Mines</span>
                              <span className="text-xl font-bold text-rose-400">{unrevealedMines}</span>
                          </div>
                        </div>

                        {/* Action Buttons */}
                        <div className="space-y-2 pt-3 border-t border-slate-800">
                            {playerNumber !== 0 && !currentBombUsedStatus && currentPlayerScore < opponentPlayerOrTeamScore && !gameOver && (
                              <button className="w-full py-3 bg-amber-600 hover:bg-amber-500 font-bold text-xs uppercase tracking-wider rounded-xl text-white shadow transition duration-200" onClick={handleUseBombClick}>
                                💣 Use Bomb Ability
                              </button>
                            )}
                            {playerNumber !== 0 && bombMode && (
                              <button className="w-full py-3 bg-rose-600 hover:bg-rose-500 font-bold text-xs uppercase tracking-wider rounded-xl text-white shadow transition duration-200 animate-pulse" onClick={handleCancelBomb}>
                                Cancel Bomb Mode
                              </button>
                            )}
                        </div>
                    </div> 

                    {/* Central Game Board Area */}
                    <div className="lg:col-span-3 flex flex-col items-center justify-center bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 shadow-2xl">
                        <div
                            className="grid gap-1 p-3 bg-slate-950 rounded-xl border border-slate-800 shadow-inner overflow-auto max-w-full"
                            style={{
                              gridTemplateColumns: `repeat(${board[0]?.length || 0}, minmax(36px, 40px))`,
                            }}
                            onMouseMove={playerNumber !== 0 && bombMode ? handleMouseMoveOnGrid : null}
                            onMouseLeave={playerNumber !== 0 && bombMode ? handleMouseLeaveGrid : null}
                        >
                            {board.flatMap((row, y) =>
                              row.map((tile, x) => {
                                const isHighlighted = highlightedBombArea.some(coord => coord.x === x && coord.y === y);
                                const isUnrevealedEndGameMine = gameOver && tile.isMine && !tile.revealed && !tile.ownerTeam;

                                return (
                                  <div
                                    key={`${x}-${y}`}
                                    className={`tile w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center rounded-lg font-bold text-sm cursor-pointer transition-all duration-150 ${
                                      isUnrevealedEndGameMine ? "bg-rose-950/80 border border-rose-600/50" :
                                      tile.revealed ? "bg-slate-800 text-white shadow-sm" : "bg-slate-700/80 hover:bg-slate-600 shadow border border-slate-600/40"
                                    } ${tile.isMine && tile.revealed ? "bg-rose-900/60" : ""} ${
                                      isHighlighted ? "ring-2 ring-amber-400 bg-amber-500/20" : ""
                                    }`}
                                    onClick={playerNumber !== 0 ? () => handleClick(x, y) : null} 
                                  >
                                    {renderTile(tile)}
                                  </div>
                                );
                              })
                            )}
                        </div>

                        {/* Game Chat & Activity Panel */}
                        <div className="w-full mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 flex flex-col h-48">
                                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Game Chat</h3>
                                <div className="flex-1 overflow-y-auto space-y-2 pr-2 text-xs">
                                    {gameMessages.map((msg, index) => (
                                        <div key={index} className="text-slate-300">
                                            <span className="font-bold text-emerald-400">{msg.sender}:</span> {msg.text}
                                        </div>
                                    ))}
                                </div>
                                <form onSubmit={sendGameMessage} className="mt-2 flex gap-2">
                                    <input
                                      type="text"
                                      value={gameMessageInput}
                                      onChange={(e) => setGameMessageInput(e.target.value)}
                                      placeholder="Type message..."
                                      className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500"
                                    />
                                    <button type="submit" className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold rounded-lg text-white">Send</button>
                                </form>
                            </div>

                            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 flex flex-col h-48">
                                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Server Feed</h3>
                                <div className="flex-1 overflow-y-auto space-y-2 pr-2 text-xs">
                                    {serverMessages.map((msg, index) => (
                                        <div key={index} className="text-slate-400">
                                            <span className="font-bold text-amber-400">{msg.sender}:</span> {msg.text}
                                        </div>
                                    ))}
                                </div>
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
