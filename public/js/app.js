// Main application logic

const App = (function() {
  // State
  let currentUser = null;
  let privateKey = null;
  let conversations = [];
  let currentConversation = null;
  let currentChatUser = null;
  let eventSource = null;
  let searchTimeout = null;

  // DOM Elements
  const elements = {
    authView: document.getElementById('auth-view'),
    chatView: document.getElementById('chat-view'),
    loginForm: document.getElementById('login-form'),
    registerForm: document.getElementById('register-form'),
    loginError: document.getElementById('login-error'),
    registerError: document.getElementById('register-error'),
    tabBtns: document.querySelectorAll('.tab-btn'),
    currentUsername: document.getElementById('current-username'),
    currentUserAvatar: document.getElementById('current-user-avatar'),
    logoutBtn: document.getElementById('logout-btn'),
    userSearch: document.getElementById('user-search'),
    searchResults: document.getElementById('search-results'),
    conversationsList: document.getElementById('conversations-list'),
    noChatSelected: document.getElementById('no-chat-selected'),
    chatContainer: document.getElementById('chat-container'),
    chatUsername: document.getElementById('chat-username'),
    chatUserAvatar: document.getElementById('chat-user-avatar'),
    messagesList: document.getElementById('messages-list'),
    messageForm: document.getElementById('message-form'),
    messageInput: document.getElementById('message-input'),
    backBtn: document.getElementById('back-btn'),
    sidebar: document.querySelector('.sidebar'),
    toastContainer: document.getElementById('toast-container')
  };

  // Initialize app
  async function init() {
    setupEventListeners();
    
    if (API.isLoggedIn()) {
      try {
        const { user } = await API.getMe();
        await loadUserSession(user);
      } catch (e) {
        API.logout();
        showAuthView();
      }
    } else {
      showAuthView();
    }
  }

  // Setup event listeners
  function setupEventListeners() {
    // Auth tabs
    elements.tabBtns.forEach(btn => {
      btn.addEventListener('click', () => switchAuthTab(btn.dataset.tab));
    });

    // Login form
    elements.loginForm.addEventListener('submit', handleLogin);

    // Register form
    elements.registerForm.addEventListener('submit', handleRegister);

    // Logout
    elements.logoutBtn.addEventListener('click', handleLogout);

    // User search
    elements.userSearch.addEventListener('input', handleUserSearch);
    elements.userSearch.addEventListener('focus', () => {
      if (elements.userSearch.value.trim()) {
        elements.searchResults.classList.remove('hidden');
      }
    });

    // Close search results on click outside
    document.addEventListener('click', (e) => {
      if (!elements.userSearch.contains(e.target) && !elements.searchResults.contains(e.target)) {
        elements.searchResults.classList.add('hidden');
      }
    });

    // Message form
    elements.messageForm.addEventListener('submit', handleSendMessage);

    // Back button (mobile)
    elements.backBtn.addEventListener('click', () => {
      elements.sidebar.classList.remove('hidden-mobile');
      currentConversation = null;
      currentChatUser = null;
      showNoChatSelected();
    });
  }

  // Switch auth tab
  function switchAuthTab(tab) {
    elements.tabBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    elements.loginForm.classList.toggle('hidden', tab !== 'login');
    elements.registerForm.classList.toggle('hidden', tab !== 'register');
    elements.loginError.textContent = '';
    elements.registerError.textContent = '';
  }

  // Handle login
  async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    
    elements.loginError.textContent = '';

    try {
      const { user } = await API.login(username, password);
      
      // Load private key from IndexedDB
      const storedKey = await CryptoModule.getStoredPrivateKey(user.id);
      if (!storedKey) {
        elements.loginError.textContent = 'Encryption keys not found. Please register again on this device.';
        API.logout();
        return;
      }
      
      privateKey = await CryptoModule.importPrivateKey(storedKey);
      currentUser = user;
      showChatView();
    } catch (e) {
      elements.loginError.textContent = e.message;
    }
  }

  // Handle register
  async function handleRegister(e) {
    e.preventDefault();
    const username = document.getElementById('register-username').value.trim();
    const password = document.getElementById('register-password').value;
    const confirm = document.getElementById('register-confirm').value;

    elements.registerError.textContent = '';

    if (password !== confirm) {
      elements.registerError.textContent = 'Passwords do not match';
      return;
    }

    try {
      // Generate key pair
      const keyPair = await CryptoModule.generateKeyPair();
      const publicKeyBase64 = await CryptoModule.exportPublicKey(keyPair.publicKey);
      
      // Register user
      const { user } = await API.register(username, password, publicKeyBase64);
      
      // Store private key
      const privateKeyJWK = await CryptoModule.exportPrivateKey(keyPair.privateKey);
      await CryptoModule.storeKeyPair(user.id, privateKeyJWK);
      
      privateKey = keyPair.privateKey;
      currentUser = user;
      showChatView();
      showToast('Account created successfully!', 'success');
    } catch (e) {
      elements.registerError.textContent = e.message;
    }
  }

  // Handle logout
  function handleLogout() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    API.logout();
    currentUser = null;
    privateKey = null;
    conversations = [];
    currentConversation = null;
    currentChatUser = null;
    showAuthView();
  }

  // Load user session
  async function loadUserSession(user) {
    currentUser = user;
    
    // Load private key
    const storedKey = await CryptoModule.getStoredPrivateKey(user.id);
    if (!storedKey) {
      showToast('Encryption keys not found. Please login again.', 'error');
      API.logout();
      showAuthView();
      return;
    }
    
    privateKey = await CryptoModule.importPrivateKey(storedKey);
    showChatView();
  }

  // Show auth view
  function showAuthView() {
    elements.authView.classList.remove('hidden');
    elements.chatView.classList.add('hidden');
    elements.loginForm.reset();
    elements.registerForm.reset();
    elements.loginError.textContent = '';
    elements.registerError.textContent = '';
  }

  // Show chat view
  async function showChatView() {
    elements.authView.classList.add('hidden');
    elements.chatView.classList.remove('hidden');
    
    // Set user info
    elements.currentUsername.textContent = currentUser.username;
    elements.currentUserAvatar.textContent = currentUser.username.charAt(0);
    
    // Load conversations
    await loadConversations();
    
    // Connect to SSE
    connectSSE();
  }

  // Load conversations
  async function loadConversations() {
    try {
      const { conversations: convs } = await API.getConversations();
      conversations = convs;
      renderConversations();
    } catch (e) {
      showToast('Failed to load conversations', 'error');
    }
  }

  // Render conversations list
  function renderConversations() {
    if (conversations.length === 0) {
      elements.conversationsList.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <p>No conversations yet</p>
          <span>Search for users to start chatting</span>
        </div>
      `;
      return;
    }

    elements.conversationsList.innerHTML = conversations.map(conv => {
      const otherUser = conv.participants.find(p => p.id !== currentUser.id);
      const isActive = currentConversation && currentConversation.id === conv.id;
      
      return `
        <div class="conversation-item ${isActive ? 'active' : ''}" data-id="${conv.id}" data-user-id="${otherUser?.id}">
          <div class="avatar">${otherUser?.username?.charAt(0) || '?'}</div>
          <div class="conversation-info">
            <div class="conversation-name">${escapeHtml(otherUser?.username || 'Unknown')}</div>
            <div class="conversation-preview">${conv.lastMessage ? 'Encrypted message' : 'No messages yet'}</div>
          </div>
          ${conv.lastMessage ? `<span class="conversation-time">${formatTime(conv.lastMessage.created_at)}</span>` : ''}
        </div>
      `;
    }).join('');

    // Add click listeners
    elements.conversationsList.querySelectorAll('.conversation-item').forEach(item => {
      item.addEventListener('click', () => {
        const convId = item.dataset.id;
        const userId = item.dataset.userId;
        openConversation(convId, userId);
      });
    });
  }

  // Handle user search
  function handleUserSearch(e) {
    const query = e.target.value.trim();
    
    clearTimeout(searchTimeout);
    
    if (!query) {
      elements.searchResults.classList.add('hidden');
      return;
    }

    searchTimeout = setTimeout(async () => {
      try {
        const { users } = await API.searchUsers(query);
        renderSearchResults(users);
      } catch (e) {
        console.error('Search error:', e);
      }
    }, 300);
  }

  // Render search results
  function renderSearchResults(users) {
    if (users.length === 0) {
      elements.searchResults.innerHTML = '<div class="search-no-results">No users found</div>';
    } else {
      elements.searchResults.innerHTML = users.map(user => `
        <div class="search-result-item" data-user-id="${user.id}" data-public-key="${user.public_key}">
          <div class="avatar">${user.username.charAt(0)}</div>
          <span>${escapeHtml(user.username)}</span>
        </div>
      `).join('');

      // Add click listeners
      elements.searchResults.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => {
          startConversation(item.dataset.userId);
          elements.searchResults.classList.add('hidden');
          elements.userSearch.value = '';
        });
      });
    }
    
    elements.searchResults.classList.remove('hidden');
  }

  // Start conversation with user
  async function startConversation(userId) {
    try {
      const { conversation } = await API.createConversation(userId);
      
      if (!conversation.existing) {
        await loadConversations();
      }
      
      openConversation(conversation.id, userId);
    } catch (e) {
      showToast('Failed to start conversation', 'error');
    }
  }

  // Open conversation
  async function openConversation(conversationId, userId) {
    try {
      // Get user info
      const { user } = await API.getUser(userId);
      currentChatUser = user;
      currentConversation = conversations.find(c => c.id === conversationId) || { id: conversationId };
      
      // Update UI
      elements.chatUsername.textContent = user.username;
      elements.chatUserAvatar.textContent = user.username.charAt(0);
      
      // Show chat container
      showNoChatSelected(false);
      elements.chatContainer.classList.remove('hidden');
      
      // Hide sidebar on mobile
      elements.sidebar.classList.add('hidden-mobile');
      
      // Mark conversation as active
      elements.conversationsList.querySelectorAll('.conversation-item').forEach(item => {
        item.classList.toggle('active', item.dataset.id === conversationId);
      });
      
      // Load messages
      await loadMessages(conversationId);
      
      // Focus input
      elements.messageInput.focus();
    } catch (e) {
      showToast('Failed to open conversation', 'error');
    }
  }

  // Load messages
  async function loadMessages(conversationId) {
    try {
      const { messages } = await API.getMessages(conversationId);
      await renderMessages(messages);
    } catch (e) {
      showToast('Failed to load messages', 'error');
    }
  }

  // Render messages
  async function renderMessages(messages) {
    if (messages.length === 0) {
      elements.messagesList.innerHTML = `
        <div class="message-encrypted">
          Messages are end-to-end encrypted. Only you and the recipient can read them.
        </div>
      `;
      return;
    }

    const messageElements = await Promise.all(messages.map(async (msg) => {
      const isSent = msg.sender_id === currentUser.id;
      let content = 'Unable to decrypt';
      
      try {
        content = await CryptoModule.decryptWithPrivateKey(
          msg.encrypted_content,
          msg.encrypted_key,
          msg.iv,
          privateKey
        );
      } catch (e) {
        console.error('Decrypt error:', e);
      }
      
      return `
        <div class="message ${isSent ? 'sent' : 'received'}">
          <div class="message-content">${escapeHtml(content)}</div>
          <div class="message-time">${formatTime(msg.created_at)}</div>
        </div>
      `;
    }));

    elements.messagesList.innerHTML = messageElements.join('');
    scrollToBottom();
  }

  // Handle send message
  async function handleSendMessage(e) {
    e.preventDefault();
    
    const message = elements.messageInput.value.trim();
    if (!message || !currentConversation || !currentChatUser) return;

    elements.messageInput.value = '';

    try {
      // Encrypt for recipient
      const recipientEncrypted = await CryptoModule.encryptForRecipient(
        message,
        currentChatUser.public_key
      );

      // Also encrypt for self (so we can read our own messages)
      const selfEncrypted = await CryptoModule.encryptForRecipient(
        message,
        currentUser.public_key
      );

      // Send to server (we send the self-encrypted version so we can decrypt it later)
      await API.sendMessage(
        currentConversation.id,
        selfEncrypted.encryptedContent,
        selfEncrypted.encryptedKey,
        selfEncrypted.iv
      );

      // Add message to UI immediately
      const messageHtml = `
        <div class="message sent">
          <div class="message-content">${escapeHtml(message)}</div>
          <div class="message-time">${formatTime(new Date().toISOString())}</div>
        </div>
      `;
      
      // Remove empty state if present
      const emptyState = elements.messagesList.querySelector('.message-encrypted');
      if (emptyState && emptyState.textContent.includes('end-to-end encrypted')) {
        emptyState.remove();
      }
      
      elements.messagesList.insertAdjacentHTML('beforeend', messageHtml);
      scrollToBottom();
    } catch (e) {
      showToast('Failed to send message', 'error');
      elements.messageInput.value = message;
    }
  }

  // Connect to SSE for real-time updates
  function connectSSE() {
    if (eventSource) {
      eventSource.close();
    }

    const token = API.getToken();
    eventSource = new EventSource(`/api/events?token=${token}`);

    eventSource.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'new_message') {
          handleNewMessage(data.message);
        }
      } catch (e) {
        console.error('SSE error:', e);
      }
    };

    eventSource.onerror = () => {
      // Reconnect after a delay
      setTimeout(() => {
        if (API.isLoggedIn()) {
          connectSSE();
        }
      }, 5000);
    };
  }

  // Handle new message from SSE
  async function handleNewMessage(message) {
    // Update conversation list
    await loadConversations();

    // If currently viewing this conversation, add the message
    if (currentConversation && currentConversation.id === message.conversation_id) {
      try {
        const content = await CryptoModule.decryptWithPrivateKey(
          message.encrypted_content,
          message.encrypted_key,
          message.iv,
          privateKey
        );

        const messageHtml = `
          <div class="message received">
            <div class="message-content">${escapeHtml(content)}</div>
            <div class="message-time">${formatTime(message.created_at)}</div>
          </div>
        `;
        
        elements.messagesList.insertAdjacentHTML('beforeend', messageHtml);
        scrollToBottom();
      } catch (e) {
        console.error('Decrypt error:', e);
      }
    }
  }

  // Show/hide no chat selected
  function showNoChatSelected(show = true) {
    elements.noChatSelected.classList.toggle('hidden', !show);
    elements.chatContainer.classList.toggle('hidden', show);
  }

  // Scroll messages to bottom
  function scrollToBottom() {
    const container = document.getElementById('messages-container');
    container.scrollTop = container.scrollHeight;
  }

  // Show toast notification
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    elements.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 3000);
  }

  // Format time
  function formatTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) return 'now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // Escape HTML
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Initialize on DOM ready
  document.addEventListener('DOMContentLoaded', init);

  // Public API
  return {
    init
  };
})();
