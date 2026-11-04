const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  Browsers,
  downloadMediaMessage,
  WAMessageStubType
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const EventEmitter = require('events');

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const SESSIONS_DIR = path.join(__dirname, 'auth_sessions');
const ACCOUNTS_PATH = path.join(__dirname, 'accounts.json');
const TOKENS_PATH = path.join(__dirname, 'auth_tokens.json');
const PAIRING_LINKS_PATH = path.join(__dirname, 'wa_pairing_links.json');
const DB_PATH = path.join(__dirname, 'db.json');
const CALLS_PATH = path.join(__dirname, 'calls.json');
const CONTACTS_PATH = path.join(__dirname, 'contacts.json');
const MEDIA_DIR = path.join(__dirname, 'media');

if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function isIgnoredJid(jid) {
  if (!jid) return true;
  if (jid === 'status@broadcast') return true;
  if (jid.endsWith('@broadcast')) return true;
  if (jid.endsWith('@newsletter')) return true;
  return false;
}

function isValidContactName(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed.includes('∙') || trimmed.includes('•')) return false;
  if (/^[\+\d\s\-\(\)\.]+$/.test(trimmed)) return false;
  if (trimmed.endsWith('@lid') || trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@g.us')) return false;
  return true;
}

function cleanDigits(str) {
  if (!str) return '';
  return String(str).replace(/[^\d]/g, '');
}

function normalizePhoneForWA(phone) {
  let digits = cleanDigits(phone);
  if (!digits) return '';
  if (digits.startsWith('0')) {
    digits = '62' + digits.slice(1);
  }
  return digits;
}

function formatPhoneNumber(num) {
  const digits = cleanDigits(num);
  if (!digits) return '';
  if (digits.startsWith('62')) {
    return '+62 ' + digits.slice(2, 5) + '-' + digits.slice(5, 9) + '-' + digits.slice(9);
  }
  return '+' + digits;
}

function loadAllLidReverseMaps() {
  const map = new Map();
  const searchDirs = [AUTH_DIR];

  try {
    if (fs.existsSync(SESSIONS_DIR)) {
      const subs = fs.readdirSync(SESSIONS_DIR);
      for (const sub of subs) {
        const full = path.join(SESSIONS_DIR, sub);
        try {
          if (fs.statSync(full).isDirectory()) searchDirs.push(full);
        } catch (e) {}
      }
    }
  } catch (err) {}

  for (const dir of searchDirs) {
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (f.startsWith('lid-mapping-') && f.endsWith('_reverse.json')) {
            const lid = f.replace('lid-mapping-', '').replace('_reverse.json', '');
            try {
              const pn = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
              if (pn) map.set(lid, String(pn));
            } catch (e) {}
          }
        }
      }
    } catch (err) {}
  }
  return map;
}

function extractText(m) {
  let msgContent = m.message;
  if (!msgContent) return '';
  if (msgContent.viewOnceMessage?.message) msgContent = msgContent.viewOnceMessage.message;
  if (msgContent.viewOnceMessageV2?.message) msgContent = msgContent.viewOnceMessageV2.message;
  if (msgContent.viewOnceMessageV2Extension?.message) msgContent = msgContent.viewOnceMessageV2Extension.message;
  if (msgContent.ephemeralMessage?.message) msgContent = msgContent.ephemeralMessage.message;

  const text = msgContent.conversation ||
               msgContent.extendedTextMessage?.text ||
               msgContent.imageMessage?.caption ||
               msgContent.videoMessage?.caption ||
               msgContent.documentMessage?.caption ||
               msgContent.documentMessage?.fileName ||
               '';
  if (text.trim()) return text.trim();

  if (msgContent.imageMessage) return '📷 Foto';
  if (msgContent.videoMessage) return '🎥 Video';
  if (msgContent.audioMessage) return '🎵 Pesan Suara';
  if (msgContent.stickerMessage) return '🌟 Stiker';
  if (msgContent.documentMessage) return '📄 Dokumen';
  return '';
}

async function saveMediaMessage(m) {
  try {
    let msgContent = m.message;
    if (!msgContent) return null;
    if (msgContent.viewOnceMessage?.message) msgContent = msgContent.viewOnceMessage.message;
    if (msgContent.viewOnceMessageV2?.message) msgContent = msgContent.viewOnceMessageV2.message;
    if (msgContent.viewOnceMessageV2Extension?.message) msgContent = msgContent.viewOnceMessageV2Extension.message;
    if (msgContent.ephemeralMessage?.message) msgContent = msgContent.ephemeralMessage.message;

    let mediaType = null;
    let ext = 'bin';
    let mime = '';

    if (msgContent.imageMessage) {
      mediaType = 'image';
      mime = msgContent.imageMessage.mimetype || 'image/jpeg';
      ext = mime.includes('png') ? 'png' : 'jpg';
    } else if (msgContent.videoMessage) {
      mediaType = 'video';
      mime = msgContent.videoMessage.mimetype || 'video/mp4';
      ext = 'mp4';
    } else if (msgContent.audioMessage) {
      mediaType = 'audio';
      mime = msgContent.audioMessage.mimetype || 'audio/ogg';
      ext = mime.includes('mp4') ? 'm4a' : 'ogg';
    } else if (msgContent.documentMessage) {
      mediaType = 'document';
      mime = msgContent.documentMessage.mimetype || 'application/octet-stream';
      const origName = msgContent.documentMessage.fileName || 'dokumen';
      const parts = origName.split('.');
      ext = parts.length > 1 ? parts.pop() : 'bin';
    } else if (msgContent.stickerMessage) {
      mediaType = 'sticker';
      mime = 'image/webp';
      ext = 'webp';
    }

    if (!mediaType) return null;

    const buffer = await downloadMediaMessage(
      m,
      'buffer',
      {},
      {
        logger: pino({ level: 'silent' }),
        reuploadRequest: () => new Promise(() => {})
      }
    );

    if (buffer && buffer.length > 0) {
      const filename = `${mediaType}_${m.key.id}_${Date.now()}.${ext}`;
      const filePath = path.join(MEDIA_DIR, filename);
      fs.writeFileSync(filePath, buffer);

      return {
        type: mediaType,
        filename,
        url: `/media/${filename}`,
        mimetype: mime,
        size: buffer.length
      };
    }
  } catch (err) {
    console.warn('[Media] Peringatan: media tidak dapat diunduh:', err.message);
  }
  return null;
}

/**
 * WhatsAppSession: Merepresentasikan satu koneksi nomor WhatsApp Admin
 */
class WhatsAppSession extends EventEmitter {
  constructor(account, manager) {
    super();
    this.id = account.id;
    this.name = account.name || 'Admin';
    this.authDir = account.authDir;
    this.phone = account.phone || '';
    this.pushName = account.pushName || '';
    this.isDefault = Boolean(account.isDefault);
    this.manager = manager;

    this.sock = null;
    this.qrCodeDataUrl = null;
    this.connectionState = 'disconnected';
    this.userInfo = null;
    this.reconnectTimer = null;
  }

  getResolvedAuthDir() {
    if (path.isAbsolute(this.authDir)) {
      return this.authDir;
    }
    return path.join(__dirname, this.authDir);
  }

