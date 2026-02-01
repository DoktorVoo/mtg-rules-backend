// server.js – semantische Suche mit lokalen Embeddings (all-MiniLM-L6-v2) + Groq
// mit erweiterter deutscher Normalisierung

import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // falls Node < 18
import fs from "fs";
import path from "path";

const app = express();
const port = process.env.PORT || 10000;

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

app.use(cors());
app.use(express.json());

/* ======================================
   Regeln + Embeddings laden
   ====================================== */

const EMBEDDINGS_FILE = path.join(process.cwd(), "rules_with_embeddings.json");
const RULES_DE_FILE = path.join(process.cwd(), "MTG-RulesDE.txt");

let rulesWithEmbeddings = []; // [{ number, text, embedding }]
let serverRulesDE = []; // [{ number, text }]

function loadRulesWithEmbeddings() {
  try {
    const raw = fs.readFileSync(EMBEDDINGS_FILE, "utf8");
    rulesWithEmbeddings = JSON.parse(raw);
    console.log("Loaded rules_with_embeddings:", rulesWithEmbeddings.length);
  } catch (e) {
    console.error("Could not load rules_with_embeddings.json:", e);
    rulesWithEmbeddings = [];
  }
}

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

function loadRulesDE() {
  try {
    const raw = fs.readFileSync(RULES_DE_FILE, "utf8");
    serverRulesDE = parseRulesServer(raw);
    console.log("Loaded DE rules:", serverRulesDE.length);
  } catch (e) {
    console.error("Could not load MTG-RulesDE.txt:", e);
    serverRulesDE = [];
  }
}

loadRulesWithEmbeddings();
loadRulesDE();

/* ======================================
   Hilfsfunktionen
   ====================================== */

