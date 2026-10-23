// Dictated checklists arrive without separators ("milk bread chicken potatoes"): the local model
// says where the items start and end. The answer is accepted only when it uses exactly the
// dictated words in order, so the model can group words but never invent or drop any.
const PROMPT = 'The user dictated a checklist without separators. Split it into the intended items. Keep multi-word items together (peanut butter, orange juice). Keep the original words and order, change nothing. Answer with ONLY a JSON array of strings.';
const words = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/** True when `items` are the words of `text`, in order, just grouped. */
export function sameWords(text, items) {
  const a = words(text);
  const b = items.flatMap(words);
  return a.length === b.length && a.every((w, i) => w === b[i]);
}

/** One short, deterministic question to the local model: `ask(system, user)` → its text. */
export function createCompleter({ endpoint = process.env.TODOS_AI_URL || 'http://127.0.0.1:18090', model = process.env.TODOS_AI_MODEL || 'qwen-local', timeout = Number(process.env.TODOS_SPLIT_TIMEOUT_MS) || 6000 } = {}) {
  return async function ask(system, user) {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(timeout), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 400, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'system', content: system }, { role: 'user', content: String(user).slice(0, 6000) }] }),
    });
    if (!response.ok) throw new Error('model unavailable');
    return String((await response.json()).choices?.[0]?.message?.content ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  };
}

export function createDictationSplitter(options = {}) {
  const ask = createCompleter(options);
  return async function split(text) {
    const items = JSON.parse(await ask(PROMPT, String(text).slice(0, 1000)));
    if (!Array.isArray(items) || !items.every((i) => typeof i === 'string' && i.trim()) || !sameWords(text, items)) throw new Error('model changed the words');
    return items.map((i) => i.trim());
  };
}
