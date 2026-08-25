/** Browser-only Paddle.js helpers — branded inline checkout. */

const PADDLE_SCRIPT = "https://cdn.paddle.com/paddle/v2/paddle.js";

/** Class name for the inline checkout mount (must match CSS class on the div). */
export const PADDLE_FRAME_TARGET = "paddle-checkout-frame";

/**
 * App palette — keep in sync with globals.css.
 * Overlay accent still needs Paddle dashboard: Checkout → Overlay → brand color #6366f1.
 * Inline chrome uses these via frameStyle + theme dark.
 */
export const PADDLE_BRAND = {
  background: "#09090b",
  foreground: "#ffffff",
  accent: "#6366f1",
  accentTo: "#8b5cf6",
  glass: "rgba(24, 24, 27, 0.72)",
};

const FRAME_STYLE =
  "width:100%;min-width:312px;background-color:transparent;border:none;border-radius:12px;";

let loadPromise = null;
let initialized = false;
/** @type {((event: { name?: string }) => void) | null} */
let checkoutListener = null;

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

function dispatchCheckoutEvent(event) {
  if (typeof checkoutListener === "function") {
    checkoutListener(event);
  }
}

function checkoutDefaults(overrides = {}) {
  return {
    settings: {
      theme: "dark",
      variant: "one-page",
      ...overrides,
    },
  };
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

  if (getEnvironment() === "sandbox" && typeof Paddle.Environment?.set === "function") {
    try {
      Paddle.Environment.set("sandbox");
    } catch {
      // already set
    }
  }

  const defaults = checkoutDefaults();

  if (Paddle.Initialized || initialized) {
    if (typeof Paddle.Update === "function") {
      Paddle.Update({
        eventCallback: dispatchCheckoutEvent,
        checkout: defaults,
      });
    }
    initialized = true;
    return Paddle;
  }

  Paddle.Initialize({
    token,
    eventCallback: dispatchCheckoutEvent,
    checkout: defaults,
  });
  initialized = true;
  return Paddle;
}

/**
 * Register a listener for Paddle checkout events (e.g. checkout.completed).
 * @param {((event: { name?: string }) => void) | null} listener
 */
export function setPaddleCheckoutListener(listener) {
  checkoutListener = listener;
}

/** Close the checkout if Paddle exposes Checkout.close. */
export async function closePaddleCheckout() {
  try {
    const Paddle = await ensurePaddle();
    if (typeof Paddle?.Checkout?.close === "function") {
      Paddle.Checkout.close();
    }
  } catch {
    // Ignore — frame may already be gone.
  }
}

/**
 * Open Paddle inline checkout for a price id, tagging Clerk user for webhooks.
 * Mounts into an element with class {@link PADDLE_FRAME_TARGET}.
 * Redirects back to the app on success so the page reloads with fresh credits.
 * @param {string} priceId
 * @param {string | null | undefined} clerkUserId
 */
export async function openPaddleCheckout(priceId, clerkUserId) {
  const id = String(priceId || "").trim();
  if (!id || id === "#") {
    throw new Error("Missing Paddle price id.");
  }

  const Paddle = await ensurePaddle();
  const successUrl = `${window.location.origin}/?checkout=success`;

  const mount = document.querySelector(`.${PADDLE_FRAME_TARGET}`);
  if (!mount) {
    throw new Error(
      "Checkout mount missing. Render an element with class paddle-checkout-frame first."
    );
  }
  // Clear previous iframe so re-opens don't stack.
  mount.innerHTML = "";

  /** @type {Record<string, unknown>} */
  const openOpts = {
    settings: {
      displayMode: "inline",
      theme: "dark",
      variant: "one-page",
      frameTarget: PADDLE_FRAME_TARGET,
      frameInitialHeight: "380",
      frameStyle: FRAME_STYLE,
      successUrl,
    },
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
