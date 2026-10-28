const express = require("express");
const fetch = require('node-fetch');
const router = express.Router();
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const passport = require("passport");
const session = require("express-session");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const FacebookStrategy = require("passport-facebook").Strategy;
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");

const { getBestAIMove } = require('./ai.js');

// --- Firebase Admin SDK Imports ---
const admin = require('firebase-admin');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { FirestoreStore } = require('@google-cloud/connect-firestore');

const app = express();
app.use(express.json());
app.set('trust proxy', 1);
const server = http.createServer(app);

// New global data structures for robust player tracking across reconnections
const userSocketMap = {}; 
const userGameMap = {};   

// Configure CORS for Express
app.use(
  cors({
    origin: [
      "https://minesweeper-flags-frontend.onrender.com",
      "https://localhost",
      "http://localhost",
      "capacitor://localhost"
    ],
    credentials: true,
  })
);

router.get('/api/get-client-ip', async (req, res) => {
    try {
        let clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

        if (Array.isArray(clientIp)) {
            clientIp = clientIp[0];
        }

        if (clientIp && clientIp.includes(':') && !clientIp.startsWith('::')) {
            clientIp = clientIp.split(':').slice(0, -1).join(':');
        }
        if (clientIp === '::1' || clientIp === '127.0.0.1' || clientIp === '::ffff:127.0.0.1') {
            const response = await fetch('https://api.ipify.org?format=json');
            if (!response.ok) {
                throw new Error(`Failed to fetch public IP from ipify.org: ${response.status}`);
            }
            const data = await response.json();
            clientIp = data.ip;
        }

        if (!clientIp || clientIp.includes('::ffff:')) {
             const response = await fetch('https://api.ipify.org?format=json');
             if (!response.ok) {
                 throw new Error(`Failed to fetch public IP from ipify.org: ${response.status}`);
             }
             const data = await response.json();
             clientIp = data.ip;
        }

        if (!clientIp) {
            throw new Error("Could not determine client IP.");
        }

        res.json({ ip: clientIp });

    } catch (error) {
        console.error('Backend IP fetch error:', error);
        res.status(500).json({ error: 'Failed to retrieve client IP address', details: error.message });
    }
});

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const FACEBOOK_CLIENT_ID = process.env.FACEBOOK_CLIENT_ID;
const FACEBOOK_CLIENT_SECRET = process.env.FACEBOOK_CLIENT_SECRET;

let db;
let sessionMiddleware;
let io;

const WIDTH = 16;
const HEIGHT = 16;
const MINES = 51;
const APP_ID = process.env.RENDER_APP_ID || "minesweeper-flags-default-app";
const GAMES_COLLECTION_PATH = `artifacts/${APP_ID}/public/data/minesweeperGames`;

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  console.log(`[Firebase Init] Service Account Project ID: ${serviceAccount.project_id}`);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = getFirestore();

  sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || "super-secret-fallback-key-for-dev",
    resave: false,
    saveUninitialized: false,
    store: new FirestoreStore({
      dataset: db,
      kind: 'express-sessions',
    }),
    cookie: {
      sameSite: "none",
      secure: true,
      maxAge: 1000 * 60 * 60 * 24,
      proxy: true,
    },
  });

  app.use(sessionMiddleware);
  app.use(passport.initialize());
  app.use(passport.session());

  console.log("Firebase Admin SDK and FirestoreStore initialized.");

  io = new Server(server, {
    cors: {
      origin: [
        "https://minesweeper-flags-frontend.onrender.com",
        "https://localhost",
        "capacitor://localhost",
        "http://localhost"
      ],
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
  });

  io.use((socket, next) => {
    const session = socket.request.session;

    if (session && session.passport && session.passport.user) {
      if (typeof session.passport.user === 'object') {
        socket.request.user = session.passport.user;
      }
      return next();
    }

    if (session && session.user) {
      socket.request.user = session.user;
      return next();
    }

    const { fallbackUserId, fallbackName } = socket.handshake.query;

    if (fallbackUserId && fallbackName) {
      socket.request.user = {
        id: fallbackUserId,
        displayName: fallbackName,
        name: fallbackName
      };

      if (!socket.request.session) socket.request.session = {};
      if (!socket.request.session.passport) socket.request.session.passport = {};
      socket.request.session.passport.user = fallbackUserId;

      return next();
    }

    return next(new Error("Authentication required"));
  });

} catch (error) {
  console.error("Failed to initialize Firebase Admin SDK or FirestoreStore.", error);
  process.exit(1);
}

passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/google/callback"
}, (accessToken, refreshToken, profile, done) => {
  done(null, { id: profile.id, displayName: profile.displayName });
}));

passport.use(new FacebookStrategy({
  clientID: FACEBOOK_CLIENT_ID,
  clientSecret: FACEBOOK_CLIENT_SECRET,
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/facebook/callback",
  profileFields: ['id', 'displayName', 'photos', 'email']
},
function(accessToken, refreshToken, profile, cb) {
  cb(null, { id: profile.id, displayName: profile.displayName });
}));

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

