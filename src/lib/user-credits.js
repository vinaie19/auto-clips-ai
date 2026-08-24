import { getSupabaseAdmin } from "./supabase-admin";

const FREE_CREDITS_DEFAULT = 3;
const PROFILE_COLUMNS = "id, clerk_user_id, free_credits_remaining, is_premium";

async function selectProfileByClerkId(supabase, clerkUserId) {
  return supabase
    .from("users")
    .select(PROFILE_COLUMNS)
    .eq("clerk_user_id", clerkUserId)
    .maybeSingle();
}

/**
 * Ensure a Clerk user has a profile row. Creates one with 3 free credits if missing.
 * Safe under concurrent /api/me + /api/videos calls (handles unique races).
 */
export async function ensureUserProfile(clerkUserId) {
  const supabase = getSupabaseAdmin();

  let { data: existing, error: selectError } = await selectProfileByClerkId(
    supabase,
    clerkUserId
  );

  // PGRST303: JWT iat slightly ahead of PostgREST clock — brief retry usually clears it.
  if (selectError?.code === "PGRST303") {
    await new Promise((resolve) => setTimeout(resolve, 250));
    ({ data: existing, error: selectError } = await selectProfileByClerkId(
      supabase,
      clerkUserId
    ));
  }

  if (selectError) {
    console.error("Supabase users select error:", selectError);
    throw new Error("Failed to load user profile.");
  }

  if (existing) return existing;

  const { data: created, error: insertError } = await supabase
    .from("users")
    .insert({
      clerk_user_id: clerkUserId,
      free_credits_remaining: FREE_CREDITS_DEFAULT,
      is_premium: false,
    })
    .select(PROFILE_COLUMNS)
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      const { data: raced, error: retryError } = await selectProfileByClerkId(
        supabase,
        clerkUserId
      );

      if (retryError || !raced) {
        console.error("Supabase users race reselect error:", retryError);
        throw new Error("Failed to load user profile.");
      }

      return raced;
    }

    console.error("Supabase users insert error:", insertError);
    throw new Error("Failed to create user profile.");
  }

  return created;
}

export function canGenerate(user) {
  if (user.is_premium) return true;
  return Number(user.free_credits_remaining) > 0;
}

/**
 * Atomically reserve one free credit (enqueue-time). Premium unchanged.
 * Throws with code PAYWALL if no credits left.
 */
export async function deductCreditIfNeeded(user) {
  if (user.is_premium) {
    return { ...user, free_credits_remaining: user.free_credits_remaining };
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("reserve_free_credit", {
    p_user_id: user.id,
  });

  if (error) {
    console.error("Supabase credit reserve error:", error);
    throw new Error("Failed to deduct generation credit.");
  }

  if (!data) {
    const err = new Error("Free credits exhausted. Upgrade to continue generating.");
    err.code = "PAYWALL_REQUIRED";
    throw err;
  }

  return {
    id: data.id,
    clerk_user_id: data.clerk_user_id,
    free_credits_remaining: data.free_credits_remaining,
    is_premium: data.is_premium,
  };
}

/**
 * Refund one free credit for a terminal failed job (idempotent via credit_refunded).
 */
export async function refundCreditForFailedJob(video) {
  if (!video?.id || !video?.user_id) return null;
  if (video.credit_refunded) return null;

  const supabase = getSupabaseAdmin();

  const { data: marked, error: markError } = await supabase
    .from("videos")
    .update({
      credit_refunded: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", video.id)
    .eq("credit_refunded", false)
    .eq("status", "failed")
    .select("id, user_id")
    .maybeSingle();

  if (markError) {
    console.error("credit_refunded mark error:", markError);
    throw new Error("Failed to mark credit refund.");
  }

  if (!marked) return null;

  const { data: userRow, error: userError } = await supabase
    .from("users")
    .select("id, is_premium")
    .eq("id", marked.user_id)
    .single();

  if (userError) {
    console.error("refund user load error:", userError);
    throw new Error("Failed to load user for credit refund.");
  }

  if (userRow.is_premium) return null;

  const { data, error } = await supabase.rpc("refund_free_credit", {
    p_user_id: marked.user_id,
  });

  if (error) {
    console.error("Supabase credit refund error:", error);
    throw new Error("Failed to refund generation credit.");
  }

  return data;
}
