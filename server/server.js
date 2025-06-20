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
const util = require('util'); // Import util for promisify

// --- Redis Session Store Imports ---
const RedisStore = require("connect-redis").default;
const { createClient } = require("redis");

// --- Firebase Admin SDK Imports ---
const admin = require('firebase-admin');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { Firestore } = require('@google-cloud/firestore'); // Required by @google-cloud/connect-firestore


const app = express();
const server = http.createServer(app);

// New global data structures (in-memory, these will be synchronized with Firestore)
const userSocketMap = {}; // Maps userId to current socket.id
const userGameMap = {};   // Maps userId to current gameId
let players = []; // Lobby players: { id: socket.id, userId, name, number, inGame }
let games = {};   // Active games: gameId: { players: [{userId, name, number, socketId}], board, scores, bombsUsed, turn, gameOver }

// Configure CORS for Express
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

// === Environment Variables for OAuth ===
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const FACEBOOK_CLIENT_ID = process.env.FACEBOOK_CLIENT_ID;
const FACEBOOK_CLIENT_SECRET = process.env.FACEBOOK_CLIENT_SECRET;

// --- Firebase and Firestore Setup ---
let db;
const APP_ID = process.env.RENDER_APP_ID || "minesweeper-flags-default-app"; // Using Render's app ID for collection path
const GAMES_COLLECTION_PATH = `artifacts/${APP_ID}/public/data/minesweeperGames`;

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = getFirestore();
  console.log("Firebase Admin SDK and Firestore initialized.");

} catch (error) {
  console.error("Failed to initialize Firebase Admin SDK. Ensure FIREBASE_SERVICE_ACCOUNT_KEY is set correctly.", error);
  process.exit(1); // Exit if Firebase cannot be initialized
}

// === Redis Client Setup ===
let redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('connect', () => console.log('Connected to Redis!'));
redisClient.on('error', (err) => console.error('Redis Client Error', err));

