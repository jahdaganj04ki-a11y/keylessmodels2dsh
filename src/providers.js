/**
 * Complete October 2026 Keyless LLM Provider & Model Registry.
 *
 * Cross-verified against 7 independent live-probed registries and DSH plugins:
 *   - bon5co/stillworks (`https://stillworks.supercapybara.com/api/llm/up`)
 *   - saya-ch/keyless-llm (2026-10-25/26 live snapshots)
 *   - MoonLite-Br/llmfree (2026-10-24/25 multi-run >=75% reliability audit)
 *   - mvalentsev/awesome-free-ai-coding (2026-10-26 verified matrix)
 *   - 0xzr/freellmpool (`providers.toml` v0.13.0)
 *   - JoLiKs/free-ai-hub (keyless + CORS host analysis)
 *   - Ebony-Vinyl/dsh-our-free-model & qianmo978/dsh-kilo-gateway
 *
 * Because DSH's LLM adapter executes inside the Node/Electron Host process
 * (`ELECTRON_RUN_AS_NODE=1` on Windows), requests bypass browser CORS limits
 * that block pure web apps from calling Kilo Gateway, VLM Run, or BlockRun.
 *
 * @module src/providers.js
 */

/** Main unified provider route in DSH Desktop's Model Picker. */
export const UNIFIED_ROUTE = 'keyless-free'

/** Prefix for optional per-provider routes (`keyless-kilo`, `keyless-ovh`, ...). */
export const PROVIDER_ROUTE_PREFIX = 'keyless-'

/** Hourly live-verified keyless endpoint feed published by Stillworks. */
export const STILLWORKS_SHELF_URL = 'https://stillworks.supercapybara.com/api/llm/up'

/** Models that are non-chat (TTS, ASR, embeddings, safety guards, image/video gen). */
const NON_CHAT_ID_RE =
  /(whisper|(?:\b|[-_/])tts(?:\b|[-_/])|embed|rerank|diffusion(?!=gemma)|stable-?diffusion|sdxl|\bflux\b|dall-?e|imagen|midjourney|\bocr\b|voxtral|seedance|kling|\bsora\b|\bveo\b|\bwan\d|moderation|content-safety|guard|safety|transcrib|speech|text-to-(?:image|speech|video|audio)|image-gen|-image\b|\/image|seedream|space-bunny|\bbge-|\be5-|realesrgan|\brmbg\b|demucs|upscal|inpaint)/i

const NON_CHAT_TYPES = new Set([
  'image',
  'images',
  'audio',
  'video',
  'embedding',
  'embeddings',
  'speech',
  'tts',
  'stt',
  'transcription',
  'moderation',
  'rerank',
  'reranker',
  'ocr',
  'image-generation',
  'image_generation',
  'music',
  '3d',
])

/** Known explicitly free IDs on Kilo / OpenRouter even without `:free` suffix. */
const KILO_EXPLICIT_FREE_IDS = new Set([
  'kilo-auto/free',
  'kilo-auto/small',
  'openrouter/free',
  'reflection/beam-free',
])

/**
 * Smart virtual meta-models exposed at the top of `keyless-free`.
 * Each virtual model selects and fails over across ranked healthy candidates.
 */
export const VIRTUAL_MODELS = Object.freeze([
  {
    id: 'auto',
    name: '⚡ Auto · Best Keyless (Smart Failover)',
    description: 'Wählt automatisch das beste verfügbare kostenlose Modell mit Tool-Support und wechselt bei Rate-Limits (429/503) nahtlos den Provider.',
    contextWindow: 262144,
    maxTokens: 16384,
    vision: false,
    tools: true,
    reasoning: true,
    intent: 'best',
    preferred: [
      'kilo/nvidia/nemotron-3-ultra-550b-a55b:free',
      'vireonix/auto',
      'ovh/gpt-oss-120b',
      'ovh/Qwen3.5-397B-A17B',
      'kilo/kilo-auto/free',
      'kilo/qwen/qwen3.6-plus:free',
      'chat/gpt-4o',
      'kilo-openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
      'ovh/Qwen3.8-27B',
      'llm7/gpt-oss:20b',
      'freeai/qwen7b',
      'vlmrun/qwen/qwen3.8-27b',
      'blockrun/nvidia/gpt-oss-120b',
      'rewind/gpt-4o-mini',
    ],
  },
  {
    id: 'auto-coding',
    name: '💻 Auto · Coding & Agentic Tools',
    description: 'Optimiert für Softwareentwicklung, Code-Analyse und zuverlässige DSH-Tool-Aufrufe über mehrere Keyless-Gateways.',
    contextWindow: 262144,
    maxTokens: 16384,
    vision: false,
    tools: true,
    reasoning: true,
    intent: 'coding',
    preferred: [
      'kilo/nvidia/nemotron-3-ultra-550b-a55b:free',
      'kilo/cohere/north-mini-code:free',
      'vireonix/auto',
      'ovh/Qwen3-Coder-30B-A3B-Instruct',
      'ovh/Qwen3.5-397B-A17B',
      'ovh/gpt-oss-120b',
      'llm7/codestral-latest',
      'kilo/minimax/minimax-m2.5:free',
      'kilo/qwen/qwen3.6-plus:free',
      'chat/gpt-4o',
      'freeai/qwen-coder',
      'kilo-openrouter/cohere/north-mini-code:free',
    ],
  },
  {
    id: 'auto-fast',
    name: '🚀 Auto · Ultra-Fast (Low Latency)',
    description: 'Priorisiert minimale Antwortzeit (TTFT) für schnelle Fragen, Titelgenerierung und flüssigen Chat.',
    contextWindow: 131072,
    maxTokens: 8192,
    vision: false,
    tools: true,
    reasoning: false,
    intent: 'fast',
    preferred: [
      'llm7/codestral-latest',
      'kilo/nvidia/nemotron-3.5-lightning:free',
      'chat/gpt-4o',
      'ovh/Mistral-Nemo-Instruct-2407',
      'ovh/Mistral-Small-3.2-24B-Instruct-2506',
      'rewind/gpt-4o-mini',
      'rewind/qwen/qwen-2.5-7b-instruct',
      'llm7/gpt-oss:20b',
      'kilo/kilo-auto/free',
      'chatjimmy/llama3.1-8B',
      'pollinations/openai',
    ],
  },
  {
    id: 'auto-reasoning',
    name: '🧠 Auto · Deep Reasoning (Thinking)',
    description: 'Bündelt kostenlose Reasoning-/Thinking-Modelle (inkl. nativer <think>- und reasoning_content-Extraktion).',
    contextWindow: 131072,
    maxTokens: 16384,
    vision: false,
    tools: true,
    reasoning: true,
    intent: 'reasoning',
    preferred: [
      'ovh/gpt-oss-120b',
      'kilo/arcee-ai/trinity-large-thinking:free',
      'kilo/stepfun/step-3.5-flash:free',
      'kilo/nvidia/nemotron-3-ultra-550b-a55b:free',
      'freeai/deepseek-r1',
      'llm7/gpt-oss:20b',
      'blockrun/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
      'ovh/gpt-oss-20b',
      'pollinations/openai-fast',
    ],
  },
  {
    id: 'auto-vision',
    name: '🖼️ Auto · Vision & Multimodal',
    description: 'Routet Anfragen mit Bildern automatisch an verifizierte kostenlose Vision-Modelle (VL).',
    contextWindow: 131072,
    maxTokens: 8192,
    vision: true,
    tools: true,
    reasoning: false,
    intent: 'vision',
    preferred: [
      'ovh/Qwen2.5-VL-72B-Instruct',
      'ovh/Qwen3.8-27B',
      'kilo/nvidia/nemotron-3.5-super-vl:free',
      'vlmrun/qwen/qwen3.8-27b',
      'ovh/Qwen3.6-27B',
      'kilo-openrouter/nvidia/nemotron-3.5-super-vl:free',
      'freeai/qwen7b',
      'blockrun/nvidia/llama-3.2-11b-vision',
    ],
  },
])

