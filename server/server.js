// server.js

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const passport = require("passport");
const session = require("express-session");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const FacebookStrategy = require("passport-facebook").Strategy;
const { v4: uuidv4 } = require("uuid");

// --- Redis Session Store Imports ---
const RedisStore = require("connect-redis").default;
const { createClient } = require("redis");

const app = express();
const server = http.createServer(app);

// New global data structures for robust player tracking across reconnections
const userSocketMap = {}; // Maps userId to current socket.id (e.g., Google ID, Facebook ID)
const userGameMap = {};   // Maps userId to the gameId they are currently in

// Configure CORS for Express
app.use(
  cors({
    origin: "https://minesweeper-flags-frontend.onrender.com", // Your frontend URL
    credentials: true, // Allow cookies to be sent cross-origin
  })
);

// Configure Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: "https://minesweeper-flags-frontend.onrender.com", // Your frontend URL
    methods: ["GET", "POST"],
    credentials: true, // Allow cookies
  },
});

// === Environment Variables for OAuth ===
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const FACEBOOK_CLIENT_ID = process.env.FACEBOOK_CLIENT_ID;
const FACEBOOK_CLIENT_SECRET = process.env.FACEBOOK_CLIENT_SECRET;

app.set('trust proxy', 1); // Crucial when deployed behind a load balancer (like Render)

// === Redis Client Setup ===
let redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379' // Use env var for Render deployment
});

redisClient.on('connect', () => console.log('Connected to Redis!'));
redisClient.on('error', (err) => console.error('Redis Client Error', err));

// Connect to Redis. This should be awaited or handled before starting the server to ensure store is ready.
// For simplicity in the main script flow, we'll connect here and log errors.
redisClient.connect().catch(e => console.error("Failed to connect to Redis:", e));


// === Express Session Middleware ===
// Define the session middleware instance ONCE, now using RedisStore
const sessionMiddleware = session({
  store: new RedisStore({ client: redisClient }), // Use RedisStore for persistent sessions
  secret: process.env.SESSION_SECRET || "super-secret-fallback-key-for-dev", // Use env var
  resave: false, // Don't save session if unmodified
  saveUninitialized: false, // Don't save uninitialized sessions
  cookie: {
    sameSite: "none",   // Required for cross-site cookie transmission
    secure: process.env.NODE_ENV === 'production', // true only if using HTTPS
    maxAge: 1000 * 60 * 60 * 24 // Cookie valid for 24 hours
  },
});

// Apply session middleware to Express
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());


// === IMPORTANT: Integrate session and passport middleware with Socket.IO ===
// This single io.use() block ensures that `socket.request.session` AND `socket.request.user`
// are correctly populated for every Socket.IO connection.
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, () => {
        passport.initialize()(socket.request, {}, () => {
            passport.session()(socket.request, {}, next);
        });
    });
});
// === END Socket.IO Session Integration ===


// Passport Google Strategy
passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/google/callback"
}, (accessToken, refreshToken, profile, done) => {
  console.log("Google Auth Profile:", profile.displayName, profile.id);
  done(null, profile.id); // Store profile.id (Google ID) in session
}));

// Passport Facebook Strategy
passport.use(new FacebookStrategy({
  clientID: FACEBOOK_CLIENT_ID,
  clientSecret: FACEBOOK_CLIENT_SECRET,
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/facebook/callback",
  profileFields: ['id', 'displayName', 'photos', 'email']
},
function(accessToken, refreshToken, profile, cb) {
  console.log("Facebook Auth Profile:", profile.displayName, profile.id);
  cb(null, profile.id);
}));


passport.serializeUser((userId, done) => {
  console.log("serializeUser:", userId);
  done(null, userId);
});

// IMPORTANT: Modify deserializeUser to return an object with `id` and `displayName`
// This makes `socket.request.user.id` and `socket.request.user.displayName` available.
passport.deserializeUser((userId, done) => {
  console.log("deserializeUser:", userId);
  // In a real app, you'd fetch the user's display name from your DB using userId
  // For now, we'll construct a simple object:
  done(null, { id: userId, displayName: `User_${userId.substring(0, 8)}` });
});


// === Authentication Routes ===
app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
app.get("/auth/google/callback", passport.authenticate("google", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com",
    successRedirect: "https://minesweeper-flags-frontend.onrender.com",
}));

