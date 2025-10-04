require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID; // ваш Telegram ID администратора
const PLATEGA_API_KEY = process.env.PLATEGA_API_KEY; // X-Secret
const PLATEGA_SHOP_ID = process.env.PLATEGA_SHOP_ID; // X-MerchantId (merchant id)
const PORT = process.env.PORT || 5000;

if (!BOT_TOKEN || !ADMIN_ID || !PLATEGA_API_KEY || !PLATEGA_SHOP_ID) {
  console.error('ERROR: Не заданы обязательные переменные окружения. Убедитесь, что BOT_TOKEN, ADMIN_ID, PLATEGA_API_KEY и PLATEGA_SHOP_ID установлены.');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
app.use(express.json({ limit: '200kb' }));

const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Ошибка загрузки данных:', error);
      return { payments: {}, users: {} };
    }
  }
  return { payments: {}, users: {} };
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Ошибка сохранения данных:', error);
  }
}

let dataStore = loadData();
const userStates = {};

const IMAGES = {
  MAIN: './attached_assets/pick spt_1759573098998.jpg',
  HELP: './attached_assets/pick help (1)_1759573098998.jpg',
  FAQ: './attached_assets/picksher_1759573098998.jpg'
};

function sendMainMenu(chatId) {
  const message = `❇️*Добро пожаловать в Blesk !*❇️

*❗️ВАЖНО❗️*
Перед покупкой вы должны быть уверены, что аккаунт в ближайший год не состоял в семейном плане!
Если вы не уверены, обращайтесь в саппорт!`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '💳 Купить подписку (169 рублей)', callback_data: 'buy' }],
      [{ text: '💬 Саппорт', callback_data: 'support' }],
      [{ text: '❓ FAQ', callback_data: 'faq' }]
    ]
  };

  if (fs.existsSync(IMAGES.MAIN)) {
    bot.sendPhoto(chatId, IMAGES.MAIN, {
      caption: message,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    }).catch(err => {
      console.error('Ошибка отправки фото:', err);
      bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    });
  } else {
    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }
}

