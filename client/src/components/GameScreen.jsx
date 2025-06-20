// src/components/GameScreen.jsx
import React from 'react';

const GameScreen = ({
  gameId,
  playerNumber,
  board,
  turn,
  scores,
  bombsUsed,
  bombMode,
  gameOver,
  opponentName,
  onTileClick,
  onUseBomb,
  onBackToLobby,
  onRestartGame,
  message,
  lastClickedTile // Highlight last clicked tile
}) => {

  // Helper function to render content inside a tile.
  const renderTile = (tile, x, y) => {
    // If the tile is the last clicked by player 1, highlight it
    const isLastClickedP1 = lastClickedTile[1] && lastClickedTile[1].x === x && lastClickedTile[1].y === y;
    // If the tile is the last clicked by player 2, highlight it
    const isLastClickedP2 = lastClickedTile[2] && lastClickedTile[2].x === x && lastClickedTile[2].y === y;

    // Show special highlight if it's the last clicked tile by either player
    if (isLastClickedP1 && playerNumber === 1) {
        return <span style={{ fontSize: '24px', animation: 'blink-red 1s infinite' }}>&#9679;</span>; // Red dot
    }
    if (isLastClickedP2 && playerNumber === 2) {
        return <span style={{ fontSize: '24px', animation: 'blink-blue 1s infinite' }}>&#9679;</span>; // Blue dot
    }
    
    if (!tile.revealed) return '';
    if (tile.isMine) {
      if (tile.owner === 1) return <span style={{ color: 'red', fontSize: '24px' }}>🚩</span>;
      if (tile.owner === 2) return <span style={{ color: 'blue', fontSize: '24px' }}>🏴</span>;
      return ''; // Fallback for mines without owner (shouldn't occur)
    }
    // For non-mine revealed tiles, show adjacent mine count
    return tile.adjacentMines > 0 ? tile.adjacentMines : '';
  };

  // Render 5x5 bomb target area when in bomb mode
  const renderBombTarget = (x, y) => {
    if (!bombMode || !board.length || !board[0].length) return ''; // Only show in bomb mode with a board

    const MIN_BOMB_X = 2; // For 3rd column (0-indexed)
    const MAX_BOMB_X = board[0].length - 3; // 16 - 3 = 13 (14th col)
    const MIN_BOMB_Y = 2; // y=2 is 3rd row
    const MAX_BOMB_Y = board.length - 3; // 16 - 3 = 13 (14th row)

    // Check if the current tile (x, y) is within the valid 12x12 bomb target area
    if (x >= MIN_BOMB_X && x < MAX_BOMB_X && y >= MIN_BOMB_Y && y < MAX_BOMB_Y) {
      return 'bomb-target-area'; // CSS class to highlight
    }
    return '';
  };

  if (!board || board.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        <p>Loading game...</p>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="header">
        <h1>Minesweeper Flags</h1>
        {playerNumber &&
          !bombsUsed[playerNumber] && // Bomb not used by current player
          scores[playerNumber] < scores[playerNumber === 1 ? 2 : 1] && // Current player is behind in score
          !gameOver && // Game is not over
          playerNumber === turn && // Only allow using bomb on your turn
          (
            <button className="bomb-button" onClick={onUseBomb}>
				{bombMode ? "Cancel Bomb" : "Use Bomb"}
			</button>
          )}
      </div>

      <h2>
        You are Player {playerNumber} (vs. {opponentName})
      </h2>
      <p>
        {turn && !gameOver ? `Current turn: Player ${turn}` : ""}
        {bombMode && " – Select 5x5 bomb center"}
      </p>
      {message && <p className="app-message" style={{ color: message.includes("Error") || message.includes("behind") || message.includes("used") || message.includes("already revealed") || message.includes("out of bounds") ? 'red' : 'green' }}>{message}</p>}
      <p>
        Score <span style={{color: 'red'}}>🔴 {scores[1]}</span> | <span style={{color: 'blue'}}>🔵 {scores[2]}</span>
      </p>

      {gameOver && (
        <div className="game-over-controls">
            <button className="bomb-button" onClick={onBackToLobby}>
              Back to Lobby
            </button>
            <button className="bomb-button" onClick={onRestartGame} style={{ marginLeft: '10px' }}>
              Restart Game
            </button>
        </div>
      )}

      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${board[0]?.length || 0}, 40px)`,
        }}
      >
        {board.flatMap((row, y) =>
          row.map((tile, x) => (
            <div
              key={`${gameId}-${x}-${y}`} // Unique key for each tile
              className={`tile ${tile.revealed ? "revealed" : "hidden"} ${tile.isMine && tile.revealed ? "mine" : ""} ${renderBombTarget(x,y)}`}
              onClick={() => onTileClick(x, y)}
              data-adjacent-mines={tile.adjacentMines} // For CSS styling based on adjacent mines
            >
              {renderTile(tile, x, y)}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default GameScreen;