// Connect to Redis and then start the server
redisClient.connect()
  .then(() => {
    console.log("Redis client successfully connected and ready.");

    // === Express Session Middleware ===
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

    // Promisify deserializeUser for async/await usage in Socket.IO middleware
    const deserializeUserPromise = util.promisify(passport.deserializeUser);

    // === IMPORTANT: Integrate session and passport middleware with Socket.IO ===
    // This middleware will run for every incoming Socket.IO connection.
    io.use(async (socket, next) => {
        const req = socket.request;
        const res = {}; // Minimal mock res object, some session stores might touch it

        try {
            // Apply session middleware to parse cookies and load session from store
            // We use a Promise wrapper to make it awaitable.
            await new Promise((resolve, reject) => {
                sessionMiddleware(req, res, (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });

            console.log(`[Socket.IO Auth] After sessionMiddleware for ${socket.id}. Session ID: ${req.sessionID}. Session exists: ${!!req.session}`);
            console.log(`[Socket.IO Auth] Session.passport exists: ${!!req.session?.passport}`);
            console.log(`[Socket.IO Auth] Session.passport.user: ${JSON.stringify(req.session?.passport?.user)}`);

            // If session is loaded and contains passport user data, manually deserialize it
            if (req.session && req.session.passport && req.session.passport.user) {
                // Call the promisified deserializeUser to get the user object.
                req.user = await deserializeUserPromise(req.session.passport.user);
                console.log(`[Socket.IO Auth] User deserialized and attached: ${req.user ? req.user.displayName || req.user.id : 'N/A'}`);
            } else {
                req.user = null; // Ensure req.user is null if no passport user data is found
                console.log("Socket.IO Auth: No passport user found in session after sessionMiddleware.");
            }
            next(); // Allow the connection to proceed
        } catch (err) {
            console.error("Socket.IO authentication middleware error:", err);
            next(new Error("Authentication failed during Socket.IO handshake."));
        }
    });
    // === END Socket.IO Session Integration ===

    passport.use(new GoogleStrategy({
      clientID: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/google/callback"
    }, (accessToken, refreshToken, profile, done) => {
      console.log(`[Passport Callback] Google Strategy: Received profile for user ID: ${profile.id}, Name: ${profile.displayName}`);
      done(null, { id: profile.id, displayName: profile.displayName });
    }));

    passport.use(new FacebookStrategy({
        clientID: FACEBOOK_CLIENT_ID,
        clientSecret: FACEBOOK_CLIENT_SECRET,
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
      done(null, user);
    });

    passport.deserializeUser((user, done) => {
      console.log(`[Passport] deserializeUser: Deserializing user - ID: ${user.id}, Name: ${user.displayName || user.name}`);
      done(null, user);
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
              domain: '.onrender.com', // Crucial for clearing cross-domain cookies
              secure: process.env.NODE_ENV === 'production',
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

      // Safely get userId and displayName from socket.request.user
      // This part runs *after* the io.use middleware chain, which should populate req.user
      const userIdOnConnect = socket.request.user ? socket.request.user.id : null;
      const userNameOnConnect = socket.request.user ? socket.request.user.displayName : null;

      if (userIdOnConnect) {
        console.log(`User ${userNameOnConnect} (${userIdOnConnect}) connected via socket.`);
        userSocketMap[userIdOnConnect] = socket.id; // Store current socket ID for this user

        // Handle rejoining an existing game (if any)
        if (userGameMap[userIdOnConnect]) {
            const gameId = userGameMap[userIdOnConnect];
            // Attempt to find in-memory game first, then Firestore
            let game = games[gameId]; 

            if (!game) { // If not in memory, try to load from Firestore
                db.collection(GAMES_COLLECTION_PATH).doc(gameId).get().then(doc => {
                    if (doc.exists && (doc.data().status === 'active' || doc.data().status === 'waiting_for_resume')) {
                        const gameData = doc.data();
                        const deserializedBoard = JSON.parse(gameData.board); // Deserialize board

                        // Reconstruct in-memory game object
                        game = {
                            gameId: gameData.gameId,
                            board: deserializedBoard,
                            scores: gameData.scores,
                            bombsUsed: gameData.bombsUsed,
                            turn: gameData.turn,
                            gameOver: gameData.gameOver,
                            players: [] // Will be populated with proper player objects
                        };

                        // Reconstruct player objects for in-memory game
                        let player1 = players.find(p => p.userId === gameData.player1_userId);
                        if (!player1) { // If player not in global players list, add them
                            player1 = { userId: gameData.player1_userId, name: gameData.player1_name, number: 1, inGame: true };
                            players.push(player1);
                        }
                        player1.socketId = userSocketMap[player1.userId] || null;
                        player1.inGame = true;

                        let player2 = players.find(p => p.userId === gameData.player2_userId);
                        if (!player2) {
                            player2 = { userId: gameData.player2_userId, name: gameData.player2_name, number: 2, inGame: true };
                            players.push(player2);
                        }
                        player2.socketId = userSocketMap[player2.userId] || null;
                        player2.inGame = true;

                        game.players = [player1, player2];
                        games[gameId] = game; // Add game to in-memory active games

                        // Set game status to active if it was waiting for resume
                        if (gameData.status === 'waiting_for_resume') {
                            doc.ref.set({ status: 'active', lastUpdated: Timestamp.now() }, { merge: true }).then(() => {
                                console.log(`Game ${gameId} status updated to 'active' in Firestore on resume.`);
                            }).catch(e => console.error("Error updating game status on resume:", e));
                        }
                        console.log(`Game ${gameId} loaded from Firestore and rehydrated in memory.`);
                        
                        // Send game state to reconnected player
                        const playerInGame = game.players.find(p => p.userId === userIdOnConnect);
                        if (playerInGame && playerInGame.socketId) {
                            const opponentPlayer = game.players.find(op => op.userId !== userIdOnConnect);
                            io.to(playerInGame.socketId).emit("game-start", {
                                gameId: game.gameId,
                                playerNumber: playerInGame.number,
                                board: game.board, // Send direct object as client expects it
                                turn: game.turn,
                                scores: game.scores,
                                bombsUsed: game.bombsUsed,
                                gameOver: game.gameOver,
                                opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
                            });
                            console.log(`Emitted game-start to reconnected user ${playerInGame.name} for game ${gameId}.`);
                        }
                        // Notify opponent if they are also online
                        const opponentPlayer = game.players.find(op => op.userId !== userIdOnConnect);
                        if (opponentPlayer && opponentPlayer.socketId) {
                            io.to(opponentPlayer.socketId).emit("opponent-reconnected", { name: userNameOnConnect });
                            console.log(`Notified opponent ${opponentPlayer.name} of ${userNameOnConnect} re-connection in game ${gameId}.`);
                        }
                        io.emit("players-list", players.filter(p => !p.inGame && !userGameMap[p.userId]).map(p => ({ id: p.id, name: p.name })));

                    } else {
                        delete userGameMap[userIdOnConnect]; // Game not found or invalid status, clear map
                        console.log(`Game ${gameId} for user ${userIdOnConnect} not found or invalid status in Firestore, clearing map.`);
                    }
                }).catch(e => {
                    console.error("Error fetching game from Firestore on reconnect:", e);
                });
            } else { // Game found in memory
                const playerInGame = game.players.find(p => p.userId === userIdOnConnect);
                if (playerInGame) {
                    playerInGame.socketId = socket.id; // Ensure current socketId is used in game object
                    console.log(`Re-sent active game state for game ${gameId} to ${playerInGame.name}.`);
                }
                const opponentPlayer = game.players.find(op => op.userId !== userIdOnConnect);
                if (opponentPlayer && opponentPlayer.socketId) {
                    io.to(opponentPlayer.socketId).emit("opponent-reconnected", { name: userNameOnConnect });
                }
                // Send game state to reconnected player
                io.to(playerInGame.socketId).emit("game-start", {
                    gameId: game.gameId,
                    playerNumber: playerInGame.number,
                    board: game.board,
                    turn: game.turn,
                    scores: game.scores,
                    bombsUsed: game.bombsUsed,
                    gameOver: game.gameOver,
                    opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
                });
            }
        }
      } else {
          console.log(`Unauthenticated or session-less socket ${socket.id} connected. (No req.user)`);
          // No 'authenticated-socket-ready' is emitted for unauthenticated sockets.
          // The client will remain in the login state.
      }


      socket.on("join-lobby", (name) => {
        // Crucial: Get the authenticated user ID from `socket.request.user`
        const userId = socket.request.user ? socket.request.user.id : null;
        const userDisplayName = socket.request.user ? socket.request.user.displayName : null;

        if (!userId) {
          // Reject if not authenticated
          socket.emit("join-error", "Authentication required to join lobby. Please login.");
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
        // Emit authenticated-socket-ready AFTER successful lobby join
        socket.emit('authenticated-socket-ready'); // ADDED THIS LINE
        console.log(`Emitted 'authenticated-socket-ready' after lobby-joined for user ${userDisplayName || name}.`);


        // Filter players for lobby list: only those not in a game
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
                .where('status', 'in', ['active', 'waiting_for_resume']) // Fetch active or waiting games
                .get();

            let unfinishedGames = [];

            gamesQuerySnapshot.forEach(doc => {
                const gameData = doc.data();
                // Check if the current user is part of this game
                const isPlayer1 = gameData.player1_userId === userId;
                const isPlayer2 = gameData.player2_userId === userId;

                if (isPlayer1 || isPlayer2) {
                    unfinishedGames.push({
                        gameId: gameData.gameId,
                        board: gameData.board, // Send serialized board for client-side use
                        opponentName: isPlayer1 ? gameData.player2_name : gameData.player1_name,
                        myPlayerNumber: isPlayer1 ? 1 : 2,
                        status: gameData.status,
                        lastUpdated: gameData.lastUpdated ? gameData.lastUpdated.toDate().toLocaleString() : 'N/A'
                    });
                }
            });

            socket.emit("receive-unfinished-games", unfinishedGames);
            console.log(`Sent ${unfinishedGames.length} unfinished games to user ${userName}.`);

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

            // Reconstruct in-memory game object from Firestore data
            const deserializedBoard = JSON.parse(gameData.board);

            const game = {
                gameId: gameData.gameId,
                board: deserializedBoard,
                scores: gameData.scores,
                bombsUsed: gameData.bombsUsed,
                turn: gameData.turn,
                gameOver: gameData.gameOver,
                players: []
            };

            let player1 = players.find(p => p.userId === gameData.player1_userId);
            if (!player1) {
                player1 = { userId: gameData.player1_userId, name: gameData.player1_name, number: 1 };
                players.push(player1);
            }
            player1.socketId = userSocketMap[player1.userId] || null;
            player1.inGame = true;

            let player2 = players.find(p => p.userId === gameData.player2_userId);
            if (!player2) {
                player2 = { userId: gameData.player2_userId, name: gameData.player2_name, number: 2 };
                players.push(player2);
            }
            player2.socketId = userSocketMap[player2.userId] || null;
            player2.inGame = true;

            game.players = [player1, player2];
            games[gameId] = game; // Add to in-memory active games
            userGameMap[player1.userId] = gameId;
            userGameMap[player2.userId] = gameId;

            // Update Firestore status to 'active' as game is being resumed
            await gameDocRef.set({ status: 'active', lastUpdated: Timestamp.now() }, { merge: true });
            console.log(`Game ${gameId} status updated to 'active' in Firestore on resume.`);

            // Emit game-start to the player who resumed
            const currentPlayerInGame = game.players.find(p => p.userId === userId);
            const opponentPlayerInGame = game.players.find(op => op.userId !== userId);

            if (currentPlayerInGame && currentPlayerInGame.socketId) {
                io.to(currentPlayerInGame.socketId).emit("game-start", {
                    gameId: game.gameId,
                    playerNumber: currentPlayerInGame.number,
                    board: game.board,
                    turn: game.turn,
                    scores: game.scores,
                    bombsUsed: game.bombsUsed,
                    gameOver: game.gameOver,
                    opponentName: opponentPlayerInGame ? opponentPlayerInGame.name : "Opponent"
                });
                console.log(`User ${userName} successfully resumed game ${gameId}.`);
                socket.emit('authenticated-socket-ready'); // ADDED THIS LINE
                console.log(`Emitted 'authenticated-socket-ready' after resuming game for user ${userName}.`);
            }

            if (opponentPlayerInGame && opponentPlayerInGame.socketId) {
                io.to(opponentPlayerInGame.socketId).emit("opponent-reconnected", { name: userName });
                console.log(`Notified opponent ${opponentPlayerInGame.name} that ${userName} reconnected to game ${gameId}.`);
            }

            io.emit(
              "players-list",
              players.filter((p) => !p.inGame && !userGameMap[p.userId]).map((p) => ({ id: p.id, name: p.name }))
            );

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
        if (inviter.inGame || invitee.inGame || userGameMap[inviter.userId] || userGameMap[invitee.userId]) {
            console.warn(`Invite failed: Inviter or invitee already in game or already mapped.`);
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

          inviter.number = 1;
          inviter.inGame = true;
          inviter.socketId = inviter.id;
          responder.number = 2;
          responder.inGame = true;
          responder.socketId = responder.id;

          const game = {
            gameId,
            players: [inviter, responder],
            board,
            scores,
            bombsUsed,
            turn,
            gameOver,
          };
          games[gameId] = game;

          userGameMap[inviter.userId] = gameId;
          userGameMap[responder.userId] = gameId;

          console.log(`Game ${gameId} started between ${inviter.name} (ID: ${inviter.userId}) and ${responder.name} (ID: ${responder.userId}).`);

          // Save initial game state to Firestore
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
                  status: 'active', // Mark as active
                  lastUpdated: Timestamp.now(),
                  winnerId: null,
                  loserId: null
              }, { merge: true });
              console.log(`Game ${gameId} saved to Firestore.`);
          } catch (error) {
              console.error("Error saving new game to Firestore:", error);
              // If DB save fails, clean up in-memory game and maps
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
      socket.on("tile-click", async ({ gameId, x, y }) => {
        const game = games[gameId];
        if (!game || game.gameOver) return;

        const currentUserId = socket.request.user ? socket.request.user.id : null;
        const player = game.players.find((p) => p.userId === currentUserId);
        if (!player || player.number !== game.turn) return;

        player.socketId = socket.id;

        const tile = game.board[y][x];
        if (tile.revealed) return;

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

            try {
                const serializedBoard = JSON.stringify(game.board);
                await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                    board: serializedBoard,
                    scores: game.scores,
                    bombsUsed: game.bombsUsed,
                    turn: game.turn,
                    gameOver: game.gameOver,
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
                        board: game.board,
                        turn: game.turn,
                        scores: game.scores,
                        bombsUsed: game.bombsUsed,
                        gameOver: game.gameOver,
                        opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
                    });
                }
            });
            return; // Exit after restarting
          }

          revealRecursive(game.board, x, y);
          game.turn = game.turn === 1 ? 2 : 1;
        }

        // Update game state in Firestore
        try {
            const serializedBoard = JSON.stringify(game.board);
            await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                board: serializedBoard,
                turn: game.turn,
                scores: game.scores,
                bombsUsed: game.bombsUsed,
                gameOver: game.gameOver,
                lastUpdated: Timestamp.now(),
                winnerId: game.gameOver ? (game.scores[1] > game.scores[2] ? player.userId : game.players.find(p => p.userId !== currentUserId).userId) : null,
                loserId: game.gameOver ? (game.scores[1] < game.scores[2] ? player.userId : game.players.find(p => p.userId !== currentUserId).userId) : null
            }, { merge: true });
            console.log(`Game ${gameId} updated in Firestore (tile-click).`);
        } catch (error) {
            console.error("Error updating game in Firestore (tile-click):", error);
        }

        game.players.forEach(p => {
            if(p.socketId) io.to(p.socketId).emit("board-update", game);
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

        io.to(player.id).emit("wait-bomb-center");
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

        const MIN_COORD = 2;
        const MAX_COORD_X = WIDTH - 3;
        const MAX_COORD_Y = HEIGHT - 3;

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

        game.bombsUsed[player.number] = true;
        revealArea(game.board, x, y, player.number, game.scores);

        if (checkGameOver(game.scores)) game.gameOver = true;
        else game.turn = game.turn === 1 ? 2 : 1;

        console.log(`Player ${player.name} used bomb at ${x},${y}. New scores: P1: ${game.scores[1]}, P2: ${game.scores[2]}`);

        // Update game state in Firestore
        try {
            const serializedBoard = JSON.stringify(game.board);
            await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                board: serializedBoard,
                turn: game.turn,
                scores: game.scores,
                bombsUsed: game.bombsUsed,
                gameOver: game.gameOver,
                lastUpdated: Timestamp.now(),
                winnerId: game.gameOver ? (game.scores[1] > game.scores[2] ? player.userId : game.players.find(p => p.userId !== currentUserId).userId) : null,
                loserId: game.gameOver ? (game.scores[1] < game.scores[2] ? player.userId : game.players.find(p => p.userId !== currentUserId).userId) : null
            }, { merge: true });
            console.log(`Game ${gameId} updated in Firestore (bomb-center).`);
        } catch (error) {
            console.error("Error updating game in Firestore (bomb-center):", error);
        }

        game.players.forEach(p => {
            if(p.socketId) io.to(p.socketId).emit("board-update", game);
        });
      });

      socket.on("restart-game", async ({ gameId }) => {
        const game = games[gameId];
        if (!game) return;

        const currentUserId = socket.request.user ? socket.request.user.id : null;
        const player = game.players.find((p) => p.userId === currentUserId);
        if (!player) return;

        player.socketId = socket.id;

        console.log(`Player ${player.name} requested game ${gameId} restart.`);

        game.board = generateBoard();
        game.scores = { 1: 0, 2: 0 };
        game.bombsUsed = { 1: false, 2: false };
        game.turn = 1;
        game.gameOver = false;

        // Update game state in Firestore
        try {
            const serializedBoard = JSON.stringify(game.board);
            await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                board: serializedBoard,
                scores: game.scores,
                bombsUsed: game.bombsUsed,
                turn: game.turn,
                gameOver: game.gameOver,
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
            if(p.socketId) io.to(p.socketId).emit("board-update", game);
        });
      });

      socket.on("leave-game", async ({ gameId }) => {
        const userId = socket.request.user ? socket.request.user.id : null;
        if (!userId) return;

        const leavingPlayer = players.find((p) => p.userId === userId);
        if (!leavingPlayer) {
          console.log(`Player with ID ${userId} not found on leave-game.`);
          return;
        }

        leavingPlayer.inGame = false;
        leavingPlayer.number = null;
        delete userGameMap[userId];

        console.log(`Player ${leavingPlayer.name} (ID: ${userId}) left game ${gameId}.`);

        const game = games[gameId];
        if (game) {
          game.players = game.players.filter(p => p.userId !== userId);

          if (game.players.length === 0) {
            delete games[gameId];
            try {
                await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                    status: 'completed', // Mark as completed if all players left
                    lastUpdated: Timestamp.now()
                }, { merge: true });
                console.log(`Game ${gameId} status set to 'completed' in Firestore as all players left.`);
            } catch (error) {
                console.error("Error updating game status to 'completed' on leave:", error);
            }
            console.log(`Game ${gameId} deleted from memory.`);
          } else {
            const opponent = game.players[0];
            if (opponent && opponent.socketId) {
                io.to(opponent.socketId).emit("opponent-left");
                const opponentGlobalEntry = players.find(p => p.userId === opponent.userId);
                if(opponentGlobalEntry) {
                    opponentGlobalEntry.inGame = false;
                    opponentGlobalEntry.number = null;
                    delete userGameMap[opponent.userId];
                }
            }
            // Update game status to 'waiting_for_resume' if one player left
            try {
                await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                    status: 'waiting_for_resume',
                    lastUpdated: Timestamp.now()
                }, { merge: true });
                console.log(`Game ${gameId} status set to 'waiting_for_resume' in Firestore due to leave.`);
            } catch (error) {
                console.error("Error updating game status to 'waiting_for_resume' on leave:", error);
            }
            delete games[gameId]; // Clear from memory to ensure it's loaded from DB on resume
          }
        }

        let playerEntry = players.find(p => p.userId === userId);
        if (!playerEntry) {
            playerEntry = { id: socket.id, userId: userId, name: leavingPlayer.name, number: null, inGame: false };
            players.push(playerEntry);
        } else {
            playerEntry.id = socket.id;
            playerEntry.inGame = false;
            playerEntry.number = null;
        }

        io.emit(
          "players-list",
          players.filter((p) => !p.inGame && !userGameMap[p.userId]).map((p) => ({ id: p.id, name: p.name }))
        );
      });


      socket.on("disconnect", async () => {
        console.log(`Socket disconnected: ${socket.id}`);
        const disconnectedUserId = socket.request.user ? socket.request.user.id : null;

        if (disconnectedUserId) {
            delete userSocketMap[disconnectedUserId];
        }

        players = players.filter(p => !(p.id === socket.id && !userGameMap[p.userId]));

        io.emit("players-list", players.filter(p => !p.inGame && !userGameMap[p.userId]).map(p => ({ id: p.id, name: p.name })));

        if (disconnectedUserId && userGameMap[disconnectedUserId]) {
            const gameId = userGameMap[disconnectedUserId];
            const game = games[gameId]; // Get game from memory if it exists

            if (game) {
                const disconnectedPlayerInGame = game.players.find(p => p.userId === disconnectedUserId);
                if (disconnectedPlayerInGame) {
                    disconnectedPlayerInGame.socketId = null;
                    console.log(`Player ${disconnectedPlayerInGame.name} (${disconnectedUserId}) in game ${gameId} disconnected (socket marked null).`);
                }

                const allPlayersDisconnected = game.players.every(p => p.socketId === null);

                if (allPlayersDisconnected) {
                    game.players.forEach(p => {
                        delete userGameMap[p.userId];
                        const globalPlayerEntry = players.find(gp => gp.userId === p.userId);
                        if (globalPlayerEntry) {
                            globalPlayerEntry.inGame = false;
                            globalPlayerEntry.number = null;
                        }
                    });
                    delete games[gameId]; // Remove from memory
                    try {
                        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                            status: 'waiting_for_resume', // Mark as resumable if all players disconnected
                            lastUpdated: Timestamp.now()
                        }, { merge: true });
                        console.log(`Game ${gameId} status set to 'waiting_for_resume' in Firestore on total disconnect.`);
                    } catch (error) {
                        console.error("Error updating game status to 'waiting_for_resume' on total disconnect:", error);
                    }
                } else {
                    const remainingPlayer = game.players.find(p => p.userId !== disconnectedUserId);
                    if (remainingPlayer && remainingPlayer.socketId) {
                        io.to(remainingPlayer.socketId).emit("opponent-left");
                        console.log(`Notified opponent ${remainingPlayer.name} that their partner disconnected.`);
                    }
                    // Mark in Firestore as waiting for resume if only one player remains/disconnected
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
            } else { // Game not in memory, but was in userGameMap. Try to update in Firestore.
                try {
                    const gameDocRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
                    const gameDoc = await gameDocRef.get();
                    if (gameDoc.exists && (gameDoc.data().status === 'active' || gameDoc.data().status === 'waiting_for_resume')) {
                        const gameData = gameDoc.data();
                        const player1Disconnected = gameData.player1_userId === disconnectedUserId;
                        const player2Disconnected = gameData.player2_userId === disconnectedUserId;

                        const otherPlayerId = player1Disconnected ? gameData.player2_userId : gameData.player1_userId;
                        const otherPlayerStillConnected = userSocketMap[otherPlayerId] !== undefined;

                        if (!otherPlayerStillConnected) {
                            await gameDocRef.set({
                                status: 'waiting_for_resume',
                                lastUpdated: Timestamp.now()
                            }, { merge: true });
                            console.log(`Game ${gameId} (Firestore) status set to 'waiting_for_resume' because both players are effectively disconnected.`);
                        } else {
                            await gameDocRef.set({
                                status: 'waiting_for_resume',
                                lastUpdated: Timestamp.now()
                            }, { merge: true });
                            console.log(`Game ${gameId} (Firestore) status set to 'waiting_for_resume' as one player disconnected.`);
                        }
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

  }) // End of redisClient.connect().then()
  .catch(e => {
    console.error("Failed to connect to Redis, server will not start:", e);
    process.exit(1); // Exit if Redis cannot be connected
  });