function normalizeQuestion(question, language) {
  if (!question) return "";
  let q = question.toLowerCase();

  if (language === "de") {
    // Mechaniken → englische Schlüsselwörter

    // Trample
    q = q.replace(/tampelschaden/g, "trampelschaden");
    q = q.replace(/trampelschaden/g, "trample");
    q = q.replace(/trampel schaden/g, "trample");
    q = q.replace(/überrennen/g, "trample");

    // Lifelink
    q = q.replace(/lebensverknüpfung/g, "lifelink");
    q = q.replace(/lebensverbindung/g, "lifelink");
    q = q.replace(/lebensbindung/g, "lifelink");

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

    // First strike
    q = q.replace(/erst schlag/g, "erstschlag");
    q = q.replace(/erstschlag/g, "first strike");
    q = q.replace(/firststrike/g, "first strike");

    // Double strike
    q = q.replace(/doppel schlag/g, "doppelschlag");
    q = q.replace(/doppelschlag/g, "double strike");
    q = q.replace(/doppelangriff/g, "double strike");
    q = q.replace(/doublestrike/g, "double strike");

    // Indestructible / Unzerstörbarkeit
    q = q.replace(/unzerst[öo]rbar(?:keit)?/g, "indestructible");
    q = q.replace(/unzerst[öo]rlichkeit/g, "indestructible");
    q = q.replace(/nicht zerst[öo]rbar/g, "indestructible");

    // Hexproof / Fluchsicher
    q = q.replace(/fluchsicher/g, "hexproof");
    q = q.replace(/fluch sicher/g, "hexproof");

    // Ward
    q = q.replace(/\bward\b/g, "ward");

    // Vigilance
    q = q.replace(/w[aä]chterhaft/g, "vigilance");
    q = q.replace(/w[aä]chter/g, "vigilance");

    // Menace
    q = q.replace(/bedrohung/g, "menace");
    q = q.replace(/bedrohlich/g, "menace");

    // Reach
    q = q.replace(/reichweite/g, "reach");

    // Prowess
    q = q.replace(/meisterschaft/g, "prowess");

    // Infect / Wither
    q = q.replace(/vergiftung/g, "infect");
    q = q.replace(/infekt/g, "infect");
    q = q.replace(/schw[aä]chung/g, "wither");

    // Protection
    q = q.replace(/schutz vor/g, "protection from");
    q = q.replace(/schutz gegen/g, "protection from");

    // ---------------- Kampf / Schaden ----------------

    // Tödlicher Schaden zuerst, damit danach "schaden" → "damage" nicht dazwischen funkt
    q = q.replace(/t[öo]dlich(en|er|em)? schaden/g, "lethal damage");
    q = q.replace(/t[öo]dlichen schaden/g, "lethal damage");
    q = q.replace(/t[öo]dlicher schaden/g, "lethal damage");
    q = q.replace(/t[öo]dlicher damage/g, "lethal damage");

    // Allgemeiner Schaden
    q = q.replace(/\bschaden\b/g, "damage");
    q = q.replace(/kampfschaden/g, "combat damage");

    // Angreifen / Blocken
    q = q.replace(/angreif(en|er|erinnen|ernde)?/g, "attack");
    q = q.replace(/greift an/g, "attacks");
    q = q.replace(/greifen an/g, "attacks");
    q = q.replace(/block(en|er|erinnen|ende)?/g, "block");
    q = q.replace(/geblockt/g, "blocked");

    // Stirbt / Tod
    q = q.replace(/stirbt\b/g, "dies");
    q = q.replace(/stirbt die kreatur/g, "creature dies");
    q = q.replace(/stirbt eine kreatur/g, "creature dies");
    q = q.replace(/stirbt ein(e)? spieler(in)?/g, "player loses the game");

    // Zerstören / zerstört
    q = q.replace(/zerst[öo]ren/g, "destroy");
    q = q.replace(/zerst[öo]rt\b/g, "destroyed");
    q = q.replace(/vernichten/g, "destroy");


    // ---------------- Marken / Counters ----------------

    q = q.replace(/\+1\/\+1[- ]?marke[n]?/g, "+1/+1 counter");
    q = q.replace(/-1\/-1[- ]?marke[n]?/g, "-1/-1 counter");
    q = q.replace(/zeitmarke[n]?/g, "time counter");
    q = q.replace(/giftmarke[n]?/g, "poison counter");
    q = q.replace(/ladungsmarke[n]?/g, "charge counter");
    q = q.replace(/marke[n]?/g, "counter");

    // Toughness / Power
    q = q.replace(/\bverteidigung\b/g, "toughness");
    q = q.replace(/\bwiderstandskraft\b/g, "toughness");
    q = q.replace(/\bresi\b/g, "toughness");
    q = q.replace(/\bangriffskraft\b/g, "power");

    // ---------------- Zonen / Kartentypen ----------------

    q = q.replace(/friedhof\b/g, "graveyard");
    q = q.replace(/handkarte[n]?/g, "hand");
    q = q.replace(/\bhand\b/g, "hand");
    q = q.replace(/bibliothek/g, "library");
    q = q.replace(/stapel\b/g, "stack");
    q = q.replace(/exil\b/g, "exile");
    q = q.replace(/kommandozone/g, "command zone");
    q = q.replace(/spielfeld/g, "battlefield");
    q = q.replace(/im spiel/g, "battlefield");

    q = q.replace(/hexerei/g, "sorcery");
    q = q.replace(/spontanzauber/g, "instant");
    q = q.replace(/verzauberung/g, "enchantment");
    q = q.replace(/artefakt/g, "artifact");
    q = q.replace(/planeswalker/g, "planeswalker");
    q = q.replace(/\bzauber\b/g, "spell");
    q = q.replace(/\bbleibende[rn]? zauber\b/g, "permanent");

    // ---------------- Spielstruktur / Trigger ----------------

    q = q.replace(/anwendung von zustandsbasierten aktionen/g, "state-based actions");
    q = q.replace(/zustandsbasierte aktionen/g, "state-based actions");
    q = q.replace(/zustandsbasierter effekt/g, "state-based action");

    q = q.replace(/ausl[öo]s(er|en|ende)/g, "trigger");
    q = q.replace(/ausgel[öo]st/g, "triggered");
    q = q.replace(/ausl[öo]sende f[aä]higkeit/g, "triggered ability");

    q = q.replace(/ersatz(ef)?fekt/g, "replacement effect");
    q = q.replace(/ersatz effekte/g, "replacement effects");

    q = q.replace(/mulligan/g, "mulligan");
  } else {
    q = q.replace(/trampel damage/g, "trample damage");
  }

  return q;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * "Pseudo-Embedding" für Fragen:
 * Nutzt die vorhandenen Embeddings der Regeln und baut
 * einen Frage-Vektor als Durchschnitt der Embeddings
 * von Regeln, die einzelne Tokens enthalten.
 */
function embedQuestionNaive(text) {
  const tokens = text
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/gi, ""))
    .filter((w) => w.length > 2);

  if (!tokens.length || !rulesWithEmbeddings.length) return null;

  const dim = rulesWithEmbeddings[0].embedding.length;
  const vec = new Array(dim).fill(0);
  let count = 0;

  for (const token of tokens) {
    const lowerToken = token.toLowerCase();
    for (const r of rulesWithEmbeddings) {
      if (r.text.toLowerCase().includes(lowerToken)) {
        const emb = r.embedding;
        for (let i = 0; i < dim; i++) {
          vec[i] += emb[i];
        }
        count++;
        break;
      }
    }
  }

  if (count === 0) return null;
  for (let i = 0; i < dim; i++) {
    vec[i] /= count;
  }
  return vec;
}

