import { createClient } from '@supabase/supabase-js';

function cleanEnvValue(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^['\"]|['\"]$/g, '').trim();
}

function normalizeSupabaseUrl(value: unknown) {
  let cleaned = cleanEnvValue(value);

  if (!cleaned) return '';

  if (!/^https?:\/\//i.test(cleaned)) {
    if (cleaned.includes('.supabase.co')) cleaned = `https://${cleaned}`;
    else if (/^[a-z0-9-]{10,}$/i.test(cleaned)) cleaned = `https://${cleaned}.supabase.co`;
  }

  try {
    const url = new URL(cleaned);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

const rawSupabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const rawSupabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseUrl = normalizeSupabaseUrl(rawSupabaseUrl);
export const supabaseAnonKey = cleanEnvValue(rawSupabaseAnonKey);
export const hasSupabaseConfig = Boolean(supabaseUrl && supabaseAnonKey);
export const supabaseConfigError = !supabaseUrl
  ? 'VITE_SUPABASE_URL is missing or invalid. Use your Supabase Project URL, like https://xxxxx.supabase.co.'
  : !supabaseAnonKey
    ? 'VITE_SUPABASE_ANON_KEY is missing. Use the anon public key, not service_role.'
    : '';

export const supabase = hasSupabaseConfig
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : null;
