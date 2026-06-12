const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const { Redis } = require('@upstash/redis');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Redirect root to dashboard
app.get('/', (req, res) => {
  res.redirect('/dashboard.html');
});

// Global state for in-memory tracker & SSE
let activeClients = [];
let currentScraperRun = {
  active: false,
  progress: 0,
  city: '',
  keyword: '',
  startedAt: null,
  status: 'Idle',
  resultsCount: 0
};
let scheduledTask = null;

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
let supabase = null;

if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false }
  });
}

// Initialize Upstash Redis Client
let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN
  });
}

// Default fallback settings
const DEFAULT_SETTINGS = {
  resend_api_key: process.env.RESEND_API_KEY || "",
  gemini_api_key: process.env.GEMINI_API_KEY || "",
  gemini_model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  smtp_host: "",
  smtp_port: "587",
  smtp_user: "",
  smtp_pass: "",
  email_subject: "Boost your sales online - 90's Kids Digital",
  email_body: "Hi {{businessName}},\n\nWe noticed your business in {{location}} is doing great, but you don't have a website yet! In today's digital era, having a website is super important.\n\nAapka business online presence scale up karne me hum help kar sakte hain. Let's build a stunning website and run local marketing ads for you.\n\nWarm regards,\nNirbhay Kumar\n90's Kids Digital",
  wa_template: "Hey {{businessName}}, this is Jordan from 90's Kids Digital. Humne dekha aapka {{category}} business solid chal raha hai in {{location}}, but online search visibility improve ki ja sakti hai. Aapka website link nahi mil raha. Let's scale it up? Reply if you're interested!",
  keywords: JSON.stringify(["clinic", "real estate agency", "hotel", "school", "coaching center", "hospital", "interior designer", "insurance agency", "travel agency", "CA firm", "law firm", "event planner", "gym", "salon", "restaurant"]),
  locations: JSON.stringify(["Bhagalpur, Bihar", "Patna, Bihar", "Ranchi, Jharkhand", "Kolkata, West Bengal", "Delhi NCR", "Mumbai, Maharashtra", "Bengaluru, Karnataka", "Pune, Maharashtra"]),
  active_location_index: "0",
  cron_time: "09:00",
  agency_name: process.env.AGENCY_NAME || "90's Kids Digital"
};

// Logger helper
async function logToAll(message, level = 'info') {
  const logObj = {
    message,
    level,
    timestamp: new Date().toISOString()
  };

  console.log(`[${level.toUpperCase()}] ${message}`);

  // Broadcast to SSE clients
  activeClients.forEach(client => {
    client.write(`data: ${JSON.stringify(logObj)}\n\n`);
  });

  // Save to Supabase (non-blocking)
  if (supabase) {
    supabase.from('logs').insert([{ message, level }]).then(({ error }) => {
      if (error) console.error("Error saving log to Supabase:", error.message);
    });
  }

  // Save to Upstash Redis cache (keep last 150 logs)
  if (redis) {
    try {
      await redis.lpush('jordan_live_logs', JSON.stringify(logObj));
      await redis.ltrim('jordan_live_logs', 0, 150);
    } catch (err) {
      console.error("Error saving log to Redis:", err.message);
    }
  }
}

// Retry helper
async function retryCall(fn, retries = 3, delay = 2000) {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 1) throw error;
    await new Promise(res => setTimeout(res, delay));
    return retryCall(fn, retries - 1, delay * 2);
  }
}

// Retrieve setting from database/redis/fallbacks
async function getSetting(key) {
  // Check Redis cache first
  if (redis) {
    try {
      const cached = await redis.get(`settings:${key}`);
      if (cached !== null) return cached;
    } catch (err) {
      console.error(`Redis get error for ${key}:`, err.message);
    }
  }

  // Check Supabase
  if (supabase) {
    try {
      const { data, error } = await supabase.from('settings').select('value').eq('key', key).single();
      if (!error && data) {
        const val = data.value;
        if (redis) {
          await redis.set(`settings:${key}`, val, { ex: 3600 }); // cache 1 hour
        }
        return val;
      }
    } catch (err) {
      console.error(`Supabase get error for ${key}:`, err.message);
    }
  }

  // Fallback to default
  return DEFAULT_SETTINGS[key] || "";
}

// Save setting helper
async function saveSetting(key, value) {
  if (supabase) {
    try {
      await supabase.from('settings').upsert({ key, value });
    } catch (err) {
      console.error(`Supabase save error for ${key}:`, err.message);
    }
  }

  if (redis) {
    try {
      await redis.set(`settings:${key}`, value);
    } catch (err) {
      console.error(`Redis save error for ${key}:`, err.message);
    }
  }
}

// Check database schema integrity
async function checkDatabaseSchema() {
  if (!supabase) {
    console.error("Supabase client not initialized.");
    return false;
  }
  try {
    const { error } = await supabase.from('settings').select('key').limit(1);
    if (error && error.message.includes("does not exist")) {
      return false;
    }
    return true;
  } catch (err) {
    return false;
  }
}

// Bootstrap settings
async function bootstrapSettings() {
  const schemaExists = await checkDatabaseSchema();
  if (!schemaExists) {
    console.warn("⚠️ Supabase tables appear to be missing. Please run schema.sql in your Supabase SQL Editor.");
    return;
  }

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    try {
      const { data, error } = await supabase.from('settings').select('value').eq('key', key).single();
      if (error || !data) {
        await supabase.from('settings').insert({ key, value });
        console.log(`Bootstrapped setting: ${key}`);
      }
    } catch (err) {
      console.error(`Error bootstrapping ${key}:`, err.message);
    }
  }
}

