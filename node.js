const WebSocket = require("ws");
const fetch = require("node-fetch");
const express = require("express");

const app = express();
app.get("/", (req, res) => res.send("FollowSync running"));
app.listen(process.env.PORT || 3000);

/* ===== 設定 ===== */

const PROJECT_ID = "1279558192";
const TURBOWARP_SERVER = "wss://clouddata.turbowarp.org";
const MAX_CLOUD_LENGTH = 10000; // TurboWarpは制限なし
const MAX_RETURNS = 20; // ☁return1～20
const CACHE_TTL = 10 * 60 * 1000; // 10分間キャッシュ

let lastRequestTime = 0;
let ws = null;
let pingInterval = null;

/* ===== キャッシュ ===== */

const cache = new Map();

function getCacheKey(username, type) {
  return `${username.toLowerCase()}_${type}`;
}

function getCache(username, type) {
  const key = getCacheKey(username, type);
  const cached = cache.get(key);
  
  if (!cached) return null;
  
  // 期限切れチェック
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  
  console.log(`  Cache HIT: ${key} (${cached.data.length} items)`);
  return cached.data;
}

function setCache(username, type, data) {
  const key = getCacheKey(username, type);
  cache.set(key, {
    data: data,
    timestamp: Date.now()
  });
  console.log(`  Cache SET: ${key} (${data.length} items)`);
  
  // メモリ管理：キャッシュが多すぎる場合は古いものを削除
  if (cache.size > 50) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
    console.log(`  Cache cleaned: removed ${oldestKey}`);
  }
}

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
    
    const batch = await getScratchDataBatch(username, endpoint, currentOffset, batchLimit);
    
    if (batch.length === 0) {
      break;
    }
    
    allData.push(...batch);
    
    currentOffset += batchLimit;
    remaining -= batchLimit;
    
    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }

  return allData;
}

/* ===== 全データ取得（キャッシュ対応） ===== */

