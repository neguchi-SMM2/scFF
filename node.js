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

/* ===== Scratch API（単一リクエスト） ===== */

async function getScratchDataBatch(username, endpoint, offset, limit) {
  const res = await fetch(
    `https://api.scratch.mit.edu/users/${username}/${endpoint}?offset=${offset}&limit=${limit}`,
    {
      headers: {
        "User-Agent": "FollowSyncServer/1.0"
      }
    }
  );

  if (!res.ok) {
    console.log(`Scratch API error: ${res.status} (${endpoint}, offset=${offset}, limit=${limit})`);
    return [];
  }

  return await res.json();
}

/* ===== Scratch API（分割リクエスト対応） ===== */

async function getScratchData(username, endpoint, offset, totalLimit) {
  const MAX_LIMIT = 40;
  const allData = [];
  
  let currentOffset = offset;
  let remaining = totalLimit;

  while (remaining > 0) {
    const batchLimit = Math.min(remaining, MAX_LIMIT);
    
    console.log(`  API call (${endpoint}): offset=${currentOffset}, limit=${batchLimit}`);
    
    const batch = await getScratchDataBatch(username, endpoint, currentOffset, batchLimit);
    
    if (batch.length === 0) {
      break; // これ以上データがない
    }
    
    allData.push(...batch);
    
    currentOffset += batchLimit;
    remaining -= batchLimit;
    
    // 複数回リクエストする場合は少し待機（レート制限対策）
    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  console.log(`  Total fetched (${endpoint}): ${allData.length}`);
  return allData;
}

/* ===== 全データ取得（相互フォロー用） ===== */

async function getAllScratchData(username, endpoint) {
  const MAX_LIMIT = 40;
  const allData = [];
  
  let offset = 0;
  
  while (true) {
    console.log(`  API call (${endpoint}): offset=${offset}, limit=${MAX_LIMIT}`);
    
    const batch = await getScratchDataBatch(username, endpoint, offset, MAX_LIMIT);
    
    if (batch.length === 0) {
      break;
    }
    
    allData.push(...batch);
    
    if (batch.length < MAX_LIMIT) {
      break; // 最後のバッチ
    }
    
    offset += MAX_LIMIT;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`  Total fetched (${endpoint}): ${allData.length}`);
  return allData;
}

/* ===== 相互フォロー取得 ===== */

async function getMutualFollows(username, rangeStart, rangeEnd) {
  console.log("Fetching all followers and following for mutual check...");
  
  const [followers, following] = await Promise.all([
    getAllScratchData(username, "followers"),
    getAllScratchData(username, "following")
  ]);

  // フォロー中のユーザー名をSetに変換（高速検索用）
  const followingSet = new Set(following.map(u => u.username.toLowerCase()));

  // 相互フォローのユーザーを抽出
  const mutualFollows = followers.filter(f => 
    followingSet.has(f.username.toLowerCase())
  );

  console.log(`Found ${mutualFollows.length} mutual follows`);

  // range_startとrange_endで切り出し
  const offset = rangeStart - 1;
  const limit = rangeEnd - rangeStart + 1;
  const result = mutualFollows.slice(offset, offset + limit);

  console.log(`Returning ${result.length} mutual follows (range ${rangeStart}-${rangeEnd})`);
  return result;
}

/* ===== 相互フォローでないユーザー取得 ===== */

async function getNonMutualUsers(username, rangeStart, rangeEnd) {
  console.log("Fetching all followers and following for non-mutual check...");
  
  const [followers, following] = await Promise.all([
    getAllScratchData(username, "followers"),
    getAllScratchData(username, "following")
  ]);

  // フォロワーと相互フォローのユーザー名をSetに変換
  const followersSet = new Set(followers.map(u => u.username.toLowerCase()));
  const followingSet = new Set(following.map(u => u.username.toLowerCase()));

  // 相互フォローでないユーザーを抽出（フォロワーだがフォロー中でない、またはフォロー中だがフォロワーでない）
  const nonMutualUsers = [];

  // フォロワーだがフォロー中でないユーザー
  for (const follower of followers) {
    if (!followingSet.has(follower.username.toLowerCase())) {
      nonMutualUsers.push(follower);
    }
  }

  // フォロー中だがフォロワーでないユーザー
  for (const followingUser of following) {
    if (!followersSet.has(followingUser.username.toLowerCase())) {
      nonMutualUsers.push(followingUser);
    }
  }

  console.log(`Found ${nonMutualUsers.length} non-mutual users`);

  // range_startとrange_endで切り出し
  const offset = rangeStart - 1;
  const limit = rangeEnd - rangeStart + 1;
  const result = nonMutualUsers.slice(offset, offset + limit);

  console.log(`Returning ${result.length} non-mutual users (range ${rangeStart}-${rangeEnd})`);
  return result;
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

  let pos = 0;
  
  // type (1文字)
  const type = request[pos];
  pos += 1;
  console.log("Type:", type);

  // lengthWrap(encodedUsername)
  const usernameResult = decodeLengthWrap(request, pos);
  const encodedUsername = usernameResult.data;
  pos = usernameResult.nextPos;

  const username = decodeUsername(encodedUsername);
  console.log("Username:", username);

  // simpleWrap(userId)
  const userIdResult = decodeSimple(request, pos);
  const userId = userIdResult.data;
  pos = userIdResult.nextPos;
  console.log("UserId:", userId);

  // simpleWrap(range_start)
  const rangeStartResult = decodeSimple(request, pos);
  const rangeStart = parseInt(rangeStartResult.data);
  pos = rangeStartResult.nextPos;

  // simpleWrap(range_end)
  const rangeEndResult = decodeSimple(request, pos);
  const rangeEnd = parseInt(rangeEndResult.data);
  
  console.log(`Range: ${rangeStart}-${rangeEnd}`);

  /* ===== データ取得（タイプ別） ===== */

  let users = [];

  switch(type) {
    case "1":
      console.log("Fetching followers...");
      const offset1 = rangeStart - 1;
      const totalLimit1 = rangeEnd - rangeStart + 1;
      users = await getScratchData(username, "followers", offset1, totalLimit1);
      break;

    case "2":
      console.log("Fetching following...");
      const offset2 = rangeStart - 1;
      const totalLimit2 = rangeEnd - rangeStart + 1;
      users = await getScratchData(username, "following", offset2, totalLimit2);
      break;

    case "3":
      console.log("Fetching mutual follows...");
      users = await getMutualFollows(username, rangeStart, rangeEnd);
      break;

    case "4":
      console.log("Fetching non-mutual users...");
      users = await getNonMutualUsers(username, rangeStart, rangeEnd);
      break;

    default:
      console.log("Unknown request type:", type);
      return;
  }

  console.log(`Successfully fetched ${users.length} users`);

  /* ===== データエンコード ===== */

  const wrappedUsers = users.map(f => {
    const encoded = encodeUsername(f.username);
    return lengthWrap(encoded);
  });

  const returns = splitCloudData(userId, wrappedUsers);
  console.log(`Split into ${returns.length} chunks`);

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