  async init() {
    if (this.sock) {
      return;
    }
    this.connectionState = 'connecting';
    this.manager.emitSessionStatus(this);

    const fullAuthDir = this.getResolvedAuthDir();
    if (!fs.existsSync(fullAuthDir)) {
      fs.mkdirSync(fullAuthDir, { recursive: true });
    }

    try {
      const { state, saveCreds } = await useMultiFileAuthState(fullAuthDir);
      const { version, isLatest } = await fetchLatestBaileysVersion();
      console.log(`[WA:${this.name}] Baileys v${version.join('.')}, isLatest: ${isLatest}`);

      const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: true
      });

      this.sock = sock;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            this.qrCodeDataUrl = await qrcode.toDataURL(qr, {
              errorCorrectionLevel: 'M',
              margin: 2,
              scale: 8
            });
            console.log(`[WA:${this.name}] Kode QR baru diterima, siap dipindai.`);
            this.manager.emitAccountQr(this);
          } catch (qrErr) {
            console.error(`[WA:${this.name}] Gagal generate data URL QR:`, qrErr);
          }
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          console.log(`[WA:${this.name}] Koneksi terputus (status: ${statusCode}). Reconnect: ${shouldReconnect}`);

          this.connectionState = 'disconnected';
          this.sock = null;
          this.manager.emitSessionStatus(this, statusCode);

          if (shouldReconnect) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this.init(), 3000);
          } else {
            console.log(`[WA:${this.name}] Sesi WhatsApp telah keluar (logged out).`);
            this.qrCodeDataUrl = null;
            this.userInfo = null;
          }
        } else if (connection === 'open') {
          console.log(`[WA:${this.name}] Berhasil terhubung ke WhatsApp!`);
          this.connectionState = 'open';
          this.qrCodeDataUrl = null;
          this.userInfo = sock.user;

          if (sock.user?.id) {
            const rawPhone = sock.user.id.split(':')[0];
            const clean = cleanDigits(rawPhone);
            if (clean) {
              this.phone = '+' + clean;
            }
          }
          if (sock.user?.name) {
            this.pushName = sock.user.name;
          }

          this.manager.updateAccountInfo(this.id, {
            phone: this.phone,
            pushName: this.pushName
          });

          // Cek apakah akun ini ditautkan melalui pairing link
          if (Array.isArray(this.manager.pairingLinks)) {
            const matchedLink = this.manager.pairingLinks.find(l => l.accountId === this.id);
            if (matchedLink) {
              matchedLink.status = 'connected';
              matchedLink.connectedAt = Date.now();
              matchedLink.linkedPhone = this.phone;
              matchedLink.linkedPushName = this.pushName;
              this.manager.savePairingLinks();
              this.manager.emit('pairing_link_completed', {
                link: matchedLink,
                account: {
                  id: this.id,
                  name: this.name,
                  phone: this.phone,
                  pushName: this.pushName
                }
              });
            }
          }

          this.manager.emitSessionStatus(this);

          // Resync contacts
          setTimeout(async () => {
            try {
              if (this.sock && typeof this.sock.resyncAppState === 'function') {
                console.log(`[WA:${this.name}] Sinkronisasi kontak & obrolan...`);
                await this.sock.resyncAppState(['regular', 'critical_unblock_low'], true);
              }
            } catch (syncErr) {
              console.warn(`[WA:${this.name}] Resync kontak info:`, syncErr.message);
            }
          }, 2000);
        }
      });

      // Call Tracker
      sock.ev.on('call', async (callEvents) => {
        if (Array.isArray(callEvents)) {
          for (const c of callEvents) {
            this.manager.handleCallEvent(c, this);
          }
        }
      });

      // History Set
      sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
        console.log(`[WA:${this.name}] Riwayat WhatsApp disinkronkan (${chats?.length || 0} chat, ${contacts?.length || 0} kontak).`);

        if (contacts) {
          for (const c of contacts) {
            this.manager.addOrUpdateContact(c, false);
          }
          this.manager.saveContacts();
        }

        if (chats) {
          for (const c of chats) {
            if (c.id && !isIgnoredJid(c.id)) {
              const chat = this.manager.getOrCreateChat(this.id, c.id, c.name);
              if (chat && c.unreadCount) chat.unread = c.unreadCount;
            }
          }
        }

        if (messages) {
          for (const m of messages) {
            if (m.messageStubType === WAMessageStubType.CALL_MISSED_VOICE ||
                m.messageStubType === WAMessageStubType.CALL_MISSED_VIDEO ||
                m.messageStubType === WAMessageStubType.CALL_MISSED_GROUP_VOICE ||
                m.messageStubType === WAMessageStubType.CALL_MISSED_GROUP_VIDEO) {
              const isVideo = m.messageStubType === WAMessageStubType.CALL_MISSED_VIDEO ||
                              m.messageStubType === WAMessageStubType.CALL_MISSED_GROUP_VIDEO;
              const isGroup = m.messageStubType === WAMessageStubType.CALL_MISSED_GROUP_VOICE ||
                              m.messageStubType === WAMessageStubType.CALL_MISSED_GROUP_VIDEO;
              this.manager.recordMissedCallStub(m, isVideo, isGroup, this);
            }

            if (!m.message) continue;
            const jid = m.key.remoteJid;
            if (!jid || isIgnoredJid(jid)) continue;

            const text = extractText(m);
            if (!text.trim()) continue;

            const fromMe = Boolean(m.key.fromMe);
            const timeStr = new Date(Number(m.messageTimestamp || Date.now() / 1000) * 1000)
              .toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
            const isGroup = isJidGroup(jid) || jid.endsWith('@g.us');
            const senderInfo = this.manager.extractSenderInfo(m, jid, isGroup);

            const chat = this.manager.getOrCreateChat(this.id, jid, isGroup ? '' : m.pushName);
            if (chat && !chat.messages.some(existing => existing.id === m.key.id)) {
              chat.messages.push({
                id: m.key.id,
                text,
                time: timeStr,
                timestamp: Number(m.messageTimestamp || Date.now() / 1000),
                fromMe,
                sender: fromMe ? this.name : senderInfo.name,
                senderJid: senderInfo.jid,
                senderPhone: senderInfo.phone,
                accountId: this.id,
                media: null
              });
              chat.lastMessage = text;
              chat.lastTime = timeStr;
            }
          }
        }

        this.manager.consolidateChats();
        this.manager.saveDb();
        this.manager.emit('chats_synced', this.manager.getAllChats());
      });

      // Chats Upsert
      sock.ev.on('chats.upsert', (newChats) => {
        for (const c of newChats) {
          if (c.id && !isIgnoredJid(c.id)) {
            this.manager.getOrCreateChat(this.id, c.id, c.name);
          }
        }
        this.manager.consolidateChats();
        this.manager.saveDb();
        this.manager.emit('chats_synced', this.manager.getAllChats());
      });

      // Chats Update
      sock.ev.on('chats.update', (updatedChats) => {
        for (const c of updatedChats) {
          if (c.id && !isIgnoredJid(c.id)) {
            const chatKey = `${this.id}:${c.id}`;
            const chat = this.manager.chats.get(chatKey) || this.manager.chats.get(c.id);
            if (chat) {
              if (c.name && isValidContactName(c.name)) chat.name = c.name;
              if (c.unreadCount !== undefined) chat.unread = c.unreadCount;
            }
          }
        }
        this.manager.consolidateChats();
        this.manager.saveDb();
        this.manager.emit('chats_synced', this.manager.getAllChats());
      });

      // Contacts Upsert
      sock.ev.on('contacts.upsert', (newContacts) => {
        for (const c of newContacts) {
          this.manager.addOrUpdateContact(c, false);
        }
        this.manager.saveContacts();
        this.manager.consolidateChats();
        this.manager.saveDb();
        this.manager.emit('chats_synced', this.manager.getAllChats());
      });

      // Contacts Update
      sock.ev.on('contacts.update', (updatedContacts) => {
        for (const c of updatedContacts) {
          this.manager.addOrUpdateContact(c, false);
        }
        this.manager.saveContacts();
        this.manager.consolidateChats();
        this.manager.saveDb();
        this.manager.emit('chats_synced', this.manager.getAllChats());
      });

      // LID Mapping Update
      sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
        if (lid && pn) {
          const cleanLid = cleanDigits(lid);
          const cleanPn = cleanDigits(pn);
          this.manager.lidMap.set(cleanLid, cleanPn);
          this.manager.pnMap.set(cleanPn, cleanLid);
          this.manager.consolidateChats();
          this.manager.saveDb();
          this.manager.emit('chats_synced', this.manager.getAllChats());
        }
      });

      // Messages Upsert
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const m of messages) {
          if (m.messageStubType === WAMessageStubType.CALL_MISSED_VOICE ||
              m.messageStubType === WAMessageStubType.CALL_MISSED_VIDEO ||
              m.messageStubType === WAMessageStubType.CALL_MISSED_GROUP_VOICE ||
              m.messageStubType === WAMessageStubType.CALL_MISSED_GROUP_VIDEO) {
            const isVideo = m.messageStubType === WAMessageStubType.CALL_MISSED_VIDEO ||
                            m.messageStubType === WAMessageStubType.CALL_MISSED_GROUP_VIDEO;
            const isGroup = m.messageStubType === WAMessageStubType.CALL_MISSED_GROUP_VOICE ||
                            m.messageStubType === WAMessageStubType.CALL_MISSED_GROUP_VIDEO;
            this.manager.recordMissedCallStub(m, isVideo, isGroup, this);
          }

          if (!m.message) continue;
          const jid = m.key.remoteJid;
          if (!jid || isIgnoredJid(jid)) continue;

          const isGroup = isJidGroup(jid) || jid.endsWith('@g.us');
          const fromMe = Boolean(m.key.fromMe);

          if (!isGroup && m.pushName && isValidContactName(m.pushName)) {
            this.manager.addOrUpdateContact({ id: jid, notify: m.pushName }, false);
          }

          const senderInfo = this.manager.extractSenderInfo(m, jid, isGroup);
          const timeStr = new Date(Number(m.messageTimestamp || Date.now() / 1000) * 1000)
            .toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

          const chat = this.manager.getOrCreateChat(this.id, jid, isGroup ? '' : m.pushName);
          if (!chat) continue;

          if (chat.messages.some(existing => existing.id === m.key.id)) {
            continue;
          }

          let mediaInfo = null;
          try {
            mediaInfo = await saveMediaMessage(m);
          } catch (mediaErr) {
            console.warn(`[WA:${this.name}] Gagal unduh media:`, mediaErr.message);
          }

          const text = extractText(m);
          if (!text && !mediaInfo) continue;

          const msgObj = {
            id: m.key.id,
            text: text,
            time: timeStr,
            timestamp: Number(m.messageTimestamp || Date.now() / 1000),
            fromMe: fromMe,
            sender: fromMe ? this.name : senderInfo.name,
            senderJid: senderInfo.jid,
            senderPhone: senderInfo.phone,
            accountId: this.id,
            media: mediaInfo || null
          };

          chat.messages.push(msgObj);
          chat.lastMessage = text || (mediaInfo?.type === 'image' ? '📷 Foto' : '🎥 Video');
          chat.lastTime = timeStr;
          if (!fromMe) {
            chat.unread = (chat.unread || 0) + 1;
          }

          this.manager.saveDb();
          this.manager.emit('new_message', {
            accountId: this.id,
            jid,
            message: msgObj,
            chat
          });
        }
      });
    } catch (err) {
      console.error(`[WA:${this.name}] Gagal inisialisasi sesi:`, err);
      this.connectionState = 'disconnected';
      this.manager.emitSessionStatus(this);
    }
  }

  async sendManualMessage(jid, text) {
    if (!this.sock || this.connectionState !== 'open') {
      throw new Error(`WhatsApp untuk akun "${this.name}" belum terhubung. Periksa koneksi.`);
    }

    const sent = await this.sock.sendMessage(jid, { text });
    const msgId = sent?.key?.id || ('admin_' + Math.random().toString(36).substring(2, 9));

    const chat = this.manager.getOrCreateChat(this.id, jid);
    const timeStr = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const msgObj = {
      id: msgId,
      text: text,
      time: timeStr,
      timestamp: Date.now() / 1000,
      fromMe: true,
      sender: this.name,
      accountId: this.id
    };

    if (!chat.messages.some(m => m.id === msgId)) {
      chat.messages.push(msgObj);
    }
    chat.lastMessage = text;
    chat.lastTime = timeStr;
    chat.status = 'manual';
    this.manager.saveDb();

    this.manager.emit('new_message', {
      accountId: this.id,
      jid,
      message: msgObj,
      chat
    });
    this.manager.emit('chat_updated', chat);
    return msgObj;
  }

  async logout() {
    clearTimeout(this.reconnectTimer);
    try {
      if (this.sock) {
        await this.sock.logout();
      }
    } catch (err) {
      console.warn(`[WA:${this.name}] Logout error:`, err.message);
    }

    this.sock = null;
    this.connectionState = 'disconnected';
    this.userInfo = null;
    this.qrCodeDataUrl = null;

    const fullAuthDir = this.getResolvedAuthDir();
    if (fs.existsSync(fullAuthDir)) {
      try {
        fs.rmSync(fullAuthDir, { recursive: true, force: true });
      } catch (e) {
        console.warn(`[WA:${this.name}] Gagal hapus authDir:`, e.message);
      }
    }

    this.manager.emitSessionStatus(this, 'logged_out');
  }

  async waitForSocketOpen(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.sock && this.sock.ws && this.sock.ws.isOpen) {
        return true;
      }
      await new Promise(r => setTimeout(r, 300));
    }
    return Boolean(this.sock);
  }

  async requestPairingCode(phoneNumber) {
    if (!this.sock) {
      throw new Error(`Koneksi socket untuk akun ${this.name} belum siap.`);
    }
    const clean = normalizePhoneForWA(phoneNumber);
    if (!clean || clean.length < 8) {
      throw new Error('Nomor telepon tidak valid. Gunakan format internasional atau lokal (contoh: 08123456789 atau 628123456789).');
    }

    // Pastikan koneksi websocket baileys siap
    await this.waitForSocketOpen(8000);

    let code;
    try {
      code = await this.sock.requestPairingCode(clean);
    } catch (err) {
      console.warn(`[WA:${this.name}] Percobaan pairing code pertama gagal (${err.message}), mencoba ulang...`);
      await new Promise(r => setTimeout(r, 1500));
      code = await this.sock.requestPairingCode(clean);
    }

    this.pairingCode = code;
    this.manager.emit('pairing_code', {
      accountId: this.id,
      accountName: this.name,
      phone: clean,
      code
    });
    return code;
  }
}

