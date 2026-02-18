const WebSocket = require("ws");
const fetch = require("node-fetch");
const express = require("express");

const app = express();
const PROJECT_ID = "1279558192";
const TURBOWARP_SERVER = "wss://clouddata.turbowarp.org";
const MAX_CLOUD_LENGTH = 10000;
const MAX_RETURNS = 7;
const CACHE_TTL = 10 * 60 * 1000;
const FILTER_DELETED_ACCOUNTS = false;

let lastRequestTime = 0;
let ws = null;
let pingInterval = null;
let lastUpdateInterval = null;
let queueSizeInterval = null;
let isReconnecting = false;
let isProcessing = false;
const requestQueue = [];
const MAX_QUEUE_SIZE = 10;
const YEAR_2000_TIMESTAMP = new Date('2000-01-01T00:00:00Z').getTime();

/* ===== ダッシュボード用データ ===== */

let totalSearchCount = 0;
const recentSearches = []; // { username, requestType, timestamp }
const MAX_RECENT_SEARCHES = 500;
const ReqTypeNames = {
  "1": "1-followers",
  "2": "2-following", 
  "3": "3-mutual",
  "4": "4-YouFollowThem",
  "5": "5-TheyFollowYou"
};
let wsStatus = "disconnected"; // "connected" / "disconnected" / "reconnecting"
let wsConnectedAt = null;
let wsDisconnectedAt = null;

function addRecentSearch(username, requestType) {
  totalSearchCount++;
  recentSearches.unshift({
    username: username,
    requestType: requestType,
    timestamp: new Date().toISOString()
  });
  if (recentSearches.length > MAX_RECENT_SEARCHES) {
    recentSearches.pop();
  }
}

/* ===== ダッシュボード ===== */

