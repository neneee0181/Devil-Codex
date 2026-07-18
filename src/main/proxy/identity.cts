const NEUTRAL_IDENTITY = "You are a coding agent. Do not claim to be GPT-5 or to be made by OpenAI.";

export function neutralizeIdentity(text: string): string {
  return text
    .replace(/You are Codex, (?:a coding agent|an agent) based on GPT-5\./g, NEUTRAL_IDENTITY)
    .replace(/You are Codex, (?:a coding agent|an agent) powered by (?:the )?GPT-5(?: model)?\./g, NEUTRAL_IDENTITY);
}
