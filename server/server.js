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
const cookieParser = require('cookie-parser'); // Import cookie-parser


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
// let parseCookieMiddleware; // This variable is now implicitly used by app.use(cookieParser(...));


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

  // --- IMPORTANT: Ensure cookie-parser runs BEFORE express-session for HTTP requests ---
  app.use(cookieParser(process.env.SESSION_SECRET)); // Initialize cookie-parser with the session secret and apply globally

  sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: false, // Set to false, session should not be saved if unmodified
    saveUninitialized: false, // Set to false, don't save new sessions that have no data
    store: firestoreSessionStore, // Use the captured instance here
    cookie: {
      sameSite: "none",
      secure: process.env.NODE_ENV === 'production', // Use true in production
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      domain: '.onrender.com' // <-- This was already correct and is being sent
    },
  });

  console.log(`[Debug] firestoreSessionStore is defined: ${!!firestoreSessionStore}`);
  console.log(`[Debug] firestoreSessionStore.get type: ${typeof firestoreSessionStore.get}`);

  // --- NEW LOGGING: Log raw cookies on every HTTP request ---
  app.use((req, res, next) => {
    console.log(`[HTTP Request Debug] Path: ${req.path}, Raw Cookies Header: ${req.headers.cookie}`);
    console.log(`[HTTP Request Debug] Path: ${req.path}, Parsed Signed Cookies: ${JSON.stringify(req.signedCookies)}`);
    console.log(`[HTTP Request Debug] Path: ${req.path}, Parsed Unsigned Cookies: ${JSON.stringify(req.cookies)}`);
    next();
  });
  // --- END NEW LOGGING ---

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
  // This single middleware block handles loading the session and applying Passport logic
  io.use(async (socket, next) => {
      // Mock response object as Passport expects it
      socket.request.res = {
          writeHead: () => {},
          end: () => {},
          setHeader: () => {}
      };

      // --- NEW LOGGING: Log raw cookies from Socket.IO handshake ---
      console.log(`[Socket.IO Session Debug] Socket ${socket.id} handshake cookies: ${socket.request.headers.cookie}`);
      // --- END NEW LOGGING ---

      // Apply cookie-parser middleware to parse the cookie from the socket request
      // We explicitly run it here for Socket.IO as it doesn't go through the main app.use pipeline
      cookieParser(process.env.SESSION_SECRET)(socket.request, socket.request.res, async () => {
          // --- NEW LOGGING: Log parsed cookies from Socket.IO handshake ---
          console.log(`[Socket.IO Session Debug] Socket ${socket.id} parsed cookies (signed): ${JSON.stringify(socket.request.signedCookies)}`);
          console.log(`[Socket.IO Session Debug] Socket ${socket.id} parsed cookies (unsigned): ${JSON.stringify(socket.request.cookies)}`);
          // --- END NEW LOGGING ---

          const sessionId = socket.request.signedCookies['connect.sid'] || socket.request.cookies['connect.sid']; // Get session ID from cookie
          
          if (sessionId) {
              console.log(`[Socket.IO Session Debug] Session ID found for socket ${socket.id}: ${sessionId}`); // Added explicit log for found ID
              try {
                  console.log(`[Socket.IO Session Debug] Attempting to load session ${sessionId} from store for socket ${socket.id}.`);
                  // Promisify firestoreSessionStore.get and await its result
                  const sessionData = await util.promisify(firestoreSessionStore.get).call(firestoreSessionStore, sessionId);
                  if (sessionData) {
                      socket.request.session = sessionData;
                      console.log(`[Socket.IO Session Debug] Session ${sessionId} loaded. Passport user exists: ${!!socket.request.session.passport?.user}`);
                      // --- NEW LOGGING: Log deserialized user if found in session data ---
                      if (socket.request.session.passport?.user) {
                        console.log(`[Socket.IO Session Debug] User in session data: ${JSON.stringify(socket.request.session.passport.user)}`);
                      }
                      // --- END NEW LOGGING ---
                  } else {
                      console.log(`[Socket.IO Session Debug] No session data found for ID ${sessionId}. Initializing empty session.`);
                      socket.request.session = {}; // Initialize empty session if not found
                  }
              } catch (e) {
                  console.error(`[Socket.IO Session Error] Failed to load session ${sessionId} for socket ${socket.id}:`, e);
                  socket.request.session = {}; // Ensure session object exists even on error
              }
          } else {
              console.log(`[Socket.IO Session Debug] No session ID found in cookie for socket ${socket.id}. Initializing empty session.`);
              socket.request.session = {}; // Initialize empty session if no cookie
          }

          // Now apply Passport middleware with the loaded session
          passport.initialize()(socket.request, socket.request.res, () => {
              passport.session()(socket.request, socket.request.res, () => {
                  console.log(`[Socket.IO Auth Final] Final check for socket ${socket.id}. req.user: ${JSON.stringify(socket.request.user)}`);
                  if (socket.request.user) {
                      console.log(`[Socket.IO Auth Final] User authenticated via session: ${socket.request.user.displayName || socket.request.user.id}`);
                  } else {
                      console.log(`[Socket.IO Auth Final] User NOT authenticated for socket ${socket.id}.`);
                  }
                  next(); // Always call next to continue connection process
              });
          });
      });
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
  // --- NEW LOGGING: Confirm `obj` being deserialized ---
  if (!obj || !obj.id) {
    console.error("[Passport] deserializeUser: Received invalid object:", obj);
  }
  // --- END NEW LOGGING ---
  done(null, obj); // The deserialized object should be the same as the serialized one
});

