import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Environment variables
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'secure-messaging-jwt-secret-key-2024';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Validate required env vars
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing required environment variables: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  console.error('Please ensure these are set in your environment.');
  process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Store SSE connections by user ID
const sseConnections = new Map();

// MIME types for static files
const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Helper to parse JSON body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Helper to send JSON response
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

// Verify JWT token (from header or query param for SSE)
function verifyToken(req) {
  // Try header first
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      return jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return null;
    }
  }
  
  // Try query param (for SSE)
  const url = new URL(req.url, `http://${req.headers.host}`);
  const queryToken = url.searchParams.get('token');
  if (queryToken) {
    try {
      return jwt.verify(queryToken, JWT_SECRET);
    } catch (e) {
      return null;
    }
  }
  
  return null;
}

// Serve static files from public directory
function serveStatic(req, res) {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // SPA fallback - serve index.html for routes
        fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, content) => {
          if (err) {
            res.writeHead(500);
            res.end('Server Error');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
          }
        });
      } else {
        res.writeHead(500);
        res.end('Server Error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
}

// API Routes
async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  // Auth routes
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    return handleRegister(req, res);
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    return handleLogin(req, res);
  }
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    return handleGetMe(req, res);
  }

  // User routes
  if (pathname === '/api/users' && req.method === 'GET') {
    return handleGetUsers(req, res);
  }
  if (pathname.match(/^\/api\/users\/[^/]+$/) && req.method === 'GET') {
    return handleGetUser(req, res, pathname.split('/')[3]);
  }

  // Conversation routes
  if (pathname === '/api/conversations' && req.method === 'GET') {
    return handleGetConversations(req, res);
  }
  if (pathname === '/api/conversations' && req.method === 'POST') {
    return handleCreateConversation(req, res);
  }

  // Message routes
  if (pathname.match(/^\/api\/conversations\/[^/]+\/messages$/) && req.method === 'GET') {
    const conversationId = pathname.split('/')[3];
    return handleGetMessages(req, res, conversationId);
  }
  if (pathname.match(/^\/api\/conversations\/[^/]+\/messages$/) && req.method === 'POST') {
    const conversationId = pathname.split('/')[3];
    return handleSendMessage(req, res, conversationId);
  }

  // SSE endpoint for real-time messages
  if (pathname === '/api/events' && req.method === 'GET') {
    return handleSSE(req, res);
  }

  // 404 for unknown API routes
  sendJson(res, 404, { error: 'Not found' });
}

