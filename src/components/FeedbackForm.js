"use client";

import { useEffect, useId, useRef, useState } from "react";

const INITIAL = { email: "", phone: "", message: "" };

export default function FeedbackForm() {
  const titleId = useId();
  const dialogRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState(INITIAL);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);

  function close() {
    setOpen(false);
  }

  function openModal() {
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return undefined;

    function onKeyDown(event) {
      if (event.key === "Escape") close();
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    dialogRef.current?.querySelector("input, textarea, button")?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function update(key) {
    return (event) => {
      setFields((prev) => ({ ...prev, [key]: event.target.value }));
      if (error) setError(null);
    };
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (status === "submitting") return;

    setStatus("submitting");
    setError(null);

    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || "Something went wrong.");
      }

      setFields(INITIAL);
      setStatus("done");
    } catch (err) {
      setError(err?.message || "Unable to send feedback.");
      setStatus("idle");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-full border border-indigo-400/40 bg-zinc-950/90 px-4 py-3 text-sm font-semibold text-white shadow-[0_8px_30px_rgba(0,0,0,0.45)] backdrop-blur transition hover:border-indigo-300 hover:bg-indigo-500/15 sm:bottom-6 sm:right-6"
      >
        Feedback
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
          <button
            type="button"
            aria-label="Close feedback dialog"
            className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
            onClick={close}
          />

          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-zinc-950 p-5 text-left shadow-2xl sm:p-6"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-indigo-300">
                  Feedback
                </p>
                <h2
                  id={titleId}
                  className="mt-1 text-lg font-semibold text-white"
                >
                  Tell us what you need
                </h2>
                <p className="mt-1 text-sm text-zinc-400">
                  Leave email and phone — we&apos;ll follow up.
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="rounded-lg px-2 py-1 text-lg leading-none text-zinc-400 transition hover:bg-white/5 hover:text-white"
              >
                ×
              </button>
            </div>

            {status === "done" ? (
              <div>
                <p className="text-sm font-medium text-indigo-300">Thanks</p>
                <h3 className="mt-1 text-base font-semibold text-white">
                  We got your message
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                  We&apos;ll reach out by email or phone soon.
                </p>
                <button
                  type="button"
                  onClick={() => setStatus("idle")}
                  className="mt-5 text-sm font-medium text-indigo-300 transition hover:text-indigo-200"
                >
                  Send another
                </button>
              </div>
            ) : (
              <form onSubmit={onSubmit} className="space-y-4" noValidate>
                <label className="block text-sm">
                  <span className="mb-1.5 block text-zinc-300">Email</span>
                  <input
                    type="email"
                    name="email"
                    required
                    autoComplete="email"
                    value={fields.email}
                    onChange={update("email")}
                    placeholder="you@example.com"
                    className="w-full rounded-xl border border-white/10 bg-zinc-900/80 px-3 py-2.5 text-sm text-white outline-none transition placeholder:text-zinc-500 focus:border-indigo-400/50"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1.5 block text-zinc-300">Phone</span>
                  <input
                    type="tel"
                    name="phone"
                    required
                    autoComplete="tel"
                    value={fields.phone}
                    onChange={update("phone")}
                    placeholder="+1 555 000 0000"
                    className="w-full rounded-xl border border-white/10 bg-zinc-900/80 px-3 py-2.5 text-sm text-white outline-none transition placeholder:text-zinc-500 focus:border-indigo-400/50"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1.5 block text-zinc-300">Message</span>
                  <textarea
                    name="message"
                    required
                    rows={4}
                    maxLength={2000}
                    value={fields.message}
                    onChange={update("message")}
                    placeholder="What worked, what didn’t, or what you need help with…"
                    className="w-full resize-y rounded-xl border border-white/10 bg-zinc-900/80 px-3 py-2.5 text-sm text-white outline-none transition placeholder:text-zinc-500 focus:border-indigo-400/50"
                  />
                </label>

                {error ? (
                  <p className="text-sm text-rose-300" role="alert">
                    {error}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={status === "submitting"}
                  className="w-full rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {status === "submitting" ? "Sending…" : "Send feedback"}
                </button>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
