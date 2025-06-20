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
const util = require('util'); // Import util for promisify

// --- Firebase Admin SDK Imports ---
const admin = require('firebase-admin');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { Firestore } = require('@google-cloud/firestore');
const { FirestoreStore } = require('@google-cloud/connect-firestore');


const app = express();
const server = http.createServer(app);

// New global data structures (in-memory, these will be synchronized with Firestore)
const userSocketMap = {}; // Maps userId to current socket.id
const userGameMap = {};   // Maps userId to current gameId
let players = []; // Lobby players: { id: socket.id, userId, name, number, inGame, socketId } (socketId is redundant with id, but explicitly kept for clarity)
let games = {};   // Active games: gameId: { players: [{userId, name, number, socketId}], board, scores, bombsUsed, turn, gameOver, lastClickedTile }

// Configure CORS for Express HTTP routes
app.use(cors({
    origin: "https://minesweeper-flags-frontend.onrender.com",
    credentials: true,
}));

app.set('trust proxy', 1); // Crucial for Render

// === Declare `db`, `sessionMiddleware`, and `io` variables here ===
let db;
let sessionMiddleware;
let io;
let firestoreSessionStore; // Dedicated variable for FirestoreStore instance


try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  console.log(`[Firebase Init] Service Account Project ID: ${serviceAccount.project_id}`);
  const privateKeyCleaned = serviceAccount.private_key.replace(/\\n/g, '\n');
  console.log(`[Firebase Init] Private Key (first 20 chars): ${privateKeyCleaned.substring(0, 20)}...`);
  console.log(`[Firebase Init] Private Key Length: ${privateKeyCleaned.length}`);


  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = getFirestore();

  const firestoreClient = new Firestore({
    projectId: serviceAccount.project_id,
    credentials: {
      client_email: serviceAccount.client_email,
      private_key: privateKeyCleaned,
    },
    databaseId: '(default)',
  });

  // Capture the FirestoreStore instance in a dedicated variable
  firestoreSessionStore = new FirestoreStore({
      dataset: firestoreClient,
      kind: 'express-sessions',
  });

  sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: false, // Set to false, session should not be saved if unmodified
    saveUninitialized: false, // Set to false, don't save new sessions that have no data
    store: firestoreSessionStore, // Use the captured instance here
    cookie: {
      sameSite: "none",
      secure: process.env.NODE_ENV === 'production', // Use true in production
      maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
    },
  });

  console.log(`[Debug] firestoreSessionStore is defined: ${!!firestoreSessionStore}`);
  console.log(`[Debug] firestoreSessionStore.get type: ${typeof firestoreSessionStore.get}`);


  app.use(sessionMiddleware);
  app.use(passport.initialize());
  app.use(passport.session());

  io = new Server(server, {
    cors: {
      origin: "https://minesweeper-flags-frontend.onrender.com",
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  // === IMPORTANT: Integrate session and passport with Socket.IO using chained middleware ===
  io.use((socket, next) => {
    socket.request.res = {
        writeHead: () => {},
        end: () => {},
        setHeader: () => {}
    };
    console.log(`[Socket.IO Auth Step 1] Applying sessionMiddleware for socket ${socket.id}.`);
    sessionMiddleware(socket.request, socket.request.res, next);
  });

  io.use((socket, next) => {
    console.log(`[Socket.IO Auth Step 2] Applying passport.initialize() for socket ${socket.id}.`);
    passport.initialize()(socket.request, socket.request.res, next);
  });

  io.use((socket, next) => {
    console.log(`[Socket.IO Auth Step 3] Applying passport.session() for socket ${socket.id}.`);
    passport.session()(socket.request, socket.request.res, next);
  });

  io.use((socket, next) => {
    console.log(`[Socket.IO Auth Step 4] Final check for socket ${socket.id}. req.user: ${JSON.stringify(socket.request.user)}`);
    if (socket.request.user) {
        console.log(`[Socket.IO Auth Final] User authenticated via session: ${socket.request.user.displayName || socket.request.user.id}`);
        next();
    } else {
        console.log(`[Socket.IO Auth Final] User NOT authenticated for socket ${socket.id}.`);
        next();
    }
  });
  // === END Socket.IO Session Integration ===


} catch (error) {
  console.error("Failed to initialize Firebase Admin SDK or FirestoreStore.", error);
  process.exit(1);
}


// === Passport config ===
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/google/callback"
}, (accessToken, refreshToken, profile, done) => {
  console.log(`[Passport Callback] Google Strategy: Received profile for user ID: ${profile.id}, Name: ${profile.displayName}`);
  done(null, { id: profile.id, displayName: profile.displayName });
}));