/**
 * Built-in Keyless Provider Definitions.
 *
 * `wire`:
 *   - `'openai'`    : OpenAI Chat Completions (`/chat/completions` SSE or JSON)
 *   - `'chatjimmy'` : ChatJimmy raw stream with `<|stats|>{json}<|/stats|>` trailer
 *   - `'ollama'`    : Ollama `/api/generate` or `/api/chat` NDJSON stream
 */
export const BUILTIN_PROVIDERS = Object.freeze([
  {
    id: 'kilo',
    name: 'Kilo Gateway (Free Pool)',
    shortName: 'Kilo',
    category: 'cloud',
    wire: 'openai',
    enabledByDefault: true,
    autoEligible: true,
    baseUrl: 'https://api.kilo.ai/api/gateway',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    headers: {},
    freeRule: { type: 'kilo' },
    concurrency: 3,
    minIntervalMs: 250,
    rateLimitNote: '~200 Anfragen/Stunde pro IP · Kein API-Key erforderlich',
    privacyNote: 'Kostenlose Kilo-Upstream-Provider können Prompts zur Dienstverbesserung protokollieren.',
    website: 'https://kilo.ai/docs/gateway',
    priority: 100,
    staticModels: [
      { id: 'kilo-auto/free', name: 'Kilo Auto Free Router', contextWindow: 200000, maxTokens: 16384, tools: true, reasoning: true },
      { id: 'openrouter/free', name: 'OpenRouter Free Router (via Kilo)', contextWindow: 200000, maxTokens: 16384, tools: true, reasoning: true },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'NVIDIA Nemotron 3 Ultra 550B', contextWindow: 262144, maxTokens: 16384, tools: true, reasoning: true },
      { id: 'nvidia/nemotron-3.5-lightning:free', name: 'NVIDIA Nemotron 3.5 Lightning', contextWindow: 262144, maxTokens: 16384, tools: true, reasoning: false },
      { id: 'nvidia/nemotron-3.5-super-vl:free', name: 'NVIDIA Nemotron 3.5 Super VL', contextWindow: 131072, maxTokens: 8192, tools: true, vision: true },
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'NVIDIA Nemotron 3 Super 120B', contextWindow: 262144, maxTokens: 16384, tools: true, reasoning: true },
      { id: 'cohere/north-mini-code:free', name: 'Cohere North Mini Code', contextWindow: 131072, maxTokens: 16384, tools: true },
      { id: 'qwen/qwen3.6-plus:free', name: 'Qwen 3.6 Plus (Free)', contextWindow: 262144, maxTokens: 16384, tools: true, reasoning: true },
      { id: 'minimax/minimax-m2.5:free', name: 'MiniMax M2.5 (Free)', contextWindow: 196608, maxTokens: 16384, tools: true, reasoning: true },
      { id: 'z-ai/glm-4.5-air:free', name: 'GLM 4.5 Air (Free)', contextWindow: 131072, maxTokens: 16384, tools: true, reasoning: true },
      { id: 'stepfun/step-3.5-flash:free', name: 'StepFun Step 3.5 Flash', contextWindow: 256000, maxTokens: 16384, tools: true, reasoning: true, reasoningCannotDisable: true },
      { id: 'arcee-ai/trinity-large-thinking:free', name: 'Arcee Trinity Large Thinking', contextWindow: 131072, maxTokens: 16384, tools: true, reasoning: true },
      { id: 'dots-studio/dots-3-note-preview:free', name: 'Dots 3 Note Preview', contextWindow: 131072, maxTokens: 8192, tools: true, reasoning: true },
      { id: 'poolside/laguna-s-2.1:free', name: 'Poolside Laguna S 2.1', contextWindow: 131072, maxTokens: 8192, tools: true },
      { id: 'liquid/lfm-2.5-2.6b:free', name: 'Liquid LFM 2.5 2.6B', contextWindow: 32768, maxTokens: 4096, tools: false },
    ],
  },
  {
    id: 'kilo-openrouter',
    name: 'Kilo OpenRouter Anonymous Lane',
    shortName: 'Kilo-OR',
    category: 'cloud',
    wire: 'openai',
    enabledByDefault: true,
    autoEligible: true,
    baseUrl: 'https://api.kilo.ai/api/openrouter',
    modelsUrl: 'https://api.kilo.ai/api/gateway/models',
    chatPath: '/chat/completions',
    headers: {
      Authorization: 'Bearer anonymous',
      'X-KILOCODE-EDITORNAME': 'kilo',
    },
    freeRule: { type: 'kilo' },
    concurrency: 2,
    minIntervalMs: 350,
    rateLimitNote: '~200 Anfragen/Stunde pro IP · Zweiter Wire-Pfad für Kilo (:free)',
    privacyNote: 'Teilt das anonyme IP-Kontingent mit Kilo Gateway, nutzt aber den OpenRouter-Wire-Pfad.',
    website: 'https://kilo.ai/docs/gateway',
    priority: 92,
    staticModels: [
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra 550B (OR-Lane)', contextWindow: 262144, maxTokens: 16384, tools: true, reasoning: true },
      { id: 'cohere/north-mini-code:free', name: 'Cohere North Mini Code (OR-Lane)', contextWindow: 131072, maxTokens: 16384, tools: true },
      { id: 'nvidia/nemotron-3.5-super-vl:free', name: 'Nemotron 3.5 Super VL (OR-Lane)', contextWindow: 131072, maxTokens: 8192, tools: true, vision: true },
      { id: 'nvidia/nemotron-3.5-lightning:free', name: 'Nemotron 3.5 Lightning (OR-Lane)', contextWindow: 262144, maxTokens: 16384, tools: true },
      { id: 'openrouter/free', name: 'OpenRouter Free Router (OR-Lane)', contextWindow: 200000, maxTokens: 16384, tools: true },
    ],
  },
  {
    id: 'ovh',
    name: 'OVHcloud AI Endpoints (EU)',
    shortName: 'OVHcloud',
    category: 'cloud',
    wire: 'openai',
    enabledByDefault: true,
    autoEligible: true,
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    headers: {},
    freeRule: { type: 'all-chat' },
    concurrency: 3,
    minIntervalMs: 800,
    rateLimitNote: '~2 Anfragen/Minute pro IP und Modell (Rotation über mehrere OVH-Modelle erhöht Durchsatz)',
    privacyNote: 'EU-Rechenzentren (OVHcloud Kepler AI Endpoints), komplett ohne Registrierung.',
    website: 'https://endpoints.ai.cloud.ovh.net/',
    priority: 96,
    staticModels: [
      { id: 'gpt-oss-120b', name: 'GPT-OSS 120B (OVH EU)', contextWindow: 131072, maxTokens: 16384, tools: true, reasoning: true },
      { id: 'Qwen3.5-397B-A17B', name: 'Qwen 3.5 397B-A17B (OVH EU)', contextWindow: 131072, maxTokens: 16384, tools: true, reasoning: true },
      { id: 'Qwen3-Coder-30B-A3B-Instruct', name: 'Qwen 3 Coder 30B (OVH EU)', contextWindow: 131072, maxTokens: 16384, tools: true },
      { id: 'Qwen3.8-27B', name: 'Qwen 3.8 27B Vision (OVH EU)', contextWindow: 131072, maxTokens: 8192, tools: true, vision: true },
      { id: 'Qwen3.6-27B', name: 'Qwen 3.6 27B Vision (OVH EU)', contextWindow: 131072, maxTokens: 8192, tools: true, vision: true },
      { id: 'Qwen2.5-VL-72B-Instruct', name: 'Qwen 2.5 VL 72B (OVH EU)', contextWindow: 32768, maxTokens: 8192, tools: true, vision: true },
      { id: 'gpt-oss-20b', name: 'GPT-OSS 20B (OVH EU)', contextWindow: 131072, maxTokens: 16384, tools: true, reasoning: true },
      { id: 'Meta-Llama-3_3-70B-Instruct', name: 'Llama 3.3 70B Instruct (OVH EU)', contextWindow: 131072, maxTokens: 8192, tools: true },
      { id: 'Mistral-Small-3.2-24B-Instruct-2506', name: 'Mistral Small 3.2 24B (OVH EU)', contextWindow: 131072, maxTokens: 8192, tools: true },
      { id: 'Mistral-Nemo-Instruct-2407', name: 'Mistral Nemo 12B (OVH EU)', contextWindow: 131072, maxTokens: 8192, tools: true },
      { id: 'Qwen3.5-9B', name: 'Qwen 3.5 9B Vision (OVH EU)', contextWindow: 131072, maxTokens: 8192, tools: true, vision: true },
    ],
  },
  {
    id: 'vireonix',
    name: 'Vireonix Keyless Gateway',
    shortName: 'Vireonix',
    category: 'cloud',
    wire: 'openai',
    enabledByDefault: true,
    autoEligible: true,
    baseUrl: 'https://vireonix.ai/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    headers: {},
    freeRule: { type: 'all-chat' },
    concurrency: 2,
    minIntervalMs: 500,
    rateLimitNote: '20M Input- / 200K Output-Tokens pro Stunde und IP · 1M Context',
    privacyNote: 'Öffentliches Keyless-Gateway mit nativem Tool-Calling und X-RateLimit-Headern.',
    website: 'https://vireonix.ai',
    priority: 95,
    staticModels: [
      { id: 'auto', name: 'Vireonix Auto (1M Context · Tools)', contextWindow: 1000000, maxTokens: 65536, tools: true, reasoning: true },
    ],
  },
  {
    id: 'chat',
    name: 'ch.at Universal Keyless',
    shortName: 'ch.at',
    category: 'cloud',
    wire: 'openai',
    enabledByDefault: true,
    autoEligible: true,
    baseUrl: 'https://ch.at/v1',
    modelsPath: null,
    chatPath: '/chat/completions',
    headers: {},
    freeRule: { type: 'static-only' },
    concurrency: 4,
    minIntervalMs: 600,
    rateLimitNote: '~100 Anfragen/Minute pro IP (Burst 10) · Kein /models-Endpunkt',
    privacyNote: 'Minimalistischer öffentlicher Chat-Dienst ohne Accounts oder Cookies.',
    website: 'https://ch.at',
    priority: 90,
    staticModels: [
      { id: 'gpt-4o', name: 'GPT-4o (ch.at Keyless)', contextWindow: 128000, maxTokens: 8192, tools: true },
    ],
  },
  {
    id: 'llm7',
    name: 'LLM7.io Anonymous Turbo',
    shortName: 'LLM7',
    category: 'cloud',
    wire: 'openai',
    enabledByDefault: true,
    autoEligible: true,
    baseUrl: 'https://api.llm7.io/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    headers: {},
    freeRule: { type: 'llm7-turbo' },
    concurrency: 2,
    minIntervalMs: 1200,
    rateLimitNote: 'Mindestabstand ~1,2 s zwischen Anfragen (Turbo-Tier ist ohne Key frei)',
    privacyNote: 'Öffentlicher anonymer Turbo-Pool von LLM7.io.',
    website: 'https://llm7.io',
    priority: 88,
    staticModels: [
      { id: 'codestral-latest', name: 'Codestral Latest (LLM7 Turbo)', contextWindow: 131072, maxTokens: 8192, tools: true },
      { id: 'gpt-oss:20b', name: 'GPT-OSS 20B (LLM7 Turbo)', contextWindow: 131072, maxTokens: 8192, tools: true, reasoning: true },
      { id: 'mistral-Nemo-Instruct-2407', name: 'Mistral Nemo (LLM7 Turbo)', contextWindow: 128000, maxTokens: 8192, tools: true },
    ],
  },
  {
    id: 'rewind',
    name: 'Rewind AI Anonymous',
    shortName: 'Rewind',
    category: 'cloud',
    wire: 'openai',
    enabledByDefault: true,
    autoEligible: true,
    baseUrl: 'https://api.rewind.ai',
    modelsPath: null,
    // Trailing slash is required by api.rewind.ai!
    chatPath: '/v1/chat/completions/',
    headers: {
      Origin: 'https://rewind.ai',
    },
    freeRule: { type: 'static-only' },
    concurrency: 3,
    minIntervalMs: 300,
    rateLimitNote: 'Hohe Stabilität und niedrige Latenz ohne API-Key (Trailing-Slash-Protokoll)',
    privacyNote: 'Öffentlicher Endpunkt von Rewind AI.',
    website: 'https://rewind.ai',
    priority: 85,
    staticModels: [
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Rewind)', contextWindow: 128000, maxTokens: 8192, tools: true },
      { id: 'qwen/qwen-2.5-7b-instruct', name: 'Qwen 2.5 7B Instruct (Rewind)', contextWindow: 32768, maxTokens: 4096, tools: false },
    ],
  },
  {
    id: 'freeai',
    name: 'Free.ai Self-Hosted vLLM',
    shortName: 'Free.ai',
    category: 'cloud',
    wire: 'openai',
    enabledByDefault: true,
    autoEligible: true,
    baseUrl: 'https://api.free.ai/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    headers: {},
    freeRule: { type: 'freeai-self-hosted' },
    concurrency: 2,
    minIntervalMs: 500,
    rateLimitNote: 'Selbstgehostete vLLM-Modelle sind frei (OpenRouter-Proxy-Modelle auf free.ai werden herausgefiltert)',
    privacyNote: 'Free.ai Self-Hosted Cluster; liefert bei Überlastung gelegentlich HTTP 503.',
    website: 'https://free.ai',
    priority: 84,
    staticModels: [
      { id: 'qwen7b', name: 'Qwen 3.6 35B (free.ai qwen7b)', contextWindow: 65536, maxTokens: 8192, tools: true, vision: true },
      { id: 'qwen-coder', name: 'Qwen Coder (free.ai)', contextWindow: 65536, maxTokens: 8192, tools: true },
      { id: 'deepseek-r1', name: 'DeepSeek R1 (free.ai)', contextWindow: 65536, maxTokens: 8192, tools: false, reasoning: true },
    ],
  },
  {
    id: 'vlmrun',
    name: 'VLM Run OpenAI Gateway',
    shortName: 'VLM Run',
    category: 'cloud',
    wire: 'openai',
    enabledByDefault: true,
    autoEligible: true,
    baseUrl: 'https://gateway.vlm.run/v1/openai',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    headers: {},
    freeRule: { type: 'all-chat' },
    concurrency: 2,
    minIntervalMs: 1000,
    rateLimitNote: '10/Min · 30/Stunde · 100/Tag pro IP · Unterstützt Vision & Tools',
    privacyNote: 'Direkter Host-Aufruf aus DSH Desktop umgeht fehlende Browser-CORS-Header.',
    website: 'https://vlm.run',
    priority: 82,
    staticModels: [
      { id: 'qwen/qwen3.8-27b', name: 'Qwen 3.8 27B Vision (VLM Run)', contextWindow: 131072, maxTokens: 8192, tools: true, vision: true },
      { id: 'qwen/qwen3.5-0.8b', name: 'Qwen 3.5 0.8B (VLM Run)', contextWindow: 32768, maxTokens: 4096, tools: false },
      { id: 'google/diffusiongemma-26b-a4b-it', name: 'Gemma 26B A4B IT (VLM Run)', contextWindow: 65536, maxTokens: 8192, tools: true },
    ],
  },
  {
    id: 'blockrun',
    name: 'BlockRun Keyless NVIDIA Pool',
    shortName: 'BlockRun',
    category: 'cloud',
    wire: 'openai',
    enabledByDefault: true,
    autoEligible: true,
    baseUrl: 'https://blockrun.ai/api/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    headers: {},
    freeRule: { type: 'prefix', value: 'nvidia/' },
    concurrency: 2,
    minIntervalMs: 800,
    rateLimitNote: 'Kostenloser nvidia/*-Pool (Upstream-Timeout ca. 12–25 s unter Last)',
    privacyNote: 'Keyless Free-Pool auf blockrun.ai.',
    website: 'https://blockrun.ai',
    priority: 78,
    staticModels: [
      { id: 'nvidia/gpt-oss-120b', name: 'NVIDIA GPT-OSS 120B (BlockRun)', contextWindow: 128000, maxTokens: 8192, tools: true, reasoning: true },
      { id: 'nvidia/nemotron-3.5-lightning', name: 'NVIDIA Nemotron 3.5 Lightning (BlockRun)', contextWindow: 128000, maxTokens: 8192, tools: true },
      { id: 'nvidia/nemotron-3-ultra-550b', name: 'NVIDIA Nemotron 3 Ultra 550B (BlockRun)', contextWindow: 128000, maxTokens: 8192, tools: true, reasoning: true },
      { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', name: 'Nemotron 3 Nano 30B Reasoning', contextWindow: 128000, maxTokens: 8192, tools: true, reasoning: true },
      { id: 'nvidia/deepseek-v4-flash', name: 'NVIDIA DeepSeek V4 Flash', contextWindow: 128000, maxTokens: 8192, tools: true },
      { id: 'nvidia/step-3.7-flash', name: 'NVIDIA Step 3.7 Flash', contextWindow: 128000, maxTokens: 8192, tools: true },
      { id: 'nvidia/llama-3.2-11b-vision', name: 'NVIDIA Llama 3.2 11B Vision', contextWindow: 128000, maxTokens: 4096, tools: false, vision: true },
    ],
  },
  {
    id: 'pollinations',
    name: 'Pollinations Text (Anonymous Host)',
    shortName: 'Pollinations',
    category: 'cloud',
    wire: 'openai',
    enabledByDefault: true,
    autoEligible: true,
    baseUrl: 'https://text.pollinations.ai',
    modelsPath: '/models',
    chatPath: '/openai',
    headers: {},
    freeRule: { type: 'pollinations-anon' },
    concurrency: 1,
    minIntervalMs: 15000,
    rateLimitNote: '~1 Anfrage pro 15 Sekunden pro IP (nutzt text.pollinations.ai; gen.pollinations.ai verlangt Key)',
    privacyNote: 'Öffentlicher Community-Dienst von Pollinations.ai.',
    website: 'https://pollinations.ai',
    priority: 72,
    staticModels: [
      { id: 'openai', name: 'Pollinations OpenAI (GPT-OSS)', contextWindow: 65536, maxTokens: 8192, tools: true },
      { id: 'openai-fast', name: 'Pollinations OpenAI Fast (GPT-OSS 20B)', contextWindow: 65536, maxTokens: 8192, tools: true, reasoning: true },
    ],
  },
  {
    id: 'chatjimmy',
    name: 'ChatJimmy Ultra-Fast Llama',
    shortName: 'ChatJimmy',
    category: 'cloud',
    wire: 'chatjimmy',
    enabledByDefault: true,
    autoEligible: false, // No native tool-calling wire; used for auto-fast text or direct selection
    baseUrl: 'https://chatjimmy.ai',
    modelsPath: '/api/models',
    chatPath: '/api/chat',
    headers: {},
    freeRule: { type: 'all-chat' },
    concurrency: 3,
    minIntervalMs: 400,
    rateLimitNote: 'Extrem schnelle Text-Inferenz ohne Key (eigenes <|stats|>-Protokoll, kein natives Tool-Calling)',
    privacyNote: 'Öffentlicher ChatJimmy-Endpunkt.',
    website: 'https://chatjimmy.ai',
    priority: 70,
    staticModels: [
      { id: 'llama3.1-8B', name: 'Llama 3.1 8B Ultra-Fast (ChatJimmy)', contextWindow: 32768, maxTokens: 4096, tools: false },
    ],
  },
  {
    id: 'mlvoca',
    name: 'mlvoca Free Ollama Cloud',
    shortName: 'mlvoca',
    category: 'opt-in',
    wire: 'ollama',
    enabledByDefault: false,
    autoEligible: false,
    baseUrl: 'https://mlvoca.com',
    modelsPath: '/api/tags',
    chatPath: '/api/generate',
    headers: {},
    freeRule: { type: 'all-chat' },
    concurrency: 1,
    minIntervalMs: 1500,
    rateLimitNote: 'Öffentlicher Ollama-Server ohne Limits, aber kleine Modelle (1.1B–1.5B)',
    privacyNote: 'Öffentlicher Demo-Endpunkt (mlvoca.com).',
    website: 'https://mlvoca.com',
    priority: 40,
    staticModels: [
      { id: 'deepseek-r1:1.5b', name: 'DeepSeek R1 1.5B (mlvoca)', contextWindow: 16384, maxTokens: 2048, tools: false, reasoning: true },
      { id: 'tinyllama', name: 'TinyLlama 1.1B (mlvoca)', contextWindow: 4096, maxTokens: 1024, tools: false },
    ],
  },
  {
    id: 'uncloseai',
    name: 'UncloseAI Hermes Keyless',
    shortName: 'UncloseAI',
    category: 'opt-in',
    wire: 'openai',
    enabledByDefault: false,
    autoEligible: false,
    baseUrl: 'https://hermes.ai.unturf.com/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    headers: {},
    freeRule: { type: 'all-chat' },
    concurrency: 1,
    minIntervalMs: 1000,
    rateLimitNote: 'Öffentlicher Hermes-3-Endpunkt ohne Authentifizierung (Opt-in)',
    privacyNote: 'Community-Server von UncloseAI.',
    website: 'https://uncloseai.com',
    priority: 45,
    staticModels: [
      { id: 'adamo1139/Hermes-3-Llama-3.1-8B-FP8-Dynamic', name: 'Hermes 3 Llama 3.1 8B (UncloseAI)', contextWindow: 32768, maxTokens: 4096, tools: false },
    ],
  },
  {
    id: 'aihorde',
    name: 'AI Horde (Volunteer GPU Network)',
    shortName: 'AI Horde',
    category: 'opt-in',
    wire: 'openai',
    enabledByDefault: false,
    autoEligible: false,
    noStream: true,
    baseUrl: 'https://oai.aihorde.net/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    headers: {
      Authorization: 'Bearer 0000000000',
    },
    freeRule: { type: 'all-chat' },
    concurrency: 1,
    minIntervalMs: 2000,
    rateLimitNote: 'Nutzt den öffentlichen anonymen Key 0000000000 · Antwortzeiten 10–90 s je nach Queue',
    privacyNote: 'WICHTIG: Prompts werden von freiwilligen GPU-Workern im Klartext verarbeitet! Standardmäßig deaktiviert.',
    website: 'https://aihorde.net',
    priority: 25,
    staticModels: [
      { id: 'aphrodite/DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash (AI Horde)', contextWindow: 16384, maxTokens: 2048, tools: false },
      { id: 'aphrodite/TheDrummer/Skyfall-31B-v4.2', name: 'Skyfall 31B v4.2 (AI Horde)', contextWindow: 16384, maxTokens: 2048, tools: false },
      { id: 'koboldcpp/Angelic_Eclipse-12B', name: 'Angelic Eclipse 12B (AI Horde)', contextWindow: 8192, maxTokens: 1024, tools: false },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen (Client-Gated / Opt-in)',
    shortName: 'OpenCode',
    category: 'opt-in',
    wire: 'openai',
    enabledByDefault: false,
    autoEligible: false,
    baseUrl: 'https://opencode.ai/zen/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    headers: {},
    freeRule: { type: 'opencode-free' },
    concurrency: 1,
    minIntervalMs: 1000,
    rateLimitNote: 'Seit Okt. 2026 antwortet /chat/completions außerhalb der OpenCode-CLI häufig mit 403 FreeTierError; nur für manuelle Tests einschaltbar.',
    privacyNote: 'OpenCode Zen Gateway.',
    website: 'https://opencode.ai',
    priority: 20,
    staticModels: [
      { id: 'minimax-m2.5-free', name: 'MiniMax M2.5 Free (OpenCode)', contextWindow: 196608, maxTokens: 16384, tools: true },
      { id: 'big-pickle', name: 'Big Pickle (OpenCode)', contextWindow: 131072, maxTokens: 8192, tools: true },
      { id: 'gpt-5-nano', name: 'GPT-5 Nano (OpenCode)', contextWindow: 128000, maxTokens: 8192, tools: true },
    ],
  },
  // Local Zero-Key Loopback Servers (zero internet quota, auto-detected on demand)
  {
    id: 'ollama-local',
    name: 'Ollama (Lokal · Zero-Key)',
    shortName: 'Ollama',
    category: 'local',
    wire: 'openai',
    enabledByDefault: false,
    autoEligible: true,
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    headers: {},
    freeRule: { type: 'all-chat' },
    concurrency: 4,
    minIntervalMs: 0,
    rateLimitNote: '100% lokal auf Ihrem Windows-PC (Port 11434) · Kein Internet, kein Limit',
    privacyNote: 'Daten verlassen niemals Ihren Computer.',
    website: 'https://ollama.com',
    priority: 110,
    staticModels: [],
  },
  {
    id: 'lmstudio-local',
    name: 'LM Studio (Lokal · Zero-Key)',
    shortName: 'LM Studio',
    category: 'local',
    wire: 'openai',
    enabledByDefault: false,
    autoEligible: true,
    baseUrl: 'http://127.0.0.1:1234/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    headers: {},
    freeRule: { type: 'all-chat' },
    concurrency: 4,
    minIntervalMs: 0,
    rateLimitNote: '100% lokal auf Ihrem Windows-PC (Port 1234) · Kein API-Key',
    privacyNote: 'Daten verlassen niemals Ihren Computer.',
    website: 'https://lmstudio.ai',
    priority: 109,
    staticModels: [],
  },
  {
    id: 'llamacpp-local',
    name: 'llama.cpp Server (Lokal · Zero-Key)',
    shortName: 'llama.cpp',
    category: 'local',
    wire: 'openai',
    enabledByDefault: false,
    autoEligible: true,
    baseUrl: 'http://127.0.0.1:8080/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    headers: {},
    freeRule: { type: 'all-chat' },
    concurrency: 2,
    minIntervalMs: 0,
    rateLimitNote: '100% lokal auf Ihrem Windows-PC (Port 8080)',
    privacyNote: 'Daten verlassen niemals Ihren Computer.',
    website: 'https://github.com/ggml-org/llama.cpp',
    priority: 108,
    staticModels: [],
  },
  {
    id: 'jan-local',
    name: 'Jan.ai Server (Lokal · Zero-Key)',
    shortName: 'Jan',
    category: 'local',
    wire: 'openai',
    enabledByDefault: false,
    autoEligible: true,
    baseUrl: 'http://127.0.0.1:1337/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    headers: {},
    freeRule: { type: 'all-chat' },
    concurrency: 2,
    minIntervalMs: 0,
    rateLimitNote: '100% lokal auf Ihrem Windows-PC (Port 1337)',
    privacyNote: 'Daten verlassen niemals Ihren Computer.',
    website: 'https://jan.ai',
    priority: 107,
    staticModels: [],
  },
])