app.get("/", (req, res) => {
  const wsStatusColor = wsStatus === "connected" ? "#22c55e" : wsStatus === "reconnecting" ? "#f59e0b" : "#ef4444";
  const wsStatusText = wsStatus === "connected" ? "接続中" : wsStatus === "reconnecting" ? "再接続中..." : "切断";
  const wsStatusIcon = wsStatus === "connected" ? "●" : wsStatus === "reconnecting" ? "◌" : "○";
  const connectedDuration = wsConnectedAt
    ? Math.floor((Date.now() - wsConnectedAt) / 1000)
    : null;

  const recentSearchesHTML = recentSearches.length === 0
    ? `<tr><td colspan="2" style="text-align:center; color:#888; padding:20px;">まだ検索されていません</td></tr>`
    : recentSearches.map((s, i) => {
        const date = new Date(s.timestamp);
        const timeStr = date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
        const reqTypeName = ReqTypeNames[s.requestType] || `type${s.requestType}`;
        return `
          <tr style="background:${i % 2 === 0 ? '#1e1e2e' : '#16161e'}">
            <td style="padding:10px 16px; font-family:monospace; font-size:14px; color:#cdd6f4">${s.username}</td>
            <td style="padding:10px 16px; font-size:13px; color:#e6e6fa">${reqTypeName}</td>
            <td style="padding:10px 16px; font-size:13px; color:#888">${timeStr}</td>
          </tr>`;
      }).join("");

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>scFF Server Dashboard</title>
  <meta http-equiv="refresh" content="5">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #11111b;
      color: #cdd6f4;
      font-family: 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh;
      padding: 32px 16px;
    }
    .container { max-width: 800px; margin: 0 auto; }
    h1 {
      font-size: 24px;
      font-weight: 700;
      color: #cba6f7;
      margin-bottom: 8px;
    }
    .subtitle {
      font-size: 13px;
      color: #585b70;
      margin-bottom: 32px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: #1e1e2e;
      border: 1px solid #313244;
      border-radius: 12px;
      padding: 20px;
    }
    .card-label {
      font-size: 12px;
      color: #585b70;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }
    .card-value {
      font-size: 36px;
      font-weight: 700;
      color: #89b4fa;
    }
    .status-card {
      background: #1e1e2e;
      border: 1px solid #313244;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .status-dot {
      font-size: 28px;
      color: ${wsStatusColor};
      animation: ${wsStatus === "reconnecting" ? "pulse 1s infinite" : "none"};
    }
    .status-info { flex: 1; }
    .status-title {
      font-size: 16px;
      font-weight: 600;
      color: ${wsStatusColor};
      margin-bottom: 4px;
    }
    .status-detail { font-size: 13px; color: #585b70; }
    .table-card {
      background: #1e1e2e;
      border: 1px solid #313244;
      border-radius: 12px;
      overflow: hidden;
    }
    .table-header {
      padding: 16px;
      border-bottom: 1px solid #313244;
      font-size: 14px;
      font-weight: 600;
      color: #a6adc8;
    }
    table { width: 100%; border-collapse: collapse; }
    th {
      padding: 10px 16px;
      text-align: left;
      font-size: 12px;
      color: #585b70;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      background: #181825;
    }
    tr { transition: background 0.1s; }
    .footer {
      margin-top: 24px;
      text-align: center;
      font-size: 12px;
      color: #45475a;
    }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  </style>
</head>
<body>
  <div class="container">
    <h1>scFF Server</h1>
    <p class="subtitle">5秒ごとに自動更新 — ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>

    <!-- 統計カード -->
    <div class="grid">
      <div class="card">
        <div class="card-label">総検索回数</div>
        <div class="card-value">${totalSearchCount.toLocaleString()}</div>
      </div>
      <div class="card">
        <div class="card-label">処理待ちキュー</div>
        <div class="card-value" style="color:${requestQueue.length > 0 ? '#f38ba8' : '#a6e3a1'}">${(isProcessing ? 1 : 0) + requestQueue.length}</div>
      </div>
    </div>

    <!-- TurboWarp接続状況 -->
    <div class="status-card">
      <div class="status-dot">${wsStatusIcon}</div>
      <div class="status-info">
        <div class="status-title">TurboWarp クラウドサーバー — ${wsStatusText}</div>
        <div class="status-detail">
          ${wsStatus === "connected" && connectedDuration !== null
            ? `接続継続時間: ${Math.floor(connectedDuration / 60)}分 ${connectedDuration % 60}秒`
            : wsDisconnectedAt
            ? `最終切断: ${new Date(wsDisconnectedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`
            : "接続履歴なし"}
        </div>
      </div>
    </div>

    <!-- 最近の検索 -->
    <div class="table-card">
      <div class="table-header">最近の検索（最大500件）</div>
      <table>
        <thead>
          <tr>
            <th>ユーザー名</th>
            <th>リクエストタイプ</th>
            <th>時刻</th>
          </tr>
        </thead>
        <tbody>
          ${recentSearchesHTML}
        </tbody>
      </table>
    </div>

    <div class="footer"><a href="https://scratch.mit.edu/projects/1279558192" target="_blank">FF checker</a></div>
  </div>
</body>
</html>`;

  res.send(html);
});

app.listen(process.env.PORT || 3000);

/* ===== キャッシュ ===== */

const cache = new Map();
const accountExistsCache = new Map();
const followingCache = new Map();

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
  cache.set(key, { data, timestamp: Date.now() });
  console.log(`  Cache SET: ${key} (${data.length} items)`);
  if (cache.size > 50) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

/* ===== フォロー中リストの取得（並列化） ===== */

async function getFollowingList(username) {
  const lowerUsername = username.toLowerCase();
  const cached = followingCache.get(lowerUsername);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`  Following list cache HIT for ${username}`);
    return cached.usernames;
  }

  console.log(`  Fetching following list for ${username}...`);
  const startTime = Date.now();
  const MAX_LIMIT = 40;
  const MAX_FOLLOWING = 500;
  const numRequests = Math.ceil(MAX_FOLLOWING / MAX_LIMIT);

  const requests = [];
  for (let i = 0; i < numRequests; i++) {
    requests.push(getScratchDataBatch(username, "following", i * MAX_LIMIT, MAX_LIMIT));
  }

  const results = await Promise.all(requests);
  const allFollowing = new Set();
  for (const batch of results) {
    if (batch.length === 0) break;
    batch.forEach(user => allFollowing.add(user.username.toLowerCase()));
    if (batch.length < MAX_LIMIT) break;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Following list fetched: ${allFollowing.size} users in ${elapsed}s`);

  followingCache.set(lowerUsername, { usernames: allFollowing, timestamp: Date.now() });
  if (followingCache.size > 20) {
    followingCache.delete(followingCache.keys().next().value);
  }

  return allFollowing;
}

/* ===== フォロワーリストの取得（並列化） ===== */

async function getFollowersList(username) {
  const lowerUsername = username.toLowerCase();
  const cached = cache.get(getCacheKey(username, 'followers_set'));
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`  Followers list cache HIT for ${username}`);
    return cached.data;
  }

  console.log(`  Fetching followers list for ${username}...`);
  const startTime = Date.now();
  const MAX_LIMIT = 40;
  const MAX_FOLLOWERS = 500;
  const numRequests = Math.ceil(MAX_FOLLOWERS / MAX_LIMIT);

  const requests = [];
  for (let i = 0; i < numRequests; i++) {
    requests.push(getScratchDataBatch(username, "followers", i * MAX_LIMIT, MAX_LIMIT));
  }

  const results = await Promise.all(requests);
  const allFollowers = new Set();
  for (const batch of results) {
    if (batch.length === 0) break;
    batch.forEach(user => allFollowers.add(user.username.toLowerCase()));
    if (batch.length < MAX_LIMIT) break;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Followers list fetched: ${allFollowers.size} users in ${elapsed}s`);

  cache.set(getCacheKey(username, 'followers_set'), { data: allFollowers, timestamp: Date.now() });
  return allFollowers;
}

/* ===== ユーティリティ ===== */

function getSecondsSince2000() {
  return Math.floor((Date.now() - YEAR_2000_TIMESTAMP) / 1000).toString();
}

function updateLastUpdate() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ method: "set", name: "☁ last_update", value: getSecondsSince2000() }));
    } catch (error) {
      console.error("Error updating last_update:", error);
    }
  }
}

function updateQueueSize() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      const queueSize = (isProcessing ? 1 : 0) + requestQueue.length;
      ws.send(JSON.stringify({ method: "set", name: "☁ return8", value: queueSize.toString() }));
    } catch (error) {
      console.error("Error updating queue size:", error);
    }
  }
}

function clearAllIntervals() {
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  if (lastUpdateInterval) { clearInterval(lastUpdateInterval); lastUpdateInterval = null; }
  if (queueSizeInterval) { clearInterval(queueSizeInterval); queueSizeInterval = null; }
}

/* ===== エンコード表 ===== */

const map = {};
for (let i = 0; i < 26; i++) map[String.fromCharCode(97 + i)] = String(10 + i);
for (let i = 0; i < 10; i++) map[String(i)] = String(36 + i);
map["-"] = "46";
map["_"] = "47";

function encodeUsername(username) {
  let result = "";
  for (const c of username.toLowerCase()) {
    if (map[c]) result += map[c];
  }
  return result;
}

function lengthWrap(encoded) {
  const len = encoded.length.toString();
  return len.length.toString() + len + encoded;
}

function decodeUsername(encoded) {
  let result = "";
  for (let i = 0; i < encoded.length; i += 2) {
    const num = parseInt(encoded.slice(i, i + 2));
    if (num >= 10 && num <= 35) result += String.fromCharCode(97 + (num - 10));
    else if (num >= 36 && num <= 45) result += String(num - 36);
    else if (num === 46) result += "-";
    else if (num === 47) result += "_";
  }
  return result;
}

function decodeLengthWrap(str, startPos) {
  const lenLen = parseInt(str[startPos]);
  const len = parseInt(str.slice(startPos + 1, startPos + 1 + lenLen));
  const data = str.slice(startPos + 1 + lenLen, startPos + 1 + lenLen + len);
  const nextPos = startPos + 1 + lenLen + len;
  return { data, nextPos };
}

function decodeSimple(str, startPos) {
  const dataLen = parseInt(str[startPos]);
  const data = str.slice(startPos + 1, startPos + 1 + dataLen);
  const nextPos = startPos + 1 + dataLen;
  return { data, nextPos };
}

/* ===== アカウント存在チェック ===== */

async function checkAccountExists(username) {
  const lowerUsername = username.toLowerCase();
  if (accountExistsCache.has(lowerUsername)) return accountExistsCache.get(lowerUsername);
  try {
    const res = await fetch(`https://api.scratch.mit.edu/users/${username}`, {
      headers: { "User-Agent": "FollowSyncServer/1.0" }
    });
    const exists = res.ok;
    accountExistsCache.set(lowerUsername, exists);
    if (accountExistsCache.size > 1000) accountExistsCache.delete(accountExistsCache.keys().next().value);
    return exists;
  } catch (error) {
    console.error(`Error checking account ${username}:`, error);
    return true;
  }
}