// Auth handlers
async function handleRegister(req, res) {
  try {
    const { username, password, publicKey } = await parseBody(req);
    
    if (!username || !password || !publicKey) {
      return sendJson(res, 400, { error: 'Username, password, and public key are required' });
    }

    if (username.length < 3 || username.length > 20) {
      return sendJson(res, 400, { error: 'Username must be 3-20 characters' });
    }

    if (password.length < 8) {
      return sendJson(res, 400, { error: 'Password must be at least 8 characters' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Insert user
    const { data, error } = await supabase
      .from('users')
      .insert({ username, password_hash: passwordHash, public_key: publicKey })
      .select('id, username, public_key, created_at')
      .single();

    if (error) {
      if (error.code === '23505') {
        return sendJson(res, 400, { error: 'Username already exists' });
      }
      throw error;
    }

    // Generate JWT
    const token = jwt.sign({ userId: data.id, username: data.username }, JWT_SECRET, { expiresIn: '7d' });

    sendJson(res, 201, { user: data, token });
  } catch (e) {
    console.error('Register error:', e);
    sendJson(res, 500, { error: 'Server error' });
  }
}

async function handleLogin(req, res) {
  try {
    const { username, password } = await parseBody(req);
    
    if (!username || !password) {
      return sendJson(res, 400, { error: 'Username and password are required' });
    }

    // Get user
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .single();

    if (error || !user) {
      return sendJson(res, 401, { error: 'Invalid credentials' });
    }

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return sendJson(res, 401, { error: 'Invalid credentials' });
    }

    // Generate JWT
    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    sendJson(res, 200, { 
      user: { id: user.id, username: user.username, public_key: user.public_key, created_at: user.created_at },
      token 
    });
  } catch (e) {
    console.error('Login error:', e);
    sendJson(res, 500, { error: 'Server error' });
  }
}

async function handleGetMe(req, res) {
  const user = verifyToken(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, public_key, created_at')
      .eq('id', user.userId)
      .single();

    if (error) throw error;
    sendJson(res, 200, { user: data });
  } catch (e) {
    console.error('GetMe error:', e);
    sendJson(res, 500, { error: 'Server error' });
  }
}

// User handlers
async function handleGetUsers(req, res) {
  const user = verifyToken(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const search = url.searchParams.get('search') || '';

    let query = supabase
      .from('users')
      .select('id, username, public_key, created_at')
      .neq('id', user.userId);

    if (search) {
      query = query.ilike('username', `%${search}%`);
    }

    const { data, error } = await query.limit(20);
    if (error) throw error;

    sendJson(res, 200, { users: data });
  } catch (e) {
    console.error('GetUsers error:', e);
    sendJson(res, 500, { error: 'Server error' });
  }
}

async function handleGetUser(req, res, userId) {
  const user = verifyToken(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, public_key, created_at')
      .eq('id', userId)
      .single();

    if (error) throw error;
    sendJson(res, 200, { user: data });
  } catch (e) {
    console.error('GetUser error:', e);
    sendJson(res, 500, { error: 'Server error' });
  }
}

// Conversation handlers
async function handleGetConversations(req, res) {
  const user = verifyToken(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  try {
    // Get conversations where user is a participant
    const { data: participations, error: partError } = await supabase
      .from('conversation_participants')
      .select('conversation_id')
      .eq('user_id', user.userId);

    if (partError) throw partError;

    if (!participations.length) {
      return sendJson(res, 200, { conversations: [] });
    }

    const conversationIds = participations.map(p => p.conversation_id);

    // Get conversation details with other participants
    const { data: conversations, error: convError } = await supabase
      .from('conversations')
      .select('id, created_at')
      .in('id', conversationIds);

    if (convError) throw convError;

    // Get participants for each conversation
    const result = await Promise.all(conversations.map(async conv => {
      const { data: participants } = await supabase
        .from('conversation_participants')
        .select('user_id, users(id, username, public_key)')
        .eq('conversation_id', conv.id);

      // Get last message
      const { data: lastMessage } = await supabase
        .from('messages')
        .select('id, encrypted_content, created_at, sender_id')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      return {
        ...conv,
        participants: participants?.map(p => p.users) || [],
        lastMessage
      };
    }));

    sendJson(res, 200, { conversations: result });
  } catch (e) {
    console.error('GetConversations error:', e);
    sendJson(res, 500, { error: 'Server error' });
  }
}

async function handleCreateConversation(req, res) {
  const user = verifyToken(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  try {
    const { participantId } = await parseBody(req);
    
    if (!participantId) {
      return sendJson(res, 400, { error: 'Participant ID is required' });
    }

    // Check if conversation already exists between these users
    const { data: existingConvs } = await supabase
      .from('conversation_participants')
      .select('conversation_id')
      .eq('user_id', user.userId);

    if (existingConvs) {
      for (const conv of existingConvs) {
        const { data: otherParticipant } = await supabase
          .from('conversation_participants')
          .select('user_id')
          .eq('conversation_id', conv.conversation_id)
          .eq('user_id', participantId)
          .single();

        if (otherParticipant) {
          // Conversation already exists, return it
          const { data: existingConv } = await supabase
            .from('conversations')
            .select('id, created_at')
            .eq('id', conv.conversation_id)
            .single();

          return sendJson(res, 200, { conversation: existingConv, existing: true });
        }
      }
    }

    // Create new conversation
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .insert({})
      .select()
      .single();

    if (convError) throw convError;

    // Add participants
    const { error: partError } = await supabase
      .from('conversation_participants')
      .insert([
        { conversation_id: conversation.id, user_id: user.userId },
        { conversation_id: conversation.id, user_id: participantId }
      ]);

    if (partError) throw partError;

    sendJson(res, 201, { conversation, existing: false });
  } catch (e) {
    console.error('CreateConversation error:', e);
    sendJson(res, 500, { error: 'Server error' });
  }
}

// Message handlers
async function handleGetMessages(req, res, conversationId) {
  const user = verifyToken(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  try {
    // Verify user is participant
    const { data: participant } = await supabase
      .from('conversation_participants')
      .select('user_id')
      .eq('conversation_id', conversationId)
      .eq('user_id', user.userId)
      .single();

    if (!participant) {
      return sendJson(res, 403, { error: 'Not a participant in this conversation' });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = parseInt(url.searchParams.get('limit')) || 50;
    const before = url.searchParams.get('before');

    let query = supabase
      .from('messages')
      .select('id, conversation_id, sender_id, encrypted_content, encrypted_key, iv, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (before) {
      query = query.lt('created_at', before);
    }

    const { data: messages, error } = await query;
    if (error) throw error;

    sendJson(res, 200, { messages: messages.reverse() });
  } catch (e) {
    console.error('GetMessages error:', e);
    sendJson(res, 500, { error: 'Server error' });
  }
}

async function handleSendMessage(req, res, conversationId) {
  const user = verifyToken(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  try {
    // Verify user is participant
    const { data: participant } = await supabase
      .from('conversation_participants')
      .select('user_id')
      .eq('conversation_id', conversationId)
      .eq('user_id', user.userId)
      .single();

    if (!participant) {
      return sendJson(res, 403, { error: 'Not a participant in this conversation' });
    }

    const { encryptedContent, encryptedKey, iv } = await parseBody(req);
    
    if (!encryptedContent || !encryptedKey || !iv) {
      return sendJson(res, 400, { error: 'Encrypted content, key, and IV are required' });
    }

    // Insert message
    const { data: message, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: user.userId,
        encrypted_content: encryptedContent,
        encrypted_key: encryptedKey,
        iv: iv
      })
      .select()
      .single();

    if (error) throw error;

    // Get other participants to notify
    const { data: participants } = await supabase
      .from('conversation_participants')
      .select('user_id')
      .eq('conversation_id', conversationId)
      .neq('user_id', user.userId);

    // Notify via SSE
    participants?.forEach(p => {
      const connection = sseConnections.get(p.user_id);
      if (connection) {
        connection.write(`data: ${JSON.stringify({ type: 'new_message', message })}\n\n`);
      }
    });

    sendJson(res, 201, { message });
  } catch (e) {
    console.error('SendMessage error:', e);
    sendJson(res, 500, { error: 'Server error' });
  }
}

// SSE handler for real-time updates
function handleSSE(req, res) {
  const user = verifyToken(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  // Store connection
  sseConnections.set(user.userId, res);

  // Keep alive
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 30000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(keepAlive);
    sseConnections.delete(user.userId);
  });
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  if (url.pathname.startsWith('/api')) {
    await handleApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
