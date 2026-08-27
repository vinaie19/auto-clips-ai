"use client";

import { UserButton, useAuth } from "@clerk/nextjs";
import { BILLING_PACKS, getPaddlePriceIds } from "@/lib/billing-plans";
import {
  closePaddleCheckout,
  isPaddleConfigured,
  openPaddleCheckout,
  PADDLE_FRAME_TARGET,
  setPaddleCheckoutListener,
} from "@/lib/paddle-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SUBTITLE_THEMES,
  TTS_VOICE_BY_TONE,
  VIDEO_TONES,
  VIDEO_DURATIONS,
  ASPECT_RATIOS,
  VISUAL_STYLES,
} from "@/lib/render-constants";

const SUBTITLE_THEME_OPTIONS = Object.entries(SUBTITLE_THEMES).map(
  ([id, theme]) => ({
    id,
    color: theme.color,
    stroke: theme.strokeColor,
    textTransform: theme.textTransform,
    sample: theme.sample,
    blurb: theme.blurb,
  })
);

const VIDEO_TONE_OPTIONS = Object.entries(VIDEO_TONES).map(([id, tone]) => ({
  id,
  blurb: tone.blurb,
  defaultVoice: tone.defaultVoice,
}));

const VIDEO_STYLE_OPTIONS = [
  { id: "auto", label: "Auto", blurb: "Auto — match the look to your topic automatically." },
  ...VISUAL_STYLES.map(({ id, label, blurb }) => ({ id, label, blurb })),
];

const DURATION_OPTIONS = Object.values(VIDEO_DURATIONS).map((d) => ({
  id: String(d.seconds),
  seconds: d.seconds,
  label: d.label,
  blurb: d.blurb,
  credits: d.credits,
}));

const ASPECT_OPTIONS = Object.values(ASPECT_RATIOS).map((a) => ({
  id: a.id,
  label: a.label,
  blurb: a.blurb,
  width: a.width,
  height: a.height,
}));

const TTS_VOICES = [
  { id: "alloy", label: "Alloy", description: "Neutral, balanced" },
  { id: "echo", label: "Echo", description: "Warm male" },
  { id: "fable", label: "Fable", description: "British storyteller" },
  { id: "onyx", label: "Onyx", description: "Deep, authoritative" },
  { id: "nova", label: "Nova", description: "Bright female" },
  { id: "shimmer", label: "Shimmer", description: "Soft, expressive" },
];

const PRE_QUEUE_LOADER = "Queueing your render...";

function formatStatus(status, progress) {
  if (!status) return "Unknown";
  if (status === "done") return "Ready";
  if (status === "failed") return "Failed";
  if (status === "expired") return "Expired";
  if (progress === "preparing") return "Preparing";
  if (progress === "rendering") return "Rendering";
  if (status === "running" || status === "claimed") {
    return progress === "preparing" ? "Preparing" : "Rendering";
  }
  if (status === "pending" || status === "queued") return "Queued";
  return status;
}

function busyStatusMessage(status, progress) {
  const label = formatStatus(status, progress);
  if (label === "Queued") return "Positioned in render queue...";
  if (label === "Preparing") return "Writing script & picking B-roll...";
  if (label === "Rendering") return "Stitching clips, captions & voiceover...";
  return "Working on your video…";
}

export function checkoutSettlementGranted({ beforeCredits, currentCredits }) {
  return (
    beforeCredits != null &&
    Number.isFinite(Number(beforeCredits)) &&
    Number.isFinite(Number(currentCredits)) &&
    Number(currentCredits) > Number(beforeCredits)
  );
}

function formatDate(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function CaptionSample({ theme, compact = false }) {
  return (
    <div
      className={`relative overflow-hidden rounded-lg bg-[linear-gradient(160deg,#1a1a1f_0%,#0a0a0c_100%)] text-center ${
        compact ? "px-2 py-3" : "px-3 py-5"
      }`}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(99,102,241,0.2),transparent_55%)]" />
      <p
        className={`relative font-black leading-tight tracking-wide ${
          compact ? "text-[11px]" : "text-sm"
        }`}
        style={{
          color: theme.color,
          textTransform: theme.textTransform,
          textShadow: `
            -2px -2px 0 ${theme.stroke},
             2px -2px 0 ${theme.stroke},
            -2px  2px 0 ${theme.stroke},
             2px  2px 0 ${theme.stroke},
             0 0 10px ${theme.color}55
          `,
        }}
      >
        {theme.sample}
      </p>
    </div>
  );
}

/**
 * Custom dropdown with hover preview panel (captions) or description (tones).
 */
