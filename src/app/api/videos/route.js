import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { ensureUserProfile } from "@/lib/user-credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await ensureUserProfile(userId);
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from("videos")
      .select(
        "id, prompt, tone, subtitle_theme, video_url, thumbnail_url, status, render_id, created_at"
      )
      .eq("clerk_user_id", userId)
      .order("created_at", { ascending: false })
      .limit(24);

    if (error) {
      console.error("Supabase videos list error:", error);
      throw new Error("Failed to load video history.");
    }

    return NextResponse.json({ videos: data || [] });
  } catch (error) {
    console.error("GET /api/videos failed:", error);
    return NextResponse.json(
      { error: error.message || "Unable to load videos." },
      { status: 500 }
    );
  }
}
