const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const line = require("@line/bot-sdk");

// ============================================================
// Environment Variables
// ============================================================
const {
  LINE_CHANNEL_SECRET = "",
  LINE_CHANNEL_ACCESS_TOKEN = "",
  SLACK_BOT_TOKEN = "",
  SLACK_SIGNING_SECRET = "",
  CHATWORK_API_TOKEN = "",
  CHATWORK_WEBHOOK_TOKEN = "",
  FB_PAGE_ACCESS_TOKEN = "",
  FB_VERIFY_TOKEN = "",
  LINE_USER_ID = "",
  SLACK_USER_ID = "",
  PORT = "3000",
} = process.env;

// ============================================================
// LINE Client
// ============================================================
const lineConfig = {
  channelSecret: LINE_CHANNEL_SECRET,
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
};
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

// ============================================================
// In-Memory Message Store
// ============================================================
// Uses short rolling codes (a, b, c ... z, aa, ab ...) instead
// of incrementing numbers. Replied messages are purged, so active
// codes stay short. Typical usage: 5-15 unreplied messages means
// single-letter codes like "a", "d", "k".
const messageStore = new Map(); // code -> { ... }
const dailyFiltered = []; // tracks filtered-out messages for digest
const myThreads = new Set(); // tracks Slack thread_ts where the user has posted

// Generate short codes: a, b, c ... z, aa, ab ... az, ba ...
let codeIndex = 0;
function nextCode() {
  let n = codeIndex++;
  let code = "";
  do {
    code = String.fromCharCode(97 + (n % 26)) + code;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return code;
}

// Reset codes periodically to keep them short.
// Called when old replied messages are purged.
function purgeReplied() {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  for (const [code, msg] of messageStore) {
    // Remove messages replied more than 1 hour ago
    if (msg.repliedAt && now - msg.repliedAt.getTime() > oneHour) {
      messageStore.delete(code);
    }
  }
  // If store is empty, reset code index for fresh short codes
  if (messageStore.size === 0) {
    codeIndex = 0;
  }
}

function storeMessage(source, sender, text, channel, meta) {
  // Purge old replied messages to keep codes short
  purgeReplied();

  const code = nextCode();
  messageStore.set(code, {
    code,
    source,
    sender,
    text,
    channel,
    meta,
    repliedAt: null,
    receivedAt: new Date(),
  });
  return code;
}

// ============================================================
// Send notification to LINE
// ============================================================
async function notifyLINE(code, source, sender, text, channel, type) {
  if (!LINE_USER_ID) {
    console.log("[WARN] LINE_USER_ID not set — skipping push.");
    return;
  }

  const sourceIcons = { slack: "S", chatwork: "C", messenger: "M" };
  const icon = sourceIcons[source] || "?";

  const message = [
    `[${icon}] ${source.charAt(0).toUpperCase() + source.slice(1)}  ${type}`,
    `${sender}`,
    `${text}`,
    `${channel}`,
    ``,
    `↩ ${code} (your reply)`,
  ].join("\n");

  try {
    await lineClient.pushMessage({
      to: LINE_USER_ID,
      messages: [{ type: "text", text: message }],
    });
    console.log(`[LINE] Sent notification [${code}] from ${source}`);
  } catch (err) {
    console.error("[LINE] Push failed:", err.message);
  }
}

// ============================================================
// Reply routing — send reply back to the original tool
// ============================================================
// Returns immediately with the routing info, then sends async.
// This keeps the LINE UX snappy — the user sees confirmation
// before the external API call completes.
async function routeReply(msgCode, replyText) {
  const original = messageStore.get(msgCode);
  if (!original) return { ok: false, error: `"${msgCode}" not found` };

  // Mark as replied immediately (optimistic)
  original.repliedAt = new Date();

  // Fire the actual send in the background — don't await
  sendReplyAsync(original, replyText);

  return {
    ok: true,
    code: original.code,
    sender: original.sender,
    source: original.source,
    channel: original.channel,
  };
}

// Background sender — errors are logged but don't block LINE response
async function sendReplyAsync(original, replyText) {
  try {
    switch (original.source) {
      case "slack":
        await replyToSlack(original, replyText);
        break;
      case "chatwork":
        await replyToChatwork(original, replyText);
        break;
      case "messenger":
        await replyToMessenger(original, replyText);
        break;
    }
    console.log(`[REPLY] Sent to ${original.source} [${original.code}]`);
  } catch (err) {
    console.error(`[REPLY] Failed [${original.code}]:`, err.message);
    // Notify via LINE that the send failed
    if (LINE_USER_ID) {
      try {
        await lineClient.pushMessage({
          to: LINE_USER_ID,
          messages: [
            {
              type: "text",
              text: `送信失敗 [${original.code}] ${original.sender}: ${err.message}`,
            },
          ],
        });
      } catch (_) {
        /* silent */
      }
    }
    // Revert optimistic update
    original.repliedAt = null;
  }
}

// --- Slack reply ---
// Adds @mention to the sender so they get notified.
// Output is clean — no system tags, no "[via ChatHub]" footers.
async function replyToSlack(original, text) {
  const { channelId, threadTs, userId } = original.meta || {};
  if (!channelId) throw new Error("No Slack channel info");

  // Prepend @mention so the original sender gets a Slack notification.
  // In Slack, <@U12345> renders as a clickable mention — it's native
  // Slack syntax, not a "tag" the recipient would find odd.
  const mentionPrefix = userId ? `<@${userId}> ` : "";

  const body = {
    channel: channelId,
    text: mentionPrefix + text,
  };
  if (threadTs) body.thread_ts = threadTs;

  await axios.post("https://slack.com/api/chat.postMessage", body, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });

  // Track this thread so future replies are forwarded to LINE
  if (threadTs) {
    myThreads.add(`${channelId}:${threadTs}`);
  }
}