// Outreach: Green API (WhatsApp)
async function sendWhatsAppMessage(phone, text) {
  const url = `${process.env.GREEN_API_URL || "https://7107.api.greenapi.com"}/waInstance${process.env.GREEN_API_INSTANCE_ID}/sendMessage/${process.env.GREEN_API_TOKEN}`;
  
  // Format phone: remove non-digits, ensure country code is 91 for Indian leads if length is 10 digits
  let formattedPhone = phone.replace(/\D/g, '');
  if (formattedPhone.length === 10) {
    formattedPhone = '91' + formattedPhone;
  }
  
  const chatId = `${formattedPhone}@c.us`;

  const body = { chatId, message: text };

  return retryCall(async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Green API returned status ${response.status}: ${errorText}`);
    }
    return await response.json();
  });
}

// Outreach: Resend Email
async function sendResendEmail(to, subject, htmlBody, apiKey) {
  return retryCall(async () => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: "Jordan <onboarding@resend.dev>", // Or verified domain if set up
        to: [to],
        subject: subject,
        html: htmlBody
      })
    });
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Resend returned status ${res.status}: ${errorText}`);
    }
    return await res.json();
  });
}

// Outreach: SMTP Email Fallback
async function sendSMTPEmail(to, subject, textBody, config) {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: parseInt(config.port),
    secure: config.port == 465,
    auth: {
      user: config.user,
      pass: config.pass
    }
  });

  return retryCall(async () => {
    return await transporter.sendMail({
      from: config.user,
      to,
      subject,
      text: textBody
    });
  });
}

