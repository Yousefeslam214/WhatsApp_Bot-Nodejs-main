/**
 * WhatsApp Bot (TypeScript + Baileys)
 *
 * Libraries used:
 * - @whiskeysockets/baileys: WhatsApp Web client API.
 * - qrcode-terminal: prints login QR code in terminal.
 * - pino: logger (set to silent to keep output clean).
 */
import qrcode from "qrcode-terminal";
import pino from "pino";
import makeWASocket, {
  BinaryInfo,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isLidUser,
  jidNormalizedUser,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

// Folder where Baileys stores session credentials after QR login.
const AUTH_FOLDER = "./baileys_auth";

// Quick replies that work without command prefix.
const GREETINGS = new Set(["hi", "hi bot"]);

// Reused usage text for send command.
const SEND_USAGE = "Usage: .sendmsg <number|jid> <message>";

type MessageContent = {
  conversation?: string;
  extendedTextMessage?: { text?: string };
  imageMessage?: { caption?: string };
  videoMessage?: { caption?: string };
  documentMessage?: { caption?: string };
};

type CommandContext = {
  sock: ReturnType<typeof makeWASocket>;
  msg: any;
  transportJid: string;
  canonicalUserId: string;
  pnToLidMap: Map<string, string>;
  text: string;
};

/**
 * Extract text from common WhatsApp message formats.
 * This gives one plain string for command parsing.
 */
function getMessageText(message?: MessageContent | null): string | null {
  if (!message) return null;
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text)
    return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  return null;
}

/**
 * Convert phone number to WhatsApp JID.
 * Example: 201234567890 -> 201234567890@s.whatsapp.net
 */
function normalizeTargetJid(target: string): string | null {
  if (!target) return null;
  if (target.includes("@")) return target; // Already JID

  const digitsOnly = target.replace(/\D/g, "");
  if (!digitsOnly) return null;

  return `${digitsOnly}@s.whatsapp.net`;
}

/**
 * Keep LID <-> phone-number JID mapping in memory.
 * This lets us unify WhatsApp Web/App identities for one user.
 */
function rememberPhoneShareMapping(
  lidRaw: string,
  pnJidRaw: string,
  lidToPnMap: Map<string, string>,
  pnToLidMap: Map<string, string>,
): void {
  const normalizedLid = jidNormalizedUser(lidRaw);
  const normalizedPn = jidNormalizedUser(pnJidRaw);
  if (!isLidUser(normalizedLid)) return;

  lidToPnMap.set(normalizedLid, normalizedPn);
  pnToLidMap.set(normalizedPn, normalizedLid);
}

/**
 * Debug helper: print full identity caches.
 */
function logIdentityCaches(
  reason: string,
  lidToPnMap: Map<string, string>,
  pnToLidMap: Map<string, string>,
  pnLookupAttempted: Set<string>,
): void {
  const lidToPnEntries = Array.from(lidToPnMap.entries());
  const pnToLidEntries = Array.from(pnToLidMap.entries());
  const attemptedEntries = Array.from(pnLookupAttempted.values());

  console.log(`🗂️ [CACHE] ${reason}`);

  console.log(`🗂️ [CACHE] lidToPnMap size=${lidToPnEntries.length}`);
  if (lidToPnEntries.length === 0) {
    console.log("🗂️ [CACHE] lidToPnMap: [empty]");
  } else {
    for (const [lid, pn] of lidToPnEntries) {
      console.log(`🗂️ [CACHE] lidToPnMap: ${lid} -> ${pn}`);
    }
  }

  console.log(`🗂️ [CACHE] pnToLidMap size=${pnToLidEntries.length}`);
  if (pnToLidEntries.length === 0) {
    console.log("🗂️ [CACHE] pnToLidMap: [empty]");
  } else {
    for (const [pn, lid] of pnToLidEntries) {
      console.log(`🗂️ [CACHE] pnToLidMap: ${pn} -> ${lid}`);
    }
  }

  console.log(`🗂️ [CACHE] pnLookupAttempted size=${attemptedEntries.length}`);
  if (attemptedEntries.length === 0) {
    console.log("🗂️ [CACHE] pnLookupAttempted: [empty]");
  } else {
    for (const pn of attemptedEntries) {
      console.log(`🗂️ [CACHE] pnLookupAttempted: ${pn}`);
    }
  }
}

