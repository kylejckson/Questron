#!/usr/bin/env node
/**
 * pack-quiz.js — Pack a quiz folder into a .questron file.
 *
 * USAGE:
 *   node scripts/pack-quiz.js <quiz-folder>
 *   npm run pack:quiz -- <quiz-folder>
 *
 * EXPECTED FOLDER STRUCTURE:
 *   my-quiz/
 *     quiz.json        ← required
 *     images/          ← optional
 *       q1.jpg
 *       q2.png
 *
 * QUIZ.JSON FORMAT:
 *   {
 *     "title": "My Quiz",
 *     "defaultTimeLimitSeconds": 20,
 *     "shuffleQuestions": true,
 *     "questions": [
 *       {
 *         "id": "q1",
 *         "text": "What is 2 + 2?",
 *         "imageRef": "q1.jpg",          ← optional: filename from images/ folder
 *         "imageUrl": "https://...",     ← optional: external URL (alternative to imageRef)
 *         "timeLimitSeconds": 15,
 *         "options": [
 *           { "id": "a", "label": "3" },
 *           { "id": "b", "label": "4" },
 *           { "id": "c", "label": "5" },
 *           { "id": "d", "label": "6" }
 *         ],
 *         "correctOptionIds": ["b"]
 *       }
 *     ]
 *   }
 *
 * The output file is placed alongside the quiz folder:
 *   my-quiz.questron
 *
 * NOTE: This script is designed for AI-assisted quiz catalogue generation.
 *       An AI can generate quiz.json + download/generate images into the images/
 *       folder, then run this script to produce a .questron file ready to host.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ── Resolve JSZip ────────────────────────────────────────────────────────────

let JSZip;
try {
  JSZip = require('jszip');
} catch {
  console.error('ERROR: jszip is not installed. Run: npm install');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const MAX_IMAGE_BYTES = 700 * 1024; // 700 KB binary → ~933 KB base64; fits in CF 1 MB WS message

/** Detect image MIME type from magic bytes. Returns null for unsupported types (including SVG). */
function detectMime(buf) {
  const b = buf instanceof Buffer ? buf : Buffer.from(buf);
  if (b[0] === 0xFF && b[1] === 0xD8)                                              return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47)           return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)                             return 'image/gif';
  if (b[0]===0x52 && b[1]===0x49 && b[2]===0x46 && b[3]===0x46 &&
      b[8]===0x57 && b[9]===0x45 && b[10]===0x42 && b[11]===0x50)                  return 'image/webp';
  return null;
}

/** Sanitize a filename: only alphanumeric, dots, hyphens, underscores. */
function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

