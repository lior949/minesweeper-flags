// src/components/AuthCallback.js
import React, { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

function AuthCallback({ type }) {
  const location = useLocation();

  useEffect(() => {
    // Check if this window was opened by another window
    if (window.opener) {
      const urlParams = new URLSearchParams(location.search);

      // Construct the payload based on success or failure type
      if (type === 'success') {
        const userId = urlParams.get('userId');
        const displayName = urlParams.get('displayName');
        
        const userData = {
          id: userId,
          displayName: displayName ? decodeURIComponent(displayName) : 'Unknown User'
        };

        // Send a message to the opener window (your main app)
        // IMPORTANT: Specify the exact origin of your main frontend application for security
        window.opener.postMessage(
          { type: 'authSuccess', payload: { user: userData } },
          'https://minesweeper-flags-frontend.onrender.com'
        );
      } else if (type === 'failure') {
        const errorMessage = urlParams.get('message') || 'Unknown authentication error.';
        // Send failure message to the opener window
        window.opener.postMessage(
          { type: 'authFailure', payload: { message: decodeURIComponent(errorMessage) } },
          'https://minesweeper-flags-frontend.onrender.com'
        );
      }
    } else {
      console.warn('AuthCallback opened directly, not in a pop-up. Cannot communicate to opener.');
    }

    // After communicating (or attempting to), close the pop-up window
    window.close();
  }, [location, type]); // Dependencies: re-run if location or type changes

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
      <p>Processing authentication...</p>
      <p>You can close this window now.</p>
    </div>
  );
}

export default AuthCallback;
