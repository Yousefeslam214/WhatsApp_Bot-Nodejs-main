import qrcode from 'qrcode-terminal';
import pino from 'pino';
import makeWASocket, {
  BinaryInfo,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';

// Auth data will be saved here after QR login.
const AUTH_FOLDER = './baileys_auth';

// Simple greeting messages (no command prefix needed).
const GREETINGS = new Set(['hi', 'hi bot']);

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
 * Extract text from common WhatsApp message types.
 * This keeps command handling focused on one plain string.
 */
function getMessageText(message?: MessageContent | null): string | null {
  if (!message) return null;
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  return null;
}

/**
 * Convert a phone number into WhatsApp JID format.
 * Example: 201234567890 -> 201234567890@s.whatsapp.net
 */
function normalizeTargetJid(target: string): string | null {
  if (!target) return null;
  if (target.includes('@')) return target;

  const digitsOnly = target.replace(/\D/g, '');
  if (!digitsOnly) return null;

  return `${digitsOnly}@s.whatsapp.net`;
}

/**
 * Handle all bot commands in one place.
 */
async function handleMessageCommand({ sock, msg, remoteJid, text }: CommandContext): Promise<void> {
  const normalizedText = text.trim();
  if (!normalizedText) return;

  const lowerText = normalizedText.toLowerCase();
  if (GREETINGS.has(lowerText)) {
    await sock.sendMessage(remoteJid, { text: 'hello' }, { quoted: msg });
    return;
  }

  const [rawCommand, ...args] = normalizedText.split(/\s+/);
  const command = rawCommand.toLowerCase();

  switch (command) {
    case '.hello':
      await sock.sendMessage(remoteJid, { text: 'Hello Too 👋' }, { quoted: msg });
      return;

    case '.test':
      await sock.sendMessage(remoteJid, { text: 'Testing...' }, { quoted: msg });
      return;

    case '.howreu':
      await sock.sendMessage(remoteJid, { text: 'Im Fine' }, { quoted: msg });
      return;

    case '.send':
    case '.sendmsg': {
      if (args.length < 2) {
        await sock.sendMessage(
          remoteJid,
          { text: 'Usage: .sendmsg <number|jid> <message>' },
          { quoted: msg }
        );
        return;
      }

      const targetRaw = args[0];
      const targetJid = normalizeTargetJid(targetRaw);
      const outgoingText = args.slice(1).join(' ').trim();

      if (!targetJid || !outgoingText) {
        await sock.sendMessage(
          remoteJid,
          { text: 'Usage: .sendmsg <number|jid> <message>' },
          { quoted: msg }
        );
        return;
      }

      try {
        await sock.sendMessage(targetJid, { text: outgoingText });
        await sock.sendMessage(
          remoteJid,
          { text: `Message sent to ${targetJid}` },
          { quoted: msg }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        await sock.sendMessage(
          remoteJid,
          { text: `Failed to send message: ${message}` },
          { quoted: msg }
        );
      }
      return;
    }

    case '.binaryinfo': {
      const info = new BinaryInfo({
        sequence: 1,
        events: [{ exampleEvent: { props: {}, globals: {} } }]
      });

      await sock.sendMessage(
        remoteJid,
        {
          text:
            `BinaryInfo => protocolVersion=${info.protocolVersion}, ` +
            `sequence=${info.sequence}, events=${info.events.length}, buffer=${info.buffer.length}`
        },
        { quoted: msg }
      );
      return;
    }

    default:
      // Unknown command: ignore to keep bot behavior simple.
      return;
  }
}

/**
 * Start bot connection and register listeners.
 */
async function start(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('BotWA'),
    printQRInTerminal: false
  });

  // Save credentials whenever WhatsApp updates session tokens.
  sock.ev.on('creds.update', saveCreds);

  // Monitor connection states (QR, open, close).
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('📸 Scan this QR to login:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('✅ Bot is connected and ready.');
      return;
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect as any)?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(
        `⚠️ Connection closed (${isLoggedOut ? 'logged out' : 'disconnected'}).`
      );

      if (isLoggedOut) {
        console.log(`Delete ${AUTH_FOLDER} and scan QR again.`);
        return;
      }

      // Auto reconnect on temporary disconnects.
      start().catch(err => console.error('Reconnect failed:', err));
    }
  });

  // Main incoming message event.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    const msg = messages?.[0] as any;
    if (!msg?.message) return;

    const remoteJid = msg.key?.remoteJid as string | undefined;
    if (!remoteJid || msg.key?.fromMe || remoteJid === 'status@broadcast') return;

    const text = (getMessageText(msg.message as MessageContent) || '').trim();
    const isGroup = remoteJid.endsWith('@g.us');
    const senderName = msg.pushName || msg.key?.participant || msg.key?.remoteJid;

    let chatName = remoteJid;
    if (isGroup) {
      try {
        const group = await sock.groupMetadata(remoteJid);
        chatName = group?.subject || remoteJid;
      } catch {
        // Ignore metadata errors and continue.
      }
    }

    // Console logs help your team see each incoming event clearly.
    console.log('📩 Incoming message');
    console.log('From:', senderName);
    console.log('Chat:', chatName);
    console.log('isGroup:', isGroup);
    console.log('Body:', text || '[non-text]');
    console.log('============================================');

    await handleMessageCommand({ sock, msg, remoteJid, text });
  });
}

start().catch(err => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});
