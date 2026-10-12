import { createHash } from "node:crypto";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 900;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 4300;
const SERPER_TIMEOUT_MS = 1500;
const GEMINI_TIMEOUT_MS = 3700;
const SUPABASE_TIMEOUT_MS = 1500;

const SYSTEM_PROMPT = [
  "Ты — ChatGPT, голосовой помощник в навыке «ЧАТ ДЖИПИТИ». Ты работаешь на основе Google Gemini.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

function getSupabaseConfig() {
  const urlValue = String(process.env.SUPABASE_URL || "").trim();
  const key = String(
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ""
  ).trim();

  if (!urlValue || !key) return null;

  try {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== "https:") return null;
    return { url: parsed.origin, key };
  } catch {
    return null;
  }
}

function getMemoryConversationId(session) {
  const skillId = String(session?.skill_id || "").trim();
  if (!skillId) return null;

  const userId = String(session?.user?.user_id || "").trim();
  const applicationId = String(session?.application?.application_id || "").trim();
  const identityType = userId ? "user" : applicationId ? "application" : "";
  const identityValue = userId || applicationId;

  // Do not create a shared fallback memory if Yandex provides no stable identity.
  if (!identityType || !identityValue) return null;

  // Store only a one-way identifier, not the raw Yandex ID.
  return createHash("sha256")
    .update(`alice-memory:v1:${skillId}:${identityType}:${identityValue}`)
    .digest("hex");
}

async function supabaseRequest(resource, options = {}, timeoutMs = SUPABASE_TIMEOUT_MS) {
  const config = getSupabaseConfig();
  if (!config) throw new Error("SUPABASE_NOT_CONFIGURED");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  const headers = {
    ...(options.headers || {}),
    apikey: config.key
  };

  // Legacy service_role keys are JWTs. New sb_secret_* keys must be sent as apikey only.
  if (!config.key.startsWith("sb_")) {
    headers.Authorization = `Bearer ${config.key}`;
  } else {
    delete headers.Authorization;
  }

  try {
    const response = await fetch(`${config.url}/rest/v1/${resource}`, {
      ...options,
      headers,
      signal: controller.signal
    });
    const raw = await response.text();
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    }

    if (!response.ok) {
      throw new Error(`SUPABASE_HTTP_${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function loadPersistentHistory(conversationId, timeoutMs = SUPABASE_TIMEOUT_MS) {
  const filter = new URLSearchParams({
    select: "history",
    conversation_id: `eq.${conversationId}`,
    limit: "1"
  });

  try {
    const rows = await supabaseRequest(`alice_memory?${filter.toString()}`, {
      method: "GET"
    }, timeoutMs);
    const row = Array.isArray(rows) ? rows[0] : null;
    return {
      ok: true,
      found: Boolean(row),
      history: safeHistory(row?.history)
    };
  } catch (error) {
    console.warn("Supabase memory read failed:", error?.message || "unknown error");
    return { ok: false, found: false, history: [] };
  }
}

async function savePersistentHistory(
  conversationId,
  history,
  timeoutMs = SUPABASE_TIMEOUT_MS,
  insertOnly = false
) {
  try {
    await supabaseRequest("alice_memory?on_conflict=conversation_id", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: `resolution=${insertOnly ? "ignore-duplicates" : "merge-duplicates"},return=minimal`
      },
      body: JSON.stringify({
        conversation_id: conversationId,
        history: safeHistory(history),
        updated_at: new Date().toISOString()
      })
    }, timeoutMs);
    return true;
  } catch (error) {
    console.warn("Supabase memory write failed:", error?.message || "unknown error");
    return false;
  }
}

async function clearPersistentHistory(conversationId, timeoutMs = SUPABASE_TIMEOUT_MS) {
  const filter = new URLSearchParams({
    conversation_id: `eq.${conversationId}`
  });

  try {
    await supabaseRequest(`alice_memory?${filter.toString()}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" }
    }, timeoutMs);
    return true;
  } catch (error) {
    console.warn("Supabase memory delete failed:", error?.message || "unknown error");
    return false;
  }
}

