import { appendFile, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { getClaudeConfigHomeDir } from './envUtils.js'

type TraceState = {
  active: boolean
  sessionId: string
  filePath: string
  sequence: number
}

let state: TraceState | null = null
let appendQueue: Promise<void> = Promise.resolve()

function getTraceFilePath(sessionId: string): string {
  return join(getClaudeConfigHomeDir(), 'trace', sessionId, '001.jsonl')
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString()
  }
  if (typeof value === 'function') {
    return '[Function]'
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }
  return value
}

function safeJsonLine(value: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (key, nestedValue) => {
    if (nestedValue && typeof nestedValue === 'object') {
      if (seen.has(nestedValue)) {
        return '[Circular]'
      }
      seen.add(nestedValue)
    }
    return jsonReplacer(key, nestedValue)
  }) ?? 'null'
}

async function prepareAIRequestTrace(): Promise<{ filePath: string }> {
  const sessionId = getSessionId()
  const filePath = getTraceFilePath(sessionId)
  await mkdir(join(getClaudeConfigHomeDir(), 'trace', sessionId), {
    recursive: true,
  })
  await writeFile(filePath, '', 'utf8')
  state = {
    active: true,
    sessionId,
    filePath,
    sequence: 0,
  }
  appendQueue = Promise.resolve()
  return { filePath }
}

export async function startAIRequestTrace(): Promise<{ filePath: string }> {
  return prepareAIRequestTrace()
}

export function stopAIRequestTrace(): void {
  if (state?.active) {
    state = null
  }
}

export function isAIRequestTraceActive(): boolean {
  return state?.active === true
}

export function getAIRequestTracePath(): string | null {
  return state?.filePath ?? null
}

export function recordAIRequestTrace(details: {
  querySource?: string
  attempt: number
  model: string
  clientRequestId?: string
  previousRequestId?: string
  isStreaming: boolean
  params: unknown
}): void {
  if (!state) return

  try {
    const current = state
    if (!current.active) return
    current.sequence += 1
    const entry = {
      type: 'ai_request',
      sequence: current.sequence,
      timestamp: new Date().toISOString(),
      session_id: current.sessionId,
      query_source: details.querySource,
      attempt: details.attempt,
      model: details.model,
      client_request_id: details.clientRequestId,
      previous_request_id: details.previousRequestId,
      is_streaming: details.isStreaming,
      request: details.params,
    }

    const line = `${safeJsonLine(entry)}\n`
    appendQueue = appendQueue
      .then(() => appendFile(current.filePath, line, 'utf8'))
      .catch(() => {
        // Tracing must never break the main AI request path.
      })
  } catch {
    // Tracing must never break the main AI request path.
  }
}
