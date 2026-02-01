// server.js (mehrsprachige Version)

import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // falls Node < 18
import fs from "fs";

const app = express();
const port = process.env.PORT || 10000;

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

app.use(cors());
app.use(express.json());

/* ======================================
   CR-Dateien auf dem Server einlesen
   ====================================== */

let serverRulesEN = [];
let serverRulesDE = [];

/**
 * Zerlegt MTG-Rules*.txt in Objekte { number: "702.15", text: "..." }
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

function loadRulesFile(filename) {
  try {
    const raw = fs.readFileSync(filename, "utf8");
    const parsed = parseRulesServer(raw);
    console.log(`Loaded ${parsed.length} rules from ${filename}`);
    return parsed;
  } catch (e) {
    console.error(`Could not load ${filename}:`, e);
    return [];
  }
}

// Beim Start: beide Sprachversionen laden
serverRulesEN = loadRulesFile("MTG-Rules.txt");     // englisch
serverRulesDE = loadRulesFile("MTG-RulesDE.txt");   // deutsch

/* ======================================
   Hilfsfunktionen
   ====================================== */

/**
 * Frage sprachspezifisch normalisieren (Tippfehler, Synonyme → Kanon).
 */
function normalizeQuestion(question, language) {
  if (!question) return "";
  let q = question.toLowerCase();

  if (language === "de") {
    // Tippfehler + deutsche Begriffe → englische Mechaniknamen
    q = q.replace(/tampelschaden/g, "trampelschaden");
    q = q.replace(/trampelschaden/g, "trample");
    q = q.replace(/lebensverknüpfung/g, "lifelink");
    q = q.replace(/todesberührung/g, "deathtouch");
    q = q.replace(/flugfähigkeit/g, "flying");
    q = q.replace(/eil[e]?/g, "haste");
    q = q.replace(/doppelangriff/g, "double strike");
    q = q.replace(/erstschlag/g, "first strike");
    q = q.replace(/überrennen/g, "trample");
    // du kannst hier nach Bedarf erweitern
  } else {
    // englische Seite: hier könntest du ebenfalls einfache Fixes machen
    q = q.replace(/trampel damage/g, "trample damage");
  }

  return q;
}

/**
 * Wählt die passende Regelbasis (EN/DE) je nach language.
 * Wichtig: Nummern sind in beiden Dateien gleich aufgebaut.
 */
function getRulesForLanguage(language) {
  if (language === "de") return serverRulesDE.length ? serverRulesDE : serverRulesEN;
  return serverRulesEN.length ? serverRulesEN : serverRulesDE;
}

/**
 * Stichwort-basierte Heuristik, um zu einer Frage die relevantesten Regeln
 * aus der gewählten Regelbasis zu finden.
 */
