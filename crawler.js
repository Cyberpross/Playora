/**
 * Fetch all item identifiers from the Internet Archive
 * collection: softwarelibrary_flash_games
 *
 * - Uses Advanced Search (JSON)
 * - Handles pagination
 * - Does NOT download any files
 * - Outputs identifiers to names.txt
 *
 * Node.js 18+ recommended (built-in fetch)
 */

import fs from "fs";

const COLLECTION = "softwarelibrary_flash_games";
const OUTPUT_FILE = "names.txt";

// Advanced Search settings
const ROWS_PER_PAGE = 1000; // max allowed by IA
let start = 0;

async function fetchPage(startIndex) {
  const url = new URL("https://archive.org/advancedsearch.php");

  url.searchParams.set("q", `collection:${COLLECTION}`);
  url.searchParams.set("fl[]", "identifier");
  url.searchParams.set("rows", ROWS_PER_PAGE.toString());
  url.searchParams.set("start", startIndex.toString());
  url.searchParams.set("output", "json");

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json();
}

async function main() {
  const identifiers = [];

  console.log("Fetching identifiers from Internet Archive...");

  while (true) {
    console.log(`Fetching page starting at ${start}...`);

    const data = await fetchPage(start);
    const docs = data.response.docs;

    if (!docs || docs.length === 0) {
      break; // no more results
    }

    for (const doc of docs) {
      if (doc.identifier) {
        identifiers.push(doc.identifier);
      }
    }

    start += ROWS_PER_PAGE;
  }

  // Write to file, one identifier per line
  fs.writeFileSync(OUTPUT_FILE, identifiers.join("\n"), "utf8");

  console.log(`Done!`);
  console.log(`Collected ${identifiers.length} identifiers.`);
  console.log(`Saved to ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
