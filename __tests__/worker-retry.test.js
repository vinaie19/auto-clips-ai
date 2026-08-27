import { describe, expect, it } from "vitest";
import { isRetryableError } from "../worker/pipeline/retry.js";

describe("worker isRetryableError", () => {
  it("treats 413 payload-too-large as non-retryable", () => {
    expect(isRetryableError({ status: 413 })).toBe(false);
  });

  it("treats not-configured errors without status as non-retryable", () => {
    expect(
      isRetryableError(
        new Error(
          "R2 not configured: STORAGE_BACKEND=r2 but R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY missing"
        )
      )
    ).toBe(false);
  });
});
