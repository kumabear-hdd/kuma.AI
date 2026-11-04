# kuma.AI - Multi-Account WhatsApp Admin Dashboard

Dashboard administrasi WhatsApp Multi-Akun modern dan responsif berbasis **Node.js**, **Express**, **WebSocket**, dan **@whiskeysockets/baileys**.

## ✨ Fitur Utama

- 📱 **Multi-Account WhatsApp**: Hubungkan dan kelola banyak nomor WhatsApp admin dalam satu dashboard terpadu.
- 🔗 **Magic Access Link (Penautan Tanpa QR)**: Bagikan tautan akses aman langsung ke admin/CS di perangkat lain. Pengguna otomatis terotentikasi dan login ke dashboard tanpa perlu scan QR.
- 🔢 **Pairing Code**: Hubungkan nomor WhatsApp menggunakan kode pairing 8 digit tanpa perlu scan kamera QR.
- 💬 **Realtime Chat Inbox**: Kirim dan terima pesan WhatsApp secara instan dengan notifikasi suara Web Audio dan notifikasi browser.
- 📞 **Call History**: Monitoring log panggilan WhatsApp masuk dan tidak terjawab.
- 🌐 **Pilihan Target Host**: Mendukung URL otomatis, IP jaringan WiFi/LAN lokal, serta Custom Domain/Tunnel publik.

## 🚀 Cara Menjalankan Secara Lokal

1. **Clone repository**:
   ```bash
   git clone git@github.com:kumabear-hdd/kuma.AI.git
   cd kuma.AI
   ```

2. **Install dependensi**:
   ```bash
   npm install
   ```

3. **Jalankan server**:
   ```bash
   npm start
   ```
   Buka browser di `http://localhost:8080`.

## ☁️ Rekomendasi Deployment

> **Catatan Penting:** Aplikasi ini menggunakan koneksi socket TCP persisten 24/7 (Baileys) dan WebSockets realtime. **Jangan di-deploy ke Vercel (serverless)** karena koneksi akan terputus dan sesi login akan hilang.

Gunakan platform dengan proses persistent:
- **[Railway.app](https://railway.app)**: Cukup hubungkan repository GitHub, Railway akan otomatis mendeteksi Node.js dan menyediakan domain HTTPS publik.
- **[Render.com](https://render.com)**: Gunakan tipe Web Service dengan persistent disk.
- **VPS Linux (Ubuntu)**: Jalankan menggunakan PM2 (`pm2 start server.js --name kuma`).
- **Cloudflare Tunnel / Ngrok**: Jika dijalankan di PC/server lokal dan ingin diakses dari internet secara gratis.

## 📄 Lisensi
ISC License
