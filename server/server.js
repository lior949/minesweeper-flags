// server.js

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const passport = require("passport");
const session = require("express-session");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const FacebookStrategy = require("passport-facebook").Strategy;
const { v4: uuidv4 } = require("uuid"); // Ensure you have 'uuid' installed: npm install uuid

const app = express();
const server = http.createServer(app);

// New global data structures (still in-memory, not persistent)
const userSocketMap = {}; // Maps userId to current socket.id
const userGameMap = {};   // Maps userId to current gameId

app.use(cors({
    origin: "https://minesweeper-flags-frontend.onrender.com",
    credentials: true,
}));

const io = new Server(server, {
  cors: {
    origin: "https://minesweeper-flags-frontend.onrender.com",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.set('trust proxy', 1);

const FACEBOOK_CLIENT_ID = process.env.FACEBOOK_CLIENT_ID;
const FACEBOOK_CLIENT_SECRET = process.env.FACEBOOK_CLIENT_SECRET;

// Define the session middleware instance ONCE
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    sameSite: "none",
    secure: process.env.NODE_ENV === 'production', // true only if using HTTPS
    maxAge: 1000 * 60 * 60 * 24
  },
});

// === Apply session middleware to Express ===
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

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/google/callback"
}, (accessToken, refreshToken, profile, done) => {
  // Store the profile.id as the userId in the session
  // For `req.user` to have displayName, you need to return an object from deserializeUser.
  done(null, profile.id); // Storing just the ID
}));

passport.use(new FacebookStrategy({
    clientID: FACEBOOK_CLIENT_ID,
    clientSecret: FACEBOOK_CLIENT_SECRET,
    callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/facebook/callback",
    profileFields: ['id', 'displayName', 'photos', 'email']
  },
  function(accessToken, refreshToken, profile, cb) {
    cb(null, profile.id); // Storing just the ID
  }
));

// Deserialize user to return an object with id and displayName
// This helps `socket.request.user` and `req.user` have the `displayName`.
passport.serializeUser((userId, done) => {
  done(null, userId);
});

passport.deserializeUser((userId, done) => {
  // In a real app, you'd look up the user's full data (including displayName) from a DB
  // For now, we construct an object with a default display name.
  done(null, { id: userId, displayName: `User_${userId.substring(0, 8)}` });
});

// === Routes ===
app.get("/auth/facebook",
  passport.authenticate("facebook", { scope: ['public_profile'] })
);

app.get("/auth/facebook/callback",
  passport.authenticate("facebook", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com/login-failed",
    successRedirect: "https://minesweeper-flags-frontend.onrender.com",
  })
);

app.get("/auth/google",
  passport.authenticate("google", { scope: ["profile"] })
);

app.get("/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com",
    successRedirect: "https://minesweeper-flags-frontend.onrender.com",
  })
);

app.get("/logout", (req, res) => {
  req.logout((err) => { // Passport's logout method
    if (err) { // Handle potential errors from logout
        console.error("Logout error:", err);
        return res.status(500).send("Logout failed.");
    }
    req.session.destroy((destroyErr) => {
      if (destroyErr) {
          console.error("Session destroy error:", destroyErr);
          return res.status(500).send("Logout failed.");
      }
      res.clearCookie("connect.sid", {
          path: '/',
          domain: '.onrender.com', // Crucial for clearing cross-domain cookies
          secure: true,
          sameSite: 'none'
      });
      res.status(200).send("Logged out successfully");
    });
  });
});

app.get("/login-failed", (req, res) => {
  res.send("Login failed");
});

