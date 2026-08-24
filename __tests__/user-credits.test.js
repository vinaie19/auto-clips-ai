import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeBackoffSeconds,
  creditsForDuration,
  isRetryableError,
} from "@/lib/render-constants";
import { FREE_CREDITS_DEFAULT } from "@/lib/billing-plans";
import {
  canGenerate,
  deductCreditIfNeeded,
  ensureUserProfile,
  grantCreditsForClerkUser,
} from "@/lib/user-credits";

const { mockFrom, mockRpc } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
}));

vi.mock("@/lib/supabase-admin", () => ({
  getSupabaseAdmin: () => ({ from: mockFrom, rpc: mockRpc }),
}));

describe("creditsForDuration", () => {
  it("maps 30/45/60 to 2/3/4", () => {
    expect(creditsForDuration(30)).toBe(2);
    expect(creditsForDuration(45)).toBe(3);
    expect(creditsForDuration(60)).toBe(4);
    expect(creditsForDuration(99)).toBe(3);
  });
});

describe("computeBackoffSeconds", () => {
  it("grows with attempt and caps at 180", () => {
    expect(computeBackoffSeconds(0)).toBe(30);
    expect(computeBackoffSeconds(1)).toBe(45);
    expect(computeBackoffSeconds(2)).toBe(68);
    expect(computeBackoffSeconds(10)).toBe(180);
  });
});

describe("isRetryableError", () => {
  it("retries network and 5xx-style failures", () => {
    expect(isRetryableError({ message: "fetch failed" })).toBe(true);
    expect(isRetryableError({ status: 503, message: "unavailable" })).toBe(true);
    expect(isRetryableError(new Error("ETIMEDOUT"))).toBe(true);
  });

  it("does not retry bad payload / missing config", () => {
    expect(isRetryableError(new Error("invalid payload"))).toBe(false);
    expect(isRetryableError(new Error("OPENAI_API_KEY is not configured"))).toBe(
      false
    );
  });
});

describe("ensureUserProfile", () => {
  beforeEach(() => {
    mockFrom.mockReset();
    mockRpc.mockReset();
  });

  it("returns the existing row after a concurrent insert race (23505)", async () => {
    const profile = {
      id: "u1",
      clerk_user_id: "clerk_1",
      free_credits_remaining: FREE_CREDITS_DEFAULT,
      is_premium: false,
    };

    const selectMissing = {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    };

    const insertConflict = {
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: null,
            error: { code: "23505", message: "duplicate" },
          }),
        }),
      }),
    };

    const selectFound = {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: profile, error: null }),
        }),
      }),
    };

    mockFrom
      .mockReturnValueOnce(selectMissing)
      .mockReturnValueOnce(insertConflict)
      .mockReturnValueOnce(selectFound);

    await expect(ensureUserProfile("clerk_1")).resolves.toEqual(profile);
  });
});

describe("canGenerate", () => {
  it("blocks users with zero credits even if marked subscribed", () => {
    expect(canGenerate({ is_premium: true, free_credits_remaining: 0 })).toBe(false);
  });

  it("requires enough credits for the requested amount", () => {
    expect(canGenerate({ free_credits_remaining: 2 }, 3)).toBe(false);
    expect(canGenerate({ free_credits_remaining: 3 }, 3)).toBe(true);
    expect(canGenerate({ free_credits_remaining: 1 })).toBe(false);
    expect(canGenerate({ free_credits_remaining: 2 })).toBe(true);
  });
});

describe("deductCreditIfNeeded", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it("reserves the requested amount via RPC", async () => {
    mockRpc.mockResolvedValue({
      data: {
        id: "u1",
        clerk_user_id: "c1",
        free_credits_remaining: 12,
        is_premium: true,
      },
      error: null,
    });

    const result = await deductCreditIfNeeded(
      {
        id: "u1",
        is_premium: true,
        free_credits_remaining: 15,
      },
      3
    );

    expect(mockRpc).toHaveBeenCalledWith("reserve_free_credit", {
      p_user_id: "u1",
      p_amount: 3,
    });
    expect(result.free_credits_remaining).toBe(12);
  });

  it("throws PAYWALL_REQUIRED when RPC returns null", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    await expect(
      deductCreditIfNeeded({ id: "u1", is_premium: true, free_credits_remaining: 0 }, 2)
    ).rejects.toMatchObject({ code: "PAYWALL_REQUIRED" });
  });
});

describe("grantCreditsForClerkUser", () => {
  beforeEach(() => {
    mockFrom.mockReset();
    mockRpc.mockReset();
  });

  it("grants via RPC after ensuring profile", async () => {
    const profile = {
      id: "u1",
      clerk_user_id: "clerk_1",
      free_credits_remaining: FREE_CREDITS_DEFAULT,
      is_premium: false,
    };

    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: profile, error: null }),
        }),
      }),
    });

    mockRpc.mockResolvedValue({
      data: { ...profile, free_credits_remaining: 36 },
      error: null,
    });

    const result = await grantCreditsForClerkUser("clerk_1", 30);
    expect(mockRpc).toHaveBeenCalledWith("grant_credits", {
      p_user_id: "u1",
      p_amount: 30,
    });
    expect(result.free_credits_remaining).toBe(36);
  });
});