function isForgetMemoryRequest(text) {
  return /забуд[ьи]\s+(?:всё|все|всё обо мне|все факты)|очисти\s+(?:свою\s+)?(?:память|историю)|удали\s+(?:(?:всю|все)\s+)?(?:память|историю)|сотри\s+(?:(?:всю|все)\s+)?(?:память|историю)/i.test(text);
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const startedAt = Date.now();
  const key = process.env.SERPER_API_KEY;
  if (!key) {
    console.warn("Serper search skipped: SERPER_API_KEY is not configured.");
    return "";
  }
  if (timeoutMs < 150) {
    console.warn("Serper search skipped: insufficient time budget", timeoutMs);
    return "";
  }

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const organicResults = Array.isArray(data.organic) ? data.organic : [];
    const items = organicResults
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);

    console.info("Serper search completed:", JSON.stringify({
      durationMs: Date.now() - startedAt,
      organicResults: organicResults.length,
      answerBox: Boolean(answerBox)
    }));

    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn(
      "Serper search failed; continuing without search:",
      error?.name || "UnknownError",
      error?.message || "No error message"
    );
    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          maxOutputTokens: 120,
          thinkingConfig: {
            thinkingLevel: "minimal"
          }
        }
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error("Gemini request failed with HTTP", status);
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Vercel.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const stateHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      stateHistory
    ));
  }

  const yandexSession = body?.session && typeof body.session === "object" ? body.session : {};
  const supabaseConfig = getSupabaseConfig();
  const memoryConversationId = supabaseConfig ? getMemoryConversationId(yandexSession) : null;

  if (isForgetMemoryRequest(text)) {
    if (supabaseConfig && memoryConversationId) {
      const cleared = await clearPersistentHistory(
        memoryConversationId,
        Math.min(SUPABASE_TIMEOUT_MS, Math.max(100, remainingMs() - 100))
      );
      if (!cleared) {
        return res.status(200).json(aliceResponse(
          "Не удалось очистить сохранённую память прямо сейчас. Попробуйте ещё раз.",
          false,
          []
        ));
      }
    }
    return res.status(200).json(aliceResponse(
      "Хорошо, начнём с чистого листа.",
      false,
      []
    ));
  }

  let oldHistory = stateHistory;
  let canSavePersistentHistory = Boolean(supabaseConfig && memoryConversationId);
  let persistentReadSucceeded = false;

  if (supabaseConfig && !memoryConversationId) {
    console.warn("Supabase memory skipped: Yandex session has no stable user or application identity.");
  }

  try {
    // Read memory and search the web in parallel to fit Alice's response-time budget.
    const memoryReadPromise = canSavePersistentHistory
      ? loadPersistentHistory(
          memoryConversationId,
          Math.min(SUPABASE_TIMEOUT_MS, Math.max(100, remainingMs() - 2200))
        )
      : Promise.resolve({ ok: false, found: false, history: [] });

    const searchPromise = isSearchIntent(text) && process.env.SERPER_API_KEY
      ? searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2200)))
      : Promise.resolve("");

    const [stored, searchContext] = await Promise.all([memoryReadPromise, searchPromise]);

    if (stored.ok) {
      oldHistory = stored.found ? stored.history : stateHistory;
      persistentReadSucceeded = true;
    } else if (canSavePersistentHistory) {
      // On read failure, allow an insert-only write after the answer; never overwrite existing memory.
      oldHistory = stateHistory;
    }

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 700))
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    if (canSavePersistentHistory) {
      const saved = await savePersistentHistory(
        memoryConversationId,
        history,
        Math.min(SUPABASE_TIMEOUT_MS, Math.max(100, remainingMs() - 100)),
        !persistentReadSucceeded
      );
      if (!saved) {
        console.warn("Supabase memory was not saved for this turn.");
      }
    }

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = error?.name === "AbortError" || /aborted/i.test(String(error?.message || ""))
      ? new Error("TIME_BUDGET_EXHAUSTED")
      : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory };
