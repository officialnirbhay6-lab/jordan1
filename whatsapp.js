import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';

let client = null;
let qrCodeImage = null;
let connectionStatus = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, QR_READY, AUTHENTICATING, CONNECTED
let logs = [];
let isInitializing = false; // Semaphore to block race conditions during async initialization

function log(message) {
  const timestamp = new Date().toISOString();
  const logMsg = `[WhatsApp] [${timestamp}] ${message}`;
  console.log(logMsg);
  logs.push(logMsg);
  if (logs.length > 500) logs.shift();
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

/**
 * Fully cleans up and shuts down the active client instance and Puppeteer browser
 */
export async function cleanupClient() {
  if (client) {
    log('Cleaning up old WhatsApp client instance...');
    try {
      // Remove all listener callbacks to prevent multi-event trigger leakages
      client.removeAllListeners();
      await client.destroy();
      log('Old WhatsApp client browser process destroyed successfully.');
    } catch (err) {
      log(`Error during client browser process cleanup: ${err.message}`);
    }
    client = null;
  }
}

/**
 * Recursively searches and deletes lingering Chrome SingletonLock files
 * to prevent Puppeteer from hanging indefinitely in Docker containers.
 */
function removeSingletonLocks(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return;
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      if (fs.statSync(fullPath).isDirectory()) {
        removeSingletonLocks(fullPath);
      } else if (file === 'SingletonLock') {
        log(`Found lingering Chrome lock: ${fullPath}. Removing it...`);
        fs.unlinkSync(fullPath);
        log(`Lingering Chrome lock removed successfully.`);
      }
    }
  } catch (err) {
    log(`Warning: Failed to clean up SingletonLock files: ${err.message}`);
  }
}

export async function initializeWhatsApp() {
  if (isInitializing) {
    log('WhatsApp initialization is already in progress. Skipping.');
    return;
  }

  if (client) {
    log('WhatsApp client already initialized.');
    return;
  }

  log('Initializing WhatsApp Web client with LocalAuth...');
  connectionStatus = 'CONNECTING';
  qrCodeImage = null;
  isInitializing = true;

  try {
    const puppeteerArgs = {
      headless: true,
      protocolTimeout: 0, // Disables internal timeouts to prevent Runtime.callFunctionOn timeouts
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-default-apps',
        '--no-default-browser-check',
        '--mute-audio',
        '--disable-backgrounding-occluded-windows',
        '--disable-blink-features=AutomationControlled', // Hides Puppeteer webdriver automation indicator
        '--js-flags="--max-old-space-size=120"' // Restricts V8 JS memory footprint to keep it extremely lightweight
      ],
      dumpio: true // Pipe browser logs to node process console for diagnostic transparency
    };

    // If running in cloud environment, use pre-installed Chrome executable path
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      puppeteerArgs.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      log(`Using custom Puppeteer executable path: ${puppeteerArgs.executablePath}`);
    }

    // Programmatically clear any lingering SingletonLock files inside the session folder
    const authPath = path.join(process.cwd(), '.wwebjs_auth');
    removeSingletonLocks(authPath);

    client = new Client({
      authStrategy: new LocalAuth({
        dataPath: path.join(process.cwd(), '.wwebjs_auth')
      }),
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html'
      },
      puppeteer: puppeteerArgs,
      // STEALTH OPTION: Mask User-Agent to match standard desktop Chrome to completely prevent auto-logouts
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });

    client.on('qr', (qr) => {
      log('QR Code received, generating image...');
      connectionStatus = 'QR_READY';
      qrcode.toDataURL(qr, (err, url) => {
        if (err) {
          log(`Failed to generate QR Data URL: ${err.message}`);
          return;
        }
        qrCodeImage = url;
        log('QR Code generated successfully.');
        console.log('\n--- SCAN THIS QR CODE ON YOUR DASHBOARD TO CONNECT --- \n');
      });
    });

    client.on('ready', () => {
      log('WhatsApp client is ready and connected!');
      connectionStatus = 'CONNECTED';
      qrCodeImage = null;
      isInitializing = false;
    });

    client.on('authenticated', () => {
      log('Authenticated successfully!');
      connectionStatus = 'AUTHENTICATING';
      qrCodeImage = null;
    });

    client.on('auth_failure', async (msg) => {
      log(`Authentication failure: ${msg}`);
      connectionStatus = 'DISCONNECTED';
      qrCodeImage = null;
      isInitializing = false;
      await cleanupClient();
    });

    client.on('disconnected', async (reason) => {
      log(`Client was disconnected: ${reason}`);
      connectionStatus = 'DISCONNECTED';
      qrCodeImage = null;
      isInitializing = false;
      await cleanupClient();
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
    client.initialize().catch(async (err) => {
      log(`CRITICAL: client.initialize() rejected with error: ${err.message}`);
      connectionStatus = 'DISCONNECTED';
      isInitializing = false;
      await cleanupClient();
    });
  } catch (error) {
    log(`Initialization error: ${error.message}`);
    connectionStatus = 'DISCONNECTED';
    isInitializing = false;
    await cleanupClient();
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
      log('Logged out successfully.');
    } catch (err) {
      log(`Error during logout: ${err.message}`);
    }
    await cleanupClient();
    connectionStatus = 'DISCONNECTED';
    qrCodeImage = null;
  }
}