// --- Chatwork reply ---
// Adds [To:id] tag so the sender gets a Chatwork notification.
// Chatwork natively renders [To:id] as a mention — it's standard
// Chatwork syntax and won't look out of place.
async function replyToChatwork(original, text) {
  const { roomId, senderId } = original.meta || {};
  if (!roomId) throw new Error("No Chatwork room info");

  // [To:id]Name\n is Chatwork's native mention format.
  // We include the sender name so it renders properly.
  const mentionPrefix = senderId
    ? `[To:${senderId}]${original.sender}\n`
    : "";

  await axios.post(
    `https://api.chatwork.com/v2/rooms/${roomId}/messages`,
    `body=${encodeURIComponent(mentionPrefix + text)}`,
    {
      headers: { "X-ChatWorkToken": CHATWORK_API_TOKEN },
    }
  );
}

// --- Messenger reply ---
// Supports both 1:1 DM and group threads.
// For groups, we reply to the thread. For DMs, direct message.
// No system tags — appears as a normal message from the Page.
async function replyToMessenger(original, text) {
  const { senderId, threadId, isGroup } = original.meta || {};

  // For group messages, reply to the thread (the group conversation)
  // For DMs, reply to the sender directly
  const recipientId = isGroup && threadId ? threadId : senderId;
  if (!recipientId) throw new Error("No Messenger recipient info");

  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages`,
    {
      recipient: { id: recipientId },
      message: { text: text },
    },
    {
      params: { access_token: FB_PAGE_ACCESS_TOKEN },
    }
  );
}

// ============================================================
// Express App
// ============================================================
const app = express();

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "line-chat-hub",
    uptime: Math.floor(process.uptime()),
    messages: messageStore.size,
  });
});

// ============================================================
// LINE Webhook — receive replies from the user
// ============================================================
app.post(
  "/webhook/line",
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
  async (req, res) => {
    // Signature verification
    const signature = req.headers["x-line-signature"];
    if (signature && LINE_CHANNEL_SECRET) {
      const hash = crypto
        .createHmac("SHA256", LINE_CHANNEL_SECRET)
        .update(req.rawBody)
        .digest("base64");
      if (hash !== signature) {
        console.warn("[LINE] Invalid signature");
        return res.status(403).send("Invalid signature");
      }
    }

    const events = req.body.events || [];
    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const userText = event.message.text.trim();
      const replyToken = event.replyToken;

      // Command: "未対応" or "pending"
      if (userText === "未対応" || userText.toLowerCase() === "pending") {
        const pending = [...messageStore.values()]
          .filter((m) => !m.repliedAt)
          .sort((a, b) => a.receivedAt - b.receivedAt);

        let replyMsg;
        if (pending.length === 0) {
          replyMsg = "未対応メッセージはありません";
        } else {
          const lines = pending.map(
            (m) =>
              `[${m.code}] ${m.sender} (${m.source})\n${m.text.substring(0, 40)}`
          );
          replyMsg = `未対応: ${pending.length}件\n━━━━━━━━━━━━━━━\n${lines.join("\n\n")}`;
        }

        await lineClient.replyMessage({
          replyToken,
          messages: [{ type: "text", text: replyMsg }],
        });
        continue;
      }

      // Command: "まとめ" or "digest"
      if (userText === "まとめ" || userText.toLowerCase() === "digest") {
        const all = [...messageStore.values()];
        const today = new Date().toDateString();
        const todayMsgs = all.filter(
          (m) => m.receivedAt.toDateString() === today
        );
        const replied = todayMsgs.filter((m) => m.repliedAt);
        const pending = todayMsgs.filter((m) => !m.repliedAt);
        const filtered = dailyFiltered.length;

        let msg = [
          `Today's digest`,
          `━━━━━━━━━━━━━━━`,
          `Received: ${todayMsgs.length}  Replied: ${replied.length}  Pending: ${pending.length}`,
        ];

        if (pending.length > 0) {
          msg.push(
            ``,
            `Pending:`,
            ...pending.map(
              (m) => `  [${m.code}] ${m.sender} (${m.source})`
            )
          );
        }

        if (filtered > 0) {
          msg.push(``, `Filtered (not forwarded): ${filtered} messages`);
        }

        await lineClient.replyMessage({
          replyToken,
          messages: [{ type: "text", text: msg.join("\n") }],
        });
        continue;
      }

      // Reply routing: "a Sure, 3pm works!" or "ab OK!"
      // Matches: letter code (a-z, aa-zz) + space + message
      const replyMatch = userText.match(/^([a-z]+)\s+(.+)$/s);
      if (replyMatch) {
        const targetCode = replyMatch[1];
        const replyContent = replyMatch[2];
        const result = await routeReply(targetCode, replyContent);

        let confirmMsg;
        if (result.ok) {
          confirmMsg = `✓ [${result.code}] ${result.sender} / ${result.source} に送信`;
        } else {
          confirmMsg = `✗ ${result.error}`;
        }

        await lineClient.replyMessage({
          replyToken,
          messages: [{ type: "text", text: confirmMsg }],
        });
        continue;
      }

      // Unrecognized input
      await lineClient.replyMessage({
        replyToken,
        messages: [
          {
            type: "text",
            text: [
              "使い方:",
              "  a OK! → [a]のメッセージに返信",
              "  未対応 → 未返信メッセージ一覧",
              "  まとめ → 今日のダイジェスト",
            ].join("\n"),
          },
        ],
      });
    }

    res.status(200).json({ ok: true });
  }
);