function HoverSelect({
  label,
  hint,
  value,
  options,
  disabled,
  onChange,
  variant = "caption", // caption | tone
}) {
  const [open, setOpen] = useState(false);
  const [hoveredId, setHoveredId] = useState(value);
  const rootRef = useRef(null);

  const selected = options.find((o) => o.id === value) || options[0];
  const preview = options.find((o) => o.id === hoveredId) || selected;

  useEffect(() => {
    if (!open) return undefined;
    function onDoc(e) {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) setHoveredId(value);
  }, [open, value]);

  return (
    <div ref={rootRef} className={`relative ${open ? "z-50" : "z-0"}`}>
      {label ? (
        <p className="mb-1 text-sm font-medium text-zinc-200">{label}</p>
      ) : null}
      {hint ? <p className="mb-3 text-xs text-zinc-500">{hint}</p> : null}

      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-zinc-950/70 px-3 py-3 text-left transition hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {variant === "caption" && selected?.color ? (
          <span
            className="h-3 w-3 shrink-0 rounded-full ring-1 ring-white/25"
            style={{ backgroundColor: selected.color }}
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white">
          {selected?.label || selected?.id || "Auto"}
        </span>
        <span className="text-xs text-zinc-500">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-50 mt-2 overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl shadow-black/50">
          <div className="grid sm:grid-cols-[1fr_minmax(140px,180px)]">
            <ul
              role="listbox"
              aria-label={label || "Options"}
              className="max-h-64 overflow-y-auto border-b border-white/5 sm:border-b-0 sm:border-r"
            >
              {options.map((option) => {
                const active = option.id === value;
                const hovered = option.id === hoveredId;
                return (
                  <li key={option.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      onMouseEnter={() => setHoveredId(option.id)}
                      onFocus={() => setHoveredId(option.id)}
                      onClick={() => {
                        onChange(option.id);
                        setOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm transition ${
                        hovered || active
                          ? "bg-indigo-500/15 text-white"
                          : "text-zinc-300 hover:bg-white/5"
                      }`}
                    >
                      {variant === "caption" && option.color ? (
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-white/20"
                          style={{ backgroundColor: option.color }}
                        />
                      ) : null}
                      <span className="font-medium">
                        {option.label || option.id || "Auto"}
                      </span>
                      {active ? (
                        <span className="ml-auto text-[10px] text-indigo-300">
                          Selected
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="hidden bg-zinc-900/80 p-3 sm:block">
              {variant === "caption" && preview ? (
                <>
                  <CaptionSample theme={preview} compact />
                  <div className="mt-2 flex items-center justify-center gap-2">
                    <span
                      className="h-2.5 w-2.5 rounded-full ring-1 ring-white/20"
                      style={{ backgroundColor: preview.color }}
                    />
                    <span
                      className="h-2.5 w-2.5 rounded-full ring-1 ring-white/20"
                      style={{ backgroundColor: preview.stroke }}
                    />
                  </div>
                  <p className="mt-2 text-[11px] leading-snug text-zinc-400">
                    {preview.blurb}
                  </p>
                </>
              ) : preview ? (
                <>
                  <p className="text-xs font-semibold text-violet-200">
                    {preview.id}
                  </p>
                  <p className="mt-2 text-[11px] leading-snug text-zinc-300">
                    {preview.blurb}
                  </p>
                </>
              ) : null}
            </div>
          </div>

          {/* Mobile: show preview under list for hovered/selected */}
          <div className="border-t border-white/5 p-3 sm:hidden">
            {variant === "caption" && preview ? (
              <>
                <CaptionSample theme={preview} compact />
                <p className="mt-2 text-[11px] leading-snug text-zinc-400">
                  {preview.blurb}
                </p>
              </>
            ) : preview ? (
              <p className="text-[11px] leading-snug text-zinc-300">
                {preview.blurb}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function NavIcon({ name }) {
  if (name === "generate") {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
        <path
          d="M12 5v14M5 12h14"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
      <rect
        x="3"
        y="5"
        width="18"
        height="14"
        rx="2"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="M10 9l6 3-6 3V9z" fill="currentColor" />
    </svg>
  );
}

export default function CreatorWorkspace() {
  const { userId: clerkUserId } = useAuth();
  const paddlePrices = getPaddlePriceIds();
  const paddleReady = isPaddleConfigured();

  const [topic, setTopic] = useState("");
  const [subtitleTheme, setSubtitleTheme] = useState("Viral Yellow");
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [tone, setTone] = useState("Cinematic");
  const [visualStyle, setVisualStyle] = useState("auto");
  const [voice, setVoice] = useState(TTS_VOICE_BY_TONE.Cinematic);
  const [targetDurationSeconds, setTargetDurationSeconds] = useState(45);
  const [aspectRatio, setAspectRatio] = useState("9:16");
  const [previewingVoice, setPreviewingVoice] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [loaderText, setLoaderText] = useState(PRE_QUEUE_LOADER);
  const [error, setError] = useState(null);
  const [showPaywall, setShowPaywall] = useState(false);
  /** When set, paywall shows the branded inline Paddle frame for this price. */
  const [checkoutPriceId, setCheckoutPriceId] = useState(null);
  const [credits, setCredits] = useState(null);
  const [isPremium, setIsPremium] = useState(false);
  const [history, setHistory] = useState([]);
  /** @type {"generate" | "videos"} */
  const [nav, setNav] = useState("generate");
  const [selectedVideoId, setSelectedVideoId] = useState(null);
  const previewAudioRef = useRef(null);
  const previewUrlRef = useRef(null);
  const mainRef = useRef(null);
  const creditsBeforeCheckoutRef = useRef(null);

  const refreshProfile = useCallback(async () => {
    const response = await fetch("/api/me", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to load profile.");
    setCredits(data.freeCreditsRemaining);
    setIsPremium(Boolean(data.isPremium));
    return data;
  }, []);

  const dismissPaywall = useCallback(() => {
    setCheckoutPriceId(null);
    setShowPaywall(false);
    setError(null);
    void closePaddleCheckout();
  }, []);

  /** After Paddle pays, close overlays and poll until webhook grants credits. */
  const settleAfterCheckout = useCallback(async () => {
    await closePaddleCheckout();
    setCheckoutPriceId(null);
    setShowPaywall(false);
    setError(null);

    let before = creditsBeforeCheckoutRef.current;
    if (before == null && typeof window !== "undefined") {
      const raw = sessionStorage.getItem("paddle_credits_before");
      if (raw != null && raw !== "") before = Number(raw);
    }
    for (let i = 0; i < 12; i += 1) {
      try {
        const data = await refreshProfile();
        if (
          checkoutSettlementGranted({
            beforeCredits: before,
            currentCredits: data.freeCreditsRemaining,
          })
        ) {
          if (typeof window !== "undefined") {
            sessionStorage.removeItem("paddle_credits_before");
          }
          return;
        }
      } catch {
        // Keep polling — webhook may still be in flight.
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }, [refreshProfile]);

  useEffect(() => {
    setPaddleCheckoutListener((event) => {
      const name = String(event?.name || "");
      if (name === "checkout.completed") {
        // Prefer a full reload via successUrl; this is a fallback if still on-page.
        const successUrl = `${window.location.origin}/?checkout=success`;
        if (!window.location.search.includes("checkout=success")) {
          window.location.assign(successUrl);
          return;
        }
        void settleAfterCheckout();
      }
    });
    return () => setPaddleCheckoutListener(null);
  }, [settleAfterCheckout]);

  // Landed from Paddle successUrl redirect — drop query and refresh credits.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") !== "success") return undefined;

    window.history.replaceState({}, "", window.location.pathname);
    setCheckoutPriceId(null);
    setShowPaywall(false);
    void settleAfterCheckout();
    return undefined;
  }, [settleAfterCheckout]);

  const startCheckout = useCallback(
    (priceId) => {
      const id = String(priceId || "").trim();
      if (!paddleReady) {
        setError(
          "Billing is not configured yet. Set NEXT_PUBLIC_PADDLE_CLIENT_TOKEN in .env.local and restart npm run dev."
        );
        setShowPaywall(true);
        return;
      }
      if (!id) {
        setError(
          "Missing Paddle price id. Set NEXT_PUBLIC_PADDLE_PRICE_* in .env.local and restart npm run dev."
        );
        setShowPaywall(true);
        return;
      }
      setError(null);
      creditsBeforeCheckoutRef.current = credits;
      try {
        if (credits != null && Number.isFinite(Number(credits))) {
          sessionStorage.setItem("paddle_credits_before", String(credits));
        } else {
          sessionStorage.removeItem("paddle_credits_before");
        }
      } catch {
        // ignore
      }
      setShowPaywall(true);
      setCheckoutPriceId(id);
    },
    [credits, paddleReady]
  );

  // Mount branded inline checkout once the frame element is in the DOM.
  useEffect(() => {
    if (!checkoutPriceId || !showPaywall) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await openPaddleCheckout(checkoutPriceId, clerkUserId);
        } catch (err) {
          if (!cancelled) {
            setError(err?.message || "Could not open checkout.");
            setCheckoutPriceId(null);
          }
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [checkoutPriceId, showPaywall, clerkUserId]);

  const isBusy = isGenerating;

  const selectedVideo = useMemo(
    () => history.find((item) => item.id === selectedVideoId) || null,
    [history, selectedVideoId]
  );

  const pollsRef = useRef(new Map());
  const [pollingIds, setPollingIds] = useState(() => new Set());

  useEffect(() => {
    return () => {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current = null;
      }
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      for (const id of pollsRef.current.values()) clearInterval(id);
      pollsRef.current.clear();
    };
  }, []);

  function markPolling(videoId, active) {
    if (!videoId) return;
    setPollingIds((prev) => {
      const next = new Set(prev);
      if (active) next.add(videoId);
      else next.delete(videoId);
      return next;
    });
  }

  function stopPolling(videoId) {
    if (videoId) {
      const handle = pollsRef.current.get(videoId);
      if (handle) clearInterval(handle);
      pollsRef.current.delete(videoId);
      markPolling(videoId, false);
      return;
    }
    for (const [id, handle] of pollsRef.current.entries()) {
      clearInterval(handle);
      markPolling(id, false);
    }
    pollsRef.current.clear();
  }

  async function previewVoiceSample(voiceId) {
    if (isBusy || previewingVoice) return;
    setPreviewingVoice(voiceId);
    setError(null);
    try {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current = null;
      }
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }

      const response = await fetch("/api/voice-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice: voiceId }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Voice preview failed.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      audio.onended = () => setPreviewingVoice(null);
      await audio.play();
    } catch (err) {
      setError(err.message || "Voice preview failed.");
      setPreviewingVoice(null);
    }
  }

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

  function goGenerate() {
    setNav("generate");
    setSelectedVideoId(null);
    setError(null);
  }

  function goVideosLibrary() {
    setNav("videos");
    setSelectedVideoId(null);
    setError(null);
  }

  function openVideo(videoId) {
    if (!videoId) return;
    setNav("videos");
    setSelectedVideoId(videoId);
    setError(null);
    requestAnimationFrame(() => {
      mainRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function upsertHistoryItem(item) {
    setHistory((prev) => {
      const rest = prev.filter((v) => v.id !== item.id);
      return [item, ...rest];
    });
  }

  function patchHistoryItem(videoId, patch) {
    setHistory((prev) =>
      prev.map((item) => (item.id === videoId ? { ...item, ...patch } : item))
    );
  }

  function pollUntilReady(statusUrl, videoId) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 300;
      const key = videoId || statusUrl;

      stopPolling(key);

      const tick = async () => {
        attempts += 1;
        try {
          const response = await fetch(statusUrl, { cache: "no-store" });
          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || "Status poll failed.");
          }

          const status = data.status;

          if (videoId) {
            patchHistoryItem(videoId, {
              status,
              progress: data.progress || null,
              video_url: data.url || null,
              thumbnail_url: data.poster || null,
              error: data.error || null,
            });
          }

          if (status === "done" && data.url) {
            stopPolling(key);
            resolve(data.url);
            return;
          }

          if (status === "failed") {
            stopPolling(key);
            reject(new Error(data.error || "Render failed."));
            return;
          }

          if (attempts >= maxAttempts) {
            stopPolling(key);
            reject(
              new Error(
                "Render timed out after waiting ~15 minutes. Check the worker logs — downloads or FFmpeg may still be running."
              )
            );
          }
        } catch (err) {
          if (attempts >= maxAttempts) {
            stopPolling(key);
            reject(err);
          }
        }
      };

      markPolling(key, true);
      void tick();
      pollsRef.current.set(key, setInterval(tick, 3000));
    });
  }

  async function runPollFlow(statusUrl, videoId, { creditHint } = {}) {
    try {
      await pollUntilReady(statusUrl, videoId);
      if (typeof creditHint?.freeCreditsRemaining === "number") {
        setCredits(creditHint.freeCreditsRemaining);
      }
      await refreshHistory();
      await refreshProfile();
    } catch (err) {
      console.error("Background poll error:", err);
      patchHistoryItem(videoId, {
        status: "failed",
        error: err?.message || "Render failed.",
      });
      await refreshHistory().catch(() => {});
      await refreshProfile().catch(() => {});
    }
  }

  async function handleRetry(videoId) {
    if (!videoId || isBusy) return;

    openVideo(videoId);
    setIsGenerating(true);
    setLoaderText("Requeueing failed render...");
    setError(null);
    setShowPaywall(false);
    patchHistoryItem(videoId, { status: "pending", error: null, video_url: null });

    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(videoId)}/retry`, {
        method: "POST",
      });
      const data = await response.json();

      if (response.status === 403 && data.code === "PAYWALL_REQUIRED") {
        setCheckoutPriceId(null);
        setShowPaywall(true);
        throw new Error(data.error || "Upgrade required.");
      }

      if (!response.ok) {
        throw new Error(data.error || "Retry request failed.");
      }

      if (typeof data.freeCreditsRemaining === "number") {
        setCredits(data.freeCreditsRemaining);
      }

      const statusUrl =
        data.statusUrl ||
        (data.renderId
          ? `/api/generate/status?id=${encodeURIComponent(data.renderId)}`
          : null);

      if (!statusUrl) {
        throw new Error("Backend did not return a renderId or statusUrl.");
      }

      setIsGenerating(false);
      setLoaderText("");
      void runPollFlow(statusUrl, videoId);
    } catch (err) {
      console.error("Retry flow error:", err);
      setError(err.message || "Something went wrong while retrying your video.");
      await refreshHistory();
      await refreshProfile();
      setIsGenerating(false);
    }
  }

  async function handleGenerate(event) {
    event.preventDefault();
    const trimmed = topic.trim();
    if (!trimmed || isBusy) return;

    setIsGenerating(true);
    setLoaderText(PRE_QUEUE_LOADER);
    setError(null);
    setShowPaywall(false);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: trimmed,
          tone,
          visualStyle:
            visualStyle && visualStyle !== "auto" ? visualStyle : undefined,
          subtitleTheme,
          voice,
          captionsEnabled,
          targetDurationSeconds,
          aspectRatio,
        }),
      });
      const data = await response.json();

      if (response.status === 403 && data.code === "PAYWALL_REQUIRED") {
        setCheckoutPriceId(null);
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

      const videoId = data.videoId || data.renderId;
      if (!videoId) {
        throw new Error("Backend did not return a video id.");
      }

      upsertHistoryItem({
        id: videoId,
        prompt: trimmed,
        tone,
        subtitle_theme: subtitleTheme,
        script: data.script || null,
        video_url: null,
        thumbnail_url: null,
        status: "pending",
        render_id: videoId,
        error: null,
        attempts: 0,
        created_at: new Date().toISOString(),
        targetDurationSeconds,
        aspectRatio,
      });

      // Clear the form for the next run, then show this job on Videos.
      setTopic("");
      setLoaderText("");
      setIsGenerating(false);
      openVideo(videoId);

      const statusUrl =
        data.statusUrl ||
        `/api/generate/status?id=${encodeURIComponent(videoId)}`;

      void runPollFlow(statusUrl, videoId, {
        creditHint: {
          freeCreditsRemaining: data.freeCreditsRemaining,
        },
      });
    } catch (err) {
      console.error("Generate flow error:", err);
      setError(err.message || "Something went wrong while generating your video.");
      await refreshHistory();
      await refreshProfile();
      setIsGenerating(false);
      setLoaderText("");
    }
  }

  const watchingBusy =
    Boolean(selectedVideoId) && pollingIds.has(selectedVideoId);

  const selectedAspect = selectedVideo?.aspectRatio || "9:16";
  const playerAspectClass =
    selectedAspect === "16:9"
      ? "aspect-video max-w-3xl"
      : selectedAspect === "1:1"
        ? "aspect-square max-w-md"
        : "aspect-[9/16] max-w-[280px]";

  const navItems = [
    { id: "generate", label: "Generate" },
    { id: "videos", label: "Videos" },
  ];

  return (
    <div className="relative min-h-full bg-zinc-950 text-white">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(99,102,241,0.16),_transparent_50%)]" />

      <header className="relative z-10 border-b border-white/5 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="brand-glow text-lg font-semibold tracking-tight">
            Short Clips
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            <div className="rounded-full border border-white/10 bg-zinc-900/80 px-3 py-1.5 text-xs font-medium text-zinc-200">
              {credits ?? "—"} credit{credits === 1 ? "" : "s"} left
              {isPremium ? " · subscribed" : ""}
            </div>
            <button
              type="button"
              className="hidden rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 px-3 py-1.5 text-xs font-semibold text-white sm:inline-flex"
              onClick={() => {
                setCheckoutPriceId(null);
                setShowPaywall(true);
              }}
            >
              Get credits
            </button>
            <UserButton afterSignOutUrl="/" />
          </div>
        </div>
      </header>

      <div className="relative z-10 mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:flex-row lg:items-start">
        <aside className="w-full shrink-0 lg:sticky lg:top-6 lg:w-56">
          <nav
            aria-label="Workspace"
            className="glass-card flex gap-2 rounded-2xl p-2 lg:flex-col"
          >
            {navItems.map((item) => {
              const active = nav === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() =>
                    item.id === "generate" ? goGenerate() : goVideosLibrary()
                  }
                  className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-3 text-sm font-semibold transition lg:justify-start ${
                    active
                      ? "bg-indigo-500/20 text-white"
                      : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                  }`}
                >
                  <NavIcon name={item.id} />
                  {item.label}
                  {item.id === "videos" && history.length > 0 ? (
                    <span className="ml-auto hidden rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-zinc-300 lg:inline">
                      {history.length}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1" ref={mainRef}>
          {nav === "generate" && (
            <form onSubmit={handleGenerate} className="mx-auto max-w-2xl space-y-4">
              <div>
                <h1 className="text-xl font-semibold text-white">Generate</h1>
                <p className="text-sm text-zinc-400">
                  Prompt, length, voice, and captions — then send it to the render
                  queue.
                </p>
              </div>

              <section className="glass-card rounded-2xl p-5 sm:p-6">
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-zinc-200">
                    Video prompt
                  </span>
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
                <p className="mb-1 text-sm font-medium text-zinc-200">Length</p>
                <p className="mb-3 text-xs text-zinc-500">
                  Longer clips use more credits (30s=2 · 45s=3 · 60s=4).
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {DURATION_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      disabled={isBusy}
                      title={option.blurb}
                      onClick={() => setTargetDurationSeconds(option.seconds)}
                      className={`rounded-xl border px-3 py-3 text-center transition disabled:cursor-not-allowed disabled:opacity-60 ${
                        targetDurationSeconds === option.seconds
                          ? "border-indigo-400/70 bg-indigo-500/15 text-white"
                          : "border-white/10 bg-zinc-950/50 text-zinc-300 hover:border-white/20"
                      }`}
                    >
                      <span className="block text-sm font-semibold">
                        {option.label}
                      </span>
                      <span className="mt-1 block text-[10px] font-medium text-indigo-300/90">
                        {option.credits} credits
                      </span>
                      <span className="mt-0.5 block text-[10px] text-zinc-500">
                        {option.blurb}
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="glass-card rounded-2xl p-5 sm:p-6">
                <p className="mb-1 text-sm font-medium text-zinc-200">
                  Aspect ratio
                </p>
                <p className="mb-3 text-xs text-zinc-500">
                  Frame size for the finished MP4.
                </p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {ASPECT_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      disabled={isBusy}
                      title={option.blurb}
                      onClick={() => setAspectRatio(option.id)}
                      className={`rounded-xl border px-3 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                        aspectRatio === option.id
                          ? "border-violet-400/70 bg-violet-500/15 text-white"
                          : "border-white/10 bg-zinc-950/50 text-zinc-300 hover:border-white/20"
                      }`}
                    >
                      <span className="block text-sm font-semibold">
                        {option.label}
                      </span>
                      <span className="mt-1 block text-[10px] text-zinc-500">
                        {option.blurb}
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="relative z-30 glass-card rounded-2xl p-5 sm:p-6">
                <HoverSelect
                  label="Video tone"
                  hint="Open the menu and hover to read each vibe."
                  value={tone}
                  options={VIDEO_TONE_OPTIONS}
                  disabled={isBusy}
                  variant="tone"
                  onChange={(next) => {
                    setTone(next);
                    setVoice(TTS_VOICE_BY_TONE[next] || "nova");
                  }}
                />
              </section>

              <section className="relative z-20 glass-card rounded-2xl p-5 sm:p-6">
                <HoverSelect
                  label="Visual style"
                  hint="Pick the footage look. Leave on Auto to match the topic."
                  value={visualStyle}
                  options={VIDEO_STYLE_OPTIONS}
                  disabled={isBusy}
                  variant="tone"
                  onChange={(next) => setVisualStyle(next)}
                />
              </section>

              <section className="relative z-10 glass-card rounded-2xl p-5 sm:p-6">
                <p className="mb-1 text-sm font-medium text-zinc-200">
                  Narrator voice
                </p>
                <p className="mb-3 text-xs text-zinc-500">
                  Preview a short sample. Tone picks a matching default.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {TTS_VOICES.map((option) => {
                    const selected = voice === option.id;
                    const loading = previewingVoice === option.id;
                    return (
                      <div
                        key={option.id}
                        className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 transition ${
                          selected
                            ? "border-violet-400/70 bg-violet-500/15"
                            : "border-white/10 bg-zinc-950/50"
                        }`}
                      >
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => setVoice(option.id)}
                          className="min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <span className="block text-sm font-semibold text-white">
                            {option.label}
                          </span>
                          <span className="block text-[11px] text-zinc-400">
                            {option.description}
                          </span>
                        </button>
                        <button
                          type="button"
                          disabled={isBusy || Boolean(previewingVoice)}
                          onClick={() => previewVoiceSample(option.id)}
                          aria-label={`Preview ${option.label} voice`}
                          className="shrink-0 rounded-lg border border-white/15 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-200 transition hover:border-white/30 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {loading ? "…" : "Preview"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section
                className={`glass-card rounded-2xl p-5 sm:p-6 ${
                  captionsEnabled ? "relative z-10" : "relative z-0"
                }`}
              >
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-zinc-200">Captions</p>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={captionsEnabled}
                    disabled={isBusy}
                    onClick={() => setCaptionsEnabled((v) => !v)}
                    className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-60 ${
                      captionsEnabled ? "bg-indigo-500" : "bg-zinc-700"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white transition ${
                        captionsEnabled ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
                <p className="mb-3 text-xs text-zinc-500">
                  {captionsEnabled
                    ? "Burned-in captions on the video"
                    : "No captions — voiceover only"}
                </p>
                {captionsEnabled && (
                  <HoverSelect
                    label="Subtitle style"
                    hint="Open the menu and hover options to preview colors."
                    value={subtitleTheme}
                    options={SUBTITLE_THEME_OPTIONS}
                    disabled={isBusy}
                    variant="caption"
                    onChange={setSubtitleTheme}
                  />
                )}
              </section>

              <button
                type="submit"
                disabled={isBusy || !topic.trim()}
                aria-busy={isBusy}
                className="inline-flex w-full items-center justify-center gap-3 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-5 py-3.5 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isBusy && nav === "generate" && !selectedVideoId ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    {loaderText || "Working..."}
                  </>
                ) : (
                  "Generate AI Video"
                )}
              </button>

              {error && !showPaywall && nav === "generate" && !selectedVideoId && (
                <div
                  role="alert"
                  className="rounded-xl border-2 border-red-500/50 bg-red-500/15 px-4 py-4 text-sm font-medium text-red-100"
                >
                  <p className="font-semibold text-red-200">Couldn’t start</p>
                  <p className="mt-1 text-red-100/90">{error}</p>
                </div>
              )}
            </form>
          )}

          {nav === "videos" && !selectedVideoId && (
            <div className="space-y-5">
              <div>
                <h1 className="text-xl font-semibold text-white">Videos</h1>
                <p className="text-sm text-zinc-400">
                  Your library — open a card to play and see details.
                </p>
              </div>

              {history.length === 0 ? (
                <div className="glass-card rounded-2xl px-6 py-16 text-center">
                  <p className="text-sm text-zinc-400">No videos yet.</p>
                  <button
                    type="button"
                    onClick={goGenerate}
                    className="mt-4 text-sm font-semibold text-indigo-300 hover:text-indigo-200"
                  >
                    Generate your first clip
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
                  {history.map((item) => {
                    const itemBusy =
                      watchingBusy && selectedVideoId === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => openVideo(item.id)}
                        className="group glass-card overflow-hidden rounded-2xl text-left transition hover:ring-2 hover:ring-indigo-400/40"
                      >
                        <div
                          className={`relative bg-zinc-900 ${
                            item.aspectRatio === "16:9"
                              ? "aspect-video"
                              : item.aspectRatio === "1:1"
                                ? "aspect-square"
                                : "aspect-[9/16]"
                          }`}
                        >                          {item.thumbnail_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={item.thumbnail_url}
                              alt=""
                              className="h-full w-full object-cover transition group-hover:scale-[1.02]"
                            />
                          ) : item.video_url ? (
                            <video
                              src={item.video_url}
                              muted
                              playsInline
                              preload="metadata"
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center">
                              {(item.status === "pending" ||
                                item.status === "claimed" ||
                                item.status === "running" ||
                                itemBusy) && (
                                <span className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-400/30 border-t-indigo-300" />
                              )}
                              <span className="text-xs font-medium text-zinc-400">
                                {formatStatus(item.status, item.progress)}
                              </span>
                            </div>
                          )}
                          <span className="absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-100 backdrop-blur">
                            {formatStatus(item.status, item.progress)}
                          </span>
                        </div>
                        <div className="space-y-1 p-3">
                          <p className="line-clamp-2 text-sm font-medium text-zinc-100">
                            {item.prompt || "Untitled"}
                          </p>
                          <p className="text-[11px] text-zinc-500">
                            {formatDate(item.created_at)}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {nav === "videos" && selectedVideo && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={goVideosLibrary}
                    className="text-xs font-medium text-indigo-300 hover:text-indigo-200"
                  >
                    ← All videos
                  </button>
                  <h1 className="mt-2 text-xl font-semibold text-white">
                    {selectedVideo.prompt || "Untitled clip"}
                  </h1>
                  <p className="mt-1 text-sm text-zinc-400">
                    {formatStatus(selectedVideo.status, selectedVideo.progress)} ·{" "}
                    {formatDate(selectedVideo.created_at)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={goGenerate}
                  className="rounded-xl border border-white/10 px-3 py-2 text-sm font-semibold text-zinc-200 hover:bg-white/5"
                >
                  Generate another
                </button>
              </div>

              <div className="grid gap-4 lg:grid-cols-[minmax(0,280px)_1fr]">
                <section className="glass-card overflow-hidden rounded-2xl">
                  <div
                    className={`relative mx-auto w-full bg-zinc-950 ${playerAspectClass}`}
                  >
                    {watchingBusy ||
                    ["pending", "claimed", "running", "queued"].includes(
                      selectedVideo.status
                    ) ? (
                      <div className="relative flex h-full flex-col items-center justify-center overflow-hidden bg-[linear-gradient(180deg,#18181b_0%,#09090b_100%)] px-6 text-center">
                        <div className="animate-scan pointer-events-none absolute inset-x-0 h-24 bg-gradient-to-b from-transparent via-indigo-400/25 to-transparent" />
                        <span className="relative z-10 mb-4 h-8 w-8 animate-spin rounded-full border-2 border-indigo-400/30 border-t-indigo-300" />
                        <p className="relative z-10 text-sm font-medium text-zinc-100">
                          {busyStatusMessage(
                            selectedVideo.status,
                            selectedVideo.progress
                          )}
                        </p>
                        <p className="relative z-10 mt-2 text-xs text-zinc-500">
                          Status updates every few seconds
                        </p>
                      </div>
                    ) : selectedVideo.video_url ? (
                      <video
                        key={selectedVideo.video_url}
                        src={selectedVideo.video_url}
                        poster={selectedVideo.thumbnail_url || undefined}
                        controls
                        playsInline
                        className="h-full w-full object-cover animate-fade-in"
                      />
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                        <p className="text-sm font-medium text-zinc-300">
                          {selectedVideo.status === "failed"
                            ? "Render failed"
                            : "No preview yet"}
                        </p>
                        <p className="mt-2 text-xs text-zinc-500">
                          {selectedVideo.status === "failed"
                            ? "Retry from the details panel."
                            : "This clip hasn’t finished rendering."}
                        </p>
                      </div>
                    )}
                  </div>
                  {selectedVideo.video_url && !watchingBusy && (
                    <div className="border-t border-white/5 p-3">
                      <a
                        href={selectedVideo.video_url}
                        download
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex w-full items-center justify-center rounded-xl border border-white/10 bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:border-indigo-400/40 hover:bg-zinc-800"
                      >
                        Download clip
                      </a>
                    </div>
                  )}
                </section>

                <section className="glass-card space-y-4 rounded-2xl p-5 sm:p-6">
                  <h2 className="text-sm font-semibold text-white">Details</h2>
                  <dl className="grid gap-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-zinc-500">Status</dt>
                      <dd className="mt-0.5 font-medium text-zinc-100">
                        {formatStatus(selectedVideo.status, selectedVideo.progress)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-zinc-500">Created</dt>
                      <dd className="mt-0.5 font-medium text-zinc-100">
                        {formatDate(selectedVideo.created_at)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-zinc-500">Length</dt>
                      <dd className="mt-0.5 font-medium text-zinc-100">
                        {selectedVideo.targetDurationSeconds
                          ? `${selectedVideo.targetDurationSeconds}s`
                          : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-zinc-500">Aspect</dt>
                      <dd className="mt-0.5 font-medium text-zinc-100">
                        {selectedVideo.aspectRatio || "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-zinc-500">Tone</dt>
                      <dd className="mt-0.5 font-medium text-zinc-100">
                        {selectedVideo.tone || "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-zinc-500">Subtitles</dt>
                      <dd className="mt-0.5 font-medium text-zinc-100">
                        {selectedVideo.subtitle_theme || "—"}
                      </dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="text-xs text-zinc-500">Prompt</dt>
                      <dd className="mt-0.5 text-zinc-200">
                        {selectedVideo.prompt || "—"}
                      </dd>
                    </div>
                    {selectedVideo.script ? (
                      <div className="sm:col-span-2">
                        <dt className="text-xs text-zinc-500">Script</dt>
                        <dd className="mt-0.5 whitespace-pre-wrap text-zinc-300">
                          {selectedVideo.script}
                        </dd>
                      </div>
                    ) : null}
                    {selectedVideo.error ? (
                      <div className="sm:col-span-2">
                        <dt className="text-xs text-red-400">Error</dt>
                        <dd className="mt-0.5 text-red-200/90">
                          {selectedVideo.error}
                        </dd>
                      </div>
                    ) : null}
                  </dl>

                  {selectedVideo.status === "failed" && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleRetry(selectedVideo.id)}
                      className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-50"
                    >
                      Retry render
                    </button>
                  )}

                  {error && !showPaywall && (
                    <div
                      role="alert"
                      className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100"
                    >
                      {error}
                    </div>
                  )}
                </section>
              </div>
            </div>
          )}
        </main>
      </div>

      {showPaywall && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-950/80 p-3 backdrop-blur-md sm:p-4">
          <div
            className={`glass-card relative z-[101] w-full max-h-[min(92vh,720px)] overflow-y-auto rounded-2xl border border-indigo-400/20 text-center shadow-[0_0_48px_rgba(99,102,241,0.18)] ${
              checkoutPriceId
                ? "max-w-lg px-4 py-4 sm:px-5 sm:py-5"
                : "max-w-lg p-6"
            }`}
          >
            {!checkoutPriceId ? (
              <div className="mx-auto mb-4 h-1 w-16 rounded-full bg-gradient-to-r from-indigo-500 to-violet-500" />
            ) : null}
            <p className="text-sm font-medium text-indigo-300">
              {checkoutPriceId ? "Secure checkout" : "Out of credits"}
            </p>
            <h3
              className={`mt-1.5 font-semibold text-white ${
                checkoutPriceId ? "text-xl" : "text-2xl"
              }`}
            >
              {checkoutPriceId
                ? "Complete payment"
                : isPremium
                  ? "Top up to keep generating"
                  : "Subscribe to keep generating"}
            </h3>
            {!checkoutPriceId ? (
              <p className="mt-3 text-sm text-zinc-400">
                {isPremium ? (
                  <>
                    Add +{BILLING_PACKS.starter.credits} or +
                    {BILLING_PACKS.creator.credits} credits anytime. Longer videos
                    cost more (30s=2 · 45s=3 · 60s=4).
                  </>
                ) : (
                  <>
                    Starter ${BILLING_PACKS.starter.priceUsd}/mo ·{" "}
                    {BILLING_PACKS.starter.credits} credits · Creator $
                    {BILLING_PACKS.creator.priceUsd}/mo ·{" "}
                    {BILLING_PACKS.creator.credits} credits. Longer videos cost more
                    (30s=2 · 45s=3 · 60s=4). Top-ups unlock after you subscribe.
                  </>
                )}
              </p>
            ) : null}
            {error ? (
              <div
                role="alert"
                className="mt-3 rounded-xl border border-red-500/40 bg-red-500/15 px-3 py-2.5 text-left text-sm text-red-100"
              >
                {error}
              </div>
            ) : null}
            {checkoutPriceId ? (
              <div className="mt-3 overflow-hidden rounded-xl border border-white/10 bg-zinc-950/90 p-1.5 sm:p-2">
                <div className={PADDLE_FRAME_TARGET} />
              </div>
            ) : (
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {!isPremium && (
                  <>
                    <button
                      type="button"
                      onClick={() => startCheckout(paddlePrices.starterSub)}
                      className="rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-3 text-sm font-semibold text-white hover:brightness-110"
                    >
                      Starter ${BILLING_PACKS.starter.priceUsd}/mo
                    </button>
                    <button
                      type="button"
                      onClick={() => startCheckout(paddlePrices.creatorSub)}
                      className="rounded-xl border border-indigo-400/40 bg-indigo-500/10 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500/20"
                    >
                      Creator ${BILLING_PACKS.creator.priceUsd}/mo
                    </button>
                  </>
                )}
                {isPremium && (
                  <>
                    <button
                      type="button"
                      onClick={() => startCheckout(paddlePrices.starterTopup)}
                      className="rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-3 text-sm font-semibold text-white hover:brightness-110"
                    >
                      Top up +{BILLING_PACKS.starter.credits} · $
                      {BILLING_PACKS.starter.priceUsd}
                    </button>
                    <button
                      type="button"
                      onClick={() => startCheckout(paddlePrices.creatorTopup)}
                      className="rounded-xl border border-indigo-400/40 bg-indigo-500/10 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500/20"
                    >
                      Top up +{BILLING_PACKS.creator.credits} · $
                      {BILLING_PACKS.creator.priceUsd}
                    </button>
                  </>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                if (checkoutPriceId) {
                  setCheckoutPriceId(null);
                  void closePaddleCheckout();
                  return;
                }
                dismissPaywall();
              }}
              className="mt-3 w-full rounded-xl border border-white/10 px-4 py-2.5 text-sm font-semibold text-zinc-200 transition hover:border-indigo-400/30 hover:bg-indigo-500/5"
            >
              {checkoutPriceId ? "Back to plans" : "Not now"}
            </button>
            {!checkoutPriceId ? (
              <div className="mt-4 text-xs text-zinc-500">
                Already paid?{" "}
                <button
                  type="button"
                  className="text-indigo-300 underline"
                  onClick={() => {
                    void (async () => {
                      try {
                        await refreshProfile();
                        dismissPaywall();
                      } catch (err) {
                        setError(err?.message || "Could not refresh credits.");
                      }
                    })();
                  }}
                >
                  Refresh credits
                </button>
                .
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
