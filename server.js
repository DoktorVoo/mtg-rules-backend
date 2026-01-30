import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const port = process.env.PORT || 3000;

// WICHTIG: GEMINI_API_KEY kommt als Environment Variable von Render
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is not set");
}

const genAI = new GoogleGenerativeAI(apiKey);

// Modell mit langem Kontext, z.B. gemini-2.0-flash-extended (oder aktuelles Long-Context-Modell)
const MODEL_NAME = "gemini-2.0-flash";

app.use(cors());
app.use(express.json());

app.post("/classifyRule", async (req, res) => {
  try {
    const { question, language = "de" } = req.body || {};
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "Missing 'question' string" });
    }

    const systemInstruction =
      "You are an expert for Magic: The Gathering Comprehensive Rules. " +
      "You receive a rules question in German or English. " +
      "Your task: Answer with EXACTLY one comprehensive rules number in the format 000.0 or 000.0a (e.g. 702.2 or 613.1g). " +
      "If you are not sure which rule applies, or the question is not a rules question, answer EXACTLY: NONE";

    const prompt =
      systemInstruction +
      "\n\nQuestion:\n" +
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
    const first = text.split(/\s+/)[0].trim();
    const lower = first.toLowerCase();

    let ruleNumber = "NONE";
    if (lower !== "none") {
      const m = lower.match(/^(\d{3}\.\d+[a-z]?)$/);
      if (m) {
        ruleNumber = m[1];
      }
    }

    return res.json({ ruleNumber });
  } catch (e) {
    console.error("Error in /classifyRule:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

app.get("/", (req, res) => {
  res.send("MTG Rules classifier backend is running.");
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
