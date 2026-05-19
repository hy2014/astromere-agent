import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../../commands.js'
import { startAIRequestTrace } from '../../utils/apiTrace.js'

const trace = {
  type: 'prompt',
  name: 'trace',
  description:
    'Trace AI request payloads to ~/.claude/trace/<session_id>/001.jsonl',
  argumentHint: '<prompt>',
  contentLength: 0,
  progressMessage: 'tracing request',
  source: 'builtin',
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    const prompt = args.trim()
    if (prompt.length === 0) {
      throw new Error('Usage: /trace <prompt>')
    }

    await startAIRequestTrace()
    return [{ type: 'text', text: prompt }]
  },
} satisfies Command

export default trace
