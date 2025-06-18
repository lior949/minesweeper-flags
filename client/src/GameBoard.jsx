import React from 'react';

function Tile({ tile, onReveal }) {
  const content = tile.revealed
    ? tile.hasMine
      ? '💣'
      : tile.adjacent || ''
    : '';
  const className = 'tile' + (tile.revealed ? ' revealed' : '');
  return (
    <div
      className={className}
      onClick={() => onReveal(tile.x, tile.y)}
    >
      {content}
    </div>
  );
}

export default function GameBoard({ board, onReveal }) {
  return (
    <div className="board">
      {board.flat().map(tile => (
        <Tile key={tile.x + '-' + tile.y} tile={tile} onReveal={onReveal} />
      ))}
    </div>
  );
}