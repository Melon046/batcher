import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { BatchWorkspace } from "@/components/batch-workspace";

export const dynamic = "force-dynamic";

/**
 * The signed-in workspace.
 *
 * Server-rendered so the workspace and its join code are known before the
 * first paint — the shell needs the workspace id for every send, and showing
 * the join code late would make sharing feel broken.
 */
export default async function AppPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", user.id)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!membership) {
    // The signup trigger normally creates one; this covers a project where the
    // migration was applied after the user already existed.
    redirect("/login?error=no_workspace");
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, name, join_code")
    .eq("id", membership.workspace_id)
    .maybeSingle();

  if (!workspace) redirect("/login?error=no_workspace");

  return (
    <BatchWorkspace
      workspaceId={workspace.id}
      workspaceName={workspace.name}
      joinCode={workspace.join_code}
      userEmail={user.email ?? ""}
      defaultName={
        (user.user_metadata?.display_name as string | undefined) ??
        (user.email ? user.email.split("@")[0] : "Teammate")
      }
    />
  );
}