/**
 * Internal stable user key.
 * - For LID chats: map to PN when known.
 * - For PN chats: keep PN.
 */
function resolveCanonicalUserId(
  transportJid: string,
  lidToPnMap: Map<string, string>,
): string {
  const normalized = jidNormalizedUser(transportJid);
  if (isLidUser(normalized)) {
    return lidToPnMap.get(normalized) || normalized;
  }
  return normalized;
}

/**
 * Preferred send target:
 * if we know the LID for a PN JID, prefer LID for delivery.
 */
function resolvePreferredSendTargetJid(
  targetJid: string,
  pnToLidMap: Map<string, string>,
): string {
  const normalized = jidNormalizedUser(targetJid);
  if (isLidUser(normalized)) return normalized;
  return pnToLidMap.get(normalized) || normalized;
}

/**
 * On first PN message, ask WhatsApp for the linked LID and cache it.
 * This reduces PN/LID split after the first resolution.
 */
async function hydratePnLidMapping(
  sock: ReturnType<typeof makeWASocket>,
  pnJid: string,
  lidToPnMap: Map<string, string>,
  pnToLidMap: Map<string, string>,
  pnLookupAttempted: Set<string>,
): Promise<void> {
  const normalizedPn = jidNormalizedUser(pnJid);
  if (isLidUser(normalizedPn)) return;
  if (pnToLidMap.has(normalizedPn)) return;
  if (pnLookupAttempted.has(normalizedPn)) return;

  pnLookupAttempted.add(normalizedPn);
  logIdentityCaches(
    `Marked PN lookup attempted for ${normalizedPn}`,
    lidToPnMap,
    pnToLidMap,
    pnLookupAttempted,
  );

  try {
    const results = await sock.onWhatsApp(normalizedPn);
    const match = (results || []).find(
      (item: any) =>
        jidNormalizedUser(item?.jid || "") === normalizedPn ||
        jidNormalizedUser(item?.id || "") === normalizedPn,
    );
    if (!match) {
      console.log(`ℹ️ No onWhatsApp match for ${normalizedPn}`);
      return;
    }

    const lidRaw = match?.lid;
    if (!lidRaw) {
      console.log(`ℹ️ No LID returned for ${normalizedPn}`);
      return;
    }

    const resolvedLid =
      typeof lidRaw === "string"
        ? jidNormalizedUser(lidRaw)
        : jidNormalizedUser((lidRaw as any)?.jid || (lidRaw as any)?.id || "");

    if (!resolvedLid || !isLidUser(resolvedLid)) return;

    rememberPhoneShareMapping(resolvedLid, normalizedPn, lidToPnMap, pnToLidMap);
    console.log(`🔗 Learned identity map: ${resolvedLid} -> ${normalizedPn}`);
    logIdentityCaches(
      `Saved mapping from onWhatsApp for ${normalizedPn}`,
      lidToPnMap,
      pnToLidMap,
      pnLookupAttempted,
    );
  } catch {
    console.log(`ℹ️ onWhatsApp lookup failed for ${normalizedPn}`);
    // Mapping can still arrive via chats.phoneNumberShare.
  }
}

/**
 * Central command router.
 * Keep this function simple so new developers can add commands quickly.
 */
