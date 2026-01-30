import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const port = process.env.PORT || 3000;

const apiKey = process.env.GEMINI_API_KEY;

// Basis-Checks loggen
console.log("Server starting...");
console.log("PORT =", port);
console.log("GEMINI_API_KEY gesetzt?", !!apiKey);

if (!apiKey) {
  console.error("GEMINI_API_KEY is not set");
}

const genAI = new GoogleGenerativeAI(apiKey);

// Einfaches, weit verbreitetes Modell
const MODEL_NAME = "gemini-1.5-flash";

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("MTG Rules classifier backend is running.");
});

app.post("/classifyRule", async (req, res) => {
  try {
    console.log("Incoming /classifyRule request:", req.body);

    const { question, language = "de" } = req.body || {};
    if (!question || typeof question !== "string") {
      console.log("Bad request: missing question");
      return res.status(400).json({ error: "Missing 'question' string" });
    }

    if (!apiKey) {
      console.error("No GEMINI_API_KEY configured on server");
      return res.status(500).json({ error: "Server misconfigured" });
    }

    const systemInstruction =
      "You are an expert for Magic: The Gathering Comprehensive Rules. " +
      "You receive a rules question in German or English. " +
      "Your task: Answer with EXACTLY one comprehensive rules number in the format 000.0 or 000.0a (e.g. 702.2 or 613.1g). " +
      "If you are not sure which rule applies, or the question is not a rules question, answer EXACTLY: NONE";

    const prompt =
      systemInstruction +
      "\n\nQuestion (" + language + "):\n" +
      question.trim() +
      "\n\nAnswer (only rule number or NONE):";

    const model = genAI.getGenerativeModel({ model: MODEL_NAME });

    const result = await model.generateContent({
      contents: [
        { role: "user", parts: [{ text: prompt }] }
      ],
      generationConfig: {
        maxOutputTokens: 16,
        temperature: 0.0,
      },
    });

    const text = (result.response.text() || "").trim();
    console.log("Raw Gemini answer:", JSON.stringify(text));

    const first = text.split(/\s+/)[0].trim();
    const lower = first.toLowerCase();

    let ruleNumber = "NONE";
    if (lower !== "none") {
      const m = lower.match(/^(\d{3}\.\d+[a-z]?)$/);
      if (m) {
        ruleNumber = m[1];
      } else {
        // Antwort ist irgendein anderer Text -> als NONE behandeln
        ruleNumber = "NONE";
      }
    }

    console.log("Returning ruleNumber:", ruleNumber);
    return res.json({ ruleNumber });
  } catch (e) {
    console.error("Error in /classifyRule:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
