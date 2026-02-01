// server.js – DE/EN, Mechanik-Fokus (Combat etc.), Top-Context für Groq

import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // falls Node < 18
import fs from "fs";

const app = express();
const port = process.env.PORT || 10000;

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
// Free-Plan Modell (anpassen, falls du ein anderes willst)
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
 * Wir mappen primär auf englische Mechanik-Namen, weil die in beiden CR-Versionen vorkommen.
 */
function normalizeQuestion(question, language) {
  if (!question) return "";
  let q = question.toLowerCase();

  if (language === "de") {
    // Trample
    q = q.replace(/tampelschaden/g, "trampelschaden");
    q = q.replace(/trampelschaden/g, "trample");
    q = q.replace(/trampel schaden/g, "trample");
    q = q.replace(/überrennen/g, "trample");

    // Lifelink
    q = q.replace(/lebensverknüpfung/g, "lifelink");
    q = q.replace(/lebensverbindung/g, "lifelink");

    // Deathtouch
    q = q.replace(/todesberührung/g, "deathtouch");
    q = q.replace(/todes berührung/g, "deathtouch");
    q = q.replace(/todesberuhrung/g, "deathtouch");
    q = q.replace(/todes beruhrung/g, "deathtouch");

    // Flying
    q = q.replace(/flugf[aä]higkeit/g, "flying");
    q = q.replace(/fliegend[e]?/g, "flying");

    // Haste
    q = q.replace(/eil[e]?/g, "haste");

    // First Strike
    q = q.replace(/erst schlag/g, "erstschlag");
    q = q.replace(/erstschlag/g, "first strike");
    q = q.replace(/firststrike/g, "first strike");

    // Double Strike (inkl. Tippfehler)
    q = q.replace(/dooe?pelschlag/g, "doppelschlag");
    q = q.replace(/dop+elschlag/g, "doppelschlag");
    q = q.replace(/doppel schlag/g, "doppelschlag");
    q = q.replace(/doppelangriff/g, "doppelschlag");
    q = q.replace(/doppelschlag/g, "double strike");
    q = q.replace(/doublestrike/g, "double strike");

    // Indestructible
    q = q.replace(/unzerst[öo]rbar/g, "indestructible");

    // Infect / Wither
    q = q.replace(/vergiftung/g, "infect");
    q = q.replace(/infekt/g, "infect");
    q = q.replace(/schw[aä]chung/g, "wither");

    // Kampfschaden / Verteidigen
    q = q.replace(/kampfschaden/g, "combat damage");
    q = q.replace(/angreif(en|er)?/g, "attack");
    q = q.replace(/verteidig(en|er|ende|end)/g, "block");
  } else {
    // einfache englische Fixes (optional)
    q = q.replace(/trampel damage/g, "trample damage");
  }

  return q;
}

/**
 * Wählt die passende Regelbasis (EN/DE) je nach language.
 * Nummern bleiben identisch, Texte sind übersetzt.
 */
function getRulesForLanguage(language) {
  if (language === "de") return serverRulesDE.length ? serverRulesDE : serverRulesEN;
  return serverRulesEN.length ? serverRulesEN : serverRulesDE;
}

/**
 * Stichwort-basierte Heuristik, um zu einer Frage die relevantesten Regeln
 * aus der gewählten Regelbasis zu finden.
 */
