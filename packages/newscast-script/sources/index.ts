/**
 * @audio-underview/newscast-script
 *
 * Generates a 2-host (진행자1 / 진행자2) Korean newscast dialogue script from a
 * set of crawled articles by calling one of three cloud LLM providers
 * (Anthropic, OpenAI, Google Gemini) over their REST APIs with `fetch` (no SDK).
 *
 * The public surface and provider HTTP contracts are locked by
 * BUILD-NEWSCAST-SPEC.md (sections 1 and 4.2). All shared wire types come from
 * `@audio-underview/newscast-core`; they are never re-declared here.
 */

import type {
  AiGatewayConfiguration,
  Article,
  LlmProvider,
  NewscastLengthPreference,
  NewscastPartPlan,
  OrganizedUnit,
  ProviderTransport,
  ScriptLine,
  SpeakerId,
} from '@audio-underview/newscast-core';
import {
  ProviderRequestError,
  aiGatewayHeaders,
  aiGatewayUrl,
  redactSecrets,
  truncateText,
} from '@audio-underview/newscast-core';

/**
 * Length-preference → sizing factor (design §14). Multiplies the estimated
 * script-character budget in {@link planNewscastParts} BEFORE the part-count /
 * turn-target clamps, so a preset only scales within what the source supports (it
 * can never force padding past the [1,3]-part / [24,56]-turn clamps). 'standard'
 * is exactly 1.0, keeping the default sizing behavior-identical to before presets.
 */
export const LENGTH_PREFERENCE_FACTORS: Record<NewscastLengthPreference, number> = {
  short: 0.6,
  standard: 1.0,
  long: 1.4,
};

/**
 * Locked model ids per provider (BUILD-NEWSCAST-SPEC.md section 1).
 * `flagship` is used by default for generation; `cheap` is provided for callers
 * that want a lower-cost tier.
 */
export const NEWSCAST_MODEL_IDS: Record<
  LlmProvider,
  { flagship: string; cheap: string }
> = {
  anthropic: {
    // Opus 5.5 (2026-09-22) is cheaper than Opus 5 ($4/$20 vs $5/$25). Its
    // effort default is 'medium', not 'high', so a job that leaves effort on
    // "Default" reasons one level lower than it did on Opus 5.
    flagship: 'claude-opus-5-5',
    // Dated snapshot, NOT the `claude-haiku-4-5` alias: since 2026-07-14 the
    // alias is rejected with 403 "Request not allowed" for this API key while
    // the snapshot works (verified by A/B on the live pipeline).
    cheap: 'claude-haiku-4-5-20251001',
  },
  openai: {
    // GPT-6 Sol (2026-09-22) costs half of GPT-5.6 Sol ($2/$10 vs $4/$20) and
    // keeps the same none..max effort ladder on Chat Completions. Explicit
    // variant ids rather than bare aliases: aliases can be re-pointed or
    // rejected outright (the Haiku 4.5 alias started returning 403 on
    // 2026-07-14), so the catalog pins the id the models API actually lists.
    flagship: 'gpt-6-sol',
    cheap: 'gpt-6-luna',
  },
  google: {
    // 3.8 Flash (2026-09-02) is the newest stable Flash at the same price as
    // 3.6/3.7 ($0.75/$3.75 per MTok through 2026-12-31).
    flagship: 'gemini-3.8-flash',
    cheap: 'gemini-3.5-flash-lite',
  },
  xai: {
    // Grok ids re-read off docs.x.ai on 2026-09-29. Grok 4.7 (2026-09-21)
    // replaced 4.6 as the flagship at the same $2/$6 per MTok; 4.3 is the
    // same-family cheaper tier ($1.25/$2.50). Both are dated-free ids — xAI
    // publishes no snapshot suffix for them — so the alias hazard that forced
    // `claude-haiku-4-5-20251001` here does not apply, but it is also why these
    // are the FIRST thing to re-check if every xAI job starts failing at once.
    flagship: 'grok-4.7',
    cheap: 'grok-4.3',
  },
};

/**
 * The flagship model id used by default for a provider.
 */
export function defaultModelForProvider(provider: LlmProvider): string {
  return NEWSCAST_MODEL_IDS[provider].flagship;
}

/**
 * One selectable model option for the newscast generation UI.
 * - id: the model id passed to the provider (and to {@link generateNewscastScript}).
 * - label: human-readable Korean label shown in the dropdown.
 * - label: shown verbatim in the dropdown — the model name plus its price as
 *   `$input/$output` per million tokens, and a shutdown date when the vendor
 *   has announced one. No marketing words: price is the thing a picker needs.
 * - recommended: marks the default pick for the provider (data only; the label
 *   does not say so).
 * - legacy: the vendor lists it as legacy, a same-tier successor exists, or a
 *   shutdown date is set. The UI renders legacy entries in their own group
 *   under the current ones; every id is still callable today.
 * - efforts: reasoning-effort levels THIS model's API accepts, in ascending
 *   order. Empty array = the model has no effort control (UI offers only
 *   "Default"). Drives the dynamic effort dropdown.
 */
export interface ModelOption {
  id: string;
  label: string;
  recommended?: boolean;
  legacy?: boolean;
  efforts: ScriptEffort[];
}

/** Effort ladders shared by the catalog below (per provider docs, swept 2026-09-17). */
const EFFORTS_TO_HIGH: ScriptEffort[] = ['low', 'medium', 'high'];
const EFFORTS_TO_XHIGH: ScriptEffort[] = ['low', 'medium', 'high', 'xhigh'];
const EFFORTS_TO_MAX: ScriptEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
// Opus 4.6 and Sonnet 4.6 accept max but never xhigh (platform.claude.com effort page).
const EFFORTS_HIGH_AND_MAX: ScriptEffort[] = ['low', 'medium', 'high', 'max'];
// GPT-5.6 additionally accepts 'none' (reasoning off — fastest/cheapest).
// Verified live 2026-08-13: a gpt-5.6-luna call with reasoning_effort "none"
// answered 200. Older GPT-5.x generations stop at xhigh or high.
const EFFORTS_NONE_TO_MAX: ScriptEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORTS_NONE_TO_XHIGH: ScriptEffort[] = ['none', 'low', 'medium', 'high', 'xhigh'];
const EFFORTS_NONE_TO_HIGH: ScriptEffort[] = ['none', 'low', 'medium', 'high'];

/**
 * Model catalog per provider, powering the runtime provider+model selection UI.
 * The web form renders these options; the worker validates and forwards the
 * chosen id to {@link generateNewscastScript}. Ordering is significant — the
 * first entry (or the one flagged `recommended`) is the sensible default.
 *
 * 2026-09-17: full sweep of every id each provider still serves (pricing,
 * models and deprecation pages of all four vendors). Every callable id is
 * listed — current ones first, then `legacy` ones — with `$input/$output` per
 * million tokens in the label. Gemini's `minimal` thinking level is not on the
 * pipeline scale, so 3.6 Flash / Flash-Lite start at 'low' here.
 *
 * 2026-09-29: added Claude Opus 5.5 / Sonnet 5.5, GPT-6 Sol / Luna and Grok 4.7,
 * which became the vendors' current models; the ids they replaced (Opus 5,
 * Sonnet 5, the GPT-5.6 family, Grok 4.6) moved to `legacy` and stay callable.
 *
 * Effort support per model (verified 2026-07-14/2026-07-27 by live probes;
 * re-verified 2026-08-13 — the three operator-keyed providers' list-model
 * endpoints were queried live and every id below is currently served):
 * - Gemini 3.x `thinking_level`: low/medium/high (no none/xhigh/max). 2026-07-27:
 *   `gemini-3.6-flash` and `gemini-3.5-flash-lite` confirmed low/medium/high.
 *   2026-08-13: `gemini-3.6-flash` is still the newest stable Flash; 3.1 Pro is
 *   still the preview top tier.
 * - GPT-5.6 family `reasoning_effort`: none/low/medium/high/xhigh/max (default
 *   medium). 'none' is new since the 07-27 sweep and was confirmed live
 *   2026-08-13 (200 on `gpt-5.6-luna`). The bare `gpt-5.6` id is not listed by
 *   the models API — it is an alias that routes to Sol — so the catalog uses
 *   the explicit `gpt-5.6-sol` id instead (an alias can be re-pointed or
 *   blocked, as the `claude-haiku-4-5` alias 403 showed).
 * - Claude 5 / Opus 4.8 `output_config.effort`: low..max ('none' is NOT a
 *   level — thinking-off is a separate `thinking` parameter, capped at 'high'
 *   effort on Opus 5 and rejected outright on Fable 5). Haiku 4.5 predates the
 *   effort API (budget_tokens era) → no effort control.
 */
