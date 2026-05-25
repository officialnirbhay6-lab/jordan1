// ==========================================================================
// 90skids.digital Automation Agent - Dashboard Controller Logic
// ==========================================================================

// Global State
let currentTab = 'overview';
let systemConfig = null;
let leadsDatabase = [];
let pollingInterval = null;
let selectedLeadForNotes = null;

// DOM Elements
const panels = {
  overview: document.getElementById('panel-overview'),
  leads: document.getElementById('panel-leads'),
  'email-config': document.getElementById('panel-email-config'),
  settings: document.getElementById('panel-settings'),
  logs: document.getElementById('panel-logs')
};

const navItems = document.querySelectorAll('.nav-item');
const pageTitle = document.getElementById('page-title');

// Initialize Dashboard
document.addEventListener('DOMContentLoaded', () => {
  setupTabNavigation();
  fetchInitialData();
  setupEventHandlers();
  
  // Start dynamic polling for live statuses and logs
  startStatusPolling();
});

/**
 * Tab Navigation Router
 */
function setupTabNavigation() {
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = item.getAttribute('data-tab');
      switchTab(tab);
    });
  });
}

function switchTab(tabId) {
  currentTab = tabId;
  
  // Update nav menu active states
  navItems.forEach(item => {
    if (item.getAttribute('data-tab') === tabId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Toggle visible panels
  Object.keys(panels).forEach(key => {
    if (key === tabId) {
      panels[key].classList.add('active');
    } else {
      panels[key].classList.remove('active');
    }
  });

  // Update Page Title Text
  const titles = {
    overview: 'Agent Command Center',
    leads: 'Scraped Leads Hub',
    'email-config': 'SMTP Cold Outreach Setup',
    settings: 'Niche & Location Settings',
    logs: 'Live System Logs console'
  };
  pageTitle.innerText = titles[tabId] || 'Dashboard';
  
  // Reload tab specific data on click
  if (tabId === 'leads') {
    fetchLeads();
  } else if (tabId === 'settings' || tabId === 'email-config') {
    fetchConfig();
  }
}

/**
 * Load Initial Settings & Leads on startup
 */
async function fetchInitialData() {
  await fetchConfig();
  await fetchLeads();
  updateStatusMetrics();
}

/**
 * Polling logic to continuously pull status from Express backend
 */
function startStatusPolling() {
  fetchStatusAndLogs(); // Fire once immediately
  pollingInterval = setInterval(fetchStatusAndLogs, 3000); // Poll every 3 seconds
}

/**
 * Call server to grab system status and system log updates
 */
async function fetchStatusAndLogs() {
  try {
    // 1. Fetch system statuses
    const resStatus = await fetch('/api/status');
    if (resStatus.ok) {
      const statusData = await resStatus.json();
      updateWhatsAppUIState(statusData.whatsapp);
      updateSchedulerUIState(statusData.scheduler);
      updateScraperUIState(statusData.scraper);
    }

    // 2. Fetch log streams if viewing logs or overview panel
    if (currentTab === 'logs' || currentTab === 'overview') {
      const resLogs = await fetch('/api/logs');
      if (resLogs.ok) {
        const logsData = await resLogs.json();
        renderLogs(logsData);
      }
    }
  } catch (err) {
    console.error('Error polling dashboard status:', err);
  }
}

/**
 * Render terminal logs into overview panel and logs console
 */
function renderLogs(logs) {
  const compileSystemLogs = () => {
    // Combine logs chronologically or use raw system.log lines
    return logs.system || [];
  };

  const logsBoxOverview = document.getElementById('logs-box-overview');
  const logsBoxExtended = document.getElementById('logs-box-extended');

  const systemLogs = compileSystemLogs();
  
  if (systemLogs.length === 0) return;

  const logsHtml = systemLogs
    .map(line => {
      // Escape HTML entities to prevent injection
      let escapedLine = line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      // Colorize categories for premium terminal readability
      if (escapedLine.includes('[Scraper]')) {
        return `<div class="log-line" style="color: var(--accent-gold);">${escapedLine}</div>`;
      } else if (escapedLine.includes('[WhatsApp]')) {
        return `<div class="log-line" style="color: var(--color-green);">${escapedLine}</div>`;
      } else if (escapedLine.includes('[Email]')) {
        return `<div class="log-line" style="color: var(--color-blue);">${escapedLine}</div>`;
      } else if (escapedLine.includes('[Scheduler]')) {
        return `<div class="log-line" style="color: #bd93f9;">${escapedLine}</div>`;
      }
      return `<div class="log-line">${escapedLine}</div>`;
    })
    .join('');

  if (logsBoxOverview) {
    const isAtBottom = logsBoxOverview.scrollHeight - logsBoxOverview.clientHeight <= logsBoxOverview.scrollTop + 20;
    logsBoxOverview.innerHTML = logsHtml;
    if (isAtBottom) {
      logsBoxOverview.scrollTop = logsBoxOverview.scrollHeight;
    }
  }

  if (logsBoxExtended) {
    const isAtBottom = logsBoxExtended.scrollHeight - logsBoxExtended.clientHeight <= logsBoxExtended.scrollTop + 20;
    logsBoxExtended.innerHTML = logsHtml;
    if (isAtBottom) {
      logsBoxExtended.scrollTop = logsBoxExtended.scrollHeight;
    }
  }
}

/**
 * Updates WhatsApp states mapping UI boxes
 */
function updateWhatsAppUIState(wsState) {
  const headerStatusText = document.getElementById('whatsapp-header-status');
  const headerBadgeDot = document.querySelector('#whatsapp-header-badge .status-dot');
  
  const qrOfflineView = document.getElementById('qr-offline-view');
  const qrCodeView = document.getElementById('qr-code-view');
  const qrLoadingView = document.getElementById('qr-loading-view');
  const qrConnectedView = document.getElementById('qr-connected-view');
  const qrLoadingMsg = document.getElementById('qr-loading-message');
  
  const statWhatsappText = document.getElementById('stat-whatsapp-status');

  // Sync header badges
  headerStatusText.innerText = wsState.status;
  headerBadgeDot.className = 'status-dot'; // Reset classes

  if (wsState.status === 'CONNECTED') {
    headerBadgeDot.classList.add('connected');
    statWhatsappText.innerText = 'Online';
    statWhatsappText.style.color = 'var(--color-green)';
  } else if (wsState.status === 'DISCONNECTED') {
    headerBadgeDot.classList.add('disconnected');
    statWhatsappText.innerText = 'Offline';
    statWhatsappText.style.color = 'var(--color-red)';
  } else {
    headerBadgeDot.classList.add('pending');
    statWhatsappText.innerText = 'Linking...';
    statWhatsappText.style.color = 'var(--accent-gold)';
  }

  // Toggle QR pairing boxes
  qrOfflineView.classList.add('hidden');
  qrCodeView.classList.add('hidden');
  qrLoadingView.classList.add('hidden');
  qrConnectedView.classList.add('hidden');

  switch (wsState.status) {
    case 'DISCONNECTED':
      qrOfflineView.classList.remove('hidden');
      break;

    case 'CONNECTING':
      qrLoadingView.classList.remove('hidden');
      qrLoadingMsg.innerText = 'Spawning headless browser...';
      break;

    case 'QR_READY':
      // Fetch latest QR Data URL and render
      fetch('/api/whatsapp/qr')
        .then(res => res.json())
        .then(data => {
          if (data.qr) {
            const qrImg = document.getElementById('qr-code-image');
            // Only update the src attribute if it has actually changed to prevent visual flickering/blinking
            if (qrImg.getAttribute('data-last-qr') !== data.qr) {
              qrImg.src = data.qr;
              qrImg.setAttribute('data-last-qr', data.qr);
            }
            qrCodeView.classList.remove('hidden');
          } else {
            qrLoadingView.classList.remove('hidden');
            qrLoadingMsg.innerText = 'Generating pairing QR code...';
          }
        });
      break;

    case 'AUTHENTICATING':
      qrLoadingView.classList.remove('hidden');
      qrLoadingMsg.innerText = 'Validating WhatsApp Session...';
      break;

    case 'CONNECTED':
      qrConnectedView.classList.remove('hidden');
      break;
  }
}

/**
 * Updates Scheduler Engine dashboard details
 */
function updateSchedulerUIState(sched) {
  const engineStatus = document.getElementById('sched-engine-status');
  const nextRun = document.getElementById('sched-next-run');
  
  if (sched.isScheduled) {
    engineStatus.innerText = 'Daily Automator Running';
    engineStatus.className = 'text-green';
  } else {
    engineStatus.innerText = 'Suspended';
    engineStatus.className = 'text-muted';
  }

  nextRun.innerText = sched.nextRunTime;
}

/**
 * Updates Scraper status progress bars in dashboard
 */
function updateScraperUIState(scraper) {
  const runCard = document.getElementById('scraper-running-card');
  const fill = document.getElementById('scraper-progress-fill');
  const percentText = document.getElementById('scraper-percent');
  const currentQuery = document.getElementById('scraper-current-query');

  if (scraper.status === 'SCRAPING') {
    runCard.classList.remove('hidden');
    
    const progress = scraper.progress;
    const percent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
    
    fill.style.width = `${percent}%`;
    percentText.innerText = `${percent}% (${progress.current}/${progress.total})`;
    currentQuery.innerHTML = `<i class="fa-solid fa-map-pin"></i> Scraped lead details: <strong style="color:var(--color-blue)">${progress.query}</strong>`;
  } else {
    runCard.classList.add('hidden');
    // If complete, fetch new leads list immediately
    if (scraper.status === 'COMPLETED') {
      fetchLeads();
    }
  }
}

/**
 * Load leads from Local JSON database
 */
async function fetchLeads() {
  try {
    const res = await fetch('/api/leads');
    if (res.ok) {
      leadsDatabase = await res.json();
      renderLeadsTable();
      updateStatusMetrics();
    }
  } catch (err) {
    console.error('Failed fetching leads list:', err);
  }
}

/**
 * Load full configuration details
 */
async function fetchConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      systemConfig = await res.json();
      populateConfigForms();
      renderChipsUI();
    }
  } catch (err) {
    console.error('Failed fetching configuration:', err);
  }
}

