// src/components/LoginScreen.js
import React from 'react';

const LoginScreen = ({ onGoogleLogin, onFacebookLogin, message }) => {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white p-4">
      <div className="bg-gray-800 p-8 rounded-lg shadow-xl text-center w-full max-w-sm">
        <h1 className="text-3xl font-bold mb-6 text-indigo-400">Minesweeper Flags</h1>
        <p className="text-gray-300 mb-8">Login to play with friends!</p>
        
        {message && <p className="app-message" style={{color: 'red', marginBottom: '1rem'}}>{message}</p>}

        <button
          onClick={onGoogleLogin}
          className="w-full flex items-center justify-center bg-red-600 hover:bg-red-700 text-white font-bold py-3 px-4 rounded-lg focus:outline-none focus:shadow-outline mb-4 transition duration-300 transform hover:scale-105"
        >
          <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Google_%22G%22_logo.svg/1024px-Google_%22G%22_logo.svg.png" alt="Google Logo" className="w-6 h-6 mr-3" />
          Login with Google
        </button>
        <button
          onClick={onFacebookLogin}
          className="w-full flex items-center justify-center bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-4 rounded-lg focus:outline-none focus:shadow-outline transition duration-300 transform hover:scale-105"
        >
          <svg className="w-6 h-6 mr-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14 12h-1v5h1v-5zm3-2h-1.5a2.5 2.5 0 00-2.5 2.5V17h4V12.5a2.5 2.5 0 00-2.5-2.5zM12 2C6.477 2 2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.873V14.89h-2.54V12h2.54V9.77c0-2.535 1.554-3.926 3.792-3.926 1.095 0 2.19.195 2.19.195V8.5h-1.397c-1.259 0-1.638.775-1.638 1.56V12h2.773l-.443 2.89h-2.33V22h5.532c4.781-.745 8.438-4.882 8.438-9.873C22 6.477 17.523 2 12 2z" />
          </svg>
          Login with Facebook
        </button>
      </div>
    </div>
  );
};

export default LoginScreen;
