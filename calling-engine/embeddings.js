import fetch from 'node-fetch';

// Same integration shape as the Kokoro TTS support already in this repo:
// a self-hosted, OpenAI-compatible server, not a hosted API. Several
// open-source embedding servers already speak this exact protocol
// (text-embeddings-inference, LocalAI, Ollama's OpenAI-compat endpoint),
// so pointing EMBEDDING_SERVICE_URL at one of those just works.
//
// Deliberately does NOT fall back to a fake/hash-based pseudo-embedding
// when unconfigured - a fake vector would make retrieval silently return
// irrelevant chunks instead of failing loudly, which is worse than telling
// the caller up front that knowledge retrieval isn't set up yet.
export async function getEmbedding(text) {
  const baseUrl = process.env.EMBEDDING_SERVICE_URL;
  if (!baseUrl) {
    throw new Error(
      'EMBEDDING_SERVICE_URL is not set - knowledge base ingestion/retrieval needs a self-hosted OpenAI-compatible embeddings server (e.g. text-embeddings-inference, LocalAI, or Ollama). Set EMBEDDING_SERVICE_URL and EMBEDDING_MODEL in .env.'
    );
  }
  const model = process.env.EMBEDDING_MODEL || 'all-MiniLM-L6-v2';

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, model }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Embedding request failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error('Embedding server returned an unexpected response shape (expected OpenAI-style {data:[{embedding:[...]}]})');
  }
  return embedding;
}

// Splits text into overlapping chunks for retrieval. Plain
// character-length chunking with paragraph-boundary preference, not
// token-aware - good enough for FAQ/short-document knowledge bases; a
// long technical document would benefit from a smarter (sentence- or
// token-based) splitter, flagged here as a known simplification.
export function chunkText(text, { chunkSize = 800, overlap = 100 } = {}) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length <= chunkSize) {
      current = current ? `${current}\n\n${para}` : para;
      continue;
    }
    if (current) chunks.push(current);
    if (para.length <= chunkSize) {
      current = para;
    } else {
      // A single paragraph longer than chunkSize - hard-split it with
      // overlap rather than producing one giant chunk.
      for (let i = 0; i < para.length; i += chunkSize - overlap) {
        chunks.push(para.slice(i, i + chunkSize));
      }
      current = '';
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text.slice(0, chunkSize)];
}

// Minimal HTML-to-text for website-URL knowledge sources. Not a real
// readability/boilerplate-stripping parser (no dependency added for it) -
// strips tags/scripts/styles and collapses whitespace. Good enough for
// simple FAQ/about pages; a JS-rendered site or a page with heavy
// nav/footer boilerplate will need a real extractor swapped in here later.
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
