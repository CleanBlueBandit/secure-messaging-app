// API module for communicating with the backend

const API = (function() {
  const BASE_URL = window.location.origin;
  let authToken = null;

  // Set auth token
  function setToken(token) {
    authToken = token;
    if (token) {
      localStorage.setItem('auth_token', token);
    } else {
      localStorage.removeItem('auth_token');
    }
  }

  // Get stored token
  function getToken() {
    if (!authToken) {
      authToken = localStorage.getItem('auth_token');
    }
    return authToken;
  }

  // Make authenticated request
  async function request(endpoint, options = {}) {
    const url = `${BASE_URL}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };

    const token = getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      ...options,
      headers
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Request failed');
    }

    return data;
  }

  // Auth endpoints
  async function register(username, password, publicKey) {
    const data = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, publicKey })
    });
    setToken(data.token);
    return data;
  }

  async function login(username, password) {
    const data = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    setToken(data.token);
    return data;
  }

  async function getMe() {
    return await request('/api/auth/me');
  }

  function logout() {
    setToken(null);
  }

  function isLoggedIn() {
    return !!getToken();
  }

  // User endpoints
  async function searchUsers(query) {
    return await request(`/api/users?search=${encodeURIComponent(query)}`);
  }

  async function getUser(userId) {
    return await request(`/api/users/${userId}`);
  }

  // Conversation endpoints
  async function getConversations() {
    return await request('/api/conversations');
  }

  async function createConversation(participantId) {
    return await request('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ participantId })
    });
  }

  // Message endpoints
  async function getMessages(conversationId, options = {}) {
    let url = `/api/conversations/${conversationId}/messages`;
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', options.limit);
    if (options.before) params.set('before', options.before);
    if (params.toString()) url += `?${params.toString()}`;
    
    return await request(url);
  }

  async function sendMessage(conversationId, encryptedContent, encryptedKey, iv) {
    return await request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ encryptedContent, encryptedKey, iv })
    });
  }

  // Public API
  return {
    setToken,
    getToken,
    register,
    login,
    logout,
    isLoggedIn,
    getMe,
    searchUsers,
    getUser,
    getConversations,
    createConversation,
    getMessages,
    sendMessage
  };
})();

// Make available globally
window.API = API;
