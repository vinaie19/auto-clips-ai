import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MESSAGE = 2000;
const MAX_PHONE = 40;
const MAX_EMAIL = 254;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }

    const email = clean(body.email).slice(0, MAX_EMAIL);
    const phone = clean(body.phone).slice(0, MAX_PHONE);
    const message = clean(body.message).slice(0, MAX_MESSAGE);

    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json(
        { error: "A valid email is required." },
        { status: 400 }
      );
    }

    if (!phone || phone.length < 7) {
      return NextResponse.json(
        { error: "A valid phone number is required." },
        { status: 400 }
      );
    }

    if (!message || message.length < 3) {
      return NextResponse.json(
        { error: "Please share a short message." },
        { status: 400 }
      );
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("feedback")
      .insert({ email, phone, message })
      .select("id")
      .single();

    if (error) {
      console.error("POST /api/feedback insert failed:", error);
      return NextResponse.json(
        { error: "Unable to save feedback." },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, id: data.id }, { status: 201 });
  } catch (error) {
    console.error("POST /api/feedback failed:", error);
    return NextResponse.json(
      { error: error.message || "Unable to save feedback." },
      { status: 500 }
    );
  }
}
