import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- ENV ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID; // e.g. "@my_channel" or "-1001234567890"
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID env vars");
  process.exit(1);
}

// --- CONSTS ---
const LIST_URL = "https://astanahub.com/ru/tech_task/";
const SEEN_PATH = path.join(__dirname, "..", "data", "seen.json");

// Tune scroll behavior if needed:
const MAX_SCROLL_ROUNDS = parseInt(process.env.MAX_SCROLL_ROUNDS || "30", 10);
const WAIT_BETWEEN_SCROLL_MS = parseInt(process.env.WAIT_BETWEEN_SCROLL_MS || "1500", 10);
const IDLE_AFTER_NO_GROWTH_ROUNDS = parseInt(process.env.IDLE_AFTER_NO_GROWTH_ROUNDS || "3", 10);

// --- HELPERS ---
function readSeen() {
  if (!fs.existsSync(SEEN_PATH)) return new Set();
  try {
    const arr = JSON.parse(fs.readFileSync(SEEN_PATH, "utf8"));
    return new Set(arr);
  } catch (e) {
    console.warn("Could not read seen.json, starting fresh", e);
    return new Set();
  }
}

function writeSeen(seenSet) {
  fs.writeFileSync(SEEN_PATH, JSON.stringify([...seenSet], null, 2));
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function postToTelegram(message, link) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const text = `${message}\n\nСсылка: ${link}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHANNEL_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Telegram error: ${res.status} ${t}`);
  }
}

function formatForTelegram(item) {
  // Required format: `${Label}: ${value}\n`
  // Using HTML + escaping to keep special chars safe
  const lines = [];
  const add = (label, val) => {
    if (val && String(val).trim()) {
      lines.push(`<b>${escapeHtml(label)}:</b> ${escapeHtml(String(val).trim())}`);
    }
  };

  add("Заголовок", item.title);
  add("Описание", item.description);
  add("Клиент", item.client);
  add("Дедлайн", item.deadline);
  add("Область задачи", item.taskArea);
  add("Подано заявок", item.applications);

  return lines.join("\n");
}

async function scrapeAll() {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 2000 } });

  await page.goto(LIST_URL, { waitUntil: "domcontentloaded" });

  let noGrowthRounds = 0;
  let lastCount = 0;

  for (let i = 0; i < MAX_SCROLL_ROUNDS; i++) {
    // Count current cards
    const count = await page.locator(".techtask-card").count();

    // If not growing over several rounds, assume loaded
    if (count <= lastCount) {
      noGrowthRounds++;
    } else {
      noGrowthRounds = 0;
    }
    lastCount = count;

    if (noGrowthRounds >= IDLE_AFTER_NO_GROWTH_ROUNDS) break;

    // Scroll to bottom to trigger lazy load
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
    await page.waitForTimeout(WAIT_BETWEEN_SCROLL_MS);
  }

  // Extract data per your selectors
  const items = await page.evaluate(() => {
    const base = "https://astanahub.com";
    const cards = Array.from(document.querySelectorAll(".techtask-card"));
    return cards.map(card => {
      const left = card.querySelector(".left");
      const right = card.querySelector(".right");

      const title = left?.querySelector("h2")?.textContent?.trim() || "";
      const description = left?.querySelector("p")?.textContent?.trim() || "";

      // Link to the task
      const linkEl = card.querySelector("a[href]");
      let link = linkEl ? linkEl.getAttribute("href") : "";
      if (link && link.startsWith("/")) link = base + link;

      // Right block:
      const client = right?.querySelector("div.card-avatar-block div.card-author h4")?.textContent?.trim() || "";

      const techItems = right ? Array.from(right.querySelectorAll("div.tech-list-item")) : [];

      // deadline - first tech-list-item -> second p -> b
      let deadline = "";
      if (techItems[0]) {
        const ps = techItems[0].querySelectorAll("p");
        deadline = ps[1]?.querySelector("b")?.textContent?.trim() || "";
      }

      // task area - second tech-list-item -> span -> b
      let taskArea = "";
      if (techItems[1]) {
        taskArea = techItems[1]?.querySelector("span b")?.textContent?.trim() || "";
      }

      // applications - third tech-list-item -> second p
      let applications = "";
      if (techItems[2]) {
        const ps2 = techItems[2].querySelectorAll("p");
        applications = ps2[1]?.textContent?.trim() || "";
      }

      return { title, description, client, deadline, taskArea, applications, link };
    });
  });

  await browser.close();
  return items;
}

(async () => {
  const seen = readSeen();
  const all = await scrapeAll();

  // Dedup rule: use the task link as unique ID
  const fresh = all.filter(x => x.link && !seen.has(x.link));

  if (fresh.length === 0) {
    console.log("No new tasks.");
    process.exit(0);
  }

  console.log(`Found ${fresh.length} new tasks.`);

  for (const item of fresh) {
    const msg = formatForTelegram(item);
    try {
      await postToTelegram(msg, item.link);
      // mark as seen only on successful post
      seen.add(item.link);
      // small delay to be polite to Telegram
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      console.error("Failed to post one item:", e.message);
    }
  }

  writeSeen(seen);
  console.log("Done.");
})();