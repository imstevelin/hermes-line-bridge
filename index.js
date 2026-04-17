const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
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

// Hermes API configuration
const HERMES_API_URL = process.env.HERMES_API_URL || 'http://localhost:8642/v1/chat/completions';

// Initialize LINE client
const client = new messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken
});
const blobClient = new messagingApi.MessagingApiBlobClient({
  channelAccessToken: config.channelAccessToken
});

// For de-duplication, sequential processing, and dynamic session management
const processedMessages = new Set();
const userQueues = new Map();
const userSessionSuffix = new Map(); // For /reset feature

// Cleanup old message IDs every hour
setInterval(() => processedMessages.clear(), 3600000);

// --- 1. Proactive Push Endpoint ---
app.post('/push', express.json(), async (req, res) => {
    const { userId, text } = req.body;
    if (!userId || !text) return res.status(400).json({ error: 'Missing userId or text' });

    try {
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
        res.status(500).json({ error: err.message });
    }
});

// --- 2. Standard Webhook ---
app.post('/webhook', middleware(config), (req, res) => {
  res.status(200).send('OK');
  req.body.events.forEach(event => {
    enqueueEvent(event);
  });
});

function enqueueEvent(event) {
  if (event.type !== 'message') return;
  if (event.message.type !== 'text' && event.message.type !== 'image') return;

  const userId = event.source.userId;
  const messageId = event.message.id;

  if (processedMessages.has(messageId)) return;
  processedMessages.add(messageId);

  if (!userQueues.has(userId)) userQueues.set(userId, Promise.resolve());

  const currentQueue = userQueues.get(userId);
  const nextInQueue = currentQueue.then(async () => {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error(`Error in sequential processing for user ${userId}:`, err.message);
    }
  });
  userQueues.set(userId, nextInQueue);
}

async function handleEvent(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  
  // Handle Reset Command
  if (event.message.type === 'text') {
      const text = event.message.text.trim();
      if (text === '/reset' || text === '重設對話' || text === '重新開始') {
          userSessionSuffix.set(userId, crypto.randomBytes(3).toString('hex'));
          return client.replyMessage({
              replyToken: replyToken,
              messages: [{ type: 'text', text: '✅ 對話已重置，史助理現在就像剛認識你一樣！' }]
          });
      }
  }

  try {
    console.log(`[Session: ${userId}] Processing ${event.message.type}...`);

    // Show Loading
    try {
        await axios.post('https://api.line.me/v2/bot/chat/loading/start', 
            { chatId: userId, loadingSeconds: 60 },
            { headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.channelAccessToken}` 
            }}
        );
    } catch (e) {}

    // Prepare Messages for Hermes
    let messages = [];
    if (event.message.type === 'text') {
        messages.push({ role: "user", content: event.message.text });
    } else if (event.message.type === 'image') {
        // Download image from LINE
        const stream = await blobClient.getMessageContent(event.message.id);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const base64Image = buffer.toString('base64');
        
        messages.push({
            role: "user",
            content: [
                { type: "text", text: "請分析這張圖片內容。" },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
            ]
        });
    }

    // Determine Session ID (including suffix if reset)
    const suffix = userSessionSuffix.get(userId) || 'default';
    const finalSessionId = `${userId}_${suffix}`;

    // Forward to Hermes
    const response = await axios.post(HERMES_API_URL, {
      model: "hermes-agent",
      messages: messages,
      stream: false
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.HERMES_API_KEY}`,
        'X-Hermes-Session-Id': finalSessionId
      },
      timeout: 600000 
    });

    const botResponse = response.data.choices[0].message.content;

    // Hybrid Reply
    try {
        await client.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: botResponse }]
        });
    } catch (lineError) {
        console.log(`[Session: ${userId}] Reply failed (expired?), using Push...`);
        await axios.post('https://api.line.me/v2/bot/message/push', {
            to: userId,
            messages: [{ type: 'text', text: botResponse }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.channelAccessToken}`
            }
        });
    }

  } catch (error) {
    console.error(`[Session: ${userId}] Error:`, error.message);
  }
}

app.use((err, req, res, next) => {
  if (err instanceof line.SignatureValidationFailed) {
    res.status(401).send(err.signature);
    return;
  }
  next(err);
});

app.listen(port, () => {
  console.log(`hermes-line-bridge (Multimodal) listening on port ${port}`);
});