async function filterDeletedAccounts(users) {
  if (!FILTER_DELETED_ACCOUNTS || users.length === 0) return users;

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
    if (i % 100 === 0 && i > 0) console.log(`    Checked ${i}/${users.length} accounts...`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Filtered ${users.length - validUsers.length} deleted accounts in ${elapsed}s`);
  return validUsers;
}

/* ===== Scratch API ===== */

async function getScratchDataBatch(username, endpoint, offset, limit) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(
      `https://api.scratch.mit.edu/users/${username}/${endpoint}?offset=${offset}&limit=${limit}`,
      { headers: { "User-Agent": "scFF_Server/1.0" }, signal: controller.signal }
    );
    clearTimeout(timeoutId);
    if (!res.ok) {
      console.log(`Scratch API error: ${res.status} (${endpoint}, offset=${offset}, limit=${limit})`);
      return [];
    }
    return await res.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') console.log(`Request timeout (${endpoint}, offset=${offset})`);
    else console.error(`Request error: ${error.message}`);
    return [];
  }
}

async function getScratchData(username, endpoint, offset, totalLimit) {
  const MAX_LIMIT = 40;
  const numRequests = Math.ceil(totalLimit / MAX_LIMIT);
  console.log(`  Making ${numRequests} parallel requests for ${endpoint}...`);

  const requests = [];
  for (let i = 0; i < numRequests; i++) {
    const currentOffset = offset + (i * MAX_LIMIT);
    const currentLimit = Math.min(MAX_LIMIT, totalLimit - (i * MAX_LIMIT));
    requests.push(getScratchDataBatch(username, endpoint, currentOffset, currentLimit));
  }

  const startTime = Date.now();
  const results = await Promise.all(requests);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  const allData = results.flat().filter(item => item);
  console.log(`  Parallel requests completed in ${elapsed}s (${allData.length} items)`);
  return allData;
}

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
  if (current.length > userIdHeader.length) result.push(current);
  return result;
}

