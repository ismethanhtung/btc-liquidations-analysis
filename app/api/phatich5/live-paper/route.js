import { NextResponse } from "next/server";
import {
  getLivePaperSnapshot,
  runLivePaperTick,
} from "@/lib/phatich5-live-paper";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  try {
    const snapshot = await getLivePaperSnapshot();
    return NextResponse.json(snapshot);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err?.message || "Failed to read live paper history.",
      },
      { status: 500 },
    );
  }
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const result = await runLivePaperTick(body || {});
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err?.message || "Failed to run live paper tick.",
      },
      { status: 500 },
    );
  }
}
