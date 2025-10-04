require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const PLATEGA_API_KEY = process.env.PLATEGA_API_KEY;
const PLATEGA_SHOP_ID = process.env.PLATEGA_SHOP_ID;
const PORT = process.env.PORT || 5000;

if (!BOT_TOKEN || !ADMIN_ID || !PLATEGA_API_KEY || !PLATEGA_SHOP_ID) {
  console.error('❌ Не заданы переменные окружения: BOT_TOKEN, ADMIN_ID, PLATEGA_API_KEY, PLATEGA_SHOP_ID');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
app.use(express.json({ limit: '200kb' }));

// ---------- Хранилище ----------
const DATA_FILE = path.join(__dirname, 'data.json');
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch { return { payments: {}, users: {} }; }
  }
  return { payments: {}, users: {} };
}
function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('Ошибка записи data.json:', e.message); }
}
let dataStore = loadData();
const userStates = {};

const IMAGES = {
  MAIN: './attached_assets/pick spt_1759573098998.jpg',
  HELP: './attached_assets/pick help (1)_1759573098998.jpg',
  FAQ: './attached_assets/picksher_1759573098998.jpg'
};

// ---------- Главное меню ----------
function sendMainMenu(chatId) {
  const msg = `❇️ *Добро пожаловать в Blesk !* ❇️

*❗️ВАЖНО❗️*
Перед покупкой убедитесь, что аккаунт Spotify не состоял в семейном плане за последний год.
Если не уверены — обратитесь в саппорт!`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '💳 Купить подписку (169 рублей)', callback_data: 'buy' }],
      [{ text: '💬 Саппорт', callback_data: 'support' }],
      [{ text: '❓ FAQ', callback_data: 'faq' }]
    ]
  };
  if (fs.existsSync(IMAGES.MAIN))
    bot.sendPhoto(chatId, IMAGES.MAIN, { caption: msg, parse_mode: 'Markdown', reply_markup: keyboard });
  else bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', reply_markup: keyboard });
}

bot.onText(/\/start/, msg => sendMainMenu(msg.chat.id));

