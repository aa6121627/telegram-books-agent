import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => reject(new Error(`Could not start ${command}: ${error.message}`)));
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${code}): ${stderr.trim()}`));
    });
  });
}

/** Render page 1 of a PDF into a JPEG cover image using Poppler's pdftoppm. */
export async function extractFirstPageCover(bookPath, outputPath) {
  const extension = path.extname(bookPath).toLowerCase();
  if (extension !== ".pdf") {
    throw new Error(`First-page image extraction currently supports PDF only. Received: ${extension || "unknown format"}`);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.rm(outputPath, { force: true });

  const prefix = outputPath.replace(/\.jpg$/i, "");
  await run("pdftoppm", [
    "-f", "1",
    "-l", "1",
    "-singlefile",
    "-jpeg",
    "-r", process.env.COVER_DPI || "120",
    "-jpegopt", "quality=85",
    bookPath,
    prefix
  ]);

  const stat = await fs.stat(outputPath).catch(() => null);
  if (!stat?.size) throw new Error("PDF page 1 was not rendered. Check that the PDF is valid and has at least one page.");

  console.log(`First-page cover created: ${outputPath} (${stat.size} bytes)`);
  return outputPath;
}