/**
 * Audited endpoints that are frequently claimed as "keyless" in older lists
 * but were verified in October 2026 to fail or require credentials/payment.
 * Documented transparently so users never waste turns on broken endpoints.
 */
export const REJECTED_KEYLESS_CLAIMS = Object.freeze([
  { name: 'Pollinations (gen.pollinations.ai/v1)', status: 401, reason: 'Neuer gen-Host erzwingt API-Key; nur der ältere Host text.pollinations.ai bedient weiterhin anonym.' },
  { name: 'OpenRouter Direct (openrouter.ai/api/v1)', status: 401, reason: '/models ist öffentlich, aber /chat/completions verlangt auch für :free-Modelle einen Account-Key (Kilo übernimmt das Keyless-Routing).' },
  { name: 'Hack Club AI (ai.hackclub.com/proxy/v1)', status: 401, reason: '/models liefert 200, aber Chat antwortet 401 Authentication required.' },
  { name: 'Naga AI (api.naga.ac/v1)', status: 401, reason: '/models öffentlich, /chat/completions verlangt Account-Registrierung.' },
  { name: 'g4f.space (/api/*/v1)', status: 402, reason: '402 insufficient_credits — verlangt Browser-Proof-of-Work ("cake credits"), inkompatibel mit Standard-Clients.' },
  { name: 'Airforce API (api.airforce/v1)', status: 401, reason: 'Verlangt API-Key bzw. liefert 402/429 ohne Guthaben.' },
  { name: 'KeylessAI Worker (keylessai.thryx.workers.dev)', status: 404, reason: 'Cloudflare-Worker abgeschaltet / 404.' },
  { name: 'FriendliAI & Liquid AI Serverless', status: 401, reason: 'Als keyless markiert in älteren Katalogen, antworten aber mit 401/403 Not authenticated.' },
  { name: 'Qwen OAuth / Gemini CLI Free / GitHub Models', status: 403, reason: 'Kostenlose unauthentifizierte/OAuth-Kontingente wurden zwischen April und August 2026 eingestellt.' },
])

