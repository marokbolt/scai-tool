import OpenAI from "openai";

let _client: OpenAI | null = null;

export function getOpenRouterClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY!,
      baseURL: "https://openrouter.ai/api/v1",
    });
  }
  return _client;
}

// Second candidate in the Epic 1 model bake-off, via OpenRouter so we can
// swap candidates without adding a new SDK per vendor.
export const EXTRACTION_MODEL_OPENROUTER = "google/gemini-2.5-flash";

export async function runOpenRouterExtraction(
  base64: string,
  mediaType: string,
  prompt: string
): Promise<{ text: string; model: string; input_tokens: number; output_tokens: number }> {
  const client = getOpenRouterClient();
  const response = await client.chat.completions.create({
    model: EXTRACTION_MODEL_OPENROUTER,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mediaType};base64,${base64}` } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  const text = response.choices[0]?.message?.content ?? "";
  return {
    text: typeof text === "string" ? text : "",
    model: EXTRACTION_MODEL_OPENROUTER,
    input_tokens: response.usage?.prompt_tokens ?? 0,
    output_tokens: response.usage?.completion_tokens ?? 0,
  };
}
