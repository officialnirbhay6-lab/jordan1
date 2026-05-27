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
  const DAILY_OUTREACH_LIMIT = 50;

  // Scrape each keyword for the target location until we have enough qualified prospects
  for (const keyword of keywords) {
    if (allNewLeads.length >= DAILY_OUTREACH_LIMIT) {
      log(`Acquired target leads goal of ${DAILY_OUTREACH_LIMIT} new listings. Stopping search loop early.`);
      break;
    }
    
    try {
      log(`Running scraper for keyword: "${keyword}" in location: "${targetLocation}"`);
      // Scrape up to 15 listings per keyword to search efficiently
      const leads = await scrapeGoogleMapsLeads(keyword, targetLocation, 15);
      allNewLeads = allNewLeads.concat(leads);
    } catch (err) {
      log(`Scraper failed for keyword "${keyword}": ${err.message}`);
    }
  }

  log(`Scraping complete. Total new unique leads found: ${allNewLeads.length}`);

  // Auto Email cold outreach to high potential leads (Cap at exactly 50 per daily run)
  let emailsSent = 0;
  for (const lead of allNewLeads) {
    if (emailsSent >= DAILY_OUTREACH_LIMIT) {
      log(`Reached daily email outreach cap of ${DAILY_OUTREACH_LIMIT}. Stopping email loop.`);
      break;
    }
    
    if (lead.email) {
      try {
        log(`Triggering cold email outreach to "${lead.name}" (${lead.email})...`);
        const sent = await sendColdEmail(lead);
        if (sent) {
          emailsSent++;
          // Add 3-second spacing delay between emails to prevent SMTP socket rate-limiting
          await new Promise(res => setTimeout(res, 3000));
        }
      } catch (err) {
        log(`Failed outreach to "${lead.name}": ${err.message}`);
      }
    }
  }

  // Auto direct WhatsApp B2B pitch to high potential leads lacking website (Cap at exactly 50 per daily run)
  let whatsappPitchesSent = 0;
  for (const lead of allNewLeads) {
    if (whatsappPitchesSent >= DAILY_OUTREACH_LIMIT) {
      log(`Reached daily WhatsApp B2B pitch cap of ${DAILY_OUTREACH_LIMIT}. Stopping WhatsApp loop.`);
      break;
    }
    
    if (lead.isHighPotential && !lead.website && lead.normalizedPhone) {
      try {
        log(`Triggering direct WhatsApp B2B pitch to "${lead.name}" (${lead.normalizedPhone})...`);
        const sent = await sendWhatsAppPitch(lead);
        if (sent) {
          whatsappPitchesSent++;
          // Add 2-second safety delay between pitches to avoid account triggers
          await new Promise(res => setTimeout(res, 2000));
        }
      } catch (err) {
        log(`Failed direct WhatsApp B2B pitch outreach to "${lead.name}": ${err.message}`);
      }
    }
  }

  // Filter high potential leads for the WhatsApp digest
  const highPotentialLeads = allNewLeads.filter(lead => lead.isHighPotential);
  log(`Identified ${highPotentialLeads.length} high-potential leads for digest.`);

  // Build the WhatsApp Digest Message
  const digestMessage = buildWhatsAppDigest(targetLocation, allNewLeads, highPotentialLeads, emailsSent, whatsappPitchesSent);

  // Send WhatsApp Digest to user
  let whatsappDelivered = false;
  try {
    if (getConnectionStatus() === 'CONNECTED') {
      log(`Delivering leads digest to WhatsApp number: ${whatsappNumber}...`);
      await sendWhatsAppMessage(whatsappNumber, digestMessage);
      whatsappDelivered = true;
      
      // Update leads as WhatsApp Sent (meaning digest was sent to Nirbhay)
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
    whatsappPitchesSent,
    whatsappDelivered
  };

  log(`Automation cycle completed successfully!`);
}

/**
 * Compiles a clean, highly structured WhatsApp digest
 */
export function buildWhatsAppDigest(location, allLeads, highPotentialLeads, emailsSent, whatsappPitchesSent = 0) {
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
  msg += `- Cold Emails Automated: *${emailsSent}*\n`;
  msg += `- Direct WhatsApp Pitches: *${whatsappPitchesSent}*\n\n`;

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
      msg += `   💬 Direct WhatsApp Pitch: ${lead.whatsappPitchSent ? '✅ Sent' : '❌ Failed/Skipped'}\n`;
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
 * Updates leads database with WhatsApp status (digest delivered to owner)
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
 * Sends a direct B2B WhatsApp pitch to a scraped business that lacks a website
 */
export async function sendWhatsAppPitch(lead) {
  if (!lead.normalizedPhone) {
    log(`No valid phone number available for direct WhatsApp pitch to "${lead.name}". Skipping.`);
    return false;
  }

  log(`Preparing direct WhatsApp B2B pitch to "${lead.name}" (${lead.normalizedPhone})...`);
  
  const pitchMsg = 
    `Hello! 👋\n\n` +
    `My name is Nirbhay Kumar from *90skids.digital*, a professional web and mobile app development agency.\n\n` +
    `I came across your business, *${lead.name}*, on Google Maps while researching outstanding local services in *${lead.location}*.\n\n` +
    `I noticed that your business currently *does not have a website* listed online. In today's digital world, having a fast, modern, and mobile-friendly website is one of the easiest ways to build trust and attract 2x to 3x more local customers!\n\n` +
    `We specialize in building premium, high-converting websites and mobile applications tailored for businesses exactly like yours. You can explore our work here:\n` +
    `🌐 *https://90skids.digital*\n\n` +
    `If you would like a free, quick digital mockup or want to discuss how we can build a stellar digital presence for *${lead.name}*, please reply directly to this chat! We would love to help you grow. 🚀\n\n` +
    `Warm regards,\n\n` +
    `*Nirbhay Kumar*\n` +
    `Founder, 90skids.digital\n` +
    `WhatsApp: +91 7717766958`;

  try {
    if (getConnectionStatus() === 'CONNECTED') {
      await sendWhatsAppMessage(lead.normalizedPhone, pitchMsg);
      log(`Direct WhatsApp B2B pitch sent successfully to "${lead.name}" (${lead.normalizedPhone})!`);
      
      // Update lead record status in database
      updateLeadWhatsAppPitchStatus(lead.mapsUrl, true);
      return true;
    } else {
      log(`WhatsApp client is offline. Direct pitch to "${lead.name}" skipped.`);
      return false;
    }
  } catch (err) {
    log(`Failed to send direct WhatsApp B2B pitch to "${lead.name}": ${err.message}`);
    return false;
  }
}

/**
 * Updates a lead's direct WhatsApp pitch status in database
 */
function updateLeadWhatsAppPitchStatus(mapsUrl, pitchStatus) {
  try {
    const leadsFile = path.join(process.cwd(), 'leads.json');
    if (!fs.existsSync(leadsFile)) return;

    const leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
    const index = leads.findIndex(l => l.mapsUrl === mapsUrl);
    
    if (index !== -1) {
      leads[index].whatsappPitchSent = pitchStatus;
      leads[index].status = (leads[index].emailSent || !leads[index].email) && pitchStatus ? 'OUTREACH_DONE' : 'WHATSAPP_PITCH_SENT';
      fs.writeFileSync(leadsFile, JSON.stringify(leads, null, 2));
      log(`Database updated for lead "${leads[index].name}" (Direct WhatsApp Pitch: Sent).`);
    }
  } catch (err) {
    log(`Failed to update direct WhatsApp pitch status in DB: ${err.message}`);
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