/** Validate quiz.json structure. Returns array of error strings (empty = valid). */
function validateQuizJson(data) {
  const errors = [];
  if (!data || typeof data !== 'object')           { errors.push('quiz.json must be a JSON object'); return errors; }
  if (!data.title || typeof data.title !== 'string') errors.push('Missing or invalid "title"');
  if (!Array.isArray(data.questions))              { errors.push('"questions" must be an array'); return errors; }
  if (data.questions.length === 0)                 errors.push('"questions" array is empty');
  if (data.questions.length > 50)                  errors.push(`Too many questions (${data.questions.length}, max 50)`);

  const safeFilename = /^[\w.\-]{1,100}$/;
  data.questions.forEach((q, i) => {
    const n = i + 1;
    if (!q.id)   errors.push(`Question ${n}: missing "id"`);
    if (!q.text) errors.push(`Question ${n}: missing "text"`);
    if (!Array.isArray(q.options) || q.options.length < 2)
      errors.push(`Question ${n}: needs at least 2 options`);
    if (!Array.isArray(q.correctOptionIds) || q.correctOptionIds.length === 0)
      errors.push(`Question ${n}: missing "correctOptionIds"`);
    if (q.imageRef && !safeFilename.test(q.imageRef))
      errors.push(`Question ${n}: imageRef "${q.imageRef}" contains invalid characters`);
    if (q.imageRef && q.imageUrl)
      errors.push(`Question ${n}: use either imageRef or imageUrl, not both`);
  });
  return errors;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const folderArg = process.argv[2];

  if (!folderArg) {
    console.log('Usage: node scripts/pack-quiz.js <quiz-folder>');
    console.log('Example: node scripts/pack-quiz.js quizzes/world-capitals');
    process.exit(1);
  }

  const folderPath = path.resolve(folderArg);

  if (!fs.existsSync(folderPath)) {
    console.error(`ERROR: Folder not found: ${folderPath}`);
    process.exit(1);
  }

  const stat = fs.statSync(folderPath);
  if (!stat.isDirectory()) {
    console.error(`ERROR: Path is not a directory: ${folderPath}`);
    process.exit(1);
  }

  // ── Read quiz.json ─────────────────────────────────────────────────────────

  const quizJsonPath = path.join(folderPath, 'quiz.json');
  if (!fs.existsSync(quizJsonPath)) {
    console.error(`ERROR: quiz.json not found in ${folderPath}`);
    process.exit(1);
  }

  let quizData;
  try {
    quizData = JSON.parse(fs.readFileSync(quizJsonPath, 'utf8'));
  } catch (err) {
    console.error(`ERROR: Could not parse quiz.json: ${err.message}`);
    process.exit(1);
  }

  // Validate
  const validationErrors = validateQuizJson(quizData);
  if (validationErrors.length > 0) {
    console.error('ERROR: quiz.json validation failed:');
    validationErrors.forEach(e => console.error(`  • ${e}`));
    process.exit(1);
  }

  console.log(`📋 Quiz: "${quizData.title}" (${quizData.questions.length} questions)`);

  // ── Collect images ─────────────────────────────────────────────────────────

  const imagesDir  = path.join(folderPath, 'images');
  const imageFiles = new Map(); // sanitizedFilename → Buffer

  // Gather imageRefs referenced from quiz.json
  const referencedRefs = new Set(
    quizData.questions.map(q => q.imageRef).filter(Boolean)
  );

  if (referencedRefs.size > 0) {
    if (!fs.existsSync(imagesDir)) {
      console.error(`ERROR: quiz.json references images but no images/ folder found in ${folderPath}`);
      process.exit(1);
    }

    let skipped = 0;
    for (const ref of referencedRefs) {
      const safeName = sanitizeFilename(ref);
      const imgPath  = path.join(imagesDir, ref);

      if (!fs.existsSync(imgPath)) {
        console.error(`ERROR: Image "${ref}" referenced in quiz.json not found at ${imgPath}`);
        process.exit(1);
      }

      const buf = fs.readFileSync(imgPath);

      // Size check
      if (buf.length > MAX_IMAGE_BYTES) {
        console.warn(`  ⚠ SKIP "${ref}" — too large (${Math.round(buf.length/1024)} KB, max ${Math.round(MAX_IMAGE_BYTES/1024)} KB)`);
        skipped++;
        continue;
      }

      // Magic byte validation — reject SVG and unknown types
      const mime = detectMime(buf);
      if (!mime) {
        console.warn(`  ⚠ SKIP "${ref}" — unsupported format (use JPEG, PNG, WebP, or GIF; SVG is not allowed)`);
        skipped++;
        continue;
      }

      imageFiles.set(safeName, buf);
      console.log(`  ✓ Image: ${ref} (${Math.round(buf.length / 1024)} KB, ${mime})`);
    }

    if (skipped > 0) {
      console.warn(`  ${skipped} image(s) skipped — questions referencing them will show no image.`);
    }
  }

  // ── Build ZIP ──────────────────────────────────────────────────────────────

  const zip = new JSZip();

  zip.file('manifest.json', JSON.stringify({
    version: 1,
    created: new Date().toISOString(),
    tool: 'questron-packer/1.0',
    generatedBy: 'pack-quiz.js',
  }, null, 2));

  zip.file('quiz.json', JSON.stringify(quizData, null, 2));

  if (imageFiles.size > 0) {
    const imgFolder = zip.folder('images');
    for (const [name, buf] of imageFiles) {
      imgFolder.file(name, buf);
    }
  }

  const outputBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });

  // ── Write output ───────────────────────────────────────────────────────────

  const folderName  = path.basename(folderPath);
  const outputName  = folderName.replace(/\s+/g, '_').slice(0, 60) + '.questron';
  const outputPath  = path.join(path.dirname(folderPath), outputName);

  fs.writeFileSync(outputPath, outputBuf);

  const sizeKb = Math.round(outputBuf.length / 1024);
  console.log(`\n✅ Created: ${outputPath} (${sizeKb} KB)`);

  if (imageFiles.size === 0 && referencedRefs.size === 0) {
    console.log('   ℹ  No images — this is a text-only quiz (also loadable as .questron).');
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
