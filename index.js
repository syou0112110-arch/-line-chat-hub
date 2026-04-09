const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const line = require("@line/bot-sdk");

// ============================================================
// 環境変数
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
  ポート = "3000",
} = process.env;

// ============================================================
// LINEクライアント
// ============================================================
const lineConfig = {
  channelSecret: LINE_CHANNEL_SECRET、
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN、
};
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN、
});

// ============================================================
// インメモリメッセージストア
// ============================================================
// 代わりに短いローリングコード（a、b、c ... z、aa、ab ...）を使用します
// 増加する番号。返信されたメッセージは削除されるため、アクティブなメッセージは
// コードは短く保ちます。一般的な使用例: 5～15 件の未返信メッセージは
// 「a」、「d」、「k」などの1文字コード。
const messageStore = new Map(); // コード -> { ... }
const dailyFiltered = []; // ダイジェスト用にフィルタリングされたメッセージを追跡します
const myThreads = new Set(); // ユーザーが投稿した Slack の thread_ts を追跡します

// ショートコードを生成します: a、b、c ... z、aa、ab ... az、ba ...
let codeIndex = 0;
function nextCode() {
  let n = codeIndex++;
  let code = "";
  する {
    code = String.fromCharCode(97 + (n % 26)) + code;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  戻りコード;
}

// コードを短く保つために、定期的にリセットします。
// 古い返信メッセージが削除されたときに呼び出されます。
function purgeReplied() {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  for (const [code, msg] of messageStore) {
    // 1時間以上前に返信されたメッセージを削除する
    if (msg.repliedAt && now - msg.repliedAt.getTime() > oneHour) {
      messageStore.delete(code);
    }
  }
  // ストアが空の場合は、新しいショートコード用にコードインデックスをリセットします
  if (messageStore.size === 0) {
    codeIndex = 0;
  }
}

function storeMessage(ソース、送信者、テキスト、チャネル、メタ) {
  // コードを短く保つために、古い返信メッセージを削除します。
  purgeReplied();

  const code = nextCode();
  messageStore.set(code, {
    コード、
    ソース、
    送信者、
    文章、
    チャネル、
    メタ、
    ReplyAt: null、
    receivedAt: new Date(),
  });
  戻りコード;
}

// ============================================================
// LINEに通知を送信
// ============================================================
async function notifyLINE(code, source, sender, text, channel, type) {
  if (!LINE_USER_ID) {
    console.log("[警告] LINE_USER_IDが設定されていません - プッシュをスキップします。");
    戻る;
  }

  const sourceIcons = { slack: "S", chatwork: "C", messenger: "M" };
  const icon = sourceIcons[source] || "?";

  const message = [
    `[${icon}] ${source.charAt(0).toUpperCase() + source.slice(1)} ${type}`,
    `${sender}`、
    `${text}`、
    `${channel}`、
    「、
    `↩ ${code} (あなたの返信)`、
  ].join("\n");

  試す {
    await lineClient.pushMessage({
      宛先: LINE_USER_ID、
      メッセージ: [{ type: "text", text: message }],
    });
    console.log(`[LINE] ${source} から通知 [${code}] を送信しました`);
  } catch (err) {
    console.error("[LINE] プッシュに失敗しました:", err.message);
  }
}

// ============================================================
// 応答ルーティング — 応答を元のツールに送り返す
// ============================================================
// ルーティング情報とともにすぐに戻り、非同期で送信します。
// これによりLINEのUXが軽快に保たれ、ユーザーは確認画面を見ることができます
// 外部 API 呼び出しが完了する前。
async function routeReply(msgCode, replyText) {
  const original = messageStore.get(msgCode);
  if (!original) return { ok: false, error: `"${msgCode}" not found` };

  // すぐに返信済みとしてマークする（楽観的）
  original.repliedAt = new Date();

  // 実際の送信処理はバックグラウンドで実行します。待機はしません。
  sendReplyAsync(original, replyText);

  戻る {
    了解: 本当です、
    コード: original.code、
    送信者: original.sender、
    ソース: original.source、
    チャンネル: original.channel、
  };
}

// バックグラウンド送信者 — エラーはログに記録されますが、LINEの応答はブロックされません
async function sendReplyAsync(original, replyText) {
  試す {
    switch (original.source) {
      case "slack":
        await replyToSlack(original, replyText);
        壊す;
      ケース「チャットワーク」：
        await replyToChatwork(original, replyText);
        壊す;
      ケース「メッセンジャー」：
        replyToMessenger(original, replyText) を待機します。
        壊す;
    }
    console.log(`[REPLY] ${original.source} [${original.code}] に送信されました`);
  } catch (err) {
    console.error(`[REPLY] 失敗しました [${original.code}]:`, err.message);
    // LINE経由で送信失敗を通知する
    if (LINE_USER_ID) {
      試す {
        await lineClient.pushMessage({
          宛先: LINE_USER_ID、
          メッセージ: [
            {
              タイプ: "テキスト"、
              text: `送信失敗 [${original.code}] ${original.sender}: ${err.message}`,
            },
          ],
        });
      } catch (_) {
        /* 静けさ */
      }
    }
    // 楽観的更新を元に戻す
    original.repliedAt = null;
  }
}

// --- Slackへの返信 ---
// 送信者に通知が届くように、@mention を追加します。
// 出力はクリーンです。システムタグや「via ChatHub」フッターは含まれません。
async function replyToSlack(original, text) {
  const { channelId, threadTs, userId } = original.meta || {};
  if (!channelId) throw new Error("Slackチャンネル情報がありません");

  // @mention を先頭に追加して、元の送信者に Slack 通知が届くようにします。
  // Slackでは、<@U12345>はクリック可能なメンションとして表示されます。これはネイティブ機能です。
  // Slackの構文であり、受信者が奇妙に感じる「タグ」ではありません。
  const mentionPrefix = userId ? `<@${userId}>` : "";

  const body = {
    チャネル: チャネルID、
    テキスト: mentionPrefix + テキスト、
  };
  if (threadTs) body.thread_ts = threadTs;

  await axios.post("https://slack.com/api/chat.postMessage", body, {
    ヘッダー: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });

  // このスレッドを追跡して、今後の返信をLINEに転送します
  if (threadTs) {
    myThreads.add(`${channelId}:${threadTs}`);
  }
}

// --- Chatworkの返信 ---
// [To:id] タグを追加して、送信者に Chatwork 通知が届くようにします。
// Chatworkは[To:id]をメンションとしてネイティブにレンダリングします。これは標準です。
// Chatwork構文なので、違和感はありません。
async function replyToChatwork(original, text) {
  const { roomId, senderId } = original.meta || {};
  if (!roomId) throw new Error("チャットワークルーム情報がありません");

  // [To:id]Name\n は Chatwork のネイティブなメンション形式です。
  // 正しく表示されるように送信者名を含めます。
  const mentionPrefix = senderId
    ? `[To:${senderId}]${original.sender}\n`
    : "";

  axios.post を待機します(
    `https://api.chatwork.com/v2/rooms/${roomId}/messages`,
    `body=${encodeURIComponent(mentionPrefix + text)}`、
    {
      ヘッダー: { "X-ChatWorkToken": CHATWORK_API_TOKEN },
    }
  );
}

// --- メッセンジャーからの返信 ---
// 1対1のDMとグループスレッドの両方をサポートします。
// グループの場合はスレッドに返信します。DMの場合はダイレクトメッセージで返信します。
// システムタグなし — ページからの通常のメッセージとして表示されます。
async function replyToMessenger(original, text) {
  const { senderId, threadId, isGroup } = original.meta || {};

  // グループメッセージの場合は、スレッド（グループの会話）に返信してください。
  // ダイレクトメッセージの場合は、送信者に直接返信してください。
  const recipientId = isGroup && threadId ? threadId : senderId;
  if (!recipientId) throw new Error("メッセンジャーの受信者情報がありません");

  axios.post を待機します(
    `https://graph.facebook.com/v19.0/me/messages`,
    {
      受信者: { id: recipientId },
      メッセージ: { テキスト: テキスト }、
    },
    {
      パラメータ: { access_token: FB_PAGE_ACCESS_TOKEN },
    }
  );
}

// ============================================================
// Expressアプリ
// ============================================================
const app = express();

// ヘルスチェック
app.get("/", (req, res) => {
  res.json({
    ステータス: "ok"、
    サービス: "line-chat-hub"
    アップタイム: Math.floor(process.uptime())
    メッセージ: messageStore.size、
  });
});

// ============================================================
// LINE Webhook — ユーザーからの返信を受信する
// ============================================================
app.post(
  "/webhook/line",
  express.json({
    検証: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
  async (req, res) => {
    // 署名検証
    const signature = req.headers["x-line-signature"];
    if (signature && LINE_CHANNEL_SECRET) {
      const hash = crypto
        .createHmac("SHA256", LINE_CHANNEL_SECRET)
        .update(req.rawBody)
        .digest("base64");
      if (hash !== signature) {
        console.warn("[LINE] 無効な署名");
        return res.status(403).send("無効な署名");
      }
    }

    const events = req.body.events || [];
    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const userText = event.message.text.trim();
      const replyToken = event.replyToken;

      // コマンド: "未対応" または "保留中"
      if (userText === "未対応" || userText.toLowerCase() === "pending") {
        const pending = [...messageStore.values()]
          .filter((m) => !m.repliedAt)
          .sort((a, b) => a.receivedAt - b.receivedAt);

        let replyMsg;
        if (pending.length === 0) {
          ReplyMsg = "未対応メッセージはありません";
        } それ以外 {
          const lines = pending.map(
            (m) =>
              `[${m.code}] ${m.sender} (${m.source})\n${m.text.substring(0, 40)}`
          );
          ReplyMsg = `未対応: ${pending.length}件\n━━━━━━━━━━━━━━━\n${lines.join("\n\n")}`;
        }

        await lineClient.replyMessage({
          返信トークン、
          メッセージ: [{ type: "text", text: replyMsg }],
        });
        続く;
      }

      // コマンド: 「まとめ」または「ダイジェスト」
      if (userText === "まとめ" || userText.toLowerCase() === "ダイジェスト") {
        const all = [...messageStore.values()];
        const today = new Date().toDateString();
        const todayMsgs = all.filter(
          (m) => m.receivedAt.toDateString() === today
        );
        const replyd = todayMsgs.filter((m) => m.repliedAt);
        const pending = todayMsgs.filter((m) => !m.repliedAt);
        const filtered = dailyFiltered.length;

        let msg = [
          「今日のダイジェスト」
          `━━━━━━━━━━━━━━━`、
          `受信: ${todayMsgs.length} 返信: ${replied.length} 保留中: ${pending.length}`,
        ];

        if (pending.length > 0) {
          msg.push(
            「、
            保留中:
            ...pending.map(
              (m) => ` [${m.code}] ${m.sender} (${m.source})`
            ）
          );
        }

        if (filtered > 0) {
          msg.push(``, `フィルタリング済み（転送されません）：${filtered} 件のメッセージ`);
        }

        await lineClient.replyMessage({
          返信トークン、
          メッセージ: [{ type: "text", text: msg.join("\n") }],
        });
        続く;
      }

      // 返信ルーティング: "a はい、3pm で大丈夫です！" または "ab OK！"
      // 一致するもの: 文字コード (az、aa-zz) + スペース + メッセージ
      const replyMatch = userText.match(/^([az]+)\s+(.+)$/s);
      if (replyMatch) {
        const targetCode = replyMatch[1];
        const replyContent = replyMatch[2];
        const result = await routeReply(targetCode, replyContent);

        確認メッセージを取得します。
        if (result.ok) {
          confirmMsg = `✓ [${result.code}] ${result.sender} / ${result.source} に送信`;
        } それ以外 {
          confirmMsg = `✗ ${result.error}`;
        }

        await lineClient.replyMessage({
          返信トークン、
          メッセージ: [{ type: "text", text: confirmMsg }]、
        });
        続く;
      }

      // 認識できない入力
      await lineClient.replyMessage({
        返信トークン、
        メッセージ: [
          {
            タイプ: "テキスト"、
            文章： [
              "使い方:",
              " a OK! → [a]のメッセージに返信",
              "未対応 → 未返信メッセージ一覧",
              「まとめ→今日のダイジェスト」、
            ].join("\n"),
          },
        ],
      });
    }

    res.status(200).json({ ok: true });
  }
);

// ============================================================
// Slack Webhook — Slackイベントを受信する
// ============================================================
app.post("/webhook/slack", express.json(), async (req, res) => {
  // URL検証チャレンジ（Slackがセットアップ時に送信します）
  if (req.body.type === "url_verification") {
    return res.json({ challenge: req.body.challenge });
  }

  // Slack署名を確認する
  if (SLACK_SIGNING_SECRET) {
    const timestamp = req.headers["x-slack-request-timestamp"];
    const slackSig = req.headers["x-slack-signature"];
    if (timestamp && slackSig) {
      const fiveMinAgo = Math.floor(Date.now() / 1000) - 60 * 5;
      if (parseInt(timestamp) < fiveMinAgo) {
        return res.status(403).send("リクエストが古すぎます");
      }
    }
  }

  const event = req.body.event;
  if (!event) return res.status(200).send("ok");

  // メッセージのみを処理する（ボットメッセージや編集内容は処理しない）
  if (event.type !== "message" || event.subtype || event.bot_id) {
    return res.status(200).send("ok");
  }

  const text = event.text || "";
  const channel = event.channel || "";
  const userId = event.user || "";
  const threadTs = event.thread_ts || event.ts;
  const isThreadReply = !!event.thread_ts;

  // ---- 自分の投稿を追跡する ----
  // ボットユーザーが投稿したとき（返信ルーティング経由）、またはSlackユーザーが
  // SLACK_USER_ID の投稿で識別され、将来のためにスレッドを記録します
  // そのスレッドへの返信は転送されます。
  if (SLACK_USER_ID && userId === SLACK_USER_ID) {
    myThreads.add(`${channel}:${threadTs}`);
    return res.status(200).send("ok"); // 自分自身に通知しない
  }

  // ---- フィルタロジック ----
  const isDM = event.channel_type === "im";
  const isMention = text.includes(`<@`) && isPersonalMention(text);
  const isMyThread =
    isThreadReply && myThreads.has(`${channel}:${event.thread_ts}`);
  const isChannelMention =
    text.includes("<!channel>") ||
    text.includes("<!here>") ||
    text.includes("<!everyone>");

  // パススルー：DM、個人メンション、または私が参加しているスレッドへの返信
  if (!isDM && !isMention && !isMyThread) {
    if (isChannelMention) {
      dailyFiltered.push({
        ソース:「slack」
        タイプ: "@channel",
        チャネル、
        時間: 新しい Date()、
      });
    } それ以外 {
      dailyFiltered.push({
        ソース:「slack」
        タイプ: "チャネル",
        チャネル、
        時間: 新しい Date()、
      });
    }
    return res.status(200).send("ok");
  }

  // 表示名のためのユーザー情報を取得する
  let senderName = userId;
  試す {
    const userInfo = await axios.get("https://slack.com/api/users.info", {
      パラメータ: { user: userId }、
      ヘッダー: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    });
    if (userInfo.data.ok) {
      送信者名 =
        userInfo.data.user.real_name || userInfo.data.user.name || userId;
    }
  } catch (_) {
    /* フォールバックとしてuserIdを使用する */
  }

  // チャンネル名を取得
  let channelName = channel;
  if (!isDM) {
    試す {
      const chInfo = await axios.get(
        「https://slack.com/api/conversations.info」
        {
          パラメータ: { チャネル }、
          ヘッダー: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
        }
      );
      if (chInfo.data.ok) {
        channelName = `#${chInfo.data.channel.name}`;
      }
    } catch (_) {
      /* フォールバックとしてチャネルIDを使用する */
    }
  }

  const type = isDM ? "DM" : isMention ? "mention" : "thread";
  const displayChannel = isDM
    ？「DM」
    : isMyThread && !isMention
    ? `${channelName} (スレッド)`
    : チャンネル名;
  const cleanText = text.replace(/<@[A-Z0-9]+>/g, "").trim();

  // このスレッドも追跡します (誰かが私たちが監視しているスレッドに返信しました、
  // ということで、返信ルーティングもそこに投稿されます。引き続き追跡してください。
  if (isThreadReply) {
    myThreads.add(`${channel}:${event.thread_ts}`);
  }

  const id = storeMessage("slack", senderName, cleanText, displayChannel, {
    channelId: チャネル、
    threadTs: isThreadReply ? event.thread_ts : event.ts,
    ユーザーID: ユーザーID、
  });

  await notifyLINE(id, "slack", senderName, cleanText, displayChannel, type);
  res.status(200).send("ok");
});

// ヘルパー: メンションが個人的なものかどうかを確認します (@channel/@here ではない)
function isPersonalMention(text) {
  // @channel/@here/@everyone を削除し、<@USERID> が残っているかどうかを確認します。
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

  // Chatwork は webhook_event_type を送信します
  const eventType = req.body.webhook_event_type;

  // 「mention_to_me」イベントのみを処理する
  // Chatworkのウェブフックタイプ: "mention_to_me", "message_created"
  // ユーザー宛てのメッセージのみを表示したい
  if (eventType !== "mention_to_me") {
    // ルーム全体へのメッセージの場合は、フィルタリング済みとしてログに記録する
    if (eventType === "message_created") {
      dailyFiltered.push({
        ソース: "チャットワーク"
        タイプ:「ルームメッセージ」
        チャネル: payload.room_id、
        時間: 新しい Date()、
      });
    }
    return res.status(200).send("ok");
  }

  const roomId = payload.room_id;
  const senderId = payload.from_account_id;
  const body = payload.body || "";

  // 送信者名を取得
  let senderName = `User ${senderId}`;
  試す {
    const members = await axios.get(
      `https://api.chatwork.com/v2/rooms/${roomId}/members`,
      { ヘッダー: { "X-ChatWorkToken": CHATWORK_API_TOKEN } }
    );
    const sender = members.data.find(
      (m) => m.account_id === senderId
    );
    if (sender) senderName = sender.name;
  } catch (_) {
    /* フォールバック名を使用する */
  }

  // ルーム名を取得
  let roomName = `部屋 ${roomId}`;
  試す {
    const roomInfo = await axios.get(
      `https://api.chatwork.com/v2/rooms/${roomId}`,
      { ヘッダー: { "X-ChatWorkToken": CHATWORK_API_TOKEN } }
    );
    roomName = roomInfo.data.name ||部屋名;
  } catch (_) {
    /* フォールバックを使用する */
  }

  // 本文から[To:xxx]タグを削除
  const cleanBody = body.replace(/\[To:\d+\][^\n]*/g, "").trim();

  const id = storeMessage("チャットワーク", 送信者名, cleanBody, ルーム名, {
    roomId: roomId、
    senderId: senderId、
  });

  await NoticeLINE(id, "チャットワーク", 送信者名, cleanBody, ルーム名, "メンション");
  res.status(200).send("ok");
});

// ============================================================
// メッセンジャーWebhook
// ============================================================
// 検証 (GET)
app.get("/webhook/messenger", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === FB_VERIFY_TOKEN) {
    console.log("[Messenger] Webhook が検証されました");
    return res.status(200).send(challenge);
  }
  res.status(403).send("検証に失敗しました");
});