app.get("/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

app.get("/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com/login-failed",
  }),
  (req, res) => {
    req.session.save((err) => {
      if (err) {
        return res.redirect(`https://minesweeper-flags-frontend.onrender.com/auth/callback-failure?message=${encodeURIComponent(err.message || 'Authentication failed due to session error.')}`);
      }
      const userData = {
        id: req.user.id,
        displayName: req.user.displayName
      };
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Authentication Complete</title>
          <script>
            window.onload = function() {
              const userData = ${JSON.stringify(userData)};
              window.location.href = 'https://minesweeper-flags-frontend.onrender.com/auth/callback#' + encodeURIComponent(JSON.stringify(userData));
            };
          </script>
        </head>
        <body><p>Authentication successful. Redirecting...</p></body>
        </html>
      `);
    });
  }
);

app.get("/auth/facebook",
  passport.authenticate("facebook", { scope: ['public_profile'] })
);

app.get("/auth/facebook/callback",
  passport.authenticate("facebook", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com/login-failed",
  }),
  (req, res) => {
    req.session.save((err) => {
      if (err) {
        return res.redirect(`https://minesweeper-flags-frontend.onrender.com/auth/callback-failure?message=${encodeURIComponent(err.message || 'Authentication failed due to session error.')}`);
      }
      const userData = {
        id: req.user.id,
        displayName: req.user.displayName
      };
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Authentication Complete</title>
          <script>
            window.onload = function() {
              const userData = ${JSON.stringify(userData)};
              window.location.href = 'https://minesweeper-flags-frontend.onrender.com/auth/callback#' + encodeURIComponent(JSON.stringify(userData));
            };
          </script>
        </head>
        <body><p>Authentication successful. Redirecting...</p></body>
        </html>
      `);
    });
  }
);

app.post("/auth/guest", (req, res) => {
    const { guestId } = req.body;
    if (!guestId) {
        return res.status(400).json({ message: "Guest ID and name are required." });
    }

    req.session.passport = { user: { id: guestId, displayName: `Guest_${guestId.substring(6, 11)}` }};

    req.session.save((err) => {
        if (err) {
            return res.status(500).json({ message: "Failed to create guest session." });
        }
        res.status(200).json({ user: req.session.passport.user });
    });
});

app.get("/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) { return next(err); }
    req.session.destroy((destroyErr) => {
      if (destroyErr) { return next(destroyErr); }
      res.clearCookie("connect.sid", {
          path: '/',
          secure: true,
          sameSite: 'none',
          proxy: true,
      });
      res.status(200).send("Logged out successfully");
    });
  });
});

app.get("/me", (req, res) => {
  if (req.isAuthenticated() && req.user) {
    res.json({ user: req.user });
  } else if (req.session?.passport?.user) {
      res.json({ user: req.session.passport.user });
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
});

app.get("/login-failed", (req, res) => {
  res.send("Login failed");
});

let players = [];
let games = {};
const pendingInvites = {};
const pending2v2Acceptances = {};

const lobbyMessages = [];
const MAX_LOBBY_MESSAGES = 100;

const generateBoard = (safeX = null, safeY = null) => {
  const board = Array.from({ length: HEIGHT }, () =>
    Array.from({ length: WIDTH }, () => ({
      isMine: false,
      revealed: false,
      adjacentMines: 0,
      owner: null,
      ownerTeam: null,
    }))
  );

  let minesPlaced = 0;
  while (minesPlaced < MINES) {
    const x = Math.floor(Math.random() * WIDTH);
    const y = Math.floor(Math.random() * HEIGHT);

    if (safeX !== null && safeY !== null && Math.abs(x - safeX) <= 1 && Math.abs(y - safeY) <= 1) {
      continue;
    }

    if (!board[y][x].isMine) {
      board[y][x].isMine = true;
      minesPlaced++;
    }
  }

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (board[y][x].isMine) continue;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < HEIGHT && nx >= 0 && nx < WIDTH) {
            if (board[ny][nx].isMine) count++;
          }
        }
      }
      board[y][x].adjacentMines = count;
    }
  }
  return board;
};

const revealRecursive = (board, x, y) => {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT || board[y][x].revealed) {
    return;
  }

  const tile = board[y][x];
  tile.revealed = true;

  if (tile.adjacentMines === 0 && !tile.isMine) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx !== 0 || dy !== 0) {
          revealRecursive(board, x + dx, y + dy);
        }
      }
    }
  }
};

const revealArea = (board, cx, cy, playerNumber, playerTeam, scores) => {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) {
        const tile = board[y][x];
        if (!tile.revealed) {
          if (tile.isMine) {
            tile.revealed = true;
            tile.owner = playerNumber;
            tile.ownerTeam = playerTeam;
            scores[playerTeam]++;
          } else {
            revealRecursive(board, x, y);
          }
        }
      }
    }
  }
};

function clearAllRelatedInvitesForUsers(userIds, currentInviteId) {
    Object.keys(pendingInvites).forEach(targetUserId => {
        if (!pendingInvites[targetUserId]) return;

        Object.keys(pendingInvites[targetUserId]).forEach(invId => {
            const inviteObj = pendingInvites[targetUserId][invId];
            
            const involvesUser = 
                userIds.includes(inviteObj.senderId) || 
                userIds.includes(targetUserId) ||
                (inviteObj.invitedPlayersInfo && inviteObj.invitedPlayersInfo.some(p => userIds.includes(p.userId)));

            if (involvesUser || invId === currentInviteId) {
                delete pendingInvites[targetUserId][invId];
            }
        });

        const clientSocketId = userSocketMap[targetUserId];
        if (clientSocketId) {
            io.to(clientSocketId).emit("update-invites", pendingInvites[targetUserId] || {});
        }
    });

    Object.keys(pending2v2Acceptances).forEach(invId => {
        const acceptanceObj = pending2v2Acceptances[invId];
        const involvesTrackerUser = userIds.some(uid => acceptanceObj.requiredPlayers?.has(uid));
        if (involvesTrackerUser || invId === currentInviteId) {
            delete pending2v2Acceptances[invId];
        }
    });
}

const checkGameOver = (scores) => {
  return scores[1] >= 26 || scores[2] >= 26;
};

const getNext2v2Turn = (currentTurn) => {
  switch (currentTurn) {
    case 1: return 3;
    case 2: return 4;
    case 3: return 2;
    case 4: return 1;
    default: return 1;
  }
};

const getPlayersWithAI = () => {
    const aiBot = {
        userId: 'ai_bot_player_id',
        name: '🤖 Minesweeper Bot',
        socketId: null,
        isAi: true
    };
    if (!players.some(p => p.userId === aiBot.userId)) {
        players.push(aiBot);
    }
    return players;
};

const emitLobbyPlayersList = () => {
    const playersWithStatus = players.map(p => {
        const gameMapping = userGameMap[p.userId];
        let opponentName = null;
        let playerNames = {}; 
        let teamName = null;

        if (gameMapping && games[gameMapping.gameId]) {
            const game = games[gameMapping.gameId];
            if (game.gameType === '1v1') {
                opponentName = game.players.find(player => player.userId !== p.userId)?.name;
            } else { 
                const myPlayer = game.players.find(player => player.userId === p.userId);
                if (myPlayer) {
                    teamName = `Team ${myPlayer.team}`;
                }
                playerNames = { 
                    player1Name: game.players.find(pl => pl.number === 1)?.name,
                    player2Name: game.players.find(pl => pl.number === 2)?.name,
                    player3Name: game.players.find(pl => pl.number === 3)?.name,
                    player4Name: game.players.find(pl => pl.number === 4)?.name,
                };
            }
        }

        return {
            id: p.id,
            name: p.name,
            userId: p.userId, 
            gameId: gameMapping ? gameMapping.gameId : null,
            role: gameMapping ? gameMapping.role : null,
            gameType: gameMapping && games[gameMapping.gameId] ? games[gameMapping.gameId].gameType : null,
            opponentName: opponentName, 
            teamName: teamName, 
            playerNames: playerNames 
        };
    });
    io.emit("players-list", playersWithStatus);
};

io.on("connection", (socket) => {
  let user = socket.request.session?.passport?.user || socket.request.user || null;
  let userId = user ? (user.id || socket.request.user?.id) : null;
  let userName = user ? (user.displayName || user.name) : null;

  if (!userId && socket.handshake.auth && socket.handshake.auth.user) {
    const authUser = socket.handshake.auth.user;
    userId = authUser.id || authUser.guestId || `guest_${Date.now()}`;
    userName = authUser.displayName || authUser.name || "Guest";
  }

  if (userId) {
    userSocketMap[userId] = socket.id;
    socket.emit('authenticated-socket-ready');

    if (userGameMap[userId]) {
        const gameMapping = userGameMap[userId];
        const gameId = gameMapping.gameId;
        const role = gameMapping.role;
        let game = games[gameId];

        if (!game) {
            db.collection(GAMES_COLLECTION_PATH).doc(gameId).get().then(doc => {
                if (doc.exists && (doc.data().status === 'active' || doc.data().status === 'waiting_for_resume')) {
                    const gameData = doc.data();
                    const deserializedBoard = JSON.parse(gameData.board);

                    game = {
                        gameId: gameData.gameId,
                        gameType: gameData.gameType || '1v1',
                        board: deserializedBoard,
                        scores: gameData.scores,
                        bombsUsed: gameData.bombsUsed,
                        turn: gameData.turn,
                        moves: gameData.moves || [],
                        gameOver: gameData.gameOver,
                        lastClickedTile: gameData.lastClickedTile || {},
                        players: [],
                        messages: gameData.messages || []
                    };

                    game.observers = (gameData.observers || []).filter(obs =>
                        ![gameData.player1_userId, gameData.player2_userId, gameData.player3_userId, gameData.player4_userId].includes(obs.userId)
                    );

                    const playerUserIds = [gameData.player1_userId, gameData.player2_userId];
                    const playerNames = {
                        1: gameData.player1_name || "Player 1",
                        2: gameData.player2_name || "Player 2",
                    };
                    if (game.gameType === '2v2') {
                        playerUserIds.push(gameData.player3_userId, gameData.player4_userId);
                        playerNames[3] = gameData.player3_name || "Player 3";
                        playerNames[4] = gameData.player4_name || "Player 4";
                    }

                    game.players = playerUserIds.map((pUid, index) => {
                        const playerNum = index + 1;
                        let playerObj = players.find(p => p.userId === pUid);
                        if (!playerObj) {
                            playerObj = { userId: pUid, name: playerNames[playerNum], number: playerNum };
                            players.push(playerObj);
                        }
                        playerObj.socketId = userSocketMap[pUid] || null;
                        playerObj.team = (playerNum === 1 || playerNum === 2) ? 1 : 2;
                        return playerObj;
                    });

                    games[gameId] = game;

                    if (gameData.status === 'waiting_for_resume') {
                        doc.ref.set({ status: 'active', lastUpdated: Timestamp.now() }, { merge: true }).catch(e => console.error(e));
                    }

                    if (role === 'player') {
                        const playerInGame = game.players.find(p => p.userId === userId);
                        if (playerInGame) {
                            socket.join(gameId);
                            io.to(playerInGame.socketId).emit("game-start", {
                                gameId: game.gameId,
                                gameType: game.gameType,
                                playerNumber: playerInGame.number,
                                board: JSON.stringify(game.board),
                                turn: game.turn,
                                scores: game.scores,
                                bombsUsed: game.bombsUsed,
                                gameOver: game.gameOver,
                                lastClickedTile: game.lastClickedTile,
                                opponentName: game.gameType === '1v1' ? game.players.find(op => op.userId !== userId)?.name : "N/A",
                                gameChat: game.messages,
                                observers: game.observers,
                                player1Name: playerNames[1],
                                player2Name: playerNames[2],
                                player3Name: playerNames[3],
                                player4Name: playerNames[4],
                            });
                            io.to(gameId).emit("player-reconnected", { name: playerInGame.name, userId: playerInGame.userId, role: 'player' });

                            game.players.filter(p => p.userId !== userId && p.socketId).forEach(opponent => {
                                io.to(opponent.socketId).emit("opponent-reconnected", { name: playerInGame.name });
                            });
                        }
                    } else if (role === 'observer') {
                        const observerInGame = game.observers.find(o => o.userId === userId);
                        if (!observerInGame) {
                            game.observers.push({ userId, name: userName, socketId: socket.id });
                            doc.ref.update({ observers: FieldValue.arrayUnion({ userId, name: userName }) });
                        } else {
                            observerInGame.socketId = socket.id;
                        }
                        socket.join(gameId);
                        io.to(socket.id).emit("game-start", {
                            gameId: game.gameId,
                            gameType: game.gameType,
                            playerNumber: 0,
                            board: JSON.stringify(game.board),
                            turn: game.turn,
                            scores: game.scores,
                            bombsUsed: game.bombsUsed,
                            gameOver: game.gameOver,
                            lastClickedTile: game.lastClickedTile,
                            opponentName: "N/A",
                            gameChat: game.messages,
                            observers: game.observers,
                            player1Name: playerNames[1],
                            player2Name: playerNames[2],
                            player3Name: playerNames[3],
                            player4Name: playerNames[4],
                        });
                        io.to(gameId).emit("observer-joined", { name: userName, userId: userId });
                    }
                    emitLobbyPlayersList();
                } else {
                    delete userGameMap[userId];
                    emitLobbyPlayersList();
                }
            }).catch(e => console.error(e));
        } else {
            if (role === 'player') {
                const playerInGame = game.players.find(p => p.userId === userId);
                if (playerInGame) {
                    playerInGame.socketId = socket.id;
                    socket.join(gameId);
                    io.to(socket.id).emit("game-start", {
                        gameId: game.gameId,
                        gameType: game.gameType,
                        playerNumber: playerInGame.number,
                        board: JSON.stringify(game.board),
                        turn: game.turn,
                        scores: game.scores,
                        bombsUsed: game.bombsUsed,
                        gameOver: game.gameOver,
                        lastClickedTile: game.lastClickedTile,
                        opponentName: game.gameType === '1v1' ? game.players.find(op => op.userId !== userId)?.name : "N/A",
                        gameChat: game.messages,
                        observers: game.observers,
                        player1Name: game.players.find(pl => pl.number === 1)?.name || "Player 1",
                        player2Name: game.players.find(pl => pl.number === 2)?.name || "Player 2",
                        player3Name: game.players.find(pl => pl.number === 3)?.name,
                        player4Name: game.players.find(pl => pl.number === 4)?.name,
                    });
                    io.to(gameId).emit("player-reconnected", { name: playerInGame.name, userId: playerInGame.userId, role: 'player' });
                    game.players.filter(p => p.userId !== userId && p.socketId).forEach(opponent => {
                        io.to(opponent.socketId).emit("opponent-reconnected", { name: playerInGame.name });
                    });
                }
            } else if (role === 'observer') {
                const observerInGame = game.observers.find(o => o.userId === userId);
                if (observerInGame) {
                    observerInGame.socketId = socket.id;
                    socket.join(gameId);
                    io.to(socket.id).emit("game-start", {
                        gameId: game.gameId,
                        gameType: game.gameType,
                        playerNumber: 0,
                        board: JSON.stringify(game.board),
                        turn: game.turn,
                        scores: game.scores,
                        bombsUsed: game.bombsUsed,
                        gameOver: game.gameOver,
                        lastClickedTile: game.lastClickedTile,
                        opponentName: "N/A",
                        gameChat: game.messages,
                        observers: game.observers,
                        player1Name: game.players.find(pl => pl.number === 1)?.name || "Player 1",
                        player2Name: game.players.find(pl => pl.number === 2)?.name || "Player 2",
                        player3Name: game.players.find(pl => pl.number === 3)?.name,
                        player4Name: game.players.find(pl => pl.number === 4)?.name,
                    });
                    io.to(gameId).emit("observer-joined", { name: userName, userId: userId });
                }
            }
        }
    }
  }

  socket.on("join-lobby", (name) => {
    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userId = user ? (user.id || socket.request.user?.id) : null;
    const userName = user ? (user.displayName || user.name || name) : name; 

    if (!userId) {
        socket.emit("join-error", "Authentication required to join lobby.");
        return;
    }

    userSocketMap[userId] = socket.id;

    players = players.filter(p => p.userId !== userId);
    players.push({ id: socket.id, userId: userId, name: userName });
    socket.emit("lobby-joined", userName);
    socket.emit("initial-lobby-messages", lobbyMessages);

    emitLobbyPlayersList();
    socket.emit("request-observable-games");
  });

  socket.on("send-lobby-message", (message) => {
    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userName = user ? (user.displayName || user.name) : 'Anonymous';
    const timestamp = new Date().toLocaleTimeString();
    const fullMessage = { sender: userName, text: message, timestamp: timestamp };
    lobbyMessages.push(fullMessage);
    if (lobbyMessages.length > MAX_LOBBY_MESSAGES) {
      lobbyMessages.shift();
    }
    io.emit("receive-lobby-message", fullMessage);
  });

  socket.on("request-unfinished-games", async () => {
    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userId = user ? (user.id || socket.request.user?.id) : null;

    if (!userId) {
        socket.emit("join-error", "Authentication required to fetch games.");
        return;
    }

    try {
        const gamesQuery = await db.collection(GAMES_COLLECTION_PATH)
            .where('gameOver', '==', false)
            .where('status', 'in', ['active', 'waiting_for_resume'])
            .get();

        let unfinishedGames = [];

        gamesQuery.forEach(doc => {
            const gameData = doc.data();
            const isPlayer1 = gameData.player1_userId === userId;
            const isPlayer2 = gameData.player2_userId === userId;
            const isPlayer3 = gameData.gameType === '2v2' && gameData.player3_userId === userId;
            const isPlayer4 = gameData.gameType === '2v2' && gameData.player4_userId === userId;

            if (isPlayer1 || isPlayer2 || isPlayer3 || isPlayer4) {
                let myPlayerNumber = null;
                if (isPlayer1) myPlayerNumber = 1;
                else if (isPlayer2) myPlayerNumber = 2;
                else if (isPlayer3) myPlayerNumber = 3;
                else if (isPlayer4) myPlayerNumber = 4;

                let opponentName = null;
                if (gameData.gameType === '1v1') {
                    opponentName = myPlayerNumber === 1 ? gameData.player2_name : gameData.player1_name;
                }

                unfinishedGames.push({
                    gameId: gameData.gameId,
                    board: gameData.board,
                    gameType: gameData.gameType || '1v1',
                    playerNumber: myPlayerNumber,
                    opponentName: opponentName,
                    player1Name: gameData.player1_name,
                    player2Name: gameData.player2_name,
                    player3Name: gameData.player3_name,
                    player4Name: gameData.player4_name,
                    status: gameData.status,
                    lastUpdated: gameData.lastUpdated ? gameData.lastUpdated.toDate().toLocaleString() : 'N/A',
                    scores: gameData.scores
                });
            }
        });

        socket.emit("receive-unfinished-games", unfinishedGames);

    } catch (error) {
        console.error(error);
        socket.emit("join-error", "Failed to load your unfinished games.");
    }
  });

  socket.on("request-observable-games", async () => {
    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userId = user ? (user.id || socket.request.user?.id) : null;

    if (!userId) return;

    try {
        const gamesQuery = await db.collection(GAMES_COLLECTION_PATH)
            .where('gameOver', '==', false)
            .where('status', 'in', ['active', 'waiting_for_resume'])
            .get();

        let observableGames = [];

        gamesQuery.forEach(doc => {
            const gameData = doc.data();
            const isPlayer = [gameData.player1_userId, gameData.player2_userId, gameData.player3_userId, gameData.player4_userId].includes(userId);

            if (!isPlayer) {
                const gameInMem = games[gameData.gameId];
                let hasActiveParticipants = false;

                if (gameInMem) {
                    const playersActive = gameInMem.players.some(p => p.socketId);
                    const anyObserverActive = gameInMem.observers.some(o => o.socketId);
                    hasActiveParticipants = playersActive || anyObserverActive;
                }

                if (hasActiveParticipants) {
                    const alreadyObserving = userGameMap[userId] && userGameMap[userId].gameId === gameData.gameId && userGameMap[userId].role === 'observer';
                    if (!alreadyObserving) {
                         observableGames.push({
                            gameId: gameData.gameId,
                            gameType: gameData.gameType || '1v1',
                            player1Name: gameData.player1_name || "Player 1",
                            player2Name: gameData.player2_name || "Player 2",
                            player3Name: gameData.player3_name,
                            player4Name: gameData.player4_name,
                            scores: gameData.scores,
                            status: gameData.status,
                            lastUpdated: gameData.lastUpdated ? gameData.lastUpdated.toDate().toLocaleString() : 'N/A',
                            activeParticipants: (gameInMem ? (gameInMem.players.filter(p => p.socketId).length + gameInMem.observers.filter(o => o.socketId).length) : 0)
                        });
                    }
                }
            }
        });

        socket.emit("receive-observable-games", observableGames);

    } catch (error) {
        console.error(error);
    }
  });

  socket.on("resume-game", async ({ gameId }) => {
    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userId = user ? (user.id || socket.request.user?.id) : null;
    const userName = user ? (user.displayName || user.name || 'Unknown Player') : 'Unknown Player';

    if (!userId) {
      socket.emit("join-error", "Authentication required to resume game.");
      return;
    }

    userSocketMap[userId] = socket.id;

    try {
      const gameDocRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
      const gameDoc = await gameDocRef.get();

      if (!gameDoc.exists) {
        socket.emit("join-error", "Game not found or already ended.");
        if (userGameMap[userId] && userGameMap[userId].gameId === gameId) {
            delete userGameMap[userId];
        }
        return;
      }

      const gameData = gameDoc.data();
      const allPlayerUserIds = [gameData.player1_userId, gameData.player2_userId];
      if (gameData.gameType === '2v2') {
          allPlayerUserIds.push(gameData.player3_userId, gameData.player4_userId);
      }
      if (!allPlayerUserIds.includes(userId)) {
        socket.emit("join-error", "You are not a participant in this game.");
        return;
      }

      let currentPlayerNumber = null;
      if (gameData.player1_userId === userId) currentPlayerNumber = 1;
      else if (gameData.player2_userId === userId) currentPlayerNumber = 2;
      else if (gameData.player3_userId === userId) currentPlayerNumber = 3;
      else if (gameData.player4_userId === userId) currentPlayerNumber = 4;

      const playerNamesForClient = {
          1: gameData.player1_name || "Player 1",
          2: gameData.player2_name || "Player 2",
          3: gameData.player3_name,
          4: gameData.player4_name,
      };

      if (games[gameId]) {
        const existingGame = games[gameId];
        existingGame.players.forEach(player => {
            player.socketId = userSocketMap[player.userId] || null;
        });
        existingGame.observers.forEach(observer => {
            observer.socketId = userSocketMap[observer.userId] || null;
        });

        const currentPlayerInGame = existingGame.players.find(p => p.userId === userId);
        if (!currentPlayerInGame) return;

        socket.join(gameId);
        userGameMap[userId] = { gameId, role: 'player' };

        io.to(currentPlayerInGame.socketId).emit("game-start", {
            gameId: existingGame.gameId,
            gameType: existingGame.gameType,
            playerNumber: currentPlayerNumber,
            board: JSON.stringify(existingGame.board),
            turn: existingGame.turn,
            scores: existingGame.scores,
            bombsUsed: existingGame.bombsUsed,
            gameOver: existingGame.gameOver,
            lastClickedTile: existingGame.lastClickedTile,
            opponentName: existingGame.gameType === '1v1' ? existingGame.players.find(op => op.userId !== userId)?.name : "N/A",
            gameChat: existingGame.messages,
            observers: existingGame.observers,
            player1Name: playerNamesForClient[1],
            player2Name: playerNamesForClient[2],
            player3Name: playerNamesForClient[3],
            player4Name: playerNamesForClient[4],
        });

        io.to(gameId).emit("player-reconnected", { name: userName, userId: userId, role: 'player' });
        return;
      }

      const deserializedBoard = JSON.parse(gameData.board);
      const game = {
        gameId: gameData.gameId,
        gameType: gameData.gameType || '1v1',
        board: deserializedBoard,
        scores: gameData.scores,
        bombsUsed: gameData.bombsUsed || { 1: false, 2: false },
        turn: gameData.turn,
        gameOver: gameData.gameOver,
        lastClickedTile: gameData.lastClickedTile || {},
        players: [],
        messages: gameData.messages || []
      };

      game.observers = (gameData.observers || []).filter(obs =>
          ![gameData.player1_userId, gameData.player2_userId, gameData.player3_userId, gameData.player4_userId].includes(obs.userId)
      );

      const playerUids = [gameData.player1_userId, gameData.player2_userId];
      if (game.gameType === '2v2') {
          playerUids.push(gameData.player3_userId, gameData.player4_userId);
      }

      game.players = playerUids.map((pUid, index) => {
          const playerNum = index + 1;
          let playerObj = players.find(p => p.userId === pUid);
          if (!playerObj) {
              playerObj = { userId: pUid, name: playerNamesForClient[playerNum], number: playerNum };
              players.push(playerObj);
          }
          playerObj.socketId = (pUid === userId) ? socket.id : (userSocketMap[pUid] || null);
          playerObj.team = (playerNum === 1 || playerNum === 2) ? 1 : 2;
          return playerObj;
      });

      games[gameId] = game;
      game.players.forEach(p => userGameMap[p.userId] = { gameId, role: 'player' });

      if (gameData.status === 'waiting_for_resume') {
        await gameDocRef.set({ status: 'active', lastUpdated: Timestamp.now() }, { merge: true });
      }

      socket.join(gameId);
      io.to(socket.id).emit("game-start", {
        gameId: game.gameId,
        gameType: game.gameType,
        playerNumber: currentPlayerNumber,
        board: JSON.stringify(game.board),
        turn: game.turn,
        scores: game.scores,
        bombsUsed: game.bombsUsed,
        gameOver: game.gameOver,
        lastClickedTile: game.lastClickedTile,
        opponentName: game.gameType === '1v1' ? game.players.find(op => op.userId !== userId)?.name : "N/A",
        gameChat: game.messages,
        observers: game.observers,
        player1Name: playerNamesForClient[1],
        player2Name: playerNamesForClient[2],
        player3Name: playerNamesForClient[3],
        player4Name: playerNamesForClient[4],
      });
      io.to(gameId).emit("player-reconnected", { name: userName, userId: userId, role: 'player' });
      emitLobbyPlayersList();

    } catch (error) {
      console.error(error);
      socket.emit("join-error", "Failed to resume game.");
    }
  });

  socket.on("observe-game", async ({ gameId }) => {
    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userId = user ? (user.id || socket.request.user?.id) : null;
    const userName = user ? (user.displayName || user.name || 'Observer') : 'Observer';

    if (!userId) return;

    try {
        const gameDocRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
        const gameDoc = await gameDocRef.get();
        if (!gameDoc.exists) return;

        const gameData = gameDoc.data();
        let game = games[gameId];
        if (!game) {
            game = {
                gameId: gameData.gameId,
                gameType: gameData.gameType || '1v1',
                board: JSON.parse(gameData.board),
                scores: gameData.scores,
                bombsUsed: gameData.bombsUsed || { 1: false, 2: false },
                turn: gameData.turn,
                gameOver: gameData.gameOver,
                lastClickedTile: gameData.lastClickedTile || {},
                players: [],
                messages: gameData.messages || [],
                observers: gameData.observers || []
            };
            games[gameId] = game;
        }

        socket.join(gameId);
        userGameMap[userId] = { gameId, role: 'observer' };
        io.to(socket.id).emit("game-start", {
            gameId: game.gameId,
            gameType: game.gameType,
            playerNumber: 0,
            board: JSON.stringify(game.board),
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile,
            opponentName: "N/A",
            gameChat: game.messages,
            observers: game.observers,
            player1Name: gameData.player1_name,
            player2Name: gameData.player2_name,
        });
    } catch (e) {
        console.error(e);
    }
  });

  socket.on("invite-player", async ({ targetSocketIds, gameType }) => {
    const inviterUser = socket.request.session?.passport?.user || socket.request.user || null;
    const inviterUserId = inviterUser ? (inviterUser.id || socket.request.user?.id) : null;
    const inviterPlayer = players.find((p) => p.userId === inviterUserId);

    if (!inviterPlayer) return;

    const firstTarget = Array.isArray(targetSocketIds) ? targetSocketIds[0] : targetSocketIds;
    const isAiInvite = 
        gameType === '1v1' && (
            firstTarget === 'ai_bot_player_id' || 
            firstTarget === null || 
            !targetSocketIds || 
            (typeof firstTarget === 'string' && firstTarget.includes('ai'))
        );

    if (isAiInvite) {
        const gameId = uuidv4();
        const board = generateBoard();
        const player1 = inviterPlayer;
        const player2 = { userId: 'ai_bot_player_id', name: '🤖 Minesweeper Bot', socketId: null, isAi: true };

        const newGame = {
            gameId,
            gameType: '1v1',
            board,
            scores: { 1: 0, 2: 0 },
            bombsUsed: { 1: false, 2: false },
            turn: 1,
            gameOver: false,
            lastClickedTile: {},
            players: [
                { userId: player1.userId, name: player1.name, number: 1, socketId: socket.id, team: 1 },
                { userId: player2.userId, name: player2.name, number: 2, socketId: null, isAi: true, team: 2 }
            ],
            messages: [],
            observers: [],
            moves: []
        };

        games[gameId] = newGame;
        userGameMap[player1.userId] = { gameId, role: 'player' };

        db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
            gameId,
            gameType: '1v1',
            player1_userId: player1.userId,
            player1_name: player1.name,
            player2_userId: player2.userId,
            player2_name: player2.name,
            board: JSON.stringify(board),
            scores: newGame.scores,
            bombsUsed: newGame.bombsUsed,
            turn: newGame.turn,
            gameOver: false,
            status: 'active',
            lastUpdated: Timestamp.now()
        }).catch(err => console.error(err));

        socket.join(gameId);
        socket.emit("game-start", {
            gameId,
            gameType: '1v1',
            playerNumber: 1,
            board: JSON.stringify(board),
            turn: 1,
            scores: newGame.scores,
            bombsUsed: newGame.bombsUsed,
            gameOver: false,
            lastClickedTile: {},
            opponentName: player2.name,
            gameChat: [],
            observers: [],
            player1Name: player1.name,
            player2Name: player2.name
        });

        emitLobbyPlayersList();
        return;
    }

    // רגיל (שחקן נגד שחקן)
    const targetSocketId = firstTarget;
    const invitedPlayer = players.find((p) => p.id === targetSocketId);
    if (!invitedPlayer) return;

    const inviteId = uuidv4();
    if (!pendingInvites[invitedPlayer.userId]) {
        pendingInvites[invitedPlayer.userId] = {};
    }
    pendingInvites[invitedPlayer.userId][inviteId] = {
      inviteId,
      senderId: inviterUserId,
      senderName: inviterPlayer.name,
      gameType: gameType,
      timestamp: Date.now()
    };

    io.to(targetSocketId).emit("game-invite", pendingInvites[invitedPlayer.userId][inviteId]);
  });

  socket.on("respond-invite", async ({ inviteId, accept }) => {
    const respondingUser = socket.request.session?.passport?.user || socket.request.user || null;
    const respondingUserId = respondingUser ? (respondingUser.id || socket.request.user?.id) : null;
    const respondingPlayer = players.find((p) => p.userId === respondingUserId);

    if (!respondingPlayer) return;

    const originalInvite = pendingInvites[respondingUserId]?.[inviteId];
    if (!originalInvite) return;

    delete pendingInvites[respondingUserId][inviteId];
    socket.emit("update-invites", pendingInvites[respondingUserId] || {});

    const inviterPlayer = players.find((p) => p.userId === originalInvite.senderId);
    if (!inviterPlayer) return;

    if (accept) {
        const newGameId = uuidv4();
        const newBoard = generateBoard();
        const initialScores = { 1: 0, 2: 0 };

        const p1User = inviterPlayer;
        const p2User = respondingPlayer;

        const gamePlayers = [
          { userId: p1User.userId, name: p1User.name, number: 1, socketId: userSocketMap[p1User.userId], team: 1 },
          { userId: p2User.userId, name: p2User.name, number: 2, socketId: userSocketMap[p2User.userId], team: 2 },
        ];

        const game = {
          gameId: newGameId,
          gameType: '1v1',
          board: newBoard,
          players: gamePlayers,
          turn: 1,
          scores: initialScores,
          bombsUsed: { 1: false, 2: false },
          gameOver: false,
          lastClickedTile: { 1: null, 2: null },
          messages: [],
          observers: [],
          moves: []
        };

        games[newGameId] = game;
        gamePlayers.forEach(p => userGameMap[p.userId] = { gameId: newGameId, role: 'player' });

        const serializedBoard = JSON.stringify(game.board);
        await db.collection(GAMES_COLLECTION_PATH).doc(newGameId).set({
          gameId: game.gameId,
          gameType: game.gameType,
          board: serializedBoard,
          player1_userId: p1User.userId, player1_name: p1User.name,
          player2_userId: p2User.userId, player2_name: p2User.name,
          turn: game.turn,
          scores: game.scores,
          bombsUsed: game.bombsUsed,
          gameOver: game.gameOver,
          status: 'active',
          lastUpdated: Timestamp.now()
        }, { merge: true });

        gamePlayers.forEach(p => {
          if (p.socketId) {
            io.sockets.sockets.get(p.socketId)?.join(newGameId);
            io.to(p.socketId).emit("game-start", {
              gameId: game.gameId,
              gameType: game.gameType,
              playerNumber: p.number,
              board: serializedBoard,
              turn: game.turn,
              scores: game.scores,
              bombsUsed: game.bombsUsed,
              gameOver: game.gameOver,
              lastClickedTile: game.lastClickedTile,
              opponentName: p.number === 1 ? p2User.name : p1User.name,
              gameChat: game.messages,
              observers: game.observers,
              player1Name: p1User.name,
              player2Name: p2User.name
            });
          }
        });

        emitLobbyPlayersList();
    } else {
        if (userSocketMap[inviterPlayer.userId]) {
            io.to(userSocketMap[inviterPlayer.userId]).emit("invite-rejected", { fromName: respondingPlayer.name });
        }
    }
  });

  socket.on("tile-click", async ({ gameId, x, y, clickStartTime }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const mineRevealed = game.scores[1] > 0 || game.scores[2] > 0 || game.board.some(row => row.some(cell => cell.isMine && cell.revealed));

    if (!mineRevealed) {
      const clickedTile = game.board[y][x];
      if (clickedTile.adjacentMines === 0 && !clickedTile.isMine) {
        game.board = generateBoard();
        game.scores = { 1: 0, 2: 0 };
        game.turn = 1;
        game.moves = [];
        game.lastClickedTile = {};

        const cachedBoardString = JSON.stringify(game.board);
        db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
          board: cachedBoardString,
          turn: game.turn,
          scores: game.scores,
          moves: game.moves,
          lastClickedTile: game.lastClickedTile,
          lastUpdated: Timestamp.now()
        }, { merge: true }).catch(err => console.error(err));

        io.to(gameId).emit("board-update", {
          gameId: game.gameId,
          board: cachedBoardString,
          turn: game.turn,
          scores: game.scores,
          bombsUsed: game.bombsUsed,
          gameOver: game.gameOver,
          lastClickedTile: game.lastClickedTile,
          observers: game.observers,
          clickStartTime: clickStartTime
        });
        return;
      }
    }

    game.clickStartTime = clickStartTime;
    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userId = user ? (user.id || socket.request.user?.id) : null;
    if (!userId) return;

    const player = game.players.find((p) => p.userId === userId);
    if (!player || player.number !== game.turn) return;

    player.socketId = socket.id;
    const tile = game.board[y][x];
    if (tile.revealed) return;

    game.lastClickedTile = { ...game.lastClickedTile, [player.number]: { x, y } };

    if (tile.isMine) {
      tile.revealed = true;
      tile.owner = player.number;
      tile.ownerTeam = player.team;
      game.scores[player.team]++;

      if (checkGameOver(game.scores)) {
        game.gameOver = true;
        // ניקוי המשחק מהזיכרון לאחר 10 דקות ממנוע הקראשים
        setTimeout(() => {
            if (games[gameId]) {
                delete games[gameId];
            }
        }, 1000 * 60 * 60 * 24 * 7);
        game.players.forEach(p => delete userGameMap[p.userId]);
        emitLobbyPlayersList();
      }
    } else {
      revealRecursive(game.board, x, y);
      game.turn = game.turn === 1 ? 2 : 1;
    }

    const cachedBoardString = JSON.stringify(game.board);
    io.to(gameId).emit("board-update", {
      gameId: game.gameId,
      board: cachedBoardString,
      turn: game.turn,
      scores: game.scores,
      bombsUsed: game.bombsUsed,
      gameOver: game.gameOver,
      lastClickedTile: game.lastClickedTile,
      observers: game.observers,
      clickStartTime: game.clickStartTime
    });

    db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
      board: cachedBoardString,
      turn: game.turn,
      scores: game.scores,
      bombsUsed: game.bombsUsed,
      gameOver: game.gameOver,
      lastClickedTile: game.lastClickedTile,
      status: game.gameOver ? 'completed' : 'active',
      lastUpdated: Timestamp.now()
    }, { merge: true }).catch(err => console.error(err));
  });

  socket.on("leave-game", async ({ gameId }) => {
    const game = games[gameId];
    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userId = user ? (user.id || socket.request.user?.id) : null;

    if (game && userId) {
      delete userGameMap[userId];
      socket.leave(gameId);
      try {
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
            status: 'waiting_for_resume',
            lastUpdated: Timestamp.now()
        }, { merge: true });
      } catch (e) {
        console.error(e);
      }
    }
    emitLobbyPlayersList();
  });

  socket.on("disconnect", async () => {
    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const disconnectedUserId = user ? (user.id || socket.request.user?.id) : null;

    if (disconnectedUserId) {
      delete userSocketMap[disconnectedUserId];
    }
    players = players.filter(p => userSocketMap[p.userId] !== undefined);
    emitLobbyPlayersList();
  });
});

app.get("/api/finished-games", async (req, res) => {
  try {
    const finishedSnapshot = await db.collection(GAMES_COLLECTION_PATH)
      .where("status", "==", "completed")
      .get();

    const finishedGames = [];
    finishedSnapshot.forEach((doc) => {
      const data = doc.data();
      finishedGames.push({
        gameId: data.gameId || doc.id,
        gameType: data.gameType || "1v1",
        player1Name: data.player1_name || "Player 1",
        player2Name: data.player2_name || "Player 2",
        scores: data.scores || { 1: 0, 2: 0 },
        winnerTeam: data.winnerTeam !== undefined ? data.winnerTeam : null,
        lastUpdated: data.lastUpdated ? (data.lastUpdated.toDate ? data.lastUpdated.toDate() : data.lastUpdated) : new Date()
      });
    });

    res.json(finishedGames);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch finished games." });
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
