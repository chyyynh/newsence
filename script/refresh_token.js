// script/refresh_token.js
require("dotenv").config();

const token = process.env.bearer_token;
const client_id = process.env.client_id;
const client_secret = process.env.client_secret;
const refresh_token = process.env.refresh_token;

async function refreshTwitterTokens() {
  if (!refresh_token) {
    throw new Error(
      "No existing Twitter Refresh Token found in (mock) KV. Ensure it's set in the script."
    );
  }

  const params = new URLSearchParams();
  params.append("refresh_token", refresh_token);
  params.append("grant_type", "refresh_token");
  params.append("client_id", client_id); // Client ID is in the body as per user's cURL
  const authHeader = "Basic " + btoa(`${client_id}:${client_secret}`);

  console.log(
    `Attempting to refresh Twitter token using the existing refresh_token...\nRequest body:${params.toString()}`
  );

  const res = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: authHeader,
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const errorText = await res
      .text()
      .catch(() => "Could not read error response body");
    console.error(
      `Failed to refresh Twitter access token. Status: ${res.status}, Response: ${errorText}`
    );
    if (res.status === 400 || res.status === 401) {
      console.log("Refresh token might be invalid or revoked.");
    }
    throw new Error(
      `Failed to refresh Twitter access token: ${res.status} ${res.statusText} - Detail: ${errorText}`
    );
  }

  const data = await res.json();

  const newAccessToken = data.access_token;
  const newRefreshTokenFromResponse = data.refresh_token;
  const expiresIn = data.expires_in || 3600;

  if (!newAccessToken || data.token_type?.toLowerCase() !== "bearer") {
    console.error(
      "Refresh response did not include a valid bearer access_token:",
      data
    );
    throw new Error(
      "Failed to obtain new valid access token from refresh response."
    );
  }

  console.log(
    `New Twitter Access Token obtained: ${newAccessToken}\nExpired In: ${expiresIn}\n\nRefresh Token: ${newRefreshTokenFromResponse}`
  );
}

refreshTwitterTokens();