export const MODELS_BY_PROVIDER: Record<LlmProvider, ModelOption[]> = {
  google: [
    // 3.6/3.7/3.8 Flash share one price ($0.75/$3.75, $1.50/$7.50 from
    // 2027-01-01); 3.1 Pro doubles above 200k input tokens ($4/$18).
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash · $0.75/$3.75', recommended: true, efforts: EFFORTS_TO_HIGH },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro · $2/$12', efforts: EFFORTS_TO_HIGH },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite · $0.30/$2.50', efforts: EFFORTS_TO_HIGH },
    { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash · $0.75/$3.75', legacy: true, efforts: EFFORTS_TO_HIGH },
    { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash · $0.75/$3.75', legacy: true, efforts: EFFORTS_TO_HIGH },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash · $1.50/$9', legacy: true, efforts: EFFORTS_TO_HIGH },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite · $0.25/$1.50 · 2027-05-07 종료', legacy: true, efforts: EFFORTS_TO_HIGH },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash · $0.50/$3', legacy: true, efforts: EFFORTS_TO_HIGH },
    // The 2.5 generation is still "stable" on Google's models page and accepts
    // thinking_level low/medium/high like 3.x; 2.5 Pro doubles above 200k.
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro · $1.25/$10', legacy: true, efforts: EFFORTS_TO_HIGH },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash · $0.30/$2.50', legacy: true, efforts: EFFORTS_TO_HIGH },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite · $0.10/$0.40', legacy: true, efforts: EFFORTS_TO_HIGH },
  ],
  anthropic: [
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 · $10/$50', efforts: EFFORTS_TO_MAX },
    // Opus 5.5 keeps adaptive thinking always on (the package never disables it)
    // and defaults to 'medium' effort when the request omits one.
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 · $4/$20', recommended: true, efforts: EFFORTS_TO_MAX },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 · $2/$10', efforts: EFFORTS_TO_MAX },
    // Haiku 4.5 predates the effort API (budget_tokens era) → no effort control.
    // Retirement "not sooner than 2026-10-15"; moves to legacy once a date is set.
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 · $1/$5', efforts: [] },
    { id: 'claude-opus-5', label: 'Claude Opus 5 · $5/$25', legacy: true, efforts: EFFORTS_TO_MAX },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 · $2/$10', legacy: true, efforts: EFFORTS_TO_MAX },
    { id: 'claude-fable-5', label: 'Claude Fable 5 · $10/$50', legacy: true, efforts: EFFORTS_TO_MAX },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 · $5/$25', legacy: true, efforts: EFFORTS_TO_MAX },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7 · $5/$25', legacy: true, efforts: EFFORTS_TO_MAX },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6 · $5/$25', legacy: true, efforts: EFFORTS_HIGH_AND_MAX },
    // Opus 4.5 is the one effort-capable model that only has extended (not
    // adaptive) thinking; this package pairs effort with adaptive thinking, so
    // it gets no effort control rather than a request Anthropic would reject.
    { id: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5 · $5/$25', legacy: true, efforts: [] },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 · $3/$15', legacy: true, efforts: EFFORTS_HIGH_AND_MAX },
    { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5 · $3/$15', legacy: true, efforts: [] },
  ],
  openai: [
    // Chat Completions only: the Responses-only ids (gpt-5.3-codex, every *-pro)
    // are not listed because this package calls /v1/chat/completions.
    { id: 'gpt-6-astra', label: 'GPT-6 Astra · $10/$50', efforts: EFFORTS_TO_MAX },
    // GPT-6 has no Terra tier; Sol and Luna both run none..max (default medium).
    { id: 'gpt-6-sol', label: 'GPT-6 Sol · $2/$10', recommended: true, efforts: EFFORTS_NONE_TO_MAX },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna · $0.10/$0.50', efforts: EFFORTS_NONE_TO_MAX },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol · $4/$20', legacy: true, efforts: EFFORTS_NONE_TO_MAX },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra · $2/$12', legacy: true, efforts: EFFORTS_NONE_TO_MAX },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · $0.20/$1.20', legacy: true, efforts: EFFORTS_NONE_TO_MAX },
    { id: 'gpt-5.5', label: 'GPT-5.5 · $5/$30', legacy: true, efforts: EFFORTS_NONE_TO_XHIGH },
    { id: 'gpt-5.4', label: 'GPT-5.4 · $2.50/$15', legacy: true, efforts: EFFORTS_NONE_TO_XHIGH },
    // 5.4 Mini/Nano have prices but no model page documenting their ladder.
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini · $0.75/$4.50', legacy: true, efforts: EFFORTS_TO_HIGH },
    { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano · $0.20/$1.25', legacy: true, efforts: EFFORTS_TO_HIGH },
    { id: 'gpt-5.2', label: 'GPT-5.2 · $1.75/$14', legacy: true, efforts: EFFORTS_NONE_TO_XHIGH },
    { id: 'gpt-5.1', label: 'GPT-5.1 · $1.25/$10', legacy: true, efforts: EFFORTS_NONE_TO_HIGH },
    // The GPT-5 generation's floor is 'minimal', which the pipeline scale lacks.
    { id: 'gpt-5', label: 'GPT-5 · $1.25/$10 · 2026-12-11 종료', legacy: true, efforts: EFFORTS_TO_HIGH },
    { id: 'gpt-5-mini', label: 'GPT-5 Mini · $0.25/$2 · 2026-12-11 종료', legacy: true, efforts: EFFORTS_TO_HIGH },
    { id: 'gpt-5-nano', label: 'GPT-5 Nano · $0.05/$0.40 · 2026-12-11 종료', legacy: true, efforts: EFFORTS_TO_HIGH },
    { id: 'gpt-4.1', label: 'GPT-4.1 · $2/$8', legacy: true, efforts: [] },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini · $0.40/$1.60', legacy: true, efforts: [] },
    { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano · $0.10/$0.40 · 2026-10-23 종료', legacy: true, efforts: [] },
    { id: 'gpt-4o', label: 'GPT-4o · $2.50/$10', legacy: true, efforts: [] },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini · $0.15/$0.60', legacy: true, efforts: [] },
    { id: 'o3', label: 'o3 · $2/$8 · 2026-12-11 종료', legacy: true, efforts: EFFORTS_TO_HIGH },
    { id: 'o4-mini', label: 'o4-mini · $1.10/$4.40 · 2026-10-23 종료', legacy: true, efforts: EFFORTS_TO_HIGH },
  ],
  // xAI / Grok (design §2). Ids and effort support read off docs.x.ai on
  // 2026-09-29; NOT verified against a live key, because this deployment has no
  // operator xAI key at all (design §8) — an xAI job only runs on a key the USER
  // registered. Korean newscast quality is likewise unmeasured (the design asks
  // for one live Korean run once a key exists), so nothing here is `recommended`
  // over the three measured providers except within xAI itself. Prices double
  // above 200k input tokens.
  xai: [
    // grok-4.7 (like 4.6) documents reasoning_effort low/medium/high/xhigh
    // (default high) and cannot disable reasoning; the pipeline's 'max' folds
    // to xhigh (see XAI_REASONING_EFFORT).
    { id: 'grok-4.7', label: 'Grok 4.7 · $2/$6', recommended: true, efforts: EFFORTS_TO_XHIGH },
    // grok-4.3 documents none/low/medium/high/xhigh (default low); 'none' is
    // not offered because XAI_REASONING_EFFORT folds it to low for every Grok.
    { id: 'grok-4.3', label: 'Grok 4.3 · $1.25/$2.50', efforts: EFFORTS_TO_XHIGH },
    { id: 'grok-4.20-0309-non-reasoning', label: 'Grok 4.20 Non-Reasoning · $1.25/$2.50', efforts: [] },
    // On the multi-agent model reasoning_effort sets the agent count, not depth.
    { id: 'grok-4.20-multi-agent-0309', label: 'Grok 4.20 Multi-Agent · $1.25/$2.50', efforts: EFFORTS_TO_XHIGH },
    // Effort support is undocumented for these, and an unsupported reasoning
    // parameter is rejected outright by OpenAI-compatible APIs rather than
    // ignored — so they declare NO effort control ("Default" only in the UI),
    // which is the choice that cannot turn a model pick into a 400.
    { id: 'grok-build-0.1', label: 'Grok Build 0.1 · $1/$2', efforts: [] },
    { id: 'grok-4.6', label: 'Grok 4.6 · $2/$6', legacy: true, efforts: EFFORTS_TO_XHIGH },
    // grok-4.5: low/medium/high, xhigh is accepted but treated as high.
    { id: 'grok-4.5', label: 'Grok 4.5 · $2/$6', legacy: true, efforts: EFFORTS_TO_HIGH },
    { id: 'grok-4.20-0309-reasoning', label: 'Grok 4.20 Reasoning · $1.25/$2.50', legacy: true, efforts: [] },
  ],
};

/**
 * The effort levels selectable for a model, or a conservative low/medium/high
 * ladder when the id is not in the catalog (custom/unknown model strings must
 * not lose effort control entirely).
 */
export function effortsForModel(provider: LlmProvider, modelId: string): ScriptEffort[] {
  const option = MODELS_BY_PROVIDER[provider].find((model) => model.id === modelId);
  return option?.efforts ?? EFFORTS_TO_HIGH;
}

/**
 * Options for {@link generateNewscastScript}.
 * - provider: which cloud LLM provider to call.
 * - apiKey: the provider API key (supplied by the caller from env).
 * - articles: source material for the newscast.
 * - model: optional override; defaults to `defaultModelForProvider(provider)`.
 * - signal: optional AbortSignal to cancel the in-flight request.
 */
/**
 * Reasoning effort for the script-generation LLM — a unified scale mapped to each
 * provider's current API:
 * - anthropic → `output_config.effort` (+ `thinking:{type:'adaptive'}`) on Claude 5 /
 *   Opus 4.8; supports low/medium/high/xhigh/max ('none' folds to 'low').
 * - openai    → `reasoning_effort` on GPT-5.6 (none/low/medium/high/xhigh/max —
 *   the ONLY provider that accepts 'none'; passes through unmapped).
 * - google    → `generationConfig.thinkingConfig.thinkingLevel` (enum, tops out at
 *   'high'); none folds to 'low', xhigh/max are capped to 'high'.
 * When omitted, no reasoning parameter is sent (each provider's default effort).
 * The per-model `efforts` arrays in the catalog gate what the UI offers, so the
 * folds below only fire on hand-crafted requests naming a level the picked
 * model's API does not speak — mapping to the nearest real level beats a 400.
 */
export type ScriptEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Gemini's `thinkingLevel` enum has no none/xhigh/max, so the ends of the
 * pipeline scale fold inward to the nearest level Gemini accepts.
 */