app.get("/me", (req, res) => {
  if (req.isAuthenticated() && req.user) { // Check req.user exists as an object
    // req.user is now { id: userId, displayName: ... }
    res.json({ user: { id: req.user.id, displayName: req.user.displayName } });
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
});

const WIDTH = 16;
const HEIGHT = 16;
const MINES = 51;

let players = []; // { id: socket.id, name, number, inGame, userId }
let games = {}; // gameId: { players: [player1, player2], board, scores, bombsUsed, turn, gameOver }

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
  const tile = board[y]?.[x];
  if (!tile || tile.revealed) return;
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

const revealArea = (board, cx, cy, player, scores) => {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) {
        const tile = board[y][x];
        if (!tile.revealed) {
          if (tile.isMine) {
            tile.revealed = true;
            tile.owner = player;
            scores[player]++;
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

io.on("connection", (socket) => {
  console.log(`Socket Connected: ${socket.id}`);

  // Safely get userId and displayName from socket.request.user
  const userIdOnConnect = socket.request.user ? socket.request.user.id : null;
  const userNameOnConnect = socket.request.user ? socket.request.user.displayName : null;

  if (userIdOnConnect) {
      console.log(`User ${userNameOnConnect} (${userIdOnConnect}) connected via socket.`);
      userSocketMap[userIdOnConnect] = socket.id; // Store current socket ID for this user

      // Check if this user was already in a game and re-send game state
      if (userGameMap[userIdOnConnect]) {
          const gameId = userGameMap[userIdOnConnect];
          const game = games[gameId];
          if (game) {
              const playerInGame = game.players.find(p => p.userId === userIdOnConnect);
              if (playerInGame) {
                  playerInGame.socketId = socket.id; // Update socketId in game object
                  const opponentPlayer = game.players.find(op => op.userId !== userIdOnConnect);
                  socket.emit("game-start", {
                      gameId: game.gameId,
                      playerNumber: playerInGame.number,
                      board: game.board,
                      turn: game.turn,
                      scores: game.scores,
                      bombsUsed: game.bombsUsed,
                      gameOver: game.gameOver,
                      opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
                  });
                  console.log(`Re-sent game state to reconnected user ${userNameOnConnect} in game ${gameId}.`);
                  if (opponentPlayer && opponentPlayer.socketId) {
                      io.to(opponentPlayer.socketId).emit("opponent-reconnected", { name: userNameOnConnect });
                  }
              }
          } else {
              delete userGameMap[userIdOnConnect]; // Clear map if game no longer exists
          }
      }
  } else {
      console.log(`Unauthenticated socket ${socket.id} connected.`);
  }


  // Authentication & lobby join
  socket.on("join-lobby", (name) => {
    // Crucial: Get the authenticated user ID from `socket.request.user`
    const userId = socket.request.user ? socket.request.user.id : null;
    const userDisplayName = socket.request.user ? socket.request.user.displayName : null;

    if (!userId) {
      // Reject if not authenticated
      socket.emit("join-error", "Authentication required to join lobby. Please login first.");
      console.warn(`Attempt to join lobby from unauthenticated socket ${socket.id}. Rejected.`);
      return;
    }

    if (!name || name.trim() === "") {
        socket.emit("join-error", "Name cannot be empty.");
        return;
    }

    // Ensure only one entry per userId in the players list, update socket.id and name if already present
    let playerEntry = players.find(p => p.userId === userId);

    if (playerEntry) {
      playerEntry.id = socket.id; // Update socket ID
      playerEntry.name = userDisplayName || name; // Update name, prefer displayName from Passport
      playerEntry.inGame = false; // Ensure they are in lobby, not in a stale game
      playerEntry.number = null;
      console.log(`Player ${playerEntry.name} (ID: ${userId}) re-joined lobby with new socket ID.`);
    } else {
      // New player for this userId
      players.push({ id: socket.id, userId: userId, name: userDisplayName || name, number: null, inGame: false });
      console.log(`New player ${userDisplayName || name} (ID: ${userId}) joined lobby.`);
    }

    userSocketMap[userId] = socket.id; // Ensure userSocketMap is up-to-date

    socket.emit("lobby-joined", userDisplayName || name);

    // Filter players for lobby list: only those not in a game
    io.emit(
      "players-list",
      players.filter((p) => !p.inGame && !userGameMap[p.userId]).map((p) => ({ id: p.id, name: p.name }))
    );
  });

  socket.on("leave-game", ({ gameId }) => {
    const userId = socket.request.user ? socket.request.user.id : null;
    if (!userId) return; // Must be authenticated to leave game

    const leavingPlayer = players.find((p) => p.userId === userId);
    if (!leavingPlayer) {
      console.log(`Player with ID ${userId} not found on leave-game.`);
      return;
    }

    leavingPlayer.inGame = false;
    leavingPlayer.number = null;
    delete userGameMap[userId]; // Remove from userGameMap

    console.log(`Player ${leavingPlayer.name} (ID: ${userId}) left game ${gameId}.`);

    const game = games[gameId];
    if (game) {
      // Filter out the leaving player from the game's player list
      game.players = game.players.filter(p => p.userId !== userId);

      if (game.players.length === 0) {
        delete games[gameId];
        console.log(`Game ${gameId} deleted as no players remain.`);
      } else {
        // Notify the remaining player
        const opponent = game.players[0]; // The remaining player
        if (opponent && opponent.socketId) {
            io.to(opponent.socketId).emit("opponent-left");
            // Mark opponent as not in game and reset their number
            const opponentGlobalEntry = players.find(p => p.userId === opponent.userId);
            if(opponentGlobalEntry) {
                opponentGlobalEntry.inGame = false;
                opponentGlobalEntry.number = null;
                delete userGameMap[opponent.userId]; // Remove opponent from userGameMap
            }
        }
        delete games[gameId]; // End the game for the other player too
      }
    }

    io.emit(
      "players-list",
      players.filter((p) => !p.inGame && !userGameMap[p.userId]).map((p) => ({ id: p.id, name: p.name }))
    );
  });

  socket.on("invite-player", (targetId) => {
    const inviterUserId = socket.request.user ? socket.request.user.id : null;
    const inviter = players.find((p) => p.userId === inviterUserId);
    const invitee = players.find((p) => p.id === targetId); // TargetId is socket.id here for the frontend list

    if (!inviter || !invitee) return;
    if (inviter.inGame || invitee.inGame || userGameMap[inviter.userId] || userGameMap[invitee.userId]) {
        console.warn(`Invite failed: Inviter or invitee already in game or already mapped.`);
        return;
    }

    // Use current socket.id for invitee for emit
    io.to(invitee.id).emit("game-invite", {
      fromId: inviter.id, // inviter's socket.id
      fromName: inviter.name,
    });
    console.log(`Invite sent from ${inviter.name} (${inviter.userId}) to ${invitee.name} (${invitee.userId || invitee.id}).`);
  });

  socket.on("respond-invite", ({ fromId, accept }) => {
    const responderUserId = socket.request.user ? socket.request.user.id : null;
    const responder = players.find((p) => p.userId === responderUserId);
    const inviter = players.find((p) => p.id === fromId); // fromId is inviter's socket.id

    if (!responder || !inviter) return;

    // Double check if either player is already in a game via userGameMap
    if (userGameMap[responder.userId] || userGameMap[inviter.userId]) {
        console.warn("Respond invite failed: One or both players already in a game via userGameMap.");
        io.to(responder.id).emit("invite-rejected", { fromName: inviter.name, reason: "Already in another game" });
        io.to(inviter.id).emit("invite-rejected", { fromName: responder.name, reason: "Already in another game" });
        return;
    }


    if (accept) {
      const gameId = uuidv4(); // Use UUID for unique game IDs
      const board = generateBoard();
      const scores = { 1: 0, 2: 0 };
      const bombsUsed = { 1: false, 2: false };
      const turn = 1;
      const gameOver = false;

      // Assign players numbers and mark inGame, store userId and current socketId
      inviter.number = 1;
      inviter.inGame = true;
      inviter.socketId = inviter.id; // Store current socket ID
      responder.number = 2;
      responder.inGame = true;
      responder.socketId = responder.id; // Store current socket ID

      games[gameId] = {
        players: [inviter, responder], // players array in game now includes userId and socketId
        board,
        scores,
        bombsUsed,
        turn,
        gameOver,
      };

      userGameMap[inviter.userId] = gameId; // Map userId to gameId
      userGameMap[responder.userId] = gameId;

      console.log(`Game ${gameId} started between ${inviter.name} (ID: ${inviter.userId}) and ${responder.name} (ID: ${responder.userId}).`);

      // Filter global players list to remove those who are now in a game
      io.emit(
        "players-list",
        players.filter((p) => !p.inGame && !userGameMap[p.userId]).map((p) => ({ id: p.id, name: p.name }))
      );

      // Notify players game started with initial state
      io.to(inviter.id).emit("game-start", {
        playerNumber: inviter.number,
        board,
        turn,
        scores,
        bombsUsed,
        gameOver,
        opponentName: responder.name,
        gameId,
      });
      io.to(responder.id).emit("game-start", {
        playerNumber: responder.number,
        board,
        turn,
        scores,
        bombsUsed,
        gameOver,
        opponentName: inviter.name,
        gameId,
      });

    } else {
      io.to(fromId).emit("invite-rejected", { fromName: responder.name });
    }
  });

  // Handle game actions
  socket.on("tile-click", ({ gameId, x, y }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const currentUserId = socket.request.user ? socket.request.user.id : null;
    const player = game.players.find((p) => p.userId === currentUserId);
    if (!player || player.number !== game.turn) return;

    player.socketId = socket.id; // Ensure player's socketId in game object is current

    const tile = game.board[y][x];
    if (tile.revealed) return;

    if (tile.isMine) {
      tile.revealed = true;
      tile.owner = player.number;
      game.scores[player.number]++;
      if (checkGameOver(game.scores)) game.gameOver = true;
    } else {
      revealRecursive(game.board, x, y);
      game.turn = game.turn === 1 ? 2 : 1;
    }

    game.players.forEach(p => {
        if(p.socketId) io.to(p.socketId).emit("board-update", game);
    });
  });

  socket.on("use-bomb", ({ gameId }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const currentUserId = socket.request.user ? socket.request.user.id : null;
    const player = game.players.find((p) => p.userId === currentUserId);
    if (!player || game.bombsUsed[player.number]) return;

    player.socketId = socket.id; // Ensure player's socketId in game object is current

    io.to(player.id).emit("wait-bomb-center");
  });

  socket.on("bomb-center", ({ gameId, x, y }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const currentUserId = socket.request.user ? socket.request.user.id : null;
    const player = game.players.find((p) => p.userId === currentUserId);
    if (!player || game.bombsUsed[player.number]) return;

    player.socketId = socket.id; // Ensure player's socketId in game object is current

    game.bombsUsed[player.number] = true;
    revealArea(game.board, x, y, player.number, game.scores);

    if (checkGameOver(game.scores)) game.gameOver = true;
    else game.turn = game.turn === 1 ? 2 : 1;

    game.players.forEach(p => {
        if(p.socketId) io.to(p.socketId).emit("board-update", game);
    });
  });

  socket.on("restart-game", ({ gameId }) => {
    const game = games[gameId];
    if (!game) return;

    const currentUserId = socket.request.user ? socket.request.user.id : null;
    const player = game.players.find((p) => p.userId === currentUserId);
    if (!player) return;

    player.socketId = socket.id; // Ensure player's socketId in game object is current

    console.log(`Player ${player.name} requested game ${gameId} restart.`);

    game.board = generateBoard();
    game.scores = { 1: 0, 2: 0 };
    game.bombsUsed = { 1: false, 2: false };
    game.turn = 1;
    game.gameOver = false;

    game.players.forEach(p => {
        if(p.socketId) io.to(p.socketId).emit("board-update", game);
    });
  });

  socket.on("disconnect", () => {
    const disconnectedUserId = socket.request.user ? socket.request.user.id : null;
    console.log(`Socket disconnected: ${socket.id}. UserID: ${disconnectedUserId || 'N/A'}`);

    if (disconnectedUserId) {
        delete userSocketMap[disconnectedUserId]; // Remove from active socket map
        // If they were in a game, they remain in userGameMap, to allow re-connection
    }

    // Remove from players list (lobby-only, if not in game)
    players = players.filter((p) => p.id !== socket.id); // Filter by socket.id for general cleanup

    // Update lobby player list
    io.emit(
      "players-list",
      players.filter((p) => !p.inGame && !userGameMap[p.userId]).map((p) => ({ id: p.id, name: p.name }))
    );

    // Check if the disconnected user was in a game
    if (disconnectedUserId && userGameMap[disconnectedUserId]) {
        const gameId = userGameMap[disconnectedUserId];
        const game = games[gameId];
        if (game) {
            // Find and remove the disconnected player from the game's players array
            game.players = game.players.filter(p => p.userId !== disconnectedUserId);

            if (game.players.length === 0) {
                // If no players left, delete the game
                delete games[gameId];
                console.log(`Game ${gameId} deleted as no players remain after disconnect.`);
            } else {
                // Notify the remaining player
                const remainingPlayer = game.players[0];
                if (remainingPlayer && remainingPlayer.socketId) {
                    io.to(remainingPlayer.socketId).emit("opponent-left");
                    // Also clear their game state in the global players and userGameMap
                    const opponentGlobalEntry = players.find(p => p.userId === remainingPlayer.userId);
                    if(opponentGlobalEntry) {
                        opponentGlobalEntry.inGame = false;
                        opponentGlobalEntry.number = null;
                    }
                    delete userGameMap[remainingPlayer.userId];
                }
                delete games[gameId]; // End the game for the other player too
            }
        }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
