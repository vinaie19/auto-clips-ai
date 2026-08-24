/** Browser-only Paddle.js helpers for overlay checkout. */

const PADDLE_SCRIPT = "https://cdn.paddle.com/paddle/v2/paddle.js";

let loadPromise = null;
let initialized = false;

function getClientToken() {
  return (
    process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ||
    process.env.NEXT_PUBLIC_PADDLE_TOKEN ||
    ""
  ).trim();
}

function getEnvironment() {
  const raw = (
    process.env.NEXT_PUBLIC_PADDLE_ENV ||
    process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT ||
    ""
  )
    .trim()
    .toLowerCase();
  return raw === "sandbox" || raw === "test" ? "sandbox" : "production";
}

function loadPaddleScript() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Paddle checkout is browser-only."));
  }
  if (window.Paddle) return Promise.resolve(window.Paddle);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${PADDLE_SCRIPT}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(window.Paddle));
      existing.addEventListener("error", () =>
        reject(new Error("Failed to load Paddle.js"))
      );
      if (window.Paddle) resolve(window.Paddle);
      return;
    }

    const script = document.createElement("script");
    script.src = PADDLE_SCRIPT;
    script.async = true;
    script.onload = () => resolve(window.Paddle);
    script.onerror = () => reject(new Error("Failed to load Paddle.js"));
    document.head.appendChild(script);
  });

  return loadPromise;
}

async function ensurePaddle() {
  const token = getClientToken();
  if (!token) {
    throw new Error(
      "Paddle is not configured. Set NEXT_PUBLIC_PADDLE_CLIENT_TOKEN."
    );
  }

  const Paddle = await loadPaddleScript();
  if (!Paddle) throw new Error("Paddle.js failed to initialize.");

  if (!initialized) {
    if (getEnvironment() === "sandbox" && typeof Paddle.Environment?.set === "function") {
      Paddle.Environment.set("sandbox");
    }
    Paddle.Initialize({ token });
    initialized = true;
  }

  return Paddle;
}

/**
 * Open Paddle overlay checkout for a price id, tagging Clerk user for webhooks.
 * @param {string} priceId
 * @param {string | null | undefined} clerkUserId
 */
export async function openPaddleCheckout(priceId, clerkUserId) {
  const id = String(priceId || "").trim();
  if (!id || id === "#") {
    throw new Error("Missing Paddle price id.");
  }

  const Paddle = await ensurePaddle();
  /** @type {Record<string, unknown>} */
  const openOpts = {
    items: [{ priceId: id, quantity: 1 }],
  };
  if (clerkUserId) {
    openOpts.customData = { user_id: String(clerkUserId) };
  }
  Paddle.Checkout.open(openOpts);
}

export function isPaddleConfigured() {
  return Boolean(getClientToken());
}