async function getAllScratchData(username, endpoint) {
  // キャッシュチェック
  const cached = getCache(username, endpoint);
  if (cached) {
    return cached;
  }

  const MAX_LIMIT = 40;
  const allData = [];
  
  let offset = 0;
  let requestCount = 0;
  const startTime = Date.now();
  
  while (true) {
    requestCount++;
    
    if (requestCount % 25 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  Progress: ${allData.length} ${endpoint} (${requestCount} requests, ${elapsed}s)`);
    }
    
    const batch = await getScratchDataBatch(username, endpoint, offset, MAX_LIMIT);
    
    if (batch.length === 0) {
      break;
    }
    
    allData.push(...batch);
    
    if (batch.length < MAX_LIMIT) {
      break;
    }
    
    offset += MAX_LIMIT;
    
    // レート制限対策
    await new Promise(resolve => setTimeout(resolve, 80));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Completed: ${allData.length} ${endpoint} (${requestCount} requests, ${elapsed}s)`);
  
  // キャッシュに保存
  setCache(username, endpoint, allData);
  
  return allData;
}

/* ===== 相互フォロー取得 ===== */

async function getMutualFollows(username, rangeStart, rangeEnd) {
  console.log("Fetching mutual follows...");
  
  const [followers, following] = await Promise.all([
    getAllScratchData(username, "followers"),
    getAllScratchData(username, "following")
  ]);

  const followingSet = new Set(following.map(u => u.username.toLowerCase()));
  const mutualFollows = followers.filter(f => 
    followingSet.has(f.username.toLowerCase())
  );

  console.log(`Found ${mutualFollows.length} mutual follows`);

  const offset = rangeStart - 1;
  const limit = rangeEnd - rangeStart + 1;
  const result = mutualFollows.slice(offset, offset + limit);

  return result;
}

/* ===== フォロー中だがフォロワーでない取得（type=4） ===== */

async function getFollowingNotFollowers(username, rangeStart, rangeEnd) {
  console.log("Fetching following but not followers...");
  
  const [followers, following] = await Promise.all([
    getAllScratchData(username, "followers"),
    getAllScratchData(username, "following")
  ]);

  const followersSet = new Set(followers.map(u => u.username.toLowerCase()));
  const result = following.filter(f => 
    !followersSet.has(f.username.toLowerCase())
  );

  console.log(`Found ${result.length} users (following but not followers)`);

  const offset = rangeStart - 1;
  const limit = rangeEnd - rangeStart + 1;
  return result.slice(offset, offset + limit);
}

/* ===== フォロワーだがフォロー中でない取得（type=5） ===== */

async function getFollowersNotFollowing(username, rangeStart, rangeEnd) {
  console.log("Fetching followers but not following...");
  
  const [followers, following] = await Promise.all([
    getAllScratchData(username, "followers"),
    getAllScratchData(username, "following")
  ]);

  const followingSet = new Set(following.map(u => u.username.toLowerCase()));
  const result = followers.filter(f => 
    !followingSet.has(f.username.toLowerCase())
  );

  console.log(`Found ${result.length} users (followers but not following)`);

  const offset = rangeStart - 1;
  const limit = rangeEnd - rangeStart + 1;
  return result.slice(offset, offset + limit);
}

/* ===== 分割処理（TurboWarp対応） ===== */

function splitCloudData(userIdHeader, wrappedUsers) {
  const result = [];
  let current = userIdHeader;

  for (const user of wrappedUsers) {
    if (current.length + user.length > MAX_CLOUD_LENGTH) {
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
  
  const type = request[pos];
  pos += 1;
  console.log("Type:", type);

  const usernameResult = decodeLengthWrap(request, pos);
  const encodedUsername = usernameResult.data;
  pos = usernameResult.nextPos;

  const username = decodeUsername(encodedUsername);
  console.log("Username:", username);

  const userIdResult = decodeSimple(request, pos);
  const userId = userIdResult.data;
  pos = userIdResult.nextPos;
  console.log("UserId:", userId);

  const rangeStartResult = decodeSimple(request, pos);
  const rangeStart = parseInt(rangeStartResult.data);
  pos = rangeStartResult.nextPos;

  const rangeEndResult = decodeSimple(request, pos);
  const rangeEnd = parseInt(rangeEndResult.data);
  
  console.log(`Range: ${rangeStart}-${rangeEnd}`);

  /* ===== データ取得（タイプ別） ===== */

  let users = [];
  const startTime = Date.now();

  try {
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
        users = await getMutualFollows(username, rangeStart, rangeEnd);
        break;

      case "4":
        users = await getFollowingNotFollowers(username, rangeStart, rangeEnd);
        break;

      case "5":
        users = await getFollowersNotFollowing(username, rangeStart, rangeEnd);
        break;

      default:
        console.log("Unknown request type:", type);
        return;
    }
  } catch (error) {
    console.error("Error fetching data:", error);
    // エラー時は空のデータを返す
    users = [];
  }

  const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`Fetched ${users.length} users in ${elapsedTime}s`);

  /* ===== データエンコード ===== */

  const wrappedUsers = users.map(f => {
    const encoded = encodeUsername(f.username);
    return lengthWrap(encoded);
  });

  const returns = splitCloudData(userId, wrappedUsers);
  console.log(`Split into ${returns.length} chunks`);

  if (returns.length > MAX_RETURNS) {
    console.warn(`Warning: Data requires ${returns.length} chunks but only ${MAX_RETURNS} available`);
  }

  /* ===== return送信（初期化なし） ===== */

  for (let i = 0; i < Math.min(returns.length, MAX_RETURNS); i++) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        method: "set",
        name: `☁ return${i + 1}`,
        value: returns[i]
      }));
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }

  // 使わなかったreturnを0にクリア
  for (let i = returns.length; i < MAX_RETURNS; i++) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        method: "set",
        name: `☁ return${i + 1}`,
        value: "0"
      }));
      await new Promise(resolve => setTimeout(resolve, 30));
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

// メモリ使用量の定期監視
setInterval(() => {
  const used = process.memoryUsage();
  console.log(`Memory: ${Math.round(used.heapUsed / 1024 / 1024)}MB / Cache: ${cache.size} entries`);
}, 60000); // 1分ごと
