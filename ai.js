const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, 'settings.json');

function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('Error reading settings:', err);
  }
  return {
    aiEnabled: true,
    aiName: 'Kuma',
    systemPrompt: 'Kamu adalah Kuma, asisten AI pribadi yang ramah, sopan, dan cerdas di WhatsApp.',
    provider: 'ollama',
    ollamaModel: 'qwen2.5-coder:3b',
    cloudApiUrl: 'https://api.groq.com/openai/v1/chat/completions',
    cloudApiKey: '',
    cloudModel: 'llama-3.3-70b-versatile',
    autoReplyMode: 'all',
    replyDelaySeconds: 2,
    handoffKeywords: ['komplain', 'refund', 'bicara dengan admin', 'hubungi pemilik', 'owner', 'manusia']
  };
}

function saveSettings(newSettings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(newSettings, null, 2));
    return true;
  } catch (err) {
    console.error('Error saving settings:', err);
    return false;
  }
}

/**
 * Memeriksa apakah pesan memicu handoff ke manusia
 */
function checkHandoffTrigger(text, settings) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const keywords = settings.handoffKeywords || [];
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

/**
 * Built-in Smart Fallback Assistant
 */
function generateBuiltinReply(userMessage, contactName, settings) {
  const msg = (userMessage || '').toLowerCase();
  const aiName = settings.aiName || 'Kuma';

  if (msg.includes('halo') || msg.includes('hai') || msg.includes('assalamu') || msg.includes('pagi') || msg.includes('siang') || msg.includes('sore') || msg.includes('malam')) {
    return `Halo kak ${contactName || ''}! Saya ${aiName}, asisten AI pribadi. Ada yang bisa saya bantu hari ini? 😊`;
  }
  if (msg.includes('siapa kamu') || msg.includes('siapa ini') || msg.includes('kamu siapa')) {
    return `Saya ${aiName}, asisten AI otomatis di nomor WhatsApp ini. Saya siap membantu menjawab pertanyaan Anda atau meneruskannya ke pemilik jika diperlukan.`;
  }
  if (msg.includes('terima kasih') || msg.includes('makasih') || msg.includes('thanks')) {
    return `Sama-sama kak! Senang bisa membantu. Jika ada pertanyaan lain, silakan tanyakan ya! ✨`;
  }
  if (msg.includes('harga') || msg.includes('biaya') || msg.includes('produk') || msg.includes('layanan')) {
    return `Terima kasih atas pertanyaannya! Informasi lengkap sedang disiapkan oleh tim kami, pesan Anda sudah tercatat ya.`;
  }
  return `Halo kak! Pesan Anda sudah saya terima: "${userMessage}". Saya ${aiName}, asisten AI pribadi di sini. Ada yang perlu saya bantu lebih lanjut?`;
}

/**
 * Panggil Ollama Local API
 */
async function callOllama(messages, settings) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);

  try {
    const model = settings.ollamaModel || 'qwen2.5-coder:3b';
    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        messages: messages,
        stream: false,
        options: {
          num_predict: 160,
          temperature: 0.7
        }
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);
    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return data.message?.content?.trim();
  } catch (err) {
    clearTimeout(timeout);
    console.error('[AI] Ollama error:', err.message);
    throw err;
  }
}

/**
 * Panggil Cloud OpenAI/Groq Compatible API
 */