function findRelevantRules(normalizedQuestion, language, maxResults = 5) {
  const rules = getRulesForLanguage(language);
  if (!rules.length || !normalizedQuestion) return [];

  const q = normalizedQuestion.toLowerCase().trim();
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
      // kleiner Bonus für Hauptregel (ohne Buchstaben, z.B. 702.19)
      if (/^\d{3}\.\d+$/.test(r.number)) score += 3;

      // Bonus für Mechanik-Schlüsselwörter im Header (erste Zeile)
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
        "vigilance",
        "hexproof",
        "ward",
        "menace",
        "reach",
        "infect",
        "wither",
      ];
      for (const mk of mechKeywords) {
        if (headerLine.includes(mk)) {
          score += 5;
        }
      }

      scored.push({ rule: r, score });
    }
  }

  if (!scored.length) return [];

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

  // Frage normalisieren (v.a. für Deutsch → englische Mechanikbegriffe)
  const normalizedQuestion = normalizeQuestion(question, language);
  const nq = normalizedQuestion;

  const rulesForLang = getRulesForLanguage(language);
  let candidateRules = [];

  // Mechanik-/Combat-Fokus: gezielt relevante Kapitel laden
  if (nq.includes("trample")) {
    candidateRules = rulesForLang.filter((r) => r.number.startsWith("702.19"));
  } else if (nq.includes("lifelink")) {
    candidateRules = rulesForLang.filter((r) => r.number.startsWith("702.15"));
  } else if (nq.includes("deathtouch")) {
    candidateRules = rulesForLang.filter((r) => r.number.startsWith("702.2"));
  } else if (nq.includes("double strike")) {
    // Double Strike + Combat Damage
    const ds = rulesForLang.filter((r) => r.number.startsWith("702.4"));
    const cd = rulesForLang.filter((r) => r.number.startsWith("510."));
    candidateRules = [...ds, ...cd];
  } else if (nq.includes("first strike")) {
    const fs = rulesForLang.filter((r) => r.number.startsWith("702.7"));
    const cd = rulesForLang.filter((r) => r.number.startsWith("510."));
    candidateRules = [...fs, ...cd];
  } else if (
    nq.includes("combat damage") ||
    nq.includes("attack") ||
    nq.includes("block")
  ) {
    const cd = rulesForLang.filter((r) => r.number.startsWith("510."));
    const ds = rulesForLang.filter((r) => r.number.startsWith("702.4"));
    const fs = rulesForLang.filter((r) => r.number.startsWith("702.7"));
    candidateRules = [...cd, ...ds, ...fs];
  } else {
    // generischer Fallback
    candidateRules = findRelevantRules(normalizedQuestion, language, 5);
  }

  if (candidateRules.length > 10) {
    candidateRules = candidateRules.slice(0, 10);
  }

  console.log("candidateRules count:", candidateRules.length);

  let contextText = "";

  if (candidateRules.length) {
    // Kontext klein halten: nur Header + einige Folgezeilen
    const isCombat =
      nq.includes("trample") ||
      nq.includes("lifelink") ||
      nq.includes("deathtouch") ||
      nq.includes("double strike") ||
      nq.includes("first strike") ||
      nq.includes("combat damage") ||
      nq.includes("attack") ||
      nq.includes("block");

    const maxExtraLines = isCombat ? 10 : 3;

    contextText = candidateRules
      .map((r) => {
        const lines = r.text.split(/\r?\n/);
        const header = lines[0] || "";
        const rest = lines.slice(1, 1 + maxExtraLines).join(" ");
        return `Rule ${r.number}:\n${header}\n${rest}`;
      })
      .join("\n\n");
  }

  // Sprachspezifischer System-Prompt (etwas weniger streng, damit er eher eine Regel wählt)
  const systemPromptDE =
    "Du bist ein Experte für die Magic: The Gathering Comprehensive Rules.\n" +
    "Du bekommst AUSZÜGE aus den umfassenden Regeln.\n" +
    "Du SOLLST deine Antwort überwiegend auf diese Auszüge stützen.\n" +
    "Deine Aufgabe: Wähle die EINE Regelnummer im Format 000.0 oder 000.0a, " +
    "die am besten zur Frage passt.\n" +
    "Wenn mehrere Regeln passen, nimm die wichtigste / allgemeinste.\n" +
    "Nur wenn keine Regel im Kontext erkennbar zur Frage passt, antworte GENAU: NONE.\n" +
    "Erkläre deine Antwort nicht. Gib nur die Regelnummer oder NONE aus.";

  const systemPromptEN =
    "You are an expert for Magic: The Gathering Comprehensive Rules.\n" +
    "You will be given EXCERPTS from the Comprehensive Rules.\n" +
    "You SHOULD base your answer primarily on these excerpts.\n" +
    "Your task: Choose the ONE rules number in the format 000.0 or 000.0a " +
    "that best answers the question.\n" +
    "If multiple rules are relevant, pick the most important/general one.\n" +
    "Only if no rule in the context clearly relates to the question, " +
    "answer EXACTLY: NONE.\n" +
    "Do not explain your answer. Output only the rule number or NONE.";

  const systemPrompt = language === "de" ? systemPromptDE : systemPromptEN;

  // User-Prompt: Originalfrage + normalisierte Frage + Kontext
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
    (language === "de" ? "Frage:\n" : "Question:\n") +
    question.trim() +
    "\n\n" +
    (language === "de"
      ? "Normalisierte Frage:\n"
      : "Normalized question:\n") +
    normalizedQuestion.trim() +
    "\n\n" +
    (language === "de"
      ? "Antwort (nur eine Regelnummer oder NONE):"
      : "Answer (only one rule number or NONE):");

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
