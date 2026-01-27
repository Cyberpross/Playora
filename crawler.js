/**
 * Internet Archive Flash Game Downloader
 * FULL VERSION – Redirect-safe, Resume-safe
 */

import fs from "fs";
import path from "path";
import https from "https";
import { execSync } from "child_process";

const OWNER = "Cyberpross";            // your GitHub username
const BASE_REPO = "flash-pack";        // flash-pack-001, 002...
const ITEMS_FILE = "names.txt";
const PROGRESS_FILE = "progress.json";

const MAX_ITEM_MB = 100;               // skip SWF > 100MB
const PACK_LIMIT_MB = 1024;            // ~1GB per repo

const GH_TOKEN = process.env.GH_TOKEN;

if (!GH_TOKEN) {
  console.error("❌ GH_TOKEN missing");
  process.exit(1);
}

/* ---------------- UTILS ---------------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) {
    return {
      pack: 1,
      sizeMB: 0,
      completed: [],
      skipped: []
    };
  }
  return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

function ghApi(method, url, body) {
  return fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      "Authorization": `token ${GH_TOKEN}`,
      "Accept": "application/vnd.github+json"
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(r => r.json());
}

async function createRepo(pack) {
  const name = `${BASE_REPO}-${String(pack).padStart(3, "0")}`;
  console.log(`🆕 Creating new repo: ${name}`);

  await ghApi("POST", "/user/repos", {
    name,
    private: false
  });

  execSync(
    `git remote set-url origin https://${GH_TOKEN}@github.com/${OWNER}/${name}.git`
  );
  execSync("git push -u origin main");
}

/* -------- DOWNLOAD (REDIRECT SAFE) -------- */

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      return reject(new Error("Too many redirects"));
    }

    const file = fs.createWriteStream(dest);

    https.get(url, res => {
      // handle redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        file.close();
        fs.unlinkSync(dest);

        const next = res.headers.location;
        console.log(`🔁 Redirect → ${next}`);
        return resolve(download(next, dest, redirects + 1));
      }

      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", err => {
      file.close();
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

/* ---------------- MAIN ---------------- */

async function main() {
  const items = fs.readFileSync(ITEMS_FILE, "utf8")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  const progress = loadProgress();

  console.log("🚀 Downloader started");
  console.log(`📦 Current pack: ${progress.pack}`);

  for (const item of items) {
    if (
      progress.completed.includes(item) ||
      progress.skipped.includes(item)
    ) {
      console.log(`⏭ Already processed: ${item}`);
      continue;
    }

    console.log(`🔍 Checking item: ${item}`);

    const meta = await fetch(
      `https://archive.org/metadata/${item}`
    ).then(r => r.json());

    const files = meta.files || [];

    const swf = files.find(f =>
      f.name?.toLowerCase().endsWith(".swf")
    );

    if (!swf || !swf.size) {
      console.log(`⚠ No SWF found`);
      progress.skipped.push(item);
      saveProgress(progress);
      continue;
    }

    const swfMB = Number(swf.size) / 1024 / 1024;

    if (swfMB > MAX_ITEM_MB) {
      console.log(`🚫 Skipped (${swfMB.toFixed(1)} MB > 100MB)`);
      progress.skipped.push(item);
      saveProgress(progress);
      continue;
    }

    // check pack size
    if (progress.sizeMB + swfMB >= PACK_LIMIT_MB) {
      progress.pack++;
      progress.sizeMB = 0;
      saveProgress(progress);
      await createRepo(progress.pack);
    }

    const itemDir = path.join("games", item);
    fs.mkdirSync(itemDir, { recursive: true });

    const base = `https://archive.org/download/${item}/`;

    console.log(`⬇ Downloading SWF`);
    await download(
      base + swf.name,
      path.join(itemDir, `${item}.swf`)
    );

    const img = files.find(f =>
      /\.(jpg|png)$/i.test(f.name)
    );

    if (img) {
      const ext = img.name.toLowerCase().endsWith(".png")
        ? "png"
        : "jpg";

      console.log(`🖼 Downloading image`);
      await download(
        base + img.name,
        path.join(itemDir, `c.${ext}`)
      );
    }

    progress.completed.push(item);
    progress.sizeMB += swfMB;
    saveProgress(progress);

    execSync("git add .");
    execSync(`git commit -m "Add ${item}"`);
    execSync("git push");

    console.log(`✅ Finished: ${item}`);
    await sleep(1000); // polite delay
  }

  console.log("🎉 ALL DONE");
}

main().catch(err => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