const GEMINI_THINKING_LEVEL: Record<ScriptEffort, 'low' | 'medium' | 'high'> = {
  none: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

/**
 * Grok's `reasoning_effort` tops out at 'xhigh' (docs.x.ai, 2026-09-17: Grok 4.6
 * accepts low / medium / high / xhigh, Grok 4.5 treats xhigh as high, neither
 * can disable reasoning), so the pipeline's 'max' folds down — the same shape
 * as Gemini above. This is the one non-obvious part of the xAI integration the
 * design flagged (§2): xAI speaks OpenAI's wire format, but it does NOT accept
 * OpenAI's full ladder, and an OpenAI-compatible API rejects an unknown enum
 * value rather than ignoring it. 'none' folds to the floor even though Grok 4.3
 * documents it: reasoning is not disableable on 4.5/4.6, and a stored effort
 * must never turn a model pick into a 400.
 */
const XAI_REASONING_EFFORT: Record<ScriptEffort, 'low' | 'medium' | 'high' | 'xhigh'> = {
  none: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
};

// ---------------------------------------------------------------------------
// Transport injection (per-user-provider-keys design §3.1/§5)
// ---------------------------------------------------------------------------

/**
 * The credential-free call seam now lives in newscast-core and is
 * re-exported here unchanged.
 *
 * It started in this package, but design §5.2 needs the SAME seam in the TTS and
 * audio packages so a self-funded job's speech synthesis and caption alignment
 * spend the caller's key too — and those two depend on core alone. Moving the
 * definitions (rather than copying them) keeps ONE `ProviderRequestError` class,
 * which matters: the pipeline branches on `instanceof`, and a second identically
 * named class would silently stop matching.
 */
export type {
  ProviderRequestSpecification,
  ProviderTransport,
  ProviderTransportResponse,
} from '@audio-underview/newscast-core';
export {
  ProviderRequestError,
  isProviderCredentialRejection,
} from '@audio-underview/newscast-core';

export interface GenerateScriptOptions {
  provider: LlmProvider;
  /**
   * The provider key, for the DIRECT path. Optional only because {@link transport}
   * replaces it: exactly one of the two must be present.
   */
  apiKey?: string;
  /** Fulfil the provider call elsewhere (the key vault) instead of holding a key. */
  transport?: ProviderTransport;
  articles: Article[];
  model?: string;
  /** Optional reasoning effort; when omitted the provider default is used. */
  effort?: ScriptEffort;
  /**
   * Optional Cloudflare AI Gateway routing (design 2026-07-29-ai-gateway-egress).
   * When omitted, the provider call goes straight to the provider's own URL —
   * today's behavior, unchanged. The worker builds this from its environment and
   * passes it down; this package never reads the environment itself.
   */
  gateway?: AiGatewayConfiguration;
  signal?: AbortSignal;
}

/**
 * Result of {@link generateNewscastScript}: the parsed dialogue plus the resolved
 * model id and token usage of the FINAL successful provider attempt (usage is
 * omitted when the provider did not report it).
 * - lines: the ordered 2-host dialogue.
 * - model: the model id actually used (the resolved default when none was given).
 * - promptTokens: input/prompt tokens reported by the provider, if any.
 * - completionTokens: output/completion tokens reported by the provider, if any.
 */
export interface GenerateScriptResult {
  lines: ScriptLine[];
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Produce the full 2-host Korean dialogue plus generation metadata.
 *
 * Builds a Korean prompt asking for a natural conversation between 진행자1 and
 * 진행자2 covering the given articles, calls the selected provider, then parses
 * the model output robustly (strict JSON first, speaker-tagged text as a
 * fallback). Returns the parsed lines together with the resolved model id and the
 * token usage of the successful attempt. Throws on transport failure or when no
 * valid line can be parsed.
 */
export async function generateNewscastScript(
  options: GenerateScriptOptions,
): Promise<GenerateScriptResult> {
  const { provider, apiKey, transport, articles, signal } = options;
  const model = options.model ?? defaultModelForProvider(provider);

  requireCredentialOrTransport('generateNewscastScript', apiKey, transport);
  if (!Array.isArray(articles) || articles.length === 0) {
    throw new Error('generateNewscastScript: at least one article is required.');
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(articles);
  return requestDialogueScript({
    provider,
    apiKey,
    transport,
    model,
    systemPrompt,
    userPrompt,
    effort: options.effort,
    gateway: options.gateway,
    signal,
    label: 'generateNewscastScript',
  });
}

/**
 * Options for {@link generateNewscastPartScript}. Extends the whole-newscast
 * options with the per-part context the dynamic-parts design (§5) needs:
 * - units: the FULL organized-unit list; `plan.unitIndexes` selects this part's
 *   share. An EMPTY array is the fallback mode — organization failed, so the
 *   part is written from the raw articles alone (no coverage block), same as the
 *   legacy single-shot path but with a dynamic turn target.
 * - plan: this part's assignment (which units + how many turns).
 * - partCount: how many parts the whole newscast splits into (drives the
 *   opening/closing-greeting rules — a lone part greets on both ends).
 * - previousHeadlines: headlines earlier parts already covered, so this part is
 *   told not to repeat them.
 * - nextHeadlines: headlines reserved for later parts, so this part does not
 *   poach them.
 * - lengthPreference: the length preset (design §14). It is threaded as the
 *   PREFERENCE (not the numeric factor) because the prompt hint is keyed by
 *   preset — 'short'/'long' each add one tone line, 'standard' (and omission) add
 *   nothing, keeping the standard prompt byte-identical to before presets. The
 *   numeric factor only affects sizing and is applied in {@link planNewscastParts}.
 */
export interface GeneratePartScriptOptions {
  provider: LlmProvider;
  /** The provider key, for the direct path; replaced by {@link transport}. */
  apiKey?: string;
  /** Fulfil the provider call elsewhere (the key vault) instead of holding a key. */
  transport?: ProviderTransport;
  articles: Article[];
  units: OrganizedUnit[];
  plan: NewscastPartPlan;
  partCount: number;
  previousHeadlines?: string[];
  nextHeadlines?: string[];
  model?: string;
  /** Optional reasoning effort; when omitted the provider default is used. */
  effort?: ScriptEffort;
  /** Optional length preset; when omitted the prompt is byte-identical to 'standard'. */
  lengthPreference?: NewscastLengthPreference;
  /** Optional AI Gateway routing; when omitted the provider call goes direct (today's behavior). */
  gateway?: AiGatewayConfiguration;
  signal?: AbortSignal;
}

/**
 * Produce ONE part of a multi-part newscast dialogue (design §5).
 *
 * Shares the system prompt, source-article blocks, reading rules, and JSON output
 * format with {@link generateNewscastScript}; only the position-aware
 * intro/outro rules, the dynamic per-part turn target, and the unit-coverage
 * block differ. Returns the same {@link GenerateScriptResult} shape (this part's
 * lines only) and follows the identical single-attempt / no-inner-retry contract.
 */
export async function generateNewscastPartScript(
  options: GeneratePartScriptOptions,
): Promise<GenerateScriptResult> {
  const { provider, apiKey, transport, articles, units, plan, partCount, signal } = options;
  const model = options.model ?? defaultModelForProvider(provider);

  requireCredentialOrTransport('generateNewscastPartScript', apiKey, transport);
  if (!Array.isArray(articles) || articles.length === 0) {
    throw new Error('generateNewscastPartScript: at least one article is required.');
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildPartUserPrompt({
    articles,
    units,
    plan,
    partCount,
    previousHeadlines: options.previousHeadlines ?? [],
    nextHeadlines: options.nextHeadlines ?? [],
    lengthPreference: options.lengthPreference,
  });
  return requestDialogueScript({
    provider,
    apiKey,
    transport,
    model,
    systemPrompt,
    userPrompt,
    effort: options.effort,
    gateway: options.gateway,
    signal,
    label: 'generateNewscastPartScript',
  });
}

// ---------------------------------------------------------------------------
// Organization stage (design §4)
// ---------------------------------------------------------------------------

/**
 * Options for {@link generateNewscastOrganization}. Same provider/key/model/effort
 * shape as {@link GenerateScriptOptions} — the organize stage is one more LLM call
 * over the SAME source articles, just producing structured speakable units instead
 * of dialogue.
 */
export interface GenerateOrganizationOptions {
  provider: LlmProvider;
  /** The provider key, for the direct path; replaced by {@link transport}. */
  apiKey?: string;
  /** Fulfil the provider call elsewhere (the key vault) instead of holding a key. */
  transport?: ProviderTransport;
  articles: Article[];
  model?: string;
  /** Optional reasoning effort; when omitted the provider default is used. */
  effort?: ScriptEffort;
  /** Optional AI Gateway routing; when omitted the provider call goes direct (today's behavior). */
  gateway?: AiGatewayConfiguration;
  signal?: AbortSignal;
}

/**
 * Result of {@link generateNewscastOrganization}: the parsed speakable units plus
 * the resolved model id and the provider's reported token usage (each omitted when
 * the provider did not report it). Mirrors {@link GenerateScriptResult}.
 */
export interface GenerateOrganizationResult {
  units: OrganizedUnit[];
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Structure the crawled source material into speakable {@link OrganizedUnit}s
 * (design §4) — the "organize" stage that runs before any dialogue is written.
 *
 * This is a preservation-oriented rearrangement, NOT a summary: the prompt keeps
 * every figure/proper-noun/quote verbatim and applies the SAME source-anonymity
 * ban the dialogue prompts use. Structurally identical to
 * {@link generateNewscastScript}: one provider call (retries are the durable
 * step's job — no inner loop), tolerant parsing, and the shared parse-failure
 * diagnostics. Throws on transport failure or when no unit can be parsed; the
 * caller (worker) is responsible for the §4 single-part fallback on failure.
 */
export async function generateNewscastOrganization(
  options: GenerateOrganizationOptions,
): Promise<GenerateOrganizationResult> {
  const { provider, apiKey, transport, articles, signal } = options;
  const model = options.model ?? defaultModelForProvider(provider);
  const label = 'generateNewscastOrganization';

  requireCredentialOrTransport(label, apiKey, transport);
  if (!Array.isArray(articles) || articles.length === 0) {
    throw new Error(`${label}: at least one article is required.`);
  }

  const call = await callSelectedProvider(
    provider,
    {
      apiKey,
      transport,
      model,
      systemPrompt: buildOrganizationSystemPrompt(),
      userPrompt: buildOrganizationUserPrompt(articles),
      effort: options.effort,
      gateway: options.gateway,
      signal,
    },
    label,
  );

  const units = parseOrganizedUnits(call.text);
  if (units.length === 0) {
    // No unit survived parsing — surface the raw model output + truncation hint the
    // same way the dialogue runner does, then throw to the durable step's retry.
    // `message` is already redacted by describeParseFailure; the label is ours.
    const message = describeParseFailure(label, provider, model, call, 'organized units');
    console.warn(`[${label}] ${message}`);
    throw new Error(message);
  }

  return {
    units,
    model,
    promptTokens: call.promptTokens,
    completionTokens: call.completionTokens,
  };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

// Per-article source caps (design §6). Raised well above the old 8000/2500 so a
// content-rich article survives into the prompt — the part planner (§2) sizes the
// newscast off the SAME caps, so both must read these exact constants. Summary and
// reactions are split from the former shared 2500 cap because reader reactions are
// the far larger, more speakable material.
const MAXIMUM_ARTICLE_CONTENT_LENGTH = 24_000;
const MAXIMUM_SUMMARY_SECTION_LENGTH = 4_000;
const MAXIMUM_REACTIONS_SECTION_LENGTH = 20_000;

/**
 * The single source/platform-anonymity rule line, shared verbatim by every
 * generation prompt (legacy dialogue, per-part dialogue, and organization). §4
 * requires the same ban apply to organized-unit detail/quotes, so it lives in one
 * place; changing it here changes it everywhere.
 */
const FORBIDDEN_SOURCE_TERMS_RULE_LINE =
  '- [매우 중요] 출처·플랫폼·커뮤니티를 절대 언급하지 마세요. 다음 표현은 금지: "긱뉴스", "GeekNews", "하다"(hada), "해커뉴스", "Hacker News", "HN", "레딧", "댓글", "커뮤니티", "포럼", "게시판", "게시글", "사이트", "링크", "출처", "~에 올라온", "~에서 화제", "글에 따르면". 정보를 어디서 봤다는 식이 아니라, 진행자가 뉴스 내용 자체를 직접 전달하는 방식으로 작성하세요.';

function buildSystemPrompt(): string {
  return [
    '당신은 한국어 뉴스 팟캐스트의 전문 대본 작가입니다.',
    '두 명의 진행자가 등장합니다: 진행자1(speaker 1)과 진행자2(speaker 2).',
    '두 진행자는 서로 자연스럽게 대화하듯 뉴스를 소개하고, 배경을 설명하고,',
    '서로의 의견을 주고받으며 청취자가 이해하기 쉽게 풀어서 전달합니다.',
    '실제 라디오 방송처럼 자연스러운 구어체 한국어를 사용하고, 딱딱한 문어체나',
    '어색한 번역투는 피합니다. 항상 진행자1이 먼저 말을 시작하고, 이후 두 진행자가',
    '번갈아 가며 이야기합니다.',
  ].join('\n');
}

/** The `\n\n`-joined `[기사 N]` source blocks, shared by every dialogue prompt. */
function buildArticleBlocks(articles: Article[]): string {
  return articles
    .map((article, index) => formatArticle(article, index))
    .join('\n\n');
}

/**
 * The `[음성 낭독용 대본 규칙]` heading + rule lines, shared verbatim by the legacy
 * single-shot prompt and the per-part prompt. The turn-count line and the
 * closing-greeting line are position-dependent (legacy: fixed "40턴", per-part:
 * dynamic target; legacy always closes, a non-final part does not), so callers
 * append those themselves — they are deliberately NOT part of this shared block.
 */
function buildReadingRuleLines(): string[] {
  return [
    '[음성 낭독용 대본 규칙 — 반드시 지킬 것]',
    '- 실제로 주고받는 자연스러운 구어체로 작성하세요. 문어체·긴 만연체는 금지.',
    '- 각 대사(턴)는 2~3문장으로 핵심 내용을 충분히 담으세요. 한 문장짜리 너무 짧은 대사는 피하세요.',
    '- 자연스러운 끊어 읽기를 위해 문장부호를 적극 사용: 쉼표(,)=짧은 숨, 마침표(.)=완전한 멈춤, 줄임표(...)=여운/뜸, 물음표(?)·느낌표(!)=억양 살리기.',
    '- 리액션·추임새를 자연스럽게 섞으세요: "아~", "네", "그렇죠", "맞아요", "오, 그래요?".',
    '- 다만 한 사람이 4문장 이상 길게 늘어놓지는 마세요. 문장 자체는 만연체 없이 자연스럽게 끊어 읽히도록 쓰세요.',
    '- 숫자·영어·약어는 읽는 그대로 한글로 풀어 쓰세요(예: "AI"→"에이아이", "GPT-5"→"지피티 파이브").',
    '- 무대지문·괄호·이모지·마크다운은 넣지 말고, 오직 말하는 문장만 출력하세요.',
    FORBIDDEN_SOURCE_TERMS_RULE_LINE,
  ];
}

/** The `=== 출력 형식 ===` JSON contract lines, shared by every dialogue prompt. */
function buildOutputFormatLines(): string[] {
  return [
    '=== 출력 형식 (반드시 준수) ===',
    '아래 형태의 JSON 객체 하나만 출력하세요. 다른 설명이나 마크다운 코드펜스는 절대 포함하지 마세요.',
    '{ "lines": [ { "speaker": 1, "text": "..." }, { "speaker": 2, "text": "..." } ] }',
    '- "speaker"는 숫자 1(진행자1) 또는 2(진행자2)만 사용합니다.',
    '- "text"는 해당 진행자의 대사(한국어)이며 빈 문자열은 허용되지 않습니다.',
  ];
}

/**
 * LEGACY whole-newscast prompt (single LLM call for the entire script). Preserved
 * byte-for-byte: the fixed "40턴" line and the always-present closing greeting are
 * intentionally kept exactly as they were. The multi-part path uses
 * {@link buildPartUserPrompt} instead.
 */
function buildUserPrompt(articles: Article[]): string {
  return [
    '아래 기사들을 바탕으로 진행자1과 진행자2가 대화하는 뉴스 방송 대본을 작성해 주세요.',
    '',
    '=== 기사 목록 ===',
    buildArticleBlocks(articles),
    '',
    '=== 작성 지침 ===',
    '- 진행자1(1)이 첫 대사를 시작하고, 이후 진행자1과 진행자2가 번갈아 가며 말합니다.',
    '- 각 기사의 핵심 내용을 청취자가 이해하기 쉽도록 대화로 풀어 주세요.',
    '',
    ...buildReadingRuleLines(),
    '- 전체 턴(두 진행자가 주고받는 대사)은 40턴 내외로 구성하세요.',
    '',
    '- 마지막에는 방송을 정리하는 짧은 마무리 인사를 넣어 주세요.',
    '',
    ...buildOutputFormatLines(),
  ].join('\n');
}

/**
 * Parameters for {@link buildPartUserPrompt} — the per-part user prompt (§5).
 * `previousHeadlines`/`nextHeadlines` are always arrays here (the public option
 * defaults them), so the builder never re-normalizes undefined.
 */
interface PartPromptInput {
  articles: Article[];
  units: OrganizedUnit[];
  plan: NewscastPartPlan;
  partCount: number;
  previousHeadlines: string[];
  nextHeadlines: string[];
  lengthPreference?: NewscastLengthPreference;
}

/**
 * The single tone hint each non-standard length preset adds to the part prompt
 * (design §14). 'standard' has NO entry on purpose: the standard prompt must stay
 * byte-identical to the pre-preset prompt, so no line is emitted for it (or when
 * the preference is omitted). These only nudge tone/breadth; the actual size is
 * governed by the turn target from {@link planNewscastParts}, and the existing
 * anti-padding reading rules still apply.
 */
const LENGTH_PREFERENCE_HINT_LINES: Record<'short' | 'long', string> = {
  short: '- 핵심만 간결히 다루고 곁가지는 생략하세요.',
  long: '- 배경 설명과 진행자들의 리액션을 풍부하게 담으세요.',
};

/** The preset tone-hint line(s) for a part prompt — empty for 'standard'/omitted. */
function lengthHintLines(preference: NewscastLengthPreference | undefined): string[] {
  if (preference === 'short' || preference === 'long') {
    return [LENGTH_PREFERENCE_HINT_LINES[preference]];
  }
  return [];
}

/**
 * Build ONE part's user prompt (design §5). Reuses the shared article blocks,
 * reading rules, and output format; the part-specific pieces are:
 * - a dynamic turn target replacing the legacy fixed "40턴" line;
 * - position-aware intro/outro rules (opening greeting only in part 1; a closing
 *   greeting only in the final part; a non-final part is told to trail off);
 * - a coverage block listing this part's units verbatim (headline/detail/quotes)
 *   plus don't-repeat / don't-poach guards from previous/next headlines.
 * When `units` is empty (fallback mode) the coverage block is omitted, degrading
 * to the legacy single-shot shape with only the dynamic turn target.
 */
function buildPartUserPrompt(input: PartPromptInput): string {
  const { articles, units, plan, partCount, previousHeadlines, nextHeadlines, lengthPreference } =
    input;
  const isFirstPart = plan.index === 1;
  const isLastPart = plan.index === partCount;

  const lines: string[] = [
    '아래 재료를 바탕으로 진행자1과 진행자2가 대화하는 뉴스 방송 대본을 작성해 주세요.',
  ];
  if (partCount > 1) {
    lines.push(
      `이 방송은 총 ${partCount}개 부분으로 이어지며, 지금 작성하는 것은 그중 ${plan.index}번째 부분입니다.`,
    );
  }
  lines.push('', '=== 기사 목록 ===', buildArticleBlocks(articles));

  const coverageBlock = buildUnitCoverageBlock(units, plan.unitIndexes);
  if (coverageBlock !== null) {
    lines.push(
      '',
      '=== 이 파트에서 다룰 재료 (아래 내용을 빠짐없이 대화로 풀어내세요) ===',
      coverageBlock,
    );
  }

  lines.push(
    '',
    '=== 작성 지침 ===',
    '- 진행자1(1)이 첫 대사를 시작하고, 이후 진행자1과 진행자2가 번갈아 가며 말합니다.',
    '- 각 기사의 핵심 내용을 청취자가 이해하기 쉽도록 대화로 풀어 주세요.',
    ...buildPartPositionLines({
      isFirstPart,
      isLastPart,
      previousHeadlines,
      nextHeadlines,
    }),
    '',
    ...buildReadingRuleLines(),
    `- 이 파트의 전체 턴은 ${plan.turnTarget}턴 내외로 구성하세요.`,
    // One preset tone hint (§14) — nothing for 'standard'/omitted, so that prompt
    // stays byte-identical to before length presets existed.
    ...lengthHintLines(lengthPreference),
    '',
    ...buildOutputFormatLines(),
  );
  return lines.join('\n');
}

/**
 * The position-aware intro/outro rule lines for one part (§5). A lone part
 * (`isFirstPart && isLastPart`) both greets and closes, matching the legacy shape.
 */
function buildPartPositionLines(input: {
  isFirstPart: boolean;
  isLastPart: boolean;
  previousHeadlines: string[];
  nextHeadlines: string[];
}): string[] {
  const { isFirstPart, isLastPart, previousHeadlines, nextHeadlines } = input;
  const positionLines: string[] = [];
  if (isFirstPart) {
    positionLines.push(
      '- 이 방송의 첫 부분입니다. 진행자1이 청취자에게 건네는 자연스러운 오프닝 인사로 시작하세요.',
    );
  } else {
    positionLines.push(
      '- 앞부분에 이어지는 중간 부분입니다. 새로 인사하지 말고, 앞의 흐름을 자연스럽게 이어서 시작하세요.',
    );
  }
  if (previousHeadlines.length > 0) {
    positionLines.push(
      `- 다음 내용은 앞부분에서 이미 다뤘으니 반복하지 마세요: ${previousHeadlines.join(' / ')}`,
    );
  }
  if (isLastPart) {
    positionLines.push(
      '- 이 방송의 마지막 부분입니다. 마지막에는 방송을 정리하는 짧은 마무리 인사를 넣어 주세요.',
    );
  } else {
    positionLines.push(
      '- 아직 뒤에 이어질 부분이 남아 있으니 마무리 인사는 하지 말고, 이 단락을 자연스럽게 맺으세요.',
    );
  }
  if (nextHeadlines.length > 0) {
    positionLines.push(
      `- 다음 내용은 뒷부분에서 다룰 몫이니 지금은 다루지 마세요: ${nextHeadlines.join(' / ')}`,
    );
  }
  return positionLines;
}

/**
 * Render the units this part covers as a verbatim material list (§5): one entry
 * per unit with its headline, detail, and any quotes preserved word-for-word so
 * the model speaks from the real numbers/quotes, not a paraphrase. Returns `null`
 * when there is nothing to cover (fallback mode or an empty assignment), so the
 * caller omits the coverage section entirely.
 */
function buildUnitCoverageBlock(units: OrganizedUnit[], unitIndexes: number[]): string | null {
  const entries: string[] = [];
  for (const unitIndex of unitIndexes) {
    const unit = units[unitIndex];
    if (unit === undefined) {
      continue;
    }
    const entryLines = [`${entries.length + 1}. [${unit.headline}] ${unit.detail}`];
    if (unit.quotes !== undefined && unit.quotes.length > 0) {
      entryLines.push(`   인용: ${unit.quotes.map((quote) => `"${quote}"`).join(' / ')}`);
    }
    entries.push(entryLines.join('\n'));
  }
  return entries.length > 0 ? entries.join('\n\n') : null;
}

/**
 * System prompt for the organize stage (§4). Frames the model as an editor who
 * REARRANGES speakable material (not a summarizer) and must preserve figures,
 * proper nouns, and key quotes verbatim.
 */
function buildOrganizationSystemPrompt(): string {
  return [
    '당신은 한국어 뉴스 방송을 준비하는 전문 편집자입니다.',
    '주어진 기사 자료를 방송에서 두 진행자가 말할 "발화 재료 단위"로 구조화합니다.',
    '이 작업은 요약이 아니라, 방송에서 말할 재료를 빠짐없이 보존하면서 방송 서사 순서로 재배열하는 것입니다.',
    '수치, 고유명사, 핵심 인용문은 원문 그대로 유지해야 합니다.',
  ].join('\n');
}

/**
 * User prompt for the organize stage (§4). Reuses the shared `[기사 N]` source
 * blocks and the same source-anonymity ban the dialogue prompts apply (so it lands
 * on unit detail/quotes too), and asks for the `{ "units": [...] }` JSON contract
 * that {@link parseOrganizedUnits} reads. The count/length caps here mirror the
 * parser's clamps and the §4 output-token budget (≤ 24 units × short fields).
 */
function buildOrganizationUserPrompt(articles: Article[]): string {
  return [
    '아래 기사 자료를 방송에서 말할 발화 재료 단위(unit)들로 정리해 주세요.',
    '',
    '=== 기사 목록 ===',
    buildArticleBlocks(articles),
    '',
    '=== 정리 규칙 (반드시 지킬 것) ===',
    '- 요약하지 마세요. 내용을 압축·생략하지 말고, 방송에서 말할 재료를 보존적으로 재배열하세요.',
    '- 수치·고유명사·핵심 인용은 원문 그대로 유지하세요.',
    '- 유닛은 6개 이상 24개 이하로 만드세요.',
    '- 각 유닛의 headline 은 60자 이하, detail 은 240자 이하로 작성하세요.',
    '- quotes 는 유닛당 최대 2개, 각 100자 이하의 원문 인용만 담으세요(인용이 없으면 빈 배열로 두세요).',
    '- kind 는 다음 중 하나입니다: "fact"(사실), "argument"(논거·주장), "example"(사례), "reaction"(반응·반론), "context"(맥락·배경).',
    '- weight 는 방송에서의 발화 가치이며 1(낮음)부터 5(높음)까지의 정수입니다.',
    '- 유닛을 방송 서사 순서로 정렬하세요: 도입·맥락 → 핵심 사실 → 심화·논거 → 반응·반론 → 전망.',
    FORBIDDEN_SOURCE_TERMS_RULE_LINE,
    '',
    '=== 출력 형식 (반드시 준수) ===',
    '아래 형태의 JSON 객체 하나만 출력하세요. 다른 설명이나 마크다운 코드펜스는 절대 포함하지 마세요.',
    '{ "units": [ { "kind": "fact", "headline": "...", "detail": "...", "quotes": ["..."], "weight": 3 } ] }',
  ].join('\n');
}

/**
 * HARD-forbidden source terms the newscast dialogue must never contain. If any
 * of these survives into the model output, {@link generateNewscastScript}
 * regenerates (see the retry loop). Matched case-insensitively as substrings;
 * the standalone `hn` token is matched separately to avoid false positives
 * inside words like "john".
 */
const HARD_FORBIDDEN_SOURCE_TERMS: readonly string[] = [
  '긱뉴스',
  'geeknews',
  '해커뉴스',
  '해커 뉴스',
  'hacker news',
  'hackernews',
  '레딧',
  'reddit',
  '댓글',
  '커뮤니티',
  '포럼',
  '게시판',
  '게시글',
  'news.hada',
  'hada.io',
];

/**
 * True when `text` contains any HARD-forbidden source term (case-insensitive).
 * Also flags the standalone `hn` token (`hn`, `hn에`, `hn의`, ...) while ignoring
 * it inside larger latin words. Exported so the generation loop and tests share
 * one definition.
 */
export function containsForbiddenSourceTerm(text: string): boolean {
  const lower = text.toLowerCase();
  for (const term of HARD_FORBIDDEN_SOURCE_TERMS) {
    if (lower.includes(term)) {
      return true;
    }
  }
  // Standalone `hn`: bounded by a non-latin-letter (space, Korean particle,
  // punctuation, or string edge) on both sides — so "john"/"hnat" don't match.
  return /(^|[^a-z])hn([^a-z]|$)/i.test(text);
}

function formatArticle(article: Article, index: number): string {
  const content = truncateSection(article.content, MAXIMUM_ARTICLE_CONTENT_LENGTH);
  // Deliberately NO source URL/domain here: the newscast should present the news
  // itself, never the platform it came from. Links are attached to the result
  // separately (NewscastResult.sources) for the web UI, not fed to the script.
  const sections: string[] = [
    `[기사 ${index + 1}]`,
    `제목: ${article.title}`,
    '본문:',
    content.length > 0 ? content : '(본문을 가져오지 못했습니다. 제목을 중심으로 다뤄 주세요.)',
  ];

  // Extra source material under NEUTRAL labels that never name the platform, so
  // the model has no source word to echo. Only included when non-empty.
  const summary = truncateSection(
    article.geeknewsSummary ?? '',
    MAXIMUM_SUMMARY_SECTION_LENGTH,
  );
  if (summary.length > 0) {
    sections.push('', '요약:', summary);
  }

  const reactions = truncateSection(
    article.hackerNewsComments ?? '',
    MAXIMUM_REACTIONS_SECTION_LENGTH,
  );
  if (reactions.length > 0) {
    sections.push('', '이 주제에 대한 독자들의 다양한 반응과 논점:', reactions);
  }

  return sections.join('\n');
}

/** Trim and cap `text` at `maxLength` chars, appending an elision marker if cut. */
function truncateSection(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}\n...(이하 생략)`;
}

// ---------------------------------------------------------------------------
// Part planning (design §2) — pure, deterministic sizing of the newscast
// ---------------------------------------------------------------------------

/**
 * Measured pipeline constants (2026-07-15 D1 telemetry, design §2). Audio length
 * tracks CHARACTER count (r=0.99), not turn count (r=0.22), so the newscast is
 * sized off characters and turns are derived from characters.
 */
/** Rendered speech ≈ 8.15 script characters per second of audio. */
const SCRIPT_CHARACTERS_PER_SECOND = 8.15;
/** One dialogue turn ≈ 78 script characters (≈ 9.6 s). */
const SCRIPT_CHARACTERS_PER_TURN = 78;
/** Source characters → script characters compression ratio. */
const SOURCE_COMPRESSION_RATIO = 4.1;
/**
 * Per-part script-character target (design §2): 480 s (8 min) at
 * {@link SCRIPT_CHARACTERS_PER_SECOND} ≈ 3912, rounded to the flat 3900 the design
 * pins — the regression turn/part expectations are computed against this value.
 */
const PART_TARGET_SCRIPT_CHARACTERS = 3900;
/** Hard cap on parts — 3 × 8 min = the 24-minute ceiling. */
const MAXIMUM_NEWSCAST_PARTS = 3;
/** Per-part turn target is clamped to this band (design §2 turnTarget formula). */
const MINIMUM_PART_TURN_TARGET = 24;
const MAXIMUM_PART_TURN_TARGET = 56;

/**
 * Total speakable SOURCE characters across all articles, measured AFTER applying
 * the exact same per-section caps {@link formatArticle} applies to the prompt
 * (design §2's `speakableSourceCharacters`). Sizing off the same capped lengths is
 * what keeps the plan honest — the planner never counts characters the prompt
 * builder would have truncated away. The elision marker is a prompt artifact, not
 * speakable material, so only the capped body length is counted.
 */
function speakableSourceCharacters(articles: Article[]): number {
  let total = 0;
  for (const article of articles) {
    total += cappedSectionLength(article.content, MAXIMUM_ARTICLE_CONTENT_LENGTH);
    total += cappedSectionLength(article.geeknewsSummary ?? '', MAXIMUM_SUMMARY_SECTION_LENGTH);
    total += cappedSectionLength(
      article.hackerNewsComments ?? '',
      MAXIMUM_REACTIONS_SECTION_LENGTH,
    );
  }
  return total;
}

/** Trimmed length of `text`, capped at `maxLength` (mirrors {@link truncateSection}'s cap). */
function cappedSectionLength(text: string, maxLength: number): number {
  return Math.min(text.trim().length, maxLength);
}

/** Clamp `value` into the inclusive `[low, high]` range. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Decide how many parts the newscast splits into and how many turns each part
 * targets, then distribute the organized units across the parts — all from the
 * §2 formulas, deterministically, with NO LLM involvement.
 *
 * Part count and turn target come from the estimated SCRIPT-character budget
 * (source characters ÷ compression ratio); the turn target is uniform across parts
 * (the §2 formula divides the budget evenly). Units keep their original narrative
 * order and are split into contiguous groups whose total `weight` is as even as
 * possible (cumulative greedy). When `units` is empty the parts still form (each
 * with no assigned units) so the caller can drive the same pipeline; the per-part
 * script generator then runs in its fallback (no-coverage) mode.
 *
 * Regression pins (design §2): a 13,000-char source → 1 part / 41-turn target
 * (matches the legacy "40턴 내외"); a 48,000-char source → 3 parts / 50-turn
 * targets (the 24-minute ceiling).
 *
 * `options.lengthFactor` scales the estimated script-character budget for the
 * length preset (design §14) BEFORE any clamp — so a preset only stretches/shrinks
 * within the source-supported range. It defaults to 1.0, which is byte-identical to
 * the pre-preset behavior (existing callers and the §2 pins pass nothing).
 */
export function planNewscastParts(
  articles: Article[],
  units: OrganizedUnit[],
  options?: { lengthFactor?: number },
): NewscastPartPlan[] {
  const lengthFactor = options?.lengthFactor ?? 1.0;
  const estimatedScriptCharacters =
    (speakableSourceCharacters(articles) / SOURCE_COMPRESSION_RATIO) * lengthFactor;
  const partCount = clamp(
    Math.round(estimatedScriptCharacters / PART_TARGET_SCRIPT_CHARACTERS),
    1,
    MAXIMUM_NEWSCAST_PARTS,
  );
  const turnTarget = clamp(
    Math.round(estimatedScriptCharacters / partCount / SCRIPT_CHARACTERS_PER_TURN),
    MINIMUM_PART_TURN_TARGET,
    MAXIMUM_PART_TURN_TARGET,
  );

  const unitGroups = distributeUnitsByWeight(units, partCount);
  return unitGroups.map((unitIndexes, groupIndex) => ({
    index: groupIndex + 1,
    unitIndexes,
    turnTarget,
  }));
}

/**
 * Split the ordered `units` into `partCount` CONTIGUOUS groups (original order
 * preserved) whose summed `weight` is as even as possible — the §4 "cumulative
 * greedy" partition. Walks the units once, advancing to the next group once the
 * running weight passes that group's fair-share boundary, but never so eagerly
 * that a later group would be left with no units (so every group gets at least one
 * unit whenever `units.length >= partCount`). Returns `partCount` index arrays
 * (some may be empty when there are fewer units than parts).
 */
function distributeUnitsByWeight(units: OrganizedUnit[], partCount: number): number[][] {
  const groups: number[][] = Array.from({ length: partCount }, () => []);
  if (partCount <= 1) {
    groups[0] = units.map((_unit, index) => index);
    return groups;
  }

  const totalWeight = units.reduce((sum, unit) => sum + unit.weight, 0);
  let currentGroup = 0;
  let cumulativeWeight = 0;
  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    groups[currentGroup].push(unitIndex);
    cumulativeWeight += units[unitIndex].weight;

    if (currentGroup >= partCount - 1) {
      continue; // Already in the last group — everything remaining lands here.
    }
    const unitsAfterThis = units.length - (unitIndex + 1);
    const groupsAfterThis = partCount - (currentGroup + 1);
    // Force a boundary the moment there are only just enough units left to give
    // every remaining group one apiece — this guarantees non-empty later groups.
    if (unitsAfterThis <= groupsAfterThis) {
      currentGroup += 1;
      continue;
    }
    // Otherwise advance for weight balance: once this group has reached its fair
    // share of the cumulative weight, start filling the next one.
    const fairShareBoundary = ((currentGroup + 1) * totalWeight) / partCount;
    if (cumulativeWeight >= fairShareBoundary) {
      currentGroup += 1;
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Provider REST calls (fetch only, no SDK)
// ---------------------------------------------------------------------------

interface ProviderCallOptions {
  /** The credential for the direct path; absent when {@link transport} fulfils the call. */
  apiKey?: string;
  /** Fulfil the call through the key vault instead of holding a credential (§5.1). */
  transport?: ProviderTransport;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  effort?: ScriptEffort;
  /** Optional AI Gateway routing; when omitted the provider call goes direct (today's behavior). */
  gateway?: AiGatewayConfiguration;
  signal?: AbortSignal;
}

/**
 * Every entry point needs exactly one of a credential or a transport; failing
 * that, the request could only be sent unauthenticated. Kept as one helper so all
 * three report it identically (the historical `apiKey is required` wording).
 */
function requireCredentialOrTransport(
  label: string,
  apiKey: string | undefined,
  transport: ProviderTransport | undefined,
): void {
  if (transport === undefined && (typeof apiKey !== 'string' || apiKey.length === 0)) {
    throw new Error(`${label}: apiKey is required.`);
  }
}

/**
 * Result of a single provider REST call: the generated text plus the provider's
 * reported token usage (each omitted when the provider did not report it).
 */
interface ProviderCallResult {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
  /**
   * Provider's reason for stopping generation, when reported (Anthropic
   * `stop_reason`). `'max_tokens'` means the output was TRUNCATED at the token
   * cap — the single most useful signal for diagnosing an unparseable response.
   */
  stopReason?: string;
}

/**
 * Per-call wall-clock timeout guarding a SINGLE hung provider request.
 *
 * Every generation entry point (script, part-script, organization) makes exactly
 * ONE provider call and then throws on failure — retries are delegated to the
 * durable Workflow step (3× with exponential backoff). An inner retry loop here
 * compounded WITH that step retry into up to ~12 doomed LLM calls whenever a
 * response was unparseable (job c3f487b3 burned ~6 min this way before erroring),
 * so a parse failure throws IMMEDIATELY and lets the step decide — one retry
 * layer, not two. This timeout only bounds the single call.
 *
 * 240s, up from 90s: high-effort reasoning models (claude-opus-5 effort=medium)
 * legitimately spend 2–4 minutes on one part's script. On the vault (BYOK) path
 * this signal is not forwarded, so the vault's own 240s abort governs there;
 * this bound covers the operator-key direct path. Both sit under the script
 * step's 5-minute per-attempt timeout.
 */
const PROVIDER_CALL_TIMEOUT_MS = 240_000;

/**
 * Dispatch one prompt to the selected provider under {@link PROVIDER_CALL_TIMEOUT_MS}.
 * `label` names the calling function in the "unsupported provider" error so a
 * misconfiguration is traceable. The caller's own `signal` (when given) wins over
 * the timeout signal, matching the previous per-function behavior.
 */
async function callSelectedProvider(
  provider: LlmProvider,
  call: ProviderCallOptions,
  label: string,
): Promise<ProviderCallResult> {
  const withSignal: ProviderCallOptions = {
    ...call,
    signal: call.signal ?? AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
  };
  switch (provider) {
    case 'anthropic':
      return callAnthropic(withSignal);
    case 'openai':
      return callOpenAI(withSignal, OPENAI_TARGET);
    case 'google':
      return callGemini(withSignal);
    case 'xai':
      // xAI is OpenAI-compatible down to the request and response bodies, so it
      // reuses `callOpenAI` wholesale (design §2: no second call site) — only the
      // host, the gateway segment and the effort ladder differ, and all three are
      // data in {@link XAI_TARGET}.
      return callOpenAI(withSignal, XAI_TARGET);
    default:
      throw new Error(`${label}: unsupported provider '${String(provider)}'.`);
  }
}

/**
 * Shared runner for the dialogue-producing entry points ({@link generateNewscastScript}
 * and {@link generateNewscastPartScript}): one provider call, robust line parsing,
 * and identical failure diagnostics. Both callers differ only in the prompt they
 * pass and the `label` used in log/error messages. Throws (never retries) so the
 * durable step owns retry policy.
 */
async function requestDialogueScript(params: {
  provider: LlmProvider;
  apiKey?: string;
  transport?: ProviderTransport;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  effort?: ScriptEffort;
  gateway?: AiGatewayConfiguration;
  signal?: AbortSignal;
  label: string;
}): Promise<GenerateScriptResult> {
  const {
    provider,
    apiKey,
    transport,
    model,
    systemPrompt,
    userPrompt,
    effort,
    gateway,
    signal,
    label,
  } = params;
  const call = await callSelectedProvider(
    provider,
    { apiKey, transport, model, systemPrompt, userPrompt, effort, gateway, signal },
    label,
  );
  const lines = parseScriptLines(call.text);

  if (lines.length === 0) {
    // Parsing produced no lines — surface WHAT the model actually returned so the
    // failure is diagnosable (truncation? wrong JSON shape? empty response?); the
    // raw text is otherwise lost. `console.warn` mirrors it into observability so
    // each failed step attempt stays visible, then we throw to the step retry.
    // describeParseFailure already redacted it — this console path bypasses the
    // Logger scrubber, so the masking has to have happened upstream.
    const message = describeParseFailure(label, provider, model, call, 'script lines');
    console.warn(`[${label}] ${message}`);
    throw new Error(message);
  }

  // A stray source word (긱뉴스/해커뉴스/댓글/...) that survived the prompt rule is a
  // soft failure only: keep the script best-effort (never fail the whole job over
  // one word) and log it. Regenerating, if ever wanted, is the step's job.
  const scriptText = lines.map((line) => line.text).join('\n');
  if (containsForbiddenSourceTerm(scriptText)) {
    // `model` is caller-supplied free text, and this console path bypasses the
    // Logger scrubber — mask before printing.
    console.warn(
      redactSecrets(
        `[${label}] ${provider}/${model} output referenced a forbidden source term; keeping best-effort.`,
      ),
    );
  }

  return {
    lines,
    model,
    promptTokens: call.promptTokens,
    completionTokens: call.completionTokens,
  };
}

/**
 * Build the diagnostic message for a response that produced no usable structured
 * output. Shared by the dialogue runner and organization so both report the raw
 * snippet + the decisive `stop_reason=max_tokens` truncation hint identically.
 * `itemDescription` names WHAT could not be parsed ('script lines' /
 * 'organized units') so the same diagnostic serves both entry points.
 */
function describeParseFailure(
  label: string,
  provider: LlmProvider,
  model: string,
  call: ProviderCallResult,
  itemDescription: string,
): string {
  const rawSnippet = call.text.length > 600 ? `${call.text.slice(0, 600)}…` : call.text;
  // stop_reason is the decisive truncation signal: 'max_tokens' means the model
  // was cut off mid-output (so the JSON never closed), not that it produced
  // garbage. Surfacing it turns "failed to parse" from a mystery into an
  // actionable "raise the token cap".
  const stopHint =
    call.stopReason === 'max_tokens'
      ? ' [TRUNCATED: stop_reason=max_tokens — output hit the token cap]'
      : call.stopReason !== undefined
        ? ` [stop_reason=${call.stopReason}]`
        : '';
  // The snippet is raw model output and `model` is caller-supplied, so both can
  // carry credential-shaped text. Redacting the finished message covers every
  // consumer at once: the `console.warn` mirror, the thrown error, and the
  // failure record the worker persists from it.
  return redactSecrets(
    `${label}: failed to parse any ${itemDescription} from the ${provider}/${model} ` +
      `response (len=${call.text.length})${stopHint}. Raw: ${JSON.stringify(rawSnippet)}`,
  );
}

/**
 * Output-token cap for the Anthropic call. A full two-host Korean newscast script
 * runs several thousand tokens; the previous 4096 cap truncated long scripts
 * mid-JSON so the array/object never closed and the response could not be parsed
 * (job c3f487b3: len=5328, stop_reason=max_tokens). 16384 gives comfortable
 * headroom — and when `effort` is set, `thinking:{type:'adaptive'}` shares this
 * budget, so the cap must cover BOTH the reasoning and the visible script. Well
 * within the Haiku/Sonnet/Opus 4.x output-token limits.
 */
const ANTHROPIC_MAX_OUTPUT_TOKENS = 16_384;

/** Coerce an unknown usage field to a non-negative integer, or undefined. */
function toTokenCount(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/**
 * One provider POST, described so that WHO authenticates it is the last decision
 * made. Both halves are here at once because the two paths must stay in step: the
 * direct path needs a full URL (already gateway-routed) plus credential headers,
 * the transport path needs the provider-RELATIVE path and no credential at all.
 */
interface ProviderHttpCall {
  /** Provider name as it appears in error messages ('Anthropic' / 'OpenAI' / …). */
  label: string;
  /** Provider-relative path for the transport; never a URL (see {@link ProviderTransport}). */
  path: string;
  /** Full URL for the direct call — gateway-routed when a gateway is configured. */
  directUrl: string;
  /** Headers safe to hand anyone: content type, API version. NO credential. */
  headers: Record<string, string>;
  /** Credential headers, used ONLY on the direct path. */
  credentialHeaders: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  transport?: ProviderTransport;
}

/**
 * Send one provider request and return its parsed JSON body, by whichever path
 * the caller was given.
 *
 * A non-2xx throws {@link ProviderRequestError} carrying the STATUS, so the
 * pipeline can separate "the credential was refused" (401/403 — terminal, design
 * §5.4) from everything a retry might fix. The body is masked and capped first:
 * a 401 body routinely quotes the offending key back, and this message is
 * persisted into the job's failure record.
 */
async function requestProviderJson(call: ProviderHttpCall): Promise<unknown> {
  if (call.transport !== undefined) {
    const response = await call.transport({
      path: call.path,
      method: 'POST',
      body: call.body,
      headers: call.headers,
    });
    if (response.status < 200 || response.status >= 300) {
      // No request-id note here: the transport returns a status and a body, not
      // response headers — a deliberate narrowing, since the vault's proxy is not
      // a general-purpose HTTP client.
      throw new ProviderRequestError(
        `${call.label} request failed (${response.status}): ${redactedErrorFragment(response.body)}`,
        response.status,
      );
    }
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      throw new Error(`${call.label} response was not valid JSON.`);
    }
  }

  const response = await fetch(call.directUrl, {
    method: 'POST',
    headers: { ...call.headers, ...call.credentialHeaders },
    body: call.body,
    signal: call.signal,
  });
  if (!response.ok) {
    throw new ProviderRequestError(
      `${call.label} request failed (${response.status})${providerRequestIDNote(response)}: ${await readRedactedErrorBody(response)}`,
      response.status,
    );
  }
  return response.json();
}

/**
 * Anthropic Messages API.
 * POST https://api.anthropic.com/v1/messages
 * Headers: x-api-key, anthropic-version, content-type.
 * Usage: `usage.input_tokens` / `usage.output_tokens`.
 */
async function callAnthropic(
  options: ProviderCallOptions,
): Promise<ProviderCallResult> {
  const { apiKey, transport, model, systemPrompt, userPrompt, effort, gateway, signal } =
    options;
  const requestBody: Record<string, unknown> = {
    model,
    max_tokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  };
  if (effort !== undefined) {
    // Claude 5 / Opus 4.8 effort control. `budget_tokens` is rejected on these
    // models — use output_config.effort with adaptive thinking instead. 'none'
    // is not an Anthropic level (thinking-off is a separate, restricted
    // parameter), so it folds to the floor rather than 400ing the request.
    requestBody.output_config = { effort: effort === 'none' ? 'low' : effort };
    requestBody.thinking = { type: 'adaptive' };
  }
  // AI Gateway egress (design 2026-07-29-ai-gateway-egress §2): Anthropic keeps
  // its own `/v1` in the gateway suffix (asymmetric with OpenAI below).
  const url =
    gateway === undefined
      ? 'https://api.anthropic.com/v1/messages'
      : aiGatewayUrl(gateway, 'anthropic/v1/messages');
  const data = (await requestProviderJson({
    label: 'Anthropic',
    path: 'v1/messages',
    directUrl: url,
    headers: {
      // `anthropic-version` is required on every request and is NOT a credential,
      // so it travels with the spec — the vault's forwardable-header allowlist
      // names it for exactly this reason.
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    // Both the provider key and the gateway token are direct-path-only: on the
    // transport path the fulfiller owns its own egress route AND its own gateway
    // credentials, so neither belongs in a spec that leaves this package.
    credentialHeaders: { 'x-api-key': apiKey ?? '', ...aiGatewayHeaders(gateway) },
    body: JSON.stringify(requestBody),
    signal,
    transport,
  })) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string;
  };
  const textBlock = data.content?.find(
    (block) => typeof block.text === 'string' && block.text.length > 0,
  );
  const text = textBlock?.text ?? data.content?.[0]?.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Anthropic response did not contain any text content.');
  }
  return {
    text,
    promptTokens: toTokenCount(data.usage?.input_tokens),
    completionTokens: toTokenCount(data.usage?.output_tokens),
    stopReason: data.stop_reason,
  };
}

/**
 * Everything that differs between two OpenAI-COMPATIBLE providers. xAI speaks the
 * same Chat Completions request and response bodies as OpenAI, so the whole
 * integration is this table plus a switch case — the design's "reuse callOpenAI,
 * branch only the base URL" rule (§2), with the effort ladder added because that
 * is the one place the two APIs genuinely disagree.
 */
interface OpenAICompatibleTarget {
  /** Provider name in error messages. */
  label: string;
  /** Direct chat-completions URL. */
  directUrl: string;
  /** Suffix appended to an AI Gateway base. */
  gatewaySuffix: string;
  /** Provider-relative path handed to a {@link ProviderTransport}. */
  proxyPath: string;
  /** Map the pipeline's effort scale onto what THIS provider accepts. */
  reasoningEffort(effort: ScriptEffort): string;
}

const OPENAI_TARGET: OpenAICompatibleTarget = {
  label: 'OpenAI',
  directUrl: 'https://api.openai.com/v1/chat/completions',
  // AI Gateway egress (design 2026-07-29-ai-gateway-egress §2): unlike Anthropic,
  // OpenAI's suffix DROPS `/v1` — the gateway base already ends in `/v1`.
  gatewaySuffix: 'openai/chat/completions',
  proxyPath: 'v1/chat/completions',
  // GPT-5.6 accepts the full low..max ladder, so the value passes through.
  reasoningEffort: (effort) => effort,
};

const XAI_TARGET: OpenAICompatibleTarget = {
  label: 'xAI',
  directUrl: 'https://api.x.ai/v1/chat/completions',
  // Cloudflare's slug for xAI is `grok`, and unlike OpenAI it KEEPS the provider's
  // own `/v1` (verified against the AI Gateway provider docs, 2026-08-11) — the
  // same mapping the key vault's registry uses, so both paths agree.
  gatewaySuffix: 'grok/v1/chat/completions',
  proxyPath: 'v1/chat/completions',
  reasoningEffort: (effort) => XAI_REASONING_EFFORT[effort],
};

/**
 * OpenAI Chat Completions API — and, with {@link XAI_TARGET}, xAI's compatible
 * one.
 * POST https://api.openai.com/v1/chat/completions
 * Header: Authorization: Bearer <apiKey>. JSON-object response mode is requested,
 * so the model returns `{ "lines": ScriptLine[] }`, unwrapped by the parser.
 */
async function callOpenAI(
  options: ProviderCallOptions,
  target: OpenAICompatibleTarget,
): Promise<ProviderCallResult> {
  const { apiKey, transport, model, systemPrompt, userPrompt, effort, gateway, signal } =
    options;
  const requestBody: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
  };
  if (effort !== undefined) {
    // reasoning_effort is honored only by reasoning models (gpt-5 / o-series, and
    // Grok 4.5); pairing effort with a non-reasoning model may be rejected by the
    // API. The value is mapped per target — Grok has no xhigh/max.
    requestBody.reasoning_effort = target.reasoningEffort(effort);
  }
  const url =
    gateway === undefined ? target.directUrl : aiGatewayUrl(gateway, target.gatewaySuffix);
  const data = (await requestProviderJson({
    label: target.label,
    path: target.proxyPath,
    directUrl: url,
    headers: { 'content-type': 'application/json' },
    credentialHeaders: {
      Authorization: `Bearer ${apiKey ?? ''}`,
      ...aiGatewayHeaders(gateway),
    },
    body: JSON.stringify(requestBody),
    signal,
    transport,
  })) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('OpenAI response did not contain any message content.');
  }
  return {
    text,
    promptTokens: toTokenCount(data.usage?.prompt_tokens),
    completionTokens: toTokenCount(data.usage?.completion_tokens),
  };
}

/**
 * Google Gemini generateContent API.
 * POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
 * Header: x-goog-api-key: <apiKey> — used in BOTH direct and gateway mode (design
 * 2026-07-29-ai-gateway-egress §4): no `?key=` query string, so the key never
 * lands in a URL or access log. The system + user prompts are combined into a
 * single text part; JSON response mime type is requested.
 */
async function callGemini(
  options: ProviderCallOptions,
): Promise<ProviderCallResult> {
  const { apiKey, transport, model, systemPrompt, userPrompt, effort, gateway, signal } =
    options;
  const modelPath = `v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const url =
    gateway === undefined
      ? `https://generativelanguage.googleapis.com/${modelPath}`
      : aiGatewayUrl(gateway, `google-ai-studio/${modelPath}`);
  const combinedPrompt = `${systemPrompt}\n\n${userPrompt}`;
  const generationConfig: Record<string, unknown> = { responseMimeType: 'application/json' };
  if (effort !== undefined) {
    // Gemini 3 uses a thinkingLevel enum (not a token budget); xhigh/max cap to high.
    generationConfig.thinkingConfig = { thinkingLevel: GEMINI_THINKING_LEVEL[effort] };
  }
  const data = (await requestProviderJson({
    label: 'Gemini',
    path: modelPath,
    directUrl: url,
    headers: { 'content-type': 'application/json' },
    credentialHeaders: {
      'x-goog-api-key': apiKey ?? '',
      ...aiGatewayHeaders(gateway),
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: combinedPrompt }] }],
      generationConfig,
    }),
    signal,
    transport,
  })) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((part) => part.text ?? '')
    .join('')
    .trim();
  if (text.length === 0) {
    throw new Error('Gemini response did not contain any text content.');
  }
  return {
    text,
    promptTokens: toTokenCount(data.usageMetadata?.promptTokenCount),
    completionTokens: toTokenCount(data.usageMetadata?.candidatesTokenCount),
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<no response body>';
  }
}

// ---------------------------------------------------------------------------
// Provider error redaction (design 2026-08-10-per-user-provider-keys §1.3)
// ---------------------------------------------------------------------------

/**
 * Maximum number of provider error-body characters kept in a thrown error.
 * The message ends up in `JobFailureDetails.message` → D1 `details.failure`,
 * which is read back over an unauthenticated route, so the body is a liability
 * rather than an asset: status code + request-id carry the diagnostic value.
 */
const PROVIDER_ERROR_BODY_LIMIT = 200;

/**
 * Mask every provider-credential pattern inside a single string.
 *
 * Under BYOK a 401/403 is a routine path, and the OpenAI 401 body echoes the
 * offending key ("Incorrect API key provided: sk-proj-...") — without masking,
 * a user's own key prefix and organization id would be published.
 *
 * The rules themselves live in newscast-core (which this package
 * already depends on) so the logger, the worker's persisted failure record and
 * this package all mask with ONE table; the historical name is kept as the
 * package's public alias.
 */
export { redactSecrets as redactProviderText };

/**
 * The provider request id, when the response carries one.
 *
 * request-id identifies this exact request to provider support — essential for
 * escalating the intermittent Anthropic 403 "Request not allowed" rejections,
 * which reproduce with identical key/model/content and are path-dependent.
 * OpenAI and xAI use `x-request-id` for the same purpose.
 */
function providerRequestIDNote(response: Response): string {
  const requestID = response.headers.get('request-id') ?? response.headers.get('x-request-id');
  return requestID !== null ? ` [request-id: ${requestID}]` : '';
}

/**
 * Turn a failed provider body into a message-safe fragment: keys masked first (so
 * a mid-key cut cannot leave a usable prefix), whitespace collapsed, then
 * truncated to PROVIDER_ERROR_BODY_LIMIT characters. Shared by both call paths —
 * a body relayed through the key vault is exactly as likely to quote a key as one
 * read straight off a `Response`.
 */
function redactedErrorFragment(rawBody: string): string {
  const collapsed = redactSecrets(rawBody).replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return '<empty response body>';
  }
  return truncateText(collapsed, PROVIDER_ERROR_BODY_LIMIT);
}