/**
 * Check whether a model entry from `/models` is a text/multimodal chat LLM
 * (excluding embeddings, TTS, ASR, moderation guards, image-only generators).
 *
 * @param {string} modelId
 * @param {Record<string, any> | null | undefined} raw
 * @returns {boolean}
 */
export function isChatModel(modelId, raw = null) {
  const id = String(modelId ?? '').trim()
  if (!id) return false
  if (NON_CHAT_ID_RE.test(id)) return false

  if (raw && typeof raw === 'object') {
    const typeField = String(raw.type ?? raw.model_type ?? raw.task ?? raw.category ?? '').toLowerCase()
    if (NON_CHAT_TYPES.has(typeField)) return false

    const arch = raw.architecture && typeof raw.architecture === 'object' ? raw.architecture : {}
    const outMods = raw.output_modalities ?? arch.output_modalities
    if (Array.isArray(outMods) && outMods.length > 0) {
      const lower = outMods.map((m) => String(m).toLowerCase())
      if (!lower.includes('text')) return false
    }

    if (typeof raw.context_length === 'number' && raw.context_length <= 0) {
      return false
    }
  }

  return true
}

/**
 * Check whether a live `/models` item is genuinely keyless/free on `provider`.
 *
 * @param {Record<string, any>} provider
 * @param {Record<string, any>} raw
 * @returns {boolean}
 */