// ---------- Callback кнопки ----------
bot.on('callback_query', async query => {
  const chatId = query.message.chat.id;
  const data = query.data;
  bot.answerCallbackQuery(query.id);

  // Покупка
  if (data === 'buy') {
    const msg = `📋 *Описание процесса покупки:*

После оплаты вы введёте логин и пароль Spotify для подключения.

⏱ Подписка длится *1 месяц*

⚠️ Главное — аккаунт не должен быть в семейном плане!`;
    const kb = {
      inline_keyboard: [
        [{ text: '💳 Оплатить 169 рублей (СБП)', callback_data: 'pay' }],
        [{ text: '🔙 Назад в меню', callback_data: 'menu' }]
      ]
    };
    return bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', reply_markup: kb });
  }

  // ---------- Создание платежа (СБП) ----------
  if (data === 'pay') {
    const loading = await bot.sendMessage(chatId, '⏳ Создаю ссылку на оплату через СБП...');
    const crypto = require('crypto');
    const localId = crypto.randomUUID();
    const ENDPOINTS = [
      'https://api.platega.io/transaction/process',
      'https://app.platega.io/api/transaction/process'
    ];
    const LOGFILE = path.join(__dirname, 'logs', 'platega.log');
    const appendLog = t => {
      try {
        fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
        fs.appendFileSync(LOGFILE, `[${new Date().toISOString()}] ${t}\n`);
      } catch {}
    };

    async function getTransactionDetails(id) {
      const bases = ['https://api.platega.io', 'https://app.platega.io/api', 'https://app.platega.io'];
      for (const base of bases) {
        const url = `${base.replace(/\/$/, '')}/transaction/${id}`;
        try {
          const r = await axios.get(url, {
            headers: { 'X-MerchantId': PLATEGA_SHOP_ID, 'X-Secret': PLATEGA_API_KEY },
            timeout: 10000
          });
          appendLog(`GET ${url} => ${r.status} ${JSON.stringify(r.data)}`);
          if (r.data?.redirect || r.data?.redirectUrl || r.data?.payformSuccessUrl)
            return r.data.redirect || r.data.redirectUrl || r.data.payformSuccessUrl;
        } catch (e) {
          appendLog(`ERR GET ${url} => ${e.response?.status || ''} ${JSON.stringify(e.response?.data || e.message)}`);
        }
      }
      return null;
    }

    try {
      const body = {
        id: localId,
        merchantId: PLATEGA_SHOP_ID,
        paymentMethod: 2,
        paymentDetails: { amount: 169, currency: 'RUB' },
        description: 'Подписка Spotify - 1 месяц',
        return: 'https://t.me/blesk_spotify_bot',
        failedUrl: 'https://t.me/blesk_spotify_bot',
        payload: JSON.stringify({ chatId })
      };
      const headers = {
        'X-MerchantId': PLATEGA_SHOP_ID,
        'X-Secret': PLATEGA_API_KEY,
        'Content-Type': 'application/json'
      };

      let redirectUrl = null;
      let transactionId = null;
      let raw = null;

      for (const endpoint of ENDPOINTS) {
        try {
          const res = await axios.post(endpoint, body, { headers, timeout: 15000 });
          appendLog(`POST ${endpoint} => ${res.status} ${JSON.stringify(res.data)}`);
          raw = res.data;
          redirectUrl =
            res.data?.redirect ||
            res.data?.redirectUrl ||
            res.data?.payformSuccessUrl ||
            res.data?.transaction?.redirectUrl ||
            null;
          transactionId = res.data?.transactionId || res.data?.id || res.data?.transaction?.id || null;
          if (redirectUrl) break;
        } catch (e) {
          appendLog(`ERR POST ${endpoint} => ${e.response?.status || ''} ${JSON.stringify(e.response?.data || e.message)}`);
        }
      }

      if (!redirectUrl && transactionId) {
        appendLog(`redirect отсутствует, пробую GET /transaction/${transactionId}`);
        redirectUrl = await getTransactionDetails(transactionId);
      }

      if (!redirectUrl) {
        await bot.editMessageText('❌ Не удалось создать ссылку на оплату через СБП. Попробуйте позже.', {
          chat_id: chatId,
          message_id: loading.message_id
        });
        await bot.sendMessage(ADMIN_ID, `⚠️ Ошибка создания СБП ссылки для ${chatId}. Проверь logs/platega.log`);
        return;
      }

      dataStore.payments[localId] = {
        chatId,
        amount: 169,
        method: 'SBP',
        status: 'pending',
        created: Date.now(),
        localId,
        remoteId: transactionId,
        rawCreateResponse: raw
      };
      if (transactionId) dataStore.payments[transactionId] = dataStore.payments[localId];
      saveData(dataStore);

      await bot.deleteMessage(chatId, loading.message_id).catch(() => {});
      const kb = {
        inline_keyboard: [
          [{ text: '💳 Оплатить через СБП', url: redirectUrl }],
          [{ text: '🔙 Назад в меню', callback_data: 'menu' }]
        ]
      };
      return bot.sendMessage(chatId, '✅ Ссылка на оплату через СБП создана!', { reply_markup: kb });
    } catch (e) {
      appendLog(`FATAL error SBP create: ${e.stack}`);
      await bot.deleteMessage(chatId, loading.message_id).catch(() => {});
      await bot.sendMessage(chatId, '❌ Ошибка при создании оплаты через СБП. Попробуйте позже.');
      await bot.sendMessage(ADMIN_ID, `Ошибка создания СБП платежа для ${chatId}: ${e.message}`);
    }
  }

  // Саппорт / FAQ
  if (data === 'support') {
    return bot.sendMessage(chatId, '💬 Саппорт: @chanceofrain', {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Назад в меню', callback_data: 'menu' }]] }
    });
  } else if (data === 'faq') {
    const msg = `❓ *FAQ*\n
*Что делать, если был в семейном плане?* — Напиши саппорту.\n
*Сколько ждать?* — 5–10 минут, максимум полчаса.`;
    return bot.sendMessage(chatId, msg, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🔙 Назад в меню', callback_data: 'menu' }]] }
    });
  } else if (data === 'menu') {
    sendMainMenu(chatId);
  } else if (data.startsWith('complete_')) {
    if (chatId.toString() !== ADMIN_ID) return bot.sendMessage(chatId, '❌ Нет прав');
    const userId = data.replace('complete_', '');
    await bot.sendMessage(userId, '✅ Подписка активирована! Приятного прослушивания 🎵');
    bot.sendMessage(chatId, `✅ Подтверждение отправлено пользователю ${userId}`);
  }
});