function findRelevantRules(question, language, maxResults = 20) {
  const rules = getRulesForLanguage(language);
  if (!rules.length || !question) return [];

  const q = question.toLowerCase().trim();
  const keywords = q
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9äöüÄÖÜß]/gi, ""))
    .filter((w) => w.length > 2);

  if (!keywords.length) return [];

  const scored = [];

  for (const r of rules) {
    const textLower = r.text.toLowerCase();
    let score = 0;

    for (const kw of keywords) {
      if (!kw) continue;
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp("\\b" + escaped + "\\b", "g");
      let match;
      let occ = 0;
      while ((match = re.exec(textLower)) !== null) {
        occ++;
      }
      if (occ > 0) {
        score += 5 + Math.min(occ, 5) * 2;
      }
    }

    if (score > 0) {
      // kleiner Bonus für Hauptregel (ohne Buchstaben)
      if (/^\d{3}\.\d+$/.test(r.number)) score += 3;

      // Bonus für Mechanik-Schlüsselwörter im Header
      const headerLine = (r.text.split(/\r?\n/)[0] || "").toLowerCase();
      const mechKeywords = [
        "trample",
        "lifelink",
        "deathtouch",
        "flying",
        "haste",
        "first strike",
        "double strike",
        "indestructible",
      ];
      for (const mk of mechKeywords) {
        if (headerLine.includes(mk)) {
          score += 5;
        }
      }

      scored.push({ rule: r, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map((x) => x.rule);
}

/**
 * Prüft, ob eine Regelform wie "702.19" in der gewählten Regelbasis existiert.
 */
function ruleExists(candidate, language) {
  const rules = getRulesForLanguage(language);
  const candLower = candidate.toLowerCase();
  return rules.some((r) => r.number.toLowerCase() === candLower);
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

  let { question, language = "de" } = req.body || {};
  if (!question || typeof question !== "string") {
    console.log("Bad request: missing 'question'");
    return res
      .status(400)
      .json({ error: "Missing 'question' string in body" });
  }

  language = language === "en" ? "en" : "de";

  // Frage normalisieren (v.a. für Deutsch)
  const normalizedQuestion = normalizeQuestion(question, language);

  // Relevante Regeln für diese Sprache finden
  const candidateRules = findRelevantRules(normalizedQuestion, language, 20);
  let contextText = "";

  if (candidateRules.length) {
    contextText = candidateRules
      .map((r) => `Rule ${r.number}:\n${r.text}`)
      .join("\n\n");
  }

  // Sprachspezifischer System-Prompt
  const systemPromptDE =
    "Du bist ein Experte für die Magic: The Gathering Comprehensive Rules.\n" +
    "Du bekommst AUSZÜGE aus den umfassenden Regeln.\n" +
    "Du MUSST deine Antwort AUSSCHLIESSLICH auf diese Auszüge stützen.\n" +
    "Deine Aufgabe: Antworte mit GENAU EINER Regelnummer im Format 000.0 oder 000.0a.\n" +
    "Die ausgegebene Regelnummer MUSS in den bereitgestellten Auszügen vorkommen.\n" +
    "Wenn keine der präsentierten Regeln klar zur Frage passt, antworte GENAU: NONE.\n" +
    "Erkläre deine Antwort nicht. Gib nur die Regelnummer oder NONE aus.";

  const systemPromptEN =
    "You are an expert for Magic: The Gathering Comprehensive Rules.\n" +
    "You will be given EXCERPTS from the Comprehensive Rules.\n" +
    "You MUST base your answer ONLY on these excerpts.\n" +
    "Your task: Answer with EXACTLY one comprehensive rules number " +
    "in the format 000.0 or 000.0a (e.g. 702.2 or 613.1g).\n" +
    "The rule number you output MUST appear in the provided excerpts.\n" +
    "If none of the provided rules clearly matches the question, " +
    "answer EXACTLY: NONE.\n" +
    "Do not explain your answer. Output only the rule number or NONE.";

  const systemPrompt = language === "de" ? systemPromptDE : systemPromptEN;

  // User-Prompt (Frage bleibt im Original, aber auch die normalisierte Version hilft)
  const userPrompt =
    (contextText
      ? (language === "de"
          ? "Relevante Regelauszüge:\n\n"
          : "Relevant rule excerpts:\n\n") +
        contextText +
        "\n\n"
      : language === "de"
      ? "Keine Regelauszüge verfügbar.\n\n"
      : "No rule excerpts available.\n\n") +
    (language === "de" ? "Frage (Deutsch):\n" : "Question:\n") +
    question.trim() +
    "\n\n" +
    (language === "de"
      ? "Interne Normalisierung der Frage:\n"
      : "Internally normalized question:\n") +
    normalizedQuestion.trim() +
    "\n\n" +
    (language === "de"
      ? "Antwort (nur eine Regelnummer aus den Auszügen oder NONE):"
      : "Answer (only one rule number from the excerpts, or NONE):");

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
        // Existiert diese Regelnummer in der gewählten Sprachbasis?
        if (ruleExists(candidate, language)) {
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
