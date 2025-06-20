// AuthCallback.jsx
import React, { useEffect } from 'react';

function AuthCallback() {
  useEffect(() => {
    console.log("AuthCallback component mounted.");

    const handleMessage = (event) => {
      // Ensure the message is from your expected origin for security
      // In production, replace '*' with your frontend's exact origin:
      // 'https://minesweeper-flags-frontend.onrender.com'
      if (event.origin !== 'https://minesweeper-flags-frontend.onrender.com' && event.origin !== 'http://localhost:3000') { // Added localhost for dev
        console.warn('AuthCallback: Message received from unexpected origin:', event.origin);
        return;
      }

      const { type, user, message } = event.data;

      if (window.opener) {
        if (type === 'AUTH_SUCCESS') {
          console.log("AuthCallback: Received AUTH_SUCCESS message from opener.", user);
          // Forward the success message to the main application's listener
          window.opener.postMessage({ type: 'AUTH_SUCCESS', user: user }, 'https://minesweeper-flags-frontend.onrender.com'); // Specify target origin
        } else if (type === 'AUTH_FAILURE') {
          console.error("AuthCallback: Received AUTH_FAILURE message from opener.", message);
          // Forward the failure message
          window.opener.postMessage({ type: 'AUTH_FAILURE', message: message }, 'https://minesweeper-flags-frontend.onrender.com'); // Specify target origin
        }
      } else {
        console.warn("AuthCallback: No window.opener found. Cannot send message back.");
        // This might happen if the callback page is opened directly.
        // You might want to redirect to the main app's root in this case.
        // window.location.href = 'https://minesweeper-flags-frontend.onrender.com';
      }

      // Close the pop-up window after handling the message
      console.log("AuthCallback: Attempting to close window after message.");
      window.close();
    };

    // Add event listener for messages from the opener
    window.addEventListener('message', handleMessage);

    // Clean up the event listener when the component unmounts
    return () => {
      console.log("AuthCallback component unmounted.");
      window.removeEventListener('message', handleMessage);
    };
  }, []); // Run once on mount

  // Display a message while the pop-up is closing
  return (
    <div style={{ textAlign: 'center', padding: '20px', fontFamily: 'Inter, sans-serif' }}>
      <h1>Authentication in progress...</h1>
      <p>Please wait while we redirect you back to the application.</p>
      <p>This window should close automatically.</p>
    </div>
  );
}

export default AuthCallback;
