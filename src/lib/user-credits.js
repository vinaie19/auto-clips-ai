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
    // Concurrent ensureUserProfile: the other request already inserted this clerk id.
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
 * Deduct one free credit for non-premium users. Premium users are unlimited.
 */
export async function deductCreditIfNeeded(user) {
  if (user.is_premium) {
    return { ...user, free_credits_remaining: user.free_credits_remaining };
  }

  const supabase = getSupabaseAdmin();
  const nextCredits = Math.max(0, Number(user.free_credits_remaining) - 1);

  const { data, error } = await supabase
    .from("users")
    .update({ free_credits_remaining: nextCredits })
    .eq("id", user.id)
    .select("id, clerk_user_id, free_credits_remaining, is_premium")
    .single();

  if (error) {
    console.error("Supabase credit deduct error:", error);
    throw new Error("Failed to deduct generation credit.");
  }

  return data;
}
