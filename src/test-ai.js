// Quick AI connectivity test. Run: npm run test-ai
// Makes one tiny real API call using your .env settings and prints the exact
// result (or the exact error), so we can see why extraction is failing.
import { config } from "./config.js";

const { provider, apiKey, model, baseUrl } = config.ai;

console.log("\n--- AI config ---");
console.log("provider :", provider);
console.log("model    :", model);
console.log("baseURL  :", baseUrl);
console.log("api key  :", apiKey ? `${apiKey.slice(0, 7)}…${apiKey.slice(-4)} (length ${apiKey.length})` : "MISSING");
if (!apiKey) { console.log("\n❌ AI_API_KEY is empty in .env. Add your key and retry.\n"); process.exit(1); }

try {
  let res, body;
  if (provider === "anthropic") {
    res = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word: ok" }] }),
    });
    body = await res.text();
  } else {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word: ok" }] }),
    });
    body = await res.text();
  }

  console.log("\n--- result ---");
  console.log("HTTP status:", res.status, res.statusText);
  if (res.ok) {
    console.log("✅ SUCCESS — your key and model work. The scraper should now extract jobs.");
  } else {
    console.log("❌ FAILED. The API returned this error:\n");
    console.log(body.slice(0, 600));
    console.log("\nCommon fixes:");
    console.log(" • 401 / authentication  -> wrong or expired API key in .env");
    console.log(" • 404 / model not found -> set AI_MODEL in .env to a model your account has");
    console.log(" • 400 / credit/billing  -> add credit to your provider account");
    console.log(" • provider mismatch     -> AI_PROVIDER must match the key (anthropic vs openai)");
  }
  console.log("");
} catch (e) {
  console.log("\n❌ Network/other error:", e.message, "\n");
}