app.get("/auth/facebook", passport.authenticate("facebook", { scope: ['public_profile'] }));
app.get("/auth/facebook/callback", passport.authenticate("facebook", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com",
    successRedirect: "https://minesweeper-flags-frontend.onrender.com",
}));

app.get("/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) { return next(err); }
    req.session.destroy((destroyErr) => {
      if (destroyErr) { return next(destroyErr); }
      res.clearCookie("connect.sid", {
          path: '/',
          domain: '.onrender.com',
          secure: true,
          sameSite: 'none'
      });
      console.log("User logged out and session destroyed.");
      res.status(200).send("Logged out successfully");
    });
  });
});

app.get("/me", (req, res) => {
  console.log("------------------- /me Request Received -------------------");
  console.log("Is Authenticated (req.isAuthenticated()):", req.isAuthenticated());
  console.log("User in session (req.user):", req.user);
  console.log("Session ID (req.sessionID):", req.sessionID);
  console.log("Session object (req.session):", req.session);

  if (req.isAuthenticated() && req.user) {
    res.json({ user: { id: req.user.id, displayName: req.user.displayName } });
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
  console.log("------------------------------------------------------------");
});

// --- Game Logic ---
const WIDTH = 16;
const HEIGHT = 16;
const MINES = 51;
let players = []; // Lobby players: { id: socket.id, userId, name }
let games = {};

// Helper to generate a new Minesweeper board
const generateBoard = () => {
    const board = Array.from({ length: HEIGHT }, () =>
      Array.from({ length: WIDTH }, () => ({
        isMine: false,
        revealed: false,
        adjacentMines: 0,
        owner: null,
      }))
    );
    let minesPlaced = 0;
    while (minesPlaced < MINES) {
      const x = Math.floor(Math.random() * WIDTH);
      const y = Math.floor(Math.random() * HEIGHT);
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
const revealArea = (board, cx, cy, playerNumber, scores) => {
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
              scores[playerNumber]++;
            } else {
              revealRecursive(board, x, y);
            }
          }
        }
      }
    }
};
const checkGameOver = (scores) => {
    return scores[1] >= 26 || scores[2] >= 26;
};
// === Socket.IO Connection and Game Events ===
io.on("connection", (socket) => {
  console.log(`Socket Connected: ${socket.id}`);

  // Now socket.request.user should be reliably populated if authenticated
  const userIdOnConnect = socket.request.user ? socket.request.user.id : null;
  const userNameOnConnect = socket.request.user ? socket.request.user.displayName : null;


  if (userIdOnConnect) {
    console.log(`User ${userNameOnConnect} (${userIdOnConnect}) (re)connected. Socket ID: ${socket.id}`);

    userSocketMap[userIdOnConnect] = socket.id; // Update user-to-socket mapping

    if (userGameMap[userIdOnConnect]) {
        const gameId = userGameMap[userIdOnConnect];
        const game = games[gameId];

        if (game) {
            const playerInGame = game.players.find(p => p.userId === userIdOnConnect);
            if (playerInGame) {
                playerInGame.socketId = socket.id;
                console.log(`Re-associated user ${playerInGame.name} (${userIdOnConnect}) in game ${gameId} with new socket ID ${socket.id}`);

                const opponentPlayer = game.players.find(op => op.userId !== userIdOnConnect);
                const dataForReconnectedPlayer = {
                    gameId: game.gameId,
                    playerNumber: playerInGame.number,
                    board: game.board,
                    turn: game.turn,
                    scores: game.scores,
                    bombsUsed: game.bombsUsed,
                    gameOver: game.gameOver,
                    opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
                };
                socket.emit("game-start", dataForReconnectedPlayer);
                console.log(`Emitted game-start to reconnected user ${playerInGame.name}`);

                if (opponentPlayer && opponentPlayer.socketId) {
                    io.to(opponentPlayer.socketId).emit("opponent-reconnected", { name: playerInGame.name });
                }
            }
        } else {
            delete userGameMap[userIdOnConnect];
            console.log(`Game ${gameId} for user ${userIdOnConnect} no longer exists, clearing map.`);
        }
    }
  } else {
      console.log(`Unauthenticated or session-less socket ${socket.id} connected. (No req.user)`);
  }


  socket.on("join-lobby", (name) => {
    const userId = socket.request.user ? socket.request.user.id : null;
    const userDisplayName = socket.request.user ? socket.request.user.displayName : null;

    if (!userId) {
        socket.emit("join-error", "Authentication required to join lobby. Please login.");
        console.warn(`Unauthenticated socket ${socket.id} tried to join lobby. Rejecting.`);
        return;
    }

    userSocketMap[userId] = socket.id;

    players = players.filter(p => p.userId !== userId); // Filter out old entry if user reconnected
    players.push({ id: socket.id, userId: userId, name: userDisplayName || name }); // Use userDisplayName, fallback to name from client

    console.log(`Player ${userDisplayName || name} (${userId}) joined lobby with socket ID ${socket.id}. Total lobby players: ${players.length}`);
    socket.emit("lobby-joined");
    io.emit("players-list", players.filter(p => !userGameMap[p.userId]).map(p => ({ id: p.id, name: p.name })));
  });

  socket.on("invite-player", (targetSocketId) => {
    const inviterPlayer = players.find((p) => p.id === socket.id);
    const invitedPlayer = players.find((p) => p.id === targetSocketId);

    if (!inviterPlayer || !invitedPlayer || userGameMap[inviterPlayer.userId] || userGameMap[invitedPlayer.userId]) {
      console.warn(`Invite failed: Inviter or invitee not found or already in game. Inviter: ${inviterPlayer?.name}, Invitee: ${invitedPlayer?.name}`);
      return;
    }

    io.to(invitedPlayer.id).emit("game-invite", {
      fromId: inviterPlayer.id,
      fromName: inviterPlayer.name,
    });
    console.log(`Invite sent from ${inviterPlayer.name} to ${invitedPlayer.name}`);
  });

  socket.on("respond-invite", ({ fromId, accept }) => {
    const respondingPlayer = players.find((p) => p.id === socket.id);
    const inviterPlayer = players.find((p) => p.id === fromId);

    if (!respondingPlayer || !inviterPlayer) {
        console.warn("Respond invite failed: Players not found.");
        return;
    }

    if (userGameMap[respondingPlayer.userId] || userGameMap[inviterPlayer.userId]) {
        console.warn("Respond invite failed: One or both players already in a game.");
        io.to(respondingPlayer.id).emit("invite-rejected", { fromName: inviterPlayer.name, reason: "Already in another game" });
        io.to(inviterPlayer.id).emit("invite-rejected", { fromName: respondingPlayer.name, reason: "Already in another game" });
        return;
    }

    if (accept) {
      const gameId = uuidv4();
      const newBoard = generateBoard();
      const scores = { 1: 0, 2: 0 };
      const bombsUsed = { 1: false, 2: false };
      const turn = 1;
      const gameOver = false;

      const game = {
        gameId,
        board: newBoard,
        players: [
          { userId: inviterPlayer.userId, name: inviterPlayer.name, number: 1, socketId: inviterPlayer.id },
          { userId: respondingPlayer.userId, name: respondingPlayer.name, number: 2, socketId: respondingPlayer.id },
        ],
        turn,
        scores,
        bombsUsed,
        gameOver,
      };
      games[gameId] = game;

      userGameMap[inviterPlayer.userId] = gameId;
      userGameMap[respondingPlayer.userId] = gameId;
      console.log(`Game ${gameId} started between ${inviterPlayer.name} (${inviterPlayer.userId}) and ${respondingPlayer.name} (${respondingPlayer.userId}).`);

      players = players.filter(p => p.userId !== inviterPlayer.userId && p.userId !== respondingPlayer.userId);
      io.emit("players-list", players.filter(p => !userGameMap[p.userId]).map(p => ({ id: p.id, name: p.name })));

      io.to(inviterPlayer.id).emit("game-start", {
        gameId: game.gameId, playerNumber: 1, board: game.board, turn: game.turn, scores: game.scores,
        bombsUsed: game.bombsUsed, gameOver: game.gameOver, opponentName: respondingPlayer.name,
      });
      io.to(respondingPlayer.id).emit("game-start", {
        gameId: game.gameId, playerNumber: 2, board: game.board, turn: game.turn, scores: game.scores,
        bombsUsed: game.bombsUsed, gameOver: game.gameOver, opponentName: inviterPlayer.name,
      });

    } else {
      io.to(fromId).emit("invite-rejected", { fromName: respondingPlayer.name });
      console.log(`Invite from ${inviterPlayer.name} rejected by ${respondingPlayer.name}.`);
    }
  });

  socket.on("tile-click", ({ gameId, x, y }) => {
    const currentUserId = socket.request.user ? socket.request.user.id : null;
    if (!currentUserId) {
        console.warn(`Tile click: Unauthenticated user for socket ${socket.id}.`);
        return;
    }

    const game = games[gameId];
    if (!game || game.gameOver) {
        console.warn(`Tile click: Game ${gameId} not found or game over.`);
        return;
    }

    const player = game.players.find((p) => p.userId === currentUserId);
    if (!player || player.number !== game.turn) {
        console.warn(`Tile click: Not player's turn or player not found in game. Player: ${player?.name}, Turn: ${game?.turn}`);
        return;
    }

    player.socketId = socket.id;

    const tile = game.board[y][x];
    if (tile.revealed) {
        console.warn(`Tile click: Tile ${x},${y} already revealed.`);
        return;
    }

    if (tile.isMine) {
      tile.revealed = true;
      tile.owner = player.number;
      game.scores[player.number]++;
      if (checkGameOver(game.scores)) game.gameOver = true;
      console.log(`Player ${player.name} revealed a mine at ${x},${y}. Score: ${game.scores[player.number]}`);
    } else {
      const isBlankTile = tile.adjacentMines === 0;
      const noFlagsRevealedYet = game.scores[1] === 0 && game.scores[2] === 0;

      if (isBlankTile && noFlagsRevealedYet) {
        console.log(`[GAME RESTART TRIGGERED] Player ${player.name} (${player.userId}) hit a blank tile at ${x},${y} before any flags were revealed. Restarting game ${gameId}.`);

        game.board = generateBoard();
        game.scores = { 1: 0, 2: 0 };
        game.bombsUsed = { 1: false, 2: false };
        game.turn = 1;
        game.gameOver = false;

        game.players.forEach(p => {
            if (p.socketId) {
                const opponentPlayer = game.players.find(op => op.userId !== p.userId);
                io.to(p.socketId).emit("game-restarted", {
                    gameId: game.gameId,
                    playerNumber: p.number,
                    board: game.board,
                    turn: game.turn,
                    scores: game.scores,
                    bombsUsed: game.bombsUsed,
                    gameOver: game.gameOver,
                    opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
                });
            } else {
                console.warn(`Player ${p.name} in game ${gameId} has no active socket. Cannot send restart event.`);
            }
        });
        console.log(`[GAME RESTARTED] Game ${gameId} state after reset. Players: ${game.players.map(p => p.name).join(', ')}`);
        return;
      }

      revealRecursive(game.board, x, y);
      game.turn = game.turn === 1 ? 2 : 1;
    }

    if (!isBlankTile || !noFlagsRevealedYet) {
        game.players.forEach(p => {
            if (p.socketId) {
                io.to(p.socketId).emit("board-update", game);
            } else {
                 console.warn(`Player ${p.name} in game ${gameId} has no active socket. Cannot send board update.`);
            }
        });
    }
  });

  socket.on("use-bomb", ({ gameId }) => {
    const currentUserId = socket.request.user ? socket.request.user.id : null;
    if (!currentUserId) {
        console.warn(`Use bomb: Unauthenticated user for socket ${socket.id}.`);
        return;
    }

    const game = games[gameId];
    if (!game || game.gameOver) return;

    const player = game.players.find((p) => p.userId === currentUserId);
    if (!player || game.bombsUsed[player.number]) return;

    player.socketId = socket.id;

    io.to(player.socketId).emit("wait-bomb-center");
    console.log(`Player ${player.name} is waiting for bomb center selection.`);
  });

  socket.on("bomb-center", ({ gameId, x, y }) => {
    const currentUserId = socket.request.user ? socket.request.user.id : null;
    if (!currentUserId) {
        console.warn(`Bomb center: Unauthenticated user for socket ${socket.id}.`);
        return;
    }

    const game = games[gameId];
    if (!game || game.gameOver) return;

    const player = game.players.find((p) => p.userId === currentUserId);
    if (!player || game.bombsUsed[player.number]) return;

    player.socketId = socket.id;

    game.bombsUsed[player.number] = true;
    revealArea(game.board, x, y, player.number, game.scores);

    if (checkGameOver(game.scores)) game.gameOver = true;
    else game.turn = game.turn === 1 ? 2 : 1;

    console.log(`Player ${player.name} used bomb at ${x},${y}. New scores: P1: ${game.scores[1]}, P2: ${game.scores[2]}`);

    game.players.forEach(p => {
        if (p.socketId) {
            io.to(p.socketId).emit("board-update", game);
        }
    });
  });

  socket.on("restart-game", ({ gameId }) => {
    const currentUserId = socket.request.user ? socket.request.user.id : null;
    if (!currentUserId) {
        console.warn(`Manual restart: Unauthenticated user for socket ${socket.id}.`);
        return;
    }

    const game = games[gameId];
    if (!game) return;
    
    const requestingPlayer = game.players.find(p => p.userId === currentUserId);
    if (!requestingPlayer) return;

    requestingPlayer.socketId = socket.id;

    console.log(`Manual restart requested by ${requestingPlayer.name} for game ${gameId}.`);

    game.board = generateBoard();
    game.scores = { 1: 0, 2: 0 };
    game.bombsUsed = { 1: false, 2: false };
    game.turn = 1;
    game.gameOver = false;

    game.players.forEach(p => {
        if (p.socketId) {
            const opponentPlayer = game.players.find(op => op.userId !== p.userId);
            io.to(p.socketId).emit("game-restarted", {
                gameId: game.gameId,
                playerNumber: p.number,
                board: game.board,
                turn: game.turn,
                scores: game.scores,
                bombsUsed: game.bombsUsed,
                gameOver: game.gameOver,
                opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
            });
        }
    });
  });

  socket.on("leave-game", ({ gameId }) => {
    const currentUserId = socket.request.user ? socket.request.user.id : null;
    if (!currentUserId) {
        console.warn(`Leave game: Unauthenticated user for socket ${socket.id}.`);
        return;
    }

    const game = games[gameId];
    if (game && currentUserId) {
      const playerIndex = game.players.findIndex(p => p.userId === currentUserId);
      if (playerIndex !== -1) {
        delete userGameMap[currentUserId];
        console.log(`User ${currentUserId} (${game.players[playerIndex].name}) left game ${gameId}.`);

        game.players.splice(playerIndex, 1);

        if (game.players.length === 0) {
          delete games[gameId];
          console.log(`Game ${gameId} deleted as no players remain.`);
        } else {
          const remainingPlayer = game.players[0];
          if (remainingPlayer && remainingPlayer.socketId) {
             io.to(remainingPlayer.socketId).emit("opponent-left");
             console.log(`Notified opponent ${remainingPlayer.name} that their partner left.`);
          }
        }
      }
    }
    if (currentUserId) {
        players = players.filter(p => p.userId !== currentUserId);
        const userDisplayName = socket.request.user ? socket.request.user.displayName : `User_${currentUserId.substring(0, 8)}`;
        players.push({ id: socket.id, userId: currentUserId, name: userDisplayName });
    }
    io.emit("players-list", players.filter(p => !userGameMap[p.userId]).map(p => ({ id: p.id, name: p.name })));
  });


  socket.on("disconnect", () => {
    console.log(`Socket disconnected: ${socket.id}`);
    const disconnectedUserId = socket.request.user ? socket.request.user.id : null;

    if (disconnectedUserId) {
        delete userSocketMap[disconnectedUserId];
        console.log(`User ${disconnectedUserId} socket removed from map.`);
    }

    players = players.filter(p => p.id !== socket.id && p.userId !== disconnectedUserId);
    io.emit("players-list", players.filter(p => !userGameMap[p.userId]).map(p => ({ id: p.id, name: p.name })));

    for (const gameId in games) {
        const game = games[gameId];
        const playerIndex = game.players.findIndex(p => p.socketId === socket.id || (disconnectedUserId && p.userId === disconnectedUserId));
        if (playerIndex !== -1) {
            console.log(`Player ${game.players[playerIndex].name} (${game.players[playerIndex].userId}) disconnected from game ${gameId}.`);
            
            if (game.players[playerIndex].userId) {
                delete userGameMap[game.players[playerIndex].userId];
            }

            game.players.splice(playerIndex, 1);

            if (game.players.length === 0) {
                delete games[gameId];
                console.log(`Game ${gameId} deleted as no players remain after disconnect.`);
            } else {
                const remainingPlayer = game.players[0];
                if (remainingPlayer && remainingPlayer.socketId) {
                    io.to(remainingPlayer.socketId).emit("opponent-left");
                    console.log(`Notified opponent ${remainingPlayer.name} that their partner disconnected.`);
                } else {
                    console.warn(`Remaining player in game ${gameId} has no active socket to notify.`);
                }
            }
        }
    }
  });

});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
