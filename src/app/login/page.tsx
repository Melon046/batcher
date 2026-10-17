"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Status = "idle" | "sending" | "sent" | "error";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim()) return;

    setStatus("sending");
    setMessage("");

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setStatus("error");
      setMessage(error.message);
      return;
    }

    setStatus("sent");
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#07080a] px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8">
          <div className="mb-5 flex h-11 w-11 flex-col justify-center gap-[4px] rounded-xl bg-gradient-to-br from-teal-400 to-emerald-600 px-2.5">
            <span className="h-[2px] w-full rounded-full bg-teal-950/70" />
            <span className="h-[2px] w-full rounded-full bg-teal-950/70" />
            <span className="h-[2px] w-2/3 rounded-full bg-teal-950/70" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Sign in to Batcher
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Magic link only — no password to remember, and the same account
            works on your laptop and your phone.
          </p>
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6">
          {status === "sent" ? (
            <div>
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                ✓
              </div>
              <h2 className="text-base font-medium text-white">Link sent</h2>
              <p className="mt-2 text-sm text-zinc-400">
                Check{" "}
                <span className="font-medium text-zinc-200">{email}</span> and
                open the link on this device.
              </p>
              <p className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.07] px-3 py-2 text-xs leading-relaxed text-amber-200/90">
                Nothing after a minute? Supabase&apos;s built-in sender allows
                only a couple of emails per hour. Wait, or use the dashboard&apos;s{" "}
                <span className="font-medium">Generate link</span> button.
              </p>
              <button
                type="button"
                onClick={() => {
                  setStatus("idle");
                  setMessage("");
                }}
                className="mt-5 text-sm text-teal-400 underline-offset-4 hover:underline"
              >
                Use a different email
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="email"
                  className="mb-1.5 block text-sm font-medium text-zinc-300"
                >
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder-zinc-600 outline-none transition focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/15"
                />
              </div>

              <button
                type="submit"
                disabled={status === "sending"}
                className="w-full rounded-xl bg-teal-400 px-4 py-3 text-sm font-semibold text-teal-950 transition hover:bg-teal-300 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {status === "sending" ? "Sending…" : "Email me a link"}
              </button>

              {status === "error" && (
                <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                  {message}
                </p>
              )}
            </form>
          )}
        </div>

        <p className="mt-6 text-xs leading-relaxed text-zinc-600">
          First sign-in creates your own workspace. To share one with your
          teammate, send them the join code from the sidebar.
        </p>
      </div>
    </main>
  );
}