const APP_ID = process.env.RENDER_APP_ID || "minesweeper-flags-default-app";
const GAMES_COLLECTION_PATH = `artifacts/${APP_ID}/public/data/minesweeperGames`;


// === Authentication Routes ===
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
        // Redirect to a specific frontend failure URL, passing an error message
        return res.redirect(`https://minesweeper-flags-frontend.onrender.com/auth/callback-failure?message=${encodeURIComponent("Failed to save session after Facebook login.")}`);
      } else {
        console.log(`[Session Save] Session successfully saved after Facebook auth. Session ID: ${req.sessionID}`);
        // Redirect to frontend success URL with user data
        // Make sure to encodeURIComponent for safe URL parameters
        return res.redirect(`https://minesweeper-flags-frontend.onrender.com/auth/callback-success?userId=${req.user.id}&displayName=${encodeURIComponent(req.user.displayName)}`);
      }
    });
  }
);

app.get("/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

app.get("/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com/login-failed",
  }),
  (req, res) => {
    console.log(`[Session Save] Attempting to save session after Google auth.`);
    req.session.save((err) => {
      if (err) {
        console.error("Error saving session after Google auth:", err);
        // Redirect to a specific frontend failure URL, passing an error message
        return res.redirect(`https://minesweeper-flags-frontend.onrender.com/auth/callback-failure?message=${encodeURIComponent("Failed to save session after Google login.")}`);
      } else {
        console.log(`[Session Save] Session successfully saved after Google auth. Session ID: ${req.sessionID}`);
        // Redirect to frontend success URL with user data
        // Make sure to encodeURIComponent for safe URL parameters
        return res.redirect(`https://minesweeper-flags-frontend.onrender.com/auth/callback-success?userId=${req.user.id}&displayName=${encodeURIComponent(req.user.displayName)}`);
      }
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
          sameSite: 'none',
          domain: '.onrender.com' 
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
  // --- NEW LOGGING: Check if session contains passport data directly ---
  console.log("Passport data in session:", req.session.passport);
  // --- END NEW LOGGING ---


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

// Helper function to check if a game is truly "active" in memory
// A game is considered "active" in memory if both players have non-null socket IDs
// AND those socket IDs match their current entries in userSocketMap.
const isGameActiveInMemory = (game) => {
    if (!game || !game.players || game.players.length !== 2) return false;

    const player1 = game.players.find(p => p.number === 1);
    const player2 = game.players.find(p => p.number === 2);

    // Ensure player objects exist before checking properties
    const player1ConnectedAndActive = player1 && player1.socketId && userSocketMap[player1.userId] === player1.socketId;
    const player2ConnectedAndActive = player2 && player2.socketId && userSocketMap[player2.userId] === player2.socketId;

    return player1ConnectedAndActive && player2ConnectedAndActive;
};


// === Socket.IO Connection and Game Events ===
io.on("connection", (socket) => {
  console.log(`Socket Connected: ${socket.id}`);

  const userIdOnConnect = socket.request.user ? socket.request.user.id : null;
  const userNameOnConnect = socket.request.user ? socket.request.user.displayName : null;

  if (userIdOnConnect) {
    console.log(`User ${userNameOnConnect} (${userIdOnConnect}) connected via socket.`);
    userSocketMap[userIdOnConnect] = socket.id; // Store current socket ID for this user
    console.log(`[Connect Debug] userGameMap for ${userIdOnConnect}: ${userGameMap[userIdOnConnect]}`); // ADDED LOG

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
                        player1 = { userId: gameData.player1_userId, name: gameData.player1_name, inGame: true }; // Removed number from initial creation
                        players.push(player1);
                    }
                    player1.number = 1; // FIX: Ensure number is set regardless of new or existing player object
                    player1.socketId = userSocketMap[player1.userId] || null;
                    player1.id = player1.socketId; // Use socketId as id for consistency
                    player1.inGame = true;

                    let player2 = players.find(p => p.userId === gameData.player2_userId);
                    if (!player2) {
                        player2 = { userId: gameData.player2_userId, name: gameData.player2_name, inGame: true }; // Removed number from initial creation
                        players.push(player2);
                    }
                    player2.number = 2; // FIX: Ensure number is set regardless of new or existing player object
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
                // Ensure the player number is consistent even if re-using an in-memory object
                // The playerInGame object should already have the 'number' from its initial setup
                // but if it somehow got corrupted, this ensures it's correct.
                // However, the resume-game flow below handles this more robustly.
                playerInGame.socketId = socket.id;
                playerInGame.id = socket.id; // Use socketId as id for consistency
                playerInGame.inGame = true; // Ensure marked as inGame

                // NEW: Update opponent's socketId in memory from userSocketMap
                const opponentPlayer = game.players.find(op => op.userId !== userIdOnConnect);
                if (opponentPlayer) {
                    opponentPlayer.socketId = userSocketMap[opponentPlayer.userId] || null; // Will be null if opponent not connected
                    opponentPlayer.id = opponentPlayer.socketId; // Update id as well
                }

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
  }
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
        console.log(`[Request Unfinished Games] User ${userName} (${userId}) is requesting unfinished games.`);
        const gamesQuerySnapshot = await db.collection(GAMES_COLLECTION_PATH)
            .where('status', 'in', ['active', 'waiting_for_resume'])
            .get();

        let unfinishedGames = [];

        gamesQuerySnapshot.forEach(doc => {
            const gameData = doc.data();
            // --- FIX: Skip malformed documents without gameId ---
            if (!gameData || !gameData.gameId) {
                console.warn(`[Request Unfinished Games] Skipping invalid Firestore document: ${doc.id} (no gameId or empty data).`);
                return; // Skip to next document
            }
            console.log(`[Request Unfinished Games] Inspecting Firestore game: ${gameData.gameId}, Status: ${gameData.status}`);
            console.log(`[Request Unfinished Games] Player1: ${gameData.player1_userId}, Player2: ${gameData.player2_userId}`);

            const isPlayer1 = gameData.player1_userId === userId;
            const isPlayer2 = gameData.player2_userId === userId;

            if (isPlayer1 || isPlayer2) {
                const gameInMemory = games[gameData.gameId];
                // --- FIX: Use the new helper to accurately determine if the game is truly active in memory ---
                const isActuallyFullyActive = isGameActiveInMemory(gameInMemory);

                console.log(`[Request Unfinished Games] User ${userId} is participant in ${gameData.gameId}.`);
                console.log(`[Request Unfinished Games] Game in memory (games[gameData.gameId]): ${!!gameInMemory}`);
                if (gameInMemory) {
                    console.log(`[Request Unfinished Games] Game ${gameData.gameId} players in memory: ${JSON.stringify(gameInMemory.players.map(p => ({ userId: p.userId, socketId: p.socketId })))}`);
                }
                console.log(`[Request Unfinished Games] Current userSocketMap[userId]: ${userSocketMap[userId]}`);
                console.log(`[Request Unfinished Games] Is actually fully active (helper check)? ${isActuallyFullyActive}`);


                if (!isActuallyFullyActive) { // Only add to unfinished if not fully active in memory with both players
                    unfinishedGames.push({
                        gameId: gameData.gameId,
                        board: gameData.board, // Send serialized board
                        opponentName: isPlayer1 ? gameData.player2_name : gameData.player1_name,
                        myPlayerNumber: isPlayer1 ? 1 : 2,
                        status: gameData.status,
                        lastUpdated: gameData.lastUpdated ? gameData.lastUpdated.toDate().toLocaleString() : 'N/A'
                    });
                    console.log(`[Request Unfinished Games] Added game ${gameData.gameId} to list.`);
                } else {
                    console.log(`[Request Unfinished Games] Game ${gameData.gameId} is fully active with current socket, skipping.`);
                }
            } else {
                console.log(`[Request Unfinished Games] User ${userId} is not a participant in game ${gameData.gameId}.`);
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
                // Ensure player number is correctly assigned to the existing in-memory player object
                playerInExistingGame.number = (gameData.player1_userId === userId) ? 1 : 2; // FIX: Assign correct player number
                playerInExistingGame.socketId = socket.id;
                playerInExistingGame.id = socket.id; // Use socketId as id for consistency
                playerInExistingGame.inGame = true; // Ensure marked as inGame
                userSocketMap[userId] = socket.id; // Update global map

                const opponentPlayer = existingGame.players.find(op => op.userId !== userId);
                // Update opponent's socketId in memory from userSocketMap
                if (opponentPlayer) {
                    opponentPlayer.socketId = userSocketMap[opponentPlayer.userId] || null; // Will be null if opponent not connected
                    opponentPlayer.id = opponentPlayer.socketId; // Update id as well
                }
                
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
                console.log(`[Resume Game Emit Debug] Player ${userName} assigned number: ${playerInExistingGame.number}`); // Added debug log

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
            bombsUsed: game.bombsUsed,
            turn: gameData.turn,
            gameOver: game.gameOver,
            lastClickedTile: gameData.lastClickedTile || { 1: null, 2: null }, // Load last clicked tile
            players: []
        };

        // Reconstruct player objects for the game and update global players list
        let player1 = players.find(p => p.userId === gameData.player1_userId);
        if (!player1) {
            player1 = { userId: gameData.player1_userId, name: gameData.player1_name };
            players.push(player1);
        }
        player1.number = 1; // FIX: Ensure number is always set for player1
        player1.socketId = userSocketMap[player1.userId] || null;
        player1.id = player1.socketId; // Use socketId as id for consistency
        player1.inGame = true; // Mark as in game

        let player2 = players.find(p => p.userId === gameData.player2_userId);
        if (!player2) {
            player2 = { userId: gameData.player2_userId, name: gameData.player2_name };
            players.push(player2);
        }
        player2.number = 2; // FIX: Ensure number is always set for player2
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
              gameId: game.gameId, // <-- ensure gameId is always explicitly set
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
    if (!player || player.number !== game.turn) return; // Turn check

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

    // FIX: Add turn check for "use-bomb"
    if (player.number !== game.turn) {
        console.warn(`Player ${player.name} (${player.userId}) attempted to use bomb out of turn in game ${gameId}.`);
        io.to(player.socketId).emit("bomb-error", "It's not your turn to use a bomb.");
        return;
    }

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

    // FIX: Add turn check for "bomb-center"
    if (player.number !== game.turn) {
        console.warn(`Player ${player.name} (${player.userId}) attempted to set bomb center out of turn in game ${gameId}.`);
        io.to(player.socketId).emit("bomb-error", "It's not your turn to set the bomb center.");
        return;
    }

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

    // Find the player in the global players array
    const leavingPlayerGlobalEntry = players.find((p) => p.userId === userId);
    if (!leavingPlayerGlobalEntry) {
      console.log(`Player with ID ${userId} not found in global list on leave-game.`);
      return;
    }

    // Attempt to find the game in memory
    const game = games[gameId];
    if (!game) { // If game not in memory, but user was mapped to it, clean up
        delete userGameMap[userId];
        leavingPlayerGlobalEntry.inGame = false;
        leavingPlayerGlobalEntry.number = null;
        leavingPlayerGlobalEntry.socketId = null;
        leavingPlayerGlobalEntry.id = null;
        console.log(`Game ${gameId} not found in memory for user ${userId} on leave. Cleaning userGameMap and player entry.`);
        io.emit(
            "players-list",
            players.filter((p) => !p.inGame && !userGameMap[p.userId]).map((p) => ({ id: p.id, name: p.name }))
        );
        return;
    }

    // Find the player object within the specific game's players array
    const leavingPlayerInGame = game.players.find(p => p.userId === userId);
    if (!leavingPlayerInGame) {
        console.log(`User ${userId} not found in game ${gameId}'s player list, despite being mapped. Consistency issue?`);
        // Clean up in-memory state for this user if somehow inconsistent
        delete userGameMap[userId];
        leavingPlayerGlobalEntry.inGame = false;
        leavingPlayerGlobalEntry.number = null;
        leavingPlayerGlobalEntry.socketId = null;
        leavingPlayerGlobalEntry.id = null;
        io.emit(
            "players-list",
            players.filter((p) => !p.inGame && !userGameMap[p.userId]).map((p) => ({ id: p.id, name: p.name }))
        );
        return;
    }

    console.log(`Player ${leavingPlayerGlobalEntry.name} (ID: ${userId}) initiating leave from game ${gameId}.`);

    // Mark leaving player's in-game status and socket as null
    leavingPlayerGlobalEntry.inGame = false;
    leavingPlayerGlobalEntry.number = null; // No longer has a player number
    leavingPlayerGlobalEntry.socketId = null; // No longer connected via this socket for the game
    leavingPlayerGlobalEntry.id = null; // Corresponding id in players list also nulled

    leavingPlayerInGame.socketId = null; // Also nullify within the game object
    leavingPlayerInGame.id = null; // Corresponding id in game.players also nulled

    delete userGameMap[userId]; // Remove user's game mapping

    const opponentPlayer = game.players.find(p => p.userId !== userId);

    if (opponentPlayer) {
        if (opponentPlayer.socketId) {
            io.to(opponentPlayer.socketId).emit("opponent-left");
            console.log(`Notified opponent ${opponentPlayer.name} of ${leavingPlayerGlobalEntry.name}'s disconnection.`);
        }
        // Ensure opponent's global player entry is also marked for lobby if they're not connected to it
        const opponentGlobalEntry = players.find(p => p.userId === opponentPlayer.userId);
        if(opponentGlobalEntry) {
            opponentGlobalEntry.inGame = false; // Opponent is now also effectively in lobby
            opponentGlobalEntry.number = null;
        }

        // Update Firestore status to 'waiting_for_resume'
        try {
            await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                status: 'waiting_for_resume',
                lastUpdated: Timestamp.now()
            }, { merge: true });
            console.log(`Game ${gameId} status set to 'waiting_for_resume' in Firestore.`);
        } catch (error) {
            console.error("Error updating game status on leave:", error);
        }
        // IMPORTANT: DO NOT delete game from `games` in-memory here. Keep it for resume.
    } else {
        // Last player leaving
        // Delete game from in-memory `games` object
        delete games[gameId];
        // Update Firestore status to 'completed'
        try {
            await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                status: 'completed',
                lastUpdated: Timestamp.now()
            }, { merge: true });
            console.log(`Game ${gameId} status set to 'completed' as last player left.`);
        } catch (error) {
            console.error("Error updating game status to 'completed' on leave:", error);
        }
    }

    // Emit updated players list (filter out those still in-game or mapped to a game)
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
        console.log(`[Disconnect] User ${disconnectedUserId} was in game ${gameId}. Game in memory: ${!!game}.`); // ADDED LOG

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
