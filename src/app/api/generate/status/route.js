import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SHOTSTACK_STATUS_BASE = "https://api.shotstack.io/edit/v1/render";

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

    const apiKey = process.env.SHOTSTACK_API_KEY;
    if (!apiKey || apiKey === "your_shotstack_key_here") {
      return NextResponse.json(
        { error: "SHOTSTACK_API_KEY is not configured on the server." },
        { status: 500 }
      );
    }

    const response = await fetch(`${SHOTSTACK_STATUS_BASE}/${encodeURIComponent(renderId)}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      cache: "no-store",
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.success) {
      console.error("Shotstack status error:", data || response.statusText);
      return NextResponse.json(
        { error: data?.message || "Failed to fetch render status." },
        { status: response.status || 500 }
      );
    }

    const render = data.response || {};
    const status = render.status;
    const url = render.url || null;
    const poster = render.poster || null;

    // Persist final MP4 URL onto the user's history row when Shotstack finishes
    if ((status === "done" && url) || status === "failed") {
      try {
        const supabase = getSupabaseAdmin();
        await supabase
          .from("videos")
          .update({
            status: status === "done" ? "done" : "failed",
            video_url: status === "done" ? url : null,
            thumbnail_url: status === "done" ? poster : null,
            updated_at: new Date().toISOString(),
          })
          .eq("render_id", renderId)
          .eq("clerk_user_id", userId);
      } catch (dbError) {
        console.error("Failed to update video history from status poll:", dbError);
      }
    }

    return NextResponse.json({
      renderId: render.id,
      status,
      url,
      poster,
      error: render.error || null,
    });
  } catch (error) {
    console.error("GET /api/generate/status failed:", error);
    return NextResponse.json(
      { error: error.message || "Unable to poll render status." },
      { status: 500 }
    );
  }
}