passport.use(new FacebookStrategy({
    clientID: process.env.FACEBOOK_CLIENT_ID,
    clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
    callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/facebook/callback",
    profileFields: ['id', 'displayName', 'photos', 'email']
  },
  function(accessToken, refreshToken, profile, cb) {
    console.log(`[Passport Callback] Facebook Strategy: Received profile for user ID: ${profile.id}, Name: ${profile.displayName}`);
    cb(null, { id: profile.id, displayName: profile.displayName });
  }
));

passport.serializeUser((user, done) => {
  console.log(`[Passport] serializeUser: Serializing user - ID: ${user.id}, Name: ${user.displayName || user.name}`);
  done(null, { id: user.id, displayName: user.displayName }); // Ensure displayName is part of serialized user
});

passport.deserializeUser((obj, done) => {
  console.log(`[Passport] deserializeUser: Deserializing user - ID: ${obj.id}, Name: ${obj.displayName || obj.name}`);
  done(null, obj); // The deserialized object should be the same as the serialized one
});

const APP_ID = process.env.RENDER_APP_ID || "minesweeper-flags-default-app";
const GAMES_COLLECTION_PATH = `artifacts/${APP_ID}/public/data/minesweeperGames`;


// === Authentication Routes ===
app.get("/auth/facebook",
  passport.authenticate("facebook", { scope: ['public_profile'] })
);

app.get("/auth/facebook/callback",
  passport.authenticate("facebook", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com/login-failed",
  }),
  (req, res) => {
    console.log(`[Session Save] Attempting to save session after Facebook auth.`);
    req.session.save((err) => {
      if (err) {
        console.error("Error saving session after Facebook auth:", err);
      } else {
        console.log(`[Session Save] Session successfully saved after Facebook auth.`);
      }
      res.redirect("https://minesweeper-flags-frontend.onrender.com");
    });
  }
);

app.get("/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] }) // Include email scope for consistency, although not directly used in displayName
);

app.get("/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com",
  }),
  (req, res) => {
    console.log(`[Session Save] Attempting to save session after Google auth.`);
    req.session.save((err) => {
      if (err) {
        console.error("Error saving session after Google auth:", err);
      } else {
        console.log(`[Session Save] Session successfully saved after Google auth.`);
      }
      res.redirect("https://minesweeper-flags-frontend.onrender.com");
    });
  }
);

app.get("/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) { return next(err); }
    req.session.destroy((destroyErr) => {
      if (destroyErr) { return next(destroyErr); }
      res.clearCookie("connect.sid", {
          path: '/',
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'none'
      });
      console.log("User logged out and session destroyed.");
      res.status(200).send("Logged out successfully");
    });
  });
});

