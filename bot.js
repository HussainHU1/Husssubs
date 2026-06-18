import express from 'express';
import NodeCache from 'node-cache';

const app = express();
const PORT = process.env.PORT || 3000;

// Session cache (10 minutes TTL)
const cache = new NodeCache({ stdTTL: 600 });

const RESULTS_PER_PAGE = 5;
const LANGUAGES = [
  { code: "EN", label: "🇬🇧 EN" },
  { code: "AR", label: "🇸🇦 AR" }
];

app.use(express.json());

// ----------------------
// 🔐 Verify Telegram webhook
// ----------------------
app.post('/', async (req, res) => {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookSecret) {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (secret !== webhookSecret) {
      return res.status(401).send('Unauthorized');
    }
  }

  const update = req.body;

  try {
    if (update.message?.text) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }
  } catch (err) {
    console.error('Error:', err);
  }

  res.send('OK');
});

// ----------------------
// 💬 Handle Messages
// ----------------------
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === '/start' || text === '/help') {
    await sendText(
      chatId,
      "👋 Send <b>/search &lt;movie or show name&gt;</b> to find subtitles.\n\nExample: <code>/search Inception</code>"
    );
    return;
  }

  if (text.startsWith('/search')) {
    const query = text.replace('/search', '').trim();

    if (!query) {
      await sendText(chatId, "⚠️ Usage: <code>/search &lt;name&gt;</code>");
      return;
    }

    await sendChatAction(chatId, 'typing');

    const res = await searchSubs(query, 'EN');
    await send(chatId, res.text, res.keyboard);
  }
}

// ----------------------
// 🎛 Handle Callbacks
// ----------------------
async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const data = cb.data;
  const [action, sessionId, arg] = data.split('|');

  const session = cache.get(`session:${sessionId}`);

  if (!session) {
    await answerCallback(cb.id, '⌛ This search expired — run /search again.', true);
    return;
  }

  // 🌍 Change language
  if (action === 'lang') {
    await answerCallback(cb.id, null);
    const res = await searchSubs(session.query, arg, sessionId);
    await edit(chatId, cb.message.message_id, res.text, res.keyboard);
    return;
  }

  // ▶️ More results
  if (action === 'more') {
    await answerCallback(cb.id, null);
    const offset = parseInt(arg, 10) || 0;
    const res = renderResults({ ...session, sessionId }, offset);
    await edit(chatId, cb.message.message_id, res.text, res.keyboard);
    return;
  }

  // 📥 Download subtitle
  if (action === 'dl') {
    const idx = parseInt(arg, 10);
    const item = session.results?.[idx];

    if (!item) {
      await answerCallback(cb.id, '❌ File not found', true);
      return;
    }

    await answerCallback(cb.id, '⬇️ Downloading…');
    await sendChatAction(chatId, 'upload_document');

    try {
      const file = await fetchWithRetry(item.fileUrl, {});
      if (!file.ok) throw new Error(`Download failed: ${file.status}`);

      const buffer = await file.arrayBuffer();
      const filename = `${sanitizeFilename(item.title)}.${item.ext || 'zip'}`;

      await sendDocument(chatId, buffer, filename);
    } catch (err) {
      console.error('Download error:', err);
      await sendText(chatId, '❌ Couldn\'t fetch that subtitle file — try another one.');
    }
  }
}

