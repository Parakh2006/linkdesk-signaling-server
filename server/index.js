// server/index.js
import "dotenv/config";
import http from "http";
import { WebSocketServer } from "ws";
import twilio from "twilio";

const PORT = process.env.PORT || 8080;

// ---------- Basic HTTP (for Render health checks) ----------
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  // A simple homepage so hitting the URL in browser returns 200
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("LinkDesk signaling server is running");
});

// ---------- WebSocket server ----------
const wss = new WebSocketServer({ server });

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ LinkDesk signaling server running on port ${PORT}`);
});

// code -> { host: WebSocket, controller: WebSocket|null }
const sessions = new Map();

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function findSessionBySocket(ws) {
  for (const [code, sess] of sessions.entries()) {
    if (sess.host === ws) return { code, role: "host", sess };
    if (sess.controller === ws) return { code, role: "controller", sess };
  }
  return null;
}

/* -------------------- TWILIO TURN / ICE -------------------- */
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

async function getIceServersFromTwilio() {
  if (!twilioClient) throw new Error("Twilio env vars missing");
  const token = await twilioClient.tokens.create();
  return token.iceServers;
}

/* -------------------- WEBSOCKET -------------------- */
wss.on("connection", (ws) => {
  console.log("✅ Client connected");

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.log("❌ Bad JSON:", raw.toString());
      return;
    }

    console.log("📩 Message received:", msg);

    // ---- TURN / ICE config ----
    if (msg.type === "get-ice") {
      try {
        const iceServers = await getIceServersFromTwilio();
        safeSend(ws, { type: "ice-config", iceServers });
      } catch (e) {
        console.error("❌ ICE fetch failed:", e?.message || e);
        safeSend(ws, {
          type: "ice-config",
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
          warning: "TURN_UNAVAILABLE_USING_STUN_ONLY",
        });
      }
      return;
    }

    // ---- Create session ----
    if (msg.type === "create-session") {
      const code = generateCode();
      sessions.set(code, { host: ws, controller: null });
      ws.__role = "host";
      ws.__code = code;

      console.log("🔑 Session created:", code);
      safeSend(ws, { type: "session-created", code });
      return;
    }

    // ---- Join session ----
    if (msg.type === "join-session") {
      const code = (msg.code || "").toUpperCase();
      const sess = sessions.get(code);

      console.log("🔎 Looking up room:", code, "found:", !!sess);

      if (!sess || !sess.host || sess.host.readyState !== ws.OPEN) {
        console.log("❌ Join failed:", code);
        safeSend(ws, { type: "join-failed", code });
        return;
      }

      sess.controller = ws;
      ws.__role = "controller";
      ws.__code = code;

      safeSend(ws, { type: "join-success", code });
      safeSend(sess.host, { type: "controller-joined", code });
      console.log("✅ Sent join-success to controller and controller-joined to host");
      return;
    }

    // ---- Relay ----
    const code = (msg.code || "").toUpperCase();
    const sess = sessions.get(code);
    if (!sess) return;

    if (sess.host === ws) {
      safeSend(sess.controller, msg);
    } else if (sess.controller === ws) {
      safeSend(sess.host, msg);
    }
  });

  ws.on("close", () => {
    console.log("❌ Client disconnected");

    const found = findSessionBySocket(ws);
    if (!found) return;

    const { code, role, sess } = found;

    if (role === "controller") {
      sess.controller = null;
      console.log("👋 Controller left. Session stays:", code);
      safeSend(sess.host, { type: "controller-left", code });
      return;
    }

    if (role === "host") {
      sessions.delete(code);
      console.log("🗑️ Host left. Session removed:", code);
      safeSend(sess.controller, { type: "host-left", code });
      return;
    }
  });
});
