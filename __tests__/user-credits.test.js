import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeBackoffSeconds,
  isRetryableError,
} from "@/lib/render-constants";
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
      free_credits_remaining: 3,
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

  it("allows users with remaining credits", () => {
    expect(canGenerate({ is_premium: false, free_credits_remaining: 1 })).toBe(true);
  });
});

describe("deductCreditIfNeeded", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it("always reserves via RPC including subscribed users", async () => {
    mockRpc.mockResolvedValue({
      data: {
        id: "u1",
        clerk_user_id: "c1",
        free_credits_remaining: 14,
        is_premium: true,
      },
      error: null,
    });

    const result = await deductCreditIfNeeded({
      id: "u1",
      is_premium: true,
      free_credits_remaining: 15,
    });

    expect(mockRpc).toHaveBeenCalledWith("reserve_free_credit", { p_user_id: "u1" });
    expect(result.free_credits_remaining).toBe(14);
  });

  it("reserves via RPC for free users", async () => {
    mockRpc.mockResolvedValue({
      data: {
        id: "u1",
        clerk_user_id: "c1",
        free_credits_remaining: 2,
        is_premium: false,
      },
      error: null,
    });

    const result = await deductCreditIfNeeded({
      id: "u1",
      is_premium: false,
      free_credits_remaining: 3,
    });

    expect(mockRpc).toHaveBeenCalledWith("reserve_free_credit", { p_user_id: "u1" });
    expect(result.free_credits_remaining).toBe(2);
  });

  it("throws PAYWALL_REQUIRED when RPC returns null", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    await expect(
      deductCreditIfNeeded({ id: "u1", is_premium: true, free_credits_remaining: 0 })
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
      free_credits_remaining: 3,
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
      data: { ...profile, free_credits_remaining: 18 },
      error: null,
    });

    const result = await grantCreditsForClerkUser("clerk_1", 15);
    expect(mockRpc).toHaveBeenCalledWith("grant_credits", {
      p_user_id: "u1",
      p_amount: 15,
    });
    expect(result.free_credits_remaining).toBe(18);
  });
});