/**
 * Form values populating
 */
function populateConfigForms() {
  if (!systemConfig) return;

  // SMTP Settings
  document.getElementById('smtp-host').value = systemConfig.smtp?.host || '';
  document.getElementById('smtp-port').value = systemConfig.smtp?.port || '587';
  document.getElementById('smtp-secure').value = systemConfig.smtp?.secure ? 'true' : 'false';
  document.getElementById('smtp-user').value = systemConfig.smtp?.user || '';
  document.getElementById('smtp-pass').value = systemConfig.smtp?.pass || '';

  // Jordan AI Configuration
  document.getElementById('gemini-api-key').value = systemConfig.geminiApiKey || '';

  // Outreach Template Profile Settings
  document.getElementById('sender-name').value = systemConfig.senderName || 'Nirbhay Kumar';
  document.getElementById('agency-name').value = systemConfig.agencyName || '90skids.digital';
  document.getElementById('agency-url').value = systemConfig.agencyUrl || '90skids.digital';
  document.getElementById('email-subject-template').value = systemConfig.emailSubjectTemplate || '';
  document.getElementById('email-body-template').value = systemConfig.emailBodyTemplate || '';

  // Active location and scheduling timer
  document.getElementById('schedule-time').value = systemConfig.scheduleTime || '09:00';
  document.getElementById('ctrl-active-location').innerText = 
    systemConfig.locations[systemConfig.currentLocationIndex % systemConfig.locations.length] || 'Bhagalpur';
}

