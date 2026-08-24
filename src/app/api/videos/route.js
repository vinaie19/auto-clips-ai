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
        "id, prompt, tone, subtitle_theme, script, video_url, thumbnail_url, status, render_id, error, attempts, created_at, payload"
      )
      .eq("clerk_user_id", userId)
      .order("created_at", { ascending: false })
      .limit(24);

    if (error) {
      console.error("Supabase videos list error:", error);
      throw new Error("Failed to load video history.");
    }

    return NextResponse.json({
      videos: (data || []).map((row) => {
        const payload =
          row.payload && typeof row.payload === "object" ? row.payload : {};
        return {
          ...row,
          targetDurationSeconds: payload.targetDurationSeconds ?? null,
          aspectRatio: payload.aspectRatio ?? null,
          payload: undefined,
        };
      }),
    });
  } catch (error) {
    console.error("GET /api/videos failed:", error);
    return NextResponse.json(
      { error: error.message || "Unable to load videos." },
      { status: 500 }
    );
  }
}
