import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config({ path: "../.env" }); // Ensure it loads .env from the parent directory relative to src

const WEBHOOK_URL =
  "https://rss-feed-scraper.chinyuhsu1023.workers.dev/webhook";

if (!WEBHOOK_URL) {
  console.error(
    "Error: WEBHOOK_URL is not defined in the .env file. Make sure the .env file exists in the 'websocket-webhook-forwarder' directory and contains the WEBHOOK_URL."
  );
  process.exit(1);
}

// Sample data to send
const testPayload = {
  source_name: "BWENEWS",
  news_title: "This is a test message news",
  coins_included: ["BTC", "ETH", "SOL"],
  url: "https://www.bwenews123.com/asdads",
  timestamp: 1745770800,
};

async function sendTestWebhook() {
  console.log(`Attempting to send test webhook to: ${WEBHOOK_URL}`);
  console.log(`Payload: ${JSON.stringify(testPayload, null, 2)}`);

  try {
    const response = await fetch(WEBHOOK_URL!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(testPayload),
    });

    const responseBody = await response.text(); // Read body regardless of status

    if (response.ok) {
      console.log(`Test webhook sent successfully! Status: ${response.status}`);
      console.log(`Response Body: ${responseBody}`);
    } else {
      console.error(`Failed to send test webhook. Status: ${response.status}`);
      console.error(`Response Body: ${responseBody}`);
    }
  } catch (error) {
    console.error("Error sending test webhook:", error);
  }
}

// Execute the function
sendTestWebhook();