/* --- Telegram handlers (unchanged, небольшие улучшения) --- */
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  delete userStates[chatId];
  sendMainMenu(chatId);
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  bot.answerCallbackQuery(query.id);

  if (data === 'buy') {
    const message = `📋 *Описание процесса покупки:*

После оплаты вам нужно будет ввести логин и пароль от вашего аккаунта Spotify, чтобы мы могли подключить вас к подписке.

⏱ Подписка длится *1 месяц*

⚠️ Главное, чтобы вы раньше не состояли в семейном плане подписки!`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '💳 Оплатить 169 рублей', callback_data: 'pay' }],
        [{ text: '🔙 Назад в меню', callback_data: 'menu' }]
      ]
    };

    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  } else if (data === 'pay') {
    let loadingMsg;
    try {
      loadingMsg = await bot.sendMessage(chatId, '⏳ Создаю ссылку на оплату...');

      const crypto = require('crypto');
      const localId = crypto.randomUUID(); // наш локальный id транзакции

      const paymentData = {
        id: localId,
        paymentMethod: 2,
        paymentDetails: {
          amount: 169,
          currency: 'RUB'
        },
        description: 'Подписка Spotify - 1 месяц',
        return: 'https://t.me/blesk_spotify_bot',
        failedUrl: 'https://t.me/blesk_spotify_bot',
        payload: JSON.stringify({ chatId: chatId }),
        merchantId: PLATEGA_SHOP_ID // дублирую merchantId в теле — на всякий случай (некоторые endpoints требуют)
      };

      // URL: использую официальный API endpoint (api.platega.io), но если у вас работает app.platega.io — можно поменять
      const PLATEGA_URL = 'https://api.platega.io/transaction/process';

      const response = await axios.post(PLATEGA_URL, paymentData, {
        headers: {
          'X-MerchantId': PLATEGA_SHOP_ID,
          'X-Secret': PLATEGA_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      // возможные поля ответа: redirect, transactionId, transactionId в разной форме
      const remoteTxId = response.data?.transactionId || response.data?.transaction?.transactionId || response.data?.id || null;
      const redirectUrl = response.data?.redirect || response.data?.payformSuccessUrl || null;

      // Сохраняем маппинг локального id -> chatId и also remote id если есть
      dataStore.payments[localId] = {
        chatId: chatId,
        amount: 169,
        status: 'pending',
        created: Date.now(),
        localId,
        remoteId: remoteTxId || null,
        rawCreateResponse: response.data
      };

      // если remoteId есть — сохраняем индекс для удобства поиска по нему (чтобы webhook'и с remoteId тоже мапились)
      if (remoteTxId) {
        dataStore.payments[remoteTxId] = dataStore.payments[localId];
      }

      saveData(dataStore);

      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

      if (redirectUrl) {
        const keyboard = {
          inline_keyboard: [
            [{ text: '💳 Перейти к оплате', url: redirectUrl }],
            [{ text: '🔙 Назад в меню', callback_data: 'menu' }]
          ]
        };

        bot.sendMessage(chatId, '✅ Ссылка на оплату готова!\n\nНажмите кнопку ниже для перехода к оплате.', {
          reply_markup: keyboard
        });
      } else {
        // Если нет redirect — покажем админке и пользователю ошибку
        await bot.sendMessage(chatId, '❌ Не удалось получить ссылку на оплату. Попробуйте позже или обратитесь в саппорт.');
        await bot.sendMessage(ADMIN_ID, `⚠️ При создании платежа для ${chatId} не вернулась ссылка. Ответ Platega: ${JSON.stringify(response.data)}`);
      }
    } catch (error) {
      console.error('Ошибка создания платежа:', error.response?.data || error.message);
      if (loadingMsg) await bot.deleteMessage(chatId, loadingMsg.message_id).catch(()=>{});
      bot.sendMessage(chatId, '❌ Произошла ошибка при создании платежа. Попробуйте позже или обратитесь в саппорт.');
      await bot.sendMessage(ADMIN_ID, `Ошибка создания платежа для ${chatId}: ${error.response?.data || error.message}`);
    }
  } else if (data === 'support') {
    const message = `💬 *Саппорт*

По всем вопросам и проблемам с подпиской обращайтесь:
@chanceofrain`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔙 Назад в меню', callback_data: 'menu' }]
      ]
    };

    if (fs.existsSync(IMAGES.HELP)) {
      bot.sendPhoto(chatId, IMAGES.HELP, {
        caption: message,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      }).catch(err => {
        bot.sendMessage(chatId, message, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
      });
    } else {
      bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }
  } else if (data === 'faq') {
    const message = `❓ *FAQ - Часто задаваемые вопросы*

*Вопрос:* Куда обращаться если что то случилось с подпиской?
*Ответ:* Если вдруг не по вашей вине, произошел казус, мы со своей стороны все восстановим и дополнительно продлим еще на 1 месяц вашу подписку. Обращайтесь в саппорт

*Вопрос:* Что делать если подписку хочу, но за последний год уже находился в семейном плане?
*Ответ:* Это не такая большая проблема, после оплаты обязательно обратитесь в саппорт и уведомите, что уже состояли ранее в семейном плане.

*Вопрос:* Что по времени?
*Ответ:* Не больше получаса, обычно 5-10 минут`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔙 Назад в меню', callback_data: 'menu' }]
      ]
    };

    if (fs.existsSync(IMAGES.FAQ)) {
      bot.sendPhoto(chatId, IMAGES.FAQ, {
        caption: message,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      }).catch(err => {
        bot.sendMessage(chatId, message, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
      });
    } else {
      bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }
  } else if (data === 'menu') {
    delete userStates[chatId];
    sendMainMenu(chatId);
  } else if (data.startsWith('complete_')) {
    if (chatId.toString() !== ADMIN_ID) {
      bot.sendMessage(chatId, '❌ У вас нет прав для этого действия');
      return;
    }

    const userId = data.replace('complete_', '');
    
    bot.sendMessage(userId, '✅ *Ваша подписка готова!*\n\nПодписка успешно активирована. Приятного использования Spotify! 🎵', {
      parse_mode: 'Markdown'
    });
    
    bot.sendMessage(chatId, `✅ Уведомление отправлено пользователю ${userId}`);
  }
});

