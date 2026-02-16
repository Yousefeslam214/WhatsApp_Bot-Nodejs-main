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
  remoteJid: string;
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
 * Central command router.
 * Keep this function simple so new developers can add commands quickly.
 */
async function handleMessageCommand({
  sock,
  msg,
  remoteJid,
  text,
}: CommandContext): Promise<void> {
  const normalizedText = text.trim();
  if (!normalizedText) return;

  // Basic greeting flow.
  const lowerText = normalizedText.toLowerCase();
  if (GREETINGS.has(lowerText)) {
    await sock.sendMessage(remoteJid, { text: "hello" }, { quoted: msg });
    return;
  }

  // Command parsing: first word = command, rest = args.
  const [rawCommand, ...args] = normalizedText.split(/\s+/);
  const command = rawCommand.toLowerCase();

  switch (command) {
    case ".hello":
      await sock.sendMessage(
        remoteJid,
        { text: "Hello Too 👋" },
        { quoted: msg },
      );
      return;

    case ".test":
      await sock.sendMessage(
        remoteJid,
        { text: "Testing..." },
        { quoted: msg },
      );
      return;

    case ".howreu":
      await sock.sendMessage(remoteJid, { text: "Im Fine" }, { quoted: msg });
      return;

    case ".send":
    case ".sendmsg": {
      // Expected format: .sendmsg <number|jid> <message>
      if (args.length < 2) {
        await sock.sendMessage(
          remoteJid,
          { text: SEND_USAGE },
          { quoted: msg },
        );
        return;
      }

      const targetRaw = args[0];
      const targetJid = normalizeTargetJid(targetRaw);
      const outgoingText = args.slice(1).join(" ").trim();

      if (!targetJid || !outgoingText) {
        await sock.sendMessage(
          remoteJid,
          { text: SEND_USAGE },
          { quoted: msg },
        );
        return;
      }

      try {
        await sock.sendMessage(targetJid, { text: outgoingText });
        await sock.sendMessage(
          remoteJid,
          { text: `Message sent to ${targetJid}` },
          { quoted: msg },
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        await sock.sendMessage(
          remoteJid,
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
        remoteJid,
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
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

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

  // Persist auth updates to disk.
  sock.ev.on("creds.update", saveCreds);

  // Connection status listener.
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("📸 Scan this QR to login:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ Bot is connected and ready.");
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

    const msg = messages?.[0] as any;
    if (!msg?.message) return;

    const remoteJid = msg.key?.remoteJid as string | undefined;

    // Ignore invalid, self, and status messages.
    if (!remoteJid || msg.key?.fromMe || remoteJid === "status@broadcast")
      return;

    const text = (getMessageText(msg.message as MessageContent) || "").trim();
    const isGroup = remoteJid.endsWith("@g.us");
    const senderName =
      msg.pushName || msg.key?.participant || msg.key?.remoteJid;

    // For group chat, try to fetch readable group subject.
    let chatName = remoteJid;
    if (isGroup) {
      try {
        const group = await sock.groupMetadata(remoteJid);
        chatName = group?.subject || remoteJid;
      } catch {
        // Ignore metadata errors.
      }
    }

    // Logs are intentionally clear for debugging/demo.
    console.log("📩 Incoming message");
    console.log("From:", senderName);
    console.log("Chat:", chatName);
    console.log("isGroup:", isGroup);
    console.log("Body:", text || "[non-text]");
    console.log("============================================");

    await handleMessageCommand({ sock, msg, remoteJid, text });
  });
}

start().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
