const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const os = require('os');
const cors = require('cors');
const wa = require('./whatsapp');

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use('/media', express.static(path.join(__dirname, 'media')));

// Broadcast helper ke semua klien WebSocket aktif
function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  });
}

// Teruskan event dari WhatsApp ke WebSocket klien
wa.on('qr', ({ qrDataUrl }) => {
  broadcast({ type: 'qr', qr: qrDataUrl });
});

wa.on('account_qr', ({ accountId, qr }) => {
  broadcast({ type: 'account_qr', accountId, qr });
});

wa.on('status', (status) => {
  broadcast({
    type: 'status',
    state: status.state,
    user: status.user,
    reason: status.reason,
    loggedOut: status.loggedOut
  });
});

wa.on('account_status', (data) => {
  broadcast({
    type: 'account_status',
    ...data
  });
});

wa.on('pairing_link_updated', (link) => {
  broadcast({ type: 'pairing_link_updated', link });
});

wa.on('pairing_link_completed', (data) => {
  broadcast({
    type: 'pairing_link_completed',
    link: data.link,
    account: data.account,
    accounts: wa.getAllAccounts()
  });
});

wa.on('pairing_links_updated', (links) => {
  broadcast({ type: 'pairing_links_updated', links });
});

wa.on('accounts_updated', (accounts) => {
  broadcast({
    type: 'accounts_updated',
    accounts
  });
});

wa.on('new_message', ({ accountId, jid, message, chat }) => {
  broadcast({
    type: 'new_message',
    accountId,
    jid,
    message,
    chat
  });
});

wa.on('chat_updated', (chat) => {
  broadcast({
    type: 'chat_updated',
    chat
  });
});

wa.on('chats_synced', (chats) => {
  broadcast({
    type: 'chats_synced',
    chats
  });
});

wa.on('calls_updated', (calls) => {
  broadcast({
    type: 'calls_updated',
    calls
  });
});

wa.on('tokens_updated', (tokens) => {
  broadcast({
    type: 'tokens_updated',
    tokens
  });
});

wa.on('pairing_code', (data) => {
  broadcast({
    type: 'pairing_code',
    ...data
  });
});

// Handler koneksi WebSocket
wss.on('connection', (ws) => {
  console.log('[WS] Klien terhubung');

  // Kirim kondisi terkini ke klien yang baru terhubung
  ws.send(JSON.stringify({
    type: 'init',
    state: wa.connectionState,
    qr: wa.qrCodeDataUrl,
    user: wa.userInfo,
    accounts: wa.getAllAccounts(),
    links: wa.getAllAuthTokens(),
    localIp: getLocalIp(),
    chats: wa.getAllChats(),
    calls: wa.getAllCalls()
  }));

  ws.on('message', async (messageRaw) => {
    try {
      const data = JSON.parse(messageRaw);

      if (data.type === 'send_message') {
        const { jid, text, accountId } = data;
        if (!jid || !text) return;
        await wa.sendManualMessage(jid, text, accountId);
      }

      else if (data.type === 'add_account') {
        await wa.addAccount(data.name);
      }

      else if (data.type === 'delete_account') {
        await wa.deleteAccount(data.accountId);
      }

      else if (data.type === 'rename_account') {
        wa.renameAccount(data.accountId, data.name);
      }

      else if (data.type === 'reconnect_account') {
        await wa.reconnectAccount(data.accountId);
      }

      else if (data.type === 'logout') {
        await wa.logout(data.accountId || null);
      }

      else if (data.type === 'refresh_qr') {
        await wa.reconnectAccount(data.accountId || 'acc_1');
      }

      else if (data.type === 'mark_read') {
        const target = data.key || data.jid;
        const chat = wa.findChat(target);
        if (chat) {
          chat.unread = 0;
          wa.saveDb();
          broadcast({ type: 'chat_updated', chat });
        }
      }

      else if (data.type === 'delete_chat') {
        const target = data.key || data.jid;
        const success = wa.deleteChat(target);
        if (success) {
          console.log(`[WA] Chat ${target} berhasil dihapus.`);
        }
      }

      else if (data.type === 'toggle_notify') {
        const target = data.key || data.jid;
        const chat = wa.setNotificationPermission(target, data.enabled);
        if (chat) {
          broadcast({ type: 'chat_updated', chat });
        }
      }

      else if (data.type === 'delete_call') {
        wa.deleteCall(data.id);
      }

      else if (data.type === 'clear_calls') {
        wa.clearCalls();
      }

      else if (data.type === 'update_chat_name') {
        const target = data.key || data.jid;
        const { name } = data;
        if (target && name) {
          const chat = wa.updateChatContactName(target, name);
          if (chat) {
            broadcast({ type: 'chat_updated', chat });
            broadcast({ type: 'chats_synced', chats: wa.getAllChats() });
          }
        }
      }

      else if (data.type === 'create_auth_link') {
        const link = wa.createAuthLink({
          deviceName: data.deviceName,
          expiresHours: data.expiresHours
        });
        ws.send(JSON.stringify({ type: 'auth_link_created', link }));
      }

      else if (data.type === 'revoke_auth_link') {
        wa.revokeAuthToken(data.tokenId || data.id);
      }

      else if (data.type === 'request_pairing_code') {
        try {
          const code = await wa.requestPairingCode(data.accountId, data.phone);
          ws.send(JSON.stringify({
            type: 'pairing_code_response',
            accountId: data.accountId,
            code
          }));
        } catch (pairErr) {
          ws.send(JSON.stringify({ type: 'error', error: pairErr.message }));
        }
      }
    } catch (err) {
      console.error('[WS] Error processing message:', err.message);
      ws.send(JSON.stringify({ type: 'error', error: err.message }));
    }
  });

  ws.on('close', () => {
    console.log('[WS] Klien terputus');
  });
});