// AI Brain: Gemini Content Generation
async function generateAIPitch(businessName, category, location, key, model) {
  const prompt = `Write a personalized business sales pitch in Hinglish (Hindi + English blend) from Jordan, an expert digital growth strategist at 90's Kids Digital (Bhagalpur, Bihar). 
The pitch is for a local business named "${businessName}" which operates in the category "${category}" in "${location}".
Context: This business does not have a website. Show them why this is costing them customers in ${location} and how we can build a high-converting website and run local ads to boost sales.
Tone: Sharp, witty, culturally relevant to ${location}, energetic, professional yet friendly.
Provide the response strictly as a JSON object, with no markdown code blocks, no backticks, and no extra text. The output must parse directly as:
{
  "subject": "A catchy witty subject line",
  "body": "The email body, structured beautifully with spacing and paragraphs"
}`;

  return retryCall(async () => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || "gemini-2.5-flash"}:generateContent?key=${key}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json"
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API returned status ${response.status}: ${errText}`);
    }

    const resJson = await response.json();
    const rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
    return JSON.parse(rawText.trim());
  });
}

// Lead Scraper Workflow
async function runLeadScraper(city, selectedKeyword = null) {
  currentScraperRun.active = true;
  currentScraperRun.progress = 5;
  currentScraperRun.city = city;
  currentScraperRun.startedAt = new Date().toISOString();
  currentScraperRun.status = "Initializing";
  currentScraperRun.resultsCount = 0;

  await logToAll(`🚀 Jordan Lead Scraper started for location: ${city}`, 'info');

  try {
    const apifyToken = process.env.APIFY_TOKEN;
    if (!apifyToken) throw new Error("APIFY_TOKEN environment variable is missing.");

    // Retrieve keywords list
    const keywordsRaw = await getSetting('keywords');
    const keywords = selectedKeyword ? [selectedKeyword] : JSON.parse(keywordsRaw);
    
    currentScraperRun.keyword = selectedKeyword || "All Keywords";
    await logToAll(`Keywords to crawl: ${keywords.join(', ')}`, 'info');

    // Build search queries
    const searchQueries = keywords.map(kw => `${kw} in ${city}`);
    
    currentScraperRun.status = "Sending request to Apify";
    currentScraperRun.progress = 15;

    // Trigger Apify actor (compass/crawler-google-places)
    const runResponse = await fetch(`https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=${apifyToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        searchStringsArray: searchQueries,
        maxCrawledPlacesPerSearch: 20,
        language: "en"
      })
    });

    if (!runResponse.ok) {
      const errTxt = await runResponse.text();
      throw new Error(`Failed to start Apify crawl: ${errTxt}`);
    }

    const runData = await runResponse.json();
    const runId = runData.data?.id;
    const datasetId = runData.data?.defaultDatasetId;

    if (!runId || !datasetId) throw new Error("Apify run ID or dataset ID not received.");

    await logToAll(`Apify crawl started. Run ID: ${runId}. Polling every 5s...`, 'info');
    currentScraperRun.status = "Crawling Google Places";
    currentScraperRun.progress = 30;

    // Polling Apify run status (Max 3 mins)
    const startTime = Date.now();
    const timeoutMs = 3 * 60 * 1000;
    let finished = false;
    let attempts = 0;

    while (Date.now() - startTime < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      attempts++;

      const checkResponse = await fetch(`https://api.apify.com/v2/runs/${runId}?token=${apifyToken}`);
      if (!checkResponse.ok) continue;

      const checkData = await checkResponse.json();
      const status = checkData.data?.status;

      currentScraperRun.progress = Math.min(90, 30 + Math.floor((attempts * 5) / 180 * 60));
      await logToAll(`Crawl status: ${status} (Elapsed: ${Math.floor((Date.now() - startTime)/1000)}s)`, 'info');

      if (['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(status)) {
        if (status === 'SUCCEEDED') {
          finished = true;
        } else {
          throw new Error(`Apify crawl completed with status: ${status}`);
        }
        break;
      }
    }

    if (!finished) {
      throw new Error("Apify crawl timed out after 3 minutes.");
    }

    currentScraperRun.status = "Fetching results";
    currentScraperRun.progress = 92;
    await logToAll(`Fetching results from Apify dataset ${datasetId}...`, 'info');

    const itemsResponse = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}`);
    if (!itemsResponse.ok) throw new Error("Failed to fetch dataset items.");

    const items = await itemsResponse.json();
    await logToAll(`Retrieved ${items.length} items from Apify. Processing...`, 'info');

    // Save leads to Supabase
    let newLeadsCount = 0;
    let emailOutreachCount = 0;

    const resendKey = await getSetting('resend_api_key');
    const geminiKey = await getSetting('gemini_api_key');
    const geminiModel = await getSetting('gemini_model');
    const smtpHost = await getSetting('smtp_host');
    const smtpPort = await getSetting('smtp_port');
    const smtpUser = await getSetting('smtp_user');
    const smtpPass = await getSetting('smtp_pass');

    for (const item of items) {
      const phone = item.phoneUnformatted || item.phone;
      if (!phone) continue; // WhatsApp agent requires a phone number

      const businessName = item.title || item.name;
      const category = item.categoryName || item.subTitle || "Local Business";
      const website = item.website || "";
      const email = item.email || "";
      const rating = item.totalScore || item.stars || 0;
      const address = item.address || "";
      const hasWebsite = !!website;

      if (!supabase) continue;

      // Check if lead already exists in DB
      const { data: existingLead } = await supabase
        .from('leads')
        .select('phone, email_sent')
        .eq('phone', phone)
        .maybeSingle();

      if (existingLead) continue; // Deduped

      // Insert new lead
      const { error: insertError, data: insertedLead } = await supabase
        .from('leads')
        .insert([{
          business_name: businessName,
          category: category,
          location: city,
          phone: phone,
          website: website,
          email: email,
          rating: parseFloat(rating),
          address: address,
          has_website: hasWebsite,
          email_sent: false,
          wa_sent: false,
          notes: `Scraped in rotate for ${city}.`
        }])
        .select()
        .single();

      if (insertError) {
        console.error("Error inserting lead:", insertError.message);
        continue;
      }

      newLeadsCount++;

      // Outreach flow: Auto outreach for leads with email + no website
      if (email && !hasWebsite) {
        await logToAll(`Target identified: ${businessName} (Has Email, No Website). Generating AI pitch...`, 'info');
        let subject = await getSetting('email_subject');
        let body = await getSetting('email_body');

        // Personalize with Gemini
        let aiSuccess = false;
        if (geminiKey) {
          try {
            const pitch = await generateAIPitch(businessName, category, city, geminiKey, geminiModel);
            subject = pitch.subject;
            body = pitch.body;
            aiSuccess = true;
            await logToAll(`Gemini personal pitch generated for ${businessName}.`, 'success');
          } catch (aiErr) {
            await logToAll(`Gemini personalization failed for ${businessName}: ${aiErr.message}. Falling back to template.`, 'error');
          }
        }

        // Apply template placeholders if fallback is used
        if (!aiSuccess) {
          subject = subject.replace(/{{businessName}}/g, businessName).replace(/{{location}}/g, city).replace(/{{agencyName}}/g, "90's Kids Digital");
          body = body.replace(/{{businessName}}/g, businessName).replace(/{{location}}/g, city).replace(/{{agencyName}}/g, "90's Kids Digital");
        }

        // Send email
        let emailSentStatus = false;
        if (resendKey) {
          try {
            await sendResendEmail(email, subject, body.replace(/\n/g, '<br>'), resendKey);
            emailSentStatus = true;
            await logToAll(`Outreach email successfully sent to ${email} via Resend.`, 'success');
          } catch (emailErr) {
            await logToAll(`Resend failed: ${emailErr.message}. Trying SMTP fallback...`, 'error');
          }
        }

        // SMTP Fallback
        if (!emailSentStatus && smtpHost && smtpUser && smtpPass) {
          try {
            await sendSMTPEmail(email, subject, body, { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass });
            emailSentStatus = true;
            await logToAll(`Outreach email successfully sent to ${email} via SMTP fallback.`, 'success');
          } catch (smtpErr) {
            await logToAll(`SMTP fallback failed: ${smtpErr.message}. Email skipped.`, 'error');
          }
        }

        if (emailSentStatus) {
          await supabase.from('leads').update({ email_sent: true }).eq('id', insertedLead.id);
          emailOutreachCount++;
        }
      }
    }

    currentScraperRun.resultsCount = newLeadsCount;
    currentScraperRun.status = "Finished";
    currentScraperRun.progress = 100;

    await logToAll(`✅ Jordan Scraper Finished! Added ${newLeadsCount} new leads. Emailed ${emailOutreachCount} hot targets.`, 'success');

    // Send Daily WhatsApp Digest to Owner
    const ownerWa = process.env.WHATSAPP_OWNER || "917717766958";
    const appUrl = process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : `http://localhost:${PORT}`;
    const dateStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

    const digestMsg = `🎯 Jordan Report - ${dateStr}
📍 ${city} | 📊 New: ${newLeadsCount} | ⭐ Hot: ${emailOutreachCount} | 📧 Mailed: ${emailOutreachCount}
🔗 Dashboard: ${appUrl}`;

    try {
      await sendWhatsAppMessage(ownerWa, digestMsg);
      await logToAll(`WhatsApp daily digest sent to owner (${ownerWa}).`, 'success');
    } catch (waErr) {
      await logToAll(`Failed to send WhatsApp daily digest: ${waErr.message}`, 'error');
    }

  } catch (err) {
    currentScraperRun.status = "Failed";
    currentScraperRun.progress = 100;
    await logToAll(`❌ Scraper Run failed: ${err.message}`, 'error');
  } finally {
    setTimeout(() => {
      currentScraperRun.active = false;
    }, 10000); // Reset state after 10s
  }
}