/**
 * Renders lists of keywords and locations as active tag chips
 */
function renderChipsUI() {
  if (!systemConfig) return;

  const locationsWrapper = document.getElementById('locations-chips-wrapper');
  const keywordsWrapper = document.getElementById('keywords-chips-wrapper');

  // Render Locations
  const activeLocIndex = systemConfig.currentLocationIndex % systemConfig.locations.length;
  locationsWrapper.innerHTML = systemConfig.locations
    .map((loc, i) => {
      const activeClass = i === activeLocIndex ? 'active' : '';
      return `
        <div class="chip ${activeClass}">
          <span>${loc}</span>
          <i class="fa-solid fa-xmark chip-remove-btn" onclick="removeConfigListItem('locations', ${i})"></i>
        </div>
      `;
    })
    .join('');

  // Render Keywords
  keywordsWrapper.innerHTML = systemConfig.keywords
    .map((key, i) => `
      <div class="chip">
        <span>${key}</span>
        <i class="fa-solid fa-xmark chip-remove-btn" onclick="removeConfigListItem('keywords', ${i})"></i>
      </div>
    `)
    .join('');
}

/**
 * Update Top Metric panels based on leads status
 */
function updateStatusMetrics() {
  document.getElementById('stat-total-leads').innerText = leadsDatabase.length;
  
  const highPotentialCount = leadsDatabase.filter(lead => lead.isHighPotential).length;
  document.getElementById('stat-high-potential').innerText = highPotentialCount;

  const hpPercent = leadsDatabase.length > 0 ? Math.round((highPotentialCount / leadsDatabase.length) * 100) : 0;
  document.getElementById('stat-hp-percentage').innerText = `${hpPercent}% Qualification Rate`;

  // Dynamic No Website Prospect Metric
  const noWebsiteCount = leadsDatabase.filter(lead => !lead.website).length;
  document.getElementById('stat-no-website').innerText = noWebsiteCount;

  const emailsSentCount = leadsDatabase.filter(lead => lead.emailSent).length;
  document.getElementById('stat-emails-sent').innerText = emailsSentCount;
}

