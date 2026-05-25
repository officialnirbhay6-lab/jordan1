import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { scrapeGoogleMapsLeads } from './scraper.js';
import { sendWhatsAppMessage, getConnectionStatus } from './whatsapp.js';
import { sendColdEmail } from './email.js';

let activeCronJob = null;
let schedulerLogs = [];
let lastRunDetails = null;

function log(message) {
  const timestamp = new Date().toISOString();
  const logMsg = `[Scheduler] [${timestamp}] ${message}`;
  console.log(logMsg);
  schedulerLogs.push(logMsg);
  if (schedulerLogs.length > 500) schedulerLogs.shift();
  try {
    fs.appendFileSync('system.log', logMsg + '\n');
  } catch (err) {}
}

export function getSchedulerLogs() {
  return schedulerLogs;
}

export function getSchedulerStatus() {
  return {
    isScheduled: activeCronJob !== null,
    lastRun: lastRunDetails,
    nextRunTime: activeCronJob ? calculateNextRunTime() : 'Not Scheduled'
  };
}

/**
 * Reads configuration
 */
function getConfig() {
  try {
    const configPath = path.join(process.cwd(), 'config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (err) {
    log(`Failed to read config: ${err.message}`);
  }
  return null;
}

/**
 * Saves configuration
 */
function saveConfig(config) {
  try {
    const configPath = path.join(process.cwd(), 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (err) {
    log(`Failed to write config: ${err.message}`);
  }
}

/**
 * Estimates the next run time for node-cron based on 9 AM schedule
 */
function calculateNextRunTime() {
  const config = getConfig();
  if (!config) return 'Unknown';
  
  const [hourStr, minStr] = config.scheduleTime.split(':');
  const targetHour = parseInt(hourStr) || 9;
  const targetMin = parseInt(minStr) || 0;

  const now = new Date();
  const target = new Date();
  target.setHours(targetHour, targetMin, 0, 0);

  if (now > target) {
    target.setDate(target.getDate() + 1); // If 9 AM already passed today, scheduled for tomorrow
  }
  return target.toLocaleString();
}

/**
 * Main Lead Scraper & Outreach Runner Orchestrator
 */
export async function triggerLeadAutomation(manualRun = false) {
  log(`Starting automation cycle (Manual Run: ${manualRun})...`);
  const config = getConfig();
  if (!config) {
    log('Aborting: Configuration file missing.');
    return;
  }

  const { locations, keywords, currentLocationIndex, whatsappNumber } = config;

  if (!locations || locations.length === 0) {
    log('Aborting: No target locations configured.');
    return;
  }
  if (!keywords || keywords.length === 0) {
    log('Aborting: No search keywords configured.');
    return;
  }

  // Get active location
  const locIndex = currentLocationIndex % locations.length;
  const targetLocation = locations[locIndex];
  log(`Active location target: "${targetLocation}" (Index ${locIndex} of ${locations.length})`);

  let allNewLeads = [];

  // Scrape each keyword for the target location
  for (const keyword of keywords) {
    try {
      log(`Running scraper for keyword: "${keyword}" in location: "${targetLocation}"`);
      const leads = await scrapeGoogleMapsLeads(keyword, targetLocation, 20);
      allNewLeads = allNewLeads.concat(leads);
    } catch (err) {
      log(`Scraper failed for keyword "${keyword}": ${err.message}`);
    }
  }

  log(`Scraping complete. Total new unique leads found: ${allNewLeads.length}`);

  // Auto Email cold outreach to high potential leads
  let emailsSent = 0;
  for (const lead of allNewLeads) {
    if (lead.email) {
      try {
        log(`Triggering cold email outreach to "${lead.name}" (${lead.email})...`);
        const sent = await sendColdEmail(lead);
        if (sent) emailsSent++;
      } catch (err) {
        log(`Failed outreach to "${lead.name}": ${err.message}`);
      }
    }
  }

  // Filter high potential leads for the WhatsApp digest
  const highPotentialLeads = allNewLeads.filter(lead => lead.isHighPotential);
  log(`Identified ${highPotentialLeads.length} high-potential leads for digest.`);

  // Build the WhatsApp Digest Message
  const digestMessage = buildWhatsAppDigest(targetLocation, allNewLeads, highPotentialLeads, emailsSent);

  // Send WhatsApp Digest to user
  let whatsappDelivered = false;
  try {
    if (getConnectionStatus() === 'CONNECTED') {
      log(`Delivering leads digest to WhatsApp number: ${whatsappNumber}...`);
      await sendWhatsAppMessage(whatsappNumber, digestMessage);
      whatsappDelivered = true;
      
      // Update leads as WhatsApp Sent
      updateLeadsWhatsAppStatus(allNewLeads.map(l => l.mapsUrl));
    } else {
      log('WhatsApp client is disconnected. Digest was NOT sent to WhatsApp. Please scan QR code.');
    }
  } catch (whatsappErr) {
    log(`Failed to send WhatsApp digest: ${whatsappErr.message}`);
  }

  // Rotate to the next location to increase location gap gradually
  if (!manualRun) {
    const nextIndex = (locIndex + 1) % locations.length;
    config.currentLocationIndex = nextIndex;
    saveConfig(config);
    log(`Location rotation successful. Next location index: ${nextIndex} ("${locations[nextIndex]}")`);
  }

  // Save last run details
  lastRunDetails = {
    timestamp: new Date().toISOString(),
    location: targetLocation,
    totalLeads: allNewLeads.length,
    highPotentialLeads: highPotentialLeads.length,
    emailsSent,
    whatsappDelivered
  };

  log(`Automation cycle completed successfully!`);
}

/**
 * Compiles a clean, highly structured WhatsApp digest
 */
export function buildWhatsAppDigest(location, allLeads, highPotentialLeads, emailsSent) {
  const dateStr = new Date().toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });

  const noWebsiteLeads = highPotentialLeads.filter(lead => !lead.website);
  const otherHighPotential = highPotentialLeads.filter(lead => lead.website);

  let msg = `🚀 *90skids.digital Outreach Digest* 🚀\n`;
  msg += `📅 *Date:* ${dateStr}\n`;
  msg += `📍 *Scraped Target:* ${location}\n\n`;
  
  msg += `📊 *Outreach Activity Metrics:*\n`;
  msg += `- Scraped listings: *${allLeads.length}*\n`;
  msg += `- High Potential Targets: *${highPotentialLeads.length}*\n`;
  msg += `- Cold Emails Automated: *${emailsSent}*\n\n`;

  // Section 1: Absolutely No Website Leads (Highest Priority)
  if (noWebsiteLeads.length > 0) {
    msg += `🔥 *PRIMARY TARGETS (No Website found):*\n\n`;
    noWebsiteLeads.slice(0, 10).forEach((lead, i) => {
      msg += `📍 *${lead.name}*\n`;
      msg += `   📞 Phone: ${lead.phone || 'N/A'}\n`;
      msg += `   📧 Email: ${lead.email || '❌ None (Send WhatsApp)'}\n`;
      if (lead.email) {
        msg += `   📬 Cold Pitch Email: ${lead.emailSent ? '✅ Sent' : '❌ Failed/SMTP'}\n`;
      }
      msg += `   🗺️ Address: ${lead.address || 'N/A'}\n\n`;
    });
  }

  // Section 2: GMB Optimization & Revamp Leads
  if (otherHighPotential.length > 0) {
    msg += `⚡ *SECONDARY TARGETS (Needs Optimization/Revamp):*\n\n`;
    otherHighPotential.slice(0, 5).forEach((lead, i) => {
      msg += `📍 *${lead.name}*\n`;
      msg += `   🌐 Website: ${lead.website}\n`;
      msg += `   ⭐ GMB Rating: ${lead.rating} (${lead.reviewsCount} reviews)\n`;
      msg += `   📞 Phone: ${lead.phone || 'N/A'}\n\n`;
    });
  }

  if (highPotentialLeads.length === 0) {
    msg += `💡 _No new high potential leads found in Bhagalpur/Bihar pool today._\n\n`;
  }

  msg += `💻 _Manage outreach templates & configuration: http://localhost:3000_`;
  return msg;
}

/**
 * Updates leads database with WhatsApp status
 */
function updateLeadsWhatsAppStatus(mapsUrls) {
  try {
    const leadsFile = path.join(process.cwd(), 'leads.json');
    if (!fs.existsSync(leadsFile)) return;

    const leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
    let updated = false;

    leads.forEach(lead => {
      if (mapsUrls.includes(lead.mapsUrl)) {
        lead.whatsappSent = true;
        lead.status = lead.emailSent ? 'OUTREACH_DONE' : 'WHATSAPP_SENT';
        updated = true;
      }
    });

    if (updated) {
      fs.writeFileSync(leadsFile, JSON.stringify(leads, null, 2));
    }
  } catch (err) {
    log(`Failed to update WhatsApp leads status in DB: ${err.message}`);
  }
}

/**
 * Initializes and schedules node-cron job based on 9 AM settings
 */
export function startScheduler() {
  const config = getConfig();
  if (!config) {
    log('Failed to start scheduler: config.json not loaded.');
    return;
  }

  // Parse time configuration e.g. "09:00"
  const [hourStr, minStr] = config.scheduleTime.split(':');
  const targetHour = parseInt(hourStr) || 9;
  const targetMin = parseInt(minStr) || 0;

  // Convert to cron expression (minutes, hours, day of month, month, day of week)
  // Run daily at scheduled hours
  const cronExpression = `${targetMin} ${targetHour} * * *`;
  log(`Scheduling daily automation run at ${config.scheduleTime} (Cron: "${cronExpression}").`);

  if (activeCronJob) {
    activeCronJob.stop();
  }

  activeCronJob = cron.schedule(cronExpression, async () => {
    log('Daily automation cron triggered!');
    try {
      await triggerLeadAutomation(false);
    } catch (err) {
      log(`Cron job crashed: ${err.message}`);
    }
  });
}

/**
 * Stops the active scheduler
 */
export function stopScheduler() {
  if (activeCronJob) {
    activeCronJob.stop();
    activeCronJob = null;
    log('Scheduler successfully suspended.');
  }
}