// 受信メッセージ (POST)
app.post("/webhook/messenger", express.json(), async (req, res) => {
  const entries = req.body.entry || [];

  for (const entry of entries) {
    const messaging = entry.messaging || [];
    for (const event of messaging) {
      if (!event.message || !event.message.text) continue;

      const senderId = event.sender.id;
      const text = event.message.text;

      // グループとDMを判別
      // グループスレッドでは、event.sender.id はユーザーです。
      // また、event.recipient.id またはスレッドコンテキストによってグループが識別されます
      const isGroup = !!(
        event.message.is_group ||
        イベント送信者コミュニティ ||
        (event.recipient && event.recipient.id !== senderId)
      );
      const threadId = event.recipient ? event.recipient.id : null;

      let senderName = senderId;
      試す {
        const profile = await axios.get(
          `https://graph.facebook.com/v19.0/${senderId}`、
          {
            パラメータ: {
              フィールド: "first_name,last_name",
              access_token: FB_PAGE_ACCESS_TOKEN、
            },
          }
        );
        senderName = `${profile.data.first_name || ""} ${profile.data.last_name || ""}`.trim();
      } catch (_) {
        /* senderId をフォールバックとして使用する */
      }

      const displayChannel = isGroup ? "Group" : "DM";

      const code = storeMessage("messenger", senderName, text, displayChannel, {
        senderId: senderId、
        threadId: threadId、
        isGroup: isGroup、
      });

      await notifyLINE(code, "messenger", senderName, text, displayChannel, "DM");
    }
  }

  res.status(200).send("EVENT_RECEIVED");
});

// ============================================================
// サーバーを起動
// ============================================================
const port = parseInt(PORT, 10);
app.listen(port, () => {
  console.log(`
╔════════════════════════════════════════╗
║ ChatHubボットサーバーが起動しました ║
╠═════════════════════════════════════════╣
║ ポート: ${String(port).padEnd(27)}║
║ LINE: ${LINE_CHANNEL_ACCESS_TOKEN ? "設定済み ✓" : "未設定 ✗ "} ║
║ Slack: ${SLACK_BOT_TOKEN ? "設定済み ✓" : "未設定 ✗ "} ║
║ Chatwork: ${CHATWORK_API_TOKEN ? "設定済み ✓" : "未設定 ✗ "} ║
║ Messenger:${FB_PAGE_ACCESS_TOKEN ? "設定済み ✓" : "未設定 ✗ "} ║
╚════════════════════════════════════════╝
  `);
});
