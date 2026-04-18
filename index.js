const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
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

// For de-duplication and sequential processing
const processedMessages = new Set();
const userQueues = new Map();
const activeSessions = new Map(); // Tracks the real Hermes Session ID for a user

// Cleanup old message IDs every hour
setInterval(() => processedMessages.clear(), 3600000);

// --- 1. Standard Webhook (MUST BE FIRST) ---
// Note: No global express.json() here because it breaks LINE's signature validation
app.post('/webhook', middleware(config), (req, res) => {
  res.status(200).send('OK');
  req.body.events.forEach(event => {
    enqueueEvent(event);
  });
});

// --- 2. Proactive Push Endpoint (Use local express.json()) ---
app.post('/push', express.json(), async (req, res) => {
    const { userId, text } = req.body;
    if (!userId || !text) {
        return res.status(400).json({ error: 'Missing userId or text' });
    }

    try {
        console.log(`[Proactive Push] Sending to ${userId}: ${text.substring(0, 20)}...`);
        await axios.post('https://api.line.me/v2/bot/message/push', {
            to: userId,
            messages: [{ type: 'text', text: text }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.channelAccessToken}`
            }
        });
        res.json({ success: true });
    } catch (err) {
        console.error('[Proactive Push] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

function enqueueEvent(event) {
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
  console.log(`[Queue: ${userId}] Queued message. Position: ${userState.queue.length}`);

  processQueue(userId);
}

async function processQueue(userId) {
  const userState = userQueues.get(userId);
  if (userState.processing) {
    console.log(`[Queue: ${userId}] Already processing. Waiting...`);
    return;
  }

  userState.processing = true;

  while (userState.queue.length > 0) {
    const event = userState.queue.shift();
    try {
      await handleEvent(event);
    } catch (err) {
      console.error(`Error in sequential processing for user ${userId}:`, err.message);
    }
  }

  userState.processing = false;
  console.log(`[Queue: ${userId}] Queue finished.`);
}

async function handleEvent(event) {
  const userId = event.source.userId;
  const userMessage = event.message.text;
  const replyToken = event.replyToken;

  try {
    console.log(`[Session: ${userId}] Processing: ${userMessage}`);

    // 1. Show Loading (This should work now that signature is verified)
    try {
        await axios.post('https://api.line.me/v2/bot/chat/loading/start', 
            { chatId: userId, loadingSeconds: 60 },
            { headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.channelAccessToken}` 
            }}
        );
    } catch (e) {
        console.error('Loading indicator error:', e.message);
    }

    // 2. Forward to Hermes
    const activeSessionId = activeSessions.get(userId) || userId;
    console.log(`[Session: ${userId}] Forwarding to Hermes (Session-Id: ${activeSessionId})...`);

    const response = await axios.post(HERMES_API_URL, {
      model: "hermes-agent",
      messages: [{ role: "user", content: userMessage }],
      stream: false
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.HERMES_API_KEY}`,
        'X-Hermes-Session-Id': activeSessionId
      },
      timeout: 600000 
    });

    const newSessionId = response.headers['x-hermes-session-id'];
    if (newSessionId && newSessionId !== activeSessionId) {
        console.log(`[Session: ${userId}] Context compressed! New Session ID: ${newSessionId}`);
        activeSessions.set(userId, newSessionId);
    }

    const botResponse = response.data.choices[0].message.content;

    // 3. Hybrid Response Mechanism
    try {
        await client.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: botResponse }]
        });
        console.log(`[Session: ${userId}] Replied via Token.`);
    } catch (lineError) {
        // Fallback if token expired
        console.log(`[Session: ${userId}] Reply failed, attempting Push...`);
        await axios.post('https://api.line.me/v2/bot/message/push', {
            to: userId,
            messages: [{ type: 'text', text: botResponse }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.channelAccessToken}`
            }
        });
        console.log(`[Session: ${userId}] Pushed via UserID.`);
    }

  } catch (error) {
    console.error(`[Session: ${userId}] Error:`, error.message);
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
  console.log(`hermes-line-bridge (Fixed Middleware) listening on port ${port}`);
});
