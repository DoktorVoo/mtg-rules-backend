import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // falls Node < 18, ansonsten kannst du den Import weglassen

const app = express();
const port = process.env.PORT || 10000;

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama3-70b-8192"; // starkes Modell, gut für Regeln

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("MTG Rules classifier backend (Groq) is running.");
});

app.post("/classifyRule", async (req, res) => {
  console.log("Incoming /classifyRule request:", req.body);

  const apiKey = process.env.GROQ_API_KEY;
  console.log("GROQ_API_KEY set?", !!apiKey);

  if (!apiKey) {
    console.error("No GROQ_API_KEY configured");
    return res.status(500).json({ error: "Server misconfigured: missing API key" });
  }

  const { question, language = "de" } = req.body || {};

  if (!question || typeof question !== "string") {
    console.log("Bad request: missing 'question'");
    return res.status(400).json({ error: "Missing 'question' string in body" });
  }

  const systemPrompt =
    "You are an expert for Magic: The Gathering Comprehensive Rules.\n" +
    "You receive a rules question in German or English.\n" +
    "Your task: Answer with EXACTLY one comprehensive rules number " +
    "in the format 000.0 or 000.0a (e.g. 702.2 or 613.1g).\n" +
    "If you are not sure which rule applies, or the question is not a rules question,\n" +
    "answer EXACTLY: NONE.\n" +
    "Do not explain your answer. Output only the rule number or NONE.";

  const userPrompt =
    `Question (${language}):\n` +
    question.trim() +
    "\n\nAnswer (only rule number or NONE):";

  try {
    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
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
      return res.status(502).json({ error: "LLM call failed", details: errorText });
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
        ruleNumber = m[1];
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
