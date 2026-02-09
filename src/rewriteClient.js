const DEFAULT_TIMEOUT_MS = 20000;

function extractText(data) {
  // Claude returns: { content: [ { type:"text", text:"..." }, ... ] }
  if (!data || !Array.isArray(data.content)) return null;
  const texts = data.content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text);
  return texts.length ? texts.join("\n").trim() : null;
}

async function rewriteText({ originalText }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-4-6";
  const url = process.env.REWRITE_API_URL || "https://api.anthropic.com/v1/messages";

  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY in .env");
  if (!originalText || typeof originalText !== "string") throw new Error("Missing originalText");

  const payload = {
    model,
    max_tokens: 400,
    messages: [
      {
        role: "user",
        content: `Rewrite the message below for ADHD-friendly clarity and neurotypical readability.
Do not change meaning or facts.
Return ONLY the rewritten message.

Message:
${originalText}`
      }
    ]
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch {}

  // If Claude returned an error JSON, show it
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || raw.slice(0, 300) || `HTTP ${res.status}`;
    throw new Error(`Claude API ${res.status}: ${msg}`);
  }

  const rewritten = extractText(data);
  if (!rewritten) {
    throw new Error(`Claude success response but no text block. First 300 chars: ${raw.slice(0, 300)}`);
  }

  return { rewritten_text: rewritten };
}

module.exports = { rewriteText };
