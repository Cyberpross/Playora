/**
 * FINAL Internet Archive Flash Archiver
 * Stable • Resume-safe • A–Z scrape • Retry • Git-safe
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

const GH_TOKEN = process.env.GH_TOKEN;
if (!GH_TOKEN) throw new Error("❌ GH_TOKEN missing");

/* ================= UTILS ================= */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const append = (f, t) => fs.appendFileSync(f, t + "\n");

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) {
    return { pack: 1, sizeMB: 0, done: [] };
  }
  return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
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
}

function hasRemoteMain() {
  try {
    execSync("git show-ref --verify --quiet refs/remotes/origin/main");
    return true;
  } catch {
    return false;
  }
}

/* ================= DOWNLOAD ================= */

function safeDownload(url, dest, item, skipFile, redirects = 0) {
  return new Promise(resolve => {
    if (redirects > 5) {
      append(skipFile, `${item} | redirect loop`);
      return resolve(false);
    }

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
        append(skipFile, `${item} | HTTP ${res.statusCode}`);
        return resolve(false);
      }

      if (res.statusCode !== 200) {
        file.close(); fs.unlinkSync(dest);
        append(SKIP_TEMP, `${item} | HTTP ${res.statusCode}`);
        return resolve(false);
      }

      res.pipe(file);
      file.on("finish", () => file.close(() => resolve(true)));

    }).on("error", () => {
      append(SKIP_TEMP, `${item} | network error`);
      resolve(false);
    });
  });
}

/* ================= IA SEARCH ================= */

async function fetchAllItems() {
  console.log("🔍 Scanning Internet Archive (A–Z)…");

  const prefixes = [
    ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)),
    ...Array.from({ length: 10 }, (_, i) => String(i))
  ];

  const all = new Set();

  for (const p of prefixes) {
    let start = 0;
    while (true) {
      const url =
        `https://archive.org/advancedsearch.php` +
        `?q=collection:softwarelibrary_flash_games AND identifier:${p}*` +
        `&fl[]=identifier&rows=${PAGE_SIZE}&start=${start}&output=json`;

      const data = await fetch(url).then(r => r.json());
      const docs = data?.response?.docs || [];
      if (docs.length === 0) break;

      docs.forEach(d => d.identifier && all.add(d.identifier));
      start += PAGE_SIZE;
      console.log(`🔠 ${p} → ${all.size}`);
      await sleep(300);
    }
  }

  console.log(`🎯 Total unique items: ${all.size}`);
  return [...all];
}

/* ================= PROCESS ITEM ================= */

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
    await setupRepo(progress.pack);
  }

  const dir = path.join("games", item);
  fs.mkdirSync(dir, { recursive: true });
  const base = `https://archive.org/download/${item}/`;

  const swfOk = await safeDownload(
    base + swf.name,
    path.join(dir, `${item}.swf`),
    item,
    SKIP_AUTH
  );

  if (!swfOk) return;

  const img = files.find(f => /\.(png|jpg)$/i.test(f.name));
  if (img) {
    await safeDownload(
      base + img.name,
      path.join(dir, "cover." + img.name.split(".").pop()),
      item,
      SKIP_TEMP
    );
  }

  execSync("git add .");
  execSync(`git commit -m "Add ${item}"`);

  if (hasRemoteMain()) {
    execSync("git pull --rebase");
  }

  execSync("git push -u origin main");

  progress.done.push(item);
  progress.sizeMB += sizeMB;
  saveProgress(progress);

  console.log(`✅ ${item}`);
  await sleep(DELAY_MS);
}

/* ================= RETRY ================= */

async function retrySkipped(progress) {
  for (let round = 1; round <= RETRY_ROUNDS; round++) {
    console.log(`🔁 Retry round ${round}`);

    const retry = new Set();

    [SKIP_TEMP, SKIP_AUTH].forEach(f => {
      if (fs.existsSync(f)) {
        fs.readFileSync(f, "utf8")
          .split("\n")
          .map(l => l.split("|")[0].trim())
          .filter(Boolean)
          .forEach(x => retry.add(x));
        fs.unlinkSync(f);
      }
    });

    for (const item of retry) {
      if (progress.done.includes(item)) continue;
      await processItem(item, progress);
    }
  }
}

/* ================= MAIN ================= */

async function main() {
  const items = await fetchAllItems();
  const progress = loadProgress();

  await setupRepo(progress.pack);

  for (const item of items) {
    if (progress.done.includes(item)) continue;
    await processItem(item, progress);
  }

  await retrySkipped(progress);

  console.log("🎉 ALL DONE");
}

main().catch(e => {
  console.error("❌ Fatal:", e.message);
  process.exit(1);
});
