/**
 * FINAL Internet Archive Flash Archiver
 * FORCE RESUME VERSION (no old data touched)
 */

import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { execSync } from "child_process";

/* ================= CONFIG ================= */

const OWNER = "Cyberpross";
const BASE_REPO = "flash-pack";

const PAGE_SIZE = 1000;
const PACK_LIMIT_MB = 1024;
const MAX_ITEM_MB = 100;

const RETRY_ROUNDS = 5;
const DELAY_MS = 1200;

const PROGRESS_FILE = "progress.json";
const SKIP_AUTH = "skipped_auth.txt";
const SKIP_LARGE = "skipped_large.txt";
const SKIP_TEMP = "skipped_temp.txt";

const FORCE_RESUME_AFTER = "swords-and-sandals-crusader_flash";
const FORCE_START_PACK = 13;

const GH_TOKEN = process.env.GH_TOKEN;
if (!GH_TOKEN) throw new Error("❌ GH_TOKEN missing");

/* ================= UTILS ================= */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const append = (f, t) => fs.appendFileSync(f, t + "\n");

/* ================= LOAD PROGRESS (SAFE OVERRIDE) ================= */

function loadProgress() {
  let p;

  if (!fs.existsSync(PROGRESS_FILE)) {
    p = { pack: 1, sizeMB: 0, done: [] };
  } else {
    p = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
  }

  console.log("📂 Progress file pack:", p.pack);
  console.log("⚡ Forcing resume pack:", FORCE_START_PACK);

  // runtime override only
  p.pack = FORCE_START_PACK;
  p.sizeMB = 0;

  return p;
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
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

async function setupRepo(pack) {
  const repo = `${BASE_REPO}-${String(pack).padStart(3, "0")}`;
  console.log(`📦 Using repo ${repo}`);

  const check = await gh("GET", `/repos/${OWNER}/${repo}`);
  if (check?.message === "Not Found") {
    console.log(`🆕 Creating repo ${repo}`);
    await gh("POST", "/user/repos", { name: repo, private: false });
  }

  execSync("rm -rf pack");
  execSync(
    `git clone https://${GH_TOKEN}@github.com/${OWNER}/${repo}.git pack`,
    { stdio: "inherit" }
  );

  process.chdir("pack");

  execSync(`git config user.name "github-actions[bot]"`);
  execSync(`git config user.email "41898282+github-actions[bot]@users.noreply.github.com"`);

  // empty repo fix
  try {
    execSync("git checkout main");
  } catch {
    execSync("git checkout -b main");
  }
}

/* ================= DOWNLOAD ================= */

function safeDownload(url, dest, item, skipFile, redirects = 0) {
  return new Promise(resolve => {
    if (redirects > 5) return resolve(false);

    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);

    proto.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {

      if ([301,302,303,307,308].includes(res.statusCode)) {
        file.close(); fs.unlinkSync(dest);
        return resolve(
          safeDownload(res.headers.location, dest, item, skipFile, redirects + 1)
        );
      }

      if ([401,403,404].includes(res.statusCode)) {
        file.close(); fs.unlinkSync(dest);
        append(skipFile, item);
        return resolve(false);
      }

      if (res.statusCode !== 200) {
        file.close(); fs.unlinkSync(dest);
        append(SKIP_TEMP, item);
        return resolve(false);
      }

      res.pipe(file);
      file.on("finish", () => file.close(() => resolve(true)));

    }).on("error", () => resolve(false));
  });
}

/* ================= IA SEARCH ================= */

async function fetchAllItems() {
  console.log("🔍 Scanning IA A–Z");

  const prefixes = [
    ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)),
    ...Array.from({ length: 10 }, (_, i) => String(i))
  ];

  const all = new Set();

  for (const p of prefixes) {
    let start = 0;
    while (true) {
      const url =
        `https://archive.org/advancedsearch.php?q=collection:softwarelibrary_flash_games AND identifier:${p}*&fl[]=identifier&rows=${PAGE_SIZE}&start=${start}&output=json`;

      const data = await fetch(url).then(r => r.json());
      const docs = data?.response?.docs || [];
      if (!docs.length) break;

      docs.forEach(d => d.identifier && all.add(d.identifier));
      start += PAGE_SIZE;
      console.log(`🔠 ${p} → ${all.size}`);
      await sleep(300);
    }
  }

  console.log("🎯 Total unique:", all.size);
  return [...all];
}

/* ================= PROCESS ITEM ================= */

async function processItem(item, progress) {
  console.log("🔍", item);

  const meta = await fetch(`https://archive.org/metadata/${item}`).then(r => r.json());
  const swf = meta.files?.find(f => f.name?.endsWith(".swf"));
  if (!swf) return;

  const sizeMB = swf.size / 1024 / 1024;
  if (sizeMB > MAX_ITEM_MB) {
    append(SKIP_LARGE, item);
    return;
  }

  if (progress.sizeMB + sizeMB > PACK_LIMIT_MB) {
    progress.pack++;
    progress.sizeMB = 0;
    process.chdir("..");
    await setupRepo(progress.pack);
  }

  const dir = path.join("games", item);
  fs.mkdirSync(dir, { recursive: true });

  const ok = await safeDownload(
    `https://archive.org/download/${item}/${swf.name}`,
    `${dir}/${item}.swf`,
    item,
    SKIP_AUTH
  );

  if (!ok) return;

  try {
    execSync("git add .");
    execSync(`git commit -m "Add ${item}"`);
    execSync("git push -u origin main");
  } catch {}

  progress.done.push(item);
  progress.sizeMB += sizeMB;
  saveProgress(progress);

  await sleep(DELAY_MS);
}

/* ================= RETRY ================= */

async function retrySkipped(progress) {
  for (let r = 1; r <= RETRY_ROUNDS; r++) {
    console.log("🔁 Retry round", r);
    if (!fs.existsSync(SKIP_TEMP)) return;

    const items = fs.readFileSync(SKIP_TEMP, "utf8").split("\n").filter(Boolean);
    fs.unlinkSync(SKIP_TEMP);

    for (const item of items)
      if (!progress.done.includes(item))
        await processItem(item, progress);
  }
}

/* ================= MAIN ================= */

async function main() {
  let items = await fetchAllItems();
  const progress = loadProgress();

  const idx = items.indexOf(FORCE_RESUME_AFTER);
  if (idx !== -1) {
    console.log("▶ Resuming AFTER:", FORCE_RESUME_AFTER);
    items = items.slice(idx + 1);
  }

  console.log("Remaining:", items.length);

  await setupRepo(progress.pack);

  for (const item of items)
    await processItem(item, progress);

  await retrySkipped(progress);

  console.log("🎉 ALL DONE");
}

main().catch(e => {
  console.error("❌ Fatal:", e.message);
  process.exit(1);
});
