/**
 * Embedding endpoint configuration.
 *
 * "Which embedding model" is a property of the user's account, not of this
 * plugin, so the endpoint is configurable instead of hardcoded: the default
 * reuses a Volcengine coding-plan key, but any OpenAI-compatible
 * `POST {baseUrl}/embeddings` endpoint works the same way.
 *
 * The API key itself is deliberately NOT part of this config — only the *name*
 * of the environment variable (or `$DSH_HOME/.credentials.yaml` ref) that holds
 * it. That keeps a plaintext secret out of `dsh-goal-ledger/config.json`.
 */

export const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3'
export const DEFAULT_MODEL = 'doubao-embedding-vision'
export const DEFAULT_KEY_ENV = 'VOLCENGINE_CODING_PLAN_API_KEY'
export const DEFAULT_BATCH_SIZE = 4
/** Provider cap shared by the OpenAI-compatible batch endpoints. */
export const MAX_BATCH = 10

export const PRESETS = [
  {
    id: 'volcengine',
    label: '火山方舟（coding plan）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    model: 'doubao-embedding-vision',
    keyEnv: 'VOLCENGINE_CODING_PLAN_API_KEY'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'text-embedding-3-small',
    keyEnv: 'OPENAI_API_KEY'
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'BAAI/bge-m3',
    keyEnv: 'SILICONFLOW_API_KEY'
  },
  {
    id: 'dashscope',
    label: '阿里百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'text-embedding-v3',
    keyEnv: 'DASHSCOPE_API_KEY'
  },
  {
    id: 'custom',
    label: '自定义（任意 OpenAI 兼容端点）',
    baseUrl: '',
    model: '',
    keyEnv: ''
  }
]

export const DEFAULT_CONFIG = {
  enabled: true,
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  keyEnv: DEFAULT_KEY_ENV,
  batchSize: DEFAULT_BATCH_SIZE
}

const URL_RE = /^https?:\/\/[^\s]+$/i
const KEY_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,80}$/

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Apply a partial patch on top of a known-good config.
 *
 * Every provided field is validated; invalid ones are reported and the previous
 * value is kept. Unknown keys are ignored rather than copied through, so a
 * hand-edited config file cannot smuggle arbitrary data into the snapshot.
 *
 * @param {object} current - the config to start from
 * @param {object} patch   - fields to change
 * @returns {{ config: object, errors: string[] }}
 */
export function applyConfigPatch(current, patch) {
  const base = { ...DEFAULT_CONFIG, ...(current ?? {}) }
  const next = {
    enabled: base.enabled !== false,
    baseUrl: trimmed(base.baseUrl) || DEFAULT_BASE_URL,
    model: trimmed(base.model) || DEFAULT_MODEL,
    keyEnv: trimmed(base.keyEnv) || DEFAULT_KEY_ENV,
    batchSize: Number.isInteger(base.batchSize) ? base.batchSize : DEFAULT_BATCH_SIZE
  }
  const errors = []
  const src = patch && typeof patch === 'object' ? patch : {}

  if ('baseUrl' in src) {
    const v = trimmed(src.baseUrl).replace(/\/+$/, '')
    if (!URL_RE.test(v)) errors.push('baseUrl 必须是 http:// 或 https:// 开头的完整地址')
    else next.baseUrl = v
  }

  if ('model' in src) {
    const v = trimmed(src.model)
    if (!v) errors.push('model 不能为空')
    else if (v.length > 200) errors.push('model 长度不能超过 200')
    else if (/\s/.test(v)) errors.push('model 不能包含空格')
    else next.model = v
  }

  if ('keyEnv' in src) {
    const v = trimmed(src.keyEnv)
    if (!KEY_ENV_RE.test(v)) {
      errors.push('keyEnv 必须是合法的环境变量名（字母/数字/下划线，不能以数字开头）')
    } else next.keyEnv = v
  }

  if ('batchSize' in src) {
    const n = Number(src.batchSize)
    if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH) {
      errors.push(`batchSize 必须是 1..${MAX_BATCH} 的整数`)
    } else next.batchSize = n
  }

  if ('enabled' in src) next.enabled = Boolean(src.enabled)

  return { config: next, errors }
}

/**
 * Read a config file defensively: never throw, always return a usable config.
 * Invalid values fall back to their defaults and are reported as warnings.
 */
export function normalizeConfig(raw) {
  const { config, errors } = applyConfigPatch(DEFAULT_CONFIG, raw && typeof raw === 'object' ? raw : {})
  return { config, warnings: errors }
}

/** Preset lookup; unknown ids return undefined. */
export function presetById(id) {
  return PRESETS.find(p => p.id === id)
}
