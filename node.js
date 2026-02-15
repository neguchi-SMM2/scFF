const WebSocket = require("ws");
const fetch = require("node-fetch");
const express = require("express");

const app = express();
app.get("/", (req, res) => res.send("FollowSync running"));
app.listen(process.env.PORT || 3000);

/* ===== 設定 ===== */

const PROJECT_ID = "1279558192";
const TURBOWARP_SERVER = "wss://clouddata.turbowarp.org";
const MAX_CLOUD_LENGTH = 10000;
const MAX_RETURNS = 20;
const CACHE_TTL = 10 * 60 * 1000; // 10分間キャッシュ
const FILTER_DELETED_ACCOUNTS = true; // 削除されたアカウントを除外

let lastRequestTime = 0;
let ws = null;
let pingInterval = null;
let lastUpdateInterval = null;
let isReconnecting = false;

// 2000年1月1日 00:00:00 UTCのタイムスタンプ
const YEAR_2000_TIMESTAMP = new Date('2000-01-01T00:00:00Z').getTime();

/* ===== キャッシュ ===== */

const cache = new Map();
const accountExistsCache = new Map();

function getCacheKey(username, type) {
  return `${username.toLowerCase()}_${type}`;
}

function getCache(username, type) {
  const key = getCacheKey(username, type);
  const cached = cache.get(key);
  
  if (!cached) return null;
  
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
  
  if (cache.size > 50) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

/* ===== 2000年からの秒数を計算 ===== */

function getSecondsSince2000() {
  const now = Date.now();
  const secondsSince2000 = Math.floor((now - YEAR_2000_TIMESTAMP) / 1000);
  return secondsSince2000.toString();
}

/* ===== last_update更新処理 ===== */

function updateLastUpdate() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      const seconds = getSecondsSince2000();
      ws.send(JSON.stringify({
        method: "set",
        name: "☁ last_update",  // スペースを追加
        value: seconds
      }));
    } catch (error) {
      console.error("Error updating last_update:", error);
    }
  }
}

/* ===== インターバルのクリーンアップ ===== */

function clearAllIntervals() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  if (lastUpdateInterval) {
    clearInterval(lastUpdateInterval);
    lastUpdateInterval = null;
  }
}

/* ===== エンコード表 ===== */

const map = {};

for (let i = 0; i < 26; i++) {
  map[String.fromCharCode(97 + i)] = String(10 + i);
}

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

/* ===== アカウント存在チェック ===== */

async function checkAccountExists(username) {
  const lowerUsername = username.toLowerCase();
  if (accountExistsCache.has(lowerUsername)) {
    return accountExistsCache.get(lowerUsername);
  }

  try {
    const res = await fetch(
      `https://api.scratch.mit.edu/users/${username}`,
      {
        headers: {
          "User-Agent": "FollowSyncServer/1.0"
        }
      }
    );

    const exists = res.ok;
    accountExistsCache.set(lowerUsername, exists);
    
    if (accountExistsCache.size > 1000) {
      const firstKey = accountExistsCache.keys().next().value;
      accountExistsCache.delete(firstKey);
    }
    
    return exists;
  } catch (error) {
    console.error(`Error checking account ${username}:`, error);
    return true;
  }
}

/* ===== アカウント存在チェック（バッチ処理） ===== */

