import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server-side Supabase client for Route Handlers and Server Components.
 *
 * Reads the session from request cookies, so every query runs *as the
 * signed-in user* and the workspace-membership RLS policies apply. Batcher
 * never needs a service-role key, which means a leak in this app cannot expose
 * another team's workspace.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // Middleware refreshes the session instead, so ignoring is safe.
          }
        },
      },
    },
  );
}
