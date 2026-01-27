/**
 * Robust Internet Archive identifier crawler
 * Handles pagination + API edge cases safely
 */

import fs from "fs";

const COLLECTION = "softwarelibrary_flash_games";
const OUTPUT_FILE = "names.txt";
const ROWS_PER_PAGE = 1000;

let start = 0;
let totalFound = null;

async function fetchPage(startIndex) {
  const url = new URL("https://archive.org/advancedsearch.php");

  url.searchParams.set("q", `collection:${COLLECTION}`);
  url.searchParams.set("fl[]", "identifier");
  url.searchParams.set("rows", ROWS_PER_PAGE.toString());
  url.searchParams.set("start", startIndex.toString());
  url.searchParams.set("output", "json");

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return res.json();
}

async function main() {
  const identifiers = [];

  console.log("Fetching identifiers from Internet Archive...");

  while (true) {
    console.log(`Fetching page starting at ${start}...`);

    const data = await fetchPage(start);

    // 🛑 SAFETY CHECK
    if (!data.response || !Array.isArray(data.response.docs)) {
      console.log("No more valid results returned. Stopping.");
      break;
    }

    const { docs, numFound } = data.response;

    if (totalFound === null) {
      totalFound = numFound;
      console.log(`Total items reported by IA: ${totalFound}`);
    }

    if (docs.length === 0) {
      break;
    }

    for (const doc of docs) {
      if (doc.identifier) {
        identifiers.push(doc.identifier);
      }
    }

    start += ROWS_PER_PAGE;

    // 🛑 Prevent overshooting numFound
    if (start >= totalFound) {
      break;
    }
  }

  fs.writeFileSync(OUTPUT_FILE, identifiers.join("\n"), "utf8");

  console.log(`Done!`);
  console.log(`Collected ${identifiers.length} identifiers.`);
  console.log(`Saved to ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
