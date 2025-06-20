// src/components/LobbyScreen.js
import React from 'react';

const LobbyScreen = ({ 
  user, 
  playersList, 
  onInvitePlayer, 
  invite, 
  onRespondInvite, 
  onLogout,
  unfinishedGames,
  onResumeGame,
  message,
  socketId // Pass socketId from App.js to filter out current user from playersList
}) => {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-900 text-white p-4">
      <div className="bg-gray-800 p-8 rounded-lg shadow-xl text-center w-full max-w-md">
        <div className="header"> {/* Using existing header style */}
          {/* Debugging parse error: Adding a comment here */}
          <h2>Test</h2>
          {onLogout && (
            <button onClick={onLogout} className="bomb-button">Logout</button>
          )}
        </div>

        {message && <p className="app-message">{message}</p>}

        {user && (
          <h3 className="text-xl mb-4">Welcome, {user.displayName} (ID: {user.id})!</h3>
        )}

        {/* Unfinished Games Section */}
        <div className="mb-8">
            <h3 className="text-2xl font-bold mb-4 text-purple-400">Your Unfinished Games</h3>
            {unfinishedGames.length === 0 ? (
                <p className="text-gray-400">No unfinished games found.</p>
            ) : (
                <ul className="player-list"> {/* Reusing player-list style for consistency */}
                    {unfinishedGames.map((game) => (
                        <li
                            key={game.gameId}
                            className="player-item text-left flex justify-between items-center"
                            onClick={() => onResumeGame(game.gameId)}
                            title={`Resume game against ${game.opponentName} (Last updated: ${game.lastUpdated})`}
                        >
                            <span>
                                Vs. {game.opponentName} (Player {game.myPlayerNumber})
                                <br />
                                <span className="text-sm text-gray-400">Status: {game.status === 'active' ? 'Live' : 'Waiting'} | Last updated: {game.lastUpdated}</span>
                            </span>
                            <button className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-1 px-3 rounded-md transition duration-300 transform hover:scale-105">Resume</button>
                        </li>
                    ))}
                </ul>
            )}
        </div>

        {/* Available Players Section */}
        <h3 className="text-2xl font-bold mb-4 text-yellow-400">Available Players</h3>
        {playersList.length === 0 ? (
          <p className="text-gray-400">No other players online.</p>
        ) : (
          <ul className="player-list">
            {playersList
              .filter(p => p.id !== socketId) // Filter out yourself
              .map((p) => (
                <li
                  key={p.id}
                  className="player-item text-left"
                  onDoubleClick={() => onInvitePlayer(p.id)}
                  title="Double-click to invite to a game"
                >
                  {p.name}
                </li>
              ))}
          </ul>
        )}

        {/* Render invite popup if an invite is active */}
        {invite && (
          <div className="invite-popup">
            <p className="text-lg">
              Invitation from <b className="text-indigo-300">{invite.fromName}</b>
            </p>
            <button 
              onClick={() => onRespondInvite(true)}
              className="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-lg transition duration-300 transform hover:scale-105"
            >
              Accept
            </button>
            <button 
              onClick={() => onRespondInvite(false)}
              className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg ml-2 transition duration-300 transform hover:scale-105"
            >
              Reject
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default LobbyScreen;