export function isFreeOnProvider(provider, raw) {
  if (!raw || typeof raw !== 'object') return false
  const id = String(raw.id ?? raw.name ?? '').trim()
  if (!id) return false
  if (!isChatModel(id, raw)) return false

  const rule = provider.freeRule ?? { type: 'all-chat' }
  switch (rule.type) {
    case 'static-only':
      return false
    case 'kilo': {
      if (raw.isFree === true) return true
      if (id.endsWith(':free')) return true
      if (KILO_EXPLICIT_FREE_IDS.has(id)) return true
      const promptPrice = raw.pricing?.prompt
      const completionPrice = raw.pricing?.completion
      if (promptPrice !== undefined && completionPrice !== undefined) {
        return Number(promptPrice) === 0 && Number(completionPrice) === 0 && id.includes('free')
      }
      return false
    }
    case 'llm7-turbo': {
      const tier = String(raw.tier ?? '').toLowerCase()
      return tier === 'turbo' || tier === 'free' || tier === 'anonymous'
    }
    case 'freeai-self-hosted': {
      if ('self_hosted' in raw) return raw.self_hosted === true
      if (raw.billing_mode && String(raw.billing_mode).toLowerCase() !== 'free') return false
      return ['qwen7b', 'qwen-coder', 'deepseek-r1'].includes(id)
    }
    case 'pollinations-anon': {
      const tier = String(raw.tier ?? '').toLowerCase()
      if (tier && tier !== 'anonymous' && tier !== 'seed' && tier !== 'free') return false
      if (raw.paid === true || raw.premium === true) return false
      return true
    }
    case 'opencode-free': {
      if (id.endsWith('-free') || id.endsWith(':free')) return true
      if (['big-pickle', 'gpt-5-nano'].includes(id)) return true
      const costIn = raw.cost?.input ?? raw.pricing?.prompt
      const costOut = raw.cost?.output ?? raw.pricing?.completion
      return costIn !== undefined && Number(costIn) === 0 && Number(costOut ?? 0) === 0
    }
    case 'prefix':
      return id.startsWith(String(rule.value ?? ''))
    case 'suffix':
      return id.endsWith(String(rule.value ?? ''))
    case 'all-chat':
    default: {
      if (raw.paid === true || raw.premium === true) return false
      const pricing = raw.pricing
      if (pricing && typeof pricing === 'object') {
        for (const k of ['prompt', 'completion', 'input', 'output']) {
          const v = Number(pricing[k])
          if (Number.isFinite(v) && v > 0) return false
        }
      }
      return true
    }
  }
}

