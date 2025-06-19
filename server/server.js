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

// --- Firebase Admin SDK Imports ---
const admin = require('firebase-admin');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');

const app = express();
const server = http.createServer(app);

app.use(cors());

const io = new Server(server, {
  cors: {
    origin: "https://minesweeper-flags-frontend.onrender.com",
    methods: ["GET", "POST"],
    credentials: true, // Allow cookies for Socket.IO handshake
  },
});

app.use(
  cors({
    origin: "https://minesweeper-flags-frontend.onrender.com", // your frontend
    credentials: true, // allow cookies for HTTP requests
  })
);

// === Session middleware ===
// IMPORTANT: This uses the default in-memory session store.
// For production, consider a persistent store like Redis (as previously discussed).
app.use(
  session({
    secret: process.env.SESSION_SECRET, // Make sure SESSION_SECRET is set in Render env vars
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: "none",
      secure: true,	
    },
  })
);

app.set('trust proxy', 1);

const FACEBOOK_CLIENT_ID = process.env.FACEBOOK_CLIENT_ID;
const FACEBOOK_CLIENT_SECRET = process.env.FACEBOOK_CLIENT_SECRET;

// === Passport config ===
app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/google/callback"
}, (accessToken, refreshToken, profile, done) => {
  // Store the profile object directly. `profile.id` will be unique for Google users.
  return done(null, profile);
}));

passport.use(new FacebookStrategy({
    clientID: FACEBOOK_CLIENT_ID,
    clientSecret: FACEBOOK_CLIENT_SECRET,
    callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/facebook/callback",
    profileFields: ['id', 'displayName', 'photos', 'email']
  },
  function(accessToken, refreshToken, profile, cb) {
    // Store the profile object directly. `profile.id` will be unique for Facebook users.
    return cb(null, profile);
  }
));

// Passport Serialization/Deserialization
// We store the full profile object (or at least id and display name)
passport.serializeUser((user, done) => {
  done(null, { id: user.id, displayName: user.displayName }); // Store minimal necessary info
});
passport.deserializeUser((obj, done) => {
  done(null, obj); // Retrieve the object
});

// === Initialize Firebase Admin SDK ===
// IMPORTANT: Use environment variable for service account key in production (e.g., Render)
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("Firebase Admin SDK initialized.");
} catch (error) {
  console.error("Failed to initialize Firebase Admin SDK. Ensure FIREBASE_SERVICE_ACCOUNT_KEY env var is set and valid JSON.", error);
  // Exit process if Firebase fails to initialize, as database operations will fail
  process.exit(1);
}

const db = getFirestore();
// Define the base collection path for games. Use __app_id if available, otherwise a default.
// Render provides __app_id automatically in the environment.
const APP_ID = process.env.RENDER_APP_ID || "minesweeper-flags-default-app"; // Using a unique default if not on Render
const GAMES_COLLECTION_PATH = `artifacts/${APP_ID}/public/data/minesweeperGames`;


