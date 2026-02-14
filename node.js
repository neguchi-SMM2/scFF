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
let ws = null;
let pingInterval = null;

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

/* ===== lengthWrapデコード（ユーザー名用） ===== */

function decodeLengthWrap(str, startPos) {
  const lenLen = parseInt(str[startPos]);
  const len = parseInt(str.slice(startPos + 1, startPos + 1 + lenLen));
  const data = str.slice(startPos + 1 + lenLen, startPos + 1 + lenLen + len);
  const nextPos = startPos + 1 + lenLen + len;
  
  return { data, nextPos };
}

/* ===== 単純なデータ長デコード（userId, range用） ===== */

function decodeSimple(str, startPos) {
  const dataLen = parseInt(str[startPos]);
  const data = str.slice(startPos + 1, startPos + 1 + dataLen);
  const nextPos = startPos + 1 + dataLen;
  
  return { data, nextPos };
}

/* ===== Scratch API ===== */

async function getFollowers(username, offset = 0, limit = 40) {
  const res = await fetch(
    `https://api.scratch.mit.edu/users/${username}/followers?offset=${offset}&limit=${limit}`,
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

/* ===== メッセージ受信ハンドラ ===== */

async function handleMessage(msg) {
  let data;

  try {
    data = JSON.parse(msg);
  } catch {
    console.log("Non-JSON message:", msg.toString());
    return;
  }

  if (data.method !== "set") return;
  if (data.name !== "☁ request") return;

  const request = data.value;
  if (!request || request === "0") return;

  /* ===== 0.5秒クールダウン ===== */

  const now = Date.now();
  if (now - lastRequestTime < 500) {
    console.log("Cooldown active");
    return;
  }
  lastRequestTime = now;

  console.log("\n=== Processing Request ===");
  console.log("Raw request:", request);

  /* ===== リクエスト解析 ===== */
  // フォーマット: type + lengthWrap(encodedUsername) + simpleWrap(userId) + simpleWrap(range_start) + simpleWrap(range_end)

  let pos = 0;
  
  // type (1文字)
  const type = request[pos];
  pos += 1;
  console.log("Type:", type);

  // lengthWrap(encodedUsername)
  const usernameResult = decodeLengthWrap(request, pos);
  const encodedUsername = usernameResult.data;
  pos = usernameResult.nextPos;
  console.log("Encoded username:", encodedUsername);

  const username = decodeUsername(encodedUsername);
  console.log("Decoded username:", username);

  // simpleWrap(userId)
  const userIdResult = decodeSimple(request, pos);
  const userId = userIdResult.data;
  pos = userIdResult.nextPos;
  console.log("UserId:", userId);

  // simpleWrap(range_start)
  const rangeStartResult = decodeSimple(request, pos);
  const rangeStart = rangeStartResult.data;
  pos = rangeStartResult.nextPos;
  console.log("Range start:", rangeStart);

  // simpleWrap(range_end)
  const rangeEndResult = decodeSimple(request, pos);
  const rangeEnd = rangeEndResult.data;
  console.log("Range end:", rangeEnd);

  console.log(`Request from: ${username}, userId: ${userId}, range: ${rangeStart}-${rangeEnd}`);

  /* ===== フォロワー取得 ===== */

  const offset = parseInt(rangeStart) - 1;
  const limit = parseInt(rangeEnd) - parseInt(rangeStart) + 1;

  console.log(`Fetching followers: offset=${offset}, limit=${limit}`);

  const followers = await getFollowers(username, offset, limit);
  console.log("Fetched followers:", followers.length);

  const wrappedUsers = followers.map(f => {
    const encoded = encodeUsername(f.username);
    return lengthWrap(encoded);
  });

  const returns = splitCloudData(userId, wrappedUsers);
  console.log("Split into", returns.length, "chunks");

  /* ===== 既存return初期化 ===== */

  for (let i = 1; i <= 9; i++) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        method: "set",
        name: `☁ return${i}`,
        value: "0"
      }));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  /* ===== return送信 ===== */

  for (let i = 0; i < returns.length && i < 9; i++) {
    if (ws.readyState === WebSocket.OPEN) {
      console.log(`Sending return${i + 1}, length: ${returns[i].length}`);
      ws.send(JSON.stringify({
        method: "set",
        name: `☁ return${i + 1}`,
        value: returns[i]
      }));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  /* ===== requestリセット ===== */

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      method: "set",
      name: "☁ request",
      value: "0"
    }));
  }

  console.log("Response sent successfully!\n");
}

/* ===== TurboWarp接続（再接続機能付き） ===== */

function connectWebSocket() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }

  ws = new WebSocket(TURBOWARP_SERVER, {
    headers: {
      "User-Agent": "FollowSyncServer/1.0 contact:https://github.com/yourproject"
    }
  });

  ws.on("open", () => {
    console.log("Connected to TurboWarp");

    const randomNum = Math.floor(Math.random() * 900000) + 100000;
    const username = `player${randomNum}`;
    
    ws.send(JSON.stringify({
      method: "handshake",
      project_id: PROJECT_ID,
      user: username
    }));

    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method: "ping" }));
      }
    }, 30000);
  });

  ws.on("message", handleMessage);

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });

  ws.on("close", (code, reason) => {
    console.log(`WebSocket closed (code: ${code}, reason: ${reason}), reconnecting in 5s...`);
    
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    
    setTimeout(connectWebSocket, 5000);
  });
}

/* ===== 初回接続 ===== */

connectWebSocket();