// ==================== PENAUTAN MELALUI LINK (MAGIC LINK) ====================
// Ketika pemegang device klik link ini, langsung dialihkan ke dashboard dan dianggap login
app.get(['/join', '/join/:token', '/link/:token'], (req, res) => {
  const token = req.params.token || req.query.token;
  if (!token) {
    return res.redirect('/?auth_error=missing_token');
  }

  const verified = wa.verifyAuthToken(token);
  if (!verified) {
    return res.redirect('/?auth_error=invalid_token');
  }

  // Arahkan ke dashboard dengan auth_token & nama perangkat
  res.redirect(`/?auth_token=${encodeURIComponent(token)}&device=${encodeURIComponent(verified.deviceName)}`);
});

// REST Endpoints
app.get('/api/links', (req, res) => {
  res.json({ ok: true, links: wa.getAllAuthTokens() });
});

app.post('/api/links', (req, res) => {
  try {
    const { deviceName, expiresHours } = req.body;
    const linkObj = wa.createAuthLink({ deviceName, expiresHours });
    res.json({ ok: true, link: linkObj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/links/:id', (req, res) => {
  const ok = wa.revokeAuthToken(req.params.id);
  res.json({ ok });
});

app.post('/api/auth/verify', (req, res) => {
  const tokenObj = wa.verifyAuthToken(req.body.token);
  if (tokenObj) {
    res.json({ ok: true, valid: true, deviceName: tokenObj.deviceName });
  } else {
    res.status(401).json({ ok: false, valid: false, error: 'Tautan tidak valid atau telah kedaluwarsa' });
  }
});

app.post('/api/accounts/:id/pairing-code', async (req, res) => {
  try {
    const { phone } = req.body;
    const code = await wa.requestPairingCode(req.params.id, phone);
    res.json({ ok: true, code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ==================== TAUTAN PENAUTAN WHATSAPP BARU (CONNECT VIA LINK) ====================
// Halaman untuk penerima/karyawan yang klik link penautan di HP
app.get(['/connect/:token', '/tautkan/:token'], (req, res) => {
  res.sendFile(path.join(__dirname, 'connect.html'));
});

// API Info Link untuk halaman /connect/:token
app.get('/api/connect/:token', (req, res) => {
  const link = wa.getPairingLinkByToken(req.params.token);
  if (!link) {
    return res.status(404).json({ ok: false, error: 'Tautan penautan tidak ditemukan atau telah kedaluwarsa' });
  }
  res.json({ ok: true, link });
});

// API Permintaan Pairing Code oleh pemegang HP di /connect/:token
app.post('/api/connect/:token/pair', async (req, res) => {
  try {
    const { phone } = req.body;
    const result = await wa.startPairingForLink(req.params.token, phone);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API Polling Status untuk halaman /connect/:token
app.get('/api/connect/:token/status', (req, res) => {
  const status = wa.getPairingLinkStatus(req.params.token);
  res.json(status);
});

// API CRUD Pairing Links untuk Admin Dashboard
app.get('/api/pairing-links', (req, res) => {
  res.json({ ok: true, links: wa.getAllPairingLinks() });
});

app.post('/api/pairing-links', (req, res) => {
  try {
    const { accountName, targetPhone, expiresHours } = req.body;
    const link = wa.createPairingLink({ accountName, targetPhone, expiresHours });
    res.json({ ok: true, link });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/pairing-links/:id', async (req, res) => {
  try {
    const ok = await wa.deletePairingLink(req.params.id);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/accounts', (req, res) => {
  res.json(wa.getAllAccounts());
});

app.post('/api/accounts', async (req, res) => {
  try {
    const acc = await wa.addAccount(req.body.name);
    res.json({ ok: true, account: acc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const ok = await wa.deleteAccount(req.params.id);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accounts/:id/rename', (req, res) => {
  const ok = wa.renameAccount(req.params.id, req.body.name);
  res.json({ ok });
});

app.post('/api/accounts/:id/reconnect', async (req, res) => {
  try {
    const ok = await wa.reconnectAccount(req.params.id);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    state: wa.connectionState,
    qr: wa.qrCodeDataUrl,
    user: wa.userInfo,
    localIp: getLocalIp(),
    accounts: wa.getAllAccounts()
  });
});

app.get('/api/chats', (req, res) => {
  res.json(wa.getAllChats(req.query.accountId || null));
});

app.delete('/api/chats/:target', (req, res) => {
  const success = wa.deleteChat(req.params.target);
  res.json({ ok: success });
});

app.post('/api/chats/:target/notify', (req, res) => {
  const chat = wa.setNotificationPermission(req.params.target, req.body.enabled);
  if (chat) {
    broadcast({ type: 'chat_updated', chat });
    res.json({ ok: true, chat });
  } else {
    res.status(404).json({ error: 'Chat tidak ditemukan' });
  }
});

app.post('/api/chats/:target/name', (req, res) => {
  const { name } = req.body;
  const chat = wa.updateChatContactName(req.params.target, name);
  if (chat) {
    broadcast({ type: 'chat_updated', chat });
    broadcast({ type: 'chats_synced', chats: wa.getAllChats() });
    res.json({ ok: true, chat });
  } else {
    res.status(404).json({ error: 'Chat tidak ditemukan' });
  }
});

app.get('/api/contacts', (req, res) => {
  res.json(Array.from(wa.contacts.values()));
});

app.get('/api/calls', (req, res) => {
  res.json(wa.getAllCalls(req.query.accountId || null));
});

app.delete('/api/calls/:id', (req, res) => {
  const success = wa.deleteCall(req.params.id);
  res.json({ ok: success });
});

app.delete('/api/calls', (req, res) => {
  const success = wa.clearCalls();
  res.json({ ok: success });
});

app.post('/api/send', async (req, res) => {
  try {
    const { jid, text, accountId } = req.body;
    const msg = await wa.sendManualMessage(jid, text, accountId);
    res.json({ ok: true, message: msg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logout', async (req, res) => {
  await wa.logout(req.body.accountId || null);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🚀 Kuma Multi-Account WhatsApp Admin berjalan di http://localhost:${PORT}`);
  console.log(`===============================================`);
  wa.init().catch(err => {
    console.error('[WA] Gagal inisialisasi WhatsApp:', err);
  });
});
