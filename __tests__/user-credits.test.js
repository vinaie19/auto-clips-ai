import { beforeEach, describe, expect, it, vi } from "vitest";
import { canGenerate, deductCreditIfNeeded, ensureUserProfile } from "@/lib/user-credits";

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));

vi.mock("@/lib/supabase-admin", () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}));

describe("ensureUserProfile", () => {
  beforeEach(() => {
    mockFrom.mockReset();
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
  it("allows premium users regardless of remaining credits", () => {
    expect(canGenerate({ is_premium: true, free_credits_remaining: 0 })).toBe(true);
    expect(canGenerate({ is_premium: true, free_credits_remaining: 7 })).toBe(true);
  });

  it("allows free users only while they have credits left", () => {
    expect(canGenerate({ is_premium: false, free_credits_remaining: 3 })).toBe(true);
    expect(canGenerate({ is_premium: false, free_credits_remaining: 1 })).toBe(true);
  });

  it("blocks free users with zero credits", () => {
    expect(canGenerate({ is_premium: false, free_credits_remaining: 0 })).toBe(false);
  });
});

describe("deductCreditIfNeeded", () => {
  it("leaves premium users unchanged without touching the database", async () => {
    const user = { id: "u1", is_premium: true, free_credits_remaining: 5 };
    const result = await deductCreditIfNeeded(user);

    expect(result.free_credits_remaining).toBe(5);
    expect(result.id).toBe("u1");
  });
});