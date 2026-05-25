import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

let scraperStatus = 'IDLE'; // IDLE, SCRAPING, SAVING, COMPLETED, ERROR
let scraperLogs = [];
let currentProgress = { current: 0, total: 0, query: '' };

function log(message) {
  const timestamp = new Date().toISOString();
  const logMsg = `[Scraper] [${timestamp}] ${message}`;
  console.log(logMsg);
  scraperLogs.push(logMsg);
  if (scraperLogs.length > 500) scraperLogs.shift();
  try {
    fs.appendFileSync('system.log', logMsg + '\n');
  } catch (err) {}
}

export function getScraperStatus() {
  return {
    status: scraperStatus,
    progress: currentProgress,
    logs: scraperLogs
  };
}

// Simple email regex
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Normalizes a phone number to standard format
 */
function normalizePhone(phoneStr) {
  if (!phoneStr) return null;
  let clean = phoneStr.replace(/[^\d]/g, '');
  if (clean.length === 10) {
    clean = '91' + clean;
  }
  return clean;
}

/**
 * Deep website crawler to find email addresses
 */
async function crawlWebsiteForEmails(browser, url) {
  if (!url) return null;
  let page = null;
  try {
    log(`Crawling website: ${url} for contact emails...`);
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setDefaultNavigationTimeout(8000); // 8s snappy limit for homepage loading
    
    // EXTREME MEMORY SAVER: Block heavy images, stylesheets, fonts, and media from loading
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Attempt to load the homepage
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const content = await page.content();
    let emails = content.match(EMAIL_REGEX) || [];
    
    // De-duplicate emails
    emails = [...new Set(emails)].filter(email => {
      const lower = email.toLowerCase();
      // Filter out obvious image assets or false positives
      return !lower.endsWith('.png') && !lower.endsWith('.jpg') && !lower.endsWith('.jpeg') && !lower.endsWith('.gif') && !lower.endsWith('.webp');
    });

    if (emails.length > 0) {
      log(`Found email(s) on homepage: ${emails.join(', ')}`);
      await page.close();
      return emails[0];
    }

    // If no email on homepage, search for common subpages like contact or about
    const subpages = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links
        .map(a => a.href)
        .filter(href => {
          if (!href) return false;
          const h = href.toLowerCase();
          return h.includes('contact') || h.includes('about') || h.includes('support') || h.includes('reach');
        });
    });

    const uniqueSubpages = [...new Set(subpages)].slice(0, 2); // Limit to top 2 links to keep it super responsive
    for (const subpageUrl of uniqueSubpages) {
      try {
        log(`Checking contact/about page: ${subpageUrl}...`);
        await page.setDefaultNavigationTimeout(5000); // 5s tight timeout for contact pages
        await page.goto(subpageUrl, { waitUntil: 'domcontentloaded' });
        const subContent = await page.content();
        let subEmails = subContent.match(EMAIL_REGEX) || [];
        subEmails = [...new Set(subEmails)].filter(e => {
          const l = e.toLowerCase();
          return !l.endsWith('.png') && !l.endsWith('.jpg') && !l.endsWith('.jpeg') && !l.endsWith('.gif');
        });
        if (subEmails.length > 0) {
          log(`Found email on subpage ${subpageUrl}: ${subEmails[0]}`);
          await page.close();
          return subEmails[0];
        }
      } catch (subErr) {
        log(`Failed crawling subpage ${subpageUrl}: ${subErr.message}`);
      }
    }
    
    await page.close();
  } catch (err) {
    log(`Failed to crawl website ${url}: ${err.message}`);
    if (page) {
      try { await page.close(); } catch (cErr) {}
    }
  }
  return null;
}

/**
 * Core Google Maps Scraper
 */
