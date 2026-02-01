# build_embeddings.py
# Liest MTG-Rules.txt, baut Embeddings (all-MiniLM-L6-v2),
# speichert rules_with_embeddings.json

import json
import os
from sentence_transformers import SentenceTransformer

RULES_FILE = "MTG-Rules.txt"
OUTPUT_FILE = "rules_with_embeddings.json"

def parse_rules_server(raw: str):
    lines = raw.splitlines()
    current_rule_number = None
    current_buffer = []
    rules = []
    import re
    rule_header_regex = re.compile(r"^(\d{3}(?:\.\d+[a-z]?)?)\s*(.*)$")

    def flush():
        nonlocal current_rule_number, current_buffer, rules
        if current_rule_number is not None:
            rules.append({
                "number": current_rule_number,
                "text": "\n".join(current_buffer).strip()
            })
            current_rule_number = None
            current_buffer = []

    for line in lines:
        m = rule_header_regex.match(line)
        if m:
            flush()
            current_rule_number = m.group(1)
            current_buffer.append(line)
        else:
            if current_rule_number is not None:
                current_buffer.append(line)
    flush()
    return rules

def main():
    if not os.path.exists(RULES_FILE):
        raise FileNotFoundError(f"{RULES_FILE} not found in current directory")

    with open(RULES_FILE, "r", encoding="utf-8") as f:
        raw = f.read()

    rules = parse_rules_server(raw)
    print("Parsed rules:", len(rules))

    model_name = "sentence-transformers/all-MiniLM-L6-v2"
    print("Loading model:", model_name)
    model = SentenceTransformer(model_name)

    out = []
    texts = [r["text"] for r in rules]
    numbers = [r["number"] for r in rules]

    print("Computing embeddings...")
    embeddings = model.encode(texts, batch_size=16, show_progress_bar=True)

    for num, txt, emb in zip(numbers, texts, embeddings):
        out.append({
            "number": num,
            "text": txt,
            "embedding": emb.tolist()
        })

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f)

    print("Saved embeddings to:", OUTPUT_FILE)

if __name__ == "__main__":
    main()
