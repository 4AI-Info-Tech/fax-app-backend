/**
 * Lightweight document-to-PDF conversion server.
 * Compatible with the ConvertX API contract used by the Worker.
 *
 * Endpoints:
 *   POST /api/convert   – multipart form: file + targetFormat
 *   POST /api/combined  – same as above (alias)
 *   GET  /health        – health check
 *
 * Uses LibreOffice in headless mode for Office → PDF conversion.
 */

import { serve } from "bun";
import { existsSync, mkdirSync, unlinkSync, readdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { $ } from "bun";

const PORT = Number(process.env.PORT) || 3000;
const WORK_DIR = "/tmp/convert";
const SOFFICE_BIN = process.env.SOFFICE_BIN || "soffice";

// Ensure work directory exists
if (!existsSync(WORK_DIR)) {
    mkdirSync(WORK_DIR, { recursive: true });
}

/**
 * Convert a file to PDF using LibreOffice headless.
 * @param {string} inputPath – absolute path to the source file
 * @param {string} outputDir – directory where PDF will be written
 * @returns {Promise<string>} – absolute path to the generated PDF
 */
async function convertToPdf(inputPath, outputDir) {
    const userInstallation = join(outputDir, ".libreoffice");
    mkdirSync(userInstallation, { recursive: true });

    const result =
        await $`${SOFFICE_BIN} --headless --norestore --safe-mode --convert-to pdf --outdir ${outputDir} -env:UserInstallation=file://${userInstallation} ${inputPath}`.quiet();

    if (result.exitCode !== 0) {
        const stderr = result.stderr.toString();
        throw new Error(`LibreOffice exited with code ${result.exitCode}: ${stderr}`);
    }

    // Find the generated PDF
    const baseName = basename(inputPath, extname(inputPath));
    const expectedPdf = join(outputDir, `${baseName}.pdf`);

    if (existsSync(expectedPdf)) {
        return expectedPdf;
    }

    // Fallback: pick first .pdf in outputDir
    const files = readdirSync(outputDir).filter((f) => f.endsWith(".pdf"));
    if (files.length > 0) {
        return join(outputDir, files[0]);
    }

    throw new Error("LibreOffice did not produce a PDF file");
}

/**
 * Cleanup a job directory.
 */
function cleanup(dir) {
    try {
        const { rmSync } = require("node:fs");
        rmSync(dir, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
}

/**
 * Handle a conversion request.
 */
async function handleConvert(req) {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
        return new Response(JSON.stringify({ error: "Expected multipart/form-data" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    const formData = await req.formData();

    // ConvertX sends file under "file" or "input"
    const file = formData.get("file") || formData.get("input");
    if (!file || typeof file === "string") {
        return new Response(JSON.stringify({ error: "No file uploaded" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    const jobId = randomUUID();
    const jobDir = join(WORK_DIR, jobId);
    mkdirSync(jobDir, { recursive: true });

    const originalName = file.name || "document";
    const inputPath = join(jobDir, originalName);

    try {
        // Write uploaded file to disk
        const buffer = Buffer.from(await file.arrayBuffer());
        await Bun.write(inputPath, buffer);

        // Convert
        const pdfPath = await convertToPdf(inputPath, jobDir);
        const pdfBytes = await Bun.file(pdfPath).arrayBuffer();
        const pdfName = basename(pdfPath);

        return new Response(pdfBytes, {
            status: 200,
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `attachment; filename="${pdfName}"`,
            },
        });
    } catch (err) {
        return new Response(
            JSON.stringify({
                error: {
                    code: "conversion_failed",
                    message: err?.message || "Conversion failed",
                },
            }),
            {
                status: 500,
                headers: { "Content-Type": "application/json" },
            }
        );
    } finally {
        cleanup(jobDir);
    }
}

serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);

        if (req.method === "GET" && url.pathname === "/health") {
            return new Response(
                JSON.stringify({ status: "ok", service: "converter-lite", timestamp: new Date().toISOString() }),
                { headers: { "Content-Type": "application/json" } }
            );
        }

        if (
            req.method === "POST" &&
            (url.pathname === "/api/convert" ||
                url.pathname === "/api/combined" ||
                url.pathname === "/convert" ||
                url.pathname === "/combined")
        ) {
            return handleConvert(req);
        }

        return new Response(JSON.stringify({ error: "Not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
        });
    },
});

console.log(`Converter-lite listening on :${PORT}`);