/**
 * Normalize one raw `/models` entry or static model spec into canonical metadata.
 *
 * @param {Record<string, any>} provider
 * @param {Record<string, any> | string} raw
 * @returns {object | null}
 */
export function normalizeModelEntry(provider, raw) {
  const item = typeof raw === 'string' ? { id: raw } : raw
  if (!item || typeof item !== 'object') return null
  const modelId = String(item.id ?? item.model ?? item.name ?? '').trim()
  if (!modelId) return null

  const compositeId = `${provider.id}/${modelId}`
  const arch = item.architecture && typeof item.architecture === 'object' ? item.architecture : {}
  const inMods = item.input_modalities ?? arch.input_modalities ?? []
  const supportedParams = item.supported_parameters ?? item.supportedParameters ?? []

  const vision =
    item.vision === true ||
    (Array.isArray(inMods) && inMods.some((m) => String(m).toLowerCase() === 'image')) ||
    /(?:^|[-_/])(vl|vision|omni|pixtral|qvq)(?:$|[-_/:0-9])/i.test(modelId)

  const reasoning =
    item.reasoning === true ||
    (Array.isArray(supportedParams) &&
      supportedParams.some((p) => ['reasoning', 'include_reasoning', 'reasoning_effort'].includes(String(p)))) ||
    /(?:thinking|reasoning|deepseek-r1|gpt-oss|qwq|step-3\.5|trinity-large-thinking|lfm-.*thinking)/i.test(modelId)

  let tools
  if (typeof item.tools === 'boolean') {
    tools = item.tools
  } else if (provider.wire !== 'openai') {
    tools = false
  } else if (Array.isArray(supportedParams) && supportedParams.length > 0) {
    tools = supportedParams.includes('tools') || supportedParams.includes('tool_choice')
  } else if (item.capabilities && typeof item.capabilities.tools === 'boolean') {
    tools = item.capabilities.tools
  } else {
    tools = !/(?:deepseek-r1(?::|$)|tinyllama|0\.8b|1\.2b|1\.5b|2\.6b)/i.test(modelId)
  }

  const rawCtx =
    item.contextWindow ??
    item.context_length ??
    item.context_window?.tokens ??
    item.context ??
    item.limit?.context ??
    item.top_provider?.context_length ??
    131072
  const contextWindow = Math.max(2048, Math.floor(Number(rawCtx) || 131072))

  const rawMaxOut =
    item.maxTokens ??
    item.max_output ??
    item.max_completion_tokens ??
    item.limit?.output ??
    item.top_provider?.max_completion_tokens ??
    Math.min(16384, Math.max(2048, Math.floor(contextWindow * 0.2)))
  const maxTokens = Math.max(512, Math.min(contextWindow, Math.floor(Number(rawMaxOut) || 8192)))

  const cleanLabel = item.name && item.name !== modelId ? String(item.name) : modelId

  return {
    compositeId,
    providerId: provider.id,
    providerName: provider.shortName ?? provider.name,
    modelId,
    name: `[${provider.shortName ?? provider.id}] ${cleanLabel}`,
    shortLabel: cleanLabel,
    description:
      item.description ||
      `${provider.name} · ${Math.round(contextWindow / 1024)}K ctx${tools ? ' · Tools' : ''}${vision ? ' · Vision' : ''}${reasoning ? ' · Reasoning' : ''}`,
    contextWindow,
    maxTokens,
    vision,
    tools,
    reasoning,
    reasoningCannotDisable:
      item.reasoningCannotDisable === true ||
      /(?:^stepfun\/|^liquid\/.*thinking|^kilo-auto\/|^openrouter\/free)/i.test(modelId),
    priority: provider.priority ?? 50,
  }
}

/**
 * Extract an array of raw model items from diverse `/models` or `/api/tags` responses.
 *
 * @param {unknown} payload
 * @returns {any[]}
 */
export function extractRawModelList(payload) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  const obj = /** @type {Record<string, any>} */ (payload)
  if (Array.isArray(obj.data)) return obj.data
  if (Array.isArray(obj.models)) return obj.models
  if (Array.isArray(obj.items)) return obj.items
  return []
}

/**
 * Look up a virtual model definition by ID (`auto`, `auto-coding`, etc.).
 *
 * @param {string} modelId
 */
export function findVirtualModel(modelId) {
  const clean = String(modelId ?? '').trim()
  return VIRTUAL_MODELS.find((v) => v.id === clean) ?? null
}
