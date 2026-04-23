export const CONFIG_FILE = '.aeo-tracker.json';

// Plain chat models used during init/brainstorm — no web-search side tools.
// DEFAULT_CONFIG.providers.*.model is for the run command (search-enabled models).
export const SUGGEST_MODELS = {
  openai: 'gpt-5.4',
  anthropic: 'claude-sonnet-4-6',
  gemini: 'gemini-2.5-flash',
};

// Cheap classification models — used for binary/structured decisions where a smaller
// model is equally capable (query validation, brand/concept classification).
// Keeping this separate from SUGGEST_MODELS so we don't accidentally downgrade
// brainstorm/research quality when tuning validator cost.
export const CLASSIFY_MODELS = {
  openai: 'gpt-5.4-mini',
  anthropic: 'claude-haiku-4-5',
  gemini: 'gemini-2.5-flash',
};

// Priority order for picking primary/validator providers in the research pipeline.
// Required providers (OpenAI + Gemini per README contract) come first so init
// doesn't pick an optional provider as primary — a mismatch that caused a 0.2.2
// user to hit a crash when Anthropic (priority #1 pre-0.2.2) had empty billing.
// Retry loop in bin/aeo-tracker.js walks this list on billing/auth/rate errors.
export const PROVIDER_PRIORITY = ['openai', 'gemini', 'anthropic'];

export const DEFAULT_CONFIG = {
  brand: '',
  domain: '',
  queries: ['', '', ''],
  competitors: [],
  regressionThreshold: 10,
  providers: {
    openai: { model: 'gpt-5-search-api', env: 'OPENAI_API_KEY' },
    gemini: { model: 'gemini-2.5-flash', env: 'GEMINI_API_KEY' },
    anthropic: { model: 'claude-sonnet-4-6', env: 'ANTHROPIC_API_KEY' },
    perplexity: { model: 'sonar', env: 'PERPLEXITY_API_KEY' },
  },
};