export async function scrapeGoogleMapsLeads(keyword, location, limit = 15) {
  scraperStatus = 'SCRAPING';
  const query = `${keyword} in ${location}`;
  currentProgress = { current: 0, total: 0, query };
  log(`Starting scrape run for: "${query}" (Limit: ${limit} leads)`);

  let browser = null;
  const newLeads = [];

  try {
    // Launch browser headlessly with advanced memory optimizations
    browser = await puppeteer.launch({
      headless: true,
      protocolTimeout: 0, // Disables internal protocol timeouts to prevent Runtime.callFunctionOn timed out errors
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-gpu',
        '--no-zygote',
        '--disable-extensions',
        '--disable-default-apps',
        '--no-default-browser-check',
        '--mute-audio',
        '--disable-blink-features=AutomationControlled', // STEALTH FLAG: Hides Puppeteer webdriver automation indicator
        '--js-flags="--max-old-space-size=120"' // Restricts V8 engine memory footprint to keep it extremely lightweight
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1200, height: 900 });

    // MEMORY SAVER: Block heavy images, fonts, and media on Maps page
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    log(`Navigating to Google Maps search...`);
    await page.goto(searchUrl, { waitUntil: 'networkidle2' });

    // Wait a brief period for listings to render
    const delay = (ms) => new Promise(res => setTimeout(res, ms));
    await delay(3000);

    // Scroll the left panel containing the results to load more businesses
    log('Scrolling result feed to load listings...');
    let lastHeight = 0;
    let scrollCount = 0;
    const maxScrolls = 8; // Scroll enough times to load at least 20-30 listings

    while (scrollCount < maxScrolls) {
      try {
        await page.evaluate(() => {
          // In Google Maps, the list container usually has a role="feed" or specific container selector
          const feed = document.querySelector('div[role="feed"]');
          if (feed) {
            feed.scrollTop = feed.scrollHeight;
          }
        });
        await delay(1500);
        scrollCount++;
      } catch (scrollErr) {
        log(`Scroll warning: ${scrollErr.message}`);
        break;
      }
    }

    // Extract links for all listings
    const businessLinks = await page.evaluate(() => {
      // Find all anchors referencing a maps place
      const links = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'));
      return links.map(a => a.href);
    });

    const uniqueLinks = [...new Set(businessLinks)].slice(0, limit);
    log(`Discovered ${businessLinks.length} listings. Selected top ${uniqueLinks.length} unique results.`);
    currentProgress.total = uniqueLinks.length;

    // Load existing database to check for duplicates
    let leadsDb = [];
    try {
      const leadsFile = path.join(process.cwd(), 'leads.json');
      if (fs.existsSync(leadsFile)) {
        leadsDb = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
      }
    } catch (err) {
      log(`Error reading leads.json: ${err.message}`);
    }

    // Close the primary search page as we don't need it anymore
    await page.close();

    const concurrency = 3; // 3 worker tabs in parallel
    const leadsFile = path.join(process.cwd(), 'leads.json');

    for (let i = 0; i < uniqueLinks.length; i += concurrency) {
      const batch = uniqueLinks.slice(i, i + concurrency);
      
      const batchPromises = batch.map(async (link, index) => {
        const globalIndex = i + index;
        log(`Scraping lead ${globalIndex + 1}/${uniqueLinks.length} (Parallel Worker): ${link}`);
        
        let workerPage = null;
        try {
          workerPage = await browser.newPage();
          await workerPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
          await workerPage.setViewport({ width: 1200, height: 900 });
          await workerPage.setDefaultNavigationTimeout(20000); // 20s timeout for GMB detail loading

          // Go to listing detail view
          await workerPage.goto(link, { waitUntil: 'domcontentloaded' });
          await delay(1800); // Snappy wait for details panel to settle

          // Extract detail elements
          const details = await workerPage.evaluate(() => {
            const getElementText = (sel) => {
              const el = document.querySelector(sel);
              return el ? el.innerText.trim() : null;
            };

            // Title
            const name = getElementText('h1') || getElementText('.DUw3O') || 'Unknown';

            // Rating and reviews
            const ratingText = getElementText('.F7nice span[aria-hidden="true"]') || '0';
            const reviewsTextRaw = getElementText('.F7nice span:nth-child(2)') || '(0)';
            const rating = parseFloat(ratingText) || 0;
            const reviewsCount = parseInt(reviewsTextRaw.replace(/[^\d]/g, '')) || 0;

            // Address
            const address = getElementText('button[data-item-id="address"]') || getElementText('.Io6YTe') || '';

            // Phone Number
            const phoneBtn = document.querySelector('button[data-item-id^="phone:tel:"]');
            const phone = phoneBtn ? phoneBtn.getAttribute('data-item-id').replace('phone:tel:', '').trim() : null;

            // Website
            const websiteBtn = document.querySelector('a[data-item-id="authority"]');
            const website = websiteBtn ? websiteBtn.getAttribute('href') : null;

            // Business type/category
            const category = getElementText('button[class*="D72N1"]') || getElementText('.fontBodyMedium span') || '';

            return { name, rating, reviewsCount, address, phone, website, category };
          });

          // Add missing fields and log
          details.mapsUrl = link;
          details.scrapedAt = new Date().toISOString();
          details.location = location;
          details.normalizedPhone = normalizePhone(details.phone);
          details.email = null;
          details.status = 'NEW';
          details.emailSent = false;
          details.whatsappSent = false;
          details.notes = '';

          log(`[Worker] Scraped details for: "${details.name}" | Rating: ${details.rating} | Phone: ${details.phone || 'N/A'} | Web: ${details.website || 'N/A'}`);

          // Check if duplicate in our database
          const isDuplicate = leadsDb.some(lead => 
            (lead.normalizedPhone && lead.normalizedPhone === details.normalizedPhone) || 
            (lead.name.toLowerCase() === details.name.toLowerCase() && lead.location.toLowerCase() === details.location.toLowerCase())
          );

          if (isDuplicate) {
            log(`[Worker] Skipping duplicate GMB lead: "${details.name}"`);
            return;
          }

          // Deep email crawl if website is present
          if (details.website) {
            const websiteEmail = await crawlWebsiteForEmails(browser, details.website);
            if (websiteEmail) {
              details.email = websiteEmail;
            }
          }

          // Qualify lead - Target GMB listings lacking website or GMB unoptimized
          let isHighPotential = false;
          let qualificationReason = '';

          if (!details.website) {
            isHighPotential = true;
            qualificationReason = 'No website found (High Priority Web Target)';
          } else if (details.rating > 0 && details.rating < 4.1 && details.reviewsCount > 3) {
            isHighPotential = true;
            qualificationReason = `Low rating (${details.rating}) but active GMB (GMB Optimization/Revamp Target)`;
          }

          details.isHighPotential = isHighPotential;
          details.qualificationReason = qualificationReason;

          // Save new lead thread-safe push and incremental write
          newLeads.push(details);
          leadsDb.push(details);
          
          fs.writeFileSync(
            leadsFile, 
            JSON.stringify(leadsDb, null, 2)
          );

        } catch (leadErr) {
          log(`Failed scraping individual GMB listing [${link}]: ${leadErr.message}`);
        } finally {
          if (workerPage) {
            try { await workerPage.close(); } catch (err) {}
          }
        }
      });

      // Run this batch in parallel and wait
      await Promise.all(batchPromises);
      currentProgress.current = Math.min(i + concurrency, uniqueLinks.length);
    }

    log(`Scraping run completed successfully. Generated ${newLeads.length} brand new leads!`);
    scraperStatus = 'COMPLETED';

  } catch (error) {
    log(`Scraper execution crashed: ${error.message}`);
    scraperStatus = 'ERROR';
  } finally {
    if (browser) {
      try {
        await browser.close();
        log('Browser closed safely.');
      } catch (err) {}
    }
  }

  return newLeads;
}
