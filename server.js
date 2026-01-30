import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("MTG Rules classifier backend is running.");
});

app.post("/classifyRule", async (req, res) => {
  console.log("Incoming /classifyRule request:", req.body);

  const apiKey = process.env.GEMINI_API_KEY;
  console.log("GEMINI_API_KEY set?", !!apiKey);

  if (!apiKey) {
    console.error("No GEMINI_API_KEY configured");
    return res.status(500).json({ error: "Server misconfigured: missing API key" });
  }

  const { question, language = "de" } = req.body || {};

  if (!question || typeof question !== "string") {
    console.log("Bad request: missing 'question'");
    return res.status(400).json({ error: "Missing 'question' string in body" });
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const systemInstruction =
      "You are an expert for Magic: The Gathering Comprehensive Rules. " +
      "You receive a rules question in German or English. " +
      "Your task: Answer with EXACTLY one comprehensive rules number " +
      "in the format 000.0 or 000.0a (e.g. 702.2 or 613.1g). " +
      "If you are not sure which rule applies, or the question is not a rules question, " +
      "answer EXACTLY: NONE.";

    const prompt =
      systemInstruction +
      "\n\nQuestion (" + language + "):\n" +
      question.trim() +
      "\n\nAnswer (only rule number or NONE):";

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
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
