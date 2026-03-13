require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const bcrypt = require('bcryptjs');
const { getDb } = require('./database');

let bot = null;

const ADMIN_KEY = process.env.ADMIN_KEY || '1727';
const USER_KEY = process.env.USER_KEY || '7979';
const MAX_ATTEMPTS = 3;
const LOCKOUT_MINUTES = 10;

// Pending auth state per chat
const pendingAuth = {};

function getBot() {
  return bot;
}

function startBot() {
  if (!process.env.TELEGRAM_TOKEN) {
    console.log('⚠️  TELEGRAM_TOKEN ayarlanmamış, bot başlatılmadı.');
    return;
  }

  bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
  console.log('🤖 Telegram botu başlatıldı.');

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const db = getDb();

    // Check if already authenticated
    const tgAuth = db.prepare(`SELECT * FROM telegram_auth WHERE chat_id = ?`).get(String(chatId));
    if (tgAuth?.user_id) {
      const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(tgAuth.user_id);
      if (user) {
        return sendMainMenu(chatId, user);
      }
    }

    pendingAuth[chatId] = { step: 'awaiting_key' };

    await bot.sendMessage(chatId,
      `🌙 *Kolektif Zihin Yapısı*\n\n` +
      `Merhaba! Bu bot, site bildirimlerinizi iletmek için tasarlandı.\n\n` +
      `Devam etmek için lütfen anahtarını gir:`,
      {
        parse_mode: 'Markdown',
        reply_markup: { remove_keyboard: true }
      }
    );
  });

  bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    const db = getDb();
    const tgAuth = db.prepare(`SELECT * FROM telegram_auth WHERE chat_id = ?`).get(String(chatId));
    if (!tgAuth?.user_id) return bot.sendMessage(chatId, '❌ Önce giriş yapman gerekiyor. /start');
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(tgAuth.user_id);
    if (user?.role !== 'admin') return bot.sendMessage(chatId, '❌ Admin yetkisi gerekli.');

    await bot.sendMessage(chatId,
      `⚙️ *Admin Paneli*\n\n` +
      `Kullanılabilir komutlar:\n` +
      `/users - Kullanıcı listesi\n` +
      `/stats - Site istatistikleri\n` +
      `/setbadge [kullanıcı] [rozet] - Rozet ata\n` +
      `/notify [mesaj] - Tüm kullanıcılara mesaj gönder`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/\/users/, async (msg) => {
    const chatId = msg.chat.id;
    const db = getDb();
    const tgAuth = db.prepare(`SELECT * FROM telegram_auth WHERE chat_id = ?`).get(String(chatId));
    if (!tgAuth?.user_id) return;
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(tgAuth.user_id);
    if (user?.role !== 'admin') return;

    const users = db.prepare(`SELECT id, nick, username, role, badge FROM users`).all();
    const text = users.map(u =>
      `👤 *${u.nick || u.username}* (${u.role})${u.badge ? `\n   🏷️ ${u.badge}` : ''}`
    ).join('\n\n');

    await bot.sendMessage(chatId, `👥 *Kullanıcılar*\n\n${text}`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const db = getDb();
    const tgAuth = db.prepare(`SELECT * FROM telegram_auth WHERE chat_id = ?`).get(String(chatId));
    if (!tgAuth?.user_id) return;

    const postCount = db.prepare(`SELECT COUNT(*) as c FROM posts`).get().c;
    const letterCount = db.prepare(`SELECT COUNT(*) as c FROM letters`).get().c;
    const commentCount = db.prepare(`SELECT COUNT(*) as c FROM post_comments`).get().c;

    await bot.sendMessage(chatId,
      `📊 *Site İstatistikleri*\n\n` +
      `📸 Gönderi: ${postCount}\n` +
      `✉️ Mektup: ${letterCount}\n` +
      `💬 Yorum: ${commentCount}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/\/logout/, async (msg) => {
    const chatId = msg.chat.id;
    const db = getDb();
    db.prepare(`DELETE FROM telegram_auth WHERE chat_id = ?`).run(String(chatId));
    delete pendingAuth[chatId];
    await bot.sendMessage(chatId, '👋 Çıkış yapıldı. Tekrar giriş için /start');
  });

  bot.onText(/\/menu/, async (msg) => {
    const chatId = msg.chat.id;
    const db = getDb();
    const tgAuth = db.prepare(`SELECT * FROM telegram_auth WHERE chat_id = ?`).get(String(chatId));
    if (!tgAuth?.user_id) return bot.sendMessage(chatId, 'Giriş yap önce: /start');
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(tgAuth.user_id);
    if (user) sendMainMenu(chatId, user);
  });

  // Handle callback queries (inline buttons)
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const db = getDb();
    const tgAuth = db.prepare(`SELECT * FROM telegram_auth WHERE chat_id = ?`).get(String(chatId));
    if (!tgAuth?.user_id) return;
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(tgAuth.user_id);

    bot.answerCallbackQuery(query.id);

    if (data === 'menu_letters') {
      const letters = db.prepare(`
        SELECT l.*, u.nick as sender_nick FROM letters l
        JOIN users u ON l.sender_id = u.id
        WHERE l.receiver_id = ? AND l.status IN ('delivered', 'read')
        ORDER BY l.delivered_at DESC LIMIT 5
      `).all(user.id);

      if (letters.length === 0) {
        return bot.sendMessage(chatId, '📭 Teslim edilmiş mektup yok.');
      }

      const siteUrl = db.prepare(`SELECT value FROM site_settings WHERE key = 'site_url'`).get()?.value || '';
      const text = letters.map(l =>
        `✉️ *${l.sender_nick}* → ${l.status === 'read' ? '✅ Okundu' : '📬 Okunmadı'}\n` +
        `📅 ${new Date(l.sent_at).toLocaleDateString('tr-TR')}\n` +
        `🔗 ${siteUrl}/letters.html`
      ).join('\n\n');

      bot.sendMessage(chatId, `📬 *Mektuplarınız*\n\n${text}`, { parse_mode: 'Markdown' });

    } else if (data === 'menu_site') {
      const siteUrl = db.prepare(`SELECT value FROM site_settings WHERE key = 'site_url'`).get()?.value || 'Ayarlanmamış';
      bot.sendMessage(chatId,
        `🌐 *Site Bilgileri*\n\n` +
        `📌 Adres: ${siteUrl}\n` +
        `🤖 Bot: Aktif ✅\n\n` +
        `Siteye girmek için adrese tıkla.`,
        { parse_mode: 'Markdown' }
      );

    } else if (data === 'menu_help') {
      bot.sendMessage(chatId,
        `ℹ️ *Yardım*\n\n` +
        `Bu bot, Kolektif Zihin Yapısı sitesinin bildiri sistemidir.\n\n` +
        `*Özellikler:*\n` +
        `• Yeni mektup bildirimler\n` +
        `• Mektup teslim bildirimleri\n` +
        `• Mektup okundu bildirimleri\n\n` +
        `*Komutlar:*\n` +
        `/start - Başlat / Giriş yap\n` +
        `/menu - Ana menü\n` +
        `/logout - Çıkış yap\n` +
        `/admin - Admin paneli (sadece admin)`,
        { parse_mode: 'Markdown' }
      );
    } else if (data === 'menu_admin' && user?.role === 'admin') {
      bot.sendMessage(chatId,
        `⚙️ *Admin Komutları:*\n/users /stats /notify`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  // Handle messages (key entry and general)
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text || text.startsWith('/')) return;

    const state = pendingAuth[chatId];
    if (state?.step === 'awaiting_key') {
      await handleKeyInput(chatId, text.trim());
      return;
    }
  });

  bot.on('polling_error', (err) => {
    console.error('Bot polling hatası:', err.message);
  });
}

async function handleKeyInput(chatId, key) {
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM telegram_auth WHERE chat_id = ?`).get(String(chatId));

  // Check lockout
  if (existing?.locked_until) {
    const lockedUntil = new Date(existing.locked_until);
    if (new Date() < lockedUntil) {
      const rem = Math.ceil((lockedUntil - new Date()) / 1000);
      const mins = Math.ceil(rem / 60);
      return bot.sendMessage(chatId, `🔒 Çok fazla hatalı deneme. ${mins} dakika bekleyin.`);
    } else {
      db.prepare(`UPDATE telegram_auth SET attempts = 0, locked_until = NULL WHERE chat_id = ?`).run(String(chatId));
    }
  }

  // Try keys
  let matchedUser = null;
  if (key === ADMIN_KEY) {
    matchedUser = db.prepare(`SELECT * FROM users WHERE role = 'admin'`).get();
  } else if (key === USER_KEY) {
    matchedUser = db.prepare(`SELECT * FROM users WHERE role = 'user'`).get();
  } else {
    // Try bcrypt
    const users = db.prepare(`SELECT * FROM users`).all();
    for (const u of users) {
      if (bcrypt.compareSync(key, u.key_hash)) { matchedUser = u; break; }
    }
  }

  if (matchedUser) {
    // Save auth
    db.prepare(`INSERT OR REPLACE INTO telegram_auth (chat_id, user_id, attempts, locked_until) VALUES (?, ?, 0, NULL)`)
      .run(String(chatId), matchedUser.id);
    db.prepare(`UPDATE users SET telegram_chat_id = ? WHERE id = ?`).run(String(chatId), matchedUser.id);
    delete pendingAuth[chatId];
    return sendMainMenu(chatId, matchedUser);
  }

  // Wrong key
  const attempts = (existing?.attempts || 0) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    const lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString();
    db.prepare(`INSERT OR REPLACE INTO telegram_auth (chat_id, user_id, attempts, locked_until) VALUES (?, NULL, ?, ?)`)
      .run(String(chatId), attempts, lockUntil);
    return bot.sendMessage(chatId, `🔒 Çok fazla hatalı deneme! ${LOCKOUT_MINUTES} dakika sonra tekrar dene.`);
  } else {
    db.prepare(`INSERT OR REPLACE INTO telegram_auth (chat_id, user_id, attempts, locked_until) VALUES (?, NULL, ?, NULL)`)
      .run(String(chatId), attempts);
    const rem = MAX_ATTEMPTS - attempts;
    return bot.sendMessage(chatId, `❌ Yanlış anahtar. ${rem} deneme hakkın kaldı.`);
  }
}

async function sendMainMenu(chatId, user) {
  if (!bot) return;
  const siteUrl = getDb().prepare(`SELECT value FROM site_settings WHERE key = 'site_url'`).get()?.value || '';

  const keyboard = [
    [
      { text: '📬 Mektuplarım', callback_data: 'menu_letters' },
      { text: '🌐 Site', callback_data: 'menu_site' }
    ],
    [
      { text: 'ℹ️ Yardım', callback_data: 'menu_help' },
      ...(user.role === 'admin' ? [{ text: '⚙️ Admin', callback_data: 'menu_admin' }] : [])
    ]
  ];

  await bot.sendMessage(chatId,
    `✅ Giriş başarılı!\n\n` +
    `👤 *${user.nick || user.username}*${user.role === 'admin' ? ' ⭐ Admin' : ''}\n\n` +
    `Bildirimler aktif. Yeni mektup geldiğinde seni haberdar edeceğim.\n\n` +
    `🔔 Bildirimleri açık tutmayı unutma!`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

// Notification functions called from routes

async function notifyNewLetter(letter, sender, receiver) {
  if (!bot) return;
  const db = getDb();
  const siteUrl = db.prepare(`SELECT value FROM site_settings WHERE key = 'site_url'`).get()?.value || '';

  if (receiver.telegram_chat_id) {
    await bot.sendMessage(receiver.telegram_chat_id,
      `📮 *Yeni bir mektubunuz yola çıktı!*\n\n` +
      `✉️ *${sender.nick || sender.username}* size yazdı.\n` +
      `⏳ 2-3 saat içinde teslim edilecek.\n\n` +
      `Kargo takibi için siteyi ziyaret edin:\n${siteUrl}/letters.html`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
}

async function notifyLetterRead(letterId) {
  if (!bot) return;
  const db = getDb();
  const letter = db.prepare(`
    SELECT l.*, s.telegram_chat_id as sender_tg, s.nick as sender_nick,
      r.nick as receiver_nick
    FROM letters l
    JOIN users s ON l.sender_id = s.id
    JOIN users r ON l.receiver_id = r.id
    WHERE l.id = ?
  `).get(letterId);

  if (letter?.sender_tg) {
    await bot.sendMessage(letter.sender_tg,
      `👁️ *Mektubunuz okundu!*\n\n` +
      `✉️ *${letter.receiver_nick}* mektubunu okudu.\n` +
      `📅 ${new Date().toLocaleString('tr-TR')}`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
}

async function notifyLetterDelivered(letter) {
  if (!bot || !letter.receiver_tg) return;
  const db = getDb();
  const siteUrl = db.prepare(`SELECT value FROM site_settings WHERE key = 'site_url'`).get()?.value || '';

  await bot.sendMessage(letter.receiver_tg,
    `📫 *Mektubunuz teslim edildi!*\n\n` +
    `✉️ *${letter.sender_nick}* size yazdı ve mektup ulaştı!\n\n` +
    `Okumak için:\n${siteUrl}/letters.html`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

module.exports = {
  startBot,
  getBot,
  notifyNewLetter,
  notifyLetterRead,
  notifyLetterDelivered
};
