const { Hono } = require("hono");
const { xAuth } = require("@hono/oauth-providers/x");
const { serve } = require("@hono/node-server");
require("dotenv").config();

const app = new Hono();

console.log("開始執行 x_login.js");

if (!process.env.client_id || !process.env.client_secret) {
  console.error(
    "Error: client_id or client_secret not found in .dev.vars or environment."
  );
  process.exit(1);
}

const twitterAuthMiddleware = xAuth({
  client_id: process.env.client_id,
  client_secret: process.env.client_secret,
  scope: ["tweet.read", "tweet.write", "users.read", "offline.access"],
  redirect_uri: "http://localhost:8787/x/callback",
});

// 處理登入請求，導向 Twitter 授權頁面
app.get("/x/login", twitterAuthMiddleware, (c) => {
  console.log("導向 Twitter 授權頁面...");
  return c.text("正在導向 Twitter 授權...");
});

// Twitter 授權後的回調路由
app.get("/x/callback", twitterAuthMiddleware, async (c) => {
  const token = c.get("token");
  const refreshToken = c.get("refresh-token");
  console.log("token", token);
  console.log("refresh-token", refreshToken);

  const query = c.req.query(); // Log query parameters for debugging
  console.log("Callback query parameters:", query);

  if (token) {
    console.log("成功獲取的使用者存取權杖 (Bearer Token):", token.access_token);
    return c.text(
      "已成功獲取 Twitter 存取權杖！請查看您的伺服器控制台。您可以關閉此視窗。"
    );
  } else {
    console.error("獲取 Twitter 存取權杖失敗。");
    const error = c.get("error");
    const errorDescription = c.get("error_description");
    console.error("錯誤物件:", error);
    console.error("錯誤描述:", errorDescription);
    console.error("完整上下文:", c.get("oauth")); // Log full OAuth context
    return c.text(
      `獲取 Twitter 存取權杖失敗。錯誤: ${error || "未知"}，描述: ${
        errorDescription || "無"
      }。請查看伺服器控制台。`,
      500
    );
  }
});

// For Node.js
const port = 8787;
serve(
  {
    fetch: app.fetch,
    port,
  },
  () => {
    console.log(
      `伺服器已啟動，監聽端口 ${port}。請訪問 http://localhost:${port}/x/login`
    );
  }
);