/* ===== リクエスト処理 ===== */

async function processRequest(request) {
  console.log("\n=== Processing Request ===");

  let pos = 0;
  const type = request[pos++];
  console.log("Type:", type);

  const usernameResult = decodeLengthWrap(request, pos);
  const username = decodeUsername(usernameResult.data);
  pos = usernameResult.nextPos;
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

  // ★ダッシュボード用に記録
  addRecentSearch(username, type);

  let users = [];
  const startTime = Date.now();

  try {
    const offset = rangeStart - 1;
    const totalLimit = rangeEnd - rangeStart + 1;

    switch(type) {
      case "1":
        console.log("Fetching followers...");
        users = await getScratchData(username, "followers", offset, totalLimit);
        break;

      case "2":
        console.log("Fetching following...");
        users = await getScratchData(username, "following", offset, totalLimit);
        break;

      case "3":
        console.log("Fetching mutual follows...");
        const [followers3, followingSet3] = await Promise.all([
          getScratchData(username, "followers", offset, totalLimit),
          getFollowingList(username)
        ]);
        users = followers3.filter(f => followingSet3.has(f.username.toLowerCase()));
        console.log(`  Found ${users.length} mutual follows in range`);
        break;

      case "4":
        console.log("Fetching following but not followers...");
        const [following4, followersSet4] = await Promise.all([
          getScratchData(username, "following", offset, totalLimit),
          getFollowersList(username)
        ]);
        users = following4.filter(f => !followersSet4.has(f.username.toLowerCase()));
        console.log(`  Found ${users.length} following but not followers in range`);
        break;

      case "5":
        console.log("Fetching followers but not following...");
        const [followers5, followingSet5] = await Promise.all([
          getScratchData(username, "followers", offset, totalLimit),
          getFollowingList(username)
        ]);
        users = followers5.filter(f => !followingSet5.has(f.username.toLowerCase()));
        console.log(`  Found ${users.length} followers but not following in range`);
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

  users = await filterDeletedAccounts(users);
  console.log(`Valid users after filtering: ${users.length}`);

  let returns;
  if (users.length === 0) {
    console.log("No users found - returning userId only");
    returns = [userId];
  } else {
    const wrappedUsers = users.map(f => lengthWrap(encodeUsername(f.username)));
    returns = splitCloudData(userId, wrappedUsers);
  }

  console.log(`Encoded into ${returns.length} chunks`);
  if (returns.length > MAX_RETURNS) {
    console.warn(`Warning: Data requires ${returns.length} chunks but only ${MAX_RETURNS} available`);
  }

  try {
    for (let i = 0; i < Math.min(returns.length, MAX_RETURNS); i++) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method: "set", name: `☁ return${i + 1}`, value: returns[i] }));
      }
    }

    setImmediate(() => {
      for (let i = returns.length; i < MAX_RETURNS; i++) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ method: "set", name: `☁ return${i + 1}`, value: "0" }));
        }
      }
    });

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ method: "set", name: "☁ request", value: "0" }));
    }

    console.log(`Total time: ${((Date.now() - startTime) / 1000).toFixed(2)}s\n`);
  } catch (error) {
    console.error("Error sending response:", error);
  }
}