// Scheduled Daily Task Rotation trigger
async function triggerDailyOutreachFlow() {
  await logToAll("⏰ Triggering daily scheduled lead outreach automation...", "info");
  
  // Rotate city
  const locationsRaw = await getSetting('locations');
  const locations = JSON.parse(locationsRaw);
  let activeIndex = parseInt(await getSetting('active_location_index')) || 0;

  // Select city
  const city = locations[activeIndex];

  // Rotate index for tomorrow
  const nextIndex = (activeIndex + 1) % locations.length;
  await saveSetting('active_location_index', nextIndex.toString());

  await logToAll(`Rotating location. Active city: ${city}. Next rotation city: ${locations[nextIndex]}`, "info");

  // Run scraper
  runLeadScraper(city);
}

// Setup or re-setup Cron job based on settings
async function initCronScheduler() {
  const cronTime = await getSetting('cron_time'); // format "09:00"
  const parts = cronTime.split(':');
  const hour = parts[0] || "9";
  const minute = parts[1] || "0";

  if (scheduledTask) {
    scheduledTask.stop();
  }

  // schedule cron expression: "minute hour * * *" (runs daily)
  const cronExpr = `${minute} ${hour} * * *`;
  scheduledTask = cron.schedule(cronExpr, () => {
    triggerDailyOutreachFlow();
  }, {
    timezone: "Asia/Kolkata"
  });

  console.log(`⏰ Cron scheduler initialized for daily runs at ${cronTime} (Asia/Kolkata). Express cron expression: "${cronExpr}"`);
}

// --- EXPRESS APP ROUTES ---

// Server-Sent Events (SSE) Route for live logging
app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  activeClients.push(res);

  // Send initial history from Redis list
  if (redis) {
    redis.lrange('jordan_live_logs', 0, 50).then(logs => {
      if (logs) {
        logs.reverse().forEach(logItem => {
          res.write(`data: ${logItem}\n\n`);
        });
      }
    }).catch(err => console.error("Error reading log history from Redis:", err.message));
  }

  req.on('close', () => {
    activeClients = activeClients.filter(client => client !== res);
  });
});

// Health endpoint
app.get('/health', async (req, res) => {
  const healthStatus = {
    whatsapp: 'unknown',
    apify: 'unknown',
    supabase: 'unknown',
    redis: 'unknown',
    scheduler: scheduledTask ? 'active' : 'inactive',
    lastRun: currentScraperRun.startedAt || 'never',
    currentRun: currentScraperRun
  };

  // Test Supabase
  if (supabase) {
    try {
      const start = Date.now();
      const { error } = await supabase.from('settings').select('key').limit(1);
      healthStatus.supabase = error ? 'error' : `connected (${Date.now() - start}ms)`;
    } catch {
      healthStatus.supabase = 'error';
    }
  } else {
    healthStatus.supabase = 'not_configured';
  }

  // Test Upstash Redis
  if (redis) {
    try {
      const ping = await redis.ping();
      healthStatus.redis = ping === 'PONG' ? 'connected' : 'error';
    } catch {
      healthStatus.redis = 'error';
    }
  } else {
    healthStatus.redis = 'not_configured';
  }

  // Test Green API
  try {
    const url = `${process.env.GREEN_API_URL}/waInstance${process.env.GREEN_API_INSTANCE_ID}/getStateInstance/${process.env.GREEN_API_TOKEN}`;
    const waRes = await fetch(url);
    if (waRes.ok) {
      const data = await waRes.json();
      healthStatus.whatsapp = data.stateInstance || 'connected';
    } else {
      healthStatus.whatsapp = 'error';
    }
  } catch {
    healthStatus.whatsapp = 'error';
  }

  // Test Apify
  try {
    const apiRes = await fetch(`https://api.apify.com/v2/users/me?token=${process.env.APIFY_TOKEN}`);
    healthStatus.apify = apiRes.ok ? 'connected' : 'error';
  } catch {
    healthStatus.apify = 'error';
  }

  res.json(healthStatus);
});

