import { getSupabaseAdmin } from "./supabase-admin";

const FREE_CREDITS_DEFAULT = 3;

/**
 * Ensure a Clerk user has a profile row. Creates one with 3 free credits if missing.
 */
export async function ensureUserProfile(clerkUserId) {
  const supabase = getSupabaseAdmin();

  const { data: existing, error: selectError } = await supabase
    .from("users")
    .select("id, clerk_user_id, free_credits_remaining, is_premium")
    .eq("clerk_user_id", clerkUserId)
    .maybeSingle();

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
    .select("id, clerk_user_id, free_credits_remaining, is_premium")
    .single();

  if (insertError) {
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
