import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

function getFileStats(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    };
  } catch {
    return { size: 0, mtime: "N/A" };
  }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const selectedDataset = searchParams.get("dataset");

    const dataDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      return NextResponse.json({ ok: true, csvFiles: [], jsonFiles: [], livePaperHistory: null });
    }
    
    const files = fs.readdirSync(dataDir);

    const csvFiles = files
      .filter((f) => f.endsWith(".csv"))
      .map((f) => ({
        name: f,
        ...getFileStats(path.join(dataDir, f)),
      }))
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

    const jsonFiles = files
      .filter((f) => f.endsWith(".json") && f !== "live-paper-history.json")
      .map((f) => ({
        name: f,
        ...getFileStats(path.join(dataDir, f)),
      }))
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

    // Read live paper history
    let livePaperHistory = null;
    try {
      const livePaperPath = path.join(dataDir, "live-paper-history.json");
      if (fs.existsSync(livePaperPath)) {
        livePaperHistory = JSON.parse(fs.readFileSync(livePaperPath, "utf8"));
      }
    } catch (e) {
      console.error("Error reading live-paper-history.json:", e);
    }

    // Read CSV preview if requested
    let previewRows = [];
    let previewHeaders = [];
    if (selectedDataset && csvFiles.some(f => f.name === selectedDataset)) {
      const filePath = path.join(dataDir, selectedDataset);
      const raw = fs.readFileSync(filePath, "utf8").trim();
      const lines = raw.split(/\r?\n/);
      if (lines.length > 0) {
        // Simple comma split handling quotes if needed, but simple split is enough for viewer
        previewHeaders = lines[0].split(",").map(h => h.trim());
        previewRows = lines.slice(1, 31).map(line => {
          const cells = line.split(",");
          return Object.fromEntries(previewHeaders.map((h, i) => [h, cells[i] ?? ""]));
        });
      }
    }

    return NextResponse.json({
      ok: true,
      csvFiles,
      jsonFiles,
      livePaperHistory,
      preview: {
        dataset: selectedDataset || null,
        headers: previewHeaders,
        rows: previewRows,
      }
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to query data assets." },
      { status: 500 }
    );
  }
}
