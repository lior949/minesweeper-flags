// AuthCallback.jsx
import React, { useEffect } from 'react';

function AuthCallback() {
  useEffect(() => {
    console.log("AuthCallback component mounted.");

    // Parse user data from the URL hash
    // The server redirects to /auth/callback#{"id":"...", "displayName":"..."}
    const hash = window.location.hash.substring(1); // Remove the '#'
    let userData = null;
    try {
      // Decode and parse the JSON string from the hash
      userData = JSON.parse(decodeURIComponent(hash));
      console.log("AuthCallback: Parsed user data from hash:", userData);
    } catch (error) {
      console.error("AuthCallback: Error parsing user data from hash:", error);
      // Fallback or error message if data is malformed
    }

    // Send the user data to the opening window (main application)
    if (window.opener && userData) {
      // Use window.opener.postMessage to safely send data back to the main window.
      // The targetOrigin '*' is used for simplicity in development, but in production,
      // you should specify your frontend's exact origin (e.g., 'https://minesweeper-flags-frontend.onrender.com')
      window.opener.postMessage({ type: 'AUTH_SUCCESS', user: userData }, '*');
      console.log("AuthCallback: Sent AUTH_SUCCESS message to opener.");
    } else if (window.opener) {
        // If userData is null/error, send an auth_failure message
        window.opener.postMessage({ type: 'AUTH_FAILURE', message: 'Failed to retrieve user data from pop-up.' }, '*');
        console.log("AuthCallback: Sent AUTH_FAILURE message to opener (no user data).");
    } else {
        console.warn("AuthCallback: No window.opener found. Cannot send message back.");
        // This might happen if the callback page is opened directly, not as a popup.
        // In this case, you might want to redirect to the main app's root.
        // window.location.href = 'https://minesweeper-flags-frontend.onrender.com';
    }

    // Close the pop-up window
    // This should always be the last step.
    console.log("AuthCallback: Attempting to close window.");
    window.close(); // This should now work correctly as it's initiated by same-origin script.
    
    // Fallback to prevent content from remaining visible if window.close() fails
    return () => {
        console.log("AuthCallback component unmounted.");
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