/* --- Приём логина/пароля после успешного платежа --- */
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text && text.startsWith('/')) {
    return;
  }

  if (userStates[chatId]) {
    if (userStates[chatId].step === 'awaiting_login') {
      userStates[chatId].login = text;
      userStates[chatId].step = 'awaiting_password';
      bot.sendMessage(chatId, '🔐 Теперь введите пароль от вашего аккаунта Spotify:');
    } else if (userStates[chatId].step === 'awaiting_password') {
      const login = userStates[chatId].login;
      const password = text;

      const user = msg.from;
      const userContact = user.username ? `@${user.username}` : `${user.first_name || ''} ${user.last_name || ''}`.trim();

      const adminMessage = `🆕 *Новая оплата!*

👤 *Контакт клиента:* ${userContact}
🆔 *User ID:* ${chatId}

📧 *Логин Spotify:* \`${login}\`
🔐 *Пароль Spotify:* \`${password}\``;

      const keyboard = {
        inline_keyboard: [
          [{ text: '✅ Готово', callback_data: `complete_${chatId}` }]
        ]
      };

      bot.sendMessage(ADMIN_ID, adminMessage, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });

      bot.sendMessage(chatId, '✅ Спасибо! Ваши данные получены.\n\n⏳ Ожидайте подключения подписки. Обычно это занимает 5-10 минут, но не более получаса.');

      delete userStates[chatId];
    }
  }
});

