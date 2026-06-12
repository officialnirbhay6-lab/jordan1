-- schema.sql
-- Run this SQL in your Supabase SQL Editor to set up the database tables for Jordan!

-- 1. Create settings table
CREATE TABLE IF NOT EXISTS public.settings (
    key text PRIMARY KEY,
    value text NOT NULL
);

-- Enable RLS for settings
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

-- Allow read/write access to service role key & anon key for this project
CREATE POLICY "Allow all access to settings" ON public.settings
    FOR ALL
    USING (true)
    WITH CHECK (true);


-- 2. Create leads table
CREATE TABLE IF NOT EXISTS public.leads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_name text NOT NULL,
    category text,
    location text,
    phone text UNIQUE NOT NULL,
    website text,
    email text,
    rating double precision,
    address text,
    has_website boolean DEFAULT false,
    email_sent boolean DEFAULT false,
    wa_sent boolean DEFAULT false,
    notes text,
    scraped_at timestamp with time zone DEFAULT now()
);

-- Enable RLS for leads
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

-- Allow read/write access to service role key & anon key
CREATE POLICY "Allow all access to leads" ON public.leads
    FOR ALL
    USING (true)
    WITH CHECK (true);


-- 3. Create logs table
CREATE TABLE IF NOT EXISTS public.logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message text NOT NULL,
    level text NOT NULL, -- info, error, success
    created_at timestamp with time zone DEFAULT now()
);

-- Enable RLS for logs
ALTER TABLE public.logs ENABLE ROW LEVEL SECURITY;

-- Allow read/write access to service role key & anon key
CREATE POLICY "Allow all access to logs" ON public.logs
    FOR ALL
    USING (true)
    WITH CHECK (true);
