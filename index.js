const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const {
  messagingApi,
  middleware
} = line;

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const app = express();
const port = process.env.PORT || 5003;

const HERMES_API_URL = process.env.HERMES_API_URL || 'http://localhost:8642/v1/chat/completions';

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken
});

const blobClient = new messagingApi.MessagingApiBlobClient({
  channelAccessToken: config.channelAccessToken
});

// Persistence
const STATE_FILE = path.join(__dirname, 'state.json');
let state = { sessions: {}, histories: {}, pending_responses: {} };

try {
  if (fs.existsSync(STATE_FILE)) {
    const savedState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { 
        sessions: savedState.sessions || {}, 
        histories: savedState.histories || {}, 
        pending_responses: savedState.pending_responses || {} 
    };
  }
} catch (err) {
  console.error('[State] Error loading state:', err.message);
}

const saveState = () => {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[State] Error saving state:', err.message);
  }
};

const generateSessionId = () => {
    const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const rand = crypto.randomBytes(3).toString('hex');
    return `line_${ts}_${rand}`;
};

const processedMessages = new Set();
const userQueues = new Map();

setInterval(() => processedMessages.clear(), 3600000);

// --- Webhook ---
app.post('/webhook', middleware(config), (req, res) => {
  res.status(200).send('OK');
  req.body.events.forEach(event => {
    enqueueEvent(event);
  });
});

async function enqueueEvent(event) {
  if (event.type !== 'message') return;
  const validTypes = ['text', 'location', 'image'];
  if (!validTypes.includes(event.message.type)) return;

  const userId = event.source.userId;
  const messageId = event.message.id;
  const userMessage = event.message.type === 'text' ? event.message.text.trim() : '';

  if (processedMessages.has(messageId)) return;
  processedMessages.add(messageId);

  // --- COMMAND HANDLING ---
  if (event.message.type === 'text') {
      const lowerMsg = userMessage.toLowerCase();
      if (lowerMsg === '/help' || lowerMsg === '說明') {
        const helpText = `🛠️ Hermes LINE Bridge 穩定版：
        
1. [/new] 👉 開啟全新會話 (100% 乾淨重置)。
2. [/help] 👉 顯示此清單。

💡 已修復上下文連貫性問題。現在系統會完整記錄您的對話歷史。`.trim();
        try {
            await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: helpText }] });
        } catch (e) {}
        return;
      }

      if (lowerMsg === '/new') {
        state.sessions[userId] = generateSessionId();
        state.histories[userId] = [];
        state.pending_responses[userId] = [];
        saveState();
        try {
            await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '🧹 對話已重置，已為您準備好全新的會話。' }] });
        } catch (e) {}
        return;
      }
  }

  if (!userQueues.has(userId)) {
    userQueues.set(userId, { queue: [], processing: false });
  }

  const userState = userQueues.get(userId);
  userState.queue.push(event);
  processQueue(userId);
}

async function processQueue(userId) {
  const userState = userQueues.get(userId);
  if (userState.processing) return;
  userState.processing = true;

  try {
    while (userState.queue.length > 0) {
      const event = userState.queue.shift();
      try {
        await handleEvent(event);
      } catch (err) {
        console.error(`[Session: ${userId}] Error:`, err.message);
        try {
          await client.pushMessage({ to: userId, messages: [{ type: 'text', text: `⚠️ 系統處理錯誤 (${err.message})。` }] });
        } catch (e) {}
      }
    }
  } finally {
    userState.processing = false;
  }
}

