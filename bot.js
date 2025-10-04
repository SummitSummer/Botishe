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

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();

app.use(express.json());

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
    try {
      bot.sendMessage(chatId, '⏳ Создаю ссылку на оплату...');

      const webhookUrl = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co/webhook/platega`;
      
      const paymentData = {
        shop_id: PLATEGA_SHOP_ID,
        amount: 169,
        currency: 'RUB',
        order_id: `order_${chatId}_${Date.now()}`,
        description: 'Подписка Spotify - 1 месяц',
        success_url: 'https://t.me/your_bot',
        fail_url: 'https://t.me/your_bot',
        webhook_url: webhookUrl,
        custom: JSON.stringify({ chatId: chatId })
      };

      const response = await axios.post('https://platega.io/api/v1/payments', paymentData, {
        headers: {
          'X-MerchantId': PLATEGA_SHOP_ID,
          'X-Secret': PLATEGA_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      if (response.data && response.data.payment_url) {
        const keyboard = {
          inline_keyboard: [
            [{ text: '💳 Перейти к оплате', url: response.data.payment_url }],
            [{ text: '🔙 Назад в меню', callback_data: 'menu' }]
          ]
        };

        dataStore.payments[response.data.order_id || paymentData.order_id] = {
          chatId: chatId,
          amount: 169,
          status: 'pending',
          created: Date.now()
        };
        saveData(dataStore);

        bot.sendMessage(chatId, '✅ Ссылка на оплату готова!\n\nНажмите кнопку ниже для перехода к оплате.', {
          reply_markup: keyboard
        });
      } else {
        throw new Error('Не удалось получить ссылку на оплату');
      }
    } catch (error) {
      console.error('Ошибка создания платежа:', error.response?.data || error.message);
      bot.sendMessage(chatId, '❌ Произошла ошибка при создании платежа. Попробуйте позже или обратитесь в саппорт.');
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

app.post('/webhook/platega', async (req, res) => {
  try {
    console.log('Получен webhook от Platega:', JSON.stringify(req.body, null, 2));
    console.log('Headers:', JSON.stringify(req.headers, null, 2));

    const merchantId = req.headers['x-merchantid'];
    const secret = req.headers['x-secret'];

    if (merchantId !== PLATEGA_SHOP_ID || secret !== PLATEGA_API_KEY) {
      console.error('⛔ Неверная аутентификация webhook:', { merchantId, secret: secret ? '[HIDDEN]' : 'missing' });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { status, order_id, custom } = req.body;

    if (status === 'CONFIRMED') {
      let chatId;

      if (custom) {
        try {
          const customData = JSON.parse(custom);
          chatId = customData.chatId;
        } catch (e) {
          console.error('Ошибка парсинга custom:', e);
        }
      }

      if (!chatId && dataStore.payments[order_id]) {
        chatId = dataStore.payments[order_id].chatId;
      }

      if (chatId) {
        dataStore.payments[order_id] = dataStore.payments[order_id] || {};
        dataStore.payments[order_id].status = 'paid';
        dataStore.payments[order_id].paidAt = Date.now();
        saveData(dataStore);

        bot.sendMessage(chatId, '✅ *Оплата прошла успешно!*\n\n📝 Теперь введите ваш логин от аккаунта Spotify:', {
          parse_mode: 'Markdown'
        });

        userStates[chatId] = {
          step: 'awaiting_login',
          orderId: order_id
        };
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Ошибка обработки webhook:', error);
    res.status(200).json({ status: 'ok' });
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
