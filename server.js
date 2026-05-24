import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Modules import
import { 
  initializeWhatsApp, 
  getConnectionStatus, 
  getQrCode, 
  logoutWhatsApp, 
  sendWhatsAppMessage, 
  getLogs as getWhatsAppLogs,
  registerMessageCallback
} from './whatsapp.js';
import { getScraperStatus, scrapeGoogleMapsLeads } from './scraper.js';
import { getEmailLogs, sendTestEmail, sendColdEmail } from './email.js';
import { 
  startScheduler, 
  stopScheduler, 
  getSchedulerStatus, 
  getSchedulerLogs, 
  triggerLeadAutomation,
  buildWhatsAppDigest
} from './scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static dashboard files
app.use(express.static(path.join(__dirname, 'public')));

// Create default log file if not exists
if (!fs.existsSync('system.log')) {
  fs.writeFileSync('system.log', '[System] Log file initialized.\n');
}

function log(message) {
  const timestamp = new Date().toISOString();
  const logMsg = `[Server] [${timestamp}] ${message}`;
  console.log(logMsg);
  try {
    fs.appendFileSync('system.log', logMsg + '\n');
  } catch (err) {}
}

/**
 * API: System Status Overview
 */
app.get('/api/status', (req, res) => {
  const wsStatus = getConnectionStatus();
  const schedStatus = getSchedulerStatus();
  const scrapStatus = getScraperStatus();
  
  res.json({
    whatsapp: {
      status: wsStatus,
      hasQr: getQrCode() !== null
    },
    scheduler: schedStatus,
    scraper: scrapStatus
  });
});

/**
 * API: Fetch Scraped Leads
 */
app.get('/api/leads', (req, res) => {
  try {
    const leadsFile = path.join(__dirname, 'leads.json');
    if (fs.existsSync(leadsFile)) {
      const leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
      return res.json(leads);
    }
    res.json([]);
  } catch (err) {
    log(`Error reading leads: ${err.message}`);
    res.status(500).json({ error: 'Failed to retrieve leads database.' });
  }
});

/**
 * API: Update individual lead status / details
 */
app.put('/api/leads', (req, res) => {
  const { mapsUrl, status, notes } = req.body;
  if (!mapsUrl) {
    return res.status(400).json({ error: 'mapsUrl is required.' });
  }

  try {
    const leadsFile = path.join(__dirname, 'leads.json');
    if (!fs.existsSync(leadsFile)) {
      return res.status(404).json({ error: 'Leads database is empty.' });
    }

    const leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
    const index = leads.findIndex(l => l.mapsUrl === mapsUrl);

    if (index === -1) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    if (status !== undefined) leads[index].status = status;
    if (notes !== undefined) leads[index].notes = notes;

    fs.writeFileSync(leadsFile, JSON.stringify(leads, null, 2));
    res.json({ success: true, lead: leads[index] });
  } catch (err) {
    log(`Error updating lead: ${err.message}`);
    res.status(500).json({ error: 'Failed to update lead details.' });
  }
});

/**
 * API: Read Config.json
 */
app.get('/api/config', (req, res) => {
  try {
    const configFile = path.join(__dirname, 'config.json');
    if (fs.existsSync(configFile)) {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      // Remove SMTP password and Gemini key from client-facing reads for safety
      const safeConfig = JSON.parse(JSON.stringify(config));
      if (safeConfig.smtp && safeConfig.smtp.pass) {
        safeConfig.smtp.pass = '********'; // Mask password
      }
      if (safeConfig.geminiApiKey) {
        safeConfig.geminiApiKey = '********'; // Mask Gemini Key
      }
      return res.json(safeConfig);
    }
    res.status(404).json({ error: 'Configuration file missing.' });
  } catch (err) {
    log(`Error reading config: ${err.message}`);
    res.status(500).json({ error: 'Failed to read configuration.' });
  }
});

/**
 * API: Save Config.json
 */