/** {@link redactedErrorFragment} over a failed `Response` (the direct path). */
async function readRedactedErrorBody(response: Response): Promise<string> {
  return redactedErrorFragment(await safeReadText(response));
}

// ---------------------------------------------------------------------------
// Robust response parsing
// ---------------------------------------------------------------------------

/**
 * Parse a model response into a clean `ScriptLine[]`.
 *
 * Strategy, in order:
 * 1. Strip any markdown code fences, then try `JSON.parse` on the whole text
 *    and on the first embedded array/object substring.
 *    Accepts a bare array, `{ lines: [...] }`, or the first array-valued field.
 * 2. Fall back to speaker-tagged plaintext lines
 *    (e.g. "진행자1: ...", "Speaker 2 - ...", "1: ...").
 *
 * Every candidate line is validated: `speaker` must resolve to 1 or 2 and
 * `text` must be a non-empty string. Invalid entries are dropped.
 */
export function parseScriptLines(rawText: string): ScriptLine[] {
  const cleaned = stripCodeFences(rawText);

  const candidates: string[] = [cleaned];
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (arrayMatch) {
    candidates.push(arrayMatch[0]);
  }
  if (objectMatch) {
    candidates.push(objectMatch[0]);
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const rawLines = extractLinesFromJson(parsed);
    if (rawLines === null) {
      continue;
    }
    const lines = rawLines
      .map(normalizeLine)
      .filter((line): line is ScriptLine => line !== null);
    if (lines.length > 0) {
      return lines;
    }
  }

  // The whole-text / first-array / first-object JSON parses all failed. The most
  // common cause is a TRUNCATED response (the model hit its output-token cap and
  // was cut off mid-JSON, so the array/object never closes — see max_tokens). Try
  // to salvage every COMPLETE `{ speaker, text }` object that was emitted before
  // the cut, so a near-complete script degrades to a slightly shorter one instead
  // of failing the whole job. Only reached when strict parsing yielded nothing.
  const salvaged = salvageLineObjects(cleaned)
    .map(normalizeLine)
    .filter((line): line is ScriptLine => line !== null);
  if (salvaged.length > 0) {
    return salvaged;
  }

  return parseTaggedLines(cleaned);
}

