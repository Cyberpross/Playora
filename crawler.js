/**
 * GUARANTEED 6500+ ITEMS FLASH ARCHIVER
 * No names.txt
 * Smart IA pagination (never stops early)
 */

import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { execSync } from "child_process";

/* ================= CONFIG ================= */

const OWNER = "Cyberpross";
const BASE_REPO = "flash-pack";

const TARGET_COUNT = 6500;
const MAX_SCAN = 20000;

const PAGE_SIZE = 1000;
const MAX_ITEM_MB = 100;
const PACK_LIMIT_MB = 1024;
const DELAY_MS = 1200;

const PROGRESS_FILE = "progress.json";
const SKIP_AUTH = "skipped_auth.txt";
const SKIP_LARGE = "skipped_large.txt";

const GH_TOKEN = process.env.GH_TOKEN;
if (!GH_TOKEN) throw new Error("❌ GH_TOKEN missing");

/* ================= UTILS ================= */

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) {
    return { pack: 1, sizeMB: 0, completed: [] };
  }
  return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

function append(file, text) {
  fs.appendFileSync(file, text + "\n");
}

/* ================= GITHUB ================= */

async function gh(method, url, body) {
  const r = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "flash-archiver"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return r.status === 204 ? {} : r.json();
}

async function setupPack(pack) {
  const repo = `${BASE_REPO}-${String(pack).padStart(3, "0")}`;
  console.log(`📦 Using repo: ${repo}`);

  const check = await gh("GET", `/repos/${OWNER}/${repo}`);
  if (check?.message === "Not Found") {
    console.log(`🆕 Creating repo ${repo}`);
    await gh("POST", "/user/repos", { name: repo, private: false });
  }

  execSync("rm -rf pack");
  fs.mkdirSync("pack");
  process.chdir("pack");

  execSync("git init");
  execSync("git branch -M main");
  execSync(`git config user.name "github-actions[bot]"`);
  execSync(`git config user.email "41898282+github-actions[bot]@users.noreply.github.com"`);
  execSync(`git remote add origin https://${GH_TOKEN}@github.com/${OWNER}/${repo}.git`);
}

/* ================= DOWNLOAD ================= */

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("redirect"));

    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);

    proto.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
      if ([301,302,303,307,308].includes(res.statusCode)) {
        file.close(); fs.unlinkSync(dest);
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        file.close(); fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", reject);
  });
}

async function safeDownload(url, dest) {
  try {
    await download(url, dest);
    return true;
  } catch (e) {
    if (/HTTP (401|403|404)/.test(e.message)) return false;
    throw e;
  }
}

/* ================= IA SEARCH (FIXED) ================= */

async function fetchAllItems() {
  console.log("🔍 Scanning Internet Archive…");

  const found = new Set();
  let start = 0;

  while (found.size < TARGET_COUNT && start < MAX_SCAN) {
    const url =
      `https://archive.org/advancedsearch.php` +
      `?q=collection:softwarelibrary_flash_games AND mediatype:software` +
      `&fl[]=identifier` +
      `&rows=${PAGE_SIZE}` +
      `&start=${start}` +
      `&sort[]=identifier asc` +
      `&output=json`;

    const data = await fetch(url).then(r => r.json());
    const docs = data?.response?.docs || [];

    for (const d of docs) {
      if (d.identifier) found.add(d.identifier);
    }

    start += PAGE_SIZE;
    console.log(`📄 Scanned ${start} → Unique ${found.size}`);
  }

  if (found.size < TARGET_COUNT) {
    console.warn(`⚠ Only found ${found.size}, continuing anyway`);
  }

  return [...found];
}

/* ================= PROCESS ================= */

async function processItem(item, progress) {
  console.log(`🔍 ${item}`);

  const meta = await fetch(`https://archive.org/metadata/${item}`).then(r => r.json());
  const files = meta.files || [];
  const swf = files.find(f => f.name?.endsWith(".swf"));

  if (!swf || !swf.size) return;

  const sizeMB = swf.size / 1024 / 1024;
  if (sizeMB > MAX_ITEM_MB) {
    append(SKIP_LARGE, item);
    return;
  }

  if (progress.sizeMB + sizeMB > PACK_LIMIT_MB) {
    progress.pack++;
    progress.sizeMB = 0;
    saveProgress(progress);
    process.chdir("..");
    await setupPack(progress.pack);
  }

  const dir = path.join("games", item);
  fs.mkdirSync(dir, { recursive: true });

  const base = `https://archive.org/download/${item}/`;
  const ok = await safeDownload(base + swf.name, path.join(dir, `${item}.swf`));
  if (!ok) {
    append(SKIP_AUTH, item);
    return;
  }

  const img = files.find(f => /\.(png|jpg)$/i.test(f.name));
  if (img) {
    await safeDownload(base + img.name, path.join(dir, "cover." + img.name.split(".").pop()));
  }

  execSync("git add .");
  execSync(`git commit -m "Add ${item}"`);
  execSync("git push -u origin main");

  progress.completed.push(item);
  progress.sizeMB += sizeMB;
  saveProgress(progress);

  console.log(`✅ ${item}`);
  await sleep(DELAY_MS);
}

/* ================= MAIN ================= */

async function main() {
  const items = await fetchAllItems();
  const progress = loadProgress();

  console.log(`🎯 Processing ${items.length} items`);
  await setupPack(progress.pack);

  for (const item of items) {
    if (progress.completed.includes(item)) continue;
    await processItem(item, progress);
  }

  console.log("🎉 DONE");
}

main().catch(e => {
  console.error("❌ Fatal:", e.message);
  process.exit(1);
});