app.post('/api/config', (req, res) => {
  try {
    const configFile = path.join(__dirname, 'config.json');
    let currentConfig = {};
    
    if (fs.existsSync(configFile)) {
      currentConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    }

    const newConfig = req.body;
    
    // Preserve old SMTP password if user didn't modify masked value
    if (newConfig.smtp && newConfig.smtp.pass === '********') {
      newConfig.smtp.pass = currentConfig.smtp ? currentConfig.smtp.pass : '';
    }

    // Preserve old Gemini key if user didn't modify masked value
    if (newConfig.geminiApiKey === '********') {
      newConfig.geminiApiKey = currentConfig.geminiApiKey ? currentConfig.geminiApiKey : '';
    }

    fs.writeFileSync(configFile, JSON.stringify(newConfig, null, 2));
    log('Configuration settings updated.');

    // Restart scheduler with new config timing
    startScheduler();
    
    res.json({ success: true, message: 'Configuration saved. Scheduler updated.' });
  } catch (err) {
    log(`Error saving config: ${err.message}`);
    res.status(500).json({ error: 'Failed to save configuration settings.' });
  }
});

/**
 * API: Get WhatsApp Login QR code image URL
 */
app.get('/api/whatsapp/qr', (req, res) => {
  const qr = getQrCode();
  const status = getConnectionStatus();
  res.json({ status, qr });
});

/**
 * API: Connect WhatsApp (Trigger Initialization)
 */
app.post('/api/whatsapp/login', (req, res) => {
  initializeWhatsApp();
  res.json({ success: true, message: 'WhatsApp initialization triggered.' });
});

/**
 * API: Logout WhatsApp
 */
app.post('/api/whatsapp/logout', async (req, res) => {
  try {
    await logoutWhatsApp();
    res.json({ success: true, message: 'WhatsApp session terminated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * API: Test WhatsApp Message
 */
app.post('/api/whatsapp/test', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ error: 'Destination number and message text are required.' });
  }

  try {
    await sendWhatsAppMessage(to, message);
    res.json({ success: true, message: 'Test message queued/delivered.' });
  } catch (err) {
    res.status(500).json({ error: `Failed to deliver message: ${err.message}` });
  }
});

/**
 * API: Test SMTP Setup
 */
app.post('/api/outreach/email/test', async (req, res) => {
  const { smtp, testEmail } = req.body;
  
  if (!testEmail || !smtp || !smtp.host || !smtp.user || !smtp.pass) {
    return res.status(400).json({ error: 'Destination email and complete SMTP credentials are required.' });
  }

  // Restore password if masked
  const configFile = path.join(__dirname, 'config.json');
  if (smtp.pass === '********' && fs.existsSync(configFile)) {
    const currentConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    smtp.pass = currentConfig.smtp ? currentConfig.smtp.pass : '';
  }

  try {
    const result = await sendTestEmail(smtp, testEmail);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: `SMTP Verification failed: ${err.message}` });
  }
});

/**
 * API: Manually trigger lead generation cycle immediately
 */
app.post('/api/trigger', (req, res) => {
  triggerLeadAutomation(true)
    .then(() => log('Manual scrape run completed.'))
    .catch((err) => log(`Manual scrape run crashed: ${err.message}`));
    
  res.json({ success: true, message: 'Lead scraper triggered. Check system logs for progress.' });
});

/**
 * API: Fetch Combined System Logs for console rendering
 */
