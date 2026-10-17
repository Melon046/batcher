import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Join a shared workspace with a code.
 *
 * The lookup has to happen in the `join_workspace` SQL function: before you are
 * a member you cannot SELECT the workspace row at all (that is the point of the
 * RLS policy), so the client could never find the id to insert itself into.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { code?: string };
  const code = body.code?.trim();
  if (!code) {
    return NextResponse.json({ error: "Enter a join code." }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("join_workspace", { code });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ workspaceId: data });
}