function findSimilarRules(normalizedQuestion, maxResults = 15) {
  if (!rulesWithEmbeddings.length || !normalizedQuestion) return [];

  const qEmbedding = embedQuestionNaive(normalizedQuestion);
  if (!qEmbedding) return [];

  const scored = rulesWithEmbeddings.map((r) => ({
    number: r.number,
    text: r.text,
    score: cosineSimilarity(qEmbedding, r.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

/* ======================================
   Express-Routen
   ====================================== */

app.get("/", (req, res) => {
  res.send("MTG Rules classifier backend (semantic-ish, local embeddings) is running.");
});

app.post("/classifyRule", async (req, res) => {
  console.log("Incoming /classifyRule request:", req.body);

  const groqKey = process.env.GROQ_API_KEY;
  console.log("GROQ_API_KEY set?", !!groqKey);

  if (!groqKey) {
    console.error("No GROQ_API_KEY configured");
    return res
      .status(500)
      .json({ error: "Server misconfigured: missing GROQ_API_KEY" });
  }

  let { question, language = "de" } = req.body || {};
  if (!question || typeof question !== "string") {
    console.log("Bad request: missing 'question'");
    return res
      .status(400)
      .json({ error: "Missing 'question' string in body" });
  }

  language = language === "en" ? "en" : "de";

  const normalizedQuestion = normalizeQuestion(question, language);
  console.log("Normalized question:", normalizedQuestion);

  try {
    const similar = findSimilarRules(normalizedQuestion, 15);
    console.log("similar rules count:", similar.length);

    let contextText = "";
    if (similar.length) {
      const maxExtraLines = 8;
      contextText = similar
        .map((r) => {
          const lines = r.text.split(/\r?\n/);
          const header = lines[0] || "";
          const rest = lines.slice(1, 1 + maxExtraLines).join(" ");
          return `Rule ${r.number}:\n${header}\n${rest}`;
        })
        .join("\n\n");
    }

    const systemPromptDE =
      "Du bist ein Experte für die Magic: The Gathering Comprehensive Rules.\n" +
      "Du bekommst AUSZÜGE aus den Regeln (auf Englisch).\n" +
      "Du SOLLST deine Antwort überwiegend auf diese Auszüge stützen.\n" +
      "Deine Aufgabe: Wähle die EINE Regelnummer im Format 000.0 oder 000.0a, " +
      "die am besten zur Frage passt.\n" +
      "Wenn mehrere Regeln passen, nimm die wichtigste / allgemeinste.\n" +
      "Nur wenn keine Regel im Kontext erkennbar zur Frage passt, antworte GENAU: NONE.\n" +
      "Erkläre deine Antwort nicht. Gib nur die Regelnummer oder NONE aus.";

    const systemPromptEN =
      "You are an expert for Magic: The Gathering Comprehensive Rules.\n" +
      "You will be given EXCERPTS from the rules (in English).\n" +
      "You SHOULD base your answer primarily on these excerpts.\n" +
      "Your task: Choose the ONE rules number in the format 000.0 or 000.0a " +
      "that best answers the question.\n" +
      "If multiple rules are relevant, pick the most important/general one.\n" +
      "Only if no rule in the context clearly relates to the question, " +
      "answer EXACTLY: NONE.\n" +
      "Do not explain your answer. Output only the rule number or NONE.";

    const systemPrompt = language === "de" ? systemPromptDE : systemPromptEN;

    const userPrompt =
      (contextText
        ? (language === "de"
            ? "Relevante Regelauszüge (EN):\n\n"
            : "Relevant rule excerpts (EN):\n\n") +
          contextText +
          "\n\n"
        : language === "de"
        ? "Keine Regelauszüge verfügbar.\n\n"
        : "No rule excerpts available.\n\n") +
      (language === "de" ? "Frage (DE):\n" : "Question:\n") +
      question.trim() +
      "\n\n" +
      (language === "de"
        ? "Normalisierte Frage (für Suche):\n"
        : "Normalized question (for search):\n") +
      normalizedQuestion.trim() +
      "\n\n" +
      (language === "de"
        ? "Antwort (nur eine Regelnummer oder NONE):"
        : "Answer (only one rule number or NONE):");

    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqKey}`,
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
        const exists = rulesWithEmbeddings.some(
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