// ----------------------
// 🔎 Search SubDL
// ----------------------
async function searchSubs(query, lang, sessionId) {
  let data;
  try {
    const url =
      `https://api.subdl.com/api/v1/subtitles` +
      `?api_key=${encodeURIComponent(process.env.SUBDL_API_KEY || '')}` +
      `&film_name=${encodeURIComponent(query)}` +
      `&languages=${encodeURIComponent(lang)}` +
      `&subs_per_page=20`;

    const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } });
    const bodyText = await res.text();

    if (!res.ok) {
      throw new Error(`SubDL API returned ${res.status}: ${bodyText.slice(0, 300)}`);
    }

    data = JSON.parse(bodyText);
  } catch (err) {
    console.error('Search error:', err);
    return { text: '⚠️ Search service is unavailable right now, try again shortly.', keyboard: null };
  }

  if (!data?.status) {
    return { text: `❌ ${escapeHtml(data?.error || 'Search failed')}`, keyboard: null };
  }

  const match = data.results?.[0];
  const subtitles = data.subtitles || [];

  if (!match || !subtitles.length) {
    return { text: `❌ No results for <b>${escapeHtml(query)}</b>`, keyboard: null };
  }

  const results = subtitles
    .map(item => {
      const relUrl = item.url || '';
      if (!relUrl) return null;
      const fileUrl = relUrl.startsWith('http') ? relUrl : `https://dl.subdl.com${relUrl}`;
      const ext = (relUrl.split('.').pop() || 'zip').toLowerCase();
      return {
        title: item.release_name || item.name || 'Unknown',
        fileUrl,
        ext
      };
    })
    .filter(x => x);

  if (!results.length) {
    return { text: `❌ No downloadable files for <b>${escapeHtml(query)}</b>`, keyboard: null };
  }

  const matchTitle = match.year ? `${match.name} (${match.year})` : match.name;

  const session = { query, lang, matchTitle, results };
  const id = sessionId || generateSessionId();
  cache.set(`session:${id}`, session);

  return renderResults({ ...session, sessionId: id }, 0);
}

function renderResults(session, offset) {
  const { matchTitle, query, lang, results, sessionId } = session;
  const page = results.slice(offset, offset + RESULTS_PER_PAGE);

  let text = `🎬 <b>${escapeHtml(matchTitle || query)}</b>\n🌍 Language: ${escapeHtml(lang)}\n\n`;
  const keyboard = [];

  page.forEach((item, i) => {
    const globalIdx = offset + i;
    text += `🎥 ${globalIdx + 1}) ${escapeHtml(item.title)}\n`;
    keyboard.push([{ text: `📥 Download ${globalIdx + 1}`, callback_data: `dl|${sessionId}|${globalIdx}` }]);
  });

  if (offset + RESULTS_PER_PAGE < results.length) {
    keyboard.push([{ text: '▶️ More results', callback_data: `more|${sessionId}|${offset + RESULTS_PER_PAGE}` }]);
  }

  keyboard.push(LANGUAGES.map(l => ({ text: l.label, callback_data: `lang|${sessionId}|${l.code}` })));

  return { text, keyboard };
}

// ----------------------
// 🔁 Retry Fetch
// ----------------------
async function fetchWithRetry(url, options = {}, retries = 2, baseDelayMs = 700) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status !== 503 && res.status !== 502) return res;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, baseDelayMs * (attempt + 1)));
      }
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, baseDelayMs * (attempt + 1)));
      }
    }
  }
  if (lastError) throw lastError;
  throw new Error('All retries failed');
}

// ----------------------
// 📤 Telegram Helpers
// ----------------------
async function tg(method, body) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (err) {
    console.error(`Telegram API error (${method}):`, err);
    return { ok: false };
  }
}

async function send(chatId, text, keyboard) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  await tg('sendMessage', body);
}

async function edit(chatId, messageId, text, keyboard) {
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  const res = await tg('editMessageText', body);
  if (!res.ok) await send(chatId, text, keyboard);
}

async function sendText(chatId, text) {
  await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

async function sendChatAction(chatId, action) {
  await tg('sendChatAction', { chat_id: chatId, action });
}

async function answerCallback(callbackQueryId, text, alert = false) {
  const body = { callback_query_id: callbackQueryId };
  if (text) {
    body.text = text;
    body.show_alert = alert;
  }
  await tg('answerCallbackQuery', body);
}

async function sendDocument(chatId, fileBuffer, filename) {
  const formData = new FormData();
  formData.append('chat_id', chatId.toString());
  formData.append('document', new Blob([fileBuffer]), filename);

  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendDocument`, {
      method: 'POST',
      body: formData
    });
    if (!res.ok) {
      console.error('sendDocument failed:', await res.text());
    }
  } catch (err) {
    console.error('sendDocument error:', err);
  }
}

// ----------------------
// 🧰 Utilities
// ----------------------
function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sanitizeFilename(name = 'subtitle') {
  return name.replace(/[^a-z0-9_\-]+/gi, '_').slice(0, 60) || 'subtitle';
}

function generateSessionId() {
  return Math.random().toString(36).substring(2, 10);
}

// ----------------------
// 🚀 Start Server
// ----------------------
app.listen(PORT, () => {
  console.log(`Bot server running on port ${PORT}`);
});