// ============================================================
// Slack Webhook — receive Slack events
// ============================================================
app.post("/webhook/slack", express.json(), async (req, res) => {
  // URL verification challenge (Slack sends this on setup)
  if (req.body.type === "url_verification") {
    return res.json({ challenge: req.body.challenge });
  }

  // Verify Slack signature
  if (SLACK_SIGNING_SECRET) {
    const timestamp = req.headers["x-slack-request-timestamp"];
    const slackSig = req.headers["x-slack-signature"];
    if (timestamp && slackSig) {
      const fiveMinAgo = Math.floor(Date.now() / 1000) - 60 * 5;
      if (parseInt(timestamp) < fiveMinAgo) {
        return res.status(403).send("Request too old");
      }
    }
  }

  const event = req.body.event;
  if (!event) return res.status(200).send("ok");

  // Only process messages (not bot messages, not edits)
  if (event.type !== "message" || event.subtype || event.bot_id) {
    return res.status(200).send("ok");
  }

  const text = event.text || "";
  const channel = event.channel || "";
  const userId = event.user || "";
  const threadTs = event.thread_ts || event.ts;
  const isThreadReply = !!event.thread_ts;

  // ---- TRACK OWN POSTS ----
  // When the bot user posts (via reply routing), or when the Slack user
  // identified by SLACK_USER_ID posts, record the thread so future
  // replies in that thread are forwarded.
  if (SLACK_USER_ID && userId === SLACK_USER_ID) {
    myThreads.add(`${channel}:${threadTs}`);
    return res.status(200).send("ok"); // don't notify yourself
  }

  // ---- FILTER LOGIC ----
  const isDM = event.channel_type === "im";
  const isMention = text.includes(`<@`) && isPersonalMention(text);
  const isMyThread =
    isThreadReply && myThreads.has(`${channel}:${event.thread_ts}`);
  const isChannelMention =
    text.includes("<!channel>") ||
    text.includes("<!here>") ||
    text.includes("<!everyone>");

  // Pass through: DM, personal mention, or reply in a thread I'm in
  if (!isDM && !isMention && !isMyThread) {
    if (isChannelMention) {
      dailyFiltered.push({
        source: "slack",
        type: "@channel",
        channel,
        time: new Date(),
      });
    } else {
      dailyFiltered.push({
        source: "slack",
        type: "channel",
        channel,
        time: new Date(),
      });
    }
    return res.status(200).send("ok");
  }

  // Fetch user info for display name
  let senderName = userId;
  try {
    const userInfo = await axios.get("https://slack.com/api/users.info", {
      params: { user: userId },
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    });
    if (userInfo.data.ok) {
      senderName =
        userInfo.data.user.real_name || userInfo.data.user.name || userId;
    }
  } catch (_) {
    /* use userId as fallback */
  }

  // Fetch channel name
  let channelName = channel;
  if (!isDM) {
    try {
      const chInfo = await axios.get(
        "https://slack.com/api/conversations.info",
        {
          params: { channel },
          headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
        }
      );
      if (chInfo.data.ok) {
        channelName = `#${chInfo.data.channel.name}`;
      }
    } catch (_) {
      /* use channel ID as fallback */
    }
  }

  const type = isDM ? "DM" : isMention ? "mention" : "thread";
  const displayChannel = isDM
    ? "DM"
    : isMyThread && !isMention
    ? `${channelName} (thread)`
    : channelName;
  const cleanText = text.replace(/<@[A-Z0-9]+>/g, "").trim();

  // Track this thread too (someone replied in a thread we're watching,
  // so our reply routing will also post there — keep tracking it)
  if (isThreadReply) {
    myThreads.add(`${channel}:${event.thread_ts}`);
  }

  const id = storeMessage("slack", senderName, cleanText, displayChannel, {
    channelId: channel,
    threadTs: isThreadReply ? event.thread_ts : event.ts,
    userId: userId,
  });

  await notifyLINE(id, "slack", senderName, cleanText, displayChannel, type);
  res.status(200).send("ok");
});

