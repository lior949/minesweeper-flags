// AuthCallback.jsx
import React, { useEffect } from 'react';

function AuthCallback() {
  useEffect(() => {
    console.log("AuthCallback component mounted.");

    const hash = window.location.hash.substring(1);
    let userData = null;
    try {
      userData = JSON.parse(decodeURIComponent(hash));
      console.log("AuthCallback: Parsed user data from hash:", userData);
    } catch (error) {
      console.error("AuthCallback: Error parsing user data from hash:", error);
    }

    if (userData) {
      if (window.opener) {
        
        window.opener.postMessage({ type: 'AUTH_SUCCESS', user: userData }, '*');
        console.log("AuthCallback: Sent AUTH_SUCCESS message to opener.");
        window.close();
      } else {
        console.warn("AuthCallback: No window.opener found. Using localStorage fallback.");
        
        
        localStorage.setItem('auth_success_user', JSON.stringify({
          user: userData,
          timestamp: Date.now()
        }));

        
        setTimeout(() => {
          window.location.href = '/'; 
        }, 500);
      }
    } else {
      if (window.opener) {
        window.opener.postMessage({ type: 'AUTH_FAILURE', message: 'Failed to retrieve user data.' }, '*');
        window.close();
      } else {
        localStorage.setItem('auth_failure', JSON.stringify({ message: 'Failed to retrieve user data.', timestamp: Date.now() }));
        setTimeout(() => { window.location.href = '/'; }, 500);
      }
    }
  }, []);

  return (
    <div style={{ textAlign: 'center', padding: '20px', fontFamily: 'sans-serif' }}>
      <h1>Authentication in progress...</h1>
      <p>Please wait while we redirect you back to the application.</p>
    </div>
  );
}

export default AuthCallback;
