import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'secure-messaging-jwt-secret-key-2024';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing required environment variables: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const sseConnections = new Map();

// --- Helpers ---
const parseBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try { resolve(body ? JSON.parse(body) : {}); } 
    catch (e) { reject(new Error('Invalid JSON')); }
  });
});

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

function verifyToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try { return jwt.verify(authHeader.split(' ')[1], JWT_SECRET); } catch (e) { return null; }
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const queryToken = url.searchParams.get('token');
  if (queryToken) {
    try { return jwt.verify(queryToken, JWT_SECRET); } catch (e) { return null; }
  }
  return null;
}

// --- Route Handlers ---

async function handleRegister(req, res) {
  try {
    const { username, password, publicKey } = await parseBody(req);
    if (!username || !password || !publicKey) return sendJson(res, 400, { error: 'Missing fields' });

    const passwordHash = await bcrypt.hash(password, 12);
    const { data, error } = await supabase
      .from('users')
      .insert({ username, password_hash: passwordHash, public_key: publicKey })
      .select('id, username, public_key, created_at')
      .single();

    if (error) return sendJson(res, 400, { error: error.code === '23505' ? 'Username exists' : error.message });

    const token = jwt.sign({ userId: data.id, username: data.username }, JWT_SECRET, { expiresIn: '7d' });
    sendJson(res, 201, { user: data, token });
  } catch (e) { sendJson(res, 500, { error: 'Server error' }); }
}