/**
 * Recover complete top-level objects from the first JSON array in `text`, even
 * when that array is never closed (a truncated response). Scans character by
 * character, honoring string/escape state so braces inside string values don't
 * throw off the depth count, and `JSON.parse`s each fully-closed `{...}` object.
 * A trailing object that was cut off mid-write is simply never closed and thus
 * dropped. Returns the parsed objects in order (empty if there is no array).
 */
function salvageLineObjects(text: string): unknown[] {
  const arrayStart = text.indexOf('[');
  if (arrayStart === -1) {
    return [];
  }
  const objects: unknown[] = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;
  for (let index = arrayStart + 1; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      if (depth === 0) {
        objectStart = index;
      }
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        try {
          objects.push(JSON.parse(text.slice(objectStart, index + 1)));
        } catch {
          // A malformed complete-looking object is skipped, not fatal.
        }
        objectStart = -1;
      }
    } else if (character === ']' && depth === 0) {
      break; // The array closed cleanly — nothing left to salvage.
    }
  }
  return objects;
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

function extractLinesFromJson(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const named = record.lines ?? record.script ?? record.dialogue;
    if (Array.isArray(named)) {
      return named;
    }
    for (const key of Object.keys(record)) {
      const candidate = record[key];
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function normalizeLine(entry: unknown): ScriptLine | null {
  if (entry === null || typeof entry !== 'object') {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const speaker = toSpeakerId(record.speaker ?? record.host ?? record.role);
  if (speaker === null) {
    return null;
  }
  const textValue = record.text ?? record.line ?? record.content ?? record.dialogue;
  if (typeof textValue !== 'string') {
    return null;
  }
  const text = textValue.trim();
  if (text.length === 0) {
    return null;
  }
  return { speaker, text };
}

function toSpeakerId(raw: unknown): SpeakerId | null {
  if (raw === 1 || raw === 2) {
    return raw;
  }
  if (typeof raw === 'string') {
    const digit = raw.match(/[12]/);
    if (digit !== null) {
      return Number(digit[0]) as SpeakerId;
    }
  }
  return null;
}

/**
 * Fallback parser for when the model ignored the JSON instruction and emitted
 * speaker-tagged plaintext lines. Recognizes an optional prefix
 * (진행자 / 호스트 / host / speaker / 화자) followed by 1 or 2 and a separator.
 */
function parseTaggedLines(text: string): ScriptLine[] {
  const pattern =
    /^\s*[[(]?\s*(?:진행자|호스트|화자|host|speaker)?\s*([12])\s*[\])]?\s*[:：.\-–]\s*(.+)$/i;
  const result: ScriptLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = rawLine.match(pattern);
    if (match === null) {
      continue;
    }
    const speaker = Number(match[1]) as SpeakerId;
    const lineText = match[2].trim();
    if (lineText.length === 0) {
      continue;
    }
    result.push({ speaker, text: lineText });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Organized-unit parsing (design §4) — sibling of parseScriptLines
// ---------------------------------------------------------------------------

/** The five valid unit kinds; anything else is coerced to 'context'. */
const ORGANIZED_UNIT_KINDS: readonly OrganizedUnit['kind'][] = [
  'fact',
  'argument',
  'example',
  'reaction',
  'context',
];
/** Clamp bounds mirroring the organize prompt's stated caps (design §4). */
const MAXIMUM_ORGANIZED_UNITS = 24;
const MAXIMUM_UNIT_HEADLINE_LENGTH = 60;
const MAXIMUM_UNIT_DETAIL_LENGTH = 240;
const MAXIMUM_UNIT_QUOTES = 2;
const MAXIMUM_UNIT_QUOTE_LENGTH = 100;
const MINIMUM_UNIT_WEIGHT = 1;
const MAXIMUM_UNIT_WEIGHT = 5;
/** Weight used when the model omitted/garbled it — the middle of the 1..5 band. */
const DEFAULT_UNIT_WEIGHT = 3;

/**
 * Parse a model response into a clean `OrganizedUnit[]` — the organize-stage
 * sibling of {@link parseScriptLines}, equally tolerant (design §4).
 *
 * Strategy: strip any markdown code fences, then try `JSON.parse` on the whole
 * text and on the first embedded object/array substring. Accepts `{ units: [...] }`,
 * a bare array, or the first array-valued field. Every candidate unit is clamped to
 * the §4 caps (headline/detail/quote lengths, ≤ 2 quotes, weight into 1..5) and an
 * unknown `kind` degrades to 'context'; a unit with no usable headline is dropped.
 * The whole list is capped at {@link MAXIMUM_ORGANIZED_UNITS}. Returns `[]` when no
 * unit can be recovered (the caller treats that as an organization failure).
 */
export function parseOrganizedUnits(rawText: string): OrganizedUnit[] {
  const cleaned = stripCodeFences(rawText);

  const candidates: string[] = [cleaned];
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  // Object first: the contract shape is `{ "units": [...] }`, so a whole-text parse
  // that fails (leading prose, trailing junk) is most often salvaged by the object.
  if (objectMatch) {
    candidates.push(objectMatch[0]);
  }
  if (arrayMatch) {
    candidates.push(arrayMatch[0]);
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const rawUnits = extractUnitsFromJson(parsed);
    if (rawUnits === null) {
      continue;
    }
    const units = rawUnits
      .map(normalizeUnit)
      .filter((unit): unit is OrganizedUnit => unit !== null);
    if (units.length > 0) {
      return units.slice(0, MAXIMUM_ORGANIZED_UNITS);
    }
  }

  return [];
}

/** Pull the units array out of a parsed value: bare array, `.units`, or first array field. */
function extractUnitsFromJson(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.units)) {
      return record.units;
    }
    for (const key of Object.keys(record)) {
      const candidate = record[key];
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Validate + clamp one raw unit into an {@link OrganizedUnit}, or `null` when it
 * has no usable headline (a headline-less unit is not speakable, mirroring how
 * {@link normalizeLine} drops a line with no text). All lengths/counts/weight are
 * clamped to the §4 caps; an unrecognized `kind` becomes 'context'.
 */
function normalizeUnit(entry: unknown): OrganizedUnit | null {
  if (entry === null || typeof entry !== 'object') {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const headline = typeof record.headline === 'string' ? record.headline.trim() : '';
  if (headline.length === 0) {
    return null;
  }
  const detail = typeof record.detail === 'string' ? record.detail.trim() : '';
  const unit: OrganizedUnit = {
    kind: normalizeUnitKind(record.kind),
    headline: clampText(headline, MAXIMUM_UNIT_HEADLINE_LENGTH),
    detail: clampText(detail, MAXIMUM_UNIT_DETAIL_LENGTH),
    weight: normalizeUnitWeight(record.weight),
  };
  const quotes = normalizeUnitQuotes(record.quotes);
  if (quotes !== undefined) {
    unit.quotes = quotes;
  }
  return unit;
}

/** Hard-truncate `text` to `maxLength` chars (no elision marker — this is data, not prompt). */
function clampText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

/** Coerce `raw` to a known unit kind, defaulting to 'context' for anything unrecognized. */
function normalizeUnitKind(raw: unknown): OrganizedUnit['kind'] {
  return typeof raw === 'string' && (ORGANIZED_UNIT_KINDS as readonly string[]).includes(raw)
    ? (raw as OrganizedUnit['kind'])
    : 'context';
}

/** Coerce `raw` to an integer weight clamped into 1..5, defaulting when unusable. */
function normalizeUnitWeight(raw: unknown): number {
  const numeric =
    typeof raw === 'number' && Number.isFinite(raw)
      ? raw
      : typeof raw === 'string'
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return DEFAULT_UNIT_WEIGHT;
  }
  return clamp(Math.round(numeric), MINIMUM_UNIT_WEIGHT, MAXIMUM_UNIT_WEIGHT);
}

/**
 * Normalize the `quotes` field: keep up to {@link MAXIMUM_UNIT_QUOTES} non-empty
 * string quotes, each clamped to {@link MAXIMUM_UNIT_QUOTE_LENGTH}. Returns
 * `undefined` (not `[]`) when there is nothing to keep, so the optional field is
 * simply omitted.
 */
function normalizeUnitQuotes(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const quotes: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      continue;
    }
    quotes.push(clampText(trimmed, MAXIMUM_UNIT_QUOTE_LENGTH));
    if (quotes.length >= MAXIMUM_UNIT_QUOTES) {
      break;
    }
  }
  return quotes.length > 0 ? quotes : undefined;
}