async function callCloudApi(messages, settings) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const url = settings.cloudApiUrl || 'https://api.groq.com/openai/v1/chat/completions';
    const apiKey = settings.cloudApiKey;
    const model = settings.cloudModel || 'llama-3.3-70b-versatile';

    if (!apiKey) {
      throw new Error('Cloud API Key belum diisi di Pengaturan Persona AI.');
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        max_tokens: 250,
        temperature: 0.7
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);
    if (!res.ok) {
      throw new Error(`Cloud API HTTP ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim();
  } catch (err) {
    clearTimeout(timeout);
    console.error('[AI] Cloud API error:', err.message);
    throw err;
  }
}

/**
 * Generate AI reply untuk pesan masuk WhatsApp
 */
async function generateAIReply(userMessage, chatHistory = [], contactName = '') {
  const settings = getSettings();

  // 1. Cek pemicu handoff otomatis
  if (checkHandoffTrigger(userMessage, settings)) {
    return {
      reply: `Baik kak, topik ini telah saya catat dan langsung saya alihkan ke pemilik/tim layanan manusia. Mohon ditunggu sebentar ya! 🙏`,
      shouldHandoff: true,
      reason: 'Kata kunci refund/komplain/bantuan manusia terdeteksi'
    };
  }

  // 2. Susun format percakapan (system prompt + history + current message)
  const systemPrompt = (settings.systemPrompt || 'Kamu adalah Kuma, asisten AI pribadi yang ramah di WhatsApp.') +
    (contactName ? ` Nama lawan bicara saat ini adalah: ${contactName}.` : '') +
    ' Jawablah secara singkat, jelas, ramah, dan hindari penjelasan bertele-tele.';

  const messages = [
    { role: 'system', content: systemPrompt }
  ];

  // Ambil maksimal 6 pesan terakhir untuk efisiensi
  const recentHistory = chatHistory.slice(-6);
  for (const h of recentHistory) {
    messages.push({
      role: h.fromMe ? 'assistant' : 'user',
      content: h.text || ''
    });
  }

  // Tambahkan pesan terkini
  messages.push({ role: 'user', content: userMessage });

  // 3. Eksekusi sesuai provider
  let reply = '';
  try {
    if (settings.provider === 'cloud' && settings.cloudApiKey) {
      reply = await callCloudApi(messages, settings);
    } else if (settings.provider === 'ollama') {
      try {
        reply = await callOllama(messages, settings);
      } catch (ollamaErr) {
        console.warn('[AI] Ollama gagal atau belum siap, beralih ke built-in fallback.');
        reply = generateBuiltinReply(userMessage, contactName, settings);
      }
    } else {
      reply = generateBuiltinReply(userMessage, contactName, settings);
    }
  } catch (err) {
    console.error('[AI] Gagal generate balasan AI:', err.message);
    reply = generateBuiltinReply(userMessage, contactName, settings);
  }

  // Bersihkan tag thinking atau markdown berlebihan jika ada
  if (reply.includes('</think>')) {
    reply = reply.split('</think>').pop().trim();
  }

  return {
    reply: reply || `Halo kak! Pesan Anda sudah kami terima.`,
    shouldHandoff: false
  };
}

/**
 * Ringkasan AI untuk sidebar konteks
 */
function generateAISummary(messages = []) {
  if (!messages || messages.length === 0) {
    return 'Belum ada riwayat percakapan.';
  }
  const lastUserMsg = [...messages].reverse().find(m => !m.fromMe);
  if (!lastUserMsg) {
    return 'Percakapan baru dimulai oleh Anda.';
  }
  const text = lastUserMsg.text.toLowerCase();
  if (text.includes('pesan') || text.includes('kirim') || text.includes('resi') || text.includes('paket')) {
    return 'Menanyakan info status pengiriman atau nomor resi pesanan.';
  }
  if (text.includes('beli') || text.includes('harga') || text.includes('stok') || text.includes('ready')) {
    return 'Menanyakan informasi produk, ketersediaan stok, atau harga.';
  }
  if (text.includes('sobek') || text.includes('rusak') || text.includes('refund') || text.includes('ganti')) {
    return 'Melaporkan kendala barang/layanan dan meminta solusi atau pengembalian dana.';
  }
  return `Membahas seputar: "${lastUserMsg.text.slice(0, 70)}${lastUserMsg.text.length > 70 ? '...' : ''}"`;
}

module.exports = {
  getSettings,
  saveSettings,
  generateAIReply,
  generateAISummary
};