app.get("/login-failed", (req, res) => {
  res.send("Login failed");
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
                // If it's a mine, reveal it and award point to player
            if (tile.isMine) {
              tile.revealed = true;
              tile.owner = playerNumber;
              scores[playerNumber]++;
            } else {
                // If not a mine, perform recursive reveal
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

  const userIdOnConnect = socket.request.user ? socket.request.user.id : null;
  const userNameOnConnect = socket.request.user ? socket.request.user.displayName : null;

  if (userIdOnConnect) {
    console.log(`User ${userNameOnConnect} (${userIdOnConnect}) connected via socket.`);
    userSocketMap[userIdOnConnect] = socket.id; // Store current socket ID for this user

    // Handle rejoining an existing game (if any)
    if (userGameMap[userIdOnConnect]) {
        const gameId = userGameMap[userIdOnConnect];
        let game = games[gameId]; 

        if (!game) { // If not in memory, try to load from Firestore
            db.collection(GAMES_COLLECTION_PATH).doc(gameId).get().then(doc => {
                if (doc.exists && (doc.data().status === 'active' || doc.data().status === 'waiting_for_resume')) {
                    const gameData = doc.data();
                    const deserializedBoard = JSON.parse(gameData.board);

                    game = {
                        gameId: gameData.gameId,
                        board: deserializedBoard,
                        scores: gameData.scores,
                        bombsUsed: gameData.bombsUsed,
                        turn: gameData.turn,
                        gameOver: gameData.gameOver,
                        lastClickedTile: gameData.lastClickedTile || { 1: null, 2: null },
                        players: []
                    };

                    let player1 = players.find(p => p.userId === gameData.player1_userId);
                    if (!player1) {
                        player1 = { userId: gameData.player1_userId, name: gameData.player1_name, number: 1, inGame: true };
                        players.push(player1);
                    }
                    player1.socketId = userSocketMap[player1.userId] || null;
                    player1.id = player1.socketId; // Use socketId as id for consistency
                    player1.inGame = true;

                    let player2 = players.find(p => p.userId === gameData.player2_userId);
                    if (!player2) {
                        player2 = { userId: gameData.player2_userId, name: gameData.player2_name, number: 2, inGame: true };
                        players.push(player2);
                    }
                    player2.socketId = userSocketMap[player2.userId] || null;
                    player2.id = player2.socketId; // Use socketId as id for consistency
                    player2.inGame = true;

                    game.players = [player1, player2];
                    games[gameId] = game;

                    if (gameData.status === 'waiting_for_resume') {
                        doc.ref.set({ status: 'active', lastUpdated: Timestamp.now() }, { merge: true }).then(() => {
                            console.log(`Game ${gameId} status updated to 'active' in Firestore on resume.`);
                        }).catch(e => console.error("Error updating game status on resume:", e));
                    }
                    console.log(`Game ${gameId} loaded from Firestore and rehydrated in memory.`);
                    
                    const playerInGame = game.players.find(p => p.userId === userIdOnConnect);
                    console.log(`[Resume Game Emit] Emitting game-start to ${playerInGame?.name} (Socket: ${playerInGame?.socketId}). Player Number: ${playerInGame?.number}`); // NEW LOG
                    if (playerInGame && playerInGame.socketId) {
                        const opponentPlayer = game.players.find(op => op.userId !== userIdOnConnect);
                        io.to(playerInGame.socketId).emit("game-start", {
                            gameId: game.gameId,
                            playerNumber: playerInGame.number,
                            board: JSON.stringify(game.board), // Stringify board for client
                            turn: game.turn,
                            scores: game.scores,
                            bombsUsed: game.bombsUsed,
                            gameOver: game.gameOver,
                            opponentName: opponentPlayer ? opponentPlayer.name : "Opponent",
                            lastClickedTile: game.lastClickedTile
                        });
                        console.log(`Emitted game-start to reconnected user ${playerInGame.name} for game ${gameId}.`);
                    }
                    const opponentPlayer = game.players.find(op => op.userId !== userIdOnConnect);
                    if (opponentPlayer && opponentPlayer.socketId) {
                        io.to(opponentPlayer.socketId).emit("opponent-reconnected", { name: userNameOnConnect });
                        console.log(`Notified opponent ${opponentPlayer.name} of ${userNameOnConnect} re-connection in game ${gameId}.`);
                    }
                    // Filter out players who are in active games or mapped to a game in userGameMap
                    io.emit("players-list", players.filter(p => !p.inGame && !userGameMap[p.userId]).map(p => ({ id: p.id, name: p.name })));

                } else {
                    delete userGameMap[userIdOnConnect];
                    console.log(`Game ${gameId} for user ${userIdOnConnect} not found or invalid status in Firestore, clearing map.`);
                }
            }).catch(e => {
                console.error("Error fetching game from Firestore on reconnect:", e);
            });
        } else { // Game found in memory
            const playerInGame = game.players.find(p => p.userId === userIdOnConnect);
            if (playerInGame) {
                playerInGame.socketId = socket.id;
                playerInGame.id = socket.id; // Use socketId as id for consistency
                console.log(`Re-sent active game state for game ${gameId} to ${playerInGame.name}.`);
            }
            const opponentPlayer = game.players.find(op => op.userId !== userIdOnConnect);
            if (opponentPlayer && opponentPlayer.socketId) {
                io.to(opponentPlayer.socketId).emit("opponent-reconnected", { name: userNameOnConnect });
            }
            io.to(playerInGame.socketId).emit("game-start", {
                gameId: game.gameId,
                playerNumber: playerInGame.number,
                board: JSON.stringify(game.board), // Stringify board for client
                turn: game.turn,
                scores: game.scores,
                bombsUsed: game.bombsUsed,
                gameOver: game.gameOver,
                opponentName: opponentPlayer ? opponentPlayer.name : "Opponent",
                lastClickedTile: game.lastClickedTile
            });
        }
    }
  } // <<< CORRECTED PLACEMENT OF THE CLOSING BRACE FOR 'if (userIdOnConnect)'
  else {
    console.log(`Unauthenticated or session-less socket ${socket.id} connected. (No req.user)`);
  }


  socket.on("join-lobby", (name) => {
    const userId = socket.request.user ? socket.request.user.id : null;
    const userDisplayName = socket.request.user ? socket.request.user.displayName : null;

    if (!userId) {
      socket.emit("join-error", "Authentication required to join lobby. Please login.");
      console.warn(`Attempt to join lobby from unauthenticated socket ${socket.id}. Rejected.`);
      return;
    }

    if (!name || name.trim() === "") {
        socket.emit("join-error", "Name cannot be empty.");
        return;
    }

    let playerEntry = players.find(p => p.userId === userId);

    if (playerEntry) {
      playerEntry.id = socket.id;
      playerEntry.socketId = socket.id; // Update socket ID
      playerEntry.name = userDisplayName || name;
      playerEntry.inGame = false; // Player is now in lobby, not in a game
      playerEntry.number = null; // No player number in lobby
      console.log(`Player ${playerEntry.name} (ID: ${userId}) re-joined lobby with new socket ID.`);
    } else {
      players.push({ id: socket.id, userId: userId, name: userDisplayName || name, number: null, inGame: false, socketId: socket.id });
      console.log(`New player ${userDisplayName || name} (ID: ${userId}) joined lobby.`);
    }

    userSocketMap[userId] = socket.id;

    socket.emit("lobby-joined", userDisplayName || name);
    
    // Filter players list to only show those not in game and not already mapped to a game in userGameMap
    io.emit(
      "players-list",
      players.filter((p) => !p.inGame && !userGameMap[p.userId]).map((p) => ({ id: p.id, name: p.name }))
    );
  });

  socket.on("request-unfinished-games", async () => {
    const userId = socket.request.user ? socket.request.user.id : null;
    const userName = socket.request.user ? socket.request.user.displayName : 'Unknown Player';

    if (!userId) {
        socket.emit("join-error", "Authentication required to fetch games.");
        return;
    }

    try {
        const gamesQuerySnapshot = await db.collection(GAMES_COLLECTION_PATH)
            .where('status', 'in', ['active', 'waiting_for_resume'])
            .get();

        let unfinishedGames = [];

        gamesQuerySnapshot.forEach(doc => {
            const gameData = doc.data();
            const isPlayer1 = gameData.player1_userId === userId;
            const isPlayer2 = gameData.player2_userId === userId;

            if (isPlayer1 || isPlayer2) {
                // Check if this game is currently active in memory and fully connected for *this user*
                const isFullyActive = games[gameData.gameId] && 
                                      games[gameData.gameId].players.some(p => p.userId === userId && p.socketId === userSocketMap[userId]);

                if (!isFullyActive) { // Only add to unfinished if not already fully active
                    unfinishedGames.push({
                        gameId: gameData.gameId,
                        board: gameData.board, // Send serialized board
                        opponentName: isPlayer1 ? gameData.player2_name : gameData.player1_name,
                        myPlayerNumber: isPlayer1 ? 1 : 2,
                        status: gameData.status,
                        lastUpdated: gameData.lastUpdated ? gameData.lastUpdated.toDate().toLocaleString() : 'N/A'
                    });
                }
            }
        });

        const uniqueGames = Array.from(new Map(unfinishedGames.map(item => [item.gameId, item])).values());

        socket.emit("receive-unfinished-games", uniqueGames);
        console.log(`Sent ${uniqueGames.length} unfinished games to user ${userName}.`);

    } catch (error) {
        console.error("Error fetching unfinished games for user:", userId, error);
        socket.emit("join-error", "Failed to load your unfinished games.");
    }
  });

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

        if (!gameDoc.exists || (gameDoc.data().status !== 'active' && gameDoc.data().status !== 'waiting_for_resume')) {
            socket.emit("join-error", "Game not found or cannot be resumed.");
            return;
        }

        const gameData = gameDoc.data();

        if (gameData.player1_userId !== userId && gameData.player2_userId !== userId) {
            socket.emit("join-error", "You are not a participant in this game.");
            return;
        }

        // Handle case where game is already in memory
        if (games[gameId]) {
            const existingGame = games[gameId];
            const playerInExistingGame = existingGame.players.find(p => p.userId === userId);
            
            if (playerInExistingGame) {
                // Update socketId in existing in-memory game object
                playerInExistingGame.socketId = socket.id;
                playerInExistingGame.id = socket.id; // Use socketId as id for consistency
                playerInExistingGame.inGame = true; // Ensure marked as inGame
                userSocketMap[userId] = socket.id; // Update global map

                const opponentPlayer = existingGame.players.find(op => op.userId !== userId);
                
                io.to(socket.id).emit("game-start", {
                    gameId: existingGame.gameId,
                    playerNumber: playerInExistingGame.number,
                    board: JSON.stringify(existingGame.board),
                    turn: existingGame.turn,
                    scores: existingGame.scores,
                    bombsUsed: existingGame.bombsUsed,
                    gameOver: existingGame.gameOver,
                    opponentName: opponentPlayer ? opponentPlayer.name : "Opponent",
                    lastClickedTile: existingGame.lastClickedTile // Send last clicked tile
                });
                console.log(`User ${userName} reconnected and re-sent active game state for game ${gameId}.`);

                if (opponentPlayer && opponentPlayer.socketId) {
                    io.to(opponentPlayer.socketId).emit("opponent-reconnected", { name: userName });
                }
                io.emit("players-list", players.filter(p => !p.inGame && !userGameMap[p.userId]).map(p => ({ id: p.id, name: p.name })));
                return;
            }
        }


        // Game not in memory, load from Firestore and re-create in memory
        const deserializedBoard = JSON.parse(gameData.board);

        const game = {
            gameId: gameData.gameId,
            board: deserializedBoard,
            scores: gameData.scores,
            bombsUsed: gameData.bombsUsed,
            turn: gameData.turn,
            gameOver: gameData.gameOver,
            lastClickedTile: gameData.lastClickedTile || { 1: null, 2: null }, // Load last clicked tile
            players: []
        };

        // Reconstruct player objects for the game and update global players list
        let player1 = players.find(p => p.userId === gameData.player1_userId);
        if (!player1) {
            player1 = { userId: gameData.player1_userId, name: gameData.player1_name, number: 1 };
            players.push(player1);
        }
        player1.socketId = userSocketMap[player1.userId] || null;
        player1.id = player1.socketId; // Use socketId as id for consistency
        player1.inGame = true; // Mark as in game

        let player2 = players.find(p => p.userId === gameData.player2_userId);
        if (!player2) {
            player2 = { userId: gameData.player2_userId, name: gameData.player2_name, number: 2 };
            players.push(player2);
        }
        player2.socketId = userSocketMap[player2.userId] || null;
        player2.id = player2.socketId; // Use socketId as id for consistency
        player2.inGame = true; // Mark as in game

        game.players = [player1, player2];
        games[gameId] = game;
        userGameMap[player1.userId] = gameId;
        userGameMap[player2.userId] = gameId;

        // Update Firestore status if it was waiting for resume
        if (gameData.status === 'waiting_for_resume') {
            await gameDocRef.set({ status: 'active', lastUpdated: Timestamp.now() }, { merge: true });
            console.log(`Game ${gameId} status updated to 'active' in Firestore on resume.`);
        }

        const currentPlayerInGame = game.players.find(p => p.userId === userId);
        const opponentPlayerInGame = game.players.find(op => op.userId !== userId);

        console.log(`[Resume Game Emit] Emitting game-start to ${currentPlayerInGame?.name} (Socket: ${currentPlayerInGame?.socketId}). Player Number: ${currentPlayerInGame?.number}`); // NEW LOG
        if (currentPlayerInGame && currentPlayerInGame.socketId) {
            io.to(currentPlayerInGame.socketId).emit("game-start", {
                gameId: game.gameId,
                playerNumber: currentPlayerInGame.number,
                board: JSON.stringify(game.board),
                turn: game.turn,
                scores: game.scores,
                bombsUsed: game.bombsUsed,
                gameOver: game.gameOver,
                opponentName: opponentPlayerInGame ? opponentPlayerInGame.name : "Opponent",
                lastClickedTile: game.lastClickedTile
            });
            console.log(`User ${userName} successfully resumed game ${gameId}.`);
        }

        if (opponentPlayerInGame && opponentPlayerInGame.socketId) {
            io.to(opponentPlayerInGame.socketId).emit("opponent-reconnected", { name: userName });
            console.log(`Notified opponent ${opponentPlayerInGame.name} that ${userName} reconnected to game ${gameId}.`);
        }

        io.emit("players-list", players.filter(p => !p.inGame && !userGameMap[p.userId]).map(p => ({ id: p.id, name: p.name })));

    } catch (error) {
        console.error("Error resuming game:", error);
        socket.emit("join-error", "Failed to resume game. " + error.message);
    }
  });


  socket.on("invite-player", (targetId) => {
    const inviterUserId = socket.request.user ? socket.request.user.id : null;
    const inviter = players.find((p) => p.userId === inviterUserId);
    const invitee = players.find((p) => p.id === targetId);

    if (!inviter || !invitee) return;
    if (userGameMap[inviter.userId] || userGameMap[invitee.userId]) {
        console.warn(`Invite failed: Inviter or invitee already in game or already mapped.`);
        io.to(inviter.id).emit("invite-rejected", { fromName: invitee.name, reason: "Player is currently in a game." });
        return;
    }

    io.to(invitee.id).emit("game-invite", {
      fromId: inviter.id,
      fromName: inviter.name,
    });
    console.log(`Invite sent from ${inviter.name} (${inviter.userId}) to ${invitee.name} (${invitee.userId || invitee.id}).`);
  });

  socket.on("respond-invite", async ({ fromId, accept }) => {
    const responderUserId = socket.request.user ? socket.request.user.id : null;
    const responder = players.find((p) => p.userId === responderUserId);
    const inviter = players.find((p) => p.id === fromId);

    if (!responder || !inviter) return;

    if (userGameMap[responder.userId] || userGameMap[inviter.userId]) {
        console.warn("Respond invite failed: One or both players already in a game via userGameMap.");
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
      const lastClickedTile = { 1: null, 2: null };

      inviter.number = 1;
      inviter.inGame = true;
      inviter.socketId = inviter.id;
      inviter.id = inviter.socketId; // Use socketId as id for consistency
      responder.number = 2;
      responder.inGame = true;
      responder.socketId = responder.id;
      responder.id = responder.socketId; // Use socketId as id for consistency

      const game = {
        gameId,
        players: [inviter, responder],
        board,
        scores,
        bombsUsed,
        turn,
        gameOver,
        lastClickedTile
      };
      games[gameId] = game;

      userGameMap[inviter.userId] = gameId;
      userGameMap[responder.userId] = gameId;

      console.log(`Game ${gameId} started between ${inviter.name} (ID: ${inviter.userId}) and ${responder.name} (ID: ${responder.userId}).`);

      try {
          const serializedBoard = JSON.stringify(game.board);
          await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
              gameId: game.gameId,
              board: serializedBoard,
              player1_userId: inviter.userId,
              player2_userId: responder.userId,
              player1_name: inviter.name,
              player2_name: responder.name,
              turn: game.turn,
              scores: game.scores,
              bombsUsed: game.bombsUsed,
              gameOver: game.gameOver,
              lastClickedTile: game.lastClickedTile,
              status: 'active',
              lastUpdated: Timestamp.now(),
              winnerId: null,
              loserId: null
          }, { merge: true });
          console.log(`Game ${gameId} saved to Firestore.`);
      } catch (error) {
          console.error("Error saving new game to Firestore:", error);
          delete games[gameId];
          delete userGameMap[inviter.userId];
          delete userGameMap[responder.userId];
          io.to(inviter.id).emit("join-error", "Failed to start game (DB error).");
          io.to(responder.id).emit("join-error", "Failed to start game (DB error).");
          return;
      }

      io.emit(
        "players-list",
        players.filter((p) => !p.inGame && !userGameMap[p.userId]).map((p) => ({ id: p.id, name: p.name }))
      );

      io.to(inviter.id).emit("game-start", {
        playerNumber: inviter.number,
        board: JSON.stringify(board),
        turn,
        scores,
        bombsUsed,
        gameOver,
        opponentName: responder.name,
        gameId,
        lastClickedTile
      });
      io.to(responder.id).emit("game-start", {
        playerNumber: responder.number,
        board: JSON.stringify(board),
        turn,
        scores,
        bombsUsed,
        gameOver,
        opponentName: inviter.name,
        gameId,
        lastClickedTile
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

    player.socketId = socket.id;
    player.id = socket.id; // Use socketId as id for consistency

    const tile = game.board[y][x];
    if (tile.revealed) return;

    game.lastClickedTile[player.number] = { x, y }; // Update last clicked tile for the current player

    if (tile.isMine) {
      tile.revealed = true;
      tile.owner = player.number;
      game.scores[player.number]++;
      if (checkGameOver(game.scores)) {
          game.gameOver = true;
      }
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
        game.lastClickedTile = { 1: null, 2: null }; // Reset last clicked tile on restart

        try {
            const serializedBoard = JSON.stringify(game.board);
            await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                board: serializedBoard,
                scores: game.scores,
                bombsUsed: game.bombsUsed,
                turn: game.turn,
                gameOver: game.gameOver,
                lastClickedTile: game.lastClickedTile,
                status: 'active',
                lastUpdated: Timestamp.now(),
                winnerId: null,
                loserId: null
            }, { merge: true });
            console.log(`Game ${gameId} restarted and updated in Firestore.`);
        } catch (error) {
            console.error("Error restarting game in Firestore:", error);
        }

        game.players.forEach(p => {
            if (p.socketId) {
                const opponentPlayer = game.players.find(op => op.userId !== p.userId);
                io.to(p.socketId).emit("game-restarted", {
                    gameId: game.gameId,
                    playerNumber: p.number,
                    board: JSON.stringify(game.board),
                    turn: game.turn,
                    scores: game.scores,
                    bombsUsed: game.bombsUsed,
                    gameOver: game.gameOver,
                    opponentName: opponentPlayer ? opponentPlayer.name : "Opponent",
                    lastClickedTile: game.lastClickedTile
                });
            }
        });
        return;
      }

      revealRecursive(game.board, x, y);
      game.turn = game.turn === 1 ? 2 : 1;
    }

    try {
        const serializedBoard = JSON.stringify(game.board);
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
            board: serializedBoard,
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile,
            lastUpdated: Timestamp.now(),
            winnerId: game.gameOver ? (game.scores[1] > game.scores[2] ? player.userId : game.players.find(p => p.userId !== currentUserId).userId) : null,
            loserId: game.gameOver ? (game.scores[1] < game.scores[2] ? player.userId : game.players.find(p => p.userId !== currentUserId).userId) : null
        }, { merge: true });
        console.log(`Game ${gameId} updated in Firestore (tile-click).`);
    } catch (error) {
        console.error("Error updating game in Firestore (tile-click):", error);
    }

    game.players.forEach(p => {
        if(p.socketId) io.to(p.socketId).emit("board-update", { ...game, board: JSON.stringify(game.board), lastClickedTile: game.lastClickedTile });
    });
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
    player.id = socket.id; // Use socketId as id for consistency

    io.to(player.socketId).emit("wait-bomb-center");
    console.log(`Player ${player.name} is waiting for bomb center selection.`);
  });

  socket.on("bomb-center", async ({ gameId, x, y }) => {
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
    player.id = socket.id; // Use socketId as id for consistency

    const MIN_COORD = 2;
    const MAX_COORD_X = WIDTH - 3;
    const MAX_COORD_Y = HEIGHT - 3;

    if (x < MIN_COORD || x > MAX_COORD_X || y < MIN_COORD || y > MAX_COORD_Y) {
      console.log(`Bomb center (${x},${y}) out of bounds for 5x5 blast.`);
      io.to(player.socketId).emit("bomb-error", "Bomb center must be within the 12x12 area.");
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
      io.to(player.socketId).emit("bomb-error", "All tiles in the bomb area are already revealed.");
      return;
    }

    game.bombsUsed[player.number] = true;
    revealArea(game.board, x, y, player.number, game.scores);

    game.lastClickedTile[player.number] = { x, y }; // Update last clicked tile after bomb

    if (checkGameOver(game.scores)) game.gameOver = true;
    else game.turn = game.turn === 1 ? 2 : 1;

    console.log(`Player ${player.name} used bomb at ${x},${y}. New scores: P1: ${game.scores[1]}, P2: ${game.scores[2]}`);

    try {
        const serializedBoard = JSON.stringify(game.board);
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
            board: serializedBoard,
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile,
            lastUpdated: Timestamp.now(),
            winnerId: game.gameOver ? (game.scores[1] > game.scores[2] ? player.userId : game.players.find(p => p.userId !== currentUserId).userId) : null,
            loserId: game.gameOver ? (game.scores[1] < game.scores[2] ? player.userId : game.players.find(p => p.userId !== currentUserId).userId) : null
        }, { merge: true });
        console.log(`Game ${gameId} updated in Firestore (bomb-center).`);
    } catch (error) {
        console.error("Error updating game in Firestore (bomb-center):", error);
    }

    game.players.forEach(p => {
        if(p.socketId) io.to(p.socketId).emit("board-update", { ...game, board: JSON.stringify(game.board), lastClickedTile: game.lastClickedTile });
    });
  });

  socket.on("restart-game", async ({ gameId }) => {
    const game = games[gameId];
    if (!game) return;

    const currentUserId = socket.request.user ? socket.request.user.id : null;
    const player = game.players.find((p) => p.userId === currentUserId);
    if (!player) return;

    player.socketId = socket.id;
    player.id = socket.id; // Use socketId as id for consistency

    console.log(`Player ${player.name} requested game ${gameId} restart.`);

    game.board = generateBoard();
    game.scores = { 1: 0, 2: 0 };
    game.bombsUsed = { 1: false, 2: false };
    game.turn = 1;
    game.gameOver = false;
    game.lastClickedTile = { 1: null, 2: null }; // Reset last clicked tile on restart

    try {
        const serializedBoard = JSON.stringify(game.board);
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
            board: serializedBoard,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            turn: game.turn,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile,
            status: 'active',
            lastUpdated: Timestamp.now(),
            winnerId: null,
            loserId: null
        }, { merge: true });
        console.log(`Game ${gameId} restarted and updated in Firestore.`);
    } catch (error) {
        console.error("Error restarting game in Firestore:", error);
    }

    game.players.forEach(p => {
        if(p.socketId) io.to(p.socketId).emit("board-update", { ...game, board: JSON.stringify(game.board), lastClickedTile: game.lastClickedTile });
    });
  });

  socket.on("leave-game", async ({ gameId }) => {
    const userId = socket.request.user ? socket.request.user.id : null;
    if (!userId) return;

    const leavingPlayer = players.find((p) => p.userId === userId);
    if (!leavingPlayer) {
      console.log(`Player with ID ${userId} not found in global list on leave-game.`);
      return;
    }

    leavingPlayer.inGame = false;
    leavingPlayer.number = null;

    console.log(`Player ${leavingPlayer.name} (ID: ${userId}) initiating leave from game ${gameId}.`);

    const game = games[gameId];
    if (game) {
        const opponent = game.players.find(p => p.userId !== userId);

        if (opponent) {
            if (opponent.socketId) {
                io.to(opponent.socketId).emit("opponent-left");
                console.log(`Notified opponent ${opponent.name} of ${leavingPlayer.name}'s disconnection.`);
            }
            const opponentGlobalEntry = players.find(p => p.userId === opponent.userId);
            if(opponentGlobalEntry) {
                opponentGlobalEntry.inGame = false;
                opponentGlobalEntry.number = null;
            }

            // Keep game in memory, mark status in Firestore
            await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                status: 'waiting_for_resume',
                lastUpdated: Timestamp.now()
            }, { merge: true });
            console.log(`Game ${gameId} status set to 'waiting_for_resume' in Firestore.`);

        } else {
            // Last player leaving, mark game as completed in Firestore
            await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                status: 'completed',
                lastUpdated: Timestamp.now()
            }, { merge: true });
            console.log(`Game ${gameId} status set to 'completed' as last player left.`);
        }
        delete games[gameId]; // Remove game from in-memory if left
        delete userGameMap[userId]; // Clear the user's game mapping
    }

    io.emit(
      "players-list",
      players.filter((p) => !p.inGame && !userGameMap[p.userId]).map((p) => ({ id: p.id, name: p.name }))
    );
  });


  socket.on("disconnect", async () => {
    console.log(`Socket disconnected: ${socket.id}`);

    let disconnectedUserId = null;
    // Find the userId associated with this disconnected socket
    for (const userId in userSocketMap) {
        if (userSocketMap[userId] === socket.id) {
            disconnectedUserId = userId;
            delete userSocketMap[userId]; // Remove this socket from the map
            break;
        }
    }

    // Update the player's status in the global 'players' array
    const disconnectedPlayerEntry = players.find(p => p.userId === disconnectedUserId);
    if (disconnectedPlayerEntry) {
        disconnectedPlayerEntry.socketId = null;
        disconnectedPlayerEntry.id = null; // Mark id as null as socket is gone
    }

    // Filter out players from the lobby list who are not in-game and whose socket just disconnected
    // Or, if their userId is known and not in a game map, remove them from lobby list.
    io.emit("players-list", players.filter(p => p.socketId !== null && !p.inGame && !userGameMap[p.userId]).map(p => ({ id: p.id, name: p.name })));


    if (disconnectedUserId && userGameMap[disconnectedUserId]) {
        const gameId = userGameMap[disconnectedUserId];
        const game = games[gameId]; // Try to find the game in memory

        if (game) {
            const disconnectedPlayerInGame = game.players.find(p => p.userId === disconnectedUserId);
            if (disconnectedPlayerInGame) {
                disconnectedPlayerInGame.socketId = null; // Mark socket as null in game object
                disconnectedPlayerInGame.id = null; // Mark id as null in game object
                console.log(`Player ${disconnectedPlayerInGame.name} (${disconnectedUserId}) in game ${gameId} disconnected (socket marked null).`);
            }

            const allPlayersDisconnected = game.players.every(p => p.socketId === null);

            if (allPlayersDisconnected) {
                // Both players disconnected, keep game in memory, mark Firestore for resume
                game.players.forEach(p => {
                    delete userGameMap[p.userId]; // Clear userGameMap for both
                    const globalPlayerEntry = players.find(gp => gp.userId === p.userId);
                    if (globalPlayerEntry) {
                        globalPlayerEntry.inGame = false;
                        globalPlayerEntry.number = null;
                    }
                });
                // Do NOT delete games[gameId] from in-memory here. It stays for resume.
                try {
                    await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                        status: 'waiting_for_resume',
                        lastUpdated: Timestamp.now()
                    }, { merge: true });
                    console.log(`Game ${gameId} status set to 'waiting_for_resume' in Firestore on total disconnect.`);
                } catch (error) {
                    console.error("Error updating game status to 'waiting_for_resume' on total disconnect:", error);
                }
            } else {
                // One player disconnected, notify opponent and mark for resume
                const remainingPlayer = game.players.find(p => p.userId !== disconnectedUserId);
                if (remainingPlayer && remainingPlayer.socketId) {
                    io.to(remainingPlayer.socketId).emit("opponent-left");
                    console.log(`Notified opponent ${remainingPlayer.name} that their partner disconnected.`);
                }
                try {
                    await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                        status: 'waiting_for_resume',
                        lastUpdated: Timestamp.now()
                    }, { merge: true });
                    console.log(`Game ${gameId} status set to 'waiting_for_resume' in Firestore due to disconnect.`);
                } catch (error) {
                    console.error("Error updating game status to 'waiting_for_resume' on disconnect:", error);
                }
            }
        } else { // Game not in memory, but user was mapped to it. Update Firestore if needed.
            try {
                const gameDocRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
                const gameDoc = await gameDocRef.get();
                if (gameDoc.exists && (gameDoc.data().status === 'active' || gameDoc.data().status === 'waiting_for_resume')) {
                    await gameDocRef.set({
                        status: 'waiting_for_resume',
                        lastUpdated: Timestamp.now()
                    }, { merge: true });
                    console.log(`Game ${gameId} (Firestore) status set to 'waiting_for_resume' due to user disconnect.`);
                }
            } catch (error) {
                console.error("Error updating Firestore game status on disconnect (game not in memory):", error);
            }
            delete userGameMap[disconnectedUserId]; // Clear stale entry
        }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
