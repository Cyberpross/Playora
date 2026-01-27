/**
 * Internet Archive crawler
 * - Saves each identifier immediately
 * - Logs every save
 * - Uses Advanced Search JSON API
 */

import fs from "fs";

const COLLECTION = "softwarelibrary_flash_games";
const OUTPUT_FILE = "names.txt";
const ROWS_PER_PAGE = 1000;

let start = 0;
let totalFound = null;

// File ko pehle clear / create kar do
fs.writeFileSync(OUTPUT_FILE, "", "utf8");

async function fetchPage(startIndex) {
  const url = new URL("https://archive.org/advancedsearch.php");

  url.searchParams.set("q", `collection:${COLLECTION}`);
  url.searchParams.set("fl[]", "identifier");
  url.searchParams.set("rows", ROWS_PER_PAGE.toString());
  url.searchParams.set("start", startIndex.toString());
  url.searchParams.set("output", "json");

  const res = await fetch(url);
  return res.json();
}

async function main() {
  console.log("🚀 Crawler started...");

  while (true) {
    console.log(`📄 Fetching page starting at ${start}`);

    const data = await fetchPage(start);

    // Safety check
    if (!data.response || !data.response.docs) {
      console.log("🛑 No more data from API. Stopping.");
      break;
    }

    const { docs, numFound } = data.response;

    if (totalFound === null) {
      totalFound = numFound;
      console.log(`📦 Total items reported: ${totalFound}`);
    }

    if (docs.length === 0) break;

    for (const doc of docs) {
      if (doc.identifier) {
        fs.appendFileSync(OUTPUT_FILE, doc.identifier + "\n", "utf8");
        console.log(`✅ Saved: ${doc.identifier}`);
      }
    }

    start += ROWS_PER_PAGE;

    if (start >= totalFound) break;
  }

  console.log("🎉 Done!");
  console.log(`📁 File saved as: ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
