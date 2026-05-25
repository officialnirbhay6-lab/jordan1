import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';

let emailLogs = [];

function log(message) {
  const timestamp = new Date().toISOString();
  const logMsg = `[Email] [${timestamp}] ${message}`;
  console.log(logMsg);
  emailLogs.push(logMsg);
  if (emailLogs.length > 500) emailLogs.shift();
  try {
    fs.appendFileSync('system.log', logMsg + '\n');
  } catch (err) {}
}

export function getEmailLogs() {
  return emailLogs;
}

/**
 * Reads settings from config.json
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
 * Sends a cold email to a specific business lead
 */
export async function sendColdEmail(lead) {
  if (!lead.email) {
    log(`No email available for lead "${lead.name}". Skipping.`);
    return false;
  }

  const config = getConfig();
  if (!config) {
    log('Configuration not loaded. Cannot send email.');
    return false;
  }

  const smtp = config.smtp;
  if (!smtp || !smtp.host || !smtp.user || !smtp.pass) {
    log(`SMTP credentials are not configured in settings. Skipping email to "${lead.name}".`);
    return false;
  }

  log(`Preparing cold email for "${lead.name}" (${lead.email})...`);

  // Compile template placeholders
  let subject = config.emailSubjectTemplate || "Website & Mobile App Development";
  let body = config.emailBodyTemplate || "";

  subject = subject.replace(/{{businessName}}/g, lead.name).replace(/{{location}}/g, lead.location);
  body = body.replace(/{{businessName}}/g, lead.name).replace(/{{location}}/g, lead.location);

  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: parseInt(smtp.port) || 587,
      secure: smtp.secure === true || smtp.secure === 'true',
      auth: {
        user: smtp.user,
        pass: smtp.pass
      },
      tls: {
        rejectUnauthorized: false // Avoid SSL handshake failure issues on local environments
      }
    });

    const mailOptions = {
      from: `"${config.senderName || 'Nirbhay Kumar'}" <${smtp.user}>`,
      to: lead.email,
      subject: subject,
      text: body
    };

    const info = await transporter.sendMail(mailOptions);
    log(`Email sent successfully to "${lead.name}" (${lead.email})! Message ID: ${info.messageId}`);
    
    // Update local database record
    updateLeadEmailStatus(lead.mapsUrl, true);
    return true;
  } catch (error) {
    log(`Failed sending email to "${lead.name}" (${lead.email}): ${error.message}`);
    return false;
  }
}

/**
 * Sends a test email to verify SMTP configuration is active
 */
export async function sendTestEmail(smtpConfig, toEmail) {
  log(`Sending SMTP verification email to ${toEmail}...`);
  try {
    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: parseInt(smtpConfig.port) || 587,
      secure: smtpConfig.secure === true || smtpConfig.secure === 'true',
      auth: {
        user: smtpConfig.user,
        pass: smtpConfig.pass
      },
      tls: {
        rejectUnauthorized: false
      }
    });

    const mailOptions = {
      from: `"Nirbhay Kumar (Test)" <${smtpConfig.user}>`,
      to: toEmail,
      subject: 'SMTP Configuration Verified - 90skids.digital Agent',
      text: 'Congratulations! Your SMTP email server credentials are valid and successfully connected to the 90skids.digital Automation Agent. Cold emailing is now fully operational.'
    };

    const info = await transporter.sendMail(mailOptions);
    log(`SMTP test email sent successfully! Message ID: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    log(`SMTP verification failed: ${error.message}`);
    throw error;
  }
}

/**
 * Updates a lead's email status in leads.json
 */
function updateLeadEmailStatus(mapsUrl, sentStatus) {
  try {
    const leadsFile = path.join(process.cwd(), 'leads.json');
    if (!fs.existsSync(leadsFile)) return;

    const leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
    const index = leads.findIndex(l => l.mapsUrl === mapsUrl);
    
    if (index !== -1) {
      leads[index].emailSent = sentStatus;
      leads[index].status = leads[index].whatsappSent ? 'OUTREACH_DONE' : 'EMAIL_SENT';
      fs.writeFileSync(leadsFile, JSON.stringify(leads, null, 2));
      log(`Database updated for lead "${leads[index].name}" (Email Status: Sent).`);
    }
  } catch (err) {
    log(`Failed updating lead email status in DB: ${err.message}`);
  }
}
