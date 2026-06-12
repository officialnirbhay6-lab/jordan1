# Jordan — WhatsApp Lead Gen & Outreach Agent (90's Kids Digital)

Jordan is a production-ready, automated lead generation and outreach agent designed specifically for **90's Kids Digital** (run by Nirbhay Kumar in Bhagalpur, Bihar). The application rotates daily across key cities in Bihar, extracts local business listings from Google Places using Apify, stores them in Supabase, and performs automated outreach.

If a scraped business has an email but no website, Jordan uses the **Gemini 2.5 Flash** AI brain to draft a personalized, sharp, and witty pitch in **Hinglish** (Hindi + English blend) and sends it via **Resend** (or SMTP fallback). The owner receives a daily WhatsApp digest with the run summary.

## Features

1. **Daily Automation (node-cron)**: Runs daily (default 09:00 AM) to rotate cities and keywords, scraping and performing automated outreach.
2. **AI Brain (Gemini 2.5 Flash)**: Generates highly customized, Hinglish-friendly emails suggesting website builds, local SEO, or ad services.
3. **Outreach Channels**:
   - **Email**: Resend API (Primary) or SMTP Gmail server (Fallback).
   - **WhatsApp**: Green API (REST only) for daily notifications to the owner and direct lead messaging.
4. **Live SSE Logs Terminal**: Real-time terminal log viewer streamed via Server-Sent Events directly from the Express server.
5. **Supabase + Upstash Cache**: Fully persistent database storage for leads, settings, and logs, cached in Upstash Redis for high speed.
6. **Premium Dashboard**: A sleek, dark-themed (Black and Gold) dashboard for lead management, configuration, testing, and logs.

---

## Getting Started

### 1. Database Setup (Supabase)

Copy the SQL commands inside the [schema.sql](file:///c:/Users/Admin/Downloads/90s/jordan/schema.sql) file and run them in your **Supabase SQL Editor** to create the tables (`leads`, `settings`, `logs`).

### 2. Environment Configuration

Create a `.env` file (copied from `.env.example`) and place your credentials there.

```env
PORT=3000
GREEN_API_URL=https://XXXX.api.greenapi.com
GREEN_API_INSTANCE_ID=your_green_api_instance_id
GREEN_API_TOKEN=your_green_api_token
WHATSAPP_OWNER=your_whatsapp_owner_number

APIFY_TOKEN=your_apify_token

SUPABASE_URL=https://your_supabase_project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_KEY=your_supabase_service_role_key

UPSTASH_REDIS_REST_URL=https://your_upstash_redis_url.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_token

GEMINI_API_KEY=your_gemini_api_key
```

### 3. Local Installation & Launch

Run the following commands to install dependencies and launch the server locally:

```bash
# Install packages
npm install

# Run the development server
npm run dev
```

Open your browser and navigate to `http://localhost:3000` to access the dashboard.

---

## Deployment on Railway

This project is fully ready for deployment on **Railway**.

1. Connect your Github repository to Railway.
2. Railway will automatically detect the `railway.toml` and build the application using the configuration:
   - Build environment: `nixpacks`
   - Start command: `node index.js`
3. Add the required environment variables under the **Variables** tab in your Railway service.
