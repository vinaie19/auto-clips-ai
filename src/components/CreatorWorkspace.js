"use client";

import { SignInButton, UserButton } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";

const SUBTITLE_THEMES = ["Viral Yellow", "Cyberpunk Neon", "Clean Minimalist"];
const VIDEO_TONES = ["Moody", "Corporate", "Cinematic"];
const LEMON_CHECKOUT =
  "https://autoclips.lemonsqueezy.com/checkout/buy/placeholder-unlimited-29";

const PRE_QUEUE_LOADER = "Drafting AI Script & Queueing Render...";

function loaderTextForShotstackStatus(status) {
  if (status === "queued" || status === "fetching") {
    return "Positioned in Cloud Queue...";
  }
  if (status === "rendering" || status === "saving") {
    return "Stitching Pexels HD Clips & Captions...";
  }
  return null;
}

export default function CreatorWorkspace() {
  const [topic, setTopic] = useState("");
  const [subtitleTheme, setSubtitleTheme] = useState("Viral Yellow");
  const [tone, setTone] = useState("Cinematic");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [loaderText, setLoaderText] = useState(PRE_QUEUE_LOADER);
  const [videoUrl, setVideoUrl] = useState(null);
  const [error, setError] = useState(null);
  const [showPaywall, setShowPaywall] = useState(false);
  const [credits, setCredits] = useState(null);
  const [isPremium, setIsPremium] = useState(false);
  const [history, setHistory] = useState([]);
  const pollRef = useRef(null);

  const isBusy = isGenerating || isPolling;

  const refreshProfile = useCallback(async () => {
    const response = await fetch("/api/me", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to load profile.");
    setCredits(data.freeCreditsRemaining);
    setIsPremium(Boolean(data.isPremium));
  }, []);

  const refreshHistory = useCallback(async () => {
    const response = await fetch("/api/videos", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to load history.");
    setHistory(data.videos || []);
  }, []);

  useEffect(() => {
    let alive = true;

    async function bootstrap() {
      try {
        const [meRes, historyRes] = await Promise.all([
          fetch("/api/me", { cache: "no-store" }),
          fetch("/api/videos", { cache: "no-store" }),
        ]);
        const meData = await meRes.json();
        const historyData = await historyRes.json();
        if (!alive) return;

        if (meRes.ok) {
          setCredits(meData.freeCreditsRemaining);
          setIsPremium(Boolean(meData.isPremium));
        }
        if (historyRes.ok) {
          setHistory(historyData.videos || []);
        }
      } catch (err) {
        console.error(err);
      }
    }

    void bootstrap();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setIsPolling(false);
  }

  /**
   * Poll Shotstack status via our backend every 3s until done/failed/timeout.
   */
  function pollUntilReady(statusUrl) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 60;

      const tick = async () => {
        attempts += 1;
        try {
          const response = await fetch(statusUrl, { cache: "no-store" });
          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || "Status poll failed.");
          }

          const status = data.status;
          const mapped = loaderTextForShotstackStatus(status);
          if (mapped) setLoaderText(mapped);

          if (status === "done" && data.url) {
            stopPolling();
            resolve(data.url);
            return;
          }

          if (status === "failed") {
            stopPolling();
            reject(new Error(data.error || "Shotstack render failed."));
            return;
          }

          if (attempts >= maxAttempts) {
            stopPolling();
            reject(new Error("Render timed out. Try again in a moment."));
          }
        } catch (err) {
          if (attempts >= maxAttempts) {
            stopPolling();
            reject(err);
          }
          // Transient network blips: keep interval alive until timeout
        }
      };

      setIsPolling(true);
      void tick();
      pollRef.current = setInterval(tick, 3000);
    });
  }

  async function handleGenerate(event) {
    event.preventDefault();
    const trimmed = topic.trim();
    if (!trimmed || isBusy) return;

    stopPolling();
    setIsGenerating(true);
    setLoaderText(PRE_QUEUE_LOADER);
    setError(null);
    setShowPaywall(false);
    setVideoUrl(null);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: trimmed, tone, subtitleTheme }),
      });
      const data = await response.json();

      if (response.status === 403 && data.code === "PAYWALL_REQUIRED") {
        setShowPaywall(true);
        throw new Error(data.error || "Upgrade required.");
      }

      if (!response.ok) {
        throw new Error(data.error || "Generation request failed.");
      }

      if (typeof data.freeCreditsRemaining === "number") {
        setCredits(data.freeCreditsRemaining);
      }
      if (typeof data.isPremium === "boolean") {
        setIsPremium(data.isPremium);
      }

      const statusUrl =
        data.statusUrl ||
        (data.renderId
          ? `/api/generate/status?id=${encodeURIComponent(data.renderId)}`
          : null);

      if (!statusUrl) {
        throw new Error("Backend did not return a renderId or statusUrl.");
      }

      setLoaderText("Positioned in Cloud Queue...");
      const mp4Url = await pollUntilReady(statusUrl);
      setVideoUrl(mp4Url);
      setLoaderText("");
      await refreshHistory();
      await refreshProfile();
    } catch (err) {
      console.error("Generate flow error:", err);
      setError(err.message || "Something went wrong while generating your video.");
      setVideoUrl(null);
    } finally {
      setIsGenerating(false);
      stopPolling();
    }
  }

  return (
    <div className="relative min-h-full bg-zinc-950 text-white">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(99,102,241,0.16),_transparent_50%)]" />

      <header className="relative z-10 border-b border-white/5 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="brand-glow text-lg font-semibold tracking-tight">
            AutoClips<span className="bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">.ai</span>
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            <div className="rounded-full border border-white/10 bg-zinc-900/80 px-3 py-1.5 text-xs font-medium text-zinc-200">
              {isPremium
                ? "Unlimited · Premium"
                : `${credits ?? "—"} credit${credits === 1 ? "" : "s"} left`}
            </div>
            {!isPremium && (
              <a
                href={LEMON_CHECKOUT}
                target="_blank"
                rel="noopener noreferrer"
                className="hidden rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 px-3 py-1.5 text-xs font-semibold text-white sm:inline-flex"
              >
                Go Unlimited
              </a>
            )}
            <UserButton afterSignOutUrl="/" />
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-6 sm:py-10">
        <div className="grid gap-6 lg:grid-cols-2">
          <form onSubmit={handleGenerate} className="space-y-4">
            <section className="glass-card rounded-2xl p-5 sm:p-6">
              <label className="block space-y-2">
                <span className="text-sm font-medium text-zinc-200">Video prompt</span>
                <textarea
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  rows={5}
                  placeholder="e.g. Sarcastic Corporate Survival Hacks"
                  disabled={isBusy}
                  required
                  className="w-full resize-none rounded-xl border border-white/10 bg-zinc-950/70 px-4 py-3 text-white placeholder:text-zinc-500 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/40 disabled:opacity-60"
                />
              </label>
            </section>

            <section className="glass-card rounded-2xl p-5 sm:p-6">
              <p className="mb-3 text-sm font-medium text-zinc-200">Subtitle style theme</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {SUBTITLE_THEMES.map((theme) => (
                  <button
                    key={theme}
                    type="button"
                    disabled={isBusy}
                    onClick={() => setSubtitleTheme(theme)}
                    className={`rounded-xl border px-3 py-3 text-left text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
                      subtitleTheme === theme
                        ? "border-indigo-400/70 bg-indigo-500/15 text-white"
                        : "border-white/10 bg-zinc-950/50 text-zinc-300 hover:border-white/20"
                    }`}
                  >
                    {theme}
                  </button>
                ))}
              </div>
            </section>

            <section className="glass-card rounded-2xl p-5 sm:p-6">
              <p className="mb-3 text-sm font-medium text-zinc-200">Video tone</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {VIDEO_TONES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    disabled={isBusy}
                    onClick={() => setTone(option)}
                    className={`rounded-xl border px-3 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
                      tone === option
                        ? "border-violet-400/70 bg-violet-500/15 text-white"
                        : "border-white/10 bg-zinc-950/50 text-zinc-300 hover:border-white/20"
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </section>

            <button
              type="submit"
              disabled={isBusy || !topic.trim()}
              aria-busy={isBusy}
              className="inline-flex w-full items-center justify-center gap-3 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-5 py-3.5 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isBusy ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  {loaderText || "Working..."}
                </>
              ) : (
                "Generate AI Video"
              )}
            </button>

            {error && !showPaywall && (
              <div
                role="alert"
                className="rounded-xl border-2 border-red-500/50 bg-red-500/15 px-4 py-4 text-sm font-medium text-red-100 shadow-[0_0_24px_rgba(239,68,68,0.15)]"
              >
                <p className="font-semibold text-red-200">Render failed</p>
                <p className="mt-1 text-red-100/90">{error}</p>
              </div>
            )}
          </form>

          <section className="glass-card flex flex-col overflow-hidden rounded-2xl">
            <div className="relative mx-auto aspect-[9/16] w-full max-w-sm bg-zinc-950">
              {videoUrl && !isBusy ? (
                <div className="flex h-full flex-col">
                  <video
                    key={videoUrl}
                    src={videoUrl}
                    controls
                    playsInline
                    className="h-full w-full object-cover opacity-0 animate-fade-in"
                  />
                </div>
              ) : isBusy ? (
                <div className="relative flex h-full flex-col items-center justify-center overflow-hidden bg-[linear-gradient(180deg,#18181b_0%,#09090b_100%)] px-8 text-center">
                  <div className="animate-scan pointer-events-none absolute inset-x-0 h-24 bg-gradient-to-b from-transparent via-indigo-400/25 to-transparent" />
                  <span className="relative z-10 mb-4 h-8 w-8 animate-spin rounded-full border-2 border-indigo-400/30 border-t-indigo-300" />
                  <p className="relative z-10 text-sm font-medium text-zinc-100">
                    {loaderText}
                  </p>
                  <p className="relative z-10 mt-2 text-xs text-zinc-500">
                    Polling cloud render status every 3 seconds…
                  </p>
                </div>
              ) : (
                <div className="relative flex h-full flex-col items-center justify-center overflow-hidden bg-[linear-gradient(180deg,#18181b_0%,#09090b_100%)] px-8 text-center">
                  <div className="animate-scan pointer-events-none absolute inset-x-0 h-24 bg-gradient-to-b from-transparent via-indigo-400/25 to-transparent" />
                  <p className="relative z-10 text-sm font-medium text-zinc-200">
                    Rendering engine ready
                  </p>
                  <p className="relative z-10 mt-2 text-xs text-zinc-500">
                    Your vertical MP4 preview will appear here.
                  </p>
                </div>
              )}
            </div>
            {videoUrl && !isBusy && (
              <div className="border-t border-white/5 p-4">
                <a
                  href={videoUrl}
                  download
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex w-full items-center justify-center rounded-xl border border-white/10 bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:border-indigo-400/40 hover:bg-zinc-800"
                >
                  Download Clip
                </a>
              </div>
            )}
          </section>
        </div>

        <section>
          <div className="mb-4 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-white">History log</h2>
              <p className="text-sm text-zinc-400">Previous clips generated by your account.</p>
            </div>
          </div>

          {history.length === 0 ? (
            <div className="glass-card rounded-2xl px-5 py-10 text-center text-sm text-zinc-500">
              No renders yet — generate your first clip above.
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {history.map((item) => (
                <article key={item.id} className="glass-card overflow-hidden rounded-2xl">
                  <div className="aspect-[9/16] max-h-56 bg-zinc-900">
                    {item.video_url ? (
                      <video
                        src={item.video_url}
                        poster={item.thumbnail_url || undefined}
                        muted
                        playsInline
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-zinc-500">
                        {item.status || "processing"}
                      </div>
                    )}
                  </div>
                  <div className="space-y-1 p-4">
                    <p className="line-clamp-2 text-sm font-medium text-white">{item.prompt}</p>
                    <p className="text-xs text-zinc-500">
                      {item.tone || "—"} · {item.subtitle_theme || "—"}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      {showPaywall && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="glass-card w-full max-w-md rounded-2xl p-6 text-center shadow-2xl">
            <p className="text-sm font-medium text-indigo-300">Premium required</p>
            <h3 className="mt-2 text-2xl font-semibold text-white">You&apos;re out of free credits</h3>
            <p className="mt-3 text-sm text-zinc-400">
              Upgrade to AutoClips Unlimited for continuous generation and priority rendering.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <a
                href={LEMON_CHECKOUT}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-3 text-sm font-semibold text-white"
              >
                Go Unlimited ($29/mo)
              </a>
              <button
                type="button"
                onClick={() => setShowPaywall(false)}
                className="flex-1 rounded-xl border border-white/10 px-4 py-3 text-sm font-semibold text-zinc-200"
              >
                Not now
              </button>
            </div>
            <div className="mt-4 text-xs text-zinc-500">
              Already upgraded?{" "}
              <SignInButton mode="modal">
                <button type="button" className="text-indigo-300 underline">
                  Refresh session
                </button>
              </SignInButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