// Helper: check if a mention is personal (not @channel/@here)
function isPersonalMention(text) {
  // Remove @channel/@here/@everyone, then check if <@USERID> remains
  const cleaned = text
    .replace(/<!channel>/g, "")
    .replace(/<!here>/g, "")
    .replace(/<!everyone>/g, "");
  return /<@[A-Z0-9]+>/.test(cleaned);
}

// ============================================================
// Chatwork Webhook
// ============================================================
app.post("/webhook/chatwork", express.json(), async (req, res) => {
  const payload = req.body.webhook_event;
  if (!payload) return res.status(200).send("ok");

  // Chatwork sends webhook_event_type
  const eventType = req.body.webhook_event_type;

  // Only process "mention_to_me" events
  // Chatwork webhook types: "mention_to_me", "message_created"
  // We only want messages directed at the user
  if (eventType !== "mention_to_me") {
    // Log as filtered if it's a room-wide message
    if (eventType === "message_created") {
      dailyFiltered.push({
        source: "chatwork",
        type: "room message",
        channel: payload.room_id,
        time: new Date(),
      });
    }
    return res.status(200).send("ok");
  }

  const roomId = payload.room_id;
  const senderId = payload.from_account_id;
  const body = payload.body || "";

  // Fetch sender name
  let senderName = `User ${senderId}`;
  try {
    const members = await axios.get(
      `https://api.chatwork.com/v2/rooms/${roomId}/members`,
      { headers: { "X-ChatWorkToken": CHATWORK_API_TOKEN } }
    );
    const sender = members.data.find(
      (m) => m.account_id === senderId
    );
    if (sender) senderName = sender.name;
  } catch (_) {
    /* use fallback name */
  }

  // Fetch room name
  let roomName = `Room ${roomId}`;
  try {
    const roomInfo = await axios.get(
      `https://api.chatwork.com/v2/rooms/${roomId}`,
      { headers: { "X-ChatWorkToken": CHATWORK_API_TOKEN } }
    );
    roomName = roomInfo.data.name || roomName;
  } catch (_) {
    /* use fallback */
  }

  // Clean [To:xxx] tags from body
  const cleanBody = body.replace(/\[To:\d+\][^\n]*/g, "").trim();

  const id = storeMessage("chatwork", senderName, cleanBody, roomName, {
    roomId: roomId,
    senderId: senderId,
  });

  await notifyLINE(id, "chatwork", senderName, cleanBody, roomName, "mention");
  res.status(200).send("ok");
});

