import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const renderId = searchParams.get("id");

    if (!renderId) {
      return NextResponse.json({ error: "id query param is required." }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { data: video, error } = await supabase
      .from("videos")
      .select(
        "id, status, video_url, thumbnail_url, error, progress, attempts, render_id"
      )
      .eq("id", renderId)
      .eq("clerk_user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("Status lookup error:", error);
      return NextResponse.json({ error: "Failed to fetch render status." }, { status: 500 });
    }

    if (!video) {
      return NextResponse.json({ error: "Render not found." }, { status: 404 });
    }

    return NextResponse.json({
      renderId: video.id,
      status: video.status,
      url: video.video_url || null,
      poster: video.thumbnail_url || null,
      error: video.error || null,
      progress: video.progress || null,
      attempts: video.attempts,
    });
  } catch (error) {
    console.error("GET /api/generate/status failed:", error);
    return NextResponse.json(
      { error: error.message || "Unable to poll render status." },
      { status: 500 }
    );
  }
}
