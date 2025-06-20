// src/components/LoginFailedScreen.js
import React from 'react';
import { useLocation, Link } from 'react-router-dom';

const LoginFailedScreen = () => {
  const location = useLocation();
  const message = location.state?.message || "Something went wrong during login.";

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-900 text-white p-4">
      <div className="bg-gray-800 p-8 rounded-lg shadow-xl text-center w-full max-w-sm">
        <h1 className="text-3xl font-bold mb-4 text-red-500">Login Failed!</h1>
        <p className="text-gray-300 mb-6">{message}</p>
        <Link to="/login" className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg focus:outline-none focus:shadow-outline transition duration-300 transform hover:scale-105">
          Try Logging In Again
        </Link>
      </div>
    </div>
  );
};

export default LoginFailedScreen;
