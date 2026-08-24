"use client";

import Link from "next/link";
import { SignInButton } from "@clerk/nextjs";
import { BILLING_PACKS } from "@/lib/billing-plans";

const FEATURES = [
  {
    title: "1080p Cloud Rendering",
    body: "Cinema-grade vertical exports rendered in the cloud — no local GPU required.",
  },
  {
    title: "AI Kinetic Captions",
    body: "Punchy 2–3 word blocks with thick high-contrast outlines that stay readable on any B-roll.",
  },
  {
    title: "Dynamic Pexels Integration",
    body: "Topic-aware portrait stock clips sourced automatically for every generation.",
  },
];

export default function LandingPage() {
  return (
    <div className="relative min-h-full overflow-hidden bg-zinc-950 text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(99,102,241,0.22),_transparent_55%),radial-gradient(ellipse_at_bottom_right,_rgba(139,92,246,0.16),_transparent_45%)]" />

      <header className="relative z-10 border-b border-white/5">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="brand-glow text-lg font-semibold tracking-tight">
            AutoClips<span className="bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">.ai</span>
          </Link>

          <nav className="hidden items-center gap-8 text-sm text-zinc-300 md:flex">
            <a href="#features" className="transition hover:text-white">
              Features
            </a>
            <a href="#pricing" className="transition hover:text-white">
              Pricing
            </a>
          </nav>

          <SignInButton mode="modal">
            <button
              type="button"
              className="animate-pulse-border rounded-full border border-indigo-400/60 bg-zinc-950/80 px-4 py-2 text-sm font-semibold text-white transition hover:border-indigo-300 hover:bg-indigo-500/10"
            >
              Sign In
            </button>
          </SignInButton>
        </div>
      </header>

      <main className="relative z-10">
        <section className="mx-auto flex max-w-4xl flex-col items-center px-4 pb-20 pt-16 text-center sm:px-6 sm:pt-24">
          <p className="mb-5 text-xs font-semibold uppercase tracking-[0.28em] text-indigo-300">
            AutoClips.ai Creator OS
          </p>
          <h1 className="text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl">
            Automate Your Social Growth. Generate Viral Short-Form Videos in Seconds.
          </h1>
          <p className="mt-6 max-w-2xl text-pretty text-base leading-relaxed text-zinc-300 sm:text-lg">
            Script, caption, source footage, and render scroll-stopping 9:16 clips from a single
            prompt — built for creators who ship daily.
          </p>

          <SignInButton mode="modal">
            <button
              type="button"
              className="mt-10 inline-flex items-center justify-center rounded-full bg-gradient-to-r from-indigo-500 via-violet-500 to-indigo-500 bg-[length:200%_100%] px-8 py-3.5 text-sm font-semibold text-white shadow-[0_0_40px_rgba(99,102,241,0.35)] transition hover:bg-right"
            >
              Start Creating Free
            </button>
          </SignInButton>
        </section>

        <section id="features" className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
          <div className="mb-8 text-center">
            <h2 className="text-2xl font-semibold text-white">Everything in one workspace</h2>
            <p className="mt-2 text-sm text-zinc-400">
              Premium tooling wrapped in a calm, high-signal interface.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {FEATURES.map((feature) => (
              <article
                key={feature.title}
                className="glass-card rounded-2xl p-6 transition duration-300 hover:-translate-y-1 hover:border-indigo-400/30"
              >
                <div className="mb-4 h-1 w-12 rounded-full bg-gradient-to-r from-indigo-400 to-violet-400" />
                <h3 className="text-lg font-semibold text-white">{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-400">{feature.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="pricing" className="mx-auto max-w-4xl px-4 pb-24 text-center sm:px-6">
          <p className="text-sm font-medium text-indigo-300">Simple pricing</p>
          <h2 className="mt-2 text-3xl font-semibold text-white">Credits that match how you create</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm text-zinc-400">
            Start with 3 free videos. Subscribe monthly or top up anytime — no unlimited plans.
          </p>
          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            <article className="glass-card rounded-3xl p-8 text-left">
              <p className="text-sm font-medium text-indigo-300">{BILLING_PACKS.starter.label}</p>
              <h3 className="mt-2 text-3xl font-semibold text-white">
                ${BILLING_PACKS.starter.priceUsd}
                <span className="text-base font-medium text-zinc-400">/mo</span>
              </h3>
              <p className="mt-3 text-sm text-zinc-400">
                {BILLING_PACKS.starter.credits} videos per month. Top up +
                {BILLING_PACKS.starter.credits} for ${BILLING_PACKS.starter.priceUsd} anytime.
              </p>
            </article>
            <article className="glass-card rounded-3xl border border-indigo-400/30 p-8 text-left">
              <p className="text-sm font-medium text-indigo-300">{BILLING_PACKS.creator.label}</p>
              <h3 className="mt-2 text-3xl font-semibold text-white">
                ${BILLING_PACKS.creator.priceUsd}
                <span className="text-base font-medium text-zinc-400">/mo</span>
              </h3>
              <p className="mt-3 text-sm text-zinc-400">
                {BILLING_PACKS.creator.credits} videos per month. Top up +
                {BILLING_PACKS.creator.credits} for ${BILLING_PACKS.creator.priceUsd} anytime.
              </p>
            </article>
          </div>
          <SignInButton mode="modal">
            <button
              type="button"
              className="mt-8 rounded-full bg-white px-6 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200"
            >
              Start with 3 free videos
            </button>
          </SignInButton>
        </section>
      </main>
    </div>
  );
}
