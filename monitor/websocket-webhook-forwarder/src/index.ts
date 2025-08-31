import WebSocket, { RawData } from "ws";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

const WEBSOCKET_URL = process.env.WEBSOCKET_URL;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!WEBSOCKET_URL) {
  console.error("Error: WEBSOCKET_URL is not defined in the .env file.");
  process.exit(1);
}

if (!WEBHOOK_URL) {
  console.error("Error: WEBHOOK_URL is not defined in the .env file.");
  process.exit(1);
}

console.log(`Attempting to connect to WebSocket: ${WEBSOCKET_URL}`);
console.log(`Forwarding messages to Webhook: ${WEBHOOK_URL}`);

let ws: WebSocket | null = null;
let reconnectInterval = 5000; // Start with 5 seconds reconnect interval

function connectWebSocket() {
  ws = new WebSocket(WEBSOCKET_URL!);

  ws.on("open", () => {
    console.log("WebSocket connection established.");
    // Reset reconnect interval on successful connection
    reconnectInterval = 5000;
  });

  ws.on("message", async (data: RawData) => {
    const messageString = data.toString();
    console.log("Received message:", messageString);

    try {
      // Attempt to parse the message as JSON
      const messageJson = JSON.parse(messageString);

      // Forward the message to the webhook
      const response = await fetch(WEBHOOK_URL!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(messageJson), // Send the parsed JSON object
      });

      if (response.ok) {
        console.log(
          `Message successfully forwarded to webhook. Status: ${response.status}`
        );
      } else {
        console.error(
          `Failed to forward message. Status: ${
            response.status
          }, Body: ${await response.text()}`
        );
      }
    } catch (error) {
      console.error(
        "Error parsing message as JSON or forwarding to webhook:",
        error
      );
      // Optionally, forward the raw string if JSON parsing fails and it's desired
      // try {
      //   const response = await fetch(WEBHOOK_URL!, {
      //     method: 'POST',
      //     headers: { 'Content-Type': 'text/plain' },
      //     body: messageString,
      //   });
      //   if (!response.ok) {
      //      console.error(`Failed to forward raw message. Status: ${response.status}`);
      //   } else {
      //      console.log('Raw message forwarded successfully.');
      //   }
      // } catch (forwardError) {
      //   console.error('Error forwarding raw message:', forwardError);
      // }
    }
  });

  ws.on("error", (error: Error) => {
    console.error("WebSocket error:", error.message);
    // No need to explicitly call close here, 'close' event will be triggered
  });

  ws.on("close", (code: number, reason: Buffer) => {
    console.log(
      `WebSocket connection closed. Code: ${code}, Reason: ${
        reason.toString() || "No reason provided"
      }`
    );
    ws = null; // Ensure ws is nullified
    console.log(
      `Attempting to reconnect in ${reconnectInterval / 1000} seconds...`
    );
    setTimeout(connectWebSocket, reconnectInterval);
    // Exponential backoff (optional, capped at 1 minute)
    reconnectInterval = Math.min(reconnectInterval * 2, 60000);
  });
}

// Initial connection attempt
connectWebSocket();

// Keep the process running
process.on("SIGINT", () => {
  console.log("SIGINT received. Closing WebSocket connection.");
  if (ws) {
    ws.close();
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received. Closing WebSocket connection.");
  if (ws) {
    ws.close();
  }
  process.exit(0);
});
