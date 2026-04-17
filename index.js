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

// Cleanup old message IDs every hour
setInterval(() => processedMessages.clear(), 3600000);

app.post('/webhook', middleware(config), (req, res) => {
  // 1. IMPORTANT: Return 200 OK to LINE immediately to prevent retries
  res.status(200).send('OK');

  // 2. Process events in the background
  req.body.events.forEach(event => {
    enqueueEvent(event);
  });
});

function enqueueEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  const userId = event.source.userId;
  const messageId = event.message.id;

  // De-duplication: Skip if message already seen
  if (processedMessages.has(messageId)) {
    console.log(`Duplicate message ignored: ${messageId}`);
    return;
  }
  processedMessages.add(messageId);

  // Sequential processing per user
  if (!userQueues.has(userId)) {
    userQueues.set(userId, Promise.resolve());
  }

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
  const userMessage = event.message.text;

  try {
    console.log(`[Session: ${userId}] Processing: ${userMessage}`);

    // Start "Loading indicator"
    try {
        await axios.post('https://api.line.me/v2/bot/chat/loading/start', 
            { chatId: userId, loadingSeconds: 60 },
            { headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.channelAccessToken}` 
            }}
        );
    } catch (loadingErr) {
        console.error('Failed to start loading indicator:', loadingErr.message);
    }

    // Forward to Hermes with strict Session-Id
    console.log(`[Session: ${userId}] Forwarding to Hermes...`);
    const response = await axios.post(HERMES_API_URL, {
      model: "hermes-agent",
      messages: [
        { role: "user", content: userMessage }
      ],
      stream: false
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.HERMES_API_KEY}`,
        'X-Hermes-Session-Id': userId // Fixed session ID for continuity
      },
      timeout: 600000 // 10 minutes
    });

    const botResponse = response.data.choices[0].message.content;
    console.log(`[Session: ${userId}] Response received. Replying...`);

    // Reply to LINE
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: botResponse,
      }]
    });
    console.log(`[Session: ${userId}] Success.`);

  } catch (error) {
    console.error(`[Session: ${userId}] Error:`, error.message);
    
    // Attempt to reply with error
    try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: '抱歉，史助理處理時遇到問題（可能是網路延遲）。請稍後再試！',
          }]
        });
    } catch (lineError) {
        // Token likely expired
    }
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
  console.log(`hermes-line-bridge (Sequential Mode) listening on port ${port}`);
});
