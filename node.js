const WebSocket = require("ws");
const fetch = require("node-fetch");
const express = require("express");

const app = express();
app.get("/", (req, res) => res.send("scFF_server running"));
app.listen(process.env.PORT || 3000);

const PROJECT_ID = "1279558192";
const TURBOWARP_SERVER = "wss://clouddata.turbowarp.org";
const MAX_CLOUD_LENGTH = 10000;
const MAX_RETURNS = 8;
const CACHE_TTL = 10 * 60 * 1000;
const FILTER_DELETED_ACCOUNTS = false;

let lastRequestTime = 0;
let ws = null;
let pingInterval = null;
let lastUpdateInterval = null;
let isReconnecting = false;

let isProcessing = false;
const requestQueue = [];
const MAX_QUEUE_SIZE = 10;

const YEAR_2000_TIMESTAMP = new Date('2000-01-01T00:00:00Z').getTime();

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
  const allFollowing = new Set();
  let offset = 0;
  
  const MAX_FOLLOWING = 500;
  
  while (offset < MAX_FOLLOWING) {
    const batch = await getScratchDataBatch(username, "following", offset, MAX_LIMIT);
    
    if (batch.length === 0) break;
    
    batch.forEach(user => allFollowing.add(user.username.toLowerCase()));
    
    if (batch.length < MAX_LIMIT) break;
    
    offset += MAX_LIMIT;
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Following list fetched: ${allFollowing.size} users in ${elapsed}s`);

  followingCache.set(lowerUsername, {
    usernames: allFollowing,
    timestamp: Date.now()
  });

  if (followingCache.size > 20) {
    const oldestKey = followingCache.keys().next().value;
    followingCache.delete(oldestKey);
  }

  return allFollowing;
}

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
  const allFollowers = new Set();
  let offset = 0;
  
  const MAX_FOLLOWERS = 500;
  
  while (offset < MAX_FOLLOWERS) {
    const batch = await getScratchDataBatch(username, "followers", offset, MAX_LIMIT);
    
    if (batch.length === 0) break;
    
    batch.forEach(user => allFollowers.add(user.username.toLowerCase()));
    
    if (batch.length < MAX_LIMIT) break;
    
    offset += MAX_LIMIT;
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Followers list fetched: ${allFollowers.size} users in ${elapsed}s`);

  cache.set(getCacheKey(username, 'followers_set'), {
    data: allFollowers,
    timestamp: Date.now()
  });

  return allFollowers;
}

function getSecondsSince2000() {
  const now = Date.now();
  const secondsSince2000 = Math.floor((now - YEAR_2000_TIMESTAMP) / 1000);
  return secondsSince2000.toString();
}

function updateLastUpdate() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      const seconds = getSecondsSince2000();
      ws.send(JSON.stringify({
        method: "set",
        name: "☁ last_update",
        value: seconds
      }));
    } catch (error) {
      console.error("Error updating last_update:", error);
    }
  }
}

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

const map = {};

for (let i = 0; i < 26; i++) {
  map[String.fromCharCode(97 + i)] = String(10 + i);
}

for (let i = 0; i < 10; i++) {
  map[String(i)] = String(36 + i);
}

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
  const lenLen = len.length.toString();
  return lenLen + len + encoded;
}

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

async function getScratchDataBatch(username, endpoint, offset, limit) {
  const res = await fetch(
    `https://api.scratch.mit.edu/users/${username}/${endpoint}?offset=${offset}&limit=${limit}`,
    {
      headers: {
        "User-Agent": "scFF_Server/1.0"
      }
    }
  );

  if (!res.ok) {
    console.log(`Scratch API error: ${res.status} (${endpoint}, offset=${offset}, limit=${limit})`);
    return [];
  }

  return await res.json();
}

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

async function processRequest(request) {
  console.log("\n=== Processing Request ===");

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
        console.log("Fetching mutual follows...");
        
        const offset3 = rangeStart - 1;
        const totalLimit3 = rangeEnd - rangeStart + 1;
        const followers3 = await getScratchData(username, "followers", offset3, totalLimit3);
        
        const followingSet3 = await getFollowingList(username);
        
        users = followers3.filter(f => followingSet3.has(f.username.toLowerCase()));
        console.log(`  Found ${users.length} mutual follows in range`);
        break;

      case "4":
        console.log("Fetching following but not followers...");
        
        const offset4 = rangeStart - 1;
        const totalLimit4 = rangeEnd - rangeStart + 1;
        const following4 = await getScratchData(username, "following", offset4, totalLimit4);
        
        const followersSet4 = await getFollowersList(username);
        
        users = following4.filter(f => !followersSet4.has(f.username.toLowerCase()));
        console.log(`  Found ${users.length} following but not followers in range`);
        break;

      case "5":
        console.log("Fetching followers but not following...");
        
        const offset5 = rangeStart - 1;
        const totalLimit5 = rangeEnd - rangeStart + 1;
        const followers5 = await getScratchData(username, "followers", offset5, totalLimit5);
        
        const followingSet5 = await getFollowingList(username);
        
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

  const encodeStart = Date.now();
  
  let returns;
  
  if (users.length === 0) {
    console.log("No users found - returning userId only");
    returns = [userId];
  } else {
    const wrappedUsers = users.map(f => {
      const encoded = encodeUsername(f.username);
      return lengthWrap(encoded);
    });

    returns = splitCloudData(userId, wrappedUsers);
  }
  
  const encodeTime = ((Date.now() - encodeStart) / 1000).toFixed(2);
  console.log(`Encoded into ${returns.length} chunks in ${encodeTime}s`);

  if (returns.length > MAX_RETURNS) {
    console.warn(`Warning: Data requires ${returns.length} chunks but only ${MAX_RETURNS} available`);
  }

  const sendStart = Date.now();

  try {
    for (let i = 0; i < Math.min(returns.length, MAX_RETURNS); i++) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          method: "set",
          name: `☁ return${i + 1}`,
          value: returns[i]
        }));
      }
    }

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

async function processNextRequest() {
  if (isProcessing || requestQueue.length === 0) {
    return;
  }

  isProcessing = true;
  const request = requestQueue.shift();
  
  console.log(`\n📋 Processing queued request (${requestQueue.length} remaining in queue)`);
  
  try {
    await processRequest(request);
  } catch (error) {
    console.error("Error processing request:", error);
  } finally {
    isProcessing = false;
    
    if (requestQueue.length > 0) {
      setTimeout(processNextRequest, 100);
    }
  }
}

async function handleMessage(msg) {
  let data;

  try {
    data = JSON.parse(msg);
  } catch {
    return;
  }

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
      console.log(`⚠️  Queue is full (${MAX_QUEUE_SIZE}), dropping oldest request`);
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
      
      if (requestQueue.length > 0) {
        setTimeout(processNextRequest, 100);
      }
    }
  }
}

function connectWebSocket() {
  if (isReconnecting) {
    return;
  }
  isReconnecting = true;

  clearAllIntervals();

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
      "User-Agent": "scFF_Server/1.0 contact:https://github.com/scFF"
    }
  });

  ws.on('ping', (data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.pong(data);
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

      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.ping();
          } catch (error) {
            console.error("Error sending ping:", error);
          }
        }
      }, 20000);

      lastUpdateInterval = setInterval(() => {
        updateLastUpdate();
      }, 5000);

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
  // console.log(`Memory: ${Math.round(used.heapUsed / 1024 / 1024)}MB / Cache: ${cache.size} / Account: ${accountExistsCache.size} / Following: ${followingCache.size} / WS: ${wsState} / Queue: ${requestQueue.length}`);
}, 60000);
