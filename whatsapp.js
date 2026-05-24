import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';

let client = null;
let qrCodeImage = null;
let connectionStatus = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, QR_READY, AUTHENTICATING, CONNECTED
let logs = [];

function log(message) {
  const timestamp = new Date().toISOString();
  const logMsg = `[WhatsApp] [${timestamp}] ${message}`;
  console.log(logMsg);
  logs.push(logMsg);
  if (logs.length > 500) logs.shift();
  // Append to a general log file
  try {
    fs.appendFileSync('system.log', logMsg + '\n');
  } catch (err) {
    // Ignore log write errors
  }
}

export function getLogs() {
  return logs;
}

export function getConnectionStatus() {
  return connectionStatus;
}

export function getQrCode() {
  return qrCodeImage;
}

export async function initializeWhatsApp() {
  if (client) {
    log('WhatsApp client already initialized or initializing...');
    return;
  }

  log('Initializing WhatsApp Web client with LocalAuth...');
  connectionStatus = 'CONNECTING';
  qrCodeImage = null;

  try {
    const puppeteerArgs = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-backgrounding-occluded-windows',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ],
      dumpio: true // Pipe browser logs to node process for diagnostic transparency in Render console
    };

    // If running in cloud Docker container, use pre-installed Chrome path
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      puppeteerArgs.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      log(`Using custom Puppeteer executable path: ${puppeteerArgs.executablePath}`);
    }

    client = new Client({
      authStrategy: new LocalAuth({
        dataPath: path.join(process.cwd(), '.wwebjs_auth')
      }),
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html'
      },
      puppeteer: puppeteerArgs
    });

    client.on('qr', (qr) => {
      log('QR Code received, generating image...');
      connectionStatus = 'QR_READY';
      // Convert QR code to base64 DataURL so it can be rendered on the dashboard
      qrcode.toDataURL(qr, (err, url) => {
        if (err) {
          log(`Failed to generate QR Data URL: ${err.message}`);
          return;
        }
        qrCodeImage = url;
        log('QR Code generated. Please scan it on the dashboard or terminal.');
        
        // Print QR code in terminal using a simple console fallback
        console.log('\n--- SCAN THIS QR CODE ON YOUR DASHBOARD TO CONNECT --- \n');
      });
    });

    client.on('ready', () => {
      log('WhatsApp client is ready and connected!');
      connectionStatus = 'CONNECTED';
      qrCodeImage = null;
    });

    client.on('authenticated', () => {
      log('Authenticated successfully!');
      connectionStatus = 'AUTHENTICATING';
      qrCodeImage = null;
    });

    client.on('auth_failure', (msg) => {
      log(`Authentication failure: ${msg}`);
      connectionStatus = 'DISCONNECTED';
      qrCodeImage = null;
      client = null;
    });

    client.on('disconnected', (reason) => {
      log(`Client was disconnected: ${reason}`);
      connectionStatus = 'DISCONNECTED';
      qrCodeImage = null;
      client = null;
    });

    client.on('message_create', async (msg) => {
      log(`Incoming message from ${msg.from}: "${msg.body}"`);
      if (onMessageReceivedCallback) {
        try {
          await onMessageReceivedCallback(msg);
        } catch (err) {
          log(`Error handling message: ${err.message}`);
        }
      }
    });

    log('Triggering client.initialize()...');
    client.initialize().catch((err) => {
      log(`CRITICAL: client.initialize() rejected with error: ${err.message}`);
      console.error(err);
      connectionStatus = 'DISCONNECTED';
      client = null;
    });
  } catch (error) {
    log(`Initialization error: ${error.message}`);
    connectionStatus = 'DISCONNECTED';
    client = null;
  }
}

let onMessageReceivedCallback = null;

export function registerMessageCallback(callback) {
  onMessageReceivedCallback = callback;
}

export async function sendWhatsAppMessage(to, message) {
  if (connectionStatus !== 'CONNECTED' || !client) {
    throw new Error('WhatsApp client is not connected. Unable to send message.');
  }

  // Format to international standard without '+' and with '@c.us' suffix
  let formattedNumber = to.replace(/[^\d]/g, '');
  if (!formattedNumber.startsWith('91') && formattedNumber.length === 10) {
    formattedNumber = '91' + formattedNumber; // Default to India country code
  }
  const chatId = `${formattedNumber}@c.us`;

  log(`Sending message to ${chatId}...`);
  try {
    const response = await client.sendMessage(chatId, message);
    log('Message sent successfully!');
    return response;
  } catch (error) {
    log(`Failed to send message: ${error.message}`);
    throw error;
  }
}

export async function logoutWhatsApp() {
  if (client) {
    try {
      log('Logging out from WhatsApp session...');
      await client.logout();
      client = null;
      connectionStatus = 'DISCONNECTED';
      qrCodeImage = null;
      log('Logged out successfully.');
    } catch (err) {
      log(`Error during logout: ${err.message}`);
      client = null;
      connectionStatus = 'DISCONNECTED';
      qrCodeImage = null;
    }
  }
}
