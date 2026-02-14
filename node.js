const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ===== エンコードテーブル ===== */

const chars = "abcdefghijklmnopqrstuvwxyz0123456789-_";
const map = {};

// a=10, b=11 ... z=35
for (let i = 0; i < 26; i++) {
  map[String.fromCharCode(97 + i)] = String(10 + i);
}

// 0=36 ... 9=45
for (let i = 0; i < 10; i++) {
  map[String(i)] = String(36 + i);
}

// -=46, _=47
map["-"] = "46";
map["_"] = "47";

/* ===== 基本エンコード ===== */

function encodeUsername(username) {
  let result = "";
  for (const c of username) {
    if (!map[c]) continue;
    result += map[c];
  }
  return result;
}

/* ===== データ長長エンコード ===== */

function lengthWrap(encoded) {
  const len = encoded.length.toString();
  const lenLen = len.length.toString();
  return lenLen + len + encoded;
}

/* ===== Scratch API ===== */

async function getFollowers(username) {
  const res = await fetch(
    `https://api.scratch.mit.edu/users/${username}/followers?limit=40`
  );
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

/* ===== クールダウン制御 ===== */

let lastRequestTime = 0;

/* ===== メイン処理 ===== */

app.post("/cloud", async (req, res) => {
  const now = Date.now();

  // 0.5秒以内なら拒否
  if (now - lastRequestTime < 500) {
    return res.json({ status: "cooldown" });
  }

  lastRequestTime = now;

  const request = req.body.request;

  if (!request || request === "0") {
    return res.json({ status: "empty" });
  }

  /* ===== リクエスト解析 ===== */

  const userIdLenLen = parseInt(request[0]);
  const userIdLen = parseInt(
    request.slice(1, 1 + userIdLenLen)
  );

  const userId = request.slice(
    1 + userIdLenLen,
    1 + userIdLenLen + userIdLen
  );

  const encodedUsername = request.slice(
    1 + userIdLenLen + userIdLen
  );

  // ここでは例としてそのままデコード不要で使用
  const username = decodeUsername(encodedUsername);

  /* ===== フォロワー取得 ===== */

  const followers = await getFollowers(username);

  /* ===== ユーザー単位エンコード ===== */

  const wrappedUsers = followers.map(f => {
    const encoded = encodeUsername(f.username);
    return lengthWrap(encoded);
  });

  /* ===== 分割 ===== */

  const returns = splitCloudData(userId, wrappedUsers);

  /* ===== ☁request を0に戻す ===== */
  // 実際にはここでTurboWarp Cloud APIへ0を書き戻す処理を書く
  // 今回はレスポンスとして通知
  res.json({
    requestReset: "0",
    returns
  });
});

/* ===== デコード（簡易） ===== */

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

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