// Fetch metrics / stats for dashboard
app.get('/api/stats', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected." });

  try {
    // Total leads
    const { count: totalLeads } = await supabase.from('leads').select('*', { count: 'exact', head: true });
    // Email sent
    const { count: emailsSent } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('email_sent', true);
    // WhatsApp sent
    const { count: waSent } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('wa_sent', true);
    // High potential: Rating >= 4.0 or no website
    const { count: highPotential } = await supabase.from('leads').select('*', { count: 'exact', head: true }).gte('rating', 4.0);
    // No website
    const { count: noWebsite } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('has_website', false);

    res.json({
      totalLeads: totalLeads || 0,
      emailsSent: emailsSent || 0,
      waSent: waSent || 0,
      highPotential: highPotential || 0,
      noWebsite: noWebsite || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch leads with optional filtering
app.get('/api/leads', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected." });

  const { filter, search, page = 1, limit = 20 } = req.query;

  try {
    let query = supabase.from('leads').select('*', { count: 'exact' });

    if (filter === 'high_potential') {
      query = query.gte('rating', 4.0);
    } else if (filter === 'no_website') {
      query = query.eq('has_website', false);
    } else if (filter === 'has_email') {
      query = query.neq('email', '').not('email', 'is', null);
    }

    if (search) {
      query = query.or(`business_name.ilike.%${search}%,category.ilike.%${search}%,location.ilike.%${search}%`);
    }

    // Pagination
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    query = query.order('scraped_at', { ascending: false }).range(from, to);

    const { data, count, error } = await query;
    if (error) throw error;

    // Calculate lead score on-the-fly
    const scoredLeads = (data || []).map(lead => {
      let score = 0;
      if (!lead.has_website && !lead.website) score += 50; // Hot target for website
      if (lead.email) score += 20; // Has email
      if (lead.phone) score += 10; // Has phone
      if (lead.rating) {
        if (lead.rating >= 4.0 && !lead.website) {
          score += 20; // Highly rated, no website
        } else if (lead.rating < 4.0) {
          score += 15; // Low rated: reputation recovery
        }
      }
      return { ...lead, lead_score: score };
    });

    res.json({
      leads: scoredLeads,
      total: count,
      page: parseInt(page),
      totalPages: Math.ceil(count / limit)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export leads as CSV
app.get('/api/leads/export', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected." });
  
  const { filter, search } = req.query;

  try {
    let query = supabase.from('leads').select('*');

    if (filter === 'high_potential') {
      query = query.gte('rating', 4.0);
    } else if (filter === 'no_website') {
      query = query.eq('has_website', false);
    } else if (filter === 'has_email') {
      query = query.neq('email', '').not('email', 'is', null);
    }

    if (search) {
      query = query.or(`business_name.ilike.%${search}%,category.ilike.%${search}%,location.ilike.%${search}%`);
    }

    const { data, error } = await query.order('scraped_at', { ascending: false });
    if (error) throw error;

    // Generate CSV content
    let csv = 'Business Name,Category,Location,Phone,Website,Email,Rating,Address,Has Website,WA Sent,Email Sent,Notes,Scraped At,Lead Score\n';
    data.forEach(l => {
      let score = 0;
      if (!l.has_website && !l.website) score += 50;
      if (l.email) score += 20;
      if (l.phone) score += 10;
      if (l.rating) {
        if (l.rating >= 4.0 && !l.website) score += 20;
        else if (l.rating < 4.0) score += 15;
      }

      const row = [
        `"${(l.business_name || '').replace(/"/g, '""')}"`,
        `"${(l.category || '').replace(/"/g, '""')}"`,
        `"${(l.location || '').replace(/"/g, '""')}"`,
        `"${(l.phone || '')}"`,
        `"${(l.website || '')}"`,
        `"${(l.email || '')}"`,
        l.rating || 0,
        `"${(l.address || '').replace(/"/g, '""')}"`,
        l.has_website ? 'Yes' : 'No',
        l.wa_sent ? 'Yes' : 'No',
        l.email_sent ? 'Yes' : 'No',
        `"${(l.notes || '').replace(/"/g, '""')}"`,
        l.scraped_at,
        score
      ];
      csv += row.join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=jordan_leads_export.csv');
    res.status(200).send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save lead notes
app.post('/api/leads/:id/notes', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected." });
  const { notes } = req.body;
  try {
    const { error } = await supabase.from('leads').update({ notes }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch settings
app.get('/api/settings', async (req, res) => {
  const settings = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    settings[key] = await getSetting(key);
  }
  res.json(settings);
});

// Save settings
app.post('/api/settings', async (req, res) => {
  const newSettings = req.body;
  try {
    for (const [key, value] of Object.entries(newSettings)) {
      await saveSetting(key, value);
    }
    
    // Re-initialize cron scheduler if time changed
    if (newSettings.cron_time) {
      await initCronScheduler();
    }

    await logToAll("System settings updated successfully.", "success");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual scraper trigger
app.post('/api/scraper/trigger', (req, res) => {
  if (currentScraperRun.active) {
    return res.status(400).json({ error: "Scraper is already active." });
  }
  const { city, keyword } = req.body;
  if (!city) return res.status(400).json({ error: "City is required." });

  // Run async scraper
  runLeadScraper(city, keyword || null);

  res.json({ success: true, message: "Scraper run triggered." });
});

// Manual WhatsApp send
app.post('/api/outreach/whatsapp', async (req, res) => {
  const { leadId, text } = req.body;
  if (!leadId || !text) return res.status(400).json({ error: "Lead ID and text are required." });

  try {
    const { data: lead, error } = await supabase.from('leads').select('*').eq('id', leadId).single();
    if (error || !lead) return res.status(404).json({ error: "Lead not found." });

    await logToAll(`Sending manual WhatsApp to ${lead.business_name} (${lead.phone})...`, 'info');
    await sendWhatsAppMessage(lead.phone, text);

    await supabase.from('leads').update({ wa_sent: true }).eq('id', leadId);
    await logToAll(`WhatsApp successfully sent to ${lead.business_name}.`, 'success');

    res.json({ success: true });
  } catch (err) {
    await logToAll(`Manual WhatsApp outreach failed: ${err.message}`, 'error');
    res.status(500).json({ error: err.message });
  }
});

// Manual Email send
app.post('/api/outreach/email', async (req, res) => {
  const { leadId, subject, body } = req.body;
  if (!leadId || !subject || !body) return res.status(400).json({ error: "Lead ID, subject, and body are required." });

  try {
    const { data: lead, error } = await supabase.from('leads').select('*').eq('id', leadId).single();
    if (error || !lead) return res.status(404).json({ error: "Lead not found." });

    if (!lead.email) return res.status(400).json({ error: "Lead does not have an email address." });

    await logToAll(`Sending manual Email to ${lead.business_name} (${lead.email})...`, 'info');

    const resendKey = await getSetting('resend_api_key');
    const smtpHost = await getSetting('smtp_host');
    const smtpPort = await getSetting('smtp_port');
    const smtpUser = await getSetting('smtp_user');
    const smtpPass = await getSetting('smtp_pass');

    let emailSentStatus = false;
    if (resendKey) {
      try {
        await sendResendEmail(lead.email, subject, body.replace(/\n/g, '<br>'), resendKey);
        emailSentStatus = true;
      } catch (err) {
        await logToAll(`Manual Resend email failed: ${err.message}. Trying SMTP fallback...`, 'error');
      }
    }

    if (!emailSentStatus && smtpHost && smtpUser && smtpPass) {
      try {
        await sendSMTPEmail(lead.email, subject, body, { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass });
        emailSentStatus = true;
      } catch (err) {
        await logToAll(`Manual SMTP fallback failed: ${err.message}`, 'error');
      }
    }

    if (!emailSentStatus) {
      throw new Error("All email sending options failed.");
    }

    await supabase.from('leads').update({ email_sent: true }).eq('id', leadId);
    await logToAll(`Email successfully sent to ${lead.business_name}.`, 'success');

    res.json({ success: true });
  } catch (err) {
    await logToAll(`Manual Email outreach failed: ${err.message}`, 'error');
    res.status(500).json({ error: err.message });
  }
});

// Broadcast WhatsApp message to multiple leads
app.post('/api/outreach/broadcast', async (req, res) => {
  const { filter, leadIds, text } = req.body;
  if (!text) return res.status(400).json({ error: "Message text is required." });

  try {
    let targets = [];
    if (filter === 'selected' && Array.isArray(leadIds) && leadIds.length > 0) {
      const { data, error } = await supabase.from('leads').select('*').in('id', leadIds);
      if (error) throw error;
      targets = data;
    } else if (supabase) {
      let query = supabase.from('leads').select('*');
      if (filter === 'high_potential') {
        query = query.gte('rating', 4.0);
      } else if (filter === 'no_website') {
        query = query.eq('has_website', false);
      } else if (filter === 'has_email') {
        query = query.neq('email', '').not('email', 'is', null);
      }
      const { data, error } = await query;
      if (error) throw error;
      targets = data || [];
    }

    if (targets.length === 0) {
      return res.status(400).json({ error: "No target leads found for the broadcast." });
    }

    await logToAll(`📢 Initializing WhatsApp broadcast to ${targets.length} leads...`, 'info');

    // Respond immediately and send in background
    res.json({ success: true, message: `Broadcast started for ${targets.length} leads.` });

    // Background runner
    (async () => {
      let sentCount = 0;
      let failedCount = 0;

      for (let i = 0; i < targets.length; i++) {
        const lead = targets[i];
        
        // Wait 1.5 seconds between each message to avoid rate-limiting or ban risk
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }

        try {
          // Replace template variables
          let personalizedText = text
            .replace(/{{businessName}}/g, lead.business_name || "")
            .replace(/{{location}}/g, lead.location || "")
            .replace(/{{category}}/g, lead.category || "")
            .replace(/{{agencyName}}/g, "90's Kids Digital");

          await sendWhatsAppMessage(lead.phone, personalizedText);
          
          await supabase.from('leads').update({ wa_sent: true }).eq('id', lead.id);
          sentCount++;
          await logToAll(`[Broadcast ${i+1}/${targets.length}] Sent to ${lead.business_name} (${lead.phone})`, 'success');
        } catch (err) {
          failedCount++;
          await logToAll(`[Broadcast ${i+1}/${targets.length}] Failed for ${lead.business_name}: ${err.message}`, 'error');
        }
      }

      await logToAll(`📢 Broadcast completed! Sent: ${sentCount} | Failed: ${failedCount}`, 'success');
    })();

  } catch (err) {
    await logToAll(`Broadcast initialization failed: ${err.message}`, 'error');
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// Test WhatsApp send to Owner
app.post('/api/outreach/test-wa', async (req, res) => {
  const { text } = req.body;
  const ownerWa = process.env.WHATSAPP_OWNER || "917717766958";
  try {
    await logToAll(`Sending test WhatsApp message to owner (${ownerWa})...`, 'info');
    await sendWhatsAppMessage(ownerWa, text || "Test WhatsApp message from Jordan Dashboard!");
    await logToAll(`Test WhatsApp sent successfully to ${ownerWa}.`, 'success');
    res.json({ success: true });
  } catch (err) {
    await logToAll(`Test WhatsApp failed: ${err.message}`, 'error');
    res.status(500).json({ error: err.message });
  }
});

// Test Email send
app.post('/api/outreach/test-email', async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: "To, subject, and body are required." });

  try {
    await logToAll(`Sending test email to ${to}...`, 'info');
    const resendKey = await getSetting('resend_api_key');
    const smtpHost = await getSetting('smtp_host');
    const smtpPort = await getSetting('smtp_port');
    const smtpUser = await getSetting('smtp_user');
    const smtpPass = await getSetting('smtp_pass');

    let emailSentStatus = false;
    if (resendKey) {
      try {
        await sendResendEmail(to, subject, body.replace(/\n/g, '<br>'), resendKey);
        emailSentStatus = true;
        await logToAll(`Test email sent successfully to ${to} via Resend.`, 'success');
      } catch (err) {
        await logToAll(`Test Resend email failed: ${err.message}. Trying SMTP fallback...`, 'error');
      }
    }

    if (!emailSentStatus && smtpHost && smtpUser && smtpPass) {
      try {
        await sendSMTPEmail(to, subject, body, { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass });
        emailSentStatus = true;
        await logToAll(`Test email sent successfully to ${to} via SMTP.`, 'success');
      } catch (err) {
        await logToAll(`Test SMTP failed: ${err.message}`, 'error');
      }
    }

    if (!emailSentStatus) {
      throw new Error("All email sending configurations failed.");
    }

    res.json({ success: true });
  } catch (err) {
    await logToAll(`Test Email failed: ${err.message}`, 'error');
    res.status(500).json({ error: err.message });
  }
});

// Manual Daily Trigger (test the cron flow immediately)
app.post('/api/scheduler/trigger-now', (req, res) => {
  triggerDailyOutreachFlow();
  res.json({ success: true, message: "Daily cron run triggered immediately." });
});

// Webhook endpoint to receive Green API incoming messages
app.post('/api/whatsapp/webhook', async (req, res) => {
  // Always respond 200 OK immediately to Green API to avoid retries
  res.status(200).send("OK");

  const notification = req.body;
  if (!notification) return;

  const isIncoming = notification.typeWebhook === 'incomingMessageReceived';
  const isOutgoing = notification.typeWebhook === 'outgoingMessageReceived';
  if (!isIncoming && !isOutgoing) return;

  const sender = notification.senderData?.chatId || notification.senderData?.sender;
  const chatId = notification.chatId;
  const ownerWa = (process.env.WHATSAPP_OWNER || "917717766958") + "@c.us";

  // Security check: 
  // 1. If incoming, sender must be the owner.
  // 2. If outgoing, destination chatId must be the owner's own number (self-text).
  if (isIncoming && sender !== ownerWa) return;
  if (isOutgoing && chatId !== ownerWa) return;

  const messageText = notification.messageData?.textMessageData?.textMessage || "";
  if (!messageText) return;

  await logToAll(`💬 Owner WhatsApp Command Received: "${messageText}"`, 'info');

  try {
    const cleanMsg = messageText.trim();

    if (cleanMsg.startsWith('/help')) {
      const menu = `🤖 *Jordan AI Manager Command Menu*

📊 */status* - Check system stats & health
🎯 */hot* - Get top 5 hot prospects
📍 */cities* - List rotation cities
🚀 */scrape [city]* - Trigger crawl (e.g. \`/scrape Patna\`)
📢 */broadcast [msg]* - WhatsApp all No Website leads
💬 *Any other text* - Chat with Jordan!`;
      await sendWhatsAppMessage(process.env.WHATSAPP_OWNER, menu);

    } else if (cleanMsg.startsWith('/status')) {
      let total = 0, high = 0, noWeb = 0, sent = 0;
      if (supabase) {
        const { count: t } = await supabase.from('leads').select('*', { count: 'exact', head: true });
        const { count: h } = await supabase.from('leads').select('*', { count: 'exact', head: true }).gte('rating', 4.0);
        const { count: nw } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('has_website', false);
        const { count: s } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('email_sent', true);
        total = t || 0;
        high = h || 0;
        noWeb = nw || 0;
        sent = s || 0;
      }
      
      const response = `📊 *Jordan System Status*
------------------------
📈 *Total Leads:* ${total}
⭐ *High Potential:* ${high}
🌐 *No Website:* ${noWeb}
📧 *Emails Sent:* ${sent}
⏰ *Scheduler:* Active (Daily at ${await getSetting('cron_time')})
📍 *Active City Index:* ${await getSetting('active_location_index')}`;
      
      await sendWhatsAppMessage(process.env.WHATSAPP_OWNER, response);

    } else if (cleanMsg.startsWith('/hot')) {
      if (!supabase) return;
      const { data, error } = await supabase
        .from('leads')
        .select('*')
        .eq('has_website', false)
        .order('rating', { ascending: false })
        .limit(5);

      if (error || !data || data.length === 0) {
        await sendWhatsAppMessage(process.env.WHATSAPP_OWNER, "🎯 No hot prospects without websites found in database currently.");
        return;
      }

      let response = `🎯 *Top 5 Hot Prospects (No Website):*\n`;
      data.forEach((l, idx) => {
        response += `\n${idx + 1}. *${l.business_name}*
   📍 City: ${l.location} | ⭐ Rating: ${l.rating || '-'}
   📞 Phone: ${l.phone}
   💼 Category: ${l.category}\n`;
      });

      await sendWhatsAppMessage(process.env.WHATSAPP_OWNER, response);

    } else if (cleanMsg.startsWith('/cities')) {
      const locationsRaw = await getSetting('locations');
      const locations = JSON.parse(locationsRaw);
      const activeIdx = parseInt(await getSetting('active_location_index')) || 0;

      let response = `📍 *Target Cities Rotation list:*\n`;
      locations.forEach((loc, idx) => {
        const activeMarker = idx === activeIdx ? '👉 ' : '   ';
        response += `\n${activeMarker}${idx}. ${loc}`;
      });

      await sendWhatsAppMessage(process.env.WHATSAPP_OWNER, response);

    } else if (cleanMsg.startsWith('/scrape')) {
      const parts = cleanMsg.split(' ');
      const city = parts.slice(1).join(' ').trim();
      if (!city) {
        await sendWhatsAppMessage(process.env.WHATSAPP_OWNER, "❌ Please specify a city name, e.g. \`/scrape Patna\`");
        return;
      }

      runLeadScraper(city);
      await sendWhatsAppMessage(process.env.WHATSAPP_OWNER, `🚀 Started Google Places crawler for *"${city}"* in the background! I will ping you the digest when finished.`);

    } else if (cleanMsg.startsWith('/broadcast')) {
      const parts = cleanMsg.split(' ');
      const text = parts.slice(1).join(' ').trim();
      if (!text) {
        await sendWhatsAppMessage(process.env.WHATSAPP_OWNER, "❌ Please specify a broadcast message, e.g. \`/broadcast Hey {{businessName}}...\`");
        return;
      }

      const { data: targets, error } = await supabase.from('leads').select('*').eq('has_website', false);
      if (error || !targets || targets.length === 0) {
        await sendWhatsAppMessage(process.env.WHATSAPP_OWNER, "❌ No target leads found for the broadcast.");
        return;
      }

      await sendWhatsAppMessage(process.env.WHATSAPP_OWNER, `📢 Initializing WhatsApp broadcast to ${targets.length} leads in background...`);

      (async () => {
        let sentCount = 0;
        for (let i = 0; i < targets.length; i++) {
          const lead = targets[i];
          if (i > 0) await new Promise(r => setTimeout(r, 1500));
          try {
            let personalizedText = text
              .replace(/{{businessName}}/g, lead.business_name || "")
              .replace(/{{location}}/g, lead.location || "")
              .replace(/{{category}}/g, lead.category || "")
              .replace(/{{agencyName}}/g, "90's Kids Digital");
            await sendWhatsAppMessage(lead.phone, personalizedText);
            await supabase.from('leads').update({ wa_sent: true }).eq('id', lead.id);
            sentCount++;
          } catch {}
        }
        await sendWhatsAppMessage(process.env.WHATSAPP_OWNER, `✅ WhatsApp Broadcast completed! Successfully sent to ${sentCount}/${targets.length} leads.`);
      })();

    } else {
      const geminiKey = await getSetting('gemini_api_key');
      const geminiModel = await getSetting('gemini_model');

      if (geminiKey) {
        const sysPrompt = `You are Jordan, the sharp, witty, Hinglish-friendly manager chatbot for Nirbhay Kumar, founder of 90's Kids Digital (Bhagalpur, Bihar). 
Nirbhay has texted you: "${cleanMsg}". 
Reply wittily, acting as his BDM/manager. Keep the reply short (1-2 sentences), highly engaging, and in natural Hinglish (Hindi + English blend). 
If he asks for status/leads, tell him to use /status or /hot commands.`;

        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel || "gemini-2.5-flash"}:generateContent?key=${geminiKey}`;
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: sysPrompt }] }] })
          });
          if (res.ok) {
            const data = await res.json();
            const textReply = data.candidates?.[0]?.content?.parts?.[0]?.text || "Ji boss!";
            await sendWhatsAppMessage(process.env.WHATSAPP_OWNER, textReply.trim());
          } else {
            await sendWhatsAppMessage(process.env.WHATSAPP_OWNER, "Boss, Gemini API responded with error, but main chiz: /help type karke commands dekh lijiye!");
          }
        } catch {
          await sendWhatsAppMessage(process.env.WHATSAPP_OWNER, "Boss, AI connection error. Command run karne ke liye /help send karein.");
        }
      } else {
        await sendWhatsAppMessage(process.env.WHATSAPP_OWNER, "Boss, Gemini key config nahi hai. Commands dekhne ke liye /help send karein.");
      }
    }
  } catch (err) {
    await logToAll(`Error processing owner webhook command: ${err.message}`, 'error');
  }
});

// Serve frontend single page
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Init and Listen
app.listen(PORT, async () => {
  console.log(`🚀 Jordan Server running on port ${PORT}`);
  
  // Create public folder structure
  const fs = require('fs');
  if (!fs.existsSync(path.join(__dirname, 'public'))) {
    fs.mkdirSync(path.join(__dirname, 'public'));
  }
  if (!fs.existsSync(path.join(__dirname, 'public', 'images'))) {
    fs.mkdirSync(path.join(__dirname, 'public', 'images'));
  }

  // Initialize DB tables bootstrap
  if (supabase) {
    await bootstrapSettings();
  }

  // Initialize Scheduler
  await initCronScheduler();

  // Auto-set Green API Webhook URL in Railway production
  const staticUrl = process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
  if (staticUrl) {
    const webhookUrl = `https://${staticUrl}/api/whatsapp/webhook`;
    const setWebhookUrl = `${process.env.GREEN_API_URL || "https://7107.api.greenapi.com"}/waInstance${process.env.GREEN_API_INSTANCE_ID}/setSettings/${process.env.GREEN_API_TOKEN}`;
    fetch(setWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhookUrl,
        incomingMessageReceived: true,
        outgoingMessageReceived: true,
        outgoingAPIMessageReceived: false,
        incomingCallReceived: false,
        deviceStatus: false,
        stateInstanceChanged: false
      })
    }).then(r => r.json()).then(d => {
      console.log(`📡 WhatsApp Webhook auto-configured to: ${webhookUrl}. Response:`, d);
    }).catch(err => console.error("Error setting WhatsApp Webhook:", err.message));
  }
  
  await logToAll("Jordan Express server successfully initialized.", "success");
});
