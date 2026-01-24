import fs from "fs";
import { execSync } from "child_process";
import fetch from "node-fetch";

const TOKEN = process.env.GH_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;

if (!TOKEN) throw new Error("❌ GH_TOKEN missing");
if (!REPO) throw new Error("❌ GITHUB_REPOSITORY missing");

const START_ID = "15-aevil_202304";
const COLLECTION = "softwarelibrary_flash_games";

const PROCESSED_FILE = "processed.json";

let processed = new Set();
if (fs.existsSync(PROCESSED_FILE)) {
  processed = new Set(JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf8")));
}

function run(cmd) {
  execSync(cmd, { stdio: "inherit" });
}

async function fetchJSON(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (text.trim().startsWith("<")) {
    throw new Error("❌ HTML received instead of JSON");
  }
  return JSON.parse(text);
}

async function getCollectionPage(cursor = "") {
  const url =
    `https://archive.org/metadata/${COLLECTION}` +
    (cursor ? `?cursor=${cursor}` : "");
  return fetchJSON(url);
}

async function getMetadata(id) {
  return fetchJSON(`https://archive.org/metadata/${id}`);
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Download failed");
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

function gitSetup() {
  run("git config user.name bot");
  run("git config user.email bot@bot");

  try {
    run("git remote remove origin");
  } catch {}

  run(
    `git remote add origin https://x-access-token:${TOKEN}@github.com/${REPO}.git`
  );
}

async function main() {
  gitSetup();

  let cursor = "";
  let started = false;

  while (true) {
    const page = await getCollectionPage(cursor);
    const items = page.members || [];

    for (const item of items) {
      const id = item.identifier;

      if (!started) {
        if (id === START_ID) {
          started = true;
        } else {
          continue;
        }
      }

      if (processed.has(id)) {
        console.log("⏭️ skipped", id);
        continue;
      }

      console.log("🎮", id);

      let meta;
      try {
        meta = await getMetadata(id);
      } catch {
        console.log("⚠️ metadata failed", id);
        continue;
      }

      const swf = meta.files?.find(f => f.name.endsWith(".swf"));
      if (!swf) {
        console.log("❌ no swf", id);
        continue;
      }

      const dir = `games/${id}`;
      fs.mkdirSync(dir, { recursive: true });

      const swfUrl = `https://archive.org/download/${id}/${swf.name}`;
      const swfPath = `${dir}/game.swf`;

      try {
        const size = await downloadFile(swfUrl, swfPath);
        if (size > 100 * 1024 * 1024) {
          console.log("🚫 too large, skipping", id);
          fs.rmSync(dir, { recursive: true, force: true });
          continue;
        }
      } catch {
        console.log("❌ swf download failed", id);
        continue;
      }

      // image (first jpg/png)
      const img = meta.files.find(f =>
        f.name.match(/\.(png|jpg|jpeg)$/i)
      );

      if (img) {
        try {
          const ext = img.name.split(".").pop();
          await downloadFile(
            `https://archive.org/download/${id}/${img.name}`,
            `${dir}/c.${ext}`
          );
        } catch {}
      }

      // index.html
      fs.writeFileSync(
        `${dir}/index.html`,
        `
<!DOCTYPE html>
<html>
<body>
<script src="../ruffle/ruffle.js"></script>
<embed src="game.swf" width="100%" height="100%">
</body>
</html>
        `.trim()
      );

      processed.add(id);
      fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...processed], null, 2));

      run("git add .");
      run(`git commit -m "add ${id}"`);
    }

    cursor = page.cursor;
    if (!cursor) break;
  }

  run("git branch -M main");
  run("git push -u origin main");
}

main().catch(err => {
  console.error("❌ FATAL:", err.message);
  process.exit(1);
});
