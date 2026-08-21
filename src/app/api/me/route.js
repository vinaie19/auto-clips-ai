import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { ensureUserProfile } from "@/lib/user-credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const profile = await ensureUserProfile(userId);

    return NextResponse.json({
      clerkUserId: profile.clerk_user_id,
      freeCreditsRemaining: profile.free_credits_remaining,
      isPremium: profile.is_premium,
    });
  } catch (error) {
    console.error("GET /api/me failed:", error);
    return NextResponse.json(
      { error: error.message || "Unable to load profile." },
      { status: 500 }
    );
  }
}
