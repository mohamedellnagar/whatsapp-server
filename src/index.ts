import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import * as kv from "./kv_store.js";
import { initDB } from "./kv_store.js";

// WhatsApp Analytics Dashboard Backend — v2
const app = new Hono();

app.use("*", logger(console.log));

app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  })
);

// Helper: generate UUID
function uuid(): string {
  return crypto.randomUUID();
}

// Helper: get today start ISO
function todayStart(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// Health check
app.get("/make-server-5c5dc789/health", (c) => {
  return c.json({ status: "ok" });
});

// ─────────────────────────────────────────────
// WEBHOOK: Evolution API — GET (health / reachability check)
// ─────────────────────────────────────────────
app.get("/make-server-5c5dc789/webhook/evolution", (c) => {
  console.log("[WEBHOOK-GET] Health check hit");
  return c.json({
    status: "ok",
    message: "Webhook endpoint is reachable. Evolution API should POST to this URL.",
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// WEBHOOK: Evolution API — POST (main handler)
// ─────────────────────────────────────────────
app.post("/make-server-5c5dc789/webhook/evolution", async (c) => {
  try {
    const rawBody = await c.req.text();
    console.log("[WEBHOOK] ── RECEIVED ──", rawBody.substring(0, 3000));

    // Store raw payload for debugging (last 30)
    try {
      const existing = await kv.get("webhook:raw_log");
      const rawLog = Array.isArray(existing) ? existing : [];
      rawLog.unshift({
        at: new Date().toISOString(),
        len: rawBody.length,
        body: rawBody.substring(0, 2000),
        headers: {
          contentType: c.req.header("content-type") || "",
          userAgent: c.req.header("user-agent") || "",
        },
      });
      if (rawLog.length > 30) rawLog.length = 30;
      await kv.set("webhook:raw_log", rawLog);
    } catch (_) {}

    let payload: any;
    try { payload = JSON.parse(rawBody); } catch {
      console.log("[WEBHOOK] Non-JSON body, ignoring");
      return c.json({ status: "ok", note: "non-JSON ignored" });
    }

    const event = payload.event || payload.type || payload.action || "unknown";
    console.log(`[WEBHOOK] Event: "${event}", top-level keys: [${Object.keys(payload).join(", ")}]`);

    // Events we don't process
    const ignoredEvents = [
      "connection.update", "CONNECTION_UPDATE", "qrcode.updated",
      "presence.update", "PRESENCE_UPDATE", "chats.set", "CHATS_SET",
      "contacts.update", "CONTACTS_UPDATE", "groups.upsert", "GROUPS_UPSERT",
      // Status updates (read/delivered) — not actual messages
      "messages.update", "MESSAGES_UPDATE",
      "message.update", "MESSAGE_UPDATE",
      "send.message", "SEND_MESSAGE",
    ];
    if (ignoredEvents.includes(event)) {
      console.log(`[WEBHOOK] Event "${event}" ignored`);
      return c.json({ status: "ok", note: `event ${event} ignored` });
    }

    // Evolution API: data can be in many places depending on version
    let dataRaw = payload.data ?? payload;
    // Handle nested messages array (some v2 versions)
    if (dataRaw?.messages && Array.isArray(dataRaw.messages)) {
      dataRaw = dataRaw.messages;
    }
    const dataItems: any[] = Array.isArray(dataRaw) ? dataRaw : [dataRaw];
    console.log(`[WEBHOOK] Processing ${dataItems.length} data item(s)`);

    // Pre-load conversations ONCE; use per-key dedup check instead of loading all messages (avoids KV 1000-item limit)
    const allConversations = await kv.getByPrefix("conversation:");

    let processedCount = 0;
    let skippedCount = 0;

    for (const data of dataItems) {
      // Skip wrapper-level objects that still have event+data
      if (data?.event && data?.data) {
        console.log("[WEBHOOK] Skipping wrapper-level object");
        continue;
      }

      // Extract remoteJid from many possible locations
      const remoteJid =
        data?.key?.remoteJid || data?.remoteJid || data?.from ||
        data?.message?.key?.remoteJid || data?.jid ||
        data?.chatId || data?.chat || "";
      const phone = remoteJid.replace(/@.*$/, "");
      const isFromMe = data?.key?.fromMe ?? data?.message?.key?.fromMe ?? data?.fromMe ?? false;

      console.log(`[WEBHOOK] Item: jid="${remoteJid}" phone="${phone}" fromMe=${isFromMe} keys=[${Object.keys(data || {}).join(",")}]`);

      // Extract text from many message types
      const m = data?.message || {};
      let messageText =
        m?.conversation || m?.extendedTextMessage?.text ||
        m?.imageMessage?.caption || m?.videoMessage?.caption ||
        m?.documentMessage?.caption || m?.documentMessage?.fileName ||
        m?.buttonsResponseMessage?.selectedDisplayText ||
        m?.listResponseMessage?.title ||
        m?.templateMessage?.hydratedTemplate?.hydratedContentText ||
        m?.contactMessage?.displayName || m?.locationMessage?.name ||
        data?.body || data?.text || data?.caption || "";
      if (!messageText && m?.audioMessage) messageText = "[Audio]";
      if (!messageText && m?.stickerMessage) messageText = "[Sticker]";
      if (!messageText && m?.imageMessage) messageText = "[Image]";
      if (!messageText && m?.videoMessage) messageText = "[Video]";
      if (!messageText && m?.documentMessage) messageText = "[Document]";

      const pushName = data?.pushName || data?.senderName || data?.verifiedBizName ||
                       data?.participant?.name || data?.notifyName || "Customer";
      const rawTs = data?.messageTimestamp || data?.timestamp || data?.t;
      const messageTimestamp = rawTs
        ? new Date(Number(rawTs) * (Number(rawTs) > 9999999999 ? 1 : 1000)).toISOString()
        : new Date().toISOString();
      // Use ONLY data.key.id as the WhatsApp message key (never use CUID from data.id)
      const msgKeyId = data?.key?.id || "";
      // Extract messageType from data.messageType OR detect from message object
      const rawMessageType = data?.messageType
        || (m?.imageMessage ? "imageMessage" : null)
        || (m?.audioMessage ? "audioMessage" : null)
        || (m?.videoMessage ? "videoMessage" : null)
        || (m?.documentMessage ? "documentMessage" : null)
        || (m?.stickerMessage ? "stickerMessage" : null)
        || (m?.conversation || m?.extendedTextMessage ? "conversation" : null)
        || "";

      if (!phone || remoteJid.includes("@g.us") || remoteJid.includes("status@") || phone === "status") {
        console.log(`[WEBHOOK] Skipping: phone="${phone}" jid="${remoteJid}" (group/status/empty)`);
        skippedCount++;
        continue;
      }

      if (msgKeyId) {
        const dedupCheck = await kv.get(`msgdedup:${msgKeyId}`);
        if (dedupCheck) {
          console.log(`[WEBHOOK] Duplicate msgKeyId="${msgKeyId}", skipping`);
          skippedCount++;
          continue;
        }
      }

      // Find or create conversation — match by cleaned phone to avoid @lid/@s.whatsapp.net duplicates
      let conversation = allConversations.find((cv: any) => {
        const cvPhone = (cv.customer_phone || "").replace(/@.*$/, "");
        return cvPhone === phone;
      });
      // Only use pushName from INBOUND messages as the customer name
      const customerName = !isFromMe && pushName && pushName !== "Customer" ? pushName : null;

      if (!conversation) {
        const convId = uuid();
        conversation = { id: convId, customer_phone: phone,
          customer_name: customerName || phone,
          status: "open", assigned_agent_id: null,
          created_at: new Date().toISOString(), last_message_at: messageTimestamp };
        await kv.set(`conversation:${convId}`, conversation);
        allConversations.push(conversation);
      } else {
        conversation.last_message_at = messageTimestamp;
        if (!isFromMe && conversation.status === "resolved") conversation.status = "open";
        // Only update name from inbound messages (don't overwrite with business name)
        if (customerName) conversation.customer_name = customerName;
        await kv.set(`conversation:${conversation.id}`, conversation);
      }

      const newMsgId = uuid();
      const msgObj = {
        id: newMsgId, conversation_id: conversation.id,
        direction: isFromMe ? "outbound" : "inbound",
        sender_type: isFromMe ? "agent" : "customer",
        text: messageText || "(media)", sent_at: messageTimestamp,
        payload: { key: data?.key, msgKeyId, messageType: rawMessageType },
      };
      // Save with conversation-specific prefix (avoids 1000-item limit on getByPrefix("message:"))
      await kv.set(`cmsg:${conversation.id}:${newMsgId}`, msgObj);
      // Save dedup marker
      if (msgKeyId) await kv.set(`msgdedup:${msgKeyId}`, { t: Date.now() });
      // Update conversation with last message info for fast chat listing
      conversation.last_message_text = messageText || "(media)";
      conversation.last_message_direction = isFromMe ? "outbound" : "inbound";
      conversation.msg_count = (conversation.msg_count || 0) + 1;
      await kv.set(`conversation:${conversation.id}`, conversation);
      processedCount++;

      // ── AI Analysis + Auto-Reply ──
      if (!isFromMe && messageText) {
        Promise.race([
          (async () => {
            const cfg = await kv.get("ai_autoresponse:config") as any;
            const mode = cfg?.mode || (cfg?.enabled ? "delayed" : "off");

            if (mode === "instant") {
              // Instant: reply immediately without analysis
              const replyText = await generateRestaurantReply(conversation.id, pushName);
              if (replyText) {
                const evoConfig = await kv.get("evolution:config") as any;
                if (evoConfig?.apiUrl && evoConfig?.apiKey && evoConfig?.instanceName) {
                  const baseUrl = evoConfig.apiUrl.replace(/\/$/, "");
                  const instanceEnc = encodeURIComponent(evoConfig.instanceName);
                  const res = await evoFetch(baseUrl, evoConfig.apiKey,
                    `/message/sendText/${instanceEnc}`, "POST",
                    { number: `${phone}@s.whatsapp.net`, text: replyText });
                  if (res.ok) {
                    const msgId = uuid();
                    await kv.set(`cmsg:${conversation.id}:${msgId}`, {
                      id: msgId, conversation_id: conversation.id,
                      direction: "outbound", sender_type: "ai",
                      text: replyText, sent_at: new Date().toISOString(),
                    });
                    conversation.last_message_text = replyText;
                    conversation.last_message_direction = "outbound";
                    conversation.last_message_at = new Date().toISOString();
                    await kv.set(`conversation:${conversation.id}`, conversation);
                    console.log(`[AI Instant] ✅ Sent to ${phone}`);
                  }
                }
              }
            } else {
              // Delayed: analyze then schedule
              await Promise.all([
                analyzeMessageIntent(messageText, conversation.id, phone, pushName).then(async () => {
                  if (mode === "delayed") {
                    const intent = await kv.get(`intent:${conversation.id}`) as any;
                    if (intent?.needsReply && intent?.suggestedReply) {
                      await scheduleAutoReply(conversation.id, phone, pushName, intent.suggestedReply);
                    }
                  }
                }),
                analyzeMessageFeedback(messageText, conversation.id, phone, pushName),
              ]);
            }
          })(),
          new Promise<void>((resolve) => setTimeout(resolve, 20000)),
        ]).catch((e) => console.log(`[AI] ❌ Error for ${phone}:`, e));
      }

      // ── Cancel auto-reply if employee sent an outbound message ──
      if (isFromMe) {
        cancelAutoReply(conversation.id).catch(() => {});
      }

      // ── Menu Chatbot: trigger for inbound messages ──
      if (!isFromMe && messageText) {
        try {
          const aiConf = await kv.get("ai:config") as any;
          if (aiConf?.enabled) {
            console.log(`[MENU] Chatbot triggered for ${phone} in conv ${conversation.id}, msg: "${messageText.substring(0, 60)}"`);
            try {
              const menuResult = await Promise.race([
                processMenuReply(conversation.id, phone, pushName, messageText),
                new Promise<{ success: false; error: string }>((_, reject) =>
                  setTimeout(() => reject({ success: false, error: "Menu reply timeout (25s)" }), 25000)
                ),
              ]);
              if (menuResult.success) {
                console.log(`[MENU] ✅ Reply sent to ${phone}: "${menuResult.reply?.substring(0, 80)}..."`);
              } else {
                console.log(`[MENU] ❌ Reply failed for ${phone}: ${menuResult.error}`);
              }
            } catch (menuExecErr: any) {
              console.log(`[MENU] ❌ Execution error for ${phone}: ${menuExecErr?.error || menuExecErr}`);
            }
          } else {
            console.log(`[MENU] Skipped — chatbot disabled for inbound from ${phone}`);
          }
        } catch (menuErr) {
          console.log("[MENU] Chatbot config check error:", menuErr);
        }
      }
    }

    // Update stats once
    const counterData = await kv.get("webhook:counter");
    const counter = (typeof counterData === "number" ? counterData : 0) + processedCount;
    await kv.set("webhook:counter", counter);

    const webhookEvent = {
      id: uuid(), event, phone: "webhook",
      customerName: payload.instance || "Evolution",
      direction: "inbound",
      text: `${processedCount} msg(s) from ${event}`,
      receivedAt: new Date().toISOString(),
    };
    const existingEvents = await kv.get("webhook:events_log");
    const eventsLog = Array.isArray(existingEvents) ? existingEvents : [];
    eventsLog.unshift(webhookEvent);
    if (eventsLog.length > 50) eventsLog.length = 50;
    await kv.set("webhook:events_log", eventsLog);

    console.log(`[WEBHOOK] ✅ DONE: processed=${processedCount}, skipped=${skippedCount}, event="${event}"`);
    return c.json({ status: "ok", processed: processedCount, skipped: skippedCount });
  } catch (error) {
    console.log("WEBHOOK ERROR:", error);
    try {
      const existing = await kv.get("webhook:raw_log");
      const rawLog = Array.isArray(existing) ? existing : [];
      rawLog.unshift({ at: new Date().toISOString(), error: String(error) });
      if (rawLog.length > 20) rawLog.length = 20;
      await kv.set("webhook:raw_log", rawLog);
    } catch (_) {}
    return c.json({ error: `Webhook error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// DASHBOARD: Live Operations
// ─────────────────────────────────────────────
app.get("/make-server-5c5dc789/dashboard/live", async (c) => {
  try {
    const conversations = await kv.getByPrefix("conversation:");
    const messages = await kv.getByPrefix("cmsg:");
    const orders = await kv.getByPrefix("order:");
    const agents = await kv.getByPrefix("agent:");

    const today = todayStart();

    const openConversations = conversations.filter((cv: any) => cv.status === "open").length;
    const pendingConversations = conversations.filter((cv: any) => cv.status === "pending").length;

    // Pending without reply: open conversations where the last message is inbound
    let pendingWithoutReply = 0;
    for (const conv of conversations) {
      if (conv.status === "open" || conv.status === "pending") {
        const convMsgs = messages
          .filter((m: any) => m.conversation_id === conv.id)
          .sort((a: any, b: any) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime());
        if (convMsgs.length > 0 && convMsgs[0].direction === "inbound") {
          pendingWithoutReply++;
        }
      }
    }

    const todayOrders = orders.filter((o: any) => o.created_at >= today);
    const ordersToday = todayOrders.length;
    const revenueToday = todayOrders.reduce((sum: number, o: any) => sum + (o.total_amount || 0), 0);

    // Recent messages (last 20) — kept for backward compat
    const recentMessages = messages
      .sort((a: any, b: any) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime())
      .slice(0, 20)
      .map((m: any) => {
        const conv = conversations.find((cv: any) => cv.id === m.conversation_id);
        return {
          ...m,
          customer_name: conv?.customer_name || "Unknown",
          customer_phone: conv?.customer_phone || "",
        };
      });

    // Load intent analyses for all conversations
    const allIntents = await kv.getByPrefix("intent:");
    const intentMap = new Map(allIntents.map((i: any) => [i.conversationId, i]));

    // Recent conversations (sorted by last message) — one entry per conversation
    const recentConversations = conversations
      .filter((cv: any) => cv.last_message_at || cv.created_at)
      .sort((a: any, b: any) => {
        const ta = new Date(a.last_message_at || a.created_at).getTime();
        const tb = new Date(b.last_message_at || b.created_at).getTime();
        return tb - ta;
      })
      .slice(0, 50)
      .map((cv: any) => {
        // Count unread (inbound messages after last outbound)
        const convMsgs = messages
          .filter((m: any) => m.conversation_id === cv.id)
          .sort((a: any, b: any) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime());
        let unread = 0;
        for (let i = convMsgs.length - 1; i >= 0; i--) {
          if (convMsgs[i].direction === "outbound") break;
          unread++;
        }
        const intent = intentMap.get(cv.id) as any;
        return {
          id: cv.id,
          customer_name: cv.customer_name || cv.customer_phone || "Unknown",
          customer_phone: cv.customer_phone || "",
          last_message_text: cv.last_message_text || convMsgs[convMsgs.length - 1]?.text || "",
          last_message_at: cv.last_message_at || cv.created_at || "",
          last_message_direction: cv.last_message_direction || convMsgs[convMsgs.length - 1]?.direction || "inbound",
          status: cv.status || "open",
          unread_count: unread,
          // AI intent analysis
          intent: intent?.intent || null,
          intent_urgency: intent?.urgency || null,
          intent_needs_reply: intent?.needsReply ?? null,
          intent_summary: intent?.summary || null,
          intent_suggested_reply: intent?.suggestedReply || null,
        };
      });

    return c.json({
      openConversations,
      pendingConversations,
      pendingWithoutReply,
      ordersToday,
      revenueToday: Math.round(revenueToday * 100) / 100,
      totalConversations: conversations.length,
      recentMessages,
      recentConversations,
      agents: agents.map((a: any) => ({ id: a.id, name: a.name, role: a.role })),
    });
  } catch (error) {
    console.log("Dashboard live error:", error);
    return c.json({ error: `Dashboard live error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// DASHBOARD: Response Analytics
// ─────────────────────────────────────────────
app.get("/make-server-5c5dc789/dashboard/analytics", async (c) => {
  try {
    const dateParam = c.req.query("date"); // optional "YYYY-MM-DD"
    const conversations = await kv.getByPrefix("conversation:");
    const allMessages = await kv.getByPrefix("cmsg:");
    const agents = await kv.getByPrefix("agent:");

    // Filter messages to the selected date (or all-time if no date)
    const messages = dateParam
      ? allMessages.filter((m: any) => {
          const msgDay = new Date(m.sent_at).toISOString().slice(0, 10);
          return msgDay === dateParam;
        })
      : allMessages;

    // ── Overview stats ──
    const totalConversations = conversations.length;
    const totalMessages = messages.length;
    const inboundMessages = messages.filter((m: any) => m.direction === "inbound");
    const outboundMessages = messages.filter((m: any) => m.direction === "outbound");
    const totalInbound = inboundMessages.length;
    const totalOutbound = outboundMessages.length;

    // Status breakdown
    const statusBreakdown: Record<string, number> = {};
    for (const cv of conversations) {
      statusBreakdown[cv.status || "unknown"] = (statusBreakdown[cv.status || "unknown"] || 0) + 1;
    }

    // Average messages per conversation
    const avgMsgsPerConv = totalConversations > 0 ? Math.round((totalMessages / totalConversations) * 10) / 10 : 0;

    // ── FRT Calculation ──
    const frtValues: number[] = [];
    const agentPerformance: Record<string, { totalFRT: number; count: number; name: string; resolved: number; totalMsgs: number }> = {};
    for (const agent of agents) {
      agentPerformance[agent.id] = { totalFRT: 0, count: 0, name: agent.name, resolved: 0, totalMsgs: 0 };
    }

    // Response rate: conversations where customer got at least one reply
    let conversationsWithReply = 0;
    let conversationsWithInbound = 0;

    // Conversations with message details
    const convDetails: Array<{ name: string; phone: string; msgCount: number; inbound: number; outbound: number; frt: number | null; lastActive: string; status: string }> = [];

    for (const conv of conversations) {
      const convMsgs = messages
        .filter((m: any) => m.conversation_id === conv.id)
        .sort((a: any, b: any) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime());

      const inCount = convMsgs.filter((m: any) => m.direction === "inbound").length;
      const outCount = convMsgs.filter((m: any) => m.direction === "outbound").length;

      if (inCount > 0) conversationsWithInbound++;
      if (inCount > 0 && outCount > 0) conversationsWithReply++;

      const firstInbound = convMsgs.find((m: any) => m.direction === "inbound");
      const firstOutbound = convMsgs.find((m: any) => m.direction === "outbound" && m.sender_type === "agent");
      let frt: number | null = null;

      if (firstInbound && firstOutbound) {
        frt = (new Date(firstOutbound.sent_at).getTime() - new Date(firstInbound.sent_at).getTime()) / 1000;
        if (frt > 0 && frt < 86400) {
          frtValues.push(frt);
          if (conv.assigned_agent_id && agentPerformance[conv.assigned_agent_id]) {
            agentPerformance[conv.assigned_agent_id].totalFRT += frt;
            agentPerformance[conv.assigned_agent_id].count++;
          }
        } else {
          frt = null;
        }
      }

      if (conv.assigned_agent_id && agentPerformance[conv.assigned_agent_id]) {
        agentPerformance[conv.assigned_agent_id].totalMsgs += convMsgs.length;
        if (conv.status === "resolved") agentPerformance[conv.assigned_agent_id].resolved++;
      }

      convDetails.push({
        name: conv.customer_name || conv.customer_phone || "Unknown",
        phone: conv.customer_phone || "",
        msgCount: convMsgs.length,
        inbound: inCount,
        outbound: outCount,
        frt,
        lastActive: conv.last_message_at || conv.created_at || "",
        status: conv.status || "open",
      });
    }

    // Average & Median FRT
    const avgFRT = frtValues.length > 0 ? frtValues.reduce((a, b) => a + b, 0) / frtValues.length : 0;
    const sortedFRT = [...frtValues].sort((a, b) => a - b);
    const medianFRT = sortedFRT.length > 0
      ? sortedFRT.length % 2 === 0
        ? (sortedFRT[sortedFRT.length / 2 - 1] + sortedFRT[sortedFRT.length / 2]) / 2
        : sortedFRT[Math.floor(sortedFRT.length / 2)]
      : 0;

    // Response rate %
    const responseRate = conversationsWithInbound > 0 ? Math.round((conversationsWithReply / conversationsWithInbound) * 100) : 0;

    // ── FRT Distribution (buckets) ──
    const frtBuckets = [
      { label: "< 1m", min: 0, max: 60 },
      { label: "1-5m", min: 60, max: 300 },
      { label: "5-15m", min: 300, max: 900 },
      { label: "15-30m", min: 900, max: 1800 },
      { label: "30m-1h", min: 1800, max: 3600 },
      { label: "1-3h", min: 3600, max: 10800 },
      { label: "> 3h", min: 10800, max: Infinity },
    ];
    const frtDistribution = frtBuckets.map(b => ({
      label: b.label,
      count: frtValues.filter(v => v >= b.min && v < b.max).length,
    }));

    // ── Response time by hour ──
    const responseByHour: Record<number, { total: number; count: number }> = {};
    for (let h = 0; h < 24; h++) responseByHour[h] = { total: 0, count: 0 };

    for (const conv of conversations) {
      const convMsgs = messages
        .filter((m: any) => m.conversation_id === conv.id)
        .sort((a: any, b: any) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime());
      for (let i = 0; i < convMsgs.length - 1; i++) {
        if (convMsgs[i].direction === "inbound" && convMsgs[i + 1].direction === "outbound") {
          const rt = (new Date(convMsgs[i + 1].sent_at).getTime() - new Date(convMsgs[i].sent_at).getTime()) / 1000;
          const hour = new Date(convMsgs[i].sent_at).getHours();
          if (rt > 0 && rt < 86400) {
            responseByHour[hour].total += rt;
            responseByHour[hour].count++;
          }
        }
      }
    }
    const responseByHourChart = Object.entries(responseByHour).map(([hour, d]) => ({
      hour: `${hour}:00`,
      avgResponseTime: d.count > 0 ? Math.round(d.total / d.count) : 0,
      count: d.count,
    }));

    // ── Messages by hour (volume) ──
    const msgByHour: Record<number, { inbound: number; outbound: number }> = {};
    for (let h = 0; h < 24; h++) msgByHour[h] = { inbound: 0, outbound: 0 };
    for (const m of messages) {
      const h = new Date(m.sent_at).getHours();
      if (m.direction === "inbound") msgByHour[h].inbound++;
      else msgByHour[h].outbound++;
    }
    const messageVolumeByHour = Object.entries(msgByHour).map(([hour, d]) => ({
      hour: `${hour}:00`, inbound: d.inbound, outbound: d.outbound, total: d.inbound + d.outbound,
    }));

    // ── Messages by day (last 30 days) ──
    const msgByDay: Record<string, { inbound: number; outbound: number }> = {};
    const now = new Date();
    for (let d = 29; d >= 0; d--) {
      const dt = new Date(now);
      dt.setDate(dt.getDate() - d);
      const key = dt.toISOString().slice(0, 10);
      msgByDay[key] = { inbound: 0, outbound: 0 };
    }
    for (const m of messages) {
      const day = new Date(m.sent_at).toISOString().slice(0, 10);
      if (msgByDay[day]) {
        if (m.direction === "inbound") msgByDay[day].inbound++;
        else msgByDay[day].outbound++;
      }
    }
    const messageVolumeByDay = Object.entries(msgByDay).map(([day, d]) => ({
      day, inbound: d.inbound, outbound: d.outbound, total: d.inbound + d.outbound,
    }));

    // ── Messages by day of week ──
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const msgByDOW: number[] = [0, 0, 0, 0, 0, 0, 0];
    for (const m of messages) {
      const dow = new Date(m.sent_at).getDay();
      msgByDOW[dow]++;
    }
    const messagesByDayOfWeek = dayNames.map((name, i) => ({ day: name, count: msgByDOW[i] }));

    // ── Busiest hour ──
    let busiestHour = "N/A";
    let maxMsgHour = 0;
    Object.entries(msgByHour).forEach(([hour, d]) => {
      const total = d.inbound + d.outbound;
      if (total > maxMsgHour) { maxMsgHour = total; busiestHour = `${hour}:00`; }
    });

    // ── Top conversations by message volume ──
    const topConversations = [...convDetails]
      .sort((a, b) => b.msgCount - a.msgCount)
      .slice(0, 10);

    // ── Agent performance table ──
    const agentTable = Object.values(agentPerformance).map((a) => ({
      name: a.name,
      avgFRT: a.count > 0 ? Math.round(a.totalFRT / a.count) : 0,
      conversationsHandled: a.count,
      resolved: a.resolved,
      totalMessages: a.totalMsgs,
    }));

    // ── SLA compliance (under 5 min = within SLA) ──
    const slaTarget = 300; // 5 minutes
    const withinSLA = frtValues.filter(v => v <= slaTarget).length;
    const slaCompliance = frtValues.length > 0 ? Math.round((withinSLA / frtValues.length) * 100) : 0;

    return c.json({
      // Overview
      totalConversations,
      totalMessages,
      totalInbound,
      totalOutbound,
      avgMsgsPerConv,
      responseRate,
      busiestHour,
      statusBreakdown,
      // FRT
      avgFRT: Math.round(avgFRT),
      medianFRT: Math.round(medianFRT),
      totalResponsesSampled: frtValues.length,
      frtDistribution,
      slaTarget,
      slaCompliance,
      // Charts
      responseByHour: responseByHourChart,
      messageVolumeByHour,
      messageVolumeByDay,
      messagesByDayOfWeek,
      // Tables
      topConversations,
      agentPerformance: agentTable,
      // Meta
      filteredDate: dateParam || null,
    });
  } catch (error) {
    console.log("Analytics error:", error);
    return c.json({ error: `Analytics error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// DASHBOARD: Orders
// ─────────────────────────────────────────────
app.get("/make-server-5c5dc789/dashboard/orders", async (c) => {
  try {
    const orders = await kv.getByPrefix("order:");
    const conversations = await kv.getByPrefix("conversation:");

    const today = todayStart();

    // Orders by status
    const statusCounts: Record<string, number> = { new: 0, confirmed: 0, preparing: 0, delivered: 0, cancelled: 0 };
    orders.forEach((o: any) => {
      if (statusCounts[o.status] !== undefined) statusCounts[o.status]++;
    });

    const ordersByStatus = Object.entries(statusCounts).map(([status, count]) => ({
      status,
      count,
    }));

    // Orders by hour (today)
    const todayOrders = orders.filter((o: any) => o.created_at >= today);
    const ordersByHour: Record<number, number> = {};
    for (let h = 0; h < 24; h++) ordersByHour[h] = 0;
    todayOrders.forEach((o: any) => {
      const h = new Date(o.created_at).getHours();
      ordersByHour[h]++;
    });

    const ordersByHourChart = Object.entries(ordersByHour).map(([hour, count]) => ({
      hour: `${hour}:00`,
      orders: count,
    }));

    // Recent orders with customer info
    const recentOrders = orders
      .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 15)
      .map((o: any) => {
        const conv = conversations.find((cv: any) => cv.id === o.conversation_id);
        return {
          ...o,
          customer_name: conv?.customer_name || "Unknown",
          customer_phone: conv?.customer_phone || "",
        };
      });

    // Average order confirmation time (time from new to confirmed)
    const totalRevenue = orders.reduce((sum: number, o: any) => sum + (o.total_amount || 0), 0);
    const todayRevenue = todayOrders.reduce((sum: number, o: any) => sum + (o.total_amount || 0), 0);

    return c.json({
      ordersByStatus,
      ordersByHour: ordersByHourChart,
      recentOrders,
      totalOrders: orders.length,
      todayOrders: todayOrders.length,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      todayRevenue: Math.round(todayRevenue * 100) / 100,
    });
  } catch (error) {
    console.log("Orders error:", error);
    return c.json({ error: `Orders error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// DASHBOARD: Feedback
// ─────────────────────────────────────────────
app.get("/make-server-5c5dc789/dashboard/feedback", async (c) => {
  try {
    // ── Same data source as Live + Analytics ──
    const conversations = await kv.getByPrefix("conversation:");
    const messages = await kv.getByPrefix("cmsg:");
    const aiFeedbacks = await kv.getByPrefix("feedback:"); // AI-enriched entries (bonus)

    // ── Build per-conversation stats ──
    type ConvStat = {
      conv: any;
      inbound: number;
      outbound: number;
      lastDirection: string;
      lastMsgAt: string;
      firstInboundAt: string | null;
      firstOutboundAt: string | null;
      frt: number | null; // seconds
    };

    const convStats: ConvStat[] = conversations.map((conv: any) => {
      const msgs = messages
        .filter((m: any) => m.conversation_id === conv.id)
        .sort((a: any, b: any) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime());

      const inbound = msgs.filter((m: any) => m.direction === "inbound").length;
      const outbound = msgs.filter((m: any) => m.direction === "outbound").length;
      const lastMsg = msgs[msgs.length - 1];
      const firstIn = msgs.find((m: any) => m.direction === "inbound");
      const firstOut = msgs.find((m: any) => m.direction === "outbound");
      let frt: number | null = null;
      if (firstIn && firstOut) {
        const diff = (new Date(firstOut.sent_at).getTime() - new Date(firstIn.sent_at).getTime()) / 1000;
        if (diff > 0 && diff < 86400) frt = diff;
      }
      return {
        conv,
        inbound,
        outbound,
        lastDirection: lastMsg?.direction || "inbound",
        lastMsgAt: lastMsg?.sent_at || conv.last_message_at || conv.created_at || "",
        firstInboundAt: firstIn?.sent_at || null,
        firstOutboundAt: firstOut?.sent_at || null,
        frt,
      };
    });

    const totalConversations = convStats.length;

    // ── Sentiment: derive from conversation health ──
    // Positive = resolved OR responded (last msg outbound)
    // Neutral  = open + responded
    // Negative = open + no reply (last msg inbound)
    let positive = 0, neutral = 0, negative = 0;
    for (const cs of convStats) {
      if (cs.conv.status === "resolved") { positive++; }
      else if (cs.lastDirection === "outbound") { neutral++; }
      else { negative++; } // inbound last = waiting for reply
    }
    // Supplement with AI sentiment if available
    if (aiFeedbacks.length > 0) {
      positive = aiFeedbacks.filter((f: any) => f.sentiment === "positive").length;
      neutral  = aiFeedbacks.filter((f: any) => f.sentiment === "neutral").length;
      negative = aiFeedbacks.filter((f: any) => f.sentiment === "negative").length;
    }
    const sentimentBreakdown = [
      { sentiment: "Positive", count: positive, color: "#22c55e" },
      { sentiment: "Neutral",  count: neutral,  color: "#f59e0b" },
      { sentiment: "Negative", count: negative, color: "#ef4444" },
    ];

    // ── Rating: derive from FRT (fast reply = high rating) ──
    const ratingDist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    if (aiFeedbacks.length > 0) {
      aiFeedbacks.forEach((f: any) => {
        if (ratingDist[f.rating] !== undefined) ratingDist[f.rating]++;
      });
    } else {
      for (const cs of convStats) {
        let rating: number;
        if (cs.conv.status === "resolved") rating = 5;
        else if (cs.frt !== null && cs.frt < 300) rating = 5;       // < 5 min
        else if (cs.frt !== null && cs.frt < 1800) rating = 4;      // < 30 min
        else if (cs.frt !== null && cs.frt < 7200) rating = 3;      // < 2 hr
        else if (cs.outbound > 0) rating = 2;
        else rating = 1; // never replied
        ratingDist[rating]++;
      }
    }
    const ratingDistribution = Object.entries(ratingDist).map(([rating, count]) => ({
      rating: Number(rating), count, label: `${rating} Star${Number(rating) > 1 ? "s" : ""}`,
    }));
    const totalRated = Object.values(ratingDist).reduce((a, b) => a + b, 0);
    const avgRating = totalRated > 0
      ? Object.entries(ratingDist).reduce((sum, [r, c]) => sum + Number(r) * c, 0) / totalRated
      : 0;

    // ── Urgency: conversations with no reply (inbound last, open) ──
    const highUrgency = convStats.filter(cs =>
      cs.lastDirection === "inbound" && cs.conv.status !== "resolved" && cs.outbound === 0
    ).length;
    const mediumUrgency = convStats.filter(cs =>
      cs.lastDirection === "inbound" && cs.conv.status !== "resolved" && cs.outbound > 0
    ).length;

    // ── Category from AI or fallback to conversation status ──
    const categoryMap: Record<string, number> = {};
    if (aiFeedbacks.length > 0) {
      aiFeedbacks.forEach((f: any) => {
        const cat = f.category || "general";
        categoryMap[cat] = (categoryMap[cat] || 0) + 1;
      });
    } else {
      convStats.forEach(cs => {
        const cat = cs.conv.status === "resolved" ? "resolved"
          : cs.outbound === 0 ? "no_reply"
          : cs.lastDirection === "outbound" ? "replied"
          : "pending";
        categoryMap[cat] = (categoryMap[cat] || 0) + 1;
      });
    }
    const categoryBreakdown = Object.entries(categoryMap)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);

    // ── Topics from AI feedback ──
    const topicMap: Record<string, number> = {};
    aiFeedbacks.forEach((f: any) => {
      if (Array.isArray(f.topics)) {
        f.topics.forEach((t: string) => { topicMap[t] = (topicMap[t] || 0) + 1; });
      }
    });
    const topTopics = Object.entries(topicMap)
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    // ── Recent feedback = recent conversations (with AI data if available) ──
    const aiFeedbackByConv = new Map(aiFeedbacks.map((f: any) => [f.conversation_id, f]));
    const recentFeedback = [...convStats]
      .filter(cs => cs.inbound > 0 || cs.outbound > 0)
      .sort((a, b) => new Date(b.lastMsgAt).getTime() - new Date(a.lastMsgAt).getTime())
      .slice(0, 30)
      .map(cs => {
        const ai = aiFeedbackByConv.get(cs.conv.id) as any;
        const derivedRating =
          cs.conv.status === "resolved" ? 5
          : cs.frt !== null && cs.frt < 300 ? 5
          : cs.frt !== null && cs.frt < 1800 ? 4
          : cs.frt !== null && cs.frt < 7200 ? 3
          : cs.outbound > 0 ? 2 : 1;
        return {
          id: cs.conv.id,
          conversation_id: cs.conv.id,
          customer_name: cs.conv.customer_name || "Unknown",
          customer_phone: cs.conv.customer_phone || "",
          rating: ai?.rating ?? derivedRating,
          sentiment: ai?.sentiment ?? (cs.conv.status === "resolved" ? "positive" : cs.lastDirection === "outbound" ? "neutral" : "negative"),
          category: ai?.category ?? (cs.conv.status === "resolved" ? "resolved" : cs.outbound === 0 ? "no_reply" : "replied"),
          comment: ai?.comment ?? cs.conv.last_message_text ?? "",
          urgency: ai?.urgency ?? (cs.outbound === 0 && cs.inbound > 0 ? "high" : cs.lastDirection === "inbound" ? "medium" : "low"),
          created_at: cs.lastMsgAt,
          source: ai ? "ai_analysis" : "conversation",
          msgCount: cs.inbound + cs.outbound,
          frt: cs.frt,
          status: cs.conv.status,
        };
      });

    // ── Negative = high urgency conversations ──
    const negativeFeedback = recentFeedback
      .filter(f => f.rating <= 2 || f.urgency === "high")
      .slice(0, 20);

    return c.json({
      ratingDistribution,
      avgRating: Math.round(avgRating * 10) / 10,
      totalFeedback: totalConversations,
      negativeFeedback,
      sentimentBreakdown,
      categoryBreakdown,
      highUrgency,
      mediumUrgency,
      topTopics,
      recentFeedback,
      // bonus stats
      totalConversations,
      totalMessages: messages.length,
      aiEnriched: aiFeedbacks.length,
    });
  } catch (error) {
    console.log("Feedback error:", error);
    return c.json({ error: `Feedback error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// CONVERSATIONS ENDPOINT
// ─────────────────────────────────────────────
app.get("/make-server-5c5dc789/conversations", async (c) => {
  try {
    const conversations = await kv.getByPrefix("conversation:");
    const sorted = conversations.sort(
      (a: any, b: any) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()
    );
    return c.json({ conversations: sorted });
  } catch (error) {
    console.log("Conversations error:", error);
    return c.json({ error: `Conversations error: ${error}` }, 500);
  }
});

// ───────────────────────────────────────��─────
// WEBHOOK: Raw Log (Debugging)
// ─────────────────���───────────────────────────
app.get("/make-server-5c5dc789/webhook/raw-log", async (c) => {
  try {
    const rawLog = await kv.get("webhook:raw_log");
    return c.json({ log: Array.isArray(rawLog) ? rawLog : [] });
  } catch (error) {
    return c.json({ error: `Raw log error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// CLEAR DATA
// ─────────────────────────────────────────────
app.delete("/make-server-5c5dc789/data/clear", async (c) => {
  try {
    const prefixes = ["agent:", "conversation:", "message:", "order:", "feedback:"];
    for (const prefix of prefixes) {
      const items = await kv.getByPrefix(prefix);
      if (items.length > 0) {
        const keys = items.map((item: any) => `${prefix}${item.id}`);
        await kv.mdel(keys);
      }
    }
    return c.json({ status: "ok", message: "All data cleared" });
  } catch (error) {
    console.log("Clear error:", error);
    return c.json({ error: `Clear error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// WEBHOOK: Stats
// ─────────────────────────────────────────────
app.get("/make-server-5c5dc789/webhook/stats", async (c) => {
  try {
    const counterData = await kv.get("webhook:counter");
    const totalReceived = typeof counterData === 'number' ? counterData : 0;
    
    const eventsData = await kv.get("webhook:events_log");
    const recentEvents = Array.isArray(eventsData) ? eventsData.slice(0, 10) : [];
    
    const lastReceivedAt = recentEvents.length > 0 ? recentEvents[0].receivedAt : null;
    
    // Determine connection status
    let connectionStatus: "connected" | "waiting" | "error" = "waiting";
    if (totalReceived > 0) {
      connectionStatus = "connected";
    }

    return c.json({
      totalReceived,
      lastReceivedAt,
      recentEvents,
      connectionStatus,
    });
  } catch (error) {
    console.log("Webhook stats error:", error);
    return c.json({ error: `Webhook stats error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// WEBHOOK: Test
// ─────────────────────────────────────────────
app.post("/make-server-5c5dc789/webhook/test", async (c) => {
  try {
    // Simulate an inbound message from Evolution API
    const testPayload = {
      event: "messages.upsert",
      data: {
        key: {
          remoteJid: "000000000000@s.whatsapp.net",
          fromMe: false,
        },
        pushName: "Webhook Test",
        message: {
          conversation: "This is a test message from the dashboard webhook tester.",
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    };

    // Process through the same logic as the webhook
    const data = testPayload.data;
    const phone = "000000000000";
    const messageText = data.message.conversation;
    const pushName = data.pushName;
    const messageTimestamp = new Date(data.messageTimestamp * 1000).toISOString();

    // Find or create test conversation
    const conversations = await kv.getByPrefix("conversation:");
    let conversation = conversations.find((cv: any) => cv.customer_phone === phone);

    if (!conversation) {
      const convId = uuid();
      conversation = {
        id: convId,
        customer_phone: phone,
        customer_name: pushName,
        status: "open",
        assigned_agent_id: null,
        created_at: new Date().toISOString(),
        last_message_at: messageTimestamp,
      };
      await kv.set(`conversation:${convId}`, conversation);
    } else {
      conversation.last_message_at = messageTimestamp;
      await kv.set(`conversation:${conversation.id}`, conversation);
    }

    const msgId = uuid();
    const message = {
      id: msgId,
      conversation_id: conversation.id,
      direction: "inbound",
      sender_type: "customer",
      text: messageText,
      sent_at: messageTimestamp,
      payload: { test: true },
    };
    await kv.set(`message:${msgId}`, message);

    // Track the test event
    const webhookEvent = {
      id: msgId,
      event: "test",
      phone,
      customerName: pushName,
      direction: "inbound",
      text: messageText,
      receivedAt: new Date().toISOString(),
    };
    const existingEvents = await kv.get("webhook:events_log");
    const eventsLog = Array.isArray(existingEvents) ? existingEvents : [];
    eventsLog.unshift(webhookEvent);
    if (eventsLog.length > 50) eventsLog.length = 50;
    await kv.set("webhook:events_log", eventsLog);
    const counterData = await kv.get("webhook:counter");
    const counter = (typeof counterData === 'number' ? counterData : 0) + 1;
    await kv.set("webhook:counter", counter);

    return c.json({
      status: "ok",
      message: "Webhook is working correctly!",
      conversation_id: conversation.id,
      message_id: msgId,
    });
  } catch (error) {
    console.log("Webhook test error:", error);
    return c.json({ error: `Webhook test error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// EVOLUTION API: Helpers
// ─────────────────────────────────────────────

// Clean the Evolution API URL: strip /manager, trailing slashes, etc.
function cleanEvoUrl(raw: string): string {
  let url = (raw || "").trim().replace(/\/+$/, "");
  // Strip common UI paths that users accidentally include
  url = url.replace(/\/(manager|dashboard|admin|app|api)(\/.*)?$/i, "");
  return url;
}

// Try fetching from Evolution API with multiple auth strategies
async function evoFetch(
  baseUrl: string,
  apiKey: string,
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: any,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "apikey": apiKey,
  };
  const opts: RequestInit = { method, headers };
  // If external signal provided, use it; otherwise add a 20-second timeout
  if (signal) {
    opts.signal = signal;
  } else {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20000);
    opts.signal = ac.signal;
  }
  if (body && (method === "POST" || method === "PUT")) {
    opts.body = JSON.stringify(body);
  }
  const url = `${baseUrl}${path}`;
  console.log(`[evoFetch] ${method} ${url}`);
  let res: Response;
  try {
    res = await fetch(url, opts);
  } catch (e: any) {
    if (e?.name === "AbortError") {
      console.log(`[evoFetch] → TIMEOUT ${url}`);
      return new Response(JSON.stringify({ error: "evoFetch timeout" }), { status: 504 });
    }
    throw e;
  }
  console.log(`[evoFetch] → ${res.status}`);

  // If 401/403 try alternative auth headers
  if (res.status === 401 || res.status === 403) {
    console.log(`[evoFetch] Auth failed with apikey header, trying Bearer...`);
    const altHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    };
    const altOpts: RequestInit = { method, headers: altHeaders };
    if (signal) altOpts.signal = signal;
    if (body && (method === "POST" || method === "PUT")) {
      altOpts.body = JSON.stringify(body);
    }
    try {
      const res2 = await fetch(url, altOpts);
      console.log(`[evoFetch] Bearer → ${res2.status}`);
      if (res2.ok) return res2;
    } catch { /* ignore timeout on alt auth */ }

    // Try x-api-key header
    console.log(`[evoFetch] Trying x-api-key...`);
    const altHeaders2: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    };
    const altOpts2: RequestInit = { method, headers: altHeaders2 };
    if (signal) altOpts2.signal = signal;
    if (body && (method === "POST" || method === "PUT")) {
      altOpts2.body = JSON.stringify(body);
    }
    try {
      const res3 = await fetch(url, altOpts2);
      console.log(`[evoFetch] x-api-key → ${res3.status}`);
      if (res3.ok) return res3;
    } catch { /* ignore */ }
  }

  return res;
}

// ─────────────────────────────────────────────
// EVOLUTION API: Config
// ─────────────────────────────────────────────
// Normalize Arabic/Eastern numerals to Western
function normalizeNumerals(str: string): string {
  return str.replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
            .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06F0));
}

app.post("/make-server-5c5dc789/evolution/config", async (c) => {
  try {
    const body = await c.req.json();
    const config = {
      apiUrl: cleanEvoUrl(body.apiUrl || ""),
      apiKey: body.apiKey || "",
      instanceName: normalizeNumerals(body.instanceName || ""),
      updatedAt: new Date().toISOString(),
    };
    await kv.set("evolution:config", config);
    console.log("Evolution config saved:", { apiUrl: config.apiUrl, instanceName: config.instanceName });
    return c.json({ status: "ok", cleanedUrl: config.apiUrl });
  } catch (error) {
    console.log("Evolution config save error:", error);
    return c.json({ error: `Config save error: ${error}` }, 500);
  }
});

app.get("/make-server-5c5dc789/evolution/config", async (c) => {
  try {
    const config = await kv.get("evolution:config") as any;
    if (!config || !config.apiUrl) {
      return c.json({ configured: false });
    }
    return c.json({
      configured: true,
      apiUrl: config.apiUrl,
      instanceName: config.instanceName,
      apiKeyMasked: config.apiKey ? "***" + config.apiKey.slice(-4) : "",
    });
  } catch (error) {
    console.log("Evolution config get error:", error);
    return c.json({ error: `Config get error: ${error}` }, 500);
  }
});

// Patch only instance name (keeps existing apiUrl & apiKey intact)
app.post("/make-server-5c5dc789/evolution/config/patch-instance", async (c) => {
  try {
    const body = await c.req.json();
    const newName = normalizeNumerals(body.instanceName || "");
    if (!newName) {
      return c.json({ error: "instanceName is required" }, 400);
    }
    const config = await kv.get("evolution:config") as any;
    if (!config?.apiUrl || !config?.apiKey) {
      return c.json({ error: "No existing config found. Save full config first." }, 400);
    }
    config.instanceName = newName;
    config.updatedAt = new Date().toISOString();
    await kv.set("evolution:config", config);
    console.log(`[EVO] Instance name patched to: "${newName}"`);
    return c.json({ status: "ok", instanceName: newName });
  } catch (error) {
    console.log("Evolution config patch error:", error);
    return c.json({ error: `Config patch error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// EVOLUTION API: Restart / Reconnect Instance
// ─────────────────────────────────────────────
app.post("/make-server-5c5dc789/evolution/restart-instance", async (c) => {
  try {
    const config = await kv.get("evolution:config") as any;
    if (!config?.apiUrl || !config?.apiKey || !config?.instanceName) {
      return c.json({ error: "Evolution API not configured" }, 400);
    }

    const baseUrl = config.apiUrl;
    const instanceEnc = encodeURIComponent(config.instanceName);
    const results: string[] = [];
    let restarted = false;
    let newState = "unknown";

    console.log(`[RESTART] Attempting to restart instance "${config.instanceName}"...`);

    // Strategy 1: Try GET /instance/connect/ FIRST (works with our Evolution API)
    // Then try other methods as fallback
    const restartAttempts: Array<{ method: "GET" | "POST" | "PUT" | "DELETE"; path: string }> = [
      { method: "GET", path: `/instance/connect/${instanceEnc}` },
      { method: "POST", path: `/instance/restart/${instanceEnc}` },
      { method: "PUT", path: `/instance/restart/${instanceEnc}` },
      { method: "POST", path: `/instance/connect/${instanceEnc}` },
      { method: "PUT", path: `/instance/connect/${instanceEnc}` },
      { method: "DELETE", path: `/instance/restart/${instanceEnc}` },
    ];
    for (const { method, path } of restartAttempts) {
      if (restarted) break;
      try {
        const res = await evoFetch(baseUrl, config.apiKey, path, method);
        const txt = await res.text();
        results.push(`${method} ${path} → ${res.status}: ${txt.substring(0, 200)}`);
        if (res.ok) {
          restarted = true;
          results.push(`✅ Restart/connect command accepted!`);
          // Check for QR code in response
          try {
            const d = JSON.parse(txt);
            if (d?.base64 || d?.qrcode || d?.code) {
              results.push(`📱 QR Code returned — scan it in WhatsApp → Linked Devices → Link a Device`);
            }
          } catch {}
        }
      } catch (e: any) {
        results.push(`${method} ${path} → Error: ${e.message}`);
      }
    }

    // Strategy 2: If no restart endpoint worked, try logout+connect sequence
    if (!restarted) {
      results.push(`\nTrying logout + connect sequence...`);
      try {
        const logoutRes = await evoFetch(baseUrl, config.apiKey, `/instance/logout/${instanceEnc}`, "DELETE");
        const logoutTxt = await logoutRes.text();
        results.push(`DELETE /instance/logout → ${logoutRes.status}: ${logoutTxt.substring(0, 200)}`);
      } catch (e: any) {
        results.push(`Logout error (ignoring): ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 2000));
      try {
        const connectRes = await evoFetch(baseUrl, config.apiKey, `/instance/connect/${instanceEnc}`, "GET");
        const connectTxt = await connectRes.text();
        results.push(`GET /instance/connect → ${connectRes.status}: ${connectTxt.substring(0, 200)}`);
        if (connectRes.ok) {
          restarted = true;
          results.push(`✅ Connect command accepted!`);
          try {
            const d = JSON.parse(connectTxt);
            if (d?.base64 || d?.qrcode || d?.code) {
              results.push(`📱 QR Code returned — may need to scan in Evolution API Manager`);
            }
          } catch {}
        }
      } catch (e: any) {
        results.push(`Connect error: ${e.message}`);
      }
    }

    // Wait for connection to establish, then check state
    await new Promise(r => setTimeout(r, 8000));
    try {
      const stRes = await evoFetch(baseUrl, config.apiKey, `/instance/connectionState/${instanceEnc}`, "GET");
      if (stRes.ok) {
        const sd = await stRes.json();
        newState = sd?.instance?.state || sd?.instance?.connectionStatus || sd?.instance?.status || sd?.connectionStatus || sd?.state || sd?.status || "unknown";
        results.push(`\nPost-restart state: ${newState}`);
      }
    } catch {}

    let isNowConnected = ["open", "connected"].includes(newState);
    
    // If still connecting, wait a bit more (up to 2 more checks)
    if (!isNowConnected && (newState === "connecting" || restarted)) {
      for (let retry = 1; retry <= 2; retry++) {
        results.push(`  ⏳ Still "${newState}" — waiting 5s more... (retry ${retry}/2)`);
        await new Promise(r => setTimeout(r, 5000));
        try {
          const stRes2 = await evoFetch(baseUrl, config.apiKey, `/instance/connectionState/${instanceEnc}`, "GET");
          if (stRes2.ok) {
            const sd2 = await stRes2.json();
            newState = sd2?.instance?.state || sd2?.instance?.connectionStatus || sd2?.state || newState;
            results.push(`  Re-check: state = "${newState}"`);
            isNowConnected = ["open", "connected"].includes(newState);
            if (isNowConnected) {
              results.push(`  ✅ Connected!`);
              break;
            }
          }
        } catch {}
      }
    }
    
    const isConnecting = newState === "connecting";
    results.push(`\n${isNowConnected ? "✅" : isConnecting ? "🔄" : "⚠️"} Final state: ${newState} (${isNowConnected ? "ready to send!" : isConnecting ? "connecting — may need QR scan" : "not connected"})`);
    if (!isNowConnected) {
      results.push(`\n🔧 الحل: روح Evolution API Manager → اضغط على "${config.instanceName}" → لو ظهر QR Code → امسحه من واتساب (Linked Devices → Link a Device)`);
    }

    return c.json({
      success: restarted,
      newState,
      isConnected: isNowConnected,
      log: results,
    });
  } catch (error) {
    console.log("Restart instance error:", error);
    return c.json({ error: `Restart error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// EVOLUTION API: Test Connection & List Instances
// ─────────────────────────────────────────────
app.post("/make-server-5c5dc789/evolution/test", async (c) => {
  try {
    const config = await kv.get("evolution:config") as any;
    if (!config?.apiUrl || !config?.apiKey) {
      return c.json({ error: "Save your Evolution API config first." }, 400);
    }

    const baseUrl = config.apiUrl;
    console.log(`[EVO-TEST] Testing Evolution API connection at: ${baseUrl}`);

    let instances: any[] = [];
    let connectionOk = false;
    let apiVersion = "unknown";
    let workingBaseUrl = baseUrl;
    const tried: string[] = [];
    const errorDetails: string[] = [];

    // List of base URLs to try (original + with /api prefix)
    const baseUrls = [baseUrl];
    // If URL doesn't already end with /api, try adding it
    if (!baseUrl.endsWith("/api")) {
      baseUrls.push(`${baseUrl}/api`);
    }

    // List of instance paths to try
    const instancePaths = [
      { path: "/instance/fetchInstances", label: "v2-fetchInstances" },
      { path: "/instance/list", label: "v1-list" },
    ];
    // If instanceName is set, also try per-instance fetch
    const encoded = config.instanceName ? encodeURIComponent(config.instanceName) : "";
    if (encoded) {
      instancePaths.splice(1, 0, {
        path: `/instance/fetchInstances/${encoded}`,
        label: "v2-fetchByName",
      });
    }

    // Try each base URL × path combination
    for (const tryBase of baseUrls) {
      if (connectionOk) break;
      for (const ep of instancePaths) {
        if (connectionOk) break;
        try {
          const fullUrl = `${tryBase}${ep.path}`;
          tried.push(`GET ${fullUrl}`);
          console.log(`[EVO-TEST] Trying: GET ${fullUrl}`);
          const res = await evoFetch(tryBase, config.apiKey, ep.path, "GET");
          if (res.ok) {
            const data = await res.json();
            instances = Array.isArray(data) ? data : data?.instances ? data.instances : [data];
            connectionOk = true;
            apiVersion = ep.label.startsWith("v2") ? "v2" : "v1";
            workingBaseUrl = tryBase;
            console.log(`[EVO-TEST] ✅ Connected via ${ep.label} at ${tryBase}`);
          } else {
            const txt = await res.text().catch(() => "");
            const detail = `${fullUrl} → ${res.status} ${txt.substring(0, 200)}`;
            errorDetails.push(detail);
            console.log(`[EVO-TEST] ✗ ${detail}`);
          }
        } catch (e) {
          const detail = `${tryBase}${ep.path} → ERROR: ${e}`;
          errorDetails.push(detail);
          console.log(`[EVO-TEST] ✗ ${detail}`);
        }
      }
    }

    // Also try a simple connectivity check (GET / or GET /health)
    if (!connectionOk) {
      for (const tryBase of baseUrls) {
        try {
          const healthUrl = `${tryBase}/`;
          tried.push(`GET ${healthUrl}`);
          console.log(`[EVO-TEST] Health check: GET ${healthUrl}`);
          const res = await fetch(healthUrl, {
            method: "GET",
            headers: { "apikey": config.apiKey },
          });
          const txt = await res.text().catch(() => "");
          errorDetails.push(`GET ${healthUrl} → ${res.status} (${txt.length} chars): ${txt.substring(0, 300)}`);
          console.log(`[EVO-TEST] Health: ${res.status} body: ${txt.substring(0, 200)}`);
        } catch (e) {
          errorDetails.push(`GET ${tryBase}/ → NETWORK ERROR: ${e}`);
        }
      }
    }

    if (!connectionOk) {
      // Return 200 so frontend can read errorDetails (fetchAPI throws on non-200)
      return c.json({
        connected: false,
        error: `Could not connect to Evolution API.`,
        tried,
        errorDetails,
        hint: `Cleaned URL: ${baseUrl}. Make sure:\n1. The URL is correct (API root, not manager UI)\n2. The API key is correct\n3. The server is reachable from the internet\n4. Try adding /api to the URL if it doesn't work`,
      });
    }

    // If we connected on a different base URL, update the stored config
    if (workingBaseUrl !== baseUrl) {
      config.apiUrl = workingBaseUrl;
      await kv.set("evolution:config", config);
      console.log(`[EVO-TEST] Updated stored URL from ${baseUrl} to ${workingBaseUrl}`);
    }

    // Parse instances
    const instanceList = instances.map((inst: any) => ({
      name: inst.instance?.instanceName || inst.instanceName || inst.name || "unknown",
      status: inst.instance?.status || inst.status || "unknown",
      owner: inst.instance?.owner || inst.owner || "",
    }));

    const matchedInstance = instanceList.find(
      (i: any) => i.name.toLowerCase() === (config.instanceName || "").toLowerCase()
    );

    // Also check real-time socket state via connectionState
    let socketState = "unknown";
    let socketReady = false;
    if (matchedInstance && encoded) {
      try {
        const csRes = await evoFetch(workingBaseUrl, config.apiKey, `/instance/connectionState/${encoded}`, "GET");
        if (csRes.ok) {
          const csData = await csRes.json();
          socketState = csData?.instance?.state || csData?.instance?.connectionStatus || csData?.state || "unknown";
          socketReady = socketState === "open" || socketState === "connected";
          console.log(`[EVO-TEST] Socket state: ${socketState} (ready: ${socketReady})`);
        }
      } catch {}
    }

    return c.json({
      connected: true,
      apiVersion,
      baseUrl: workingBaseUrl,
      urlChanged: workingBaseUrl !== baseUrl ? `URL updated from ${baseUrl} to ${workingBaseUrl}` : undefined,
      instances: instanceList,
      matchedInstance: matchedInstance || null,
      instanceNameConfigured: config.instanceName,
      tried,
      errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
      socketState,
      socketReady,
      hint: matchedInstance
        ? `Instance "${matchedInstance.name}" found (${matchedInstance.status})${!socketReady ? ` ⚠️ Socket: ${socketState} — WhatsApp not connected!` : ` ✅ Socket: ${socketState}`}`
        : `Instance "${config.instanceName}" NOT found. Available: ${instanceList.map((i: any) => i.name).join(", ")}`,
    });
  } catch (error) {
    console.log("Evolution test error:", error);
    return c.json({ error: `Test connection error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// EVOLUTION API: Sync (Pull messages)
// ────────────────────────────────��────────────
app.post("/make-server-5c5dc789/evolution/sync", async (c) => {
  try {
    const config = await kv.get("evolution:config") as any;
    if (!config?.apiUrl || !config?.apiKey || !config?.instanceName) {
      return c.json({ error: "Evolution API not configured." }, 400);
    }

    const baseUrl = config.apiUrl;
    const instanceEnc = encodeURIComponent(config.instanceName);
    console.log(`Evolution sync: ${baseUrl}, instance: ${config.instanceName}`);

    // ── Step 0: Verify API key & instance connection ──
    // Only "open"/"connected" are truly ready — "connecting" means socket isn't ready
    const READY_STATES = new Set(["open", "connected"]);
    const ALIVE_STATES = new Set(["open", "connected", "connecting"]);

    let instanceState = "unknown";
    let instanceConnected = false;
    let instanceFound = false;
    let fetchInstancesStateSaved = "";
    const syncDiagnostics: string[] = [];
    let availableInstances: Array<{ name: string; state: string }> = [];

    // Helper: extract state from many possible fields in Evolution API response
    function extractInstanceState(inst: any): string {
      return (
        inst?.instance?.state ||
        inst?.instance?.connectionStatus ||
        inst?.instance?.status ||
        inst?.connectionStatus ||
        inst?.state ||
        inst?.status ||
        inst?.connection?.state ||
        ""
      );
    }

    // Helper to get real-time connectionState
    async function getSyncConnectionState(): Promise<string> {
      try {
        const stateRes = await evoFetch(baseUrl, config.apiKey, `/instance/connectionState/${instanceEnc}`, "GET");
        if (stateRes.ok) {
          const sd = await stateRes.json();
          const csRawKeys = Object.keys(sd || {}).join(",");
          const csInnerKeys = sd?.instance ? Object.keys(sd.instance).join(",") : "n/a";
          const cs = extractInstanceState(sd);
          syncDiagnostics.push(`connectionState → "${cs}" [keys: ${csRawKeys} | instance keys: ${csInnerKeys}]`);
          return cs;
        } else {
          const txt = await stateRes.text().catch(() => "");
          syncDiagnostics.push(`connectionState → ${stateRes.status}: ${txt.substring(0, 200)}`);
          if (stateRes.status === 404 && instanceFound) {
            syncDiagnostics.push(`  (404 on connectionState but instance found in list — proceeding)`);
          }
        }
      } catch (e: any) {
        syncDiagnostics.push(`connectionState → Error: ${e.message}`);
      }
      return "";
    }

    // 0a: fetchInstances to verify API key AND list all available instances
    let apiKeyValid = false;
    try {
      const iRes = await evoFetch(baseUrl, config.apiKey, "/instance/fetchInstances", "GET");
      if (iRes.ok) {
        apiKeyValid = true;
        const iData = await iRes.json();
        const instances = Array.isArray(iData) ? iData : (iData?.instances || []);
        syncDiagnostics.push(`fetchInstances → ${instances.length} instance(s) found`);
        for (const inst of instances) {
          const name = inst.instance?.instanceName || inst.instanceName || inst.name || "";
          const st = extractInstanceState(inst);
          const rawKeys = Object.keys(inst || {}).join(",");
          const innerKeys = inst?.instance ? Object.keys(inst.instance).join(",") : "n/a";
          syncDiagnostics.push(`  • "${name}" → state="${st}" [keys: ${rawKeys} | instance keys: ${innerKeys}]`);
          if (name) {
            availableInstances.push({ name, state: st || "unknown" });
          }
          if (name === config.instanceName) {
            instanceFound = true;
            instanceState = st;
            fetchInstancesStateSaved = st;
          }
        }
      } else {
        const txt = await iRes.text().catch(() => "");
        syncDiagnostics.push(`fetchInstances → ${iRes.status}: ${txt.substring(0, 200)}`);
        if (iRes.status === 401 || iRes.status === 403) {
          syncDiagnostics.push(`⚠️ API Key rejected (${iRes.status}) — check your API key in Settings`);
        }
      }
    } catch (e: any) {
      syncDiagnostics.push(`fetchInstances → Error: ${e.message}`);
    }

    // 0b: Direct connectionState = authoritative real-time socket state
    const syncRealState = await getSyncConnectionState();
    if (syncRealState) {
      if (fetchInstancesStateSaved && fetchInstancesStateSaved !== syncRealState) {
        syncDiagnostics.push(`ℹ️ fetchInstances="${fetchInstancesStateSaved}" vs connectionState="${syncRealState}" — using connectionState (real-time)`);
      }
      instanceState = syncRealState;
      if (!instanceFound) instanceFound = true;
    }

    // Determine if ready
    instanceConnected = READY_STATES.has(instanceState);

    // 0b2: If not ready, auto-restart and wait
    if (instanceFound && !instanceConnected) {
      syncDiagnostics.push(`⚠️ State is "${instanceState}" — attempting auto-restart...`);
      let restartAccepted = false;
      const restartAttempts: Array<{ method: "GET" | "POST" | "PUT" | "DELETE"; path: string }> = [
        { method: "GET", path: `/instance/connect/${instanceEnc}` },
        { method: "POST", path: `/instance/restart/${instanceEnc}` },
        { method: "PUT", path: `/instance/restart/${instanceEnc}` },
        { method: "POST", path: `/instance/connect/${instanceEnc}` },
        { method: "PUT", path: `/instance/connect/${instanceEnc}` },
      ];
      for (const { method, path } of restartAttempts) {
        if (restartAccepted) break;
        try {
          const rr = await evoFetch(baseUrl, config.apiKey, path, method);
          const rt = await rr.text();
          syncDiagnostics.push(`  ${method} ${path} → ${rr.status}: ${rt.substring(0, 150)}`);
          if (rr.ok) {
            restartAccepted = true;
            syncDiagnostics.push(`  ✅ Restart/connect command accepted`);
            try {
              const d = JSON.parse(rt);
              if (d?.base64 || d?.qrcode || d?.code) {
                syncDiagnostics.push(`  📱 QR Code returned — scan in Evolution API Manager`);
              }
            } catch {}
          }
        } catch (e: any) { syncDiagnostics.push(`  ${method} ${path} → Error: ${e.message}`); }
      }
      if (!restartAccepted) {
        syncDiagnostics.push(`  Trying logout + connect sequence...`);
        try { await evoFetch(baseUrl, config.apiKey, `/instance/logout/${instanceEnc}`, "DELETE"); } catch {}
        await new Promise(r => setTimeout(r, 2000));
        try {
          const cr = await evoFetch(baseUrl, config.apiKey, `/instance/connect/${instanceEnc}`, "GET");
          const ct = await cr.text();
          syncDiagnostics.push(`  GET /instance/connect (after logout) → ${cr.status}: ${ct.substring(0, 150)}`);
          if (cr.ok) { restartAccepted = true; syncDiagnostics.push(`  ✅ Connect after logout accepted`); }
        } catch (e: any) { syncDiagnostics.push(`  Connect after logout → Error: ${e.message}`); }
      }
      // Wait and re-check (3 attempts, 5s each)
      for (let attempt = 1; attempt <= 3; attempt++) {
        syncDiagnostics.push(`  ⏳ Waiting 5s... (attempt ${attempt}/3)`);
        await new Promise(r => setTimeout(r, 5000));
        const ns = await getSyncConnectionState();
        if (ns) instanceState = ns;
        syncDiagnostics.push(`  Re-check: state = "${instanceState}"`);
        if (READY_STATES.has(instanceState)) {
          instanceConnected = true;
          syncDiagnostics.push(`  ✅ Instance is now READY`);
          break;
        }
      }
    }

    // 0c: If instance found but state is empty/unknown, assume it's usable
    if (instanceFound && !instanceConnected) {
      const isDefinitelyDown = ["close", "closed", "disconnected", "refused", "banned", "connecting"].includes(instanceState);
      if (!isDefinitelyDown) {
        syncDiagnostics.push(`⚠️ State "${instanceState}" is ambiguous — instance found, proceeding with sync anyway`);
        instanceConnected = true;
      }
    }

    console.log(`[SYNC] Instance "${config.instanceName}" state: ${instanceState}, connected: ${instanceConnected}, found: ${instanceFound}, available: ${availableInstances.map(i => `${i.name}(${i.state})`).join(", ")}`);

    if (!instanceConnected) {
      const instanceExists = availableInstances.some(i => i.name === config.instanceName);
      const connectedInstances = availableInstances.filter(i => ALIVE_STATES.has(i.state));

      let errorMsg: string;
      let hint: string;

      if (!apiKeyValid) {
        errorMsg = `فشل التحقق من API Key — السيرفر رجّع 401 Unauthorized. تأكد إن الـ API Key صحيح في Settings.`;
        hint = "روح Settings → تأكد من الـ API Key → اضغط Save Config → وبعدها Test Connection";
      } else if (!instanceExists) {
        const available = availableInstances.map(i => `"${i.name}" (${i.state})`).join("، ");
        errorMsg = `الـ Instance "${config.instanceName}" مش موجود! الـ Instances المتاحة: ${available || "لا يوجد"}`;
        hint = connectedInstances.length > 0
          ? `غيّر اسم الـ Instance في Settings لـ "${connectedInstances[0].name}" واضغط Save Config`
          : "مفيش أي instance متصل. روح Evolution API Manager وأعد الاتصال.";
      } else {
        const isClosed = instanceState === "close" || instanceState === "closed";
        const isConnecting = instanceState === "connecting";
        errorMsg = `الـ Instance "${config.instanceName}" موجود بس الـ WhatsApp socket ${isClosed ? "مقفول" : isConnecting ? "عالق في connecting" : `في حالة "${instanceState}"`}. حاولنا auto-restart بس محصلش اتصال.`;
        hint = `🔧 الحل:\n1. روح Evolution API Manager: ${config.apiUrl.replace(/\/api$/, '')}\n2. اضغط على "${config.instanceName}"\n3. لو Disconnected → اضغط Connect\n4. لو ظهر QR Code → امسحه من واتساب (Linked Devices)\n5. استنى لحد ما يبقى "Connected" (أخضر)\n6. ارجع هنا واعمل Sync تاني`;
      }

      return c.json({
        error: errorMsg,
        instanceState,
        instanceConnected: false,
        diagnostics: syncDiagnostics,
        hint,
        availableInstances,
        suggestedInstance: connectedInstances.length > 0 ? connectedInstances[0].name : null,
        stuckConnecting: instanceState === "connecting",
      }, 503);
    }

    // Step 1: Fetch ALL contacts + chats from Evolution API using pagination
    const chatErrors: string[] = [];

    // ── Helper: paginate any POST endpoint until exhausted ──
    const fetchAllPages = async (path: string, bodyShapes: ((skip: number, limit: number) => any)[]): Promise<any[]> => {
      const PAGE = 100;
      let results: any[] = [];
      // Try each body shape until one returns data
      for (const shapeFn of bodyShapes) {
        const firstRes = await evoFetch(baseUrl, config.apiKey, path, "POST", shapeFn(0, PAGE)).catch(() => null);
        if (!firstRes?.ok) continue;
        const firstData = await firstRes.json().catch(() => null);
        const firstPage: any[] = Array.isArray(firstData) ? firstData : firstData?.chats || firstData?.contacts || firstData?.data || [];
        if (firstPage.length === 0) continue;
        results = [...firstPage];
        // Keep paginating while full pages come back
        let skip = PAGE;
        while (firstPage.length === PAGE || results.length === skip) {
          const res = await evoFetch(baseUrl, config.apiKey, path, "POST", shapeFn(skip, PAGE)).catch(() => null);
          if (!res?.ok) break;
          const d = await res.json().catch(() => null);
          const page: any[] = Array.isArray(d) ? d : d?.chats || d?.contacts || d?.data || [];
          if (page.length === 0) break;
          results.push(...page);
          skip += PAGE;
          if (page.length < PAGE) break;
        }
        break; // found a working shape
      }
      return results;
    };

    // ── 1a: Fetch ALL contacts (990 in your case) ──
    const contactShapes = [
      (s: number, l: number) => ({ where: {}, limit: l, skip: s }),
      (s: number, l: number) => ({ where: {}, take: l, skip: s }),
      (_s: number, _l: number) => ({}),
    ];
    const allContacts = await fetchAllPages(`/contact/findContacts/${instanceEnc}`, contactShapes)
      .catch(() => []);

    // ── 1b: Fetch ALL chats (613 in your case) ──
    const chatShapes = [
      (s: number, l: number) => ({ where: {}, limit: l, skip: s }),
      (s: number, l: number) => ({ where: {}, take: l, skip: s }),
      (_s: number, _l: number) => ({}),
    ];
    let chatsFromApi = await fetchAllPages(`/chat/findChats/${instanceEnc}`, chatShapes)
      .catch(() => []);
    // Fallback: try findChats GET
    if (chatsFromApi.length === 0) {
      const r = await evoFetch(baseUrl, config.apiKey, `/chat/findChats/${instanceEnc}`, "GET", undefined).catch(() => null);
      if (r?.ok) {
        const d = await r.json().catch(() => null);
        chatsFromApi = Array.isArray(d) ? d : d?.chats || d?.data || [];
      }
    }

    // ── 1c: Merge contacts + chats into a single deduplicated list ──
    const seen = new Set<string>();
    const chats: any[] = [];
    const addItem = (item: any) => {
      const jid = item.id || item.remoteJid || item.jid || item.pushName && `${item.phone || item.id}@s.whatsapp.net` || "";
      if (!jid || seen.has(jid)) return;
      seen.add(jid);
      chats.push(item);
    };
    for (const c of chatsFromApi) addItem(c);
    for (const c of allContacts) addItem(c);

    const chatEndpointUsed = `contacts:${allContacts.length} chats:${chatsFromApi.length}`;

    if (chats.length === 0) {
      return c.json({
        error: "Could not fetch chats from Evolution API.",
        instanceState,
        instanceConnected,
        chatErrors,
        diagnostics: syncDiagnostics,
        hint: "تأكد إن الـ instance متصل وفيه محادثات. جرب تبعت رسالة من الموبايل الأول.",
      }, 502);
    }

    let syncedConversations = 0;
    let syncedMessages = 0;
    const errors: string[] = [];
    const debugInfo: string[] = [];

    // Build dedup set from msgdedup: markers (set by both webhook and previous syncs)
    // Re-build properly: get the keys themselves from DB
    const [dedupRows] = await (kv as any).pool?.execute?.(
      "SELECT `key` FROM kv_store WHERE `key` LIKE 'msgdedup:%'",
      []
    ).catch(() => [[]]) || [[]];
    const dedupKeySet = new Set<string>(
      (Array.isArray(dedupRows) ? dedupRows : []).map((r: any) => (r.key || "").replace("msgdedup:", ""))
    );
    // Also include keys from existing cmsg: messages
    const existingCmsg = await kv.getByPrefix("cmsg:");
    for (const m of existingCmsg) {
      const k = m?.payload?.msgKeyId || m?.payload?.key?.id;
      if (k) dedupKeySet.add(k);
    }

    const individualChats = chats.filter((chat: any) => {
      const jid = chat.id || chat.remoteJid || chat.jid || "";
      const phone = chat.phone || chat.number || "";
      // Accept if JID is individual, OR if it has a phone number but no JID (contact-only entry)
      if (jid.includes("@g.us") || jid.includes("status@") || jid.includes("@broadcast")) return false;
      return jid.includes("@s.whatsapp.net") || (!jid && phone) || (jid && !jid.includes("@"));
    });

    const allConversations = await kv.getByPrefix("conversation:");

    debugInfo.push(`Total chats: ${chats.length}, Individual: ${individualChats.length}`);

    // ── Helper: store a single message (more forgiving) ──
    const storeMsg = async (msg: any, convId: string, source: string): Promise<boolean> => {
      if (!msg || typeof msg !== "object") return false;
      const msgKeyId = msg.key?.id || msg.id || msg.messageId || "";
      if (!msgKeyId) return false; // skip messages with no key — can't dedup them safely
      if (dedupKeySet.has(msgKeyId)) return false; // already stored

      const isFromMe = msg.key?.fromMe ?? msg.fromMe ?? false;
      const m = msg.message || msg;
      const messageText =
        m?.conversation || m?.extendedTextMessage?.text ||
        m?.imageMessage?.caption || m?.videoMessage?.caption ||
        m?.documentMessage?.caption || m?.body || msg.body || msg.text || "";
      const rawTs = msg.messageTimestamp || msg.timestamp;
      const timestamp = rawTs
        ? new Date(Number(rawTs) * (Number(rawTs) > 9999999999 ? 1 : 1000)).toISOString()
        : new Date().toISOString();
      const newMsgId = uuid();
      const msgObj = {
        id: newMsgId, conversation_id: convId,
        direction: isFromMe ? "outbound" : "inbound",
        sender_type: isFromMe ? "agent" : "customer",
        text: messageText || "(media)", sent_at: timestamp,
        payload: { key: msg.key, messageType: msg.messageType, msgKeyId, source },
      };
      await kv.set(`cmsg:${convId}:${newMsgId}`, msgObj);
      await kv.set(`msgdedup:${msgKeyId}`, { t: Date.now() });
      dedupKeySet.add(msgKeyId);
      return true;
    };

    // ── Step 2: Dump first chat object for debugging ──
    if (individualChats.length > 0) {
      const sample = individualChats[0];
      const sampleKeys = Object.keys(sample);
      debugInfo.push(`Chat[0] keys: ${sampleKeys.join(", ")}`);
      debugInfo.push(`Chat[0] raw: ${JSON.stringify(sample).substring(0, 800)}`);
    }

    // ── Helper: extract records array from any Evolution API response shape ──
    const extractRecords = (parsed: any): any[] => {
      if (Array.isArray(parsed)) return parsed;
      // {messages: {records: [], total, pages}} ← Evolution API v2 paginated
      if (parsed?.messages?.records && Array.isArray(parsed.messages.records)) return parsed.messages.records;
      if (parsed?.messages && Array.isArray(parsed.messages)) return parsed.messages;
      if (parsed?.records && Array.isArray(parsed.records)) return parsed.records;
      if (parsed?.data && Array.isArray(parsed.data)) return parsed.data;
      return [];
    };

    // ── Step 3: Detect working message endpoint ──
    // Use a real WhatsApp JID (phone@s.whatsapp.net), not a database ID
    let workingMsgEp: { path: string; bodyType: string; totalPages?: number } | null = null;
    if (individualChats.length > 0) {
      // Find first chat with a proper WhatsApp JID
      const testChat = individualChats.find((ch: any) => {
        const jid = ch.remoteJid || ch.jid || ch.id || "";
        return jid.includes("@s.whatsapp.net");
      }) || individualChats[0];

      const rawTestJid = testChat.remoteJid || testChat.jid || testChat.id || "";
      // Build proper @s.whatsapp.net JID if needed
      const testPhone = rawTestJid.includes("@")
        ? rawTestJid.replace(/@.*$/, "")
        : (testChat.phone || testChat.number || rawTestJid).replace(/[^0-9]/g, "");
      const testJid = testPhone ? `${testPhone}@s.whatsapp.net` : rawTestJid;

      debugInfo.push(`Test JID: ${testJid}`);

      const attempts = [
        { label: "key.remoteJid", path: `/chat/findMessages/${instanceEnc}`, method: "POST" as const, body: { where: { key: { remoteJid: testJid } }, limit: 10 } },
        { label: "remoteJid",     path: `/chat/findMessages/${instanceEnc}`, method: "POST" as const, body: { where: { remoteJid: testJid }, limit: 10 } },
        { label: "number",        path: `/chat/findMessages/${instanceEnc}`, method: "POST" as const, body: { number: testPhone, limit: 10 } },
        { label: "msg.findMessages", path: `/message/findMessages/${instanceEnc}`, method: "POST" as const, body: { where: { key: { remoteJid: testJid } }, limit: 10 } },
        { label: "get.chat", path: `/chat/findMessages/${instanceEnc}?remoteJid=${encodeURIComponent(testJid)}&limit=10`, method: "GET" as const, body: undefined },
      ];
      for (const att of attempts) {
        try {
          const res = await evoFetch(baseUrl, config.apiKey, att.path, att.method, att.body);
          const raw = await res.text();
          debugInfo.push(`${att.label} → ${res.status} (${raw.length}ch) ${raw.substring(0, 300)}`);
          if (res.ok && raw.length > 5) {
            let parsed: any;
            try { parsed = JSON.parse(raw); } catch { continue; }
            const records = extractRecords(parsed);
            const totalPages = parsed?.messages?.pages || 1;
            if (records.length > 0) {
              workingMsgEp = { path: att.path, bodyType: att.label, totalPages };
              debugInfo.push(`✓ WORKING: ${att.label} → ${records.length} messages (${totalPages} pages total)`);
              break;
            }
          }
        } catch (e) { debugInfo.push(`${att.label}: ERR ${e}`); }
      }
    }

    // ── Step 4: Process each chat ──
    for (const chat of individualChats) {
      // Prefer remoteJid/jid over id (id is often a database record ID, not a WhatsApp JID)
      const rawJid = chat.remoteJid || chat.jid || "";

      // Extract phone from various sources
      let phone = "";
      if (rawJid.includes("@s.whatsapp.net")) {
        phone = rawJid.replace("@s.whatsapp.net", "").replace(/[^0-9]/g, "");
      } else if (rawJid.includes("@lid")) {
        // @lid JID — try to get real phone from lastMessage.key.remoteJidAlt
        const altJid = chat.lastMessage?.key?.remoteJidAlt || chat.lastMessage?.key?.remoteJid || "";
        phone = altJid.includes("@s.whatsapp.net")
          ? altJid.replace("@s.whatsapp.net", "").replace(/[^0-9]/g, "")
          : rawJid.replace("@lid", "").replace(/[^0-9]/g, "");
      } else {
        phone = (chat.phone || chat.number || rawJid).replace(/[^0-9]/g, "");
      }
      if (!phone || phone.length < 7) continue;

      // Always use @s.whatsapp.net for storage (canonical JID)
      const remoteJid = `${phone}@s.whatsapp.net`;
      // Keep original JID for API calls (may be @lid)
      const apiJid = rawJid.includes("@") ? rawJid : remoteJid;

      const chatName = chat.name || chat.pushName || chat.contactName || chat.notify || chat.formattedName || phone;

      let conversation = allConversations.find((cv: any) => cv.customer_phone === phone);
      if (!conversation) {
        const convId = uuid();
        conversation = { id: convId, customer_phone: phone, customer_name: chatName,
          status: "open", assigned_agent_id: null,
          created_at: new Date().toISOString(), last_message_at: new Date().toISOString() };
        await kv.set(`conversation:${convId}`, conversation);
        allConversations.push(conversation);
        syncedConversations++;
      }

      // Extract embedded messages from chat object (many possible fields)
      const embedded: any[] = [];
      if (chat.messages && Array.isArray(chat.messages)) embedded.push(...chat.messages);
      if (chat.lastMessage && typeof chat.lastMessage === "object") embedded.push(chat.lastMessage);
      if (chat.msg && typeof chat.msg === "object") embedded.push(chat.msg);
      if (chat.last_message && typeof chat.last_message === "object") embedded.push(chat.last_message);
      // Some APIs nest it in chat.message
      if (chat.message && typeof chat.message === "object" && chat.message.key) embedded.push(chat);

      for (const em of embedded) {
        if (await storeMsg(em, conversation.id, "embedded")) syncedMessages++;
      }

      // Fetch messages via working endpoint (with pagination)
      if (workingMsgEp) {
        try {
          const PER_PAGE = 100;
          // Try both @s.whatsapp.net and original @lid JID for max compatibility
          const buildBody = (page: number, jidOverride?: string): any => {
            const j = jidOverride || remoteJid;
            if (workingMsgEp!.bodyType === "key.remoteJid")
              return { where: { key: { remoteJid: j } }, limit: PER_PAGE, page };
            if (workingMsgEp!.bodyType === "remoteJid")
              return { where: { remoteJid: j }, limit: PER_PAGE, page };
            if (workingMsgEp!.bodyType === "number")
              return { number: phone, limit: PER_PAGE, page };
            return { where: { key: { remoteJid: j } }, limit: PER_PAGE, page };
          };

          const method = workingMsgEp.bodyType.startsWith("get.") ? "GET" as const : "POST" as const;

          // Determine which JID(s) to try: @s.whatsapp.net first, then original @lid if different
          const jidsToTry = [remoteJid];
          if (apiJid !== remoteJid && apiJid.includes("@")) jidsToTry.push(apiJid);

          for (const jid of jidsToTry) {
            let currentPage = 1;
            let keepFetching = true;
            let fetchedFromThisJid = 0;

            while (keepFetching) {
              const body = buildBody(currentPage, jid);
              const res = await evoFetch(baseUrl, config.apiKey, workingMsgEp.path, method, body);
              if (!res.ok) break;
              const data = await res.json();
              const records = extractRecords(data);
              const totalPages = data?.messages?.pages || 1;

              for (const mm of records) {
                if (await storeMsg(mm, conversation.id, "api")) {
                  syncedMessages++;
                  fetchedFromThisJid++;
                }
              }
              if (records.length === 0 || currentPage >= totalPages || currentPage >= 20) {
                keepFetching = false;
              } else {
                currentPage++;
              }
            }
            // If we got messages with the first JID, no need to try the second
            if (fetchedFromThisJid > 0) break;
          }
        } catch (e) { errors.push(`${phone}: ${e}`); }
      }
    }

    // Track sync event
    const syncEvent = { id: uuid(), event: "manual_sync", phone: "system",
      customerName: "Evolution Sync", direction: "inbound",
      text: `Synced ${syncedMessages} msgs, ${syncedConversations} convos`,
      receivedAt: new Date().toISOString() };
    const existingEvents = await kv.get("webhook:events_log");
    const eventsLog = Array.isArray(existingEvents) ? existingEvents : [];
    eventsLog.unshift(syncEvent);
    if (eventsLog.length > 50) eventsLog.length = 50;
    await kv.set("webhook:events_log", eventsLog);

    return c.json({
      status: "ok", syncedMessages, syncedConversations,
      totalChatsFound: chats.length, processedChats: individualChats.length,
      chatEndpoint: chatEndpointUsed,
      messageEndpoint: workingMsgEp ? `${workingMsgEp.path} (${workingMsgEp.bodyType})` : "none found",
      debugInfo,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.log("Evolution sync error:", error);
    return c.json({ error: `Sync error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// EVOLUTION API: Auto-Register Webhook
// ─────────────────────────────────────────────
app.post("/make-server-5c5dc789/evolution/register-webhook", async (c) => {
  try {
    const config = await kv.get("evolution:config") as any;
    if (!config?.apiUrl || !config?.apiKey || !config?.instanceName) {
      return c.json({ error: "Save your Evolution API config first." }, 400);
    }

    const baseUrl = config.apiUrl;
    const instanceEnc = encodeURIComponent(config.instanceName);
    // Build the webhook URL that Evolution API will POST to
    const serverUrl = ((globalThis as any).process?.env?.SERVER_URL || "http://localhost:3001").replace(/\/$/, "");
    const webhookUrl = `${serverUrl}/make-server-5c5dc789/webhook/evolution`;
    const anonKey = "";

    console.log(`[WEBHOOK-REG] Registering: ${webhookUrl} on instance ${config.instanceName}`);

    const debugInfo: string[] = [];
    let registered = false;

    // ── Attempt: try various payload shapes for different Evolution API versions ──
    const webhookBodies = [
      {
        label: "v2-flat-with-headers",
        body: {
          enabled: true,
          url: webhookUrl,
          webhookByEvents: false,
          webhookBase64: false,
          headers: {
            "Authorization": `Bearer ${anonKey}`,
          },
          events: [
            "MESSAGES_UPSERT",
            "MESSAGES_UPDATE",
            "SEND_MESSAGE",
            "CONNECTION_UPDATE",
          ],
        },
      },
      {
        label: "v2-nested",
        body: {
          webhook: {
            enabled: true,
            url: webhookUrl,
            webhookByEvents: false,
            webhookBase64: false,
            headers: {
              "Authorization": `Bearer ${anonKey}`,
            },
            events: [
              "MESSAGES_UPSERT",
              "MESSAGES_UPDATE",
              "SEND_MESSAGE",
              "CONNECTION_UPDATE",
            ],
          },
        },
      },
      {
        label: "v2-flat",
        body: {
          enabled: true,
          url: webhookUrl,
          webhookByEvents: false,
          webhookBase64: false,
          events: [
            "MESSAGES_UPSERT",
            "MESSAGES_UPDATE",
            "SEND_MESSAGE",
            "CONNECTION_UPDATE",
          ],
        },
      },
      {
        label: "v2-events-lowercase",
        body: {
          enabled: true,
          url: webhookUrl,
          webhookByEvents: false,
          webhookBase64: false,
          events: [
            "messages.upsert",
            "messages.update",
            "send.message",
            "connection.update",
          ],
        },
      },
    ];

    // Try PUT first, then POST
    for (const method of ["PUT", "POST"] as const) {
      for (const webhookPath of [
        `/webhook/set/${instanceEnc}`,
        `/webhook/${instanceEnc}`,
      ]) {
        if (registered) break;
        for (const attempt of webhookBodies) {
          if (registered) break;
          try {
            const url = `${baseUrl}${webhookPath}`;
            debugInfo.push(`${method} ${webhookPath} (${attempt.label})`);
            const res = await evoFetch(baseUrl, config.apiKey, webhookPath, method as any, attempt.body);
            const txt = await res.text();
            debugInfo.push(`  → ${res.status} (${txt.length} chars): ${txt.substring(0, 200)}`);
            if (res.ok) {
              registered = true;
              debugInfo.push(`  ✓ REGISTERED via ${method} ${webhookPath} (${attempt.label})`);
              break;
            }
          } catch (e) {
            debugInfo.push(`  → error: ${e}`);
          }
        }
      }
    }

    // ── Verify: GET webhook config ──
    let currentConfig: any = null;
    for (const checkPath of [
      `/webhook/find/${instanceEnc}`,
      `/webhook/${instanceEnc}`,
    ]) {
      try {
        const res = await evoFetch(baseUrl, config.apiKey, checkPath, "GET");
        if (res.ok) {
          currentConfig = await res.json();
          debugInfo.push(`Verified via GET ${checkPath}: ${JSON.stringify(currentConfig).substring(0, 300)}`);
          break;
        }
      } catch (_) {}
    }

    // Store registration status
    await kv.set("evolution:webhook_registered", {
      registered,
      webhookUrl,
      registeredAt: new Date().toISOString(),
      debugInfo,
    });

    return c.json({
      registered,
      webhookUrl,
      currentConfig,
      debugInfo,
      message: registered
        ? "Webhook registered successfully! Messages will now flow automatically to the dashboard."
        : "Could not auto-register webhook. You may need to set it manually in Evolution API dashboard.",
    });
  } catch (error) {
    console.log("Register webhook error:", error);
    return c.json({ error: `Register webhook error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// EVOLUTION API: Check Webhook Status
// ─────────────────────────────────────────────
app.get("/make-server-5c5dc789/evolution/webhook-status", async (c) => {
  try {
    const config = await kv.get("evolution:config") as any;
    if (!config?.apiUrl || !config?.apiKey || !config?.instanceName) {
      return c.json({ configured: false });
    }

    const baseUrl = config.apiUrl;
    const instanceEnc = encodeURIComponent(config.instanceName);

    // Check what webhook is currently set
    let webhookConfig: any = null;
    for (const path of [
      `/webhook/find/${instanceEnc}`,
      `/webhook/${instanceEnc}`,
    ]) {
      try {
        const res = await evoFetch(baseUrl, config.apiKey, path, "GET");
        if (res.ok) {
          webhookConfig = await res.json();
          break;
        }
      } catch (_) {}
    }

    // Check our stored registration
    const storedReg = await kv.get("evolution:webhook_registered") as any;

    const supabaseUrl = process.env.SERVER_URL || "http://localhost:3001";
    const anonKey = "";
    const ourWebhookUrl = `${supabaseUrl}/functions/v1/make-server-5c5dc789/webhook/evolution?apikey=${anonKey}`;

    // Determine if our webhook is active
    const currentUrl = webhookConfig?.webhook?.url || webhookConfig?.url || "";
    const isOurWebhook = currentUrl.includes("make-server-5c5dc789");
    const isEnabled = webhookConfig?.webhook?.enabled ?? webhookConfig?.enabled ?? false;

    return c.json({
      configured: true,
      webhookConfig,
      isOurWebhook,
      isEnabled,
      ourWebhookUrl,
      storedRegistration: storedReg,
    });
  } catch (error) {
    console.log("Webhook status error:", error);
    return c.json({ error: `Webhook status error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// BULK MESSAGING: Send WhatsApp Messages
// ─────────────────────────────────────────────
app.post("/make-server-5c5dc789/bulk-message/send", async (c) => {
  try {
    const config = await kv.get("evolution:config") as any;
    if (!config?.apiUrl || !config?.apiKey || !config?.instanceName) {
      return c.json({ error: "Evolution API not configured. Go to Settings > Evolution API Direct Sync." }, 400);
    }

    const body = await c.req.json();
    const { 
      phoneNumbers = [], 
      message = "", 
      imageUrl = null,
      minDelay = 2, // seconds
      maxDelay = 5 
    } = body;

    // Validate inputs
    if (!Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
      return c.json({ error: "Please provide at least one phone number" }, 400);
    }
    if (!message || message.trim().length === 0) {
      return c.json({ error: "Message text cannot be empty" }, 400);
    }
    if (minDelay < 1 || maxDelay < minDelay) {
      return c.json({ error: "Invalid delay range. minDelay must be >= 1 and maxDelay >= minDelay" }, 400);
    }

    const baseUrl = config.apiUrl;
    const instanceEnc = encodeURIComponent(config.instanceName);

    // Quick connection check via connectionState (real-time socket state)
    try {
      const stRes = await evoFetch(baseUrl, config.apiKey, `/instance/connectionState/${instanceEnc}`, "GET");
      if (stRes.ok) {
        const sd = await stRes.json();
        const st = sd?.instance?.state || sd?.instance?.connectionStatus || sd?.state || "";
        if (st !== "open" && st !== "connected") {
          console.log(`[BULK] Instance state "${st}" — attempting auto-connect...`);
          for (const { m, p } of [
            { m: "GET" as const, p: `/instance/connect/${instanceEnc}` },
            { m: "POST" as const, p: `/instance/restart/${instanceEnc}` },
          ]) {
            try {
              const rr = await evoFetch(baseUrl, config.apiKey, p, m);
              const rt = await rr.text();
              console.log(`[BULK] ${m} ${p} → ${rr.status}: ${rt.substring(0, 150)}`);
              if (rr.ok) {
                // Check if QR code returned
                try {
                  const d = JSON.parse(rt);
                  if (d?.base64 || d?.qrcode || d?.code) {
                    console.log(`[BULK] ⚠️ QR code returned — user needs to scan`);
                  }
                } catch {}
                break;
              }
            } catch {}
          }
          // Wait longer for connection to establish
          await new Promise(r => setTimeout(r, 8000));
          const recheck = await evoFetch(baseUrl, config.apiKey, `/instance/connectionState/${instanceEnc}`, "GET");
          if (recheck.ok) {
            const rd = await recheck.json();
            const newSt = rd?.instance?.state || rd?.state || "";
            if (newSt !== "open" && newSt !== "connected") {
              return c.json({ error: `Instance "${config.instanceName}" مش جاهز (state: ${newSt || st}). الـ WhatsApp socket مقفول.\n\n🔧 الحل:\n1. روح Evolution API Manager\n2. اضغط على Instance "${config.instanceName}"\n3. لو طلب QR Code → امسحه من واتساب\n4. استنى لما يبقى "Connected" (أخضر)\n5. ارجع هنا وجرّب تاني` }, 503);
            }
          }
        }
      }
    } catch {}

    const results: Array<{ phone: string; success: boolean; error?: string; delayUsed?: number }> = [];
    
    console.log(`Starting bulk send to ${phoneNumbers.length} numbers via ${baseUrl}`);

    for (let i = 0; i < phoneNumbers.length; i++) {
      const rawPhone = phoneNumbers[i].toString().trim();
      // Normalize phone: remove spaces, dashes, etc.
      const phone = rawPhone.replace(/[^0-9]/g, "");
      
      if (phone.length < 10) {
        results.push({ phone: rawPhone, success: false, error: "Invalid phone number format" });
        continue;
      }

      // Evolution API v2 expects raw phone number WITHOUT @s.whatsapp.net
      // The API adds the JID suffix internally
      const phoneFormatted = phone;

      // Send message using correct payload structure (discovered from test-send)
      let sent = false;
      let lastError = "";

      if (imageUrl && imageUrl.trim().length > 0) {
        // Send image with caption - try raw number first, then with JID
        const mediaPayloads = [
          { number: phoneFormatted, mediaMessage: { mediatype: "image", media: imageUrl.trim(), caption: message.trim() } },
          { number: phoneFormatted, media: imageUrl.trim(), caption: message.trim(), mediatype: "image" },
          { number: `${phoneFormatted}@s.whatsapp.net`, mediaMessage: { mediatype: "image", media: imageUrl.trim(), caption: message.trim() } },
        ];
        
        for (const payload of mediaPayloads) {
          try {
            const res = await evoFetch(baseUrl, config.apiKey, `/message/sendMedia/${instanceEnc}`, "POST", payload);
            if (res.ok) {
              sent = true;
              console.log(`✅ Sent image to ${phone}`);
              break;
            } else {
              const errText = await res.text();
              lastError = `${res.status}: ${errText}`;
            }
          } catch (e: any) {
            lastError = e.message || String(e);
          }
        }
      } else {
        // Send text only - try raw number first, then with JID suffix
        const textPayloads = [
          { number: phoneFormatted, text: message.trim() },
          { number: `${phoneFormatted}@s.whatsapp.net`, text: message.trim() },
        ];

        for (const payload of textPayloads) {
          try {
            const res = await evoFetch(baseUrl, config.apiKey, `/message/sendText/${instanceEnc}`, "POST", payload);
            if (res.ok) {
              sent = true;
              console.log(`✅ Sent text to ${phone}`);
              break;
            } else {
              const errText = await res.text();
              lastError = `${res.status}: ${errText}`;
            }
          } catch (e: any) {
            lastError = e.message || String(e);
          }
        }
      }

      // Random delay between messages (avoid WhatsApp rate limits / spam detection)
      const randomDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay) * 1000;
      
      if (sent) {
        results.push({ phone: rawPhone, success: true, delayUsed: randomDelay / 1000 });
      } else {
        results.push({ phone: rawPhone, success: false, error: lastError || "Unknown error" });
      }

      // Wait before sending next message (except for last one)
      if (i < phoneNumbers.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, randomDelay));
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    // Store campaign in KV for history
    const campaignId = uuid();
    await kv.set(`bulk_campaign:${campaignId}`, {
      id: campaignId,
      createdAt: new Date().toISOString(),
      message,
      imageUrl,
      totalRecipients: phoneNumbers.length,
      successCount,
      failCount,
      allRecipients: phoneNumbers,
      results,
    });

    console.log(`Bulk send complete: ${successCount} success, ${failCount} failed`);

    return c.json({
      status: "ok",
      campaignId,
      totalRecipients: phoneNumbers.length,
      successCount,
      failCount,
      results,
    });
  } catch (error) {
    console.log("Bulk message send error:", error);
    return c.json({ error: `Bulk send error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// BULK MESSAGING: Streamed Send (SSE) — Live Progress + Skip
// ─────────────────────────────────────────────
app.post("/make-server-5c5dc789/bulk-message/send-stream", async (c) => {
  try {
    const config = await kv.get("evolution:config") as any;
    if (!config?.apiUrl || !config?.apiKey || !config?.instanceName) {
      return c.json({ error: "Evolution API not configured. Go to Settings > Evolution API Direct Sync." }, 400);
    }

    const body = await c.req.json();
    const {
      phoneNumbers = [],
      message = "",
      imageUrl = null,
      minDelay = 2,
      maxDelay = 5,
      sessionId = "",
      // Human Mode parameters
      humanMode = false,
      batchSize = 5,
      batchRestMin = 60,
      batchRestMax = 120,
      messageVariants = [] as string[],
      shuffleNumbers = false,
    } = body;

    if (!Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
      return c.json({ error: "Please provide at least one phone number" }, 400);
    }
    if (!message || message.trim().length === 0) {
      return c.json({ error: "Message text cannot be empty" }, 400);
    }
    if (minDelay < 1 || maxDelay < minDelay) {
      return c.json({ error: "Invalid delay range" }, 400);
    }

    const baseUrl = config.apiUrl;
    const instanceEnc = encodeURIComponent(config.instanceName);

    // Quick connection check via connectionState (real-time socket state)
    try {
      const stRes = await evoFetch(baseUrl, config.apiKey, `/instance/connectionState/${instanceEnc}`, "GET");
      if (stRes.ok) {
        const sd = await stRes.json();
        const st = sd?.instance?.state || sd?.instance?.connectionStatus || sd?.state || "";
        if (st !== "open" && st !== "connected") {
          console.log(`[BULK-STREAM] Instance state "${st}" — attempting auto-connect...`);
          for (const { m, p } of [
            { m: "GET" as const, p: `/instance/connect/${instanceEnc}` },
            { m: "POST" as const, p: `/instance/restart/${instanceEnc}` },
          ]) {
            try {
              const rr = await evoFetch(baseUrl, config.apiKey, p, m);
              const rt = await rr.text();
              console.log(`[BULK-STREAM] ${m} ${p} → ${rr.status}: ${rt.substring(0, 150)}`);
              if (rr.ok) {
                try {
                  const d = JSON.parse(rt);
                  if (d?.base64 || d?.qrcode || d?.code) {
                    console.log(`[BULK-STREAM] ⚠️ QR code returned — user needs to scan`);
                  }
                } catch {}
                break;
              }
            } catch {}
          }
          await new Promise(r => setTimeout(r, 8000));
          const recheck = await evoFetch(baseUrl, config.apiKey, `/instance/connectionState/${instanceEnc}`, "GET");
          if (recheck.ok) {
            const rd = await recheck.json();
            const newSt = rd?.instance?.state || rd?.state || "";
            if (newSt !== "open" && newSt !== "connected") {
              return c.json({ error: `Instance مش جاهز (state: ${newSt || st}). الـ WhatsApp socket مقفول.\n\n🔧 الحل:\n1. روح Evolution API Manager\n2. اضغط على Instance "${config.instanceName}"\n3. لو طلب QR Code → امسحه من واتساب\n4. استنى لما يبقى "Connected" (أخضر)\n5. ارجع هنا وجرّب تاني` }, 503);
            }
          }
        }
      }
    } catch {}

    // Optionally shuffle numbers for human mode
    let finalPhoneNumbers = [...phoneNumbers];
    if (humanMode && shuffleNumbers) {
      for (let ii = finalPhoneNumbers.length - 1; ii > 0; ii--) {
        const jj = Math.floor(Math.random() * (ii + 1));
        [finalPhoneNumbers[ii], finalPhoneNumbers[jj]] = [finalPhoneNumbers[jj], finalPhoneNumbers[ii]];
      }
    }

    const total = finalPhoneNumbers.length;
    const skipKey = sessionId ? `bulk_skip:${sessionId}` : "";
    const stopKey = sessionId ? `bulk_stop:${sessionId}` : "";

    // Clear any stale flags
    if (skipKey) { try { await kv.del(skipKey); } catch {} }
    if (stopKey) { try { await kv.del(stopKey); } catch {} }

    // Build message variants array for spinning
    const allMessages: string[] = [message.trim()];
    if (humanMode && Array.isArray(messageVariants)) {
      for (const v of messageVariants) {
        const trimmed = (v || "").trim();
        if (trimmed && trimmed !== message.trim()) {
          allMessages.push(trimmed);
        }
      }
    }

    console.log(`[BulkStream] Starting streamed bulk send to ${total} numbers, session=${sessionId}, humanMode=${humanMode}, variants=${allMessages.length}, batchSize=${batchSize}, shuffle=${shuffleNumbers}`);

    // Helper: check if skip was requested
    const checkSkip = async (): Promise<boolean> => {
      if (!skipKey) return false;
      try { const val = await kv.get(skipKey); return !!val; } catch { return false; }
    };
    // Helper: clear skip flag after consuming
    const clearSkip = async () => {
      if (!skipKey) return;
      try { await kv.del(skipKey); } catch {}
    };
    // Helper: check if stop was requested
    const checkStop = async (): Promise<boolean> => {
      if (!stopKey) return false;
      try { const val = await kv.get(stopKey); return !!val; } catch { return false; }
    };
    // Helper: pick a random message variant
    const pickMessage = (): string => {
      if (allMessages.length === 1) return allMessages[0];
      return allMessages[Math.floor(Math.random() * allMessages.length)];
    };

    const encoder = new TextEncoder();
    // Track client disconnection
    let cancelled = false;

    const stream = new ReadableStream({
      async start(controller) {
        // Safe send — silently stops if client disconnected
        // critical=true means a send failure should set cancelled (e.g., result, done events)
        // critical=false means a send failure is logged but doesn't kill the campaign (e.g., countdown ticks)
        const send = (eventData: any, critical = true): boolean => {
          if (cancelled) return false;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(eventData)}\n\n`));
            return true;
          } catch (e) {
            if (critical) {
              console.log("[BulkStream] Client disconnected on critical send, stopping writes");
              cancelled = true;
            } else {
              console.log(`[BulkStream] Non-critical send failed (type=${eventData?.type}), continuing`);
            }
            return false;
          }
        };

        const campaignStartedAt = Date.now();
        send({ type: "start", total, sessionId, humanMode, batchSize: humanMode ? batchSize : total, shuffled: shuffleNumbers, variants: allMessages.length, startedAt: new Date().toISOString(), message: `Starting send to ${total} recipients${humanMode ? " (Human Mode)" : ""}...` });

        const results: Array<{ phone: string; success: boolean; error?: string; skipped?: boolean; messageUsed?: string }> = [];
        let successCount = 0;
        let failCount = 0;
        let skipCount = 0;
        let consecutiveConnectionErrors = 0;
        let autoStopped = false;
        let manuallyStopped = false;

        for (let i = 0; i < total; i++) {
          // Abort loop if client disconnected
          if (cancelled) {
            console.log(`[BulkStream] Client gone at index ${i}/${total}, stopping loop`);
            break;
          }

          // Check for manual stop
          if (await checkStop()) {
            manuallyStopped = true;
            console.log(`[BulkStream] Campaign manually stopped at index ${i}/${total}`);
            send({ type: "campaign_stopped", reason: "manual", index: i, total, successCount, failCount, skipCount, elapsedSeconds: Math.round((Date.now() - campaignStartedAt) / 1000) });
            break;
          }

          // Human Mode: batch rest
          if (humanMode && i > 0 && i % batchSize === 0) {
            const batchNumber = Math.floor(i / batchSize);
            const totalBatches = Math.ceil(total / batchSize);
            const restDuration = Math.floor(Math.random() * (batchRestMax - batchRestMin + 1) + batchRestMin) * 1000;
            console.log(`[BulkStream] Batch ${batchNumber}/${totalBatches} complete. Resting ${restDuration / 1000}s...`);
            send({ type: "batch_rest", batchNumber, totalBatches, restDuration, nextBatchStart: i });
            const restStart = Date.now();
            while (Date.now() - restStart < restDuration && !cancelled) {
              if (await checkStop()) {
                manuallyStopped = true;
                send({ type: "campaign_stopped", reason: "manual_during_rest", index: i, total, successCount, failCount, skipCount, elapsedSeconds: Math.round((Date.now() - campaignStartedAt) / 1000) });
                break;
              }
              if (await checkSkip()) {
                await clearSkip();
                send({ type: "skip_wait", message: "تم تخطي فترة الاستراحة" });
                break;
              }
              const elapsed = Date.now() - restStart;
              const remaining = Math.max(0, restDuration - elapsed);
              send({ type: "batch_countdown", remaining, batchNumber, totalBatches }, false);
              await new Promise((resolve) => setTimeout(resolve, 5000));
            }
            if (manuallyStopped || cancelled) break;
            // Notify frontend that batch rest ended and sending is about to resume
            if (!manuallyStopped && !cancelled) {
              console.log(`[BulkStream] Batch ${batchNumber} rest ended, resuming...`);
              send({ type: "batch_rest_end", batchNumber, totalBatches, nextIndex: i });
            }
          }

          // Auto-stop on 3 consecutive connection closed errors
          if (humanMode && consecutiveConnectionErrors >= 3) {
            autoStopped = true;
            const lastErrDetail = results.length > 0 ? results[results.length - 1]?.error || "" : "";
            console.log(`[BulkStream] Auto-stopped: 3 consecutive connection errors at index ${i}`);
            send({ type: "auto_stopped", reason: "3_consecutive_connection_errors", index: i, total, successCount, failCount, skipCount, elapsedSeconds: Math.round((Date.now() - campaignStartedAt) / 1000), message: `تم اكتشاف 3 أخطاء اتصال متتالية. آخر خطأ: ${lastErrDetail}` });
            break;
          }

          const rawPhone = finalPhoneNumbers[i].toString().trim();
          const phone = rawPhone.replace(/[^0-9]/g, "");

          // Check skip BEFORE starting this number
          if (await checkSkip()) {
            await clearSkip();
            skipCount++;
            failCount++;
            results.push({ phone: rawPhone, success: false, error: "تم التخطي يدوياً", skipped: true });
            send({
              type: "result", index: i, total, phone: rawPhone,
              success: false, error: "تم التخطي يدوياً", skipped: true,
              successCount, failCount, skipCount,
              progress: Math.round(((i + 1) / total) * 100),
            });
            continue;
          }

          // Pick message for this recipient (spinning)
          const currentMessage = pickMessage();

          send({
            type: "sending", index: i, total, phone: rawPhone,
            progress: Math.round(((i) / total) * 100),
            batchNumber: humanMode ? Math.floor(i / batchSize) + 1 : undefined,
            messagePreview: allMessages.length > 1 ? currentMessage.substring(0, 50) : undefined,
          });

          if (phone.length < 10) {
            failCount++;
            results.push({ phone: rawPhone, success: false, error: "Invalid phone number format" });
            send({
              type: "result", index: i, total, phone: rawPhone,
              success: false, error: "Invalid phone number format",
              successCount, failCount, skipCount,
              progress: Math.round(((i + 1) / total) * 100),
            });
            continue;
          }

          // Evolution API v2 expects raw phone number WITHOUT @s.whatsapp.net
          const phoneFormatted = phone;
          let sent = false;
          let lastError = "";
          let wasSkipped = false;

          // Send with 30s timeout + skip/stop polling
          const ac = new AbortController();
          const timeoutId = setTimeout(() => ac.abort(), 30000);
          let skipPollBusy = false;
          const skipPoll = setInterval(async () => {
            if (skipPollBusy) return; // prevent overlapping checks
            skipPollBusy = true;
            try {
              if (await checkSkip() || await checkStop()) ac.abort();
            } catch { /* ignore KV errors in poll */ }
            skipPollBusy = false;
          }, 2000);

          try {
            if (imageUrl && imageUrl.trim().length > 0) {
              // Try raw number first, then with JID suffix as fallback
              const mediaPayloads = [
                { number: phoneFormatted, mediaMessage: { mediatype: "image", media: imageUrl.trim(), caption: currentMessage } },
                { number: phoneFormatted, media: imageUrl.trim(), caption: currentMessage, mediatype: "image" },
                { number: `${phoneFormatted}@s.whatsapp.net`, mediaMessage: { mediatype: "image", media: imageUrl.trim(), caption: currentMessage } },
              ];
              for (const payload of mediaPayloads) {
                if (ac.signal.aborted) break;
                try {
                  const res = await evoFetch(baseUrl, config.apiKey, `/message/sendMedia/${instanceEnc}`, "POST", payload, ac.signal);
                  if (res.ok) { sent = true; break; }
                  else {
                    const errText = await res.text();
                    lastError = `${res.status}: ${errText.substring(0, 100)}`;
                  }
                } catch (e: any) {
                  if (ac.signal.aborted) {
                    const isStop = await checkStop();
                    if (isStop) { manuallyStopped = true; lastError = "تم إيقاف الحملة"; break; }
                    const isSkip = await checkSkip();
                    if (isSkip) { wasSkipped = true; await clearSkip(); lastError = "تم التخطي يدوياً"; }
                    else { lastError = "تجاوز المهلة (30 ثانية)"; }
                    break;
                  }
                  lastError = e.message || String(e);
                }
              }
            } else {
              // Try raw number first, then with JID suffix as fallback
              const textPayloads = [
                { number: phoneFormatted, text: currentMessage },
                { number: `${phoneFormatted}@s.whatsapp.net`, text: currentMessage },
              ];
              for (const payload of textPayloads) {
                if (ac.signal.aborted) break;
                try {
                  const res = await evoFetch(baseUrl, config.apiKey, `/message/sendText/${instanceEnc}`, "POST", payload, ac.signal);
                  if (res.ok) { sent = true; break; }
                  else {
                    const errText = await res.text();
                    lastError = `${res.status}: ${errText.substring(0, 100)}`;
                  }
                } catch (e: any) {
                  if (ac.signal.aborted) {
                    const isStop = await checkStop();
                    if (isStop) { manuallyStopped = true; lastError = "تم إيقاف الحملة"; }
                    else {
                      const isSkip = await checkSkip();
                      if (isSkip) { wasSkipped = true; await clearSkip(); lastError = "تم التخطي يدوياً"; }
                      else { lastError = "تجاوز المهلة (30 ثانية)"; }
                    }
                    break;
                  } else {
                    lastError = e.message || String(e);
                  }
                }
              }
            }
          } finally {
            clearTimeout(timeoutId);
            clearInterval(skipPoll);
          }

          if (manuallyStopped) {
            failCount++;
            results.push({ phone: rawPhone, success: false, error: lastError, messageUsed: currentMessage });
            send({ type: "campaign_stopped", reason: "manual", index: i, total, successCount, failCount, skipCount, elapsedSeconds: Math.round((Date.now() - campaignStartedAt) / 1000) });
            break;
          }

          if (sent) {
            successCount++;
            consecutiveConnectionErrors = 0;
            results.push({ phone: rawPhone, success: true, messageUsed: currentMessage });
          } else {
            failCount++;
            if (wasSkipped) skipCount++;
            results.push({ phone: rawPhone, success: false, error: lastError || "Unknown error", skipped: wasSkipped, messageUsed: currentMessage });
            // Track consecutive connection errors for auto-stop
            const lowerErr = (lastError || "").toLowerCase();
            if (lowerErr.includes("connection closed") || lowerErr.includes("connection reset") || lowerErr.includes("connection refused") || lowerErr.includes("econnreset") || lowerErr.includes("socket hang up")) {
              consecutiveConnectionErrors++;
              console.log(`[BulkStream] Connection error #${consecutiveConnectionErrors}: ${lastError}`);
            } else if (!wasSkipped) {
              consecutiveConnectionErrors = 0;
            }
          }

          send({
            type: "result", index: i, total, phone: rawPhone,
            success: sent, error: sent ? undefined : lastError,
            skipped: wasSkipped, successCount, failCount, skipCount,
            progress: Math.round(((i + 1) / total) * 100),
            messageUsed: allMessages.length > 1 ? currentMessage.substring(0, 80) : undefined,
            batchNumber: humanMode ? Math.floor(i / batchSize) + 1 : undefined,
          });

          // Interruptible delay between messages
          if (i < total - 1 && !cancelled && !manuallyStopped && !autoStopped) {
            // In human mode, skip inter-message delay if next message starts a new batch
            if (humanMode && (i + 1) % batchSize === 0) {
              // batch rest will handle it
            } else {
              const effectiveMinDelay = humanMode ? Math.max(minDelay, 8) : minDelay;
              const effectiveMaxDelay = humanMode ? Math.max(maxDelay, 15) : maxDelay;
              const randomDelay = Math.floor(Math.random() * (effectiveMaxDelay - effectiveMinDelay + 1) + effectiveMinDelay) * 1000;
              send({ type: "waiting", index: i, delayMs: randomDelay, nextPhone: finalPhoneNumbers[i + 1] });
              const delayStart = Date.now();
              while (Date.now() - delayStart < randomDelay && !cancelled) {
                if (await checkStop()) {
                  manuallyStopped = true;
                  send({ type: "campaign_stopped", reason: "manual_during_delay", index: i, total, successCount, failCount, skipCount, elapsedSeconds: Math.round((Date.now() - campaignStartedAt) / 1000) });
                  break;
                }
                if (await checkSkip()) {
                  await clearSkip();
                  send({ type: "skip_wait", message: "تم تخطي فترة الانتظار" });
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 500));
              }
              if (manuallyStopped) break;
            }
          }
        }

        // Always save campaign results (even if client disconnected)
        const campaignId = uuid();
        const elapsedSeconds = Math.round((Date.now() - campaignStartedAt) / 1000);
        try {
          await kv.set(`bulk_campaign:${campaignId}`, {
            id: campaignId,
            createdAt: new Date().toISOString(),
            message,
            messageVariants: allMessages.length > 1 ? allMessages : undefined,
            imageUrl,
            humanMode,
            totalRecipients: total,
            successCount,
            failCount,
            autoStopped,
            manuallyStopped,
            elapsedSeconds,
            allRecipients: finalPhoneNumbers,
            results,
          });
        } catch (e) {
          console.log("[BulkStream] Failed to save campaign:", e);
        }

        // Clean up stop + skip flags
        if (stopKey) { try { await kv.del(stopKey); } catch {} }
        if (skipKey) { try { await kv.del(skipKey); } catch {} }

        send({
          type: "done", campaignId, total,
          successCount, failCount, skipCount,
          autoStopped, manuallyStopped,
          elapsedSeconds,
          progress: 100, results,
        });

        console.log(`[BulkStream] Complete: ${successCount} success, ${failCount} failed, ${skipCount} skipped, autoStopped=${autoStopped}, manuallyStopped=${manuallyStopped}, cancelled=${cancelled}`);
        // Safely close the controller
        if (!cancelled) {
          try { controller.close(); } catch {}
        }
      },
      cancel() {
        // Called by Deno when the client disconnects
        console.log("[BulkStream] Stream cancelled — client disconnected");
        cancelled = true;
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
      },
    });
  } catch (error) {
    console.log("BulkStream error:", error);
    return c.json({ error: `BulkStream error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// BULK MESSAGING: Stop campaign
// ─────────────────────────────────────────────
app.post("/make-server-5c5dc789/bulk-message/stop", async (c) => {
  try {
    const { sessionId } = await c.req.json();
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    await kv.set(`bulk_stop:${sessionId}`, { stop: true, at: new Date().toISOString() });
    console.log(`[BulkStop] Stop requested for session ${sessionId}`);
    return c.json({ status: "ok", message: "Stop signal sent" });
  } catch (error) {
    console.log("BulkStop error:", error);
    return c.json({ error: `Stop error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// BULK MESSAGING: Skip current number / wait
// ─────────────────────────────────────────────
app.post("/make-server-5c5dc789/bulk-message/skip", async (c) => {
  try {
    const { sessionId } = await c.req.json();
    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    await kv.set(`bulk_skip:${sessionId}`, { skip: true, at: new Date().toISOString() });
    console.log(`[BulkSkip] Skip requested for session ${sessionId}`);
    return c.json({ status: "ok", message: "Skip signal sent" });
  } catch (error) {
    console.log("BulkSkip error:", error);
    return c.json({ error: `Skip error: ${error}` }, 500);
  }
});

// Get bulk message campaign history
app.get("/make-server-5c5dc789/bulk-message/campaigns", async (c) => {
  try {
    const campaigns = await kv.getByPrefix("bulk_campaign:");
    const sorted = campaigns.sort(
      (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return c.json({ campaigns: sorted });
  } catch (error) {
    console.log("Campaigns get error:", error);
    return c.json({ error: `Campaigns get error: ${error}` }, 500);
  }
});

// Test single message send with detailed debugging
app.post("/make-server-5c5dc789/bulk-message/test-send", async (c) => {
  try {
    const config = await kv.get("evolution:config") as any;
    if (!config?.apiUrl || !config?.apiKey || !config?.instanceName) {
      return c.json({ error: "Evolution API not configured" }, 400);
    }

    const body = await c.req.json();
    const { phone, message, imageUrl = null } = body;

    if (!phone || !message) {
      return c.json({ error: "Phone and message are required" }, 400);
    }

    const baseUrl = config.apiUrl;
    const instanceName = config.instanceName;
    const instanceEnc = encodeURIComponent(instanceName);
    const phoneClean = phone.replace(/[^0-9]/g, "");
    const phoneRaw = phoneClean;
    const phoneJid = `${phoneClean}@s.whatsapp.net`;

    const debugLog: string[] = [];
    let successEndpoint: string | null = null;
    let successPayload: any = null;

    debugLog.push(`=== DIAGNOSTICS ===`);
    debugLog.push(`Instance: "${instanceName}" (encoded: "${instanceEnc}")`);
    debugLog.push(`Phone raw: ${phoneRaw} | Phone JID: ${phoneJid}`);
    debugLog.push(`Base URL: ${baseUrl}`);

    // ── Step 1: Check instance connection status ──
    debugLog.push(`\n=== STEP 1: Instance Connection Check ===`);
    // SEND_READY = actually ready to send (socket fully open)
    const SEND_READY = new Set(["open", "connected"]);
    // INSTANCE_ALIVE = instance exists and doing something
    const INSTANCE_ALIVE = new Set(["open", "connected", "connecting"]);
    let instanceConnected = false;
    let instanceState = "unknown";
    let instanceFound = false;
    const allInstances: Array<{ name: string; state: string }> = [];

    // Helper to get real-time connectionState
    async function getConnectionState(): Promise<string> {
      try {
        const res = await evoFetch(baseUrl, config.apiKey, `/instance/connectionState/${instanceEnc}`, "GET");
        const txt = await res.text();
        debugLog.push(`connectionState → ${res.status}: ${txt.substring(0, 200)}`);
        if (res.ok) {
          const d = JSON.parse(txt);
          return d?.instance?.state || d?.instance?.connectionStatus || d?.instance?.status || d?.connectionStatus || d?.state || d?.status || d?.connection?.state || "";
        }
      } catch (e: any) { debugLog.push(`connectionState → Error: ${e.message}`); }
      return "";
    }

    // Fetch instances list
    let fetchInstancesState = "";
    for (const iPath of ["/instance/fetchInstances", "/instance/list"]) {
      try {
        const res = await evoFetch(baseUrl, config.apiKey, iPath, "GET");
        if (res.ok) {
          const data = await res.json();
          const instances = Array.isArray(data) ? data : (data?.instances || data?.data || []);
          debugLog.push(`Fetched instances via ${iPath}: found ${instances.length}`);
          for (const inst of instances) {
            const name = inst.instance?.instanceName || inst.instanceName || inst.name || "?";
            const state = inst.instance?.state || inst.instance?.connectionStatus || inst.instance?.status || inst.connectionStatus || inst.state || inst.status || inst.connection?.state || "";
            const match = name === instanceName;
            allInstances.push({ name, state: state || "unknown" });
            debugLog.push(`  • "${name}" → state: "${state}"${match ? " ← YOUR INSTANCE" : ""}`);
            if (match) {
              instanceFound = true;
              instanceState = state;
              fetchInstancesState = state;
            }
          }
          break;
        } else {
          const txt = await res.text().catch(() => "");
          debugLog.push(`  ${iPath} → ${res.status}: ${txt.substring(0, 200)}`);
        }
      } catch (e: any) { debugLog.push(`  ${iPath} → Error: ${e.message}`); }
    }

    // Direct connection state (authoritative real-time socket state)
    const realState = await getConnectionState();
    if (realState) {
      if (fetchInstancesState && fetchInstancesState !== realState) {
        debugLog.push(`ℹ️ fetchInstances="${fetchInstancesState}" vs connectionState="${realState}" — using connectionState (real-time socket state)`);
      }
      instanceState = realState;
      if (!instanceFound) instanceFound = true;
    }

    // Determine if ready to send
    instanceConnected = SEND_READY.has(instanceState);

    // ── Step 1b: If not ready, auto-restart and wait ──
    if (instanceFound && !instanceConnected) {
      debugLog.push(`\n⚠️ State is "${instanceState}" — socket not ready to send`);
      debugLog.push(`  Attempting auto-restart (trying multiple methods)...`);

      // Try multiple methods × paths (Evolution API versions vary)
      let restartOk = false;
      const attempts: Array<{ method: "GET" | "POST" | "PUT" | "DELETE"; path: string }> = [
        { method: "GET", path: `/instance/connect/${instanceEnc}` },
        { method: "POST", path: `/instance/restart/${instanceEnc}` },
        { method: "PUT", path: `/instance/restart/${instanceEnc}` },
        { method: "POST", path: `/instance/connect/${instanceEnc}` },
        { method: "PUT", path: `/instance/connect/${instanceEnc}` },
      ];
      for (const { method, path } of attempts) {
        if (restartOk) break;
        try {
          const rr = await evoFetch(baseUrl, config.apiKey, path, method);
          const rt = await rr.text();
          debugLog.push(`  ${method} ${path} → ${rr.status}: ${rt.substring(0, 150)}`);
          if (rr.ok) {
            restartOk = true;
            debugLog.push(`  ✅ Restart/connect command accepted`);
            try {
              const d = JSON.parse(rt);
              if (d?.base64 || d?.qrcode || d?.code) {
                debugLog.push(`  📱 QR Code returned — scan in Evolution API Manager`);
              }
            } catch {}
          }
        } catch (e: any) { debugLog.push(`  ${method} ${path} → Error: ${e.message}`); }
      }
      if (!restartOk) {
        debugLog.push(`  Trying logout + connect...`);
        try { await evoFetch(baseUrl, config.apiKey, `/instance/logout/${instanceEnc}`, "DELETE"); } catch {}
        await new Promise(r => setTimeout(r, 2000));
        try {
          const cr = await evoFetch(baseUrl, config.apiKey, `/instance/connect/${instanceEnc}`, "GET");
          const ct = await cr.text();
          debugLog.push(`  GET /instance/connect (after logout) → ${cr.status}: ${ct.substring(0, 150)}`);
          if (cr.ok) { restartOk = true; debugLog.push(`  ✅ Connect after logout accepted`); }
        } catch (e: any) { debugLog.push(`  Connect after logout → Error: ${e.message}`); }
      }

      // Wait and re-check (3 attempts, 5s each)
      for (let attempt = 1; attempt <= 3; attempt++) {
        debugLog.push(`  ⏳ Waiting 5s... (attempt ${attempt}/3)`);
        await new Promise(r => setTimeout(r, 5000));
        const newState = await getConnectionState();
        if (newState) instanceState = newState;
        debugLog.push(`  Re-check: state = "${instanceState}"`);
        if (SEND_READY.has(instanceState)) {
          instanceConnected = true;
          debugLog.push(`  ✅ Instance is now READY (state: ${instanceState})`);
          break;
        }
      }
    }

    // If instance found but state is empty/unknown, assume it's usable
    if (instanceFound && !instanceConnected) {
      const isDefinitelyDown = ["close", "closed", "disconnected", "refused", "banned", "connecting"].includes(instanceState);
      if (!isDefinitelyDown) {
        debugLog.push(`⚠️ State "${instanceState}" is ambiguous — instance found, proceeding anyway`);
        instanceConnected = true;
      }
    }

    if (!instanceFound && allInstances.length > 0) {
      const connectedOnes = allInstances.filter(i => INSTANCE_ALIVE.has(i.state));
      debugLog.push(`\n❌ Instance "${instanceName}" NOT FOUND in Evolution API!`);
      debugLog.push(`  Available: ${allInstances.map(i => `"${i.name}" (${i.state})`).join(", ")}`);
      if (connectedOnes.length > 0) {
        debugLog.push(`  💡 Suggestion: Change instance name to "${connectedOnes[0].name}" in Settings`);
      }
      return c.json({
        success: false,
        error: `Instance "${instanceName}" مش موجود! المتاح: ${allInstances.map(i => `"${i.name}" (${i.state})`).join("، ")}`,
        hint: connectedOnes.length > 0 ? `غيّر الاسم في Settings لـ "${connectedOnes[0].name}"` : "مفيش instance متصل",
        debugLog,
        availableInstances: allInstances,
        suggestedInstance: connectedOnes.length > 0 ? connectedOnes[0].name : null,
      });
    } else if (!instanceConnected) {
      const isConnecting = instanceState === "connecting";
      const isClosed = instanceState === "close" || instanceState === "closed";
      debugLog.push(`\n⚠️ Instance "${instanceName}" NOT READY (state: ${instanceState})`);
      debugLog.push(`  الـ WhatsApp WebSocket مقفول — الرسائل مش هتتبعت.`);
      debugLog.push(`  Auto-restart اتجرب بس محصلش اتصال.`);
      debugLog.push(``);
      debugLog.push(`  🔧 الحل الجذري (خطوات):`);
      debugLog.push(`  1. روح لـ Evolution API Manager:`);
      debugLog.push(`     ${baseUrl.replace(/\/api$/, '')}`);
      debugLog.push(`  2. اضغط على Instance "${instanceName}"`);
      debugLog.push(`  3. لو مكتوب "Disconnected" → اضغط "Connect"`);
      debugLog.push(`  4. لو ظهر QR Code → افتح واتساب على موبايلك`);
      debugLog.push(`     → Settings → Linked Devices → Link a Device`);
      debugLog.push(`     → امسح الـ QR Code`);
      debugLog.push(`  5. استنى لحد ما الحالة تبقى "Connected" (أخضر)`);
      debugLog.push(`  6. ارجع هنا واضغط "Test Send" تاني`);
      debugLog.push(``);
      debugLog.push(`  ⚠️ ملاحظة: fetchInstances ممكن يقول "open" بس ده cached.`);
      debugLog.push(`     connectionState هو اللي بيقولك حالة الـ socket الحقيقية.`);
      debugLog.push(`\n=== SHORT-CIRCUIT: Skipping send — socket not ready ===`);
      debugLog.push(`\n=== SUMMARY ===`);
      debugLog.push(`Instance: "${instanceName}" | State: ${instanceState} | Send-Ready: false`);
      debugLog.push(`Send: SKIPPED (WhatsApp socket disconnected)`);
      debugLog.push(`\n🔴 DIAGNOSIS: WhatsApp socket is "${instanceState}" — ${isClosed ? "connection closed, needs reconnection via Evolution API Manager" : isConnecting ? "stuck connecting, may need QR scan" : "not ready, check Evolution API Manager"}`);
      return c.json({
        success: false,
        successEndpoint: null,
        successPayload: null,
        instanceState,
        instanceConnected: false,
        debugLog,
        config: { baseUrl: config.apiUrl, instanceName: config.instanceName },
        canRestart: true,
        stuckConnecting: isConnecting,
      });
    } else {
      debugLog.push(`\n✅ Instance "${instanceName}" CONNECTED & READY (state: ${instanceState})`);
    }

    // ── Step 2: Number check ──
    debugLog.push(`\n=== STEP 2: Number Check ===`);
    try {
      const res = await evoFetch(baseUrl, config.apiKey, `/chat/whatsappNumbers/${instanceEnc}`, "POST", { numbers: [phoneRaw] });
      const txt = await res.text();
      debugLog.push(`whatsappNumbers → ${res.status}: ${txt.substring(0, 200)}`);
    } catch (e: any) { debugLog.push(`whatsappNumbers → Error: ${e.message}`); }

    // ── Step 3: Send attempts ──
    debugLog.push(`\n=== STEP 3: Send Message Attempts ===`);

    const payloadVariants = imageUrl && imageUrl.trim().length > 0 
      ? [
          { number: phoneRaw, mediaMessage: { mediatype: "image", media: imageUrl.trim(), caption: message.trim() } },
          { number: phoneRaw, media: imageUrl.trim(), caption: message.trim(), mediatype: "image" },
          { number: phoneJid, mediaMessage: { mediatype: "image", media: imageUrl.trim(), caption: message.trim() } },
          { number: phoneJid, media: imageUrl.trim(), caption: message.trim(), mediatype: "image" },
        ]
      : [
          { number: phoneRaw, text: message.trim() },
          { number: phoneJid, text: message.trim() },
          { number: phoneRaw, textMessage: { text: message.trim() } },
          { number: phoneJid, textMessage: { text: message.trim() } },
        ];

    const endpoints = imageUrl && imageUrl.trim().length > 0
      ? [`/message/sendMedia/${instanceEnc}`, `/sendMedia/${instanceEnc}`, `/message/sendImage/${instanceEnc}`]
      : [`/message/sendText/${instanceEnc}`, `/sendText/${instanceEnc}`, `/message/send/${instanceEnc}`, `/sendMessage/${instanceEnc}`];

    debugLog.push(`Testing ${endpoints.length} endpoints × ${payloadVariants.length} payloads`);

    for (const endpoint of endpoints) {
      for (const payload of payloadVariants) {
        try {
          debugLog.push(`\nTrying: ${endpoint} | Payload: ${JSON.stringify(payload).substring(0, 200)}`);
          const res = await evoFetch(baseUrl, config.apiKey, endpoint, "POST", payload);
          const responseText = await res.text();
          debugLog.push(`  → Status: ${res.status}`);
          debugLog.push(`  → Response: ${responseText.substring(0, 300)}`);
          if (res.ok) {
            successEndpoint = endpoint;
            successPayload = payload;
            debugLog.push(`  ✅ SUCCESS!`);
            break;
          }
        } catch (e: any) {
          debugLog.push(`  ❌ Error: ${e.message || e}`);
        }
      }
      if (successEndpoint) break;
    }

    // ── Summary ──
    debugLog.push(`\n=== SUMMARY ===`);
    debugLog.push(`Instance: "${instanceName}" | State: ${instanceState} | Connected: ${instanceConnected}`);
    debugLog.push(`Send: ${successEndpoint ? `SUCCESS via ${successEndpoint}` : "FAILED"}`);
    if (!successEndpoint && !instanceConnected) {
      debugLog.push(`\n🔴 DIAGNOSIS: Instance NOT connected → reconnect via Evolution API Manager`);
    }

    return c.json({
      success: !!successEndpoint,
      successEndpoint,
      successPayload,
      instanceState,
      instanceConnected,
      debugLog,
      config: { baseUrl: config.apiUrl, instanceName: config.instanceName },
    });
  } catch (error) {
    console.log("Test send error:", error);
    return c.json({ error: `Test send error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// Upload Image for Bulk Messaging (local storage)
// ─────────────────────────────────────────────
app.post("/make-server-5c5dc789/bulk-message/upload-image", async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get("image") as File;

    if (!file) {
      return c.json({ error: "No image file provided" }, 400);
    }

    const { writeFile, mkdir } = await import("fs/promises");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const __dir = dirname(fileURLToPath(import.meta.url));
    const uploadsDir = join(__dir, "..", "uploads");
    await mkdir(uploadsDir, { recursive: true });

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fileName = `${uuid()}-${safeName}`;
    const filePath = join(uploadsDir, fileName);
    const fileBuffer = await file.arrayBuffer();
    await writeFile(filePath, Buffer.from(fileBuffer));

    const serverUrl = process.env.SERVER_URL || "http://localhost:3001";
    const imageUrl = `${serverUrl}/uploads/${fileName}`;

    return c.json({ success: true, imageUrl, fileName });
  } catch (error: any) {
    console.error("Image upload error:", error);
    return c.json({ error: `Image upload error: ${error.message}` }, 500);
  }
});

// ─────────────────────────────────────────────
// WHATSAPP CHATBOT: Configuration (IVR-style menu system)
// ─────────────────────────────────────────────
app.get("/make-server-5c5dc789/ai-config", async (c) => {
  try {
    const config = await kv.get("ai:config") as any;
    if (!config) {
      return c.json({
        enabled: false,
        menuItems: [],
        language: "ar",
        businessName: "",
        businessInfo: "",
        orderEnabled: true,
      });
    }
    return c.json(config);
  } catch (error) {
    console.log("Chatbot config get error:", error);
    return c.json({ error: `Chatbot config get error: ${error}` }, 500);
  }
});

app.post("/make-server-5c5dc789/ai-config", async (c) => {
  try {
    const body = await c.req.json();
    const config = {
      enabled: body.enabled ?? false,
      menuItems: body.menuItems || [],
      language: body.language || "ar",
      businessName: body.businessName || "",
      businessInfo: body.businessInfo || "",
      orderEnabled: body.orderEnabled ?? true,
      updatedAt: new Date().toISOString(),
    };
    await kv.set("ai:config", config);
    console.log("Chatbot config saved:", { enabled: config.enabled, language: config.language });
    return c.json({ status: "ok" });
  } catch (error) {
    console.log("Chatbot config save error:", error);
    return c.json({ error: `Chatbot config save error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// AI AUTO-REPLY CONFIG & SCHEDULER
// ─────────────────────────────────────────────

// GET /ai-autoresponse/config
app.get("/make-server-5c5dc789/ai-autoresponse/config", async (c) => {
  const cfg = await kv.get("ai_autoresponse:config") as any || { enabled: false, delayMinutes: 10 };
  return c.json(cfg);
});

// POST /ai-autoresponse/config
app.post("/make-server-5c5dc789/ai-autoresponse/config", async (c) => {
  const body = await c.req.json();
  // mode: "off" | "instant" | "delayed"
  const cfg = {
    enabled: body.mode !== "off",
    mode: body.mode || (body.enabled ? "delayed" : "off"),
    delayMinutes: Number(body.delayMinutes) || 10,
  };
  await kv.set("ai_autoresponse:config", cfg);
  return c.json({ success: true, ...cfg });
});

// Schedule auto-reply for a conversation
async function scheduleAutoReply(
  conversationId: string,
  phone: string,
  customerName: string,
  suggestedReply: string
): Promise<void> {
  const cfg = await kv.get("ai_autoresponse:config") as any;
  if (!cfg?.enabled) return;
  const delayMs = (cfg.delayMinutes || 10) * 60 * 1000;
  await kv.set(`ai_pending:${conversationId}`, {
    conversationId, phone, customerName, suggestedReply,
    scheduledAt: new Date().toISOString(),
    fireAt: new Date(Date.now() + delayMs).toISOString(),
  });
  console.log(`[AI AutoReply] Scheduled for conv ${conversationId} in ${cfg.delayMinutes} min`);
}

// Cancel auto-reply when employee replies
async function cancelAutoReply(conversationId: string): Promise<void> {
  await kv.del(`ai_pending:${conversationId}`);
}

// Generate a smart AI reply as a restaurant employee
async function generateRestaurantReply(conversationId: string, customerName: string): Promise<string | null> {
  try {
    const apiKey = ((globalThis as any).process?.env?.OPENAI_API_KEY) || "";
    if (!apiKey) return null;

    // Get conversation history (last 10 messages)
    const convMsgs = (await kv.getByPrefix(`cmsg:${conversationId}:`))
      .sort((a: any, b: any) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime())
      .slice(-10);

    // Get menu/products
    const products = await kv.getByPrefix("product:");
    const menuText = products.length > 0
      ? products.map((p: any) => {
          let priceStr = p.price ? `${p.price} ${p.currency || ""}` : "";
          let discountStr = "";
          if (p.discountType && p.discountValue) {
            const finalPrice = p.discountType === "percent"
              ? (p.price * (1 - p.discountValue / 100)).toFixed(2)
              : (p.price - p.discountValue).toFixed(2);
            discountStr = ` 🏷️ عرض: ${p.discountType === "percent" ? `خصم ${p.discountValue}%` : `خصم ${p.discountValue} ${p.currency || ""}`} → السعر بعد الخصم: ${finalPrice} ${p.currency || ""}`;
            if (p.offerLabel) discountStr += ` (${p.offerLabel})`;
          }
          return `- ${p.name}${priceStr ? ` (${priceStr})` : ""}${p.description ? `: ${p.description}` : ""}${discountStr}${p.available === false ? " [غير متاح]" : ""}`;
        }).join("\n")
      : "المنيو غير محدد بعد";

    // Get business info
    const aiConf = await kv.get("ai:config") as any || {};
    const businessName = aiConf.businessName || "المطعم";
    const businessInfo = aiConf.businessInfo || "";

    // Build conversation history for OpenAI
    const messages: any[] = [
      {
        role: "system",
        content: `أنت موظف خدمة عملاء محترف في ${businessName}. العميل اسمه: ${customerName || "العميل"}.
${businessInfo ? `معلومات عن المطعم: ${businessInfo}` : ""}

المنيو المتاح:
${menuText}

تعليمات:
- رد باللغة التي يكتب بها العميل (عربي أو إنجليزي)
- كن ودوداً ومفيداً كموظف حقيقي
- لو العميل يسأل عن المنيو، اشرح الخيارات المتاحة
- لو العميل يريد طلب، اسأله عن التفاصيل (الكمية، العنوان)
- ردك يكون قصير وطبيعي (جملة أو جملتين)
- لا تذكر أنك AI`,
      },
    ];

    // Add conversation history
    for (const msg of convMsgs) {
      messages.push({
        role: msg.direction === "inbound" ? "user" : "assistant",
        content: msg.text || "(media)",
      });
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "gpt-4o-mini", messages, max_tokens: 300, temperature: 0.7 }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.log("[AI RestaurantReply] error:", e);
    return null;
  }
}

// Background checker — runs every 60 seconds
async function checkPendingAutoReplies(): Promise<void> {
  try {
    const cfg = await kv.get("ai_autoresponse:config") as any;
    if (!cfg?.enabled) return;

    const pending = await kv.getByPrefix("ai_pending:");
    const now = Date.now();

    for (const item of pending) {
      if (!item?.fireAt || !item?.conversationId) continue;
      if (new Date(item.fireAt).getTime() > now) continue;

      // Time to send AI reply
      console.log(`[AI AutoReply] Firing for conv ${item.conversationId} → ${item.phone}`);

      // Check if employee already replied after scheduling
      const convMsgs = await kv.getByPrefix(`cmsg:${item.conversationId}:`);
      const lastMsg = convMsgs.sort((a: any, b: any) =>
        new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime())[0];

      if (lastMsg?.direction === "outbound") {
        // Employee replied — cancel
        await kv.del(`ai_pending:${item.conversationId}`);
        console.log(`[AI AutoReply] Cancelled — employee already replied`);
        continue;
      }

      // Generate smart AI reply as restaurant employee
      const aiReplyText = await generateRestaurantReply(item.conversationId, item.customerName);
      if (!aiReplyText) {
        console.log(`[AI AutoReply] No reply generated for ${item.phone}`);
        await kv.del(`ai_pending:${item.conversationId}`);
        continue;
      }

      // Send via Evolution API
      try {
        const evoConfig = await kv.get("evolution:config") as any;
        if (!evoConfig?.apiUrl || !evoConfig?.apiKey || !evoConfig?.instanceName) continue;
        const baseUrl = evoConfig.apiUrl.replace(/\/$/, "");
        const instanceEnc = encodeURIComponent(evoConfig.instanceName);
        const remoteJid = `${item.phone}@s.whatsapp.net`;
        const res = await evoFetch(baseUrl, evoConfig.apiKey, `/message/sendText/${instanceEnc}`, "POST",
          { number: remoteJid, text: aiReplyText });

        if (res.ok) {
          console.log(`[AI AutoReply] ✅ Sent to ${item.phone}: "${aiReplyText.substring(0, 60)}"`);
          const msgId = uuid();
          await kv.set(`cmsg:${item.conversationId}:${msgId}`, {
            id: msgId, conversation_id: item.conversationId,
            direction: "outbound", sender_type: "ai",
            text: aiReplyText, sent_at: new Date().toISOString(),
          });
          const conv = await kv.get(`conversation:${item.conversationId}`) as any;
          if (conv) {
            conv.last_message_text = aiReplyText;
            conv.last_message_direction = "outbound";
            conv.last_message_at = new Date().toISOString();
            await kv.set(`conversation:${item.conversationId}`, conv);
          }
        }
      } catch (e) {
        console.log(`[AI AutoReply] ❌ Send error:`, e);
      }

      // Remove pending
      await kv.del(`ai_pending:${item.conversationId}`);
    }
  } catch (e) {
    console.log("[AI AutoReply] checker error:", e);
  }
}

// Start background checker every 30 seconds
setInterval(() => {
  checkPendingAutoReplies().catch(e => console.log("[AI AutoReply] interval error:", e));
}, 30 * 1000);

// Run once on startup after 10 seconds
setTimeout(() => {
  checkPendingAutoReplies().catch(e => console.log("[AI AutoReply] startup check error:", e));
}, 10 * 1000);

// GET /ai-autoresponse/check — manual trigger for testing
app.get("/make-server-5c5dc789/ai-autoresponse/check", async (c) => {
  await checkPendingAutoReplies();
  const pending = await kv.getByPrefix("ai_pending:");
  return c.json({ triggered: true, pendingCount: pending.length, pending });
});

// POST /ai-autoresponse/reply-now — instant AI reply for a specific conversation
app.post("/make-server-5c5dc789/ai-autoresponse/reply-now", async (c) => {
  try {
    const { conversationId } = await c.req.json();
    if (!conversationId) return c.json({ error: "conversationId required" }, 400);

    const conv = await kv.get(`conversation:${conversationId}`) as any;
    if (!conv) return c.json({ error: "Conversation not found" }, 404);

    const phone = conv.customer_phone;
    const customerName = conv.customer_name || phone;

    // Generate AI reply
    const replyText = await generateRestaurantReply(conversationId, customerName);
    if (!replyText) return c.json({ error: "AI could not generate a reply" }, 500);

    // Send via Evolution API
    const evoConfig = await kv.get("evolution:config") as any;
    if (!evoConfig?.apiUrl || !evoConfig?.apiKey || !evoConfig?.instanceName) {
      return c.json({ error: "Evolution API not configured" }, 400);
    }
    const baseUrl = evoConfig.apiUrl.replace(/\/$/, "");
    const instanceEnc = encodeURIComponent(evoConfig.instanceName);
    const remoteJid = `${phone}@s.whatsapp.net`;
    const res = await evoFetch(baseUrl, evoConfig.apiKey, `/message/sendText/${instanceEnc}`, "POST",
      { number: remoteJid, text: replyText });

    if (!res.ok) return c.json({ error: "Failed to send message" }, 502);

    // Save to KV
    const msgId = uuid();
    await kv.set(`cmsg:${conversationId}:${msgId}`, {
      id: msgId, conversation_id: conversationId,
      direction: "outbound", sender_type: "ai",
      text: replyText, sent_at: new Date().toISOString(),
    });
    conv.last_message_text = replyText;
    conv.last_message_direction = "outbound";
    conv.last_message_at = new Date().toISOString();
    await kv.set(`conversation:${conversationId}`, conv);

    // Cancel any pending scheduled reply
    await kv.del(`ai_pending:${conversationId}`);

    console.log(`[AI ReplyNow] ✅ Sent to ${phone}: "${replyText.substring(0, 60)}"`);
    return c.json({ success: true, reply: replyText });
  } catch (error) {
    return c.json({ error: `${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// AI MESSAGE INTENT ANALYSIS
// ─────────────────────────────────────────────
async function analyzeMessageIntent(
  messageText: string,
  conversationId: string,
  customerPhone: string,
  customerName: string
): Promise<void> {
  try {
    const apiKey = ((globalThis as any).process?.env?.OPENAI_API_KEY) || "";
    if (!apiKey) return;
    if (!messageText || messageText.length < 2) return;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `أنت مساعد ذكاء اصطناعي لتحليل رسائل واتساب لمطعم/متجر. حلل الرسالة وأرجع JSON فقط بهذه الحقول:
- "needsReply": true/false — هل تحتاج رد فوري؟
- "intent": "question" | "order" | "complaint" | "greeting" | "thanks" | "media" | "other"
- "urgency": "high" | "medium" | "low"
- "summary": ملخص الرسالة في جملة واحدة (بنفس لغة الرسالة)
- "suggestedReply": رد مقترح قصير (اختياري، بنفس لغة الرسالة)

قواعد urgency:
- high: شكوى، مشكلة، طلب عاجل، سؤال عن موعد أو توصيل
- medium: سؤال عادي، طلب معلومات
- low: تحية، شكر، رد عادي`
          },
          { role: "user", content: messageText }
        ],
        max_tokens: 250,
        temperature: 0.2,
      }),
    });

    if (!response.ok) return;
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    const cleaned = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    let analysis: any;
    try { analysis = JSON.parse(cleaned); } catch { return; }

    const intentId = `intent:${conversationId}`;
    await kv.set(intentId, {
      conversationId,
      customerPhone,
      customerName,
      messageText: messageText.substring(0, 200),
      needsReply: analysis.needsReply ?? true,
      intent: analysis.intent || "other",
      urgency: analysis.urgency || "medium",
      summary: analysis.summary || "",
      suggestedReply: analysis.suggestedReply || "",
      analyzedAt: new Date().toISOString(),
    });

    console.log(`[AI Intent] ✅ ${customerPhone}: intent=${analysis.intent} urgency=${analysis.urgency} needsReply=${analysis.needsReply}`);
  } catch (err) {
    console.log(`[AI Intent] ❌ Error:`, err);
  }
}

// ─────────────────────────────────────────────
// AI FEEDBACK ANALYSIS: Analyze each inbound message
// ─────────────────────────────────────────────
async function analyzeMessageFeedback(
  messageText: string,
  conversationId: string,
  customerPhone: string,
  customerName: string
): Promise<void> {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.log("[AI Feedback] ❌ OPENAI_API_KEY not set, skipping feedback analysis");
      return;
    }

    // Skip very short messages or media placeholders
    if (!messageText || messageText.length < 3 || messageText.startsWith("[")) {
      console.log(`[AI Feedback] Skipping: too short or media placeholder: "${messageText}"`);
      return;
    }

    console.log(`[AI Feedback] Analyzing message from ${customerPhone}: "${messageText.substring(0, 80)}"`);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a customer feedback analyzer for a WhatsApp business. Analyze the following customer message and return ONLY a valid JSON object (no markdown, no extra text) with these fields:
- "sentiment": one of "positive", "neutral", "negative"
- "rating": a number from 1 to 5 (1=very negative, 2=negative, 3=neutral, 4=positive, 5=very positive)
- "category": one of "complaint", "praise", "question", "order", "suggestion", "greeting", "general"
- "summary": a brief 1-line summary of what the customer is saying (in the same language as the message)
- "urgency": one of "low", "medium", "high" (high = angry customer or urgent issue)
- "topics": an array of up to 3 short keywords/topics detected in the message (in the same language as the message)

Analyze the emotional tone, intent, and satisfaction level. Even simple greetings should be classified. Be accurate with Arabic and English messages.`
          },
          {
            role: "user",
            content: messageText,
          },
        ],
        max_tokens: 300,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.log(`[AI Feedback] ❌ OpenAI error ${response.status}: ${errText.substring(0, 200)}`);
      return;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    console.log(`[AI Feedback] Raw OpenAI response: ${content.substring(0, 300)}`);

    // Parse the JSON response
    let analysis: any;
    try {
      // Strip markdown code fences if present
      const cleaned = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      analysis = JSON.parse(cleaned);
    } catch (parseErr) {
      console.log(`[AI Feedback] ❌ Failed to parse OpenAI response as JSON: ${content.substring(0, 200)}`);
      return;
    }

    const feedbackId = uuid();
    const rating = Math.min(5, Math.max(1, Math.round(Number(analysis.rating) || 3)));
    const sentiment = ["positive", "neutral", "negative"].includes(analysis.sentiment) ? analysis.sentiment : "neutral";
    const category = analysis.category || "general";
    const summary = analysis.summary || messageText.substring(0, 100);
    const urgency = ["low", "medium", "high"].includes(analysis.urgency) ? analysis.urgency : "low";
    const topics = Array.isArray(analysis.topics) ? analysis.topics.slice(0, 3) : [];

    await kv.set(`feedback:${feedbackId}`, {
      id: feedbackId,
      conversation_id: conversationId,
      customer_phone: customerPhone,
      customer_name: customerName,
      rating,
      sentiment,
      category,
      comment: summary,
      original_message: messageText,
      urgency,
      topics,
      source: "ai_analysis",
      created_at: new Date().toISOString(),
    });

    console.log(`[AI Feedback] ✅ Stored feedback ${feedbackId}: sentiment=${sentiment} rating=${rating} category=${category} urgency=${urgency}`);
  } catch (err) {
    console.log(`[AI Feedback] ❌ Error analyzing feedback:`, err);
  }
}

// ─────────────────────────────────────────────
// MENU CHATBOT: Number-based IVR Menu System
// ─────────────────────────────────────────────

interface ChatState {
  state: string;
  selectedCategory: string | null;
  cart: Array<{ name: string; price: number; currency: string; qty: number; category: string }>;
  customerName: string | null;
  deliveryAddress: string | null;
  deliveryPhone: string | null;
  lastActivity: string;
}

function newChatState(): ChatState {
  return { state: "welcome", selectedCategory: null, cart: [], customerName: null, deliveryAddress: null, deliveryPhone: null, lastActivity: new Date().toISOString() };
}

function getMenuCategories(menuItems: any[]): Record<string, any[]> {
  const cats: Record<string, any[]> = {};
  for (const item of menuItems) {
    const cat = item.category || "عام";
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push(item);
  }
  return cats;
}

function formatPrice(price: number, currency: string): string {
  return `${price} ${currency}`;
}

function buildCartSummary(cart: ChatState["cart"]): { text: string; total: number; currency: string } {
  if (cart.length === 0) return { text: "السلة فارغة", total: 0, currency: "AED" };
  const currency = cart[0]?.currency || "AED";
  let total = 0;
  const lines = cart.map((item, i) => {
    const subtotal = item.price * item.qty;
    total += subtotal;
    return `${i + 1}. ${item.name} × ${item.qty} = ${formatPrice(subtotal, currency)}`;
  });
  return { text: lines.join("\n"), total, currency };
}

function normalizeInput(raw: string): string {
  return raw.trim()
    .replace(/[٠]/g, "0").replace(/[١]/g, "1").replace(/[٢]/g, "2")
    .replace(/[٣]/g, "3").replace(/[٤]/g, "4").replace(/[٥]/g, "5")
    .replace(/[٦]/g, "6").replace(/[٧]/g, "7").replace(/[٨]/g, "8")
    .replace(/[٩]/g, "9");
}

function buildWelcome(bizName: string, cartCount: number): string {
  const cartLine = cartCount > 0 ? `\n🛒 لديك ${cartCount} أصناف في السلة\n` : "";
  return `مرحباً بك في *${bizName}*! 🍽️${cartLine}\n\n1️⃣ عرض قائمة الطعام 📋\n2️⃣ الاستفسارات ❓${cartCount > 0 ? "\n3️⃣ عرض السلة 🛒\n4️⃣ إتمام الطلب ✅" : ""}\n\nاكتب رقم الخيار 👆`;
}

function menuStateMachine(
  menuItems: any[], bizName: string, bizInfo: string,
  chatState: ChatState, rawInput: string, customerPhone: string
): { reply: string; newState: ChatState } {
  const input = rawInput.trim();
  const inputNorm = normalizeInput(input);
  const categories = getMenuCategories(menuItems);
  const categoryNames = Object.keys(categories);
  const st: ChatState = { ...chatState, cart: chatState.cart.map(c => ({ ...c })), lastActivity: new Date().toISOString() };
  let reply = "";

  // Global "0" → main menu from anywhere
  if (inputNorm === "0") { st.state = "welcome"; st.selectedCategory = null; }

  switch (st.state) {
    case "welcome": {
      reply = buildWelcome(bizName, st.cart.length);
      st.state = "main_menu";
      break;
    }
    case "main_menu": {
      if (inputNorm === "1") {
        if (menuItems.length === 0) {
          reply = `⚠️ القائمة فارغة حالياً\n\nيرجى التواصل معنا لاحقاً\n\n0️⃣ القائمة الرئيسية`;
        } else if (categoryNames.length === 1) {
          st.selectedCategory = categoryNames[0];
          st.state = "category_items";
          const items = categories[categoryNames[0]];
          reply = `📋 *${categoryNames[0]}:*\n\n`;
          items.forEach((item: any, i: number) => {
            reply += `*${i + 1}.* ${item.name} — ${formatPrice(item.price, item.currency || "AED")}`;
            if (item.description) reply += `\n   _${item.description}_`;
            reply += "\n\n";
          });
          reply += `اكتب رقم الصنف لإضافته للسلة 🛒\n0️⃣ رجوع`;
        } else {
          reply = `📋 *أقسام القائمة:*\n\n`;
          categoryNames.forEach((cat, i) => { reply += `*${i + 1}.* ${cat} (${categories[cat].length} صنف)\n`; });
          reply += `\nاكتب رقم القسم لعرض الأصناف\n0️⃣ رجوع`;
          st.state = "categories";
        }
      } else if (inputNorm === "2") {
        reply = `❓ *الاستفسارات:*\n\n${bizInfo || "للاستفسار يرجى التواصل معنا مباشرة"}\n\n0️⃣ القائمة الرئيسية`;
        st.state = "main_menu";
      } else if (inputNorm === "3" && st.cart.length > 0) {
        const { text, total, currency } = buildCartSummary(st.cart);
        reply = `🛒 *سلة التسوق:*\n\n${text}\n\n💰 *الإجمالي: ${formatPrice(total, currency)}*\n\n1️⃣ إضافة أكثر\n2️⃣ حذف صنف\n3️⃣ إتمام الطلب ✅\n4️⃣ تفريغ السلة 🗑️\n0️⃣ القائمة الرئيسية`;
        st.state = "cart";
      } else if (inputNorm === "4" && st.cart.length > 0) {
        reply = `📝 *إتمام الطلب*\n\nاكتب اسمك الكريم:`; st.state = "checkout_name";
      } else {
        reply = buildWelcome(bizName, st.cart.length); st.state = "main_menu";
      }
      break;
    }
    case "categories": {
      const catIdx = parseInt(inputNorm) - 1;
      if (catIdx >= 0 && catIdx < categoryNames.length) {
        const catName = categoryNames[catIdx];
        st.selectedCategory = catName; st.state = "category_items";
        const items = categories[catName];
        reply = `📋 *${catName}:*\n\n`;
        items.forEach((item: any, i: number) => {
          reply += `*${i + 1}.* ${item.name} — ${formatPrice(item.price, item.currency || "AED")}`;
          if (item.description) reply += `\n   _${item.description}_`;
          reply += "\n\n";
        });
        reply += `اكتب رقم الصنف لإضافته للسلة 🛒\n0️⃣ رجوع`;
      } else { reply = `⚠️ رقم غير صحيح. اختر من 1 إلى ${categoryNames.length}\n0️⃣ رجوع`; }
      break;
    }
    case "category_items": {
      const catName = st.selectedCategory || categoryNames[0];
      const items = categories[catName] || [];
      const itemIdx = parseInt(inputNorm) - 1;
      if (itemIdx >= 0 && itemIdx < items.length) {
        const item = items[itemIdx];
        reply = `كم واحد تبي من *${item.name}*? 🔢\n\nالسعر: ${formatPrice(item.price, item.currency || "AED")}\n\nاكتب العدد (1-20)\n0️⃣ إلغاء`;
        st.state = `item_quantity:${catName}:${itemIdx}`;
      } else { reply = `⚠️ رقم غير صحيح. اختر من 1 إلى ${items.length}\n0️⃣ رجوع`; }
      break;
    }
    default: {
      if (st.state.startsWith("item_quantity:")) {
        const parts = st.state.split(":"); const catName = parts[1]; const itemIdx = parseInt(parts[2]);
        const items = categories[catName] || []; const item = items[itemIdx];
        if (!item) { reply = buildWelcome(bizName, st.cart.length); st.state = "main_menu"; break; }
        const qty = parseInt(inputNorm);
        if (qty >= 1 && qty <= 20) {
          const existing = st.cart.find(c => c.name === item.name);
          if (existing) { existing.qty += qty; } else { st.cart.push({ name: item.name, price: item.price, currency: item.currency || "AED", qty, category: catName }); }
          const { total, currency } = buildCartSummary(st.cart);
          reply = `✅ تمت الإضافة! ${qty} × *${item.name}*\n\n🛒 السلة: ${st.cart.length} أصناف — ${formatPrice(total, currency)}\n\n1️⃣ إضافة أكثر 📋\n2️⃣ عرض السلة 🛒\n3️⃣ إتمام الطلب ✅\n0️⃣ القائمة الرئيسية`;
          st.state = "after_add";
        } else { reply = `⚠️ اكتب عدد صحيح من 1 إلى 20\n0️⃣ إلغاء`; }
      } else if (st.state === "after_add") {
        if (inputNorm === "1") { reply = buildWelcome(bizName, st.cart.length); st.state = "main_menu"; }
        else if (inputNorm === "2") { const { text, total, currency } = buildCartSummary(st.cart); reply = `🛒 *سلة التسوق:*\n\n${text}\n\n💰 *الإجمالي: ${formatPrice(total, currency)}*\n\n1️⃣ إضافة أكثر\n2️⃣ حذف صنف\n3️⃣ إتمام الطلب ✅\n4️⃣ تفريغ السلة 🗑️\n0️⃣ القائمة الرئيسية`; st.state = "cart"; }
        else if (inputNorm === "3") { reply = `📝 *إتمام الطلب*\n\nاكتب اسمك الكريم:`; st.state = "checkout_name"; }
        else { reply = buildWelcome(bizName, st.cart.length); st.state = "main_menu"; }
      } else if (st.state === "cart") {
        if (inputNorm === "1") { reply = buildWelcome(bizName, st.cart.length); st.state = "main_menu"; }
        else if (inputNorm === "2") {
          if (st.cart.length === 0) { reply = `السلة فارغة!\n0️⃣ القائمة الرئيسية`; st.state = "main_menu"; }
          else { let d = `🗑️ *حذف صنف:*\n\n`; st.cart.forEach((item, i) => { d += `*${i + 1}.* ${item.name} × ${item.qty}\n`; }); d += `\nاكتب رقم الصنف لحذفه\n0️⃣ رجوع`; reply = d; st.state = "cart_delete"; }
        } else if (inputNorm === "3") {
          if (st.cart.length === 0) { reply = `⚠️ السلة فارغة!\n0️⃣ القائمة الرئيسية`; st.state = "main_menu"; }
          else { reply = `📝 *إتمام الطلب*\n\nاكتب اسمك الكريم:`; st.state = "checkout_name"; }
        } else if (inputNorm === "4") { st.cart = []; reply = `🗑️ تم تفريغ السلة\n\n0️⃣ القائمة الرئيسية`; st.state = "main_menu"; }
        else { reply = `⚠️ اختر من الخيارات أعلاه\n0️⃣ القائمة الرئيسية`; }
      } else if (st.state === "cart_delete") {
        const delIdx = parseInt(inputNorm) - 1;
        if (delIdx >= 0 && delIdx < st.cart.length) {
          const removed = st.cart.splice(delIdx, 1)[0]; reply = `✅ تم حذف *${removed.name}*\n\n`;
          if (st.cart.length > 0) { const { text, total, currency } = buildCartSummary(st.cart); reply += `🛒 السلة:\n${text}\n💰 الإجمالي: ${formatPrice(total, currency)}\n\n1️⃣ إضافة أكثر\n3️⃣ إتمام الطلب\n0️⃣ القائمة الرئيسية`; st.state = "cart"; }
          else { reply += `السلة فارغة\n0️⃣ القائمة الرئيسية`; st.state = "main_menu"; }
        } else { reply = `⚠️ رقم غير صحيح\n0️⃣ رجوع`; }
      } else if (st.state === "checkout_name") {
        if (input.length < 2) { reply = `⚠️ يرجى كتابة اسم صحيح\n\nاكتب اسمك الكريم:`; }
        else { st.customerName = input; reply = `👤 الاسم: *${input}*\n\n📍 اكتب عنوان التوصيل:`; st.state = "checkout_address"; }
      } else if (st.state === "checkout_address") {
        if (input.length < 3) { reply = `⚠️ يرجى كتابة عنوان صحيح\n\nاكتب عنوان التوصيل:`; }
        else { st.deliveryAddress = input; reply = `📍 العنوان: *${input}*\n\n📱 اكتب رقم الهاتف للتواصل:\n(أو اكتب *نفسه* لاستخدام هذا الرقم)`; st.state = "checkout_phone"; }
      } else if (st.state === "checkout_phone") {
        const phoneInput = input === "نفسه" || input.toLowerCase() === "same" ? customerPhone : input.replace(/[^0-9+]/g, "");
        if (phoneInput.length < 8) { reply = `⚠️ يرجى كتابة رقم هاتف صحيح`; }
        else { st.deliveryPhone = phoneInput; const { text, total, currency } = buildCartSummary(st.cart); reply = `📋 *ملخص الطلب:*\n\n👤 الاسم: ${st.customerName}\n📍 العنوان: ${st.deliveryAddress}\n📱 الهاتف: ${phoneInput}\n\n🛒 *الأصناف:*\n${text}\n\n💰 *الإجمالي: ${formatPrice(total, currency)}*\n\n1️⃣ تأكيد الطلب ✅\n2️⃣ تعديل الطلب\n0️⃣ إلغاء`; st.state = "checkout_confirm"; }
      } else if (st.state === "checkout_confirm") {
        if (inputNorm === "1") {
          const { total, currency } = buildCartSummary(st.cart);
          const orderId = "ORD" + Date.now().toString(36).toUpperCase();
          reply = `✅ *تم تأكيد طلبك بنجاح!*\n\n🆔 رقم الطلب: #${orderId}\n💰 المبلغ: ${formatPrice(total, currency)}\n\nسيتم التواصل معك قريباً للتأكيد 📞\n\nشكراً لاختيارك *${bizName}*! 🙏\n\nاكتب 0 للعودة للقائمة الرئيسية`;
          // Mark for order creation
          (st as any)._orderConfirmed = { orderId, total, currency };
          st.cart = []; st.customerName = null; st.deliveryAddress = null; st.deliveryPhone = null; st.state = "main_menu";
        } else if (inputNorm === "2") { reply = buildWelcome(bizName, st.cart.length); st.state = "main_menu"; }
        else { st.cart = []; reply = `❌ تم إلغاء الطلب\n\n0️⃣ القائمة الرئيسية`; st.state = "main_menu"; }
      } else {
        reply = buildWelcome(bizName, st.cart.length); st.state = "main_menu";
      }
      break;
    }
  }

  return { reply, newState: st };
}

async function processMenuReply(
  conversationId: string, customerPhone: string, customerName: string, incomingText?: string
): Promise<{ success: boolean; reply?: string; error?: string }> {
  try {
    console.log(`[MENU] processMenuReply START conv=${conversationId} phone=${customerPhone} text="${(incomingText || "").substring(0, 60)}"`);
    const aiConfig = await kv.get("ai:config") as any;
    if (!aiConfig?.enabled) return { success: false, error: "Chatbot is disabled" };

    const menuItems = aiConfig.menuItems || [];
    const bizName = aiConfig.businessName || "مطعمنا";
    const bizInfo = aiConfig.businessInfo || "";

    // Get or create chat state
    let chatState = await kv.get(`chatstate:${customerPhone}`) as ChatState | null;
    if (!chatState) chatState = newChatState();
    // Reset if inactive > 30 min
    if (Date.now() - new Date(chatState.lastActivity).getTime() > 30 * 60 * 1000) chatState = newChatState();

    // Get incoming text if not provided
    if (!incomingText) {
      // Use conversation-specific prefix (cmsg:) with legacy fallback
      let convMsgs = await kv.getByPrefix(`cmsg:${conversationId}:`);
      if (convMsgs.length === 0) {
        const allMsgs = await kv.getByPrefix("message:");
        convMsgs = allMsgs.filter((m: any) => m.conversation_id === conversationId);
      }
      convMsgs.sort((a: any, b: any) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime());
      const lastInbound = [...convMsgs].reverse().find((m: any) => m.direction === "inbound");
      incomingText = lastInbound?.text || "";
    }

    // Skip if last message is already from bot
    let convMsgs2 = await kv.getByPrefix(`cmsg:${conversationId}:`);
    if (convMsgs2.length === 0) {
      const allMsgs2 = await kv.getByPrefix("message:");
      convMsgs2 = allMsgs2.filter((m: any) => m.conversation_id === conversationId);
    }
    convMsgs2.sort((a: any, b: any) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime());
    if (convMsgs2.length > 0) {
      const lastMsg = convMsgs2[convMsgs2.length - 1];
      if (lastMsg.sender_type === "ai" || lastMsg.sender_type === "bot") {
        console.log("[MENU] Skipping — last message is already from bot");
        return { success: false, error: "Last message is already a bot reply" };
      }
    }

    // Run state machine
    const { reply, newState } = menuStateMachine(menuItems, bizName, bizInfo, chatState, incomingText || "", customerPhone);

    // Check if order was confirmed
    if ((newState as any)._orderConfirmed) {
      const { orderId, total, currency } = (newState as any)._orderConfirmed;
      const orderItems = chatState.cart; // Cart before reset
      await kv.set(`order:${orderId}`, {
        id: orderId, conversation_id: conversationId, customer_phone: customerPhone,
        customer_name: chatState.customerName, delivery_address: chatState.deliveryAddress,
        delivery_phone: chatState.deliveryPhone,
        items: orderItems.map(c => ({ name: c.name, qty: c.qty, price: c.price, currency: c.currency })),
        items_text: buildCartSummary(orderItems).text, total_amount: total, currency,
        status: "new", created_at: new Date().toISOString(), source: "menu_chatbot",
      });
      console.log(`[MENU] Order created: ${orderId} total=${total} ${currency}`);
      delete (newState as any)._orderConfirmed;
    }

    // Save chat state
    await kv.set(`chatstate:${customerPhone}`, newState);

    console.log(`[MENU] Sending reply to ${customerPhone} (state: ${newState.state}): "${reply.substring(0, 80)}..."`);

    // Send via WhatsApp
    const sent = await sendWhatsAppReply(customerPhone, reply);

    // Store bot message
    const msgId = uuid();
    const botMsgObj = {
      id: msgId, conversation_id: conversationId, direction: "outbound", sender_type: "ai",
      text: reply, sent_at: new Date().toISOString(),
      payload: { bot: true, menuState: newState.state, sent_via_whatsapp: sent },
    };
    await kv.set(`cmsg:${conversationId}:${msgId}`, botMsgObj);

    // Log interaction
    try {
      const aiLog = (await kv.get("ai:interactions_log")) as any[] || [];
      aiLog.unshift({ conversationId, customerPhone, customerName, aiReply: reply.substring(0, 200), sentViaWhatsApp: sent, menuState: newState.state, at: new Date().toISOString() });
      if (aiLog.length > 100) aiLog.length = 100;
      await kv.set("ai:interactions_log", aiLog);
    } catch (_) {}

    console.log(`[MENU] ✅ DONE conv=${conversationId} sent=${sent}`);
    return { success: true, reply };
  } catch (error) {
    console.log(`[MENU] ❌ ERROR conv=${conversationId}:`, error);
    return { success: false, error: String(error) };
  }
}

// Send WhatsApp reply via Evolution API
async function sendWhatsAppReply(phone: string, text: string): Promise<boolean> {
  const config = await kv.get("evolution:config") as any;
  if (!config?.apiUrl || !config?.apiKey || !config?.instanceName) {
    console.log("[AI sendWA] ❌ Cannot send — Evolution API not configured");
    return false;
  }

  const baseUrl = config.apiUrl;
  const instanceEnc = encodeURIComponent(config.instanceName);

  // Quick connection state check (real-time socket state)
  try {
    const stRes = await evoFetch(baseUrl, config.apiKey, `/instance/connectionState/${instanceEnc}`, "GET");
    if (stRes.ok) {
      const sd = await stRes.json();
      const st = sd?.instance?.state || sd?.instance?.connectionStatus || sd?.instance?.status || sd?.connectionStatus || sd?.state || sd?.status || "?";
      if (st !== "open" && st !== "connected") {
        console.log(`[AI sendWA] ⚠️ Instance state "${st}" — attempting auto-connect...`);
        for (const { m, p } of [
          { m: "GET" as const, p: `/instance/connect/${instanceEnc}` },
          { m: "POST" as const, p: `/instance/restart/${instanceEnc}` },
        ]) {
          try {
            const rr = await evoFetch(baseUrl, config.apiKey, p, m);
            const rt = await rr.text();
            console.log(`[AI sendWA] ${m} ${p} → ${rr.status}: ${rt.substring(0, 150)}`);
            if (rr.ok) {
              try {
                const d = JSON.parse(rt);
                if (d?.base64 || d?.qrcode || d?.code) {
                  console.log(`[AI sendWA] ⚠️ QR code returned — needs manual scan`);
                }
              } catch {}
              break;
            }
          } catch {}
        }
        await new Promise(r => setTimeout(r, 8000));
        try {
          const recheck = await evoFetch(baseUrl, config.apiKey, `/instance/connectionState/${instanceEnc}`, "GET");
          if (recheck.ok) {
            const rd = await recheck.json();
            const newSt = rd?.instance?.state || rd?.state || "?";
            console.log(`[AI sendWA] Post-restart state: ${newSt}`);
            if (newSt !== "open" && newSt !== "connected") {
              console.log(`[AI sendWA] ❌ Still not ready — send will likely fail`);
            }
          }
        } catch {}
      }
    }
  } catch { /* ignore check failures */ }

  // Evolution API v2 expects raw phone number WITHOUT @s.whatsapp.net
  const phoneRaw = phone.replace(/@s\.whatsapp\.net$/, "");
  const phoneJid = `${phoneRaw}@s.whatsapp.net`;

  console.log(`[AI sendWA] Sending to ${phoneRaw} via ${baseUrl}/message/sendText/${instanceEnc}`);

  // Try raw number first (v2), then with JID suffix (v1) as fallback
  const payloads = [
    { number: phoneRaw, text: text },
    { number: phoneJid, text: text },
    { number: phoneRaw, textMessage: { text: text } },
  ];

  for (let i = 0; i < payloads.length; i++) {
    try {
      const res = await evoFetch(baseUrl, config.apiKey, `/message/sendText/${instanceEnc}`, "POST", payloads[i]);
      if (res.ok) {
        const resData = await res.text();
        console.log(`[AI sendWA] ✅ Sent to ${phone} (format #${i + 1}), response: ${resData.substring(0, 200)}`);
        return true;
      } else {
        const errText = await res.text();
        console.log(`[AI sendWA] Format #${i + 1} failed: ${res.status} ${errText.substring(0, 200)}`);
      }
    } catch (e) {
      console.log(`[AI sendWA] Format #${i + 1} error: ${e}`);
    }
  }

  console.log(`[AI sendWA] ❌ All formats failed for ${phone}`);
  return false;
}

// ─────────────────────────────────────────────
// MENU CHATBOT: Full Test (test webhook → Menu → WhatsApp)
// ─────────────────────────────────────────────
app.post("/make-server-5c5dc789/ai-test", async (c) => {
  try {
    const body = await c.req.json();
    const { phone, message: testMessage } = body;
    if (!phone) return c.json({ error: "phone is required" }, 400);

    const steps: Array<{ step: string; status: string; detail?: string; at: string }> = [];
    const addStep = (step: string, status: string, detail?: string) => {
      steps.push({ step, status, detail, at: new Date().toISOString() });
      console.log(`[Menu Test] ${step}: ${status}${detail ? ` — ${detail}` : ""}`);
    };

    const aiConfig = await kv.get("ai:config") as any;
    if (!aiConfig?.enabled) { addStep("Chatbot Config", "FAIL", "Chatbot is disabled. Enable it first."); return c.json({ success: false, steps }); }
    addStep("Chatbot Config", "OK", `enabled, menu=${(aiConfig.menuItems || []).length} items`);

    const evoConfig = await kv.get("evolution:config") as any;
    if (!evoConfig?.apiUrl || !evoConfig?.apiKey || !evoConfig?.instanceName) { addStep("Evolution Config", "FAIL", "Evolution API not configured"); return c.json({ success: false, steps }); }
    addStep("Evolution Config", "OK", `${evoConfig.apiUrl} / instance: ${evoConfig.instanceName}`);

    const phoneClean = phone.replace(/[^0-9]/g, "");
    const conversations = await kv.getByPrefix("conversation:");
    let conv = conversations.find((cv: any) => cv.customer_phone === phoneClean);
    if (!conv) {
      const convId = uuid();
      conv = { id: convId, customer_phone: phoneClean, customer_name: "Test User", status: "open", assigned_agent_id: null, created_at: new Date().toISOString(), last_message_at: new Date().toISOString() };
      await kv.set(`conversation:${convId}`, conv);
      addStep("Conversation", "CREATED", `New conv ${convId}`);
    } else { addStep("Conversation", "FOUND", `Existing conv ${conv.id}`); }

    const inMsgId = uuid();
    const inText = testMessage || "مرحبا";
    await kv.set(`message:${inMsgId}`, { id: inMsgId, conversation_id: conv.id, direction: "inbound", sender_type: "customer", text: inText, sent_at: new Date().toISOString(), payload: { test: true } });
    addStep("Inbound Message", "STORED", `"${inText}"`);

    const menuResult = await processMenuReply(conv.id, phoneClean, conv.customer_name || "Test User", inText);
    if (menuResult.success) { addStep("Menu Reply", "OK", `"${menuResult.reply?.substring(0, 150)}..."`); }
    else { addStep("Menu Reply", "FAIL", menuResult.error); }

    return c.json({ success: menuResult.success, reply: menuResult.reply, steps, conversationId: conv.id });
  } catch (error) {
    console.log("Menu test error:", error);
    return c.json({ error: `Menu test error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// MENU CHATBOT: Manual Trigger
// ─────────────────────────────────────────────
app.post("/make-server-5c5dc789/ai-reply", async (c) => {
  try {
    const body = await c.req.json();
    const { conversationId } = body;
    if (!conversationId) return c.json({ error: "conversationId is required" }, 400);
    const conversations = await kv.getByPrefix("conversation:");
    const conv = conversations.find((cv: any) => cv.id === conversationId);
    if (!conv) return c.json({ error: "Conversation not found" }, 404);
    const result = await processMenuReply(conv.id, conv.customer_phone, conv.customer_name);
    return c.json(result);
  } catch (error) {
    console.log("Menu manual reply error:", error);
    return c.json({ error: `Menu reply error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// MENU CHATBOT SIMULATOR: Preview menu responses without sending WhatsApp
// ─────────────────────────────────────────────
app.post("/make-server-5c5dc789/ai-simulate", async (c) => {
  try {
    const body = await c.req.json();
    const { messages: chatHistory, customerName, simState } = body;

    if (!chatHistory || !Array.isArray(chatHistory) || chatHistory.length === 0) {
      return c.json({ error: "messages array is required" }, 400);
    }

    const aiConfig = await kv.get("ai:config") as any;
    if (!aiConfig) {
      return c.json({ error: "Chatbot config not found. Please save your settings first." }, 400);
    }

    const menuItems = aiConfig.menuItems || [];
    const bizName = aiConfig.businessName || "مطعمنا";
    const bizInfo = aiConfig.businessInfo || "";

    // Use provided state or start fresh
    let currentState: ChatState = simState || newChatState();

    // Get the latest user message
    const lastUserMsg = [...chatHistory].reverse().find((m: any) => m.role === "user");
    if (!lastUserMsg) return c.json({ error: "No user message found" }, 400);

    const { reply, newState } = menuStateMachine(menuItems, bizName, bizInfo, currentState, lastUserMsg.content, "971500000000");
    return c.json({ success: true, reply, simState: newState });
  } catch (error: any) {
    console.log("AI simulate error:", error);
    return c.json({ error: `AI simulate error: ${error?.message || error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// AI AUTO-REPLY: Get Conversations with AI Status
// ─────────────────────────────────────────────
app.get("/make-server-5c5dc789/ai-conversations", async (c) => {
  try {
    const conversations = await kv.getByPrefix("conversation:");
    const aiConfig = await kv.get("ai:config") as any;

    const resultP = conversations
      .sort((a: any, b: any) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime())
      .slice(0, 50) // limit for performance
      .map(async (conv: any) => {
        // Use conversation-specific prefix
        let convMsgs = await kv.getByPrefix(`cmsg:${conv.id}:`);
        convMsgs.sort((a: any, b: any) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime());

        const lastMsg = convMsgs[0];
        const aiReplies = convMsgs.filter((m: any) => m.sender_type === "ai").length;
        const totalMsgs = convMsgs.length;
        const needsReply = lastMsg?.direction === "inbound";

        return {
          ...conv,
          lastMessage: lastMsg ? { text: lastMsg.text, direction: lastMsg.direction, sender_type: lastMsg.sender_type, sent_at: lastMsg.sent_at } : null,
          aiReplies,
          totalMessages: totalMsgs,
          needsReply,
        };
      });

    const result = await Promise.all(resultP);
    return c.json({ conversations: result, aiEnabled: aiConfig?.enabled || false });
  } catch (error) {
    console.log("AI conversations error:", error);
    return c.json({ error: `AI conversations error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// AI AUTO-REPLY: Get Conversation Messages
// ────────────────────��────────────────────────
app.get("/make-server-5c5dc789/ai-conversation/:id", async (c) => {
  try {
    const convId = c.req.param("id");
    const conversations = await kv.getByPrefix("conversation:");
    const conv = conversations.find((cv: any) => cv.id === convId);
    if (!conv) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    // Use conversation-specific prefix with legacy fallback
    let convMessages = await kv.getByPrefix(`cmsg:${convId}:`);
    if (convMessages.length === 0) {
      const allMessages = await kv.getByPrefix("message:");
      convMessages = allMessages.filter((m: any) => m.conversation_id === convId);
    }
    convMessages = convMessages
      .sort((a: any, b: any) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime());

    return c.json({ conversation: conv, messages: convMessages });
  } catch (error) {
    console.log("AI conversation detail error:", error);
    return c.json({ error: `Conversation detail error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// AI AUTO-REPLY: Diagnostics
// ─────────────────────────────────────────────
app.get("/make-server-5c5dc789/ai-diagnostics", async (c) => {
  try {
    const checks: Array<{ check: string; status: string; detail?: string }> = [];

    // 1. Chatbot Config
    const aiConfig = await kv.get("ai:config") as any;
    if (aiConfig?.enabled) {
      checks.push({ check: "Chatbot Enabled", status: "OK", detail: `Menu: ${(aiConfig.menuItems || []).length} items, Business: ${aiConfig.businessName || "not set"}` });
    } else {
      checks.push({ check: "Chatbot Enabled", status: "FAIL", detail: "Menu chatbot is disabled" });
    }

    // 3. Evolution API Config
    const evoConfig = await kv.get("evolution:config") as any;
    if (evoConfig?.apiUrl && evoConfig?.apiKey && evoConfig?.instanceName) {
      checks.push({ check: "Evolution API", status: "OK", detail: `${evoConfig.apiUrl} / ${evoConfig.instanceName}` });
    } else {
      checks.push({ check: "Evolution API", status: "FAIL", detail: "Not configured" });
    }

    // 4. Webhook registration
    const webhookReg = await kv.get("evolution:webhook_registered") as any;
    if (webhookReg?.registered) {
      checks.push({ check: "Webhook Registered", status: "OK", detail: `At: ${webhookReg.registeredAt}` });
    } else {
      checks.push({ check: "Webhook Registered", status: "WARN", detail: "No registration recorded — webhook may be set manually" });
    }

    // 5. Recent webhook activity
    const counter = await kv.get("webhook:counter") as number || 0;
    const events = await kv.get("webhook:events_log") as any[] || [];
    const lastEvent = Array.isArray(events) && events.length > 0 ? events[0] : null;
    checks.push({
      check: "Webhook Activity",
      status: counter > 0 ? "OK" : "WARN",
      detail: `${counter} total messages received. Last: ${lastEvent?.receivedAt || "never"}`,
    });

    // 6. AI interactions log
    const aiLog = await kv.get("ai:interactions_log") as any[] || [];
    const recentAI = Array.isArray(aiLog) ? aiLog.slice(0, 5) : [];
    checks.push({
      check: "AI Replies",
      status: recentAI.length > 0 ? "OK" : "WARN",
      detail: `${aiLog.length} total AI replies logged. Last: ${recentAI[0]?.at || "never"}`,
    });

    // 7. Conversations count
    const conversations = await kv.getByPrefix("conversation:");
    checks.push({
      check: "Conversations",
      status: "INFO",
      detail: `${conversations.length} total conversations`,
    });

    // Build webhook URL for reference
    const supabaseUrl = process.env.SERVER_URL || "http://localhost:3001";
    const anonKey = "";
    const webhookUrl = `${supabaseUrl}/functions/v1/make-server-5c5dc789/webhook/evolution?apikey=${anonKey}`;

    return c.json({ checks, recentAILog: recentAI, webhookUrl });
  } catch (error) {
    console.log("AI diagnostics error:", error);
    return c.json({ error: `Diagnostics error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// AI AUTO-REPLY: Interactions Log
// ─────────────────────────────────────────────
// GET /intent/:conversationId — get AI intent analysis for a conversation
app.get("/make-server-5c5dc789/intent/:conversationId", async (c) => {
  try {
    const conversationId = c.req.param("conversationId");
    const intent = await kv.get(`intent:${conversationId}`);
    if (!intent) return c.json({ found: false });
    return c.json({ found: true, ...intent });
  } catch (error) {
    return c.json({ error: `${error}` }, 500);
  }
});

// GET /intents — get all recent intent analyses (for live dashboard)
app.get("/make-server-5c5dc789/intents", async (c) => {
  try {
    const intents = await kv.getByPrefix("intent:");
    const sorted = intents
      .sort((a: any, b: any) => new Date(b.analyzedAt).getTime() - new Date(a.analyzedAt).getTime())
      .slice(0, 100);
    return c.json({ intents: sorted });
  } catch (error) {
    return c.json({ error: `${error}` }, 500);
  }
});

app.get("/make-server-5c5dc789/ai-log", async (c) => {
  try {
    const log = await kv.get("ai:interactions_log") as any[] || [];
    return c.json({ log: Array.isArray(log) ? log : [] });
  } catch (error) {
    console.log("AI log error:", error);
    return c.json({ error: `AI log error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// MESSAGE TEMPLATES: Save & Reuse templates
// ─────────────────────────────────────────────
app.get("/make-server-5c5dc789/templates", async (c) => {
  try {
    const templates = await kv.getByPrefix("template:");
    const sorted = templates.sort(
      (a: any, b: any) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
    );
    return c.json({ templates: sorted });
  } catch (error) {
    console.log("Templates get error:", error);
    return c.json({ error: `Templates get error: ${error}` }, 500);
  }
});

app.post("/make-server-5c5dc789/templates", async (c) => {
  try {
    const body = await c.req.json();
    const { name, message, imageUrl, messageVariants, id } = body;
    if (!name || !message) {
      return c.json({ error: "Template name and message are required" }, 400);
    }
    const templateId = id || uuid();
    const existing = id ? await kv.get(`template:${id}`) as any : null;
    await kv.set(`template:${templateId}`, {
      id: templateId,
      name,
      message,
      imageUrl: imageUrl || null,
      messageVariants: Array.isArray(messageVariants) ? messageVariants.filter((v: string) => v.trim()) : [],
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    console.log(`Template saved: ${templateId} "${name}"`);
    return c.json({ status: "ok", templateId });
  } catch (error) {
    console.log("Template save error:", error);
    return c.json({ error: `Template save error: ${error}` }, 500);
  }
});

app.delete("/make-server-5c5dc789/templates/:id", async (c) => {
  try {
    const id = c.req.param("id");
    await kv.del(`template:${id}`);
    return c.json({ status: "ok" });
  } catch (error) {
    console.log("Template delete error:", error);
    return c.json({ error: `Template delete error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// CONTACT GROUPS: Save phone number groups
// ─────────────────────────────────────────────
app.get("/make-server-5c5dc789/contact-groups", async (c) => {
  try {
    const groups = await kv.getByPrefix("contact_group:");
    const sorted = groups.sort(
      (a: any, b: any) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
    );
    return c.json({ groups: sorted });
  } catch (error) {
    console.log("Contact groups get error:", error);
    return c.json({ error: `Contact groups get error: ${error}` }, 500);
  }
});

app.post("/make-server-5c5dc789/contact-groups", async (c) => {
  try {
    const body = await c.req.json();
    const { name, phoneNumbers, id } = body;
    if (!name || !Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
      return c.json({ error: "Group name and at least one phone number are required" }, 400);
    }
    const groupId = id || uuid();
    const existing = id ? await kv.get(`contact_group:${id}`) as any : null;
    await kv.set(`contact_group:${groupId}`, {
      id: groupId,
      name,
      phoneNumbers: phoneNumbers.filter((p: string) => p.trim()),
      count: phoneNumbers.filter((p: string) => p.trim()).length,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    console.log(`Contact group saved: ${groupId} "${name}" (${phoneNumbers.length} numbers)`);
    return c.json({ status: "ok", groupId });
  } catch (error) {
    console.log("Contact group save error:", error);
    return c.json({ error: `Contact group save error: ${error}` }, 500);
  }
});

app.delete("/make-server-5c5dc789/contact-groups/:id", async (c) => {
  try {
    const id = c.req.param("id");
    await kv.del(`contact_group:${id}`);
    return c.json({ status: "ok" });
  } catch (error) {
    console.log("Contact group delete error:", error);
    return c.json({ error: `Contact group delete error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// BULK MESSAGING: Delete a campaign from history
// ─────────────────────────────────────────────
app.delete("/make-server-5c5dc789/bulk-message/campaigns/:id", async (c) => {
  try {
    const id = c.req.param("id");
    await kv.del(`bulk_campaign:${id}`);
    console.log(`Campaign deleted: ${id}`);
    return c.json({ status: "ok" });
  } catch (error) {
    console.log("Campaign delete error:", error);
    return c.json({ error: `Campaign delete error: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// MENU / PRODUCTS: CRUD + Bulk Excel Import
// ─────────────────────────────────────────────

// Get all products
app.get("/make-server-5c5dc789/products", async (c) => {
  try {
    const products = await kv.getByPrefix("product:");
    const sorted = products.sort(
      (a: any, b: any) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
    );
    const categories = await kv.getByPrefix("product_category:");
    const sortedCats = categories.sort((a: any, b: any) => (a.order || 0) - (b.order || 0));
    return c.json({ products: sorted, categories: sortedCats });
  } catch (error) {
    console.log("Products get error:", error);
    return c.json({ error: `Products get error: ${error}` }, 500);
  }
});

// Save or update a product
app.post("/make-server-5c5dc789/products", async (c) => {
  try {
    const body = await c.req.json();
    const { name, price, currency, description, category, imageUrl, available, id,
            discountType, discountValue, offerLabel } = body;
    if (!name || price === undefined) {
      return c.json({ error: "Product name and price are required" }, 400);
    }
    const productId = id || uuid();
    const existing = id ? await kv.get(`product:${id}`) as any : null;
    const product: any = {
      id: productId,
      name: name.trim(),
      price: parseFloat(price) || 0,
      currency: currency || "AED",
      description: (description || "").trim(),
      category: (category || "عام").trim(),
      imageUrl: imageUrl || "",
      available: available !== false,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Discount fields
    if (discountType) {
      product.discountType = discountType;
      product.discountValue = parseFloat(discountValue) || 0;
      product.offerLabel = (offerLabel || "").trim();
    } else {
      product.discountType = null;
      product.discountValue = null;
      product.offerLabel = null;
    }
    await kv.set(`product:${productId}`, product);
    await syncProductsToAI();
    console.log(`Product saved: ${productId} "${name}" ${price} ${currency || "AED"}`);
    return c.json({ status: "ok", productId, product });
  } catch (error) {
    console.log("Product save error:", error);
    return c.json({ error: `Product save error: ${error}` }, 500);
  }
});

// Delete a product
app.delete("/make-server-5c5dc789/products/:id", async (c) => {
  try {
    const id = c.req.param("id");
    await kv.del(`product:${id}`);
    await syncProductsToAI();
    return c.json({ status: "ok" });
  } catch (error) {
    console.log("Product delete error:", error);
    return c.json({ error: `Product delete error: ${error}` }, 500);
  }
});

// Bulk delete products
app.post("/make-server-5c5dc789/products/bulk-delete", async (c) => {
  try {
    const body = await c.req.json();
    const { ids } = body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return c.json({ error: "ids array is required" }, 400);
    }
    const keys = ids.map((id: string) => `product:${id}`);
    await kv.mdel(keys);
    await syncProductsToAI();
    console.log(`Bulk deleted ${ids.length} products`);
    return c.json({ status: "ok", deleted: ids.length });
  } catch (error) {
    console.log("Bulk delete error:", error);
    return c.json({ error: `Bulk delete error: ${error}` }, 500);
  }
});

// Bulk import products (from parsed Excel JSON)
app.post("/make-server-5c5dc789/products/bulk-import", async (c) => {
  try {
    const body = await c.req.json();
    const { products, mode } = body;
    if (!Array.isArray(products) || products.length === 0) {
      return c.json({ error: "products array is required and must not be empty" }, 400);
    }
    if (mode === "replace") {
      const existing = await kv.getByPrefix("product:");
      if (existing.length > 0) {
        const keys = existing.map((p: any) => `product:${p.id}`);
        await kv.mdel(keys);
        console.log(`Replaced: deleted ${existing.length} existing products`);
      }
    }
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (let i = 0; i < products.length; i++) {
      const row = products[i];
      const name = (row.name || row["اسم المنتج"] || row["Name"] || row["Product"] || row["المنتج"] || "").toString().trim();
      const priceRaw = row.price || row["السعر"] || row["Price"] || row["سعر"] || 0;
      const price = parseFloat(priceRaw.toString().replace(/[^0-9.]/g, "")) || 0;
      const currency = (row.currency || row["العملة"] || row["Currency"] || "AED").toString().trim();
      const description = (row.description || row["الوصف"] || row["Description"] || "").toString().trim();
      const category = (row.category || row["الفئة"] || row["Category"] || row["التصنيف"] || "عام").toString().trim();
      const availableRaw = row.available ?? row["متاح"] ?? row["Available"] ?? true;
      const available = availableRaw === true || availableRaw === "true" || availableRaw === "نعم" || availableRaw === "yes" || availableRaw === 1 || availableRaw === "1";
      if (!name) {
        skipped++;
        errors.push(`Row ${i + 2}: missing product name`);
        continue;
      }
      const productId = uuid();
      await kv.set(`product:${productId}`, {
        id: productId, name, price, currency, description, category,
        imageUrl: (row.imageUrl || row["صورة"] || row["Image"] || "").toString().trim(),
        available,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      imported++;
      const catId = category.toLowerCase().replace(/\s+/g, "_");
      const existingCat = await kv.get(`product_category:${catId}`) as any;
      if (!existingCat) {
        await kv.set(`product_category:${catId}`, { id: catId, name: category, order: 0, createdAt: new Date().toISOString() });
      }
    }
    await syncProductsToAI();
    console.log(`Bulk import: ${imported} imported, ${skipped} skipped (mode: ${mode})`);
    return c.json({ status: "ok", imported, skipped, errors: errors.slice(0, 20), total: products.length });
  } catch (error) {
    console.log("Bulk import error:", error);
    return c.json({ error: `Bulk import error: ${error}` }, 500);
  }
});

// Save/update category
app.post("/make-server-5c5dc789/products/categories", async (c) => {
  try {
    const body = await c.req.json();
    const { id, name, order } = body;
    if (!name) return c.json({ error: "Category name is required" }, 400);
    const catId = id || name.toLowerCase().replace(/\s+/g, "_");
    await kv.set(`product_category:${catId}`, { id: catId, name: name.trim(), order: order || 0, createdAt: new Date().toISOString() });
    return c.json({ status: "ok", categoryId: catId });
  } catch (error) {
    console.log("Category save error:", error);
    return c.json({ error: `Category save error: ${error}` }, 500);
  }
});

// Delete category
app.delete("/make-server-5c5dc789/products/categories/:id", async (c) => {
  try {
    const id = c.req.param("id");
    await kv.del(`product_category:${id}`);
    return c.json({ status: "ok" });
  } catch (error) {
    console.log("Category delete error:", error);
    return c.json({ error: `Category delete error: ${error}` }, 500);
  }
});

// Sync products → AI config menuItems
async function syncProductsToAI() {
  try {
    const products = await kv.getByPrefix("product:");
    const available = products.filter((p: any) => p.available !== false);
    const menuItems = available.map((p: any) => ({
      name: p.name, price: p.price, currency: p.currency || "AED",
      description: p.description || "", category: p.category || "",
    }));
    const aiConfig = await kv.get("ai:config") as any;
    if (aiConfig) {
      aiConfig.menuItems = menuItems;
      await kv.set("ai:config", aiConfig);
      console.log(`Synced ${menuItems.length} products to AI config`);
    }
  } catch (e) {
    console.log("syncProductsToAI error:", e);
  }
}

// ─────────────────────────────────────────────
// AI AUTO-REPLY: Send Manual Message (Human Override)
// ─────────────────────────────────────────────
app.post("/make-server-5c5dc789/ai-send-manual", async (c) => {
  try {
    const body = await c.req.json();
    const { conversationId, text } = body;
    if (!conversationId || !text) {
      return c.json({ error: "conversationId and text are required" }, 400);
    }
    const conversations = await kv.getByPrefix("conversation:");
    const conv = conversations.find((cv: any) => cv.id === conversationId);
    if (!conv) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    const sent = await sendWhatsAppReply(conv.customer_phone, text);
    const msgId = uuid();
    await kv.set(`message:${msgId}`, {
      id: msgId,
      conversation_id: conversationId,
      direction: "outbound",
      sender_type: "agent",
      text: text,
      sent_at: new Date().toISOString(),
      payload: { manual: true, sent_via_whatsapp: sent },
    });
    return c.json({ success: true, sent_via_whatsapp: sent, message_id: msgId });
  } catch (error) {
    console.log("Manual send error:", error);
    return c.json({ error: `Manual send error: ${error}` }, 500);
  }
});

// ──────────────────────────────────────────────
// INBOX — WhatsApp Chat Supervision
// ──────────────────────────────────────────────

// GET /inbox/chats — list all individual chats (KV-first, Evo API merge)
app.get("/make-server-5c5dc789/inbox/chats", async (c) => {
  try {
    // ── Primary: build chat list from KV conversations (uses embedded last_message_text to avoid loading all messages) ──
    const conversations = await kv.getByPrefix("conversation:");

    const kvChats: any[] = [];
    const seenPhones = new Set<string>();
    for (const conv of conversations) {
      const rawPhone = conv.customer_phone || "";
      if (!rawPhone) continue;
      // Strip @lid, @s.whatsapp.net, @g.us etc. to get clean phone number
      const phone = rawPhone.replace(/@.*$/, "");
      if (!phone || phone.length < 5) continue;
      // Deduplicate by clean phone number — merge data from duplicate conversations
      if (seenPhones.has(phone)) {
        // If this duplicate conv has newer data, update the existing chat entry
        const existingChat = kvChats.find((ch: any) => ch.phone === phone);
        if (existingChat && conv.last_message_at) {
          const existingTs = existingChat.timestamp;
          const thisTs = new Date(conv.last_message_at).getTime() / 1000;
          if (thisTs > existingTs) {
            existingChat.timestamp = thisTs;
            existingChat.lastMessage = conv.last_message_text || existingChat.lastMessage;
            existingChat.name = conv.customer_name || existingChat.name;
          }
          existingChat.msgCount = (existingChat.msgCount || 0) + (conv.msg_count || 0);
        }
        continue;
      }
      seenPhones.add(phone);
      const remoteJid = `${phone}@s.whatsapp.net`;

      // Use embedded conversation data (set by webhook) — no need to load all messages
      const lastMsgText = conv.last_message_text || "";
      const ts = conv.last_message_at ? new Date(conv.last_message_at).getTime() / 1000 : 0;
      const msgCount = conv.msg_count || 0;

      kvChats.push({
        remoteJid, phone,
        name: conv.customer_name || phone,
        lastMessage: lastMsgText,
        timestamp: ts,
        unreadCount: 0,
        msgCount,
      });
    }

    // ── Secondary: try Evolution API for additional chats (fast, non-blocking) ──
    let evoChats: any[] = [];
    try {
      const config = await kv.get("evolution:config") as any;
      if (config?.apiUrl && config?.apiKey && config?.instanceName) {
        const baseUrl = cleanEvoUrl(config.apiUrl);
        const instanceEnc = encodeURIComponent(config.instanceName);
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 8000);
        const chatEndpoints = [
          { path: `/chat/findChats/${instanceEnc}`, method: "POST" as const, body: {} },
          { path: `/chat/findChats/${instanceEnc}`, method: "GET" as const, body: undefined },
        ];
        for (const ep of chatEndpoints) {
          try {
            const res = await evoFetch(baseUrl, config.apiKey, ep.path, ep.method, ep.body, ac.signal);
            if (res.ok) {
              const raw = await res.text();
              const parsed = JSON.parse(raw);
              const arr = Array.isArray(parsed) ? parsed : parsed?.data || parsed?.chats || [];
              if (Array.isArray(arr) && arr.length > 0) { evoChats = arr; break; }
            }
          } catch { /* ignore — KV is primary */ }
        }
      }
    } catch {
      console.log("[Inbox] Evo API chat fetch skipped (non-critical)");
    }

    // Merge: add Evo chats not already in KV
    const kvPhones = new Set(kvChats.map((ch: any) => ch.phone));
    for (const ch of evoChats) {
      const id = ch.id || ch.remoteJid || ch.jid || "";
      if (!id.endsWith("@s.whatsapp.net") || id.startsWith("status")) continue;
      const phone = id.replace("@s.whatsapp.net", "");
      if (kvPhones.has(phone)) {
        const existing = kvChats.find((k: any) => k.phone === phone);
        if (existing && (ch.unreadMessages || ch.unreadCount)) {
          existing.unreadCount = Math.max(existing.unreadCount, ch.unreadMessages || ch.unreadCount || 0);
        }
        continue;
      }
      const name = ch.name || ch.pushName || ch.contact?.pushName || ch.contact?.name || ch.notifyName || phone;
      const lastMsg = ch.lastMessage?.conversation || ch.lastMessage?.extendedTextMessage?.text || ch.lastMessage?.message?.conversation || ch.lastMessage?.message?.extendedTextMessage?.text || ch.msg?.conversation || ch.msg?.extendedTextMessage?.text || "";
      const ts = ch.lastMsgTimestamp || ch.lastMessageTimestamp || ch.updatedAt || 0;
      const unread = ch.unreadMessages || ch.unreadCount || 0;
      kvChats.push({ remoteJid: id, phone, name, lastMessage: lastMsg, timestamp: ts, unreadCount: unread, msgCount: 0 });
    }

    kvChats.sort((a: any, b: any) => {
      const numA = typeof a.timestamp === "number" ? a.timestamp : new Date(a.timestamp).getTime() / 1000;
      const numB = typeof b.timestamp === "number" ? b.timestamp : new Date(b.timestamp).getTime() / 1000;
      return numB - numA;
    });

    console.log(`[Inbox] chats: ${kvChats.length} total (${conversations.length} KV, ${evoChats.length} Evo)`);
    return c.json({ success: true, chats: kvChats, total: kvChats.length });
  } catch (error) {
    console.log("[Inbox] chats error:", error);
    return c.json({ error: `Failed to fetch chats: ${error}` }, 500);
  }
});

// POST /inbox/messages — get messages for a specific chat (KV-first)
app.post("/make-server-5c5dc789/inbox/messages", async (c) => {
  try {
    const { remoteJid, limit = 100 } = await c.req.json();
    if (!remoteJid) return c.json({ error: "remoteJid is required" }, 400);

    const phone = remoteJid.replace(/@.*$/, "");
    console.log(`[Inbox] Fetching messages for phone=${phone} jid=${remoteJid}`);

    // ── Primary: KV messages — find ALL matching conversations (handles @lid / @s.whatsapp.net duplicates) ──
    const conversations = await kv.getByPrefix("conversation:");
    const matchingConversations = conversations.filter((cv: any) => {
      const cvPhone = (cv.customer_phone || "").replace(/@.*$/, "");
      return cvPhone === phone;
    });
    console.log(`[Inbox] Found ${matchingConversations.length} matching conversations for phone=${phone} (IDs: ${matchingConversations.map((c: any) => c.id).join(", ")})`);

    let kvMessages: any[] = [];
    if (matchingConversations.length > 0) {
      // Load messages per conversation using conversation-specific prefix (avoids 1000-item global limit)
      for (const conv of matchingConversations) {
        const convMsgs = await kv.getByPrefix(`cmsg:${conv.id}:`);
        console.log(`[Inbox] Conv ${conv.id}: ${convMsgs.length} msgs via cmsg: prefix`);
        kvMessages.push(...convMsgs);
      }
      // Fallback: if cmsg: is empty, try legacy message: prefix (for pre-migration data)
      if (kvMessages.length === 0) {
        console.log(`[Inbox] No cmsg: messages found, trying legacy message: prefix...`);
        const legacyMessages = await kv.getByPrefix("message:");
        const matchingConvIds = new Set(matchingConversations.map((c: any) => c.id));
        kvMessages = legacyMessages.filter((m: any) => matchingConvIds.has(m.conversation_id));
        console.log(`[Inbox] Legacy fallback: ${kvMessages.length} of ${legacyMessages.length} total`);
      }
      kvMessages.sort((a: any, b: any) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime());
      kvMessages = kvMessages.slice(-limit);
      console.log(`[Inbox] KV messages across ${matchingConversations.length} conv(s): ${kvMessages.length}`);
    } else {
      console.log(`[Inbox] No KV conversation found for phone=${phone}`);
    }

    // Build a map of conversation id -> customer_name for pushName
    const convNameMap: Record<string, string> = {};
    for (const cv of matchingConversations) {
      convNameMap[cv.id] = cv.customer_name || "";
    }

    // Normalize KV messages
    const normalized = kvMessages.map((m: any) => {
      const fromMe = m.direction === "outbound";
      const text = m.text || "";
      const rawMsgType = m.payload?.messageType || "";
      const msgTypeMap: Record<string, string> = {
        imageMessage: "image", videoMessage: "video", audioMessage: "audio",
        documentMessage: "document", stickerMessage: "sticker",
      };
      let mediaType: string | null = null;
      if (rawMsgType && msgTypeMap[rawMsgType]) mediaType = msgTypeMap[rawMsgType];
      else if (text === "[Image]") mediaType = "image";
      else if (text === "[Video]") mediaType = "video";
      else if (text === "[Audio]") mediaType = "audio";
      else if (text === "[Document]") mediaType = "document";
      else if (text === "[Sticker]") mediaType = "sticker";
      const timestamp = m.sent_at ? new Date(m.sent_at).getTime() / 1000 : 0;
      const msgId = m.id || m.payload?.key?.id || m.payload?.msgKeyId || `kv-${timestamp}`;
      const pushName = fromMe ? "" : (convNameMap[m.conversation_id] || "");
      // ← Pass the real WhatsApp key ID and original remoteJid for media fetching
      const msgKeyId = m.payload?.msgKeyId || m.payload?.key?.id || "";
      const payloadRemoteJid = m.payload?.key?.remoteJid || "";
      return {
        id: msgId, fromMe, text: mediaType ? "" : text, mediaType, timestamp, pushName,
        msgKeyId, payloadRemoteJid, messageType: rawMsgType,
      };
    });

    // ── Fallback: if KV is empty, try Evolution API with longer timeout + more endpoints ──
    if (normalized.length === 0) {
      console.log(`[Inbox] KV empty for phone=${phone}, trying Evolution API fallback...`);
      try {
        const config = await kv.get("evolution:config") as any;
        if (config?.apiUrl && config?.apiKey && config?.instanceName) {
          const baseUrl = cleanEvoUrl(config.apiUrl);
          const instanceEnc = encodeURIComponent(config.instanceName);
          const ac = new AbortController();
          setTimeout(() => ac.abort(), 18000); // 18s timeout

          // Build JID variants to try
          const jidS = `${phone}@s.whatsapp.net`;
          const jidLid = `${phone}@lid`;

          const msgEndpoints = [
            // v2 endpoints
            { label: "chat.findMessages.POST.jidS", method: "POST" as const, path: `/chat/findMessages/${instanceEnc}`, body: { where: { key: { remoteJid: jidS } }, limit } },
            { label: "chat.findMessages.POST.jidLid", method: "POST" as const, path: `/chat/findMessages/${instanceEnc}`, body: { where: { key: { remoteJid: jidLid } }, limit } },
            // Alternative body formats
            { label: "chat.findMessages.POST.remoteJid", method: "POST" as const, path: `/chat/findMessages/${instanceEnc}`, body: { remoteJid: jidS, limit } },
            // message/ endpoint variations
            { label: "message.findMessages.POST.jidS", method: "POST" as const, path: `/message/findMessages/${instanceEnc}`, body: { where: { key: { remoteJid: jidS } }, limit } },
            // v1-style GET with query params
            { label: "chat.findMessages.GET", method: "GET" as const, path: `/chat/findMessages/${instanceEnc}?remoteJid=${encodeURIComponent(jidS)}&limit=${limit}`, body: undefined },
          ];

          const normalizeEvoMessages = (arr: any[]) => {
            return arr.map((msg: any) => {
              const key = msg.key || {};
              const fromMe = key.fromMe ?? msg.fromMe ?? false;
              const mc = msg.message || {};
              const text = mc.conversation || mc.extendedTextMessage?.text || mc.buttonsResponseMessage?.selectedDisplayText || mc.listResponseMessage?.title || mc.imageMessage?.caption || mc.videoMessage?.caption || mc.documentMessage?.caption || msg.body || msg.text || "";
              let mediaType: string | null = null;
              if (mc.imageMessage) mediaType = "image";
              else if (mc.videoMessage) mediaType = "video";
              else if (mc.audioMessage || mc.pttMessage) mediaType = "audio";
              else if (mc.documentMessage) mediaType = "document";
              else if (mc.stickerMessage) mediaType = "sticker";
              else if (mc.contactMessage || mc.contactsArrayMessage) mediaType = "contact";
              else if (mc.locationMessage || mc.liveLocationMessage) mediaType = "location";
              const timestamp = msg.messageTimestamp || msg.timestamp || msg.createdAt || 0;
              const msgId = key.id || msg.id || msg._id || `evo-${timestamp}-${Math.random().toString(36).slice(2, 6)}`;
              const pushName = msg.pushName || "";
              return { id: msgId, fromMe, text, mediaType, timestamp, pushName };
            }).sort((a: any, b: any) => {
              const tA = typeof a.timestamp === "number" ? a.timestamp : new Date(a.timestamp).getTime() / 1000;
              const tB = typeof b.timestamp === "number" ? b.timestamp : new Date(b.timestamp).getTime() / 1000;
              return tA - tB;
            });
          };

          for (const ep of msgEndpoints) {
            if (ac.signal.aborted) break;
            try {
              console.log(`[Inbox] Trying Evo endpoint: ${ep.label}`);
              const res = await evoFetch(baseUrl, config.apiKey, ep.path, ep.method, ep.body, ac.signal);
              const statusCode = res.status;
              if (res.ok) {
                const raw = await res.text();
                console.log(`[Inbox] Evo ${ep.label} response (${statusCode}): ${raw.slice(0, 300)}`);
                let parsed;
                try { parsed = JSON.parse(raw); } catch { console.log(`[Inbox] Evo ${ep.label}: invalid JSON`); continue; }
                const arr = Array.isArray(parsed) ? parsed : parsed?.messages || parsed?.records || parsed?.data || [];
                if (Array.isArray(arr) && arr.length > 0) {
                  console.log(`[Inbox] Evo API messages via ${ep.label}: ${arr.length}`);
                  const evoNormalized = normalizeEvoMessages(arr);
                  return c.json({ success: true, messages: evoNormalized, total: evoNormalized.length, source: "evolution_api", endpoint: ep.label });
                } else {
                  console.log(`[Inbox] Evo ${ep.label}: OK but empty array (${typeof parsed} keys=${Object.keys(parsed || {}).join(",")})`);
                }
              } else {
                console.log(`[Inbox] Evo ${ep.label}: HTTP ${statusCode}`);
              }
            } catch (e: any) {
              console.log(`[Inbox] Evo ${ep.label} error: ${e?.message || e}`);
            }
          }
          console.log(`[Inbox] All Evo API message endpoints exhausted, returning empty`);
        } else {
          console.log(`[Inbox] No Evolution config found, returning empty KV result`);
        }
      } catch (evoErr) {
        console.log(`[Inbox] Evolution API fallback error (non-critical): ${evoErr}`);
      }
    }

    return c.json({ success: true, messages: normalized, total: normalized.length, source: normalized.length > 0 ? "kv_store" : "empty" });
  } catch (error) {
    console.log("[Inbox] messages error:", error);
    return c.json({ error: `Failed to fetch messages: ${error}` }, 500);
  }
});

// POST /inbox/migrate — one-time migration: re-key legacy message: entries to cmsg:{convId}:{msgId}
app.post("/make-server-5c5dc789/inbox/migrate", async (c) => {
  try {
    const legacyMessages = await kv.getByPrefix("message:");
    console.log(`[Migration] Found ${legacyMessages.length} legacy messages to migrate`);
    
    let migrated = 0;
    let skipped = 0;
    let orphaned = 0;
    
    // Also update conversation objects with last message info
    const allConversations = await kv.getByPrefix("conversation:");
    const convMap = new Map(allConversations.map((cv: any) => [cv.id, cv]));
    const convLastMsg: Record<string, any> = {};
    
    for (const msg of legacyMessages) {
      const convId = msg.conversation_id;
      if (!convId || !convMap.has(convId)) {
        orphaned++;
        continue;
      }
      
      const msgId = msg.id;
      if (!msgId) { skipped++; continue; }
      
      // Save with new prefix
      await kv.set(`cmsg:${convId}:${msgId}`, msg);
      
      // Save dedup marker if msgKeyId exists
      const msgKeyId = msg.payload?.key?.id || msg.payload?.msgKeyId;
      if (msgKeyId) {
        await kv.set(`msgdedup:${msgKeyId}`, { t: Date.now() });
      }
      
      // Track last message per conversation
      if (!convLastMsg[convId] || new Date(msg.sent_at).getTime() > new Date(convLastMsg[convId].sent_at).getTime()) {
        convLastMsg[convId] = msg;
      }
      
      migrated++;
    }
    
    // Update conversation objects with last message info and count
    let convsUpdated = 0;
    for (const [convId, lastMsg] of Object.entries(convLastMsg)) {
      const conv = convMap.get(convId);
      if (!conv) continue;
      conv.last_message_text = (lastMsg as any).text || "";
      conv.last_message_direction = (lastMsg as any).direction || "";
      // Count all messages for this conversation
      const count = legacyMessages.filter((m: any) => m.conversation_id === convId).length;
      conv.msg_count = count;
      await kv.set(`conversation:${convId}`, conv);
      convsUpdated++;
    }
    
    console.log(`[Migration] Done: migrated=${migrated} skipped=${skipped} orphaned=${orphaned} convsUpdated=${convsUpdated}`);
    return c.json({ 
      success: true, 
      migrated, skipped, orphaned, convsUpdated,
      totalLegacy: legacyMessages.length,
      note: "Legacy messages have been re-keyed to cmsg:{convId}:{msgId}. New messages will use the new format automatically."
    });
  } catch (error) {
    console.log("[Migration] error:", error);
    return c.json({ error: `Migration error: ${error}` }, 500);
  }
});

// POST /inbox/debug — diagnostic endpoint to inspect KV data for a given phone
app.post("/make-server-5c5dc789/inbox/debug", async (c) => {
  try {
    const { phone: rawPhone } = await c.req.json();
    const phone = (rawPhone || "").replace(/@.*$/, "");

    const allConversations = await kv.getByPrefix("conversation:");

    // All conversations summary
    const convSummaries = allConversations.map((cv: any) => ({
      id: cv.id,
      customer_phone: cv.customer_phone,
      customer_name: cv.customer_name,
      cleanPhone: (cv.customer_phone || "").replace(/@.*$/, ""),
      status: cv.status,
      last_message_at: cv.last_message_at,
      last_message_text: cv.last_message_text || "",
      msg_count: cv.msg_count || 0,
    }));

    // Matching conversations for this phone
    const matching = convSummaries.filter((cv: any) => cv.cleanPhone === phone);

    // Check NEW cmsg: prefix for matching conversations
    let cmsgCount = 0;
    const cmsgSample: any[] = [];
    for (const cv of matching) {
      const convMsgs = await kv.getByPrefix(`cmsg:${cv.id}:`);
      cmsgCount += convMsgs.length;
      cmsgSample.push(...convMsgs.slice(0, 5).map((m: any) => ({
        id: m.id, conversation_id: m.conversation_id, direction: m.direction,
        text: (m.text || "").slice(0, 100), sent_at: m.sent_at,
      })));
    }

    // Check legacy message: prefix (limited to 1000)
    const legacyMessages = await kv.getByPrefix("message:");
    const matchingIds = new Set(matching.map((cv: any) => cv.id));
    const legacyMatchCount = legacyMessages.filter((m: any) => matchingIds.has(m.conversation_id)).length;

    return c.json({
      phone,
      totalConversations: allConversations.length,
      totalLegacyMessages: legacyMessages.length,
      matchingConversations: matching,
      cmsgMessages: cmsgCount,
      cmsgSample: cmsgSample.slice(0, 10),
      legacyMatchCount,
      note: cmsgCount > 0 ? "Messages found in new cmsg: format" : legacyMatchCount > 0 ? "Messages found in legacy format only — run migration" : "No messages found — check if webhook is receiving data",
    });
  } catch (error) {
    return c.json({ error: `Debug error: ${error}` }, 500);
  }
});

// POST /inbox/media — fetch media (image/audio/video/doc) from Evolution API as base64
app.post("/make-server-5c5dc789/inbox/media", async (c) => {
  try {
    const config = await kv.get("evolution:config") as any;
    if (!config?.apiUrl || !config?.apiKey || !config?.instanceName) {
      return c.json({ error: "Evolution API not configured" }, 400);
    }
    const { msgKeyId, remoteJid, fromMe, messageType } = await c.req.json();
    if (!msgKeyId) return c.json({ error: "msgKeyId required" }, 400);

    const baseUrl = config.apiUrl.replace(/\/$/, "");
    const instanceEnc = encodeURIComponent(config.instanceName);

    const body = {
      message: {
        key: { id: msgKeyId, fromMe: fromMe ?? false, remoteJid: remoteJid || "" },
        messageType: messageType || "imageMessage",
      },
      convertToMp4: messageType === "audioMessage",
    };

    const res = await evoFetch(baseUrl, config.apiKey, `/chat/getBase64FromMediaMessage/${instanceEnc}`, "POST", body);
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return c.json({ error: `Evolution API error ${res.status}: ${err.substring(0, 200)}` }, 502);
    }
    const data = await res.json();
    // Response: { base64: "...", mimetype: "image/jpeg", ... }
    const base64 = data?.base64 || data?.data || data?.mediaData || "";
    const mimetype = data?.mimetype || data?.mimeType || inferMime(messageType);
    if (!base64) return c.json({ error: "No media data returned" }, 404);
    return c.json({ success: true, base64, mimetype, messageType });
  } catch (error) {
    return c.json({ error: `Media fetch error: ${error}` }, 500);
  }
});

function inferMime(messageType: string): string {
  if (messageType === "imageMessage") return "image/jpeg";
  if (messageType === "videoMessage") return "video/mp4";
  if (messageType === "audioMessage") return "audio/ogg";
  if (messageType === "documentMessage") return "application/pdf";
  return "application/octet-stream";
}

// POST /inbox/send — send a message to a chat (with short timeout + KV save)
app.post("/make-server-5c5dc789/inbox/send", async (c) => {
  try {
    const config = await kv.get("evolution:config") as any;
    if (!config?.apiUrl || !config?.apiKey || !config?.instanceName) {
      return c.json({ error: "Evolution API not configured" }, 400);
    }
    const baseUrl = cleanEvoUrl(config.apiUrl);
    const instanceEnc = encodeURIComponent(config.instanceName);
    const { remoteJid, text } = await c.req.json();
    if (!remoteJid || !text) return c.json({ error: "remoteJid and text are required" }, 400);

    const phone = remoteJid.replace("@s.whatsapp.net", "");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 15000);

    const payloads = [
      { number: phone, text },
      { number: remoteJid, text },
      { number: phone, textMessage: { text } },
    ];
    const errors: string[] = [];
    for (const payload of payloads) {
      if (ac.signal.aborted) break;
      try {
        const res = await evoFetch(baseUrl, config.apiKey, `/message/sendText/${instanceEnc}`, "POST", payload, ac.signal);
        if (res.ok) {
          console.log(`[Inbox] Sent to ${phone}`);
          // Also save to KV so it shows in inbox immediately
          try {
            const conversations = await kv.getByPrefix("conversation:");
            const conv = conversations.find((cv: any) => {
              const cvPhone = (cv.customer_phone || "").replace(/@.*$/, "");
              return cvPhone === phone;
            });
            if (conv) {
              const msgId = uuid();
              const now = new Date().toISOString();
              await kv.set(`cmsg:${conv.id}:${msgId}`, {
                id: msgId, conversation_id: conv.id,
                direction: "outbound", sender_type: "agent",
                text, sent_at: now,
                payload: { source: "inbox_send" },
              });
              conv.last_message_at = now;
              conv.last_message_text = text;
              conv.last_message_direction = "outbound";
              conv.msg_count = (conv.msg_count || 0) + 1;
              await kv.set(`conversation:${conv.id}`, conv);
            }
          } catch (kvErr) {
            console.log(`[Inbox] KV save after send error (non-critical): ${kvErr}`);
          }
          return c.json({ success: true });
        } else {
          const errText = await res.text().catch(() => "");
          errors.push(`${res.status} ${errText.substring(0, 200)}`);
        }
      } catch (e: any) {
        errors.push(`${e?.message || e}`);
        console.log(`[Inbox] sendText error:`, e?.message || e);
      }
    }
    console.log(`[Inbox] All send attempts failed:`, errors);
    return c.json({ error: `Failed to send message. Attempts: ${errors.join(" | ")}` }, 500);
  } catch (error) {
    console.log("[Inbox] send error:", error);
    return c.json({ error: `Failed to send message: ${error}` }, 500);
  }
});

// ─────────────────────────────────────────────
// Static files: uploaded images
// ─────────────────────────────────────────────
app.use("/uploads/*", serveStatic({ root: "../" }));

// ─────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3001");

await initDB();
console.log(`[DB] MySQL connected — table kv_store ready`);
console.log(`[Server] Running on http://localhost:${PORT}`);

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" });