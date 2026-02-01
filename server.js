// server.js (komplett)

import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // falls Node < 18
import fs from "fs";

const app = express();
const port = process.env.PORT || 10000;

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile"; // starkes Modell, gut für Regeln

app.use(cors());
app.use(express.json());

/* ======================================
   CR-Datei auf dem Server einlesen
   ====================================== */

let serverRules = [];

/**
 * Parser ähnlich wie im Frontend: zerlegt MTG-Rules.txt
 * in Objekte { number: "702.15", text: "702.15 Lifelink ..."}
 */
function parseRulesServer(raw) {
  const lines = raw.split(/\r?\n/);
  let currentRuleNumber = null;
  let currentBuffer = [];
  const rules = [];
  const ruleHeaderRegex = /^(\d{3}(?:\.\d+[a-z]?)?)\s*(.*)$/;

  const flush = () => {
    if (currentRuleNumber !== null) {
      rules.push({
        number: currentRuleNumber,
        text: currentBuffer.join("\n").trim(),
      });
      currentRuleNumber = null;
      currentBuffer = [];
    }
  };

  for (const line of lines) {
    const m = line.match(ruleHeaderRegex);
    if (m) {
      flush();
      currentRuleNumber = m[1];
      currentBuffer.push(line);
    } else if (currentRuleNumber !== null) {
      currentBuffer.push(line);
    }
  }
  flush();
  return rules;
}

/**
 * Einfache Heuristik, um zu einer Frage die relevantesten Regeln
 * aus serverRules zu finden (Stichwort-basiertes Scoring).
 */
function findRelevantRules(question, maxResults = 20) {
  if (!serverRules.length || !question) return [];

  const q = question.toLowerCase().trim();
  // ganz simple Tokenisierung
  const keywords = q
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9äöüÄÖÜß]/gi, ""))
    .filter((w) => w.length > 2);

  if (!keywords.length) return [];

  const scored = [];

  for (const r of serverRules) {
    const textLower = r.text.toLowerCase();
    let score = 0;

    for (const kw of keywords) {
      if (!kw) continue;
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp("\\b" + escaped + "\\b", "g");
      let match;
      let occurrences = 0;
      while ((match = re.exec(textLower)) !== null) {
        occurrences++;
      }
      if (occurrences > 0) {
        // Grundscore + kleiner Bonus für mehrere Vorkommen
        score += 5 + Math.min(occurrences, 5) * 2;
      }
    }

    if (score > 0) {
      // kleiner Bonus für "Hauptregel" ohne Buchstaben
      if (/^\d{3}\.\d+$/.test(r.number)) score += 3;
      scored.push({ rule: r, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map((x) => x.rule);
}

// Beim Start: MTG-Rules.txt einlesen
try {
  const rawCR = fs.readFileSync("MTG-Rules.txt", "utf8");
  serverRules = parseRulesServer(rawCR);
  console.log("Loaded rules on server:", serverRules.length);
} catch (e) {
  console.error("Could not load MTG-Rules.txt on server:", e);
  serverRules = [];
}

/* ======================================
   Express-Routen
   ====================================== */

app.get("/", (req, res) => {
  res.send("MTG Rules classifier backend (Groq) is running.");
});

app.post("/classifyRule", async (req, res) => {
  console.log("Incoming /classifyRule request:", req.body);

  const apiKey = process.env.GROQ_API_KEY;
  console.log("GROQ_API_KEY set?", !!apiKey);

  if (!apiKey) {
    console.error("No GROQ_API_KEY configured");
    return res
      .status(500)
      .json({ error: "Server misconfigured: missing API key" });
  }

  const { question, language = "de" } = req.body || {};

  if (!question || typeof question !== "string") {
    console.log("Bad request: missing 'question'");
    return res
      .status(400)
      .json({ error: "Missing 'question' string in body" });
  }

  // 1) Relevante Regeln zur Frage suchen
  const candidateRules = findRelevantRules(question, 20);
  let contextText = "";

  if (candidateRules.length) {
    contextText = candidateRules
      .map((r) => `Rule ${r.number}:\n${r.text}`)
      .join("\n\n");
  }

  // 2) Prompt mit Kontext bauen
  const systemPrompt =
    "You are an expert for Magic: The Gathering Comprehensive Rules.\n" +
    "You will be given EXCERPTS from the Comprehensive Rules.\n" +
    "You MUST base your answer ONLY on these excerpts.\n" +
    "Your task: Answer with EXACTLY one comprehensive rules number " +
    "in the format 000.0 or 000.0a (e.g. 702.2 or 613.1g).\n" +
    "The rule number you output MUST appear in the provided excerpts.\n" +
    "If none of the provided rules clearly matches the question, " +
    "answer EXACTLY: NONE.\n" +
    "Do not explain your answer. Output only the rule number or NONE.";

  const userPrompt =
    (contextText
      ? "Relevant rule excerpts:\n\n" + contextText + "\n\n"
      : "No rule excerpts available.\n\n") +
    `Question (${language}):\n` +
    question.trim() +
    "\n\nAnswer (only one rule number from the excerpts, or NONE):";

  try {
    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 16,
        temperature: 0.0,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Groq API error:", response.status, errorText);
      return res
        .status(502)
        .json({ error: "LLM call failed", details: errorText });
    }

    const data = await response.json();
    const text = (data.choices?.[0]?.message?.content || "").trim();
    console.log("Raw Groq answer:", JSON.stringify(text));

    const first = text.split(/\s+/)[0].trim();
    const lower = first.toLowerCase();
    let ruleNumber = "NONE";

    if (lower !== "none") {
      const m = lower.match(/^(\d{3}\.\d+[a-z]?)$/);
      if (m) {
        const candidate = m[1];
        // 3) Sicherstellen, dass diese Regel in serverRules existiert
        const exists = serverRules.some(
          (r) => r.number.toLowerCase() === candidate.toLowerCase()
        );
        if (exists) {
          ruleNumber = candidate;
        } else {
          console.warn("LLM returned non-existing rule:", candidate);
          ruleNumber = "NONE";
        }
      } else {
        ruleNumber = "NONE";
      }
    }

    console.log("Returning ruleNumber:", ruleNumber);
    return res.json({ ruleNumber });
  } catch (err) {
    console.error("Error in /classifyRule:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