/* --- Вебхук от Platega --- */
/*
  Примечание по безопасности/форматам:
  - Platega обычно шлёт заголовки X-MerchantId и X-Secret. Мы поддерживаем
    варианты 'x-merchantid' и 'x-merchant-id' (все имена заголовков в Node.js
    приходят в lowercase).
  - Webhook'и могут приходить в нескольких форматах (top-level id/status или
    вложенные transaction), поэтому обрабатываем несколько случаев.
  - Если не удалось сопоставить webhook с локальной транзакцией — уведомляем админа.
*/
app.post('/webhook/platega', async (req, res) => {
  try {
    // Быстрая проверка заголовков (учитываем разные варианты написания)
    const headers = req.headers || {};
    const merchantHeader = headers['x-merchantid'] || headers['x-merchant-id'] || headers['x-merchant'];
    const secretHeader = headers['x-secret'] || headers['x-api-key'] || headers['x-secret-key'];

    if (!merchantHeader || !secretHeader || merchantHeader !== PLATEGA_SHOP_ID || secretHeader !== PLATEGA_API_KEY) {
      console.error('⛔ Неверная аутентификация webhook:', { merchantHeader, secretHeader: secretHeader ? '[HIDDEN]' : 'missing' });
      // Важно: если заголовки неверны — вернуть 401, чтобы знать, что пришёл невалидный запрос
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Валидация успешной доставки: обрабатываем возможные форматы тела
    const body = req.body || {};
    console.log('Получен webhook от Platega:', JSON.stringify(body, null, 2));

    // Вытащим статус и возможные id'шники (учитываем как top-level, так и вложенный transaction)
    const status = (body.status || body.transaction?.status || '').toString().toUpperCase();
    let txId = body.id || body.transaction?.id || body.transactionId || body.invoiceId || body.externalId || null;

    // Найдём chatId: несколько способов
    let chatId = null;

    // 1) если у нас уже есть запись по txId
    if (txId && dataStore.payments[txId]) {
      chatId = dataStore.payments[txId].chatId;
    }

    // 2) если есть payload (мы отправляли JSON.stringify({chatId}))
    if (!chatId) {
      const payloadRaw = body.payload || body.transaction?.payload || body.transaction?.externalId || null;
      if (payloadRaw) {
        try {
          const parsed = (typeof payloadRaw === 'string') ? JSON.parse(payloadRaw) : payloadRaw;
          if (parsed && parsed.chatId) {
            chatId = parsed.chatId;
            // Если txId отсутствует, попробуем найти локальную запись по chatId и pending статусу
            if (!txId) {
              for (const [k, v] of Object.entries(dataStore.payments)) {
                if (v.chatId == chatId && v.status === 'pending') {
                  txId = k;
                  break;
                }
              }
            }
          }
        } catch (e) {
          // payload не JSON — пропускаем
        }
      }
    }

    // 3) запасной поиск по сумме и pending-записям
    if (!chatId && body.paymentDetails?.amount != null) {
      const amount = Number(body.paymentDetails.amount);
      for (const [k, v] of Object.entries(dataStore.payments)) {
        if (v.amount === amount && v.status === 'pending') {
          chatId = v.chatId;
          txId = k;
          break;
        }
      }
    }

    // Если remote transaction id присутствует, попробуем маппинг: например, Platega может прислать remoteId
    const remoteIdCandidate = body.transaction?.id || body.transactionId || body.id || body.invoiceId || body.externalId || null;
    if (!txId && remoteIdCandidate && dataStore.payments[remoteIdCandidate]) {
      txId = remoteIdCandidate;
      chatId = dataStore.payments[txId].chatId;
    }

    // Если уже обработан — idempotency (на случай повторов)
    if (txId && dataStore.payments[txId] && dataStore.payments[txId].status === 'paid' && status === 'CONFIRMED') {
      console.log('Webhook duplicate CONFIRMED для', txId);
      return res.status(200).json({ status: 'ok' });
    }

    // Основная логика по статусам
    if (status === 'CONFIRMED') {
      if (chatId) {
        // обновляем статус и сохраняем
        const storeKey = txId || `tx_unknown_${Date.now()}`;
        dataStore.payments[storeKey] = dataStore.payments[storeKey] || {};
        dataStore.payments[storeKey].chatId = chatId;
        dataStore.payments[storeKey].status = 'paid';
        dataStore.payments[storeKey].paidAt = Date.now();
        saveData(dataStore);

        // спросим логин у пользователя
        await bot.sendMessage(chatId, '✅ *Оплата прошла успешно!*\n\n📝 Теперь введите ваш логин от аккаунта Spotify:', {
          parse_mode: 'Markdown'
        });

        userStates[chatId] = {
          step: 'awaiting_login',
          transactionId: storeKey
        };

        // вернуть 200 — Platega подтвердит доставку
        return res.status(200).json({ status: 'ok' });
      } else {
        // Не нашли соответствие — уведомляем админа и сохраняем необработанный webhook
        await bot.sendMessage(ADMIN_ID, `⚠️ Получен webhook CONFIRMED, но не удалось найти chatId для транзакции.\nbody: \`${JSON.stringify(body)}\``, { parse_mode: 'Markdown' });
        console.error('CONFIRMED, но chatId не найден. Сохраняю для ручной проверки.');
        // Сохраняем "непривязанную" запись
        const unkKey = `unmapped_${Date.now()}`;
        dataStore.payments[unkKey] = { status: 'confirmed_unmapped', raw: body, created: Date.now() };
        saveData(dataStore);
        return res.status(200).json({ status: 'ok' });
      }
    } else if (status === 'CANCELED' || status === 'EXPIRED' || status === 'FAILED') {
      if (chatId && txId) {
        dataStore.payments[txId] = dataStore.payments[txId] || {};
        dataStore.payments[txId].status = status.toLowerCase();
        dataStore.payments[txId].updatedAt = Date.now();
        saveData(dataStore);

        await bot.sendMessage(chatId, `❌ Статус платежа: *${status}*. Платёж не был завершён. Попробуйте ещё раз или обратитесь в саппорт.`, {
          parse_mode: 'Markdown'
        });
      } else {
        await bot.sendMessage(ADMIN_ID, `⚠️ Получен webhook ${status}, но не найден связанный chatId. body: \`${JSON.stringify(body)}\``, { parse_mode: 'Markdown' });
        const unkKey = `unmapped_${Date.now()}`;
        dataStore.payments[unkKey] = { status: status.toLowerCase(), raw: body, created: Date.now() };
        saveData(dataStore);
      }
      return res.status(200).json({ status: 'ok' });
    } else {
      // другие статусы (например PENDING) — просто логируем и сохраняем при возможности
      console.log('Получен webhook со статусом:', status);
      if (txId) {
        dataStore.payments[txId] = dataStore.payments[txId] || {};
        dataStore.payments[txId].status = (status || dataStore.payments[txId].status || 'pending').toLowerCase();
        saveData(dataStore);
      } else {
        const unkKey = `unmapped_${Date.now()}`;
        dataStore.payments[unkKey] = { status: status || 'unknown', raw: body, created: Date.now() };
        saveData(dataStore);
      }
      return res.status(200).json({ status: 'ok' });
    }
  } catch (error) {
    console.error('Ошибка обработки webhook:', error);
    // лучше вернуть 200, чтобы Platega не считала ошибку на нашей стороне (но логируем администратору)
    await bot.sendMessage(ADMIN_ID, `Ошибка при обработке webhook Platega: ${error.message}`);
    return res.status(200).json({ status: 'ok' });
  }
});

app.get('/', (req, res) => {
  res.send('Blesk Spotify Bot is running!');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  console.log(`✅ Бот запущен и готов к работе!`);
});

console.log('🤖 Blesk Spotify Bot запускается...');
