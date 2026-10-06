import { createServer as createHttpServer } from 'node:http';
import { createServer as createViteServer } from 'vite';

const HOST = '127.0.0.1';
const BACKEND_PORT = 3001;
const FRONTEND_PORT = 5173;
const OLLAMA_URL = 'http://127.0.0.1:11434';
const MODEL_NAME = 'llama3.2:latest';
const MAX_BODY_SIZE = 1024 * 1024;
const SYSTEM_PROMPT = [
  "Answer the user's question directly and clearly.",
  'Be concise and helpful.',
  'Do not invent information.',
  'Do not claim to lack real-time access when the backend supplies current date and time.',
  'Use the supplied current local date and time when answering time or date questions.',
].join(' ');

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_SIZE) {
      throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    }
  }

  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 });
  }
}

async function callOllama(path, options) {
  try {
    return await fetch(`${OLLAMA_URL}${path}`, {
      ...options,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') {
      throw Object.assign(new Error('Ollama took too long to respond. Please try again.'), { status: 504 });
    }
    throw Object.assign(new Error('Ollama is not running. Start Ollama and try again.'), { status: 503 });
  }
}

function getCurrentLocalDateTime() {
  const now = new Date();
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(now);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(now);
  return { date, time };
}

function answerDateTimeQuestion(message) {
  const asksTime = /\b(?:what(?:'s| is)\s+(?:the\s+)?time(?:\s+(?:is\s+it|now|right now))?|what\s+time\s+is\s+it(?:\s+now)?|current\s+time|time\s+(?:now|right now))\b/i.test(message);
  const asksDate = /\b(?:what(?:'s| is)\s+(?:the\s+)?date(?:\s+is\s+it)?(?:\s+today)?|what\s+date\s+is\s+it(?:\s+today)?|today['’]?s\s+date|current\s+date|what\s+day\s+is\s+it(?:\s+today)?)\b/i.test(message);

  if (!asksTime && !asksDate) return null;

  const { date, time } = getCurrentLocalDateTime();
  if (asksTime && asksDate) return `The current local time is ${time}. Today's date is ${date}.`;
  if (asksTime) return `The current local time is ${time} on ${date}.`;
  return `Today's date is ${date}.`;
}

const backend = createHttpServer(async (request, response) => {
  const pathname = new URL(request.url, `http://${HOST}`).pathname;

  if (request.method === 'GET' && pathname === '/api/ollama/tags') {
    try {
      const upstream = await callOllama('/api/tags');
      const body = await upstream.text();
      response.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      });
      response.end(body);
    } catch (error) {
      sendJson(response, error.status ?? 503, { error: error.message });
    }
    return;
  }

  if (request.method === 'POST' && pathname === '/api/ollama/chat') {
    try {
      const body = await readJsonBody(request);
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        !Array.isArray(body.messages) ||
        body.messages.length === 0 ||
        body.messages.some(
          (message) =>
            !message ||
            !['user', 'assistant', 'system'].includes(message.role) ||
            typeof message.content !== 'string',
        )
      ) {
        sendJson(response, 400, { error: 'A non-empty array of valid chat messages is required.' });
        return;
      }

      const latestUserMessage = [...body.messages].reverse().find((message) => message.role === 'user');
      if (!latestUserMessage) {
        sendJson(response, 400, { error: 'At least one user message is required.' });
        return;
      }

      const dateTimeAnswer = answerDateTimeQuestion(latestUserMessage.content);
      if (dateTimeAnswer) {
        sendJson(response, 200, { message: { role: 'assistant', content: dateTimeAnswer } });
        return;
      }

      const { date, time } = getCurrentLocalDateTime();
      const systemMessage = {
        role: 'system',
        content: `${SYSTEM_PROMPT} Current local date: ${date}. Current local time: ${time}.`,
      };
      const upstream = await callOllama('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL_NAME,
          messages: [systemMessage, ...body.messages],
          stream: false,
        }),
      });
      const result = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        sendJson(response, upstream.status, {
          error: result?.error || `Ollama returned HTTP ${upstream.status}.`,
        });
        return;
      }
      if (typeof result?.message?.content !== 'string') {
        sendJson(response, 502, { error: 'Ollama returned an invalid chat response.' });
        return;
      }
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.status ?? 503, { error: error.message });
    }
    return;
  }

  sendJson(response, 404, { error: 'Not found.' });
});

const vite = await createViteServer({
  configFile: './vite.config.js',
  server: { host: HOST, port: FRONTEND_PORT, strictPort: true },
});

try {
  await new Promise((resolve, reject) => {
    backend.once('error', reject);
    backend.listen(BACKEND_PORT, HOST, resolve);
  });
  await vite.listen();
} catch (error) {
  backend.close();
  await vite.close();
  throw error;
}

console.log(`LocalChat backend listening at http://${HOST}:${BACKEND_PORT}`);
vite.printUrls();

async function shutdown() {
  backend.close();
  await vite.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