app.get('/api/logs', (req, res) => {
  try {
    const systemLogPath = path.join(__dirname, 'system.log');
    let fileLogs = [];
    if (fs.existsSync(systemLogPath)) {
      const content = fs.readFileSync(systemLogPath, 'utf8');
      fileLogs = content.trim().split('\n').slice(-150); // Get last 150 lines
    }
    
    res.json({
      system: fileLogs,
      whatsapp: getWhatsAppLogs(),
      email: getEmailLogs(),
      scheduler: getSchedulerLogs()
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to compile logs.' });
  }
});

// Register WhatsApp incoming interactive message listener
registerMessageCallback(async (msg) => {
  // Read config to check if the message is from Nirbhay Kumar (configured number)
  let config = {};
  try {
    const configFile = path.join(__dirname, 'config.json');
    if (fs.existsSync(configFile)) {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    }
  } catch (err) {
    log(`Failed to read config in WhatsApp message callback: ${err.message}`);
    return;
  }

  const userPhone = config.whatsappNumber || '7717766958';
  let formattedUserPhone = userPhone.replace(/[^\d]/g, '');
  if (!formattedUserPhone.startsWith('91') && formattedUserPhone.length === 10) {
    formattedUserPhone = '91' + formattedUserPhone;
  }
  const userChatId = `${formattedUserPhone}@c.us`;

  // Strict check: only respond if the message is from Nirbhay Kumar's configured number OR if it's sent directly from the bot phone (Message Yourself / fromMe)
  const isFromAuthorizedUser = msg.from === userChatId || msg.fromMe === true;
  if (!isFromAuthorizedUser) {
    log(`Message ignored (not from Nirbhay's configured number: ${userChatId} and not fromMe)`);
    return;
  }

  // Ignore status broadcasts, media captions, or automatic digests to prevent recursive loops
  if (!msg.body || msg.body.length > 50 || msg.from.includes('broadcast')) {
    return;
  }

  const text = msg.body.trim().toLowerCase();

  // Clean summon name and punctuation for accurate command matching
  let cleanText = text.replace(/jordan/g, '').trim().replace(/^[\s,.\?!;:]+|[\s,.\?!;:]+$/g, '');
  if (cleanText === '') {
    cleanText = 'hello'; // Default to greeting if empty
  }

  const leadsRegex = /(\w+)\s+leads?\s+(?:from|in|at)\s+([a-zA-Z\s]+)/i;
  const match = cleanText.match(leadsRegex);

  if (match) {
    const customKeyword = match[1].trim();
    const customLocation = match[2].trim();
    log(`Interactive WhatsApp command: Nirbhay requested dynamic leads for "${customKeyword}" in "${customLocation}"!`);

    // Reply immediately using Jordan's persona
    await msg.reply(`Acknowledged, Nirbhay Sir! 🚀 Your agent Jordan is in your service, Sir!\n\nI have parsed your request:\n🎯 *Target Niche*: ${customKeyword}\n📍 *Target Location*: ${customLocation}\n\nStarting my Puppeteer engine to search Google Maps immediately. I will send you the lead digest and auto-email proposals as soon as it's completed! (Typically takes 2-4 minutes).`);

    // Run custom scraping and outreach in background
    (async () => {
      try {
        const leads = await scrapeGoogleMapsLeads(customKeyword, customLocation, 10);
        
        if (leads.length === 0) {
          await sendWhatsAppMessage(userPhone, `Your agent Jordan is in your service, Nirbhay Sir! 👋\n\nI completed my scrape run for *${customKeyword}* in *${customLocation}*, but found *0 new listings*. Try another category!`);
          return;
        }

        // Auto cold email outreach in background
        let emailsSent = 0;
        for (const lead of leads) {
          if (lead.email) {
            try {
              const sent = await sendColdEmail(lead);
              if (sent) emailsSent++;
            } catch (err) {
              log(`Failed custom email outreach to ${lead.name}: ${err.message}`);
            }
          }
        }

        // Filter high potential leads for WhatsApp
        const highPotential = leads.filter(lead => lead.isHighPotential);

        // Build customized digest and send
        const digestMsg = buildWhatsAppDigest(customLocation, leads, highPotential, emailsSent);
        await sendWhatsAppMessage(userPhone, digestMsg);

      } catch (err) {
        log(`Interactive custom scrape failed: ${err.message}`);
        await sendWhatsAppMessage(userPhone, `Your agent Jordan is in your service, Nirbhay Sir! ⚠️ An error occurred during custom lead generation: ${err.message}`);
      }
    })();

  } else if (cleanText.includes('give leads') || cleanText.includes('leads') || cleanText.includes('scrape')) {
    log('Interactive WhatsApp command: Nirbhay requested instant leads generation!');
    
    // Reply immediately using Jordan's persona
    await msg.reply(`Acknowledged, Nirbhay Sir! 🚀 Your agent Jordan is in your service, Sir!\n\nI am starting the Google Maps scraper right now to search for high-potential website development clients in your active target location: *${config.locations[config.currentLocationIndex % config.locations.length]}*.\n\nI will send you the complete daily digest as soon as the run is completed! (This typically takes 2-4 minutes).`);

    // Trigger lead automation immediately in background
    triggerLeadAutomation(true)
      .then(() => log('Interactive manual scrape run completed.'))
      .catch((err) => log(`Interactive manual scrape run crashed: ${err.message}`));

  } else if (cleanText.includes('send email') || cleanText.includes('email') || cleanText.includes('mail') || cleanText.includes('outreach')) {
    log('Interactive WhatsApp command: Nirbhay requested outstanding cold email outreach!');
    
    let leads = [];
    try {
      const leadsFile = path.join(__dirname, 'leads.json');
      if (fs.existsSync(leadsFile)) {
        leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
      }
    } catch (err) {
      log(`Failed to read leads: ${err.message}`);
    }

    const pendingEmails = leads.filter(lead => lead.email && !lead.emailSent);

    if (pendingEmails.length === 0) {
      await msg.reply(`Your agent Jordan is in your service, Nirbhay Sir! I checked your database and found *0 leads* with pending cold email outreach. All available email contacts are fully up to date! ✉️`);
      return;
    }

    await msg.reply(`Acknowledged, Nirbhay Sir! ✉️ Your agent Jordan is in your service, Sir!\n\nI found *${pendingEmails.length} leads* with unsent emails in your database. Starting automated cold email outreach pitching *90skids.digital* now...\n\nI will notify you once all emails are processed.`);

    // Run emails asynchronously in background
    (async () => {
      let sentCount = 0;
      for (const lead of pendingEmails) {
        try {
          const sent = await sendColdEmail(lead);
          if (sent) sentCount++;
        } catch (e) {
          log(`Failed interactive email outreach to ${lead.name}: ${e.message}`);
        }
      }
      await sendWhatsAppMessage(userPhone, `✉️ *Email Campaign Completed, Nirbhay Sir!* \n\nSuccessfully sent cold email proposals to *${sentCount} / ${pendingEmails.length}* new leads in your database.\n\nYour agent Jordan is in your service, Sir! Reply *'jordan status'* to check overall agent health.`);
    })();

  } else if (cleanText.includes('status') || cleanText.includes('info') || cleanText.includes('health')) {
    const wsStatus = getConnectionStatus();
    const schedStatus = getSchedulerStatus();
    const scrapStatus = getScraperStatus();
    const activeLoc = config.locations[config.currentLocationIndex % config.locations.length];

    const statusMsg = `🤖 *Jordan - 90skids.digital Agent Status* 🤖\n\n` +
      `Your agent Jordan is in your service, Nirbhay Sir!\n\n` +
      `🟢 *WhatsApp Client*: ${wsStatus}\n` +
      `📅 *Scheduler Engine*: ${schedStatus.isScheduled ? 'Active (9:00 AM Daily)' : 'Suspended'}\n` +
      `📍 *Active Location Target*: ${activeLoc}\n` +
      `📊 *Scraper Status*: ${scrapStatus.status}\n` +
      `📈 *Total Scraped Database*: ${fs.existsSync(path.join(__dirname, 'leads.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'leads.json'), 'utf8')).length : 0} leads\n\n` +
      `*Commands you can send:*\n` +
      `• *jordan give leads now* - Scrapes current target immediately.\n` +
      `• *jordan send emails now* - Sends emails to pending leads.\n` +
      `• *jordan status* - Shows this status message.`;
    
    await msg.reply(statusMsg);

  } else if (cleanText === 'jordan' || cleanText === 'help' || cleanText === 'hi' || cleanText === 'hello' || cleanText === 'hlw' || cleanText === 'hey') {
    const welcomeMsg = `Your agent Jordan is in your service, Nirbhay Sir! 🤵‍♂️👋\n\n` +
      `I am *Jordan*, your assistant for lead scraping and cold emailing. I am always ready to help you!\n\n` +
      `*Here is what I can do for you:*\n\n` +
      `🚀 *1. [jordan give leads now]*\n` +
      `Scrapes Google Maps for local businesses without websites and starts emailing them immediately.\n\n` +
      `✉️ *2. [jordan send emails now]*\n` +
      `Sends cold emails to any remaining leads in your list.\n\n` +
      `📊 *3. [jordan status]*\n` +
      `Checks if I am online, my active target city, and total leads.\n\n` +
      `💡 *4. [Daily Auto-Run]*\n` +
      `I will automatically scrape and send your leads digest every morning at *9:00 AM*.\n\n` +
      `*Simply reply with 'jordan give leads now', 'jordan send emails now', or 'jordan status' and I will start immediately, Nirbhay Sir!*`;
      
    await msg.reply(welcomeMsg);
  } else {
    // conversational AI Brain - Jordan replies intelligently & wittily!
    log(`Jordan processing general conversational message from Nirbhay Sir: "${msg.body}"`);
    
    // Check if Gemini API Key is configured
    if (config.geminiApiKey && config.geminiApiKey !== "") {
      try {
        let response;
        let retries = 2;
        let delayMs = 1500;
        
        while (retries >= 0) {
          response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${config.geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [{
                  text: "System Prompt: You are Jordan, a helpful, polite, and loyal personal butler and AI assistant for Nirbhay Sir (founder of the web and app development agency 90skids.digital). Greet him as 'Nirbhay Sir' with high respect and loyalty, maintaining a loyal, polite, and clever butler persona. Keep your responses in simple, clear, and plain English that is very easy to read on WhatsApp. Keep your answers brief and punchy (1-2 sentences max). Never talk about API keys, the Gemini API, Google, tech specifications, or your 'brain' or 'silicon brain'. Add a touch of wit and local Bihar business/GMB humor where appropriate.\n\nUser Question: " + msg.body
                }]
              }]
            })
          });

          if (response.ok) {
            const data = await response.json();
            const aiReply = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (aiReply) {
              await msg.reply(aiReply.trim());
              return;
            }
          }

          const errText = await response.text();
          log(`Gemini API returned error status ${response.status}: ${errText}`);
          
          if (response.status === 503 || response.status === 429) {
            log(`Transient Gemini error (${response.status}). Retrying in ${delayMs}ms... (Retries left: ${retries})`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            retries--;
            delayMs *= 2; // exponential backoff
          } else {
            break; // Don't retry for fatal errors like 400 (Bad Request) or 403 (Invalid Key)
          }
        }
        
        log('Gemini API call failed or returned empty after retries. Falling back to built-in responses.');
      } catch (err) {
        log(`Failed calling Gemini API: ${err.message}`);
      }
    }

    // Built-in respectful and simple responses if no API Key is linked yet
    const query = text.toLowerCase();
    let replyText = "";

    if (query.includes('joke') || query.includes('funny') || query.includes('laugh')) {
      replyText = "Why did the local doctor close his clinic, Nirbhay Sir? Because patients couldn't find his address online! If only he had hired 90skids.digital to build his website! 😂🤵‍♂️";
    } else if (query.includes('smart') || query.includes('intelligent') || query.includes('ai') || query.includes('genius')) {
      replyText = "Thank you, Nirbhay Sir! I am always working hard to help you grow 90skids.digital. Your success is my goal! 🤵‍♂️";
    } else if (query.includes('strategy') || query.includes('marketing') || query.includes('business') || query.includes('sell')) {
      replyText = "Nirbhay Sir, businesses without websites are losing local customers every day. Let's find them and build modern websites for them! 🚀";
    } else if (query.includes('who are you') || query.includes('your name') || query.includes('jordan')) {
      replyText = "Your agent Jordan is in your service, Nirbhay Sir! 🤵‍♂️ I am here to help you get leads and manage your cold email outreach.";
    } else {
      replyText = "Your agent Jordan is in your service, Nirbhay Sir! 🤵‍♂️ Let me know how I can help you today. I can scrape GMB leads, send cold emails, or check status!";
    }

    await msg.reply(replyText);
  }
});

// Start Express server and initialize core modules
app.listen(PORT, '0.0.0.0', () => {
  log(`90skids.digital Lead Automation Server is active!`);
  log(`Dashboard is available at: http://localhost:${PORT}`);
  
  // Auto-start modules
  initializeWhatsApp();
  startScheduler();
});