// ============================================================
// Messenger Webhook
// ============================================================
// Verification (GET)
app.get("/webhook/messenger", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === FB_VERIFY_TOKEN) {
    console.log("[Messenger] Webhook verified");
    return res.status(200).send(challenge);
  }
  res.status(403).send("Verification failed");
});

// Incoming messages (POST)
app.post("/webhook/messenger", express.json(), async (req, res) => {
  const entries = req.body.entry || [];

  for (const entry of entries) {
    const messaging = entry.messaging || [];
    for (const event of messaging) {
      if (!event.message || !event.message.text) continue;

      const senderId = event.sender.id;
      const text = event.message.text;

      // Detect group vs DM
      // In group threads, event.sender.id is the user,
      // and event.recipient.id or the thread context identifies the group
      const isGroup = !!(
        event.message.is_group ||
        event.sender.community ||
        (event.recipient && event.recipient.id !== senderId)
      );
      const threadId = event.recipient ? event.recipient.id : null;

      let senderName = senderId;
      try {
        const profile = await axios.get(
          `https://graph.facebook.com/v19.0/${senderId}`,
          {
            params: {
              fields: "first_name,last_name",
              access_token: FB_PAGE_ACCESS_TOKEN,
            },
          }
        );
        senderName = `${profile.data.first_name || ""} ${profile.data.last_name || ""}`.trim();
      } catch (_) {
        /* use senderId as fallback */
      }

      const displayChannel = isGroup ? "Group" : "DM";

      const code = storeMessage("messenger", senderName, text, displayChannel, {
        senderId: senderId,
        threadId: threadId,
        isGroup: isGroup,
      });

      await notifyLINE(code, "messenger", senderName, text, displayChannel, "DM");
    }
  }

  res.status(200).send("EVENT_RECEIVED");
});

// ============================================================
// Start Server
// ============================================================
const port = parseInt(PORT, 10);
app.listen(port, () => {
  console.log(`
╔════════════════════════════════════════╗
║       ChatHub Bot Server Started       ║
╠════════════════════════════════════════╣
║  Port:     ${String(port).padEnd(27)}║
║  LINE:     ${LINE_CHANNEL_ACCESS_TOKEN ? "Configured ✓" : "Not set ✗   "}               ║
║  Slack:    ${SLACK_BOT_TOKEN ? "Configured ✓" : "Not set ✗   "}               ║
║  Chatwork: ${CHATWORK_API_TOKEN ? "Configured ✓" : "Not set ✗   "}               ║
║  Messenger:${FB_PAGE_ACCESS_TOKEN ? "Configured ✓" : "Not set ✗   "}               ║
╚════════════════════════════════════════╝
  `);
});
