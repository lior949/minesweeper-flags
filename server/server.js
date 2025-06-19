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

// --- CORRECTED: Firestore Session Store Imports ---
const { FirestoreStore } = require('@google-cloud/connect-firestore');


const app = express();
const server = http.createServer(app);

// Configure CORS for Express HTTP routes
app.use(
  cors({
    origin: "https://minesweeper-flags-frontend.onrender.com", // your frontend
    credentials: true, // allow cookies for HTTP requests
  })
);

app.set('trust proxy', 1); // Crucial when deployed behind a load balancer (like Render)

// === Initialize Firebase Admin SDK first, so `db` is available ===
let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = getFirestore(); // Initialize db only after app is initialized
  console.log("Firebase Admin SDK initialized.");
} catch (error) {
  console.error("Failed to initialize Firebase Admin SDK. Ensure FIREBASE_SERVICE_ACCOUNT_KEY env var is set and valid JSON.", error);
  process.exit(1); // Exit process if Firebase fails to initialize
}

// === Define the session middleware instance with FirestoreStore ===
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET, // Make sure SESSION_SECRET is set in Render env vars
  resave: false,
  saveUninitialized: false,
  store: new FirestoreStore({ // Use FirestoreStore for persistent sessions
    dataset: db, // 'dataset' is the correct parameter name for Firestore instance in @google-cloud/connect-firestore
    kind: 'express-sessions', // Optional: specify your session collection name (e.g., 'sessions' or 'express-sessions')
  }),
  cookie: {
    sameSite: "none",
    secure: true,	
    domain: '.onrender.com', // Explicitly set domain for cross-subdomain cookies
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days (example)
  },
});

// === Apply session middleware to Express ===
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());


// Configure Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: "https://minesweeper-flags-frontend.onrender.com",
    methods: ["GET", "POST"],
    credentials: true, // Allow cookies for Socket.IO handshake
  },
});

// === IMPORTANT: Integrate session and passport middleware with Socket.IO ===
io.use((socket, next) => {
    // Wrap the standard Express session and passport middleware for Socket.IO
    sessionMiddleware(socket.request, socket.request.res || {}, () => { // Pass a dummy res object if not present
        passport.initialize()(socket.request, socket.request.res || {}, () => {
            passport.session()(socket.request, socket.request.res || {}, next);
        });
    });
});
// === END Socket.IO Session Integration ===


const FACEBOOK_CLIENT_ID = process.env.FACEBOOK_CLIENT_ID;
const FACEBOOK_CLIENT_SECRET = process.env.FACEBOOK_CLIENT_SECRET;

// === Passport config ===
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/google/callback"
}, (accessToken, refreshToken, profile, done) => {
  return done(null, profile);
}));

passport.use(new FacebookStrategy({
    clientID: FACEBOOK_CLIENT_ID,
    clientSecret: FACEBOOK_CLIENT_SECRET,
    callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/facebook/callback",
    profileFields: ['id', 'displayName', 'photos', 'email']
  },
  function(accessToken, refreshToken, profile, cb) {
    return cb(null, profile);
  }
));

passport.serializeUser((user, done) => {
  done(null, { id: user.id, displayName: user.displayName || user.name });
});
passport.deserializeUser((obj, done) => {
  done(null, obj);
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
          domain: '.onrender.com',
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

// Helper functions (generateBoard, revealRecursive, revealArea, checkGameOver) remain the same
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
          revealRecursive(board, x + dx, y + d
