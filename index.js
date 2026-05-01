const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
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

// Hermes API configuration
const HERMES_API_URL = process.env.HERMES_API_URL || 'http://localhost:8642/v1/chat/completions';

// Initialize LINE client
const client = new messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken
});

// Persistence for Sessions, History, and Pending Responses
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
    console.log('[State] Loaded persistent state.');
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
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  const userId = event.source.userId;
  const messageId = event.message.id;

  if (processedMessages.has(messageId)) {
    console.log(`[Queue] Duplicate ignored: ${messageId}`);
    return;
  }
  processedMessages.add(messageId);

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
        console.error(`[Session: ${userId}] Processing error:`, err.message);
        try {
          await client.pushMessage({
            to: userId,
            messages: [{ type: 'text', text: `⚠️ 系統處理發生錯誤 (Error: ${err.message})。請稍後再試。` }]
          });
        } catch (e) {
          console.error(`[Session: ${userId}] Failed to send error notification:`, e.message);
        }
      }
    }
  } finally {
    userState.processing = false;
    console.log(`[Queue: ${userId}] Queue finished.`);
  }
}

async function handleEvent(event) {
  const userId = event.source.userId;
  const userMessage = event.message.text;
  const replyToken = event.replyToken;

  console.log(`[Session: ${userId}] Processing: ${userMessage}`);

  const showLoading = async () => {
    try {
        // Use official SDK method
        await client.showLoadingAnimation({ chatId: userId, loadingSeconds: 40 });
    } catch (e) {
        console.error(`[Session: ${userId}] Loading error:`, e.message);
    }
  };

  // 1. Start loading animation
  await showLoading();
  const loadingTimer = setInterval(showLoading, 30000); // Trigger every 30s to be safe

  // 2. 10-minute Nudge with Retry logic
  const nudgeTimer = setTimeout(async () => {
    const sendNudge = async (attempt = 1) => {
        try {
            console.log(`[Session: ${userId}] 10-minute nudge (attempt ${attempt}).`);
            await client.pushMessage({
                to: userId,
                messages: [{ type: 'text', text: '稍等！系統正在處理複雜任務中，請耐心候標... (進度持續更新中)' }]
            });
        } catch (e) {
            if (e.message.includes('429') && attempt < 3) {
                console.warn(`[Session: ${userId}] Nudge rate limited, retrying in 5s...`);
                setTimeout(() => sendNudge(attempt + 1), 5000);
            } else {
                console.error(`[Session: ${userId}] Nudge failed:`, e.message);
            }
        }
    };
    sendNudge();
  }, 600000);

  try {
    const activeSessionId = state.sessions[userId] || userId;
    const history = state.histories[userId] || [];
    const messages = [...history.slice(-10), { role: "user", content: userMessage }];

    console.log(`[Session: ${userId}] Forwarding to Hermes...`);

    const response = await axios.post(HERMES_API_URL, {
      model: "hermes-agent",
      messages: messages,
      stream: false
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.HERMES_API_KEY}`,
        'X-Hermes-Session-Id': activeSessionId
      },
      timeout: 2400000 
    });

    clearInterval(loadingTimer);
    clearTimeout(nudgeTimer);

    // CRITICAL: Update and persist Session ID if Hermes triggers compression
    const newSessionId = response.headers['x-hermes-session-id'];
    if (newSessionId && newSessionId !== activeSessionId) {
        console.log(`[Session: ${userId}] Context compressed! New Session ID: ${newSessionId}`);
        state.sessions[userId] = newSessionId;
        saveState();
    }

    const botResponse = response.data.choices[0].message.content;

    // Update state
    if (!state.histories[userId]) state.histories[userId] = [];
    state.histories[userId].push({ role: "user", content: userMessage });
    state.histories[userId].push({ role: "assistant", content: botResponse });
    if (state.histories[userId].length > 20) state.histories[userId] = state.histories[userId].slice(-20);

    // Delivery
    const pending = state.pending_responses[userId] || [];
    const messagesToSend = [...pending, botResponse];
    const lineMessages = messagesToSend.slice(-5).map(text => ({ type: 'text', text }));

    try {
        await client.replyMessage({ replyToken, messages: lineMessages });
        console.log(`[Session: ${userId}] Replied.`);
        state.pending_responses[userId] = [];
    } catch (e) {
        console.log(`[Session: ${userId}] Reply failed, using Push.`);
        try {
            await client.pushMessage({ to: userId, messages: lineMessages });
            state.pending_responses[userId] = [];
        } catch (pushErr) {
            console.error(`[Session: ${userId}] Push failed. Queuing.`);
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
  if (err instanceof line.SignatureValidationFailed) {
    res.status(401).send(err.signature);
    return;
  } else if (err instanceof line.JSONParseError) {
    res.status(400).send(err.raw);
    return;
  }
  next(err);
});

app.listen(port, () => {
  console.log(`hermes-line-bridge (Final Stability Version) listening on port ${port}`);
});