async function filterDeletedAccounts(users) {
  if (!FILTER_DELETED_ACCOUNTS || users.length === 0) {
    return users;
  }

  console.log(`  Checking ${users.length} accounts for deletion...`);
  const startTime = Date.now();

  const batchSize = 10;
  const validUsers = [];

  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (user) => {
        const exists = await checkAccountExists(user.username);
        return exists ? user : null;
      })
    );

    validUsers.push(...results.filter(u => u !== null));
    
    if (i % 100 === 0 && i > 0) {
      console.log(`    Checked ${i}/${users.length} accounts...`);
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const filtered = users.length - validUsers.length;
  console.log(`  Filtered ${filtered} deleted accounts in ${elapsed}s`);

  return validUsers;
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
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  return allData;
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

      default:
        console.log("Unknown request type:", type);
        return;
    }
  } catch (error) {
    console.error("Error fetching data:", error);
    users = [];
  }

  const fetchTime = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`Fetched ${users.length} users in ${fetchTime}s`);

  /* ===== 削除アカウントのフィルタリング ===== */

  users = await filterDeletedAccounts(users);
  console.log(`Valid users after filtering: ${users.length}`);

  /* ===== データエンコード ===== */

  const encodeStart = Date.now();
  const wrappedUsers = users.map(f => {
    const encoded = encodeUsername(f.username);
    return lengthWrap(encoded);
  });

  const returns = splitCloudData(userId, wrappedUsers);
  const encodeTime = ((Date.now() - encodeStart) / 1000).toFixed(2);
  console.log(`Encoded into ${returns.length} chunks in ${encodeTime}s`);

  if (returns.length > MAX_RETURNS) {
    console.warn(`Warning: Data requires ${returns.length} chunks but only ${MAX_RETURNS} available`);
  }

  /* ===== return送信 ===== */

  const sendStart = Date.now();

  try {
    // データ送信
    for (let i = 0; i < Math.min(returns.length, MAX_RETURNS); i++) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          method: "set",
          name: `☁ return${i + 1}`,
          value: returns[i]
        }));
      }
    }

    // 使わなかったreturnを0にクリア
    setImmediate(() => {
      for (let i = returns.length; i < MAX_RETURNS; i++) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            method: "set",
            name: `☁ return${i + 1}`,
            value: "0"
          }));
        }
      }
    });

    // requestリセット
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        method: "set",
        name: "☁ request",
        value: "0"
      }));
    }

    const sendTime = ((Date.now() - sendStart) / 1000).toFixed(3);
    console.log(`Sent response in ${sendTime}s`);
    console.log(`Total time: ${((Date.now() - startTime) / 1000).toFixed(2)}s\n`);
  } catch (error) {
    console.error("Error sending response:", error);
  }
}

/* ===== TurboWarp接続（再接続機能付き） ===== */

function connectWebSocket() {
  if (isReconnecting) {
    return;
  }
  isReconnecting = true;

  // 既存のインターバルをすべてクリア
  clearAllIntervals();

  // 既存のWebSocketをクリーンアップ
  if (ws) {
    try {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    } catch (error) {
      console.error("Error cleaning up old WebSocket:", error);
    }
    ws = null;
  }

  ws = new WebSocket(TURBOWARP_SERVER, {
    headers: {
      "User-Agent": "FollowSyncServer/1.0 contact:https://github.com/yourproject"
    }
  });

  ws.on("open", () => {
    console.log("Connected to TurboWarp");
    isReconnecting = false;

    const randomNum = Math.floor(Math.random() * 900000) + 100000;
    const username = `player${randomNum}`;
    
    try {
      ws.send(JSON.stringify({
        method: "handshake",
        project_id: PROJECT_ID,
        user: username
      }));

      // ping送信（30秒ごと）
      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ method: "ping" }));
          } catch (error) {
            console.error("Error sending ping:", error);
          }
        }
      }, 30000);

      // last_update更新（5秒ごと）
      lastUpdateInterval = setInterval(() => {
        updateLastUpdate();
      }, 5000);

      // 初回のlast_update送信
      setTimeout(() => {
        updateLastUpdate();
        console.log("Started last_update timer (every 5 seconds)");
      }, 1000);

    } catch (error) {
      console.error("Error during handshake:", error);
    }
  });

  ws.on("message", handleMessage);

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });

  ws.on("close", (code, reason) => {
    console.log(`WebSocket closed (code: ${code}, reason: ${reason || 'no reason'}), reconnecting in 5s...`);
    
    clearAllIntervals();
    isReconnecting = false;
    
    setTimeout(() => {
      connectWebSocket();
    }, 5000);
  });

  // 接続タイムアウト（10秒）
  setTimeout(() => {
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      console.log("Connection timeout, retrying...");
      ws.terminate();
      isReconnecting = false;
      setTimeout(connectWebSocket, 2000);
    }
  }, 10000);
}

/* ===== 初回接続 ===== */

connectWebSocket();

// メモリ使用量の定期監視
setInterval(() => {
  const used = process.memoryUsage();
  const wsState = ws ? ws.readyState : 'null';
  console.log(`Memory: ${Math.round(used.heapUsed / 1024 / 1024)}MB / Cache: ${cache.size} / Account cache: ${accountExistsCache.size} / WS: ${wsState}`);
}, 60000);