async function handleMessageCommand({
  sock,
  msg,
  transportJid,
  canonicalUserId,
  text,
  pnToLidMap,
}: CommandContext): Promise<void> {
  console.log(
    `🛠️ [FLOW 4.7] handleMessageCommand start (transport=${transportJid}, canonical=${canonicalUserId})`,
  );
  const normalizedText = text.trim();
  if (!normalizedText) return;

  // Basic greeting flow.
  const lowerText = normalizedText.toLowerCase();
  if (GREETINGS.has(lowerText)) {
    await sock.sendMessage(transportJid, { text: "hello" }, { quoted: msg });
    return;
  }

  // Command parsing: first word = command, rest = args.
  const [rawCommand, ...args] = normalizedText.split(/\s+/);
  const command = rawCommand.toLowerCase();

  switch (command) {
    case ".hello":
      await sock.sendMessage(
        transportJid,
        { text: "Hello Too 👋" },
        { quoted: msg },
      );
      return;

    case ".test":
      await sock.sendMessage(
        transportJid,
        { text: "Testing..." },
        { quoted: msg },
      );
      return;

    case ".howreu":
      await sock.sendMessage(transportJid, { text: "Im Fine" }, { quoted: msg });
      return;

    case ".send":
    case ".sendmsg": {
      // Expected format: .sendmsg <number|jid> <message>
      if (args.length < 2) {
        await sock.sendMessage(
          transportJid,
          { text: SEND_USAGE },
          { quoted: msg },
        );
        return;
      }

      const targetRaw = args[0];
      const normalizedTargetJid = normalizeTargetJid(targetRaw);
      const targetJid = normalizedTargetJid
        ? resolvePreferredSendTargetJid(normalizedTargetJid, pnToLidMap)
        : null;
      const outgoingText = args.slice(1).join(" ").trim();

      if (!targetJid || !outgoingText) {
        await sock.sendMessage(
          transportJid,
          { text: SEND_USAGE },
          { quoted: msg },
        );
        return;
      }

      try {
        await sock.sendMessage(targetJid, { text: outgoingText });
        await sock.sendMessage(
          transportJid,
          { text: `Message sent to ${targetJid}` },
          { quoted: msg },
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        await sock.sendMessage(
          transportJid,
          { text: `Failed to send message: ${message}` },
          { quoted: msg },
        );
      }
      return;
    }

    case ".binaryinfo": {
      // Demo command: shows one Baileys helper object.
      const info = new BinaryInfo({
        sequence: 1,
        events: [{ exampleEvent: { props: {}, globals: {} } }],
      });

      await sock.sendMessage(
        transportJid,
        {
          text:
            `BinaryInfo => protocolVersion=${info.protocolVersion}, ` +
            `sequence=${info.sequence}, events=${info.events.length}, buffer=${info.buffer.length}`,
        },
        { quoted: msg },
      );
      return;
    }

    default:
      // Unknown command -> ignore.
      return;
  }
}

/**
 * App bootstrap:
 * 1) Load auth state.
 * 2) Create WhatsApp socket.
 * 3) Register connection and message listeners.
 */

async function start(): Promise<void> {
  console.log("🚀 [FLOW 1] Bootstrapping bot...");
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`✅ [FLOW 1] Auth loaded and Baileys version resolved: ${version.join(".")}`);

  /**
   * Represents a WhatsApp socket connection.
   *
   * The `sock` object is created using the `makeWASocket` function, which initializes
   * a connection to the WhatsApp Web service. It includes authentication state,
   * versioning information, logging configuration, browser details, and QR code
   * display settings.
   *
   * @type {WASocket} - The socket instance used for sending and receiving messages.
   * @property {AuthState} auth - The authentication state for the WhatsApp session.
   * @property {string} version - The version of the WhatsApp Web API being used.
   * @property {Logger} logger - The logger instance for logging events and errors.
   * @property {Browser} browser - The browser information for the connection.
   * @property {boolean} printQRInTerminal - Flag indicating whether to print the QR code in the terminal.
   */
  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: "silent" }),
    browser: Browsers.ubuntu("BotWA"),
    printQRInTerminal: false,
  });
  console.log("🔌 [FLOW 1] WhatsApp socket created.");

  // In-memory user identity map (LID <-> PN).
  const lidToPnMap = new Map<string, string>();
  const pnToLidMap = new Map<string, string>();
  const pnLookupAttempted = new Set<string>();
  console.log("🧠 [FLOW 2] In-memory maps initialized.");
  console.log("🧠 [FLOW 2] lidToPnMap (LID -> PN) ready.");
  console.log("🧠 [FLOW 2] pnToLidMap (PN -> LID) ready.");
  console.log("🧠 [FLOW 2] pnLookupAttempted set ready.");

  // Persist auth updates to disk.
  sock.ev.on("creds.update", saveCreds);

  // WhatsApp emits this when LID can be linked to a phone-number JID.
  console.log("👂 [FLOW 3] Listening for chats.phoneNumberShare events.");
  sock.ev.on("chats.phoneNumberShare", ({ lid, jid }) => {
    if (!lid || !jid) return;
    rememberPhoneShareMapping(lid, jid, lidToPnMap, pnToLidMap);
    console.log(
      `🔗 Learned identity map: ${jidNormalizedUser(lid)} -> ${jidNormalizedUser(jid)}`,
    );
    logIdentityCaches(
      `Saved mapping from chats.phoneNumberShare (${jidNormalizedUser(lid)})`,
      lidToPnMap,
      pnToLidMap,
      pnLookupAttempted,
    );
  });

  // Connection status listener.
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("📸 Scan this QR to login:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ [FLOW 1] Bot is connected and ready.");
      return;
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect as any)?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(
        `⚠️ Connection closed (${isLoggedOut ? "logged out" : "disconnected"}).`,
      );

      if (isLoggedOut) {
        console.log(`Delete ${AUTH_FOLDER} and scan QR again.`);
        return;
      }

      // Reconnect on temporary disconnect.
      start().catch((err) => console.error("Reconnect failed:", err));
    }
  });

  // Incoming message listener.
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    console.log("📥 [FLOW 4] messages.upsert notify event received.");

    const msg = messages?.[0] as any;
    if (!msg?.message) return;

    console.log("🧾 [FLOW 4.1] Reading transportJid from incoming message key.");
    const transportJid = msg.key?.remoteJid as string | undefined;
    console.log("🧾 [FLOW 4.1] transportJid =", transportJid || "[missing]");

    // Ignore invalid, self, and status messages.
    if (!transportJid || msg.key?.fromMe || transportJid === "status@broadcast") {
      console.log("⏭️ [FLOW 4.2] Ignored message (invalid/self/status).");
      return;
    }

    const text = (getMessageText(msg.message as MessageContent) || "").trim();
    const isGroup = transportJid.endsWith("@g.us");
    const senderName =
      msg.pushName || msg.key?.participant || msg.key?.remoteJid;

    if (!isGroup) {
      console.log(
        "🔎 [FLOW 4.3] Direct chat detected, trying PN->LID lookup with onWhatsApp once.",
      );
      await hydratePnLidMapping(
        sock,
        transportJid,
        lidToPnMap,
        pnToLidMap,
        pnLookupAttempted,
      );
    }

    console.log("🧩 [FLOW 4.4] Computing canonicalUserId.");
    const canonicalUserId = isGroup
      ? transportJid
      : resolveCanonicalUserId(transportJid, lidToPnMap);

    // For group chat, try to fetch readable group subject.
    let chatName = transportJid;
    if (isGroup) {
      try {
        const group = await sock.groupMetadata(transportJid);
        chatName = group?.subject || transportJid;
      } catch {
        // Ignore metadata errors.
      }
    }

    // Logs are intentionally clear for debugging/demo.
    console.log("📩 Incoming message");
    console.log("From:", senderName);
    console.log("Chat:", chatName);
    console.log("Transport JID:", transportJid);
    console.log("Canonical User:", canonicalUserId);
    console.log("🪪 [FLOW 4.5] Debug IDs logged (Transport + Canonical).");
    console.log("isGroup:", isGroup);
    console.log("Body:", text || "[non-text]");
    console.log("============================================");

    console.log("↩️ [FLOW 4.6] Routing to command handler (replies use transportJid).");
    await handleMessageCommand({
      sock,
      msg,
      transportJid,
      canonicalUserId,
      pnToLidMap,
      text,
    });
  });
}

start().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