// ---------- Получение логина/пароля ----------
bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (text && text.startsWith('/')) return;
  if (userStates[chatId]) {
    if (userStates[chatId].step === 'awaiting_login') {
      userStates[chatId].login = text;
      userStates[chatId].step = 'awaiting_password';
      return bot.sendMessage(chatId, '🔐 Введите пароль Spotify:');
    } else if (userStates[chatId].step === 'awaiting_password') {
      const login = userStates[chatId].login;
      const password = text;
      const contact = msg.from.username
        ? `@${msg.from.username}`
        : `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();
      const adminMsg = `🆕 *Новая оплата*\n👤 ${contact}\n🆔 ${chatId}\n📧 \`${login}\`\n🔐 \`${password}\``;
      const kb = { inline_keyboard: [[{ text: '✅ Готово', callback_data: `complete_${chatId}` }]] };
      await bot.sendMessage(ADMIN_ID, adminMsg, { parse_mode: 'Markdown', reply_markup: kb });
      await bot.sendMessage(chatId, '✅ Данные получены. Подключение займёт до 30 минут.');
      delete userStates[chatId];
    }
  }
});

// ---------- CALLBACK по документации Platega ----------
app.post('/webhook/platega', async (req, res) => {
  try {
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const merchant = headers['x-merchantid'] || headers['x-merchant-id'];
    const secret = headers['x-secret'] || headers['x-secret-key'];
    if (!merchant || !secret || merchant !== PLATEGA_SHOP_ID || secret !== PLATEGA_API_KEY) {
      console.error('❌ Неверные заголовки webhook:', headers);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const body = req.body || {};
    console.log('📦 Webhook Platega:', JSON.stringify(body, null, 2));
    const status = (body.status || body.transaction?.status || '').toUpperCase();
    const txId = body.id || body.transaction?.id || body.transactionId || null;
    let chatId = null;

    const payloadRaw = body.payload || body.transaction?.payload;
    if (payloadRaw) {
      try {
        if (typeof payloadRaw === 'string') {
          const parsed = JSON.parse(payloadRaw);
          if (parsed.chatId) chatId = parsed.chatId;
        } else if (typeof payloadRaw === 'object' && payloadRaw.chatId) chatId = payloadRaw.chatId;
      } catch {}
    }
    if (!chatId && txId && dataStore.payments[txId]) chatId = dataStore.payments[txId].chatId;

    console.log('Webhook status:', status, 'txId:', txId, 'chatId:', chatId);

    if (status === 'CONFIRMED') {
      if (chatId) {
        dataStore.payments[txId] = dataStore.payments[txId] || {};
        dataStore.payments[txId].status = 'paid';
        saveData(dataStore);
        userStates[chatId] = { step: 'awaiting_login', transactionId: txId };
        await bot.sendMessage(chatId, '✅ Оплата подтверждена! Введите логин Spotify:');
      } else {
        await bot.sendMessage(ADMIN_ID, `⚠️ Webhook CONFIRMED, chatId не найден\n${JSON.stringify(body)}`);
      }
    } else if (['CANCELED', 'FAILED', 'EXPIRED'].includes(status)) {
      if (chatId) await bot.sendMessage(chatId, `❌ Платёж не прошёл (${status}).`);
    } else {
      console.log('ℹ️ Промежуточный статус webhook:', status);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('🔥 Ошибка webhook Platega:', err);
    await bot.sendMessage(ADMIN_ID, `Ошибка webhook Platega: ${err.message}`);
    res.status(200).json({ ok: true });
  }
});

// ---------- Сервер ----------
app.get('/', (req, res) => res.send('Blesk Spotify Bot is running.'));
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Сервер запущен на порту ${PORT}`));