/* ===== キュー処理 ===== */

async function processNextRequest() {
  if (isProcessing || requestQueue.length === 0) return;

  isProcessing = true;
  const request = requestQueue.shift();
  console.log(`\n📋 Processing queued request (${requestQueue.length} remaining in queue)`);

  try {
    await processRequest(request);
  } catch (error) {
    console.error("Error processing request:", error);
  } finally {
    isProcessing = false;
    if (requestQueue.length > 0) setTimeout(processNextRequest, 100);
  }
}

async function handleMessage(msg) {
  let data;
  try {
    data = JSON.parse(msg);
  } catch { return; }

  if (data.method === "ping") {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ method: "pong" }));
      } catch (error) {
        console.error("Error sending pong:", error);
      }
    }
    return;
  }

  if (data.method !== "set") return;
  if (data.name !== "☁ request") return;

  const request = data.value;
  if (!request || request === "0") return;

  const now = Date.now();
  if (now - lastRequestTime < 500) {
    console.log("⏱️  Cooldown active - request ignored");
    return;
  }
  lastRequestTime = now;

  if (isProcessing) {
    if (requestQueue.length >= MAX_QUEUE_SIZE) {
      console.log(`⚠️  Queue is full, dropping oldest request`);
      requestQueue.shift();
    }
    requestQueue.push(request);
    console.log(`📥 Request queued (queue size: ${requestQueue.length})`);
  } else {
    isProcessing = true;
    try {
      await processRequest(request);
    } catch (error) {
      console.error("Error processing request:", error);
    } finally {
      isProcessing = false;
      if (requestQueue.length > 0) setTimeout(processNextRequest, 100);
    }
  }
}

/* ===== WebSocket接続 ===== */

function connectWebSocket() {
  if (isReconnecting) return;
  isReconnecting = true;

  wsStatus = "reconnecting";
  clearAllIntervals();

  if (ws) {
    try {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN) ws.close();
    } catch (error) {
      console.error("Error cleaning up old WebSocket:", error);
    }
    ws = null;
  }

  ws = new WebSocket(TURBOWARP_SERVER, {
    headers: { "User-Agent": "scFF_Server/1.0 contact:https://github.com/scFF" }
  });

  ws.on('ping', (data) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.pong(data);
  });

  ws.on("open", () => {
    console.log("Connected to TurboWarp");
    isReconnecting = false;
    wsStatus = "connected";
    wsConnectedAt = Date.now();

    const randomNum = Math.floor(Math.random() * 900000) + 100000;
    const username = `player${randomNum}`;

    try {
      ws.send(JSON.stringify({ method: "handshake", project_id: PROJECT_ID, user: username }));

      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.ping(); } catch (error) { console.error("Error sending ping:", error); }
        }
      }, 20000);

      lastUpdateInterval = setInterval(() => updateLastUpdate(), 5000);
      queueSizeInterval = setInterval(() => updateQueueSize(), 2000);

      setTimeout(() => {
        updateLastUpdate();
        updateQueueSize();
        console.log("Started timers: last_update (5s), queue_size (2s)");
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
    wsStatus = "disconnected";
    wsDisconnectedAt = Date.now();
    wsConnectedAt = null;

    clearAllIntervals();
    isReconnecting = false;

    setTimeout(() => connectWebSocket(), 5000);
  });

  setTimeout(() => {
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      console.log("Connection timeout, retrying...");
      ws.terminate();
      isReconnecting = false;
      setTimeout(connectWebSocket, 2000);
    }
  }, 10000);
}

connectWebSocket();

setInterval(() => {
  const used = process.memoryUsage();
  const wsState = ws ? ws.readyState : 'null';
  console.log(`Memory: ${Math.round(used.heapUsed / 1024 / 1024)}MB / Cache: ${cache.size} / Account: ${accountExistsCache.size} / Following: ${followingCache.size} / WS: ${wsState} / Queue: ${requestQueue.length}`);
}, 60000);
