"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side Supabase client.
 *
 * Uses the public key, which is safe to ship: every table is behind RLS that
 * checks workspace membership, so this client can only ever read the threads
 * belonging to workspaces the signed-in user is a member of.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
