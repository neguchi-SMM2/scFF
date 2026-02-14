const WebSocket = require("ws");
const fetch = require("node-fetch");
const express = require("express");

const app = express();
app.get("/", (req, res) => res.send("FollowSync running"));
app.listen(process.env.PORT || 3000);

/* ===== 設定 ===== */

const PROJECT_ID = "1279558192";
const TURBOWARP_SERVER = "wss://clouddata.turbowarp.org";

let lastRequestTime = 0;

/* ===== エンコード表 ===== */

const map = {};

// a-z → 10-35
for (let i = 0; i < 26; i++) {
  map[String.fromCharCode(97 + i)] = String(10 + i);
}

// 0-9 → 36-45
for (let i = 0; i < 10; i++) {
  map[String(i)] = String(36 + i);
}

map["-"] = "46";
map["_"] = "47";

/* ===== エンコード ===== */

function encodeUsername(username) {
  let result = "";
  for (const c of username.toLowerCase()) {
    if (map[c]) result += map[c];
  }
  return result;
}

function lengthWrap(encoded) {
  const len = encoded.length.toString();
  const lenLen = len.length.toString();
  return lenLen + len + encoded;
}

/* ===== デコード ===== */

function decodeUsername(encoded) {
  let result = "";
  for (let i = 0; i < encoded.length; i += 2) {
    const num = parseInt(encoded.slice(i, i + 2));

    if (num >= 10 && num <= 35)
      result += String.fromCharCode(97 + (num - 10));
    else if (num >= 36 && num <= 45)
      result += String(num - 36);
    else if (num === 46)
      result += "-";
    else if (num === 47)
      result += "_";
  }
  return result;
}

/* ===== Scratch API ===== */

async function getFollowers(username) {
  const res = await fetch(
    `https://api.scratch.mit.edu/users/${username}/followers?limit=40`,
    {
      headers: {
        "User-Agent": "FollowSyncServer/1.0"
      }
    }
  );

  if (!res.ok) {
    console.log("Scratch API error:", res.status);
    return [];
  }

  return await res.json();
}

/* ===== 分割処理 ===== */

function splitCloudData(userIdHeader, wrappedUsers) {
  const MAX = 256;
  const result = [];

  let current = userIdHeader;

  for (const user of wrappedUsers) {
    if (current.length + user.length > MAX) {
      result.push(current);
      current = userIdHeader + user;
    } else {
      current += user;
    }
  }

  if (current.length > userIdHeader.length) {
    result.push(current);
  }

  return result;
}

/* ===== TurboWarp接続（User-Agent必須） ===== */

const ws = new WebSocket(TURBOWARP_SERVER, {
  headers: {
    "User-Agent": "FollowSyncServer/1.0 (Render)"
  }
});

ws.on("open", () => {
  console.log("Connected to TurboWarp");

  ws.send(JSON.stringify({
    method: "handshake",
    user: "FollowSyncServer",
    project_id: PROJECT_ID
  }));

  setInterval(() => {
    ws.send(JSON.stringify({ method: "ping" }));
  }, 30000);
});

/* ===== メッセージ受信 ===== */

ws.on("message", async (msg) => {

  let data;

  // JSONでないメッセージは無視（重要）
  try {
    data = JSON.parse(msg);
  } catch {
    console.log("Non-JSON message:", msg.toString());
    return;
  }

  if (data.method !== "set") return;
  if (data.name !== "☁request") return;

  const request = data.value;
  if (!request || request === "0") return;

  /* ===== 0.5秒クールダウン ===== */

  const now = Date.now();
  if (now - lastRequestTime < 500) {
    console.log("Cooldown active");
    return;
  }
  lastRequestTime = now;

  /* ===== リクエスト解析 ===== */

  const userIdLenLen = parseInt(request[0]);
  const userIdLen = parseInt(request.slice(1, 1 + userIdLenLen));

  const userId = request.slice(
    1 + userIdLenLen,
    1 + userIdLenLen + userIdLen
  );

  const encodedUsername = request.slice(
    1 + userIdLenLen + userIdLen
  );

  const username = decodeUsername(encodedUsername);

  console.log("Request from:", username);

  /* ===== フォロワー取得 ===== */

  const followers = await getFollowers(username);

  const wrappedUsers = followers.map(f => {
    const encoded = encodeUsername(f.username);
    return lengthWrap(encoded);
  });

  const returns = splitCloudData(userId, wrappedUsers);

  /* ===== 既存return初期化 ===== */

  for (let i = 1; i <= 9; i++) {
    ws.send(JSON.stringify({
      method: "set",
      name: `☁return${i}`,
      value: "0"
    }));
  }

  /* ===== return送信 ===== */

  returns.forEach((chunk, index) => {
    if (index >= 9) return;

    ws.send(JSON.stringify({
      method: "set",
      name: `☁return${index + 1}`,
      value: chunk
    }));
  });

  /* ===== requestリセット ===== */

  ws.send(JSON.stringify({
    method: "set",
    name: "☁request",
    value: "0"
  }));

  console.log("Response sent");
});

/* ===== エラー対策 ===== */

ws.on("error", (err) => {
  console.error("WebSocket error:", err);
});

ws.on("close", () => {
  console.log("WebSocket closed");
});