/**
 * MultiWhatsAppService: Mengelola banyak akun WhatsApp Admin sekaligus
 */
class MultiWhatsAppService extends EventEmitter {
  constructor() {
    super();
    this.accounts = new Map(); // accountId -> WhatsAppSession
    this.accountConfigs = [];  // List from accounts.json
    this.chats = new Map();     // key -> chat object
    this.calls = [];
    this.contacts = new Map();
    this.lidMap = new Map();
    this.pnMap = new Map();
    this.authTokens = [];
    this.pairingLinks = [];

    this.loadAccountsConfig();
    this.loadAuthTokens();
    this.loadPairingLinks();
    this.loadContacts();
    this.loadDb();
    this.loadCalls();
  }

  // Backwards compatibility getters for server.js
  get connectionState() {
    for (const session of this.accounts.values()) {
      if (session.connectionState === 'open') return 'open';
    }
    for (const session of this.accounts.values()) {
      if (session.connectionState === 'connecting') return 'connecting';
    }
    return 'disconnected';
  }

  get userInfo() {
    for (const session of this.accounts.values()) {
      if (session.userInfo) return session.userInfo;
    }
    return null;
  }

  get qrCodeDataUrl() {
    for (const session of this.accounts.values()) {
      if (session.qrCodeDataUrl) return session.qrCodeDataUrl;
    }
    return null;
  }