// === Authentication Routes ===
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
  req.logout((err) => {
    if (err) {
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
  if (req.isAuthenticated() && req.user) {
    // req.user will be the object { id: userId, displayName: ... } from deserializeUser
    res.json({ user: req.user });
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
});

// --- Game Constants ---
const WIDTH = 16;
const HEIGHT = 16;
const MINES = 51;

// Global Game Data Structures (in-memory, for currently active games/lobby)
let players = []; // Lobby players: { id: socket.id, name, number, inGame, userId }
let games = {}; // Active games: gameId: { players: [player1, player2], board, scores, bombsUsed, turn, gameOver }

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

// Helper for recursive reveal of blank areas
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

// Helper for bomb ability 5x5 reveal
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

  // Safely get userId and displayName from socket.request.user if authenticated
  const currentUserId = socket.request.user ? socket.request.user.id : null;
  const currentUserName = socket.request.user ? socket.request.user.displayName : null;

  if (!currentUserId) {
    console.log(`Unauthenticated socket ${socket.id} connected. (No req.user)`);
    // Consider emitting an event to the client to inform them they are not authenticated
    // socket.emit("auth-status", { authenticated: false });
  } else {
    console.log(`User ${currentUserName} (${currentUserId}) connected via socket: ${socket.id}`);
    // Map userId to socket.id for quick lookup and re-association
    players = players.filter(p => p.userId !== currentUserId); // Remove old socket if user reconnected
    players.push({ id: socket.id, userId: currentUserId, name: currentUserName, number: null, inGame: false });
  }


  socket.on("join-lobby", (name) => {
    // Authenticate the request based on the passport session
    const userId = socket.request.user ? socket.request.user.id : null;
    const userName = socket.request.user ? socket.request.user.displayName : name; // Use display name from passport if available

    if (!userId) {
      socket.emit("join-error", "Authentication required to join lobby. Please login first.");
      console.warn(`Attempt to join lobby from unauthenticated socket ${socket.id}. Rejected.`);
      return;
    }

    if (!userName || userName.trim() === "") {
        socket.emit("join-error", "Name cannot be empty.");
        return;
    }

    // Update or add player to the global 'players' list
    let playerEntry = players.find(p => p.userId === userId);
    if (playerEntry) {
      playerEntry.id = socket.id; // Update socket ID on re-join
      playerEntry.name = userName;
      playerEntry.inGame = false;
      playerEntry.number = null;
      console.log(`Player ${userName} (ID: ${userId}) re-joined lobby with new socket ID.`);
    } else {
      players.push({ id: socket.id, userId: userId, name: userName, number: null, inGame: false });
      console.log(`New player ${userName} (ID: ${userId}) joined lobby.`);
    }

    socket.emit("lobby-joined", userName);

    // Filter players for lobby list: only those not currently in a game
    io.emit(
      "players-list",
      players.filter((p) => !p.inGame && !Object.values(games).some(g => g.players.some(gp => gp.userId === p.userId))).map((p) => ({ id: p.id, name: p.name }))
    );
  });

  // --- NEW: Request unfinished games from Firestore ---
  socket.on("request-unfinished-games", async () => {
    const userId = socket.request.user ? socket.request.user.id : null;
    if (!userId) {
        // This shouldn't happen if frontend waits for auth, but good to check
        socket.emit("join-error", "Authentication required to fetch games.");
        return;
    }

    try {
        const querySnapshot = await db.collection(GAMES_COLLECTION_PATH)
            .where('status', 'in', ['active', 'waiting_for_resume']) // 'active' for games that might be paused, 'waiting_for_resume' for abandoned
            .where('player1_userId', '==', userId)
            .get();

        const querySnapshot2 = await db.collection(GAMES_COLLECTION_PATH)
            .where('status', 'in', ['active', 'waiting_for_resume'])
            .where('player2_userId', '==', userId)
            .get();

        let unfinishedGames = [];

        querySnapshot.forEach(doc => {
            const gameData = doc.data();
            // Ensure this game isn't already actively loaded in memory for this player (avoid duplicates)
            const isCurrentlyActiveInMemory = Object.values(games).some(g => g.gameId === gameData.gameId && g.players.some(p => p.userId === userId && p.id === socket.id));
            if (!isCurrentlyActiveInMemory) {
                unfinishedGames.push({
                    gameId: gameData.gameId,
                    opponentName: gameData.player2_name, // If player1, opponent is player2
                    myPlayerNumber: 1,
                    status: gameData.status,
                    lastUpdated: gameData.lastUpdated ? gameData.lastUpdated.toDate().toLocaleString() : 'N/A'
                });
            }
        });

        querySnapshot2.forEach(doc => {
            const gameData = doc.data();
            const isCurrentlyActiveInMemory = Object.values(games).some(g => g.gameId === gameData.gameId && g.players.some(p => p.userId === userId && p.id === socket.id));
            if (!isCurrentlyActiveInMemory) {
                unfinishedGames.push({
                    gameId: gameData.gameId,
                    opponentName: gameData.player1_name, // If player2, opponent is player1
                    myPlayerNumber: 2,
                    status: gameData.status,
                    lastUpdated: gameData.lastUpdated ? gameData.lastUpdated.toDate().toLocaleString() : 'N/A'
                });
            }
        });

        // Filter out any potential duplicates if a game appeared in both queries
        const uniqueGames = Array.from(new Map(unfinishedGames.map(item => [item.gameId, item])).values());

        socket.emit("receive-unfinished-games", uniqueGames);
        console.log(`Sent ${uniqueGames.length} unfinished games to user ${userName}.`);

    } catch (error) {
        console.error("Error fetching unfinished games for user:", userId, error);
        socket.emit("join-error", "Failed to load your unfinished games."); // Use join-error for general lobby errors
    }
  });

  // --- NEW: Resume game from Firestore ---
  socket.on("resume-game", async ({ gameId }) => {
    const userId = socket.request.user ? socket.request.user.id : null;
    const userName = socket.request.user ? socket.request.user.displayName : 'Unknown Player';

    if (!userId) {
        socket.emit("join-error", "Authentication required to resume game.");
        return;
    }

    try {
        const gameDocRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
        const gameDoc = await gameDocRef.get();

        if (!gameDoc.exists) {
            socket.emit("join-error", "Game not found or already ended.");
            return;
        }

        const gameData = gameDoc.data();

        // Ensure user is one of the players in this game
        if (gameData.player1_userId !== userId && gameData.player2_userId !== userId) {
            socket.emit("join-error", "You are not a participant in this game.");
            return;
        }

        // Check if the game is already active in server memory (someone else resumed it or reconnect)
        if (games[gameId]) {
            const existingGame = games[gameId];
            const playerInExistingGame = existingGame.players.find(p => p.userId === userId);
            if (playerInExistingGame && playerInExistingGame.id === socket.id) {
                // Already in this game with this socket, just re-send state (e.g., reconnect flow)
                const opponentPlayer = existingGame.players.find(op => op.userId !== userId);
                socket.emit("game-start", {
                    gameId: existingGame.gameId,
                    playerNumber: playerInExistingGame.number,
                    board: existingGame.board,
                    turn: existingGame.turn,
                    scores: existingGame.scores,
                    bombsUsed: existingGame.bombsUsed,
                    gameOver: existingGame.gameOver,
                    opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
                });
                console.log(`User ${userName} re-sent active game state for game ${gameId}.`);
                return;
            } else if (existingGame.players.some(p => p.userId === userId && p.id !== socket.id)) {
                // User trying to resume with a different socket, update it
                const playerToUpdate = existingGame.players.find(p => p.userId === userId);
                if(playerToUpdate) playerToUpdate.id = socket.id;
                userSocketMap[userId] = socket.id; // Update mapping

                 const opponentPlayer = existingGame.players.find(op => op.userId !== userId);
                 socket.emit("game-start", {
                    gameId: existingGame.gameId,
                    playerNumber: playerToUpdate.number,
                    board: existingGame.board,
                    turn: existingGame.turn,
                    scores: existingGame.scores,
                    bombsUsed: existingGame.bombsUsed,
                    gameOver: existingGame.gameOver,
                    opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
                });
                 if (opponentPlayer && opponentPlayer.id) {
                    io.to(opponentPlayer.id).emit("opponent-reconnected", { name: userName });
                 }
                 console.log(`User ${userName} re-associated socket ID for active game ${gameId}.`);
                 return;
            } else {
                 socket.emit("join-error", "Game is already active in memory for another player or user is in another game.");
                 console.warn(`User ${userName} tried to resume game ${gameId} but it's already active or user is in another game.`);
                 return;
            }
        }

        // Reconstruct the in-memory game object from Firestore data
        const game = {
            gameId: gameData.gameId,
            board: gameData.board,
            scores: gameData.scores,
            bombsUsed: gameData.bombsUsed,
            turn: gameData.turn,
            gameOver: gameData.gameOver,
            // Players array will be populated below based on current socket state
            players: []
        };

        // Find/create player objects for the in-memory game instance, updating their socket IDs
        let player1 = players.find(p => p.userId === gameData.player1_userId);
        if (!player1) { // Player1 not in current global players list (e.g. they disconnected)
            player1 = {
                id: (gameData.player1_userId === userId) ? socket.id : userSocketMap[gameData.player1_userId] || null,
                userId: gameData.player1_userId,
                name: gameData.player1_name,
                number: 1,
                inGame: true,
            };
            players.push(player1); // Add to global list
        } else {
            player1.id = (gameData.player1_userId === userId) ? socket.id : userSocketMap[gameData.player1_userId] || player1.id;
            player1.inGame = true;
            player1.number = 1;
        }

        let player2 = players.find(p => p.userId === gameData.player2_userId);
        if (!player2) { // Player2 not in current global players list
            player2 = {
                id: (gameData.player2_userId === userId) ? socket.id : userSocketMap[gameData.player2_userId] || null,
                userId: gameData.player2_userId,
                name: gameData.player2_name,
                number: 2,
                inGame: true,
            };
            players.push(player2); // Add to global list
        } else {
            player2.id = (gameData.player2_userId === userId) ? socket.id : userSocketMap[gameData.player2_userId] || player2.id;
            player2.inGame = true;
            player2.number = 2;
        }

        game.players = [player1, player2];
        games[gameId] = game; // Store in-memory active game

        // Update the game status in Firestore to 'active' if it was 'waiting_for_resume'
        if (gameData.status === 'waiting_for_resume') {
            await gameDocRef.update({ status: 'active', lastUpdated: Timestamp.now() });
            console.log(`Game ${gameId} status updated to 'active' in Firestore.`);
        }

        // Send game-start to both players (if they are connected)
        [player1, player2].forEach(p => {
            if (p.id) { // Ensure socket ID exists
                const opponentPlayer = game.players.find(op => op.userId !== p.userId);
                io.to(p.id).emit("game-start", {
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

        // If resuming a game, remove players from the lobby list
        io.emit("players-list", players.filter(p => !p.inGame).map(p => ({ id: p.id, name: p.name })));
        console.log(`User ${userName} successfully resumed game ${gameId}.`);

    } catch (error) {
        console.error("Error resuming game:", error);
        socket.emit("join-error", "Failed to resume game. " + error.message);
    }
  });


  socket.on("leave-game", async ({ gameId }) => {
    const userId = socket.request.user ? socket.request.user.id : null;
    if (!userId) return;

    const leavingPlayer = players.find((p) => p.userId === userId);
    if (!leavingPlayer) {
      console.log(`Player with ID ${userId} not found in global list on leave-game.`);
      return;
    }

    // Mark player as not in game globally
    leavingPlayer.inGame = false;
    leavingPlayer.number = null;

    console.log(`Player ${leavingPlayer.name} (ID: ${userId}) initiating leave from game ${gameId}.`);

    const game = games[gameId];
    if (game) {
        // Find the opponent
        const opponent = game.players.find(p => p.userId !== userId);

        if (opponent) {
            // Notify opponent that their partner left
            if (opponent.id) { // Check if opponent socket is still active
                io.to(opponent.id).emit("opponent-left");
                console.log(`Notified opponent ${opponent.name} that ${leavingPlayer.name} left.`);
            }
            // Update opponent's status in global players list if found
            const opponentGlobalEntry = players.find(p => p.userId === opponent.userId);
            if(opponentGlobalEntry) {
                opponentGlobalEntry.inGame = false;
                opponentGlobalEntry.number = null;
            }

            // Update game status in Firestore
            await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
                status: 'waiting_for_resume', // Game is now waiting for the opponent to resume
                lastUpdated: Timestamp.now()
            });
            console.log(`Game ${gameId} status set to 'waiting_for_resume' in Firestore.`);

        } else {
            // No opponent left, meaning this player was the last one. Delete from DB.
            await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
                status: 'completed', // Or 'abandoned_single_player'
                lastUpdated: Timestamp.now()
            });
            console.log(`Game ${gameId} status set to 'completed' as last player left.`);
        }
        delete games[gameId]; // Remove game from in-memory active list
    }

    // Update lobby player list for all clients
    io.emit(
      "players-list",
      players.filter((p) => !p.inGame && !Object.values(games).some(g => g.players.some(gp => gp.userId === p.userId))).map((p) => ({ id: p.id, name: p.name }))
    );
  });

  socket.on("invite-player", (targetId) => {
    const inviterUserId = socket.request.user ? socket.request.user.id : null;
    const inviter = players.find((p) => p.userId === inviterUserId);
    const invitee = players.find((p) => p.id === targetId); // TargetId is socket.id here for the frontend list

    if (!inviter || !invitee) return;
    // Check if either player is already in a game (either in-memory or in userGameMap/Firestore based)
    const inviterInGame = Object.values(games).some(g => g.players.some(p => p.userId === inviter.userId));
    const inviteeInGame = Object.values(games).some(g => g.players.some(p => p.userId === invitee.userId));

    if (inviterInGame || inviteeInGame) {
        console.warn(`Invite failed: Inviter or invitee already in active game.`);
        // Notify inviter that invitee is busy
        io.to(inviter.id).emit("invite-rejected", { fromName: invitee.name, reason: "Player is currently in a game." });
        return;
    }

    io.to(invitee.id).emit("game-invite", {
      fromId: inviter.id, // inviter's socket.id
      fromName: inviter.name,
    });
    console.log(`Invite sent from ${inviter.name} (${inviter.userId}) to ${invitee.name} (${invitee.userId}).`);
  });

  socket.on("respond-invite", async ({ fromId, accept }) => {
    const responderUserId = socket.request.user ? socket.request.user.id : null;
    const responder = players.find((p) => p.userId === responderUserId);
    const inviter = players.find((p) => p.id === fromId); // fromId is inviter's socket.id

    if (!responder || !inviter) return;

    // Double check if either player is already in a game via active games or userGameMap
    const responderInGame = Object.values(games).some(g => g.players.some(p => p.userId === responder.userId));
    const inviterInGame = Object.values(games).some(g => g.players.some(p => p.userId === inviter.userId));

    if (responderInGame || inviterInGame) {
        console.warn("Respond invite failed: One or both players already in an active game.");
        io.to(responder.id).emit("invite-rejected", { fromName: inviter.name, reason: "Already in another game" });
        io.to(inviter.id).emit("invite-rejected", { fromName: responder.name, reason: "Already in another game" });
        return;
    }

    if (accept) {
      const gameId = uuidv4();
      const board = generateBoard();
      const scores = { 1: 0, 2: 0 };
      const bombsUsed = { 1: false, 2: false };
      const turn = 1;
      const gameOver = false;

      // Assign players numbers and mark inGame, store userId and current socketId
      // Ensure player objects passed to game contain userId
      inviter.number = 1;
      inviter.inGame = true;
      inviter.socketId = inviter.id; // Store current socket ID for active game management
      responder.number = 2;
      responder.inGame = true;
      responder.socketId = responder.id; // Store current socket ID for active game management

      const game = {
        gameId,
        board,
        scores,
        bombsUsed,
        turn,
        gameOver,
        players: [inviter, responder],
      };
      games[gameId] = game; // Store in-memory

      // --- Store new game in Firestore ---
      try {
          await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
              gameId: game.gameId,
              board: game.board,
              player1_userId: inviter.userId,
              player2_userId: responder.userId,
              player1_name: inviter.name,
              player2_name: responder.name,
              turn: game.turn,
              scores: game.scores,
              bombsUsed: game.bombsUsed,
              gameOver: game.gameOver,
              status: 'active', // New game is active
              lastUpdated: Timestamp.now(),
              winnerId: null,
              loserId: null
          });
          console.log(`Game ${gameId} saved to Firestore.`);
      } catch (error) {
          console.error("Error saving new game to Firestore:", error);
          // Potentially revert game start or notify players
          io.to(inviter.id).emit("join-error", "Failed to start game (DB error).");
          io.to(responder.id).emit("join-error", "Failed to start game (DB error).");
          delete games[gameId]; // Clean up in-memory game
          return;
      }

      console.log(`Game ${gameId} started between ${inviter.name} (ID: ${inviter.userId}) and ${responder.name} (ID: ${responder.userId}).`);

      // Update lobby player list
      io.emit(
        "players-list",
        players.filter((p) => !p.inGame).map((p) => ({ id: p.id, name: p.name }))
      );

      // Notify players game started with initial state
      [inviter, responder].forEach((p) => {
        io.to(p.id).emit("game-start", {
          playerNumber: p.number,
          board,
          turn,
          scores,
          bombsUsed,
          gameOver,
          opponentName:
            p.id === inviter.id ? responder.name : inviter.name,
          gameId,
        });
      });

    } else {
      io.to(fromId).emit("invite-rejected", { fromName: responder.name });
    }
  });

  // Handle game actions
  socket.on("tile-click", async ({ gameId, x, y }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const currentUserId = socket.request.user ? socket.request.user.id : null;
    const player = game.players.find((p) => p.userId === currentUserId);
    if (!player || player.number !== game.turn) return;

    player.id = socket.id; // Update player's current socket ID in the game object

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

    // --- Update game state in Firestore ---
    try {
        const gameDocRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
        await gameDocRef.update({
            board: game.board,
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastUpdated: Timestamp.now(),
            winnerId: game.gameOver ? (game.scores[1] > game.scores[2] ? game.players[0].userId : game.players[1].userId) : null,
            loserId: game.gameOver ? (game.scores[1] < game.scores[2] ? game.players[0].userId : game.players[1].userId) : null
        });
        console.log(`Game ${gameId} updated in Firestore (tile-click).`);
    } catch (error) {
        console.error("Error updating game in Firestore (tile-click):", error);
    }

    game.players.forEach(p => {
        if(p.id) io.to(p.id).emit("board-update", game);
    });
  });

  socket.on("use-bomb", ({ gameId }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const currentUserId = socket.request.user ? socket.request.user.id : null;
    const player = game.players.find((p) => p.userId === currentUserId);
    if (!player || game.bombsUsed[player.number]) return;

    player.id = socket.id; // Update player's current socket ID

    io.to(player.id).emit("wait-bomb-center");
  });

  socket.on("bomb-center", async ({ gameId, x, y }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const currentUserId = socket.request.user ? socket.request.user.id : null;
    const player = game.players.find((p) => p.userId === currentUserId);
    if (!player || game.bombsUsed[player.number]) return;

    player.id = socket.id; // Update player's current socket ID

    // --- NEW BOMB LOGIC (from previous request) ---
    const MIN_COORD = 2; // For 3rd line/column (0-indexed)
    const MAX_COORD_X = WIDTH - 3; // For 14th column (16-3 = 13)
    const MAX_COORD_Y = HEIGHT - 3; // For 14th line (16-3 = 13)

    if (x < MIN_COORD || x > MAX_COORD_X || y < MIN_COORD || y > MAX_COORD_Y) {
      console.log(`Bomb center (${x},${y}) out of bounds for 5x5 blast.`);
      io.to(player.id).emit("bomb-error", "Bomb center must be within the 12x12 area.");
      return;
    }

    let allTilesRevealed = true;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const checkX = x + dx;
        const checkY = y + dy;
        if (checkX >= 0 && checkX < WIDTH && checkY >= 0 && checkY < HEIGHT) {
          if (!game.board[checkY][checkX].revealed) {
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
      console.log(`Bomb area at (${x},${y}) already fully revealed.`);
      io.to(player.id).emit("bomb-error", "All tiles in the bomb area are already revealed.");
      return;
    }
    // --- END NEW BOMB LOGIC ---

    game.bombsUsed[player.number] = true;
    revealArea(game.board, x, y, player.number, game.scores);

    if (checkGameOver(game.scores)) game.gameOver = true;
    else game.turn = game.turn === 1 ? 2 : 1;

    // --- Update game state in Firestore ---
    try {
        const gameDocRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
        await gameDocRef.update({
            board: game.board,
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastUpdated: Timestamp.now(),
            winnerId: game.gameOver ? (game.scores[1] > game.scores[2] ? game.players[0].userId : game.players[1].userId) : null,
            loserId: game.gameOver ? (game.scores[1] < game.scores[2] ? game.players[0].userId : game.players[1].userId) : null
        });
        console.log(`Game ${gameId} updated in Firestore (bomb-center).`);
    } catch (error) {
        console.error("Error updating game in Firestore (bomb-center):", error);
    }

    game.players.forEach(p => {
        if(p.id) io.to(p.id).emit("board-update", game);
    });
  });

  socket.on("restart-game", async ({ gameId }) => {
    const game = games[gameId];
    if (!game) return;

    const currentUserId = socket.request.user ? socket.request.user.id : null;
    const player = game.players.find((p) => p.userId === currentUserId);
    if (!player) return;

    player.id = socket.id; // Update player's current socket ID

    console.log(`Player ${player.name} requested game ${gameId} restart.`);

    game.board = generateBoard();
    game.scores = { 1: 0, 2: 0 };
    game.bombsUsed = { 1: false, 2: false };
    game.turn = 1;
    game.gameOver = false;

    // --- Update game state in Firestore ---
    try {
        const gameDocRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
        await gameDocRef.update({
            board: game.board,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            turn: game.turn,
            gameOver: game.gameOver,
            status: 'active', // Reset status to active on restart
            lastUpdated: Timestamp.now(),
            winnerId: null, // Clear winner/loser on restart
            loserId: null
        });
        console.log(`Game ${gameId} restarted and updated in Firestore.`);
    } catch (error) {
        console.error("Error restarting game in Firestore:", error);
    }

    game.players.forEach(p => {
        if(p.id) io.to(p.id).emit("board-update", game);
    });
  });

  socket.on("disconnect", async () => {
    console.log(`Socket disconnected: ${socket.id}`);

    // Find the player by socket.id in our global players list
    const disconnectedPlayerIndex = players.findIndex((p) => p.id === socket.id);
    let disconnectedPlayer = null;
    if (disconnectedPlayerIndex !== -1) {
        disconnectedPlayer = players[disconnectedPlayerIndex];
        // Keep the player in the `players` array, but mark them as not currently active in lobby
        // or game by updating their socket ID if we had a persistent userId from passport.
        // For in-memory players array, we'll remove and re-add if they rejoin.
        players.splice(disconnectedPlayerIndex, 1); // Remove from current in-memory lobby list
    }

    // Iterate through active games to find if this socket was part of one
    for (const gameId in games) {
        const game = games[gameId];
        const playerInGame = game.players.find(p => p.id === socket.id);

        if (playerInGame) {
            console.log(`Player ${playerInGame.name} (${playerInGame.userId}) disconnected from game ${gameId}.`);
            // Find opponent
            const opponent = game.players.find(p => p.id !== socket.id);

            // Update game status in Firestore
            try {
                const gameDocRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
                if (opponent) {
                    // Notify opponent and set game status to 'waiting_for_resume'
                    if (opponent.id) {
                        io.to(opponent.id).emit("opponent-left");
                        console.log(`Notified opponent ${opponent.name} of ${playerInGame.name}'s disconnection.`);
                    }
                    await gameDocRef.update({ status: 'waiting_for_resume', lastUpdated: Timestamp.now() });
                    console.log(`Game ${gameId} status set to 'waiting_for_resume' in Firestore due to disconnect.`);
                } else {
                    // No opponent left, meaning this was the last player. Mark game as completed/abandoned.
                    await gameDocRef.update({ status: 'completed', lastUpdated: Timestamp.now() });
                    console.log(`Game ${gameId} status set to 'completed' (last player disconnected).`);
                }
            } catch (error) {
                console.error("Error updating game status on disconnect:", error);
            }
            delete games[gameId]; // Remove game from in-memory active list
            break; // Game found and handled, exit loop
        }
    }

    // Update lobby player list for all clients, filtering by in-game status from Firestore
    // This is a more complex filter since 'inGame' is only in-memory.
    // Instead, just re-emit the lobby list and let the frontend query unfinished games.
    io.emit(
        "players-list",
        players.filter((p) => !Object.values(games).some(g => g.players.some(gp => gp.userId === p.userId))).map((p) => ({ id: p.id, name: p.name }))
    );
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