async function handleEvent(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const messageId = event.message.id;

  let currentPayload;
  let logMessage;

  // 1. Process Input
  if (event.message.type === 'text') {
      currentPayload = event.message.text.trim();
      logMessage = currentPayload;
  } else if (event.message.type === 'location') {
      const { title, address, latitude, longitude } = event.message;
      currentPayload = `[位置資訊] ${title ? title + ' - ' : ''}${address} (緯度: ${latitude}, 經度: ${longitude})`;
      logMessage = currentPayload;
  } else if (event.message.type === 'image') {
      try {
          const res = await blobClient.getMessageContent(messageId);
          let buffer;
          if (res.arrayBuffer) {
              buffer = Buffer.from(await res.arrayBuffer());
          } else {
              const chunks = [];
              for await (const chunk of res) chunks.push(Buffer.from(chunk));
              buffer = Buffer.concat(chunks);
          }
          currentPayload = [
              { type: 'text', text: '這是一張圖片，請解析：' },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}` } }
          ];
          logMessage = '[收到一張圖片]';
      } catch (err) {
          currentPayload = "[圖片讀取失敗]";
          logMessage = currentPayload;
      }
  }

  console.log(`[Session: ${userId}] Processing: ${logMessage}`);

  // Loading animation loop
  const showLoading = async () => { try { await client.showLoadingAnimation({ chatId: userId, loadingSeconds: 40 }); } catch (e) {} };
  await showLoading();
  const loadingTimer = setInterval(showLoading, 30000);

  // Nudge timer
  const nudgeTimer = setTimeout(async () => {
    const sendNudge = async (attempt = 1) => {
        try {
            await client.pushMessage({ to: userId, messages: [{ type: 'text', text: '稍等！系統正在處理複雜任務中...' }] });
        } catch (e) {
            if (e.message.includes('429') && attempt < 3) setTimeout(() => sendNudge(attempt + 1), 5000);
        }
    };
    sendNudge();
  }, 600000);

  try {
    if (!state.sessions[userId]) {
        state.sessions[userId] = generateSessionId();
        saveState();
    }
    const activeSessionId = state.sessions[userId];
    
    // STRATEGY: 
    // When using X-Hermes-Session-Id, Hermes API Server uses database history.
    // We only send the CURRENT turn. This prevents the bridge's sliding window
    // from overriding/corrupting the full database history.
    const apiMessages = [{ role: "user", content: currentPayload }];

    console.log(`[Session: ${userId}] Forwarding to Hermes (Session: ${activeSessionId})...`);

    const response = await axios.post(HERMES_API_URL, {
      model: "hermes-agent",
      messages: apiMessages,
      stream: false
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.HERMES_API_KEY}`,
        'X-Hermes-Session-Id': activeSessionId
      },
      timeout: 2400000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    clearInterval(loadingTimer);
    clearTimeout(nudgeTimer);

    const newSessionId = response.headers['x-hermes-session-id'];
    if (newSessionId && newSessionId !== activeSessionId) {
        console.log(`[Session: ${userId}] Session rotated (compression): ${newSessionId}`);
        state.sessions[userId] = newSessionId;
        saveState();
    }

    const botResponse = response.data.choices[0].message.content;

    // We don't need to maintain histories[] for the API call anymore, 
    // but we keep it for redundancy/local logs if needed.
    if (!state.histories[userId]) state.histories[userId] = [];
    state.histories[userId].push({ role: "user", content: logMessage });
    state.histories[userId].push({ role: "assistant", content: botResponse });
    if (state.histories[userId].length > 40) state.histories[userId] = state.histories[userId].slice(-40);

    const pending = state.pending_responses[userId] || [];
    const messagesToSend = [...pending, botResponse];
    const lineMessages = messagesToSend.slice(-5).map(text => ({ type: 'text', text }));

    try {
        await client.replyMessage({ replyToken, messages: lineMessages });
        state.pending_responses[userId] = [];
    } catch (e) {
        try {
            await client.pushMessage({ to: userId, messages: lineMessages });
            state.pending_responses[userId] = [];
        } catch (pushErr) {
            if (!state.pending_responses[userId]) state.pending_responses[userId] = [];
            state.pending_responses[userId].push(botResponse);
        }
    }
    saveState();

  } catch (error) {
    clearInterval(loadingTimer);
    clearTimeout(nudgeTimer);
    throw error;
  }
}

app.use((err, req, res, next) => {
  if (err instanceof line.SignatureValidationFailed) return res.status(401).send(err.signature);
  if (err instanceof line.JSONParseError) return res.status(400).send(err.raw);
  next(err);
});

app.listen(port, () => {
  console.log(`hermes-line-bridge (Database-First Context) listening on port ${port}`);
});