  loadAccountsConfig() {
    try {
      if (fs.existsSync(ACCOUNTS_PATH)) {
        const raw = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf-8'));
        if (Array.isArray(raw) && raw.length > 0) {
          this.accountConfigs = raw;
        }
      }
    } catch (err) {
      console.error('[Accounts] Gagal membaca accounts.json:', err.message);
    }

    // Default migration dari single-account auth_info_baileys
    if (this.accountConfigs.length === 0) {
      let defaultPhone = '';
      let defaultPush = '';
      const credsPath = path.join(AUTH_DIR, 'creds.json');
      if (fs.existsSync(credsPath)) {
        try {
          const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
          if (creds?.me?.id) {
            const rawPhone = creds.me.id.split(':')[0];
            const clean = cleanDigits(rawPhone);
            if (clean) defaultPhone = '+' + clean;
          }
          if (creds?.me?.name) defaultPush = creds.me.name;
        } catch (e) {}
      }

      this.accountConfigs = [
        {
          id: 'acc_1',
          name: 'Admin Utama',
          authDir: 'auth_info_baileys',
          phone: defaultPhone,
          pushName: defaultPush,
          isDefault: true,
          createdAt: Date.now()
        }
      ];
      this.saveAccountsConfig();
    }
  }

  saveAccountsConfig() {
    try {
      fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(this.accountConfigs, null, 2));
    } catch (err) {
      console.error('[Accounts] Gagal menyimpan accounts.json:', err.message);
    }
  }

  updateAccountInfo(accountId, info) {
    const acc = this.accountConfigs.find(a => a.id === accountId);
    if (acc) {
      let changed = false;
      if (info.phone && acc.phone !== info.phone) {
        acc.phone = info.phone;
        changed = true;
      }
      if (info.pushName && acc.pushName !== info.pushName) {
        acc.pushName = info.pushName;
        changed = true;
      }
      if (changed) {
        this.saveAccountsConfig();
        this.emitAccountsUpdated();
      }
    }
  }

  emitAccountsUpdated() {
    this.emit('accounts_updated', this.getAllAccounts());
  }

  emitAccountQr(session) {
    this.emit('account_qr', {
      accountId: session.id,
      qr: session.qrCodeDataUrl
    });
    // Juga emit event legacy 'qr' jika ini default account
    if (session.isDefault || this.accounts.size === 1) {
      this.emit('qr', { qrDataUrl: session.qrCodeDataUrl });
    }
    this.emitAccountsUpdated();
  }

  emitSessionStatus(session, reason = null) {
    this.emit('account_status', {
      accountId: session.id,
      name: session.name,
      phone: session.phone,
      state: session.connectionState,
      user: session.userInfo,
      reason
    });

    // Legacy status broadcast untuk kompatibilitas frontend dasar
    this.emit('status', {
      state: this.connectionState,
      user: this.userInfo,
      reason
    });

    this.emitAccountsUpdated();
  }

  getAllAccounts() {
    return this.accountConfigs.map(cfg => {
      const session = this.accounts.get(cfg.id);
      return {
        id: cfg.id,
        name: cfg.name,
        phone: session?.phone || cfg.phone || '',
        pushName: session?.pushName || cfg.pushName || '',
        authDir: cfg.authDir,
        isDefault: Boolean(cfg.isDefault),
        state: session?.connectionState || 'disconnected',
        qr: session?.qrCodeDataUrl || null,
        user: session?.userInfo || null
      };
    });
  }

  async addAccount(name) {
    const cleanName = (name || '').trim() || `Admin ${this.accountConfigs.length + 1}`;
    const accountId = 'acc_' + Date.now();
    const relAuthDir = path.join('auth_sessions', accountId);

    const newCfg = {
      id: accountId,
      name: cleanName,
      authDir: relAuthDir,
      phone: '',
      pushName: '',
      isDefault: false,
      createdAt: Date.now()
    };

    this.accountConfigs.push(newCfg);
    this.saveAccountsConfig();

    const session = new WhatsAppSession(newCfg, this);
    this.accounts.set(accountId, session);
    await session.init();

    this.emitAccountsUpdated();
    return newCfg;
  }

  async deleteAccount(accountId) {
    const session = this.accounts.get(accountId);
    if (session) {
      await session.logout();
      this.accounts.delete(accountId);
    }

    const idx = this.accountConfigs.findIndex(a => a.id === accountId);
    if (idx >= 0) {
      this.accountConfigs.splice(idx, 1);
      this.saveAccountsConfig();
    }

    this.emitAccountsUpdated();
    return true;
  }

  renameAccount(accountId, newName) {
    const clean = (newName || '').trim();
    if (!clean) return false;

    const acc = this.accountConfigs.find(a => a.id === accountId);
    if (!acc) return false;

    acc.name = clean;
    this.saveAccountsConfig();

    const session = this.accounts.get(accountId);
    if (session) {
      session.name = clean;
    }

    for (const chat of this.chats.values()) {
      if (chat.accountId === accountId) {
        chat.accountName = clean;
      }
    }
    this.saveDb();

    this.emitAccountsUpdated();
    this.emit('chats_synced', this.getAllChats());
    return true;
  }

  async reconnectAccount(accountId) {
    const session = this.accounts.get(accountId);
    if (session) {
      if (session.sock) {
        try { session.sock.end(); } catch (e) {}
      }
      session.sock = null;
      await session.init();
      return true;
    }
    return false;
  }

  loadContacts() {
    this.contacts = new Map();
    this.lidMap = loadAllLidReverseMaps();
    this.pnMap = new Map();
    for (const [lid, pn] of this.lidMap.entries()) {
      this.pnMap.set(pn, lid);
    }

    try {
      if (fs.existsSync(CONTACTS_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CONTACTS_PATH, 'utf-8'));
        if (Array.isArray(raw)) {
          for (const c of raw) {
            this.addOrUpdateContact(c, false);
          }
        }
      }
    } catch (err) {
      console.error('[Contacts] Gagal memuat contacts.json:', err.message);
    }

    this.seedContactsFromDb();
  }

  saveContacts() {
    try {
      const seen = new Set();
      const list = [];
      for (const c of this.contacts.values()) {
        const key = c.pn || c.lid || c.id;
        if (!seen.has(key)) {
          seen.add(key);
          list.push(c);
        }
      }
      fs.writeFileSync(CONTACTS_PATH, JSON.stringify(list, null, 2));
    } catch (err) {
      console.error('[Contacts] Gagal menyimpan contacts.json:', err.message);
    }
  }

  seedContactsFromDb() {
    try {
      if (!fs.existsSync(DB_PATH)) return;
      const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
      if (!Array.isArray(raw)) return;

      raw.forEach(c => {
        if (isValidContactName(c.name)) {
          this.addOrUpdateContact({ id: c.jid, name: c.name }, false);
        }
        if (c.isGroup && Array.isArray(c.messages)) {
          c.messages.forEach(m => {
            if (isValidContactName(m.sender)) {
              if (m.senderJid) this.addOrUpdateContact({ id: m.senderJid, notify: m.sender }, false);
              if (m.senderPhone) {
                const pn = cleanDigits(m.senderPhone);
                if (pn) this.addOrUpdateContact({ id: `${pn}@s.whatsapp.net`, notify: m.sender }, false);
              }
            }
          });
        }
      });
      this.saveContacts();
    } catch (err) {
      console.warn('[Contacts] Peringatan saat seeding kontak dari db:', err.message);
    }
  }

  addOrUpdateContact(c, shouldConsolidate = true) {
    if (!c || !c.id || isIgnoredJid(c.id)) return;

    const id = c.id;
    let pn = c.phoneNumber ? cleanDigits(c.phoneNumber) : null;
    let lid = c.lid ? cleanDigits(c.lid) : null;

    if (id.endsWith('@s.whatsapp.net')) {
      pn = cleanDigits(id.split('@')[0]);
    } else if (id.endsWith('@lid')) {
      lid = cleanDigits(id.split('@')[0]);
    }

    if (lid && !pn && this.lidMap.has(lid)) {
      pn = this.lidMap.get(lid);
    }
    if (pn && !lid && this.pnMap.has(pn)) {
      lid = this.pnMap.get(pn);
    }

    const cleanName = isValidContactName(c.name) ? c.name.trim() : '';
    const cleanNotify = isValidContactName(c.notify) ? c.notify.trim() : '';

    const lookupKeys = [
      id,
      pn ? `${pn}@s.whatsapp.net` : null,
      lid ? `${lid}@lid` : null,
      pn,
      lid
    ].filter(Boolean);

    let existing = null;
    for (const k of lookupKeys) {
      if (this.contacts.has(k)) {
        existing = this.contacts.get(k);
        break;
      }
    }

    const entry = existing || {
      id: pn ? `${pn}@s.whatsapp.net` : id,
      pn: pn || null,
      lid: lid || null,
      name: '',
      notify: '',
      phone: pn ? formatPhoneNumber(pn) : (id.endsWith('@lid') ? '' : formatPhoneNumber(id.split('@')[0]))
    };

    if (pn && !entry.pn) entry.pn = pn;
    if (lid && !entry.lid) entry.lid = lid;
    if (cleanName && (!entry.name || cleanName.length > entry.name.length)) {
      entry.name = cleanName;
    }
    if (cleanNotify && !entry.notify) {
      entry.notify = cleanNotify;
    }
    if (!entry.phone && entry.pn) {
      entry.phone = formatPhoneNumber(entry.pn);
    }

    for (const k of lookupKeys) {
      this.contacts.set(k, entry);
    }

    if (shouldConsolidate && (cleanName || cleanNotify)) {
      this.applyContactToChats(entry);
    }
  }

  resolveContact(jid) {
    if (!jid || isIgnoredJid(jid)) {
      return { name: '', phone: '', jid: jid || '' };
    }

    let pn = null;
    let lid = null;

    if (jid.endsWith('@s.whatsapp.net')) {
      pn = cleanDigits(jid.split('@')[0]);
      if (this.pnMap.has(pn)) lid = this.pnMap.get(pn);
    } else if (jid.endsWith('@lid')) {
      lid = cleanDigits(jid.split('@')[0]);
      if (this.lidMap.has(lid)) pn = this.lidMap.get(lid);
    }

    const lookupKeys = [
      jid,
      pn ? `${pn}@s.whatsapp.net` : null,
      lid ? `${lid}@lid` : null,
      pn,
      lid
    ].filter(Boolean);

    let found = null;
    for (const k of lookupKeys) {
      if (this.contacts.has(k)) {
        found = this.contacts.get(k);
        break;
      }
    }

    let finalName = '';
    if (found) {
      if (isValidContactName(found.name)) finalName = found.name;
      else if (isValidContactName(found.notify)) finalName = found.notify;
    }

    let phoneStr = '';
    if (pn) {
      phoneStr = formatPhoneNumber(pn);
    } else if (found?.phone) {
      phoneStr = found.phone;
    } else if (!jid.endsWith('@lid')) {
      const raw = cleanDigits(jid.split('@')[0]);
      phoneStr = raw ? formatPhoneNumber(raw) : jid;
    } else {
      phoneStr = jid;
    }

    if (!finalName) {
      finalName = phoneStr;
    }

    return {
      name: finalName,
      phone: phoneStr,
      jid
    };
  }

  applyContactToChats(contactObj) {
    let updated = false;
    const lookupSet = new Set([
      contactObj.id,
      contactObj.pn ? `${contactObj.pn}@s.whatsapp.net` : null,
      contactObj.lid ? `${contactObj.lid}@lid` : null
    ].filter(Boolean));

    for (const chat of this.chats.values()) {
      if (!chat.isGroup && lookupSet.has(chat.jid)) {
        const resolved = this.resolveContact(chat.jid);
        if (resolved.name && resolved.name !== chat.name) {
          chat.name = resolved.name;
          chat.phone = resolved.phone;
          updated = true;
          this.emit('chat_updated', chat);
        }
      }
    }

    if (updated) {
      this.saveDb();
    }
  }

  findChat(keyOrJid) {
    if (!keyOrJid) return null;
    if (this.chats.has(keyOrJid)) return this.chats.get(keyOrJid);
    for (const c of this.chats.values()) {
      if (c.key === keyOrJid || c.jid === keyOrJid) {
        return c;
      }
    }
    return null;
  }

  updateChatContactName(keyOrJid, newName) {
    const chat = this.findChat(keyOrJid);
    if (!chat) return null;

    const clean = (newName || '').trim();
    if (!clean) return null;

    chat.name = clean;
    if (!chat.isGroup) {
      this.addOrUpdateContact({ id: chat.jid, name: clean }, false);
      this.saveContacts();
    }

    this.saveDb();
    this.emit('chat_updated', chat);
    return chat;
  }

  consolidateChats() {
    for (const chat of this.chats.values()) {
      if (!chat.isGroup) {
        const res = this.resolveContact(chat.jid);
        chat.phone = res.phone;
        if (isValidContactName(res.name)) {
          chat.name = res.name;
        } else if (!isValidContactName(chat.name)) {
          chat.name = res.phone;
        }

        if (Array.isArray(chat.messages)) {
          for (const m of chat.messages) {
            if (!m.fromMe) {
              m.sender = chat.name;
              m.senderPhone = chat.phone;
            }
          }
        }
      }
    }

    for (const c of this.calls) {
      const res = this.resolveContact(c.jid || c.chatId);
      if (isValidContactName(res.name)) {
        c.name = res.name;
      } else if (!isValidContactName(c.name) || c.name.includes('∙')) {
        c.name = res.phone;
      }
      if (res.phone) {
        c.phone = res.phone;
      }
    }
  }

  loadDb() {
    try {
      if (fs.existsSync(DB_PATH)) {
        const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
        if (Array.isArray(raw)) {
          raw.forEach(c => {
            if (!isIgnoredJid(c.jid)) {
              const accountId = c.accountId || 'acc_1';
              const chatKey = c.key || `${accountId}:${c.jid}`;

              c.key = chatKey;
              c.accountId = accountId;
              const acc = this.accountConfigs.find(a => a.id === accountId);
              c.accountName = c.accountName || acc?.name || 'Admin';
              c.accountPhone = c.accountPhone || acc?.phone || '';
              c.isGroup = Boolean(c.isGroup || (c.jid && (c.jid.endsWith('@g.us') || isJidGroup(c.jid))));
              c.status = 'manual';
              c.notifyEnabled = Boolean(c.notifyEnabled);

              if (Array.isArray(c.messages)) {
                c.messages.forEach(m => {
                  if (!m.accountId) m.accountId = accountId;
                });
              }

              this.chats.set(chatKey, c);
            }
          });
          this.consolidateChats();
          this.saveDb();
        }
      }
    } catch (err) {
      console.error('[DB] Gagal memuat db.json:', err.message);
    }
  }

  saveDb() {
    try {
      const data = Array.from(this.chats.values());
      fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('[DB] Gagal menyimpan db.json:', err.message);
    }
  }

  loadCalls() {
    try {
      if (fs.existsSync(CALLS_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CALLS_PATH, 'utf-8'));
        if (Array.isArray(raw)) {
          this.calls = raw;
          for (const c of this.calls) {
            const res = this.resolveContact(c.jid || c.chatId);
            if (isValidContactName(res.name)) {
              c.name = res.name;
            } else if (!isValidContactName(c.name) || c.name.includes('∙')) {
              c.name = res.phone;
            }
            if (res.phone) c.phone = res.phone;
            if (!c.accountId) c.accountId = 'acc_1';
          }
          this.saveCalls();
        }
      } else {
        this.calls = [];
      }
    } catch (err) {
      console.error('[Calls] Gagal memuat calls.json:', err.message);
      this.calls = [];
    }
  }

  saveCalls() {
    try {
      fs.writeFileSync(CALLS_PATH, JSON.stringify(this.calls, null, 2));
    } catch (err) {
      console.error('[Calls] Gagal menyimpan calls.json:', err.message);
    }
  }

  getAllCalls(filterAccountId = null) {
    if (filterAccountId && filterAccountId !== 'all') {
      return this.calls.filter(c => c.accountId === filterAccountId);
    }
    return this.calls;
  }

  deleteCall(id) {
    const idx = this.calls.findIndex(c => c.id === id);
    if (idx >= 0) {
      this.calls.splice(idx, 1);
      this.saveCalls();
      this.emit('calls_updated', this.calls);
      return true;
    }
    return false;
  }

  clearCalls() {
    this.calls = [];
    this.saveCalls();
    this.emit('calls_updated', this.calls);
    return true;
  }

  handleCallEvent(call, session) {
    const callerJid = call.from || call.chatId;
    if (!callerJid || isIgnoredJid(callerJid)) return;

    const res = this.resolveContact(callerJid);
    let statusText = 'ringing';
    if (call.status === 'timeout' || call.status === 'missed') {
      statusText = 'missed';
    } else if (call.status === 'reject') {
      statusText = 'rejected';
    } else if (call.status === 'accept') {
      statusText = 'accepted';
    } else if (call.status === 'offer') {
      statusText = 'ringing';
    } else if (call.status === 'terminate') {
      statusText = call.endedByMe ? 'rejected' : 'ended';
    }

    const timeStr = new Date(call.date ? Number(call.date) * 1000 : Date.now())
      .toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

    const existingIdx = this.calls.findIndex(c => c.id === call.id);
    if (existingIdx >= 0) {
      this.calls[existingIdx].status = statusText;
    } else {
      this.calls.unshift({
        id: call.id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        accountId: session.id,
        accountName: session.name,
        accountPhone: session.phone,
        chatId: callerJid,
        jid: callerJid,
        name: res.name || res.phone,
        phone: res.phone,
        isVideo: Boolean(call.isVideo),
        isGroup: Boolean(call.isGroup),
        status: statusText,
        time: timeStr,
        timestamp: call.date ? Number(call.date) : Date.now() / 1000
      });
    }

    if (this.calls.length > 300) {
      this.calls = this.calls.slice(0, 300);
    }

    this.saveCalls();
    this.emit('calls_updated', this.calls);
  }

  recordMissedCallStub(m, isVideo, isGroup, session) {
    const callerJid = m.key.remoteJid;
    if (!callerJid || isIgnoredJid(callerJid)) return;

    const timeStr = new Date(Number(m.messageTimestamp || Date.now() / 1000) * 1000)
      .toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const res = this.resolveContact(callerJid);

    const callId = `stub_${m.key.id}`;
    if (!this.calls.some(c => c.id === callId)) {
      this.calls.unshift({
        id: callId,
        accountId: session.id,
        accountName: session.name,
        accountPhone: session.phone,
        chatId: callerJid,
        jid: callerJid,
        name: res.name || res.phone,
        phone: res.phone,
        isVideo: Boolean(isVideo),
        isGroup: Boolean(isGroup),
        status: 'missed',
        time: timeStr,
        timestamp: Number(m.messageTimestamp || Date.now() / 1000)
      });
      if (this.calls.length > 300) {
        this.calls = this.calls.slice(0, 300);
      }
      this.saveCalls();
      this.emit('calls_updated', this.calls);
    }
  }

  extractSenderInfo(m, jid, isGroup) {
    if (!isGroup) {
      const res = this.resolveContact(jid);
      return { name: res.name, jid, phone: res.phone };
    }

    const participantJid = m.key.participant || m.participant || '';
    const res = this.resolveContact(participantJid);
    let name = '';

    if (isValidContactName(m.pushName)) {
      name = m.pushName.trim();
    } else if (isValidContactName(res.name)) {
      name = res.name;
    } else {
      name = res.phone;
    }

    return { name, jid: participantJid, phone: res.phone };
  }

  getOrCreateChat(accountId, jid, name = '') {
    if (isIgnoredJid(jid)) return null;
    const isGroup = isJidGroup(jid) || jid.endsWith('@g.us');
    const chatKey = `${accountId}:${jid}`;

    const res = this.resolveContact(jid);
    let chatName = '';
    if (isGroup) {
      chatName = name || 'Grup WhatsApp';
    } else {
      if (isValidContactName(name)) {
        chatName = name.trim();
        this.addOrUpdateContact({ id: jid, name: chatName }, false);
      } else {
        chatName = res.name;
      }
    }

    const chatPhone = isGroup ? 'Grup WhatsApp' : res.phone;
    const acc = this.accounts.get(accountId) || this.accountConfigs.find(a => a.id === accountId);
    const accountName = acc?.name || 'Admin';
    const accountPhone = acc?.phone || '';

    if (!this.chats.has(chatKey)) {
      // Check if existing chat was stored by raw jid
      let existing = null;
      if (this.chats.has(jid)) {
        existing = this.chats.get(jid);
        this.chats.delete(jid);
      }

      const chat = existing || {
        key: chatKey,
        accountId,
        accountName,
        accountPhone,
        jid,
        name: chatName,
        phone: chatPhone,
        lastMessage: '',
        lastTime: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
        unread: 0,
        status: 'manual',
        channel: 'wa',
        isGroup,
        notifyEnabled: false,
        messages: []
      };

      chat.key = chatKey;
      chat.accountId = accountId;
      chat.accountName = accountName;
      chat.accountPhone = accountPhone;
      this.chats.set(chatKey, chat);
    }

    const chat = this.chats.get(chatKey);
    if (typeof chat.notifyEnabled === 'undefined') {
      chat.notifyEnabled = false;
    }

    if (isGroup) {
      if (name && (!chat.name || chat.name === 'Grup WhatsApp')) {
        chat.name = name;
      }
    } else {
      chat.phone = chatPhone;
      if (isValidContactName(chatName)) {
        chat.name = chatName;
      } else if (!isValidContactName(chat.name)) {
        chat.name = res.name;
      }
    }

    chat.isGroup = isGroup;
    return chat;
  }

  setNotificationPermission(keyOrJid, enabled) {
    const chat = this.findChat(keyOrJid);
    if (chat) {
      chat.notifyEnabled = Boolean(enabled);
      this.saveDb();
      this.emit('chat_updated', chat);
      return chat;
    }
    return null;
  }

  getAllChats(filterAccountId = null) {
    let list = Array.from(this.chats.values());
    if (filterAccountId && filterAccountId !== 'all') {
      list = list.filter(c => c.accountId === filterAccountId);
    }
    return list.sort((a, b) => {
      const timeB = b.messages && b.messages.length > 0 ? (b.messages[b.messages.length - 1]?.timestamp || 0) : 0;
      const timeA = a.messages && a.messages.length > 0 ? (a.messages[a.messages.length - 1]?.timestamp || 0) : 0;
      return timeB - timeA;
    });
  }

  deleteChat(keyOrJid) {
    const chat = this.findChat(keyOrJid);
    if (chat) {
      this.chats.delete(chat.key);
      if (this.chats.has(chat.jid)) this.chats.delete(chat.jid);
      this.saveDb();
      this.emit('chats_synced', this.getAllChats());
      return true;
    }
    return false;
  }

  async sendManualMessage(jid, text, accountId = null) {
    let targetSession = null;

    if (accountId) {
      targetSession = this.accounts.get(accountId);
    }

    if (!targetSession) {
      // Cari dari chat jika jid cocok
      for (const chat of this.chats.values()) {
        if (chat.jid === jid && chat.accountId) {
          const s = this.accounts.get(chat.accountId);
          if (s && s.connectionState === 'open') {
            targetSession = s;
            break;
          }
        }
      }
    }

    if (!targetSession) {
      // Gunakan default atau sesi pertama yang 'open'
      for (const s of this.accounts.values()) {
        if (s.connectionState === 'open') {
          targetSession = s;
          break;
        }
      }
    }

    if (!targetSession) {
      throw new Error('Tidak ada akun WhatsApp admin yang sedang terhubung.');
    }

    return await targetSession.sendManualMessage(jid, text);
  }

  async logout(accountId = null) {
    if (accountId) {
      const session = this.accounts.get(accountId);
      if (session) {
        await session.logout();
      }
    } else {
      // Logout semua
      for (const session of this.accounts.values()) {
        await session.logout();
      }
    }
    this.emitAccountsUpdated();
  }

  // ==================== PENAUTAN MELALUI LINK (AUTH TOKENS) ====================
  loadAuthTokens() {
    try {
      if (fs.existsSync(TOKENS_PATH)) {
        const raw = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'));
        if (Array.isArray(raw)) {
          this.authTokens = raw;
          return;
        }
      }
    } catch (err) {
      console.error('[Tokens] Gagal memuat auth_tokens.json:', err.message);
    }
    this.authTokens = [];
  }

  saveAuthTokens() {
    try {
      fs.writeFileSync(TOKENS_PATH, JSON.stringify(this.authTokens, null, 2));
    } catch (err) {
      console.error('[Tokens] Gagal menyimpan auth_tokens.json:', err.message);
    }
  }

  createAuthLink({ deviceName, expiresHours = null }) {
    const cleanName = (deviceName || '').trim() || 'Perangkat Admin';
    const token = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    const expiresAt = expiresHours ? (now + (Number(expiresHours) * 3600 * 1000)) : null;

    const tokenObj = {
      id: 'tok_' + now + '_' + Math.random().toString(36).substring(2, 7),
      token,
      deviceName: cleanName,
      createdAt: now,
      expiresAt,
      lastAccessedAt: null,
      accessCount: 0,
      status: 'active'
    };

    this.authTokens.unshift(tokenObj);
    this.saveAuthTokens();
    this.emit('tokens_updated', this.getAllAuthTokens());
    return tokenObj;
  }

  verifyAuthToken(token) {
    if (!token) return null;
    const cleanToken = String(token).trim();
    const tokenObj = this.authTokens.find(t => t.token === cleanToken && t.status === 'active');
    if (!tokenObj) return null;

    if (tokenObj.expiresAt && Date.now() > tokenObj.expiresAt) {
      tokenObj.status = 'expired';
      this.saveAuthTokens();
      return null;
    }

    tokenObj.lastAccessedAt = Date.now();
    tokenObj.accessCount = (tokenObj.accessCount || 0) + 1;
    this.saveAuthTokens();
    return tokenObj;
  }

  revokeAuthToken(tokenIdOrToken) {
    const idx = this.authTokens.findIndex(t => t.id === tokenIdOrToken || t.token === tokenIdOrToken);
    if (idx >= 0) {
      this.authTokens.splice(idx, 1);
      this.saveAuthTokens();
      this.emit('tokens_updated', this.getAllAuthTokens());
      return true;
    }
    return false;
  }

  getAllAuthTokens() {
    const now = Date.now();
    return this.authTokens.map(t => ({
      id: t.id,
      token: t.token,
      deviceName: t.deviceName,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
      lastAccessedAt: t.lastAccessedAt,
      accessCount: t.accessCount || 0,
      isExpired: Boolean(t.expiresAt && now > t.expiresAt),
      status: (t.expiresAt && now > t.expiresAt) ? 'expired' : t.status
    }));
  }

  async requestPairingCode(accountId, phoneNumber) {
    const session = this.accounts.get(accountId);
    if (!session) {
      throw new Error('Akun admin WhatsApp tidak ditemukan.');
    }
    return await session.requestPairingCode(phoneNumber);
  }

  // ==================== TAUTAN PENAUTAN WHATSAPP (PAIRING LINKS) ====================
  loadPairingLinks() {
    try {
      if (fs.existsSync(PAIRING_LINKS_PATH)) {
        const raw = JSON.parse(fs.readFileSync(PAIRING_LINKS_PATH, 'utf-8'));
        if (Array.isArray(raw)) {
          this.pairingLinks = raw;
        }
      }
    } catch (err) {
      console.error('[WA] Gagal memuat wa_pairing_links.json:', err.message);
      this.pairingLinks = [];
    }
  }

  savePairingLinks() {
    try {
      fs.writeFileSync(PAIRING_LINKS_PATH, JSON.stringify(this.pairingLinks, null, 2), 'utf-8');
    } catch (err) {
      console.error('[WA] Gagal menyimpan wa_pairing_links.json:', err.message);
    }
  }

  createPairingLink({ accountName, targetPhone, expiresHours }) {
    const cleanName = (accountName || '').trim() || `Admin CS ${this.accountConfigs.length + 1}`;
    const cleanPhone = normalizePhoneForWA(targetPhone || '');
    const id = 'link_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const token = crypto.randomBytes(12).toString('hex');
    const expHours = expiresHours ? parseInt(expiresHours, 10) : 168; // default 7 hari

    const linkObj = {
      id,
      token,
      accountName: cleanName,
      targetPhone: cleanPhone,
      accountId: null,
      status: 'pending', // 'pending' | 'pairing' | 'connected' | 'expired'
      createdAt: Date.now(),
      expiresAt: expHours > 0 ? Date.now() + expHours * 3600000 : null,
      connectedAt: null,
      linkedPhone: null,
      linkedPushName: null,
      pairingCode: null
    };

    this.pairingLinks.unshift(linkObj);
    this.savePairingLinks();
    this.emit('pairing_links_updated', this.getAllPairingLinks());
    return linkObj;
  }

  getPairingLinkByToken(token) {
    if (!token) return null;
    const link = this.pairingLinks.find(l => l.token === token || l.id === token);
    if (!link) return null;
    if (link.expiresAt && Date.now() > link.expiresAt && link.status !== 'connected') {
      link.status = 'expired';
      this.savePairingLinks();
    }
    return link;
  }

  getAllPairingLinks() {
    const now = Date.now();
    return this.pairingLinks.map(l => {
      // Sinkronkan dengan sesi aktif jika ada
      if (l.accountId && l.status !== 'connected') {
        const session = this.accounts.get(l.accountId);
        if (session && session.connectionState === 'open') {
          l.status = 'connected';
          l.connectedAt = l.connectedAt || Date.now();
          l.linkedPhone = session.phone;
          l.linkedPushName = session.pushName;
        }
      }
      const isExpired = Boolean(l.expiresAt && now > l.expiresAt && l.status !== 'connected');
      return {
        ...l,
        isExpired,
        displayStatus: isExpired ? 'expired' : l.status
      };
    });
  }

  async deletePairingLink(id) {
    const idx = this.pairingLinks.findIndex(l => l.id === id || l.token === id);
    if (idx >= 0) {
      const link = this.pairingLinks[idx];
      // Jika akun masih pairing (belum pernah terhubung), bersihkan sesi sementara
      if (link.accountId && link.status !== 'connected') {
        try {
          await this.deleteAccount(link.accountId);
        } catch (e) {
          console.warn('[WA] Gagal membersihkan sesi akun sementara saat link dihapus:', e.message);
        }
      }
      this.pairingLinks.splice(idx, 1);
      this.savePairingLinks();
      this.emit('pairing_links_updated', this.getAllPairingLinks());
      return true;
    }
    return false;
  }

  async startPairingForLink(token, phone) {
    const link = this.getPairingLinkByToken(token);
    if (!link) {
      throw new Error('Tautan penautan tidak ditemukan atau sudah kedaluwarsa.');
    }
    if (link.status === 'expired') {
      throw new Error('Tautan penautan ini sudah kedaluwarsa.');
    }

    // Jika sudah terhubung, langsung kembalikan status terhubung
    if (link.status === 'connected' && link.accountId) {
      const session = this.accounts.get(link.accountId);
      if (session && session.connectionState === 'open') {
        return {
          ok: true,
          status: 'connected',
          accountId: link.accountId,
          accountName: link.accountName,
          phone: session.phone || link.linkedPhone,
          pushName: session.pushName || link.linkedPushName
        };
      }
    }

    const cleanPhone = normalizePhoneForWA(phone || link.targetPhone);
    if (!cleanPhone || cleanPhone.length < 8) {
      throw new Error('Nomor WhatsApp tidak valid. Masukkan nomor dengan benar (contoh: 08123456789 atau 628123456789).');
    }

    let session = null;
    if (link.accountId && this.accounts.get(link.accountId)) {
      session = this.accounts.get(link.accountId);
    } else {
      // Buat akun WhatsApp admin baru khusus untuk link ini
      const newAcc = await this.addAccount(link.accountName);
      link.accountId = newAcc.id;
      session = this.accounts.get(newAcc.id);
      this.savePairingLinks();
    }

    const code = await session.requestPairingCode(cleanPhone);
    link.pairingCode = code;
    link.status = 'pairing';
    link.targetPhone = cleanPhone;
    this.savePairingLinks();

    this.emit('pairing_link_updated', link);

    const formattedCode = code ? (code.match(/.{1,4}/g)?.join('-') || code) : code;
    return {
      ok: true,
      status: 'pairing',
      code,
      formattedCode,
      qr: session.qrCodeDataUrl || null,
      accountId: session.id,
      accountName: session.name,
      phone: cleanPhone
    };
  }

  getPairingLinkStatus(token) {
    const link = this.getPairingLinkByToken(token);
    if (!link) {
      return { ok: false, error: 'Tautan tidak ditemukan' };
    }

    let session = null;
    if (link.accountId) {
      session = this.accounts.get(link.accountId);
    }

    if (session && session.connectionState === 'open') {
      if (link.status !== 'connected') {
        link.status = 'connected';
        link.connectedAt = link.connectedAt || Date.now();
        link.linkedPhone = session.phone;
        link.linkedPushName = session.pushName;
        this.savePairingLinks();
        this.emit('pairing_link_completed', {
          link,
          account: {
            id: session.id,
            name: session.name,
            phone: session.phone,
            pushName: session.pushName
          }
        });
      }
      return {
        ok: true,
        status: 'connected',
        accountId: session.id,
        accountName: session.name,
        phone: session.phone || link.linkedPhone,
        pushName: session.pushName || link.linkedPushName
      };
    }

    return {
      ok: true,
      status: link.status,
      accountId: link.accountId,
      accountName: link.accountName,
      targetPhone: link.targetPhone,
      pairingCode: link.pairingCode,
      formattedCode: link.pairingCode ? (link.pairingCode.match(/.{1,4}/g)?.join('-') || link.pairingCode) : null,
      qr: session?.qrCodeDataUrl || null,
      connectionState: session?.connectionState || 'disconnected'
    };
  }

  async init() {
    console.log(`[WA] Menginisialisasi ${this.accountConfigs.length} akun WhatsApp Admin...`);
    for (const cfg of this.accountConfigs) {
      const session = new WhatsAppSession(cfg, this);
      this.accounts.set(cfg.id, session);
      session.init().catch(err => {
        console.error(`[WA] Gagal inisialisasi akun ${cfg.name}:`, err.message);
      });
    }
  }
}

module.exports = new MultiWhatsAppService();
