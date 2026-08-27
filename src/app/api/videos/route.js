import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { ensureUserProfile } from "@/lib/user-credits";
import {
  VIDEO_LIST_COLUMNS,
  decodeVideoListCursor,
  paginateVideoRows,
  parseVideoListLimit,
  videoListCursorFilter,
} from "@/lib/video-history-pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit = parseVideoListLimit(searchParams.get("limit"));
    const cursorParam = searchParams.get("cursor");
    let cursor = null;
    if (cursorParam) {
      try {
        cursor = decodeVideoListCursor(cursorParam);
      } catch {
        return NextResponse.json({ error: "Invalid cursor." }, { status: 400 });
      }
    }

    await ensureUserProfile(userId);
    const supabase = getSupabaseAdmin();

    let query = supabase
      .from("videos")
      .select(VIDEO_LIST_COLUMNS)
      .eq("clerk_user_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);

    if (cursor) {
      query = query.or(videoListCursorFilter(cursor));
    }

    const countPromise = cursor
      ? null
      : supabase
          .from("videos")
          .select("*", { count: "exact", head: true })
          .eq("clerk_user_id", userId);

    const [listResult, countResult] = await Promise.all([
      query,
      countPromise ?? Promise.resolve(null),
    ]);

    const { data, error } = listResult;
    if (error) {
      console.error("Supabase videos list error:", error);
      throw new Error("Failed to load video history.");
    }

    const { videos, nextCursor } = paginateVideoRows(data || [], limit);

    return NextResponse.json({
      videos,
      nextCursor,
      ...(countResult && !countResult.error
        ? { totalCount: countResult.count ?? 0 }
        : {}),
    });
  } catch (error) {
    console.error("GET /api/videos failed:", error);
    return NextResponse.json(
      { error: error.message || "Unable to load videos." },
      { status: 500 }
    );
  }
}
