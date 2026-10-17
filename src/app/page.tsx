import Link from "next/link";

/**
 * Public landing page.
 *
 * Its job is to explain the one thing that makes Batcher different from every
 * other chat box: it answers a list, not a message. Everything else on the page
 * supports that idea.
 */
export default function LandingPage() {
  return (
    <main className="min-h-dvh bg-[#07080a] text-zinc-200">
      <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-6 py-8">
        {/* Nav */}
        <header className="flex items-center gap-3">
          <BatchMark />
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-tight text-white">
              Batcher
            </p>
            <p className="text-[11px] text-zinc-500">shared AI workspace</p>
          </div>
          <Link
            href="/login"
            className="ml-auto rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/15"
          >
            Open workspace
          </Link>
        </header>

        {/* Hero */}
        <section className="mt-20 max-w-3xl">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-teal-400/25 bg-teal-400/[0.07] px-3 py-1 text-[11px] font-medium text-teal-300">
            <span className="h-1.5 w-1.5 rounded-full bg-teal-400" />
            Built for two people, not two hundred
          </p>
          <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-white sm:text-5xl">
            Ask eight questions.
            <br />
            <span className="text-teal-300">Get eight answers.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-zinc-400">
            Batcher is a study and build partner you share with one other person.
            Paste a list of questions — one per line — and it works through them
            in order, streaming each answer as it lands. Everything stays in one
            thread you can both read, so nobody has to re-explain the context.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/login"
              className="rounded-xl bg-teal-400 px-5 py-2.5 text-sm font-semibold text-teal-950 transition hover:bg-teal-300"
            >
              Start a batch
            </Link>
            <span className="text-xs text-zinc-500">
              Free tier · magic-link sign-in · no password
            </span>
          </div>
        </section>

        {/* How it works */}
        <section className="mt-20 grid gap-4 sm:grid-cols-3">
          {[
            {
              step: "01",
              title: "Paste your list",
              body: "Numbered list, bullets, or one question per line. Batcher splits it into items — up to eight per send.",
            },
            {
              step: "02",
              title: "Watch it work",
              body: "Each answer streams in on its own. One slow question never blocks the ones after it from showing progress.",
            },
            {
              step: "03",
              title: "Share the thread",
              body: "Send your teammate the join code. They see the same batches, the same answers, the same history.",
            },
          ].map((card) => (
            <div
              key={card.step}
              className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5"
            >
              <p className="font-mono text-[11px] text-teal-400">{card.step}</p>
              <h2 className="mt-2 text-sm font-semibold text-white">
                {card.title}
              </h2>
              <p className="mt-2 text-[13px] leading-relaxed text-zinc-400">
                {card.body}
              </p>
            </div>
          ))}
        </section>

        {/* Why it is cheap */}
        <section className="mt-16 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-6">
          <h2 className="text-sm font-semibold text-white">
            Why it can stay at R15.17/month
          </h2>
          <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-zinc-400">
            Batcher answers items one at a time rather than firing them in
            parallel, which keeps a batch inside a free tier&apos;s per-minute
            limit instead of tripping it. Gemini Flash does the work, Groq catches
            the overflow, and a per-item output cap keeps one long answer from
            eating the budget for the rest.
          </p>
        </section>

        <footer className="mt-auto pt-12 text-xs text-zinc-600">
          Batcher can make mistakes. Verify anything that matters.
        </footer>
      </div>
    </main>
  );
}

/** The mark: three stacked bars — a batch, not a chat bubble. */
function BatchMark() {
  return (
    <div className="flex h-9 w-9 flex-col justify-center gap-[3px] rounded-xl bg-gradient-to-br from-teal-400 to-emerald-600 px-2">
      <span className="h-[2px] w-full rounded-full bg-teal-950/70" />
      <span className="h-[2px] w-full rounded-full bg-teal-950/70" />
      <span className="h-[2px] w-2/3 rounded-full bg-teal-950/70" />
    </div>
  );
}