async function handleLogin(req, res) {
  try {
    const { username, password } = await parseBody(req);
    const { data: user, error } = await supabase.from('users').select('*').eq('username', username).single();

    if (error || !user || !(await bcrypt.compare(password, user.password_hash))) {
      return sendJson(res, 401, { error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    sendJson(res, 200, { user: { id: user.id, username: user.username, public_key: user.public_key }, token });
  } catch (e) { sendJson(res, 500, { error: 'Server error' }); }
}

// ---------- NEW: Get current user (GET /api/auth/me) ----------
async function handleGetMe(req, res) {
  const user = verifyToken(req);
  if (!user) return sendJson(res, 401, { error: 'Unauthorized' });
  const { data, error } = await supabase
    .from('users')
    .select('id, username, public_key, created_at')
    .eq('id', user.userId)
    .single();
  if (error || !data) return sendJson(res, 404, { error: 'User not found' });
  sendJson(res, 200, { user: data });
}

// ---------- NEW: Search users (GET /api/users?search=query) ----------
async function handleSearchUsers(req, res) {
  const user = verifyToken(req);
  if (!user) return sendJson(res, 401, { error: 'Unauthorized' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const query = url.searchParams.get('search')?.trim();
  if (!query) return sendJson(res, 400, { error: 'Search query required' });

  const { data, error } = await supabase
    .from('users')
    .select('id, username, public_key, created_at')
    .ilike('username', `%${query}%`)
    .limit(20);

  if (error) return sendJson(res, 500, { error: 'Search failed' });
  sendJson(res, 200, { users: data || [] });
}

// ---------- NEW: Get single user (GET /api/users/:userId) ----------
async function handleGetUser(req, res, userId) {
  const user = verifyToken(req);
  if (!user) return sendJson(res, 401, { error: 'Unauthorized' });

  const { data, error } = await supabase
    .from('users')
    .select('id, username, public_key, created_at')
    .eq('id', userId)
    .single();

  if (error || !data) return sendJson(res, 404, { error: 'User not found' });
  sendJson(res, 200, { user: data });
}

async function handleGetConversations(req, res) {
  const user = verifyToken(req);
  if (!user) return sendJson(res, 401, { error: 'Unauthorized' });

  try {
    const { data: participations } = await supabase.from('conversation_participants').select('conversation_id').eq('user_id', user.userId);
    if (!participations?.length) return sendJson(res, 200, { conversations: [] });

    const convIds = participations.map(p => p.conversation_id);
    const { data: conversations } = await supabase.from('conversations').select('id, created_at').in('id', convIds);

    const result = await Promise.all(conversations.map(async conv => {
      const { data: participants } = await supabase.from('conversation_participants').select('users(id, username, public_key)').eq('conversation_id', conv.id);
      const { data: lastMessage } = await supabase.from('messages').select('*').eq('conversation_id', conv.id).order('created_at', { ascending: false }).limit(1).single();
      return { ...conv, participants: participants.map(p => p.users), lastMessage };
    }));

    sendJson(res, 200, { conversations: result });
  } catch (e) { sendJson(res, 500, { error: 'Server error' }); }
}

// ---------- NEW: Create conversation (POST /api/conversations) ----------
async function handleCreateConversation(req, res) {
  const user = verifyToken(req);
  if (!user) return sendJson(res, 401, { error: 'Unauthorized' });

  try {
    const { participantId } = await parseBody(req);
    if (!participantId) return sendJson(res, 400, { error: 'participantId required' });

    // Check if conversation already exists between the two users
    const { data: existingConvs } = await supabase
      .from('conversation_participants')
      .select('conversation_id')
      .eq('user_id', user.userId);

    const userConvIds = existingConvs?.map(p => p.conversation_id) || [];
    if (userConvIds.length > 0) {
      const { data: shared } = await supabase
        .from('conversation_participants')
        .select('conversation_id')
        .in('conversation_id', userConvIds)
        .eq('user_id', participantId);

      if (shared?.length) {
        // Existing conversation found
        const convId = shared[0].conversation_id;
        const { data: participants } = await supabase.from('conversation_participants').select('users(id, username, public_key)').eq('conversation_id', convId);
        return sendJson(res, 200, { conversation: { id: convId, participants: participants.map(p => p.users), existing: true } });
      }
    }

    // Create new conversation
    const { data: conv, error: convError } = await supabase.from('conversations').insert({}).select().single();
    if (convError) throw convError;

    // Add participants
    await supabase.from('conversation_participants').insert([
      { conversation_id: conv.id, user_id: user.userId },
      { conversation_id: conv.id, user_id: participantId }
    ]);

    sendJson(res, 201, { conversation: { id: conv.id, participants: [{ id: user.userId }, { id: participantId }], existing: false } });
  } catch (e) { sendJson(res, 500, { error: 'Server error' }); }
}

async function handleSendMessage(req, res, conversationId) {
  const user = verifyToken(req);
  if (!user) return sendJson(res, 401, { error: 'Unauthorized' });

  try {
    const { encryptedContent, encryptedKey, iv } = await parseBody(req);
    const { data: message, error } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      sender_id: user.userId,
      encrypted_content: encryptedContent,
      encrypted_key: encryptedKey,
      iv: iv
    }).select().single();

    if (error) throw error;

    const { data: participants } = await supabase.from('conversation_participants').select('user_id').eq('conversation_id', conversationId).neq('user_id', user.userId);
    participants?.forEach(p => {
      const conn = sseConnections.get(p.user_id);
      if (conn) conn.write(`data: ${JSON.stringify({ type: 'new_message', message })}\n\n`);
    });

    sendJson(res, 201, { message });
  } catch (e) { sendJson(res, 500, { error: 'Server error' }); }
}

// ---------- NEW: Get messages (GET /api/conversations/:id/messages) ----------
async function handleGetMessages(req, res, conversationId) {
  const user = verifyToken(req);
  if (!user) return sendJson(res, 401, { error: 'Unauthorized' });

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = parseInt(url.searchParams.get('limit')) || 50;
    const before = url.searchParams.get('before'); // ISO timestamp

    let query = supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (before) {
      query = query.lt('created_at', before);
    }

    const { data: messages, error } = await query;

    if (error) throw error;
    // Return messages in chronological order
    sendJson(res, 200, { messages: (messages || []).reverse() });
  } catch (e) { sendJson(res, 500, { error: 'Server error' }); }
}

// --- SSE & Static Logic ---

function handleSSE(req, res) {
  const user = verifyToken(req);
  if (!user) return sendJson(res, 401, { error: 'Unauthorized' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  sseConnections.set(user.userId, res);
  const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 30000);
  req.on('close', () => { clearInterval(keepAlive); sseConnections.delete(user.userId); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' });
    return res.end();
  }

  // Auth routes
  if (pathname === '/api/auth/register' && req.method === 'POST') return handleRegister(req, res);
  if (pathname === '/api/auth/login' && req.method === 'POST') return handleLogin(req, res);
  if (pathname === '/api/auth/me' && req.method === 'GET') return handleGetMe(req, res);

  // User routes
  if (pathname === '/api/users' && req.method === 'GET') return handleSearchUsers(req, res);
  if (pathname.startsWith('/api/users/') && req.method === 'GET') {
    const userId = pathname.split('/')[3]; // /api/users/:userId
    if (userId) return handleGetUser(req, res, userId);
  }

  // Conversation routes
  if (pathname === '/api/conversations' && req.method === 'GET') return handleGetConversations(req, res);
  if (pathname === '/api/conversations' && req.method === 'POST') return handleCreateConversation(req, res);

  // Message routes
  const messageMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (messageMatch) {
    const conversationId = messageMatch[1];
    if (req.method === 'POST') return handleSendMessage(req, res, conversationId);
    if (req.method === 'GET') return handleGetMessages(req, res, conversationId);
  }

  // SSE
  if (pathname === '/api/events') return handleSSE(req, res);

  // Static file serving fallback
  const filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': ext === '.js' ? 'application/javascript' : 'text/html' });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