/**
 * Render main leads list table
 */
let activeTableFilter = 'all';
let activeTableSearch = '';

function renderLeadsTable() {
  const body = document.getElementById('leads-table-body');
  
  let filtered = leadsDatabase.filter(lead => {
    // 1. Text Search Filter
    if (activeTableSearch) {
      const search = activeTableSearch.toLowerCase();
      const matchName = lead.name.toLowerCase().includes(search);
      const matchCategory = lead.category?.toLowerCase().includes(search);
      const matchLocation = lead.location.toLowerCase().includes(search);
      const matchPhone = lead.phone?.includes(search);
      
      if (!matchName && !matchCategory && !matchLocation && !matchPhone) return false;
    }

    // 2. Tab Category Filter
    if (activeTableFilter === 'high-potential') return lead.isHighPotential;
    if (activeTableFilter === 'no-website') return !lead.website;
    if (activeTableFilter === 'has-email') return lead.email !== null;

    return true;
  });

  if (filtered.length === 0) {
    body.innerHTML = `
      <tr>
        <td colspan="9" class="text-center py-4 text-muted">No matching leads found. Try expanding searches.</td>
      </tr>
    `;
    return;
  }

  body.innerHTML = filtered
    .map(lead => {
      // Setup dynamic web links
      const websiteLink = lead.website 
        ? `<a href="${lead.website}" target="_blank" class="table-website-link"><i class="fa-solid fa-arrow-up-right-from-square"></i> Visit Website</a>`
        : `<span style="color:var(--color-red)">❌ None</span>`;

      // Status badging styles
      let badgeHtml = '';
      if (lead.status === 'OUTREACH_DONE') {
        badgeHtml = `<span class="badge badge-outreach-done"><i class="fa-solid fa-check-double"></i> Outreach Done</span>`;
      } else if (lead.emailSent) {
        badgeHtml = `<span class="badge badge-email-sent"><i class="fa-solid fa-envelope"></i> Email Sent</span>`;
      } else if (lead.isHighPotential) {
        badgeHtml = `<span class="badge badge-potential"><i class="fa-solid fa-star"></i> High Potential</span>`;
      } else {
        badgeHtml = `<span class="badge badge-new">New Lead</span>`;
      }

      const ratingStars = lead.rating > 0 
        ? `⭐ <strong>${lead.rating}</strong> <span class="text-muted">(${lead.reviewsCount})</span>`
        : `<span class="text-muted">N/A</span>`;

      const safeNotes = lead.notes ? lead.notes.replace(/"/g, '&quot;') : '';

      return `
        <tr>
          <td>
            <strong>${lead.name}</strong>
          </td>
          <td><span class="text-muted">${lead.category || 'N/A'}</span></td>
          <td>${lead.location}</td>
          <td>${ratingStars}</td>
          <td><code>${lead.phone || 'N/A'}</code></td>
          <td>${websiteLink}</td>
          <td>${lead.email ? `<code>${lead.email}</code>` : '<span class="text-muted">None</span>'}</td>
          <td>${badgeHtml}</td>
          <td>
            <div class="btn-group">
              <button class="btn btn-secondary btn-sm" onclick="openNotesModal('${encodeURIComponent(lead.mapsUrl)}', '${safeNotes}', '${lead.name}')">
                <i class="fa-regular fa-comment-dots"></i> Notes
              </button>
              <a href="${lead.mapsUrl}" target="_blank" class="btn btn-secondary btn-sm" style="text-decoration:none">
                <i class="fa-solid fa-map-pin"></i> Maps
              </a>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

/**
 * Handle configuration changes like list removals
 */
async function removeConfigListItem(field, index) {
  if (!systemConfig) return;

  systemConfig[field].splice(index, 1);
  await saveConfigToServer();
  renderChipsUI();
  showToast(`Item removed from ${field}`, 'info');
}

/**
 * Post current config state to Express API
 */
async function saveConfigToServer() {
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(systemConfig)
    });
    if (res.ok) {
      await fetchConfig(); // Reload
    }
  } catch (err) {
    showToast('Failed to save settings to server.', 'error');
  }
}

/**
 * Configure DOM click/submit handlers
 */
function setupEventHandlers() {
  // 1. WhatsApp Controls
  document.getElementById('btn-init-whatsapp').addEventListener('click', async () => {
    showToast('Launching headless WhatsApp browser...', 'info');
    await fetch('/api/whatsapp/login', { method: 'POST' });
  });

  document.getElementById('btn-logout-whatsapp').addEventListener('click', async () => {
    if (confirm('Are you sure you want to disconnect WhatsApp?')) {
      showToast('Logging out WhatsApp session...', 'info');
      await fetch('/api/whatsapp/logout', { method: 'POST' });
    }
  });

  document.getElementById('btn-refresh-qr').addEventListener('click', () => {
    fetchStatusAndLogs();
    showToast('QR status refreshed.', 'info');
  });

  document.getElementById('btn-send-test-whatsapp').addEventListener('click', async () => {
    if (!systemConfig || !systemConfig.whatsappNumber) return;
    showToast('Sending test digest message via WhatsApp...', 'info');
    
    try {
      const res = await fetch('/api/whatsapp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: systemConfig.whatsappNumber,
          message: `👋 *90skids.digital Automation Check!* \n\nIf you see this, your WhatsApp notification channel is successfully connected. You will receive beautiful daily digests at 9:00 AM right here.`
        })
      });
      if (res.ok) {
        showToast('Test digest delivered!', 'success');
      } else {
        const errData = await res.json();
        showToast(`Send failed: ${errData.error}`, 'error');
      }
    } catch (e) {
      showToast('Network error during WhatsApp test.', 'error');
    }
  });

  // 2. Manual Scrape Trigger
  document.getElementById('btn-trigger-scraper').addEventListener('click', async () => {
    if (confirm('Manually trigger Google Maps scraper now? This launches background tasks.')) {
      showToast('Lead generation cycle triggered in background.', 'success');
      await fetch('/api/trigger', { method: 'POST' });
    }
  });

  // 3. SMTP configuration form submission
  document.getElementById('smtp-config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!systemConfig) return;

    systemConfig.smtp = {
      host: document.getElementById('smtp-host').value,
      port: document.getElementById('smtp-port').value,
      secure: document.getElementById('smtp-secure').value === 'true',
      user: document.getElementById('smtp-user').value,
      pass: document.getElementById('smtp-pass').value
    };

    await saveConfigToServer();
    showToast('SMTP Server credentials saved successfully.', 'success');
  });

  // 4. Test SMTP diagnostic
  document.getElementById('btn-test-smtp').addEventListener('click', async () => {
    const testEmail = document.getElementById('smtp-test-email').value;
    if (!testEmail) {
      showToast('Please specify a receiver email address.', 'error');
      return;
    }

    const smtpConfig = {
      host: document.getElementById('smtp-host').value,
      port: document.getElementById('smtp-port').value,
      secure: document.getElementById('smtp-secure').value === 'true',
      user: document.getElementById('smtp-user').value,
      pass: document.getElementById('smtp-pass').value
    };

    showToast('Connecting SMTP server and dispatching test email...', 'info');
    try {
      const res = await fetch('/api/outreach/email/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          smtp: smtpConfig,
          testEmail: testEmail
        })
      });

      if (res.ok) {
        showToast('SMTP diagnostic test email delivered!', 'success');
      } else {
        const errData = await res.json();
        showToast(`SMTP Connection Failed: ${errData.error}`, 'error');
      }
    } catch (e) {
      showToast('Network error verifying SMTP mail server.', 'error');
    }
  });

  // 5. Save templates customized
  document.getElementById('btn-save-templates').addEventListener('click', async () => {
    if (!systemConfig) return;

    systemConfig.senderName = document.getElementById('sender-name').value;
    systemConfig.agencyName = document.getElementById('agency-name').value;
    systemConfig.agencyUrl = document.getElementById('agency-url').value;
    systemConfig.emailSubjectTemplate = document.getElementById('email-subject-template').value;
    systemConfig.emailBodyTemplate = document.getElementById('email-body-template').value;

    await saveConfigToServer();
    showToast('Outreach email templates updated successfully.', 'success');
  });

  // 6. Save Schedule hour
  document.getElementById('btn-save-time').addEventListener('click', async () => {
    if (!systemConfig) return;
    
    systemConfig.scheduleTime = document.getElementById('schedule-time').value;
    await saveConfigToServer();
    showToast(`Scheduler timing rescheduled to ${systemConfig.scheduleTime} daily.`, 'success');
  });

  // 6b. Save Gemini API key
  document.getElementById('btn-save-ai-key').addEventListener('click', async () => {
    if (!systemConfig) return;

    systemConfig.geminiApiKey = document.getElementById('gemini-api-key').value;
    await saveConfigToServer();
    showToast('Jordan AI Brain configuration updated successfully.', 'success');
  });

  // 7. Add target location list item
  document.getElementById('btn-add-location').addEventListener('click', async () => {
    const input = document.getElementById('new-location-input');
    const newLoc = input.value.trim();
    if (!newLoc || !systemConfig) return;

    if (systemConfig.locations.some(l => l.toLowerCase() === newLoc.toLowerCase())) {
      showToast('Location already exists in rotation pool.', 'error');
      return;
    }

    systemConfig.locations.push(newLoc);
    await saveConfigToServer();
    renderChipsUI();
    input.value = '';
    showToast(`"${newLoc}" added to target pool.`, 'success');
  });

  // 8. Add category keyword list item
  document.getElementById('btn-add-keyword').addEventListener('click', async () => {
    const input = document.getElementById('new-keyword-input');
    const newKey = input.value.trim();
    if (!newKey || !systemConfig) return;

    if (systemConfig.keywords.some(k => k.toLowerCase() === newKey.toLowerCase())) {
      showToast('Niche keyword already exists.', 'error');
      return;
    }

    systemConfig.keywords.push(newKey);
    await saveConfigToServer();
    renderChipsUI();
    input.value = '';
    showToast(`"${newKey}" added to niches list.`, 'success');
  });

  // 9. Lead Search Text input handler
  document.getElementById('lead-search-input').addEventListener('input', (e) => {
    activeTableSearch = e.target.value;
    renderLeadsTable();
  });

  // 10. Table buttons categorizing click
  document.querySelectorAll('.btn-filter').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTableFilter = btn.getAttribute('data-filter');
      renderLeadsTable();
    });
  });

  // 11. Modal Popup cancel actions
  document.getElementById('modal-close').addEventListener('click', closeNotesModal);
  document.getElementById('btn-modal-cancel').addEventListener('click', closeNotesModal);
  
  // 12. Modal Popup save action
  document.getElementById('btn-modal-save').addEventListener('click', async () => {
    const mapsUrl = document.getElementById('modal-lead-url').value;
    const notes = document.getElementById('modal-notes-textarea').value;

    try {
      const res = await fetch('/api/leads', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapsUrl, notes })
      });
      if (res.ok) {
        showToast('Lead notes updated successfully.', 'success');
        closeNotesModal();
        await fetchLeads(); // Reload table
      }
    } catch (e) {
      showToast('Failed to update lead notes.', 'error');
    }
  });

  // 13. Terminal clear actions
  document.getElementById('btn-clear-terminal').addEventListener('click', () => {
    document.getElementById('logs-box-extended').innerHTML = '<div class="log-line text-muted">Console cleared by user. Polling fresh logs...</div>';
    showToast('Local terminal screen cleared.', 'info');
  });

  document.getElementById('btn-refresh-logs').addEventListener('click', () => {
    fetchStatusAndLogs();
    showToast('Logs reloaded.', 'info');
  });
}

/**
 * Opens modal for editing notes
 */
function openNotesModal(encodedUrl, notes, name) {
  selectedLeadForNotes = decodeURIComponent(encodedUrl);
  document.getElementById('modal-lead-url').value = selectedLeadForNotes;
  document.getElementById('modal-notes-textarea').value = notes;
  document.getElementById('modal-lead-name').innerText = `Outreach Notes: ${name}`;
  document.getElementById('notes-modal').classList.add('active');
}

/**
 * Closes the notes modal
 */
function closeNotesModal() {
  document.getElementById('notes-modal').classList.remove('active');
  selectedLeadForNotes = null;
}

/**
 * Renders glowing Toast Notification elements
 */
function showToast(message, type = 'info') {
  const wrapper = document.getElementById('toast-wrapper');
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let iconHtml = '';
  if (type === 'success') iconHtml = '<i class="fa-solid fa-circle-check"></i>';
  else if (type === 'error') iconHtml = '<i class="fa-solid fa-triangle-exclamation"></i>';
  else iconHtml = '<i class="fa-solid fa-circle-info"></i>';

  toast.innerHTML = `
    ${iconHtml}
    <span>${message}</span>
  `;

  wrapper.appendChild(toast);
  
  // Slide out and remove toast after 3.5s
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse forwards';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3500);
}
