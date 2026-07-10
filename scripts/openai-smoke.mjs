if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required for npm run test:openai:smoke');
  process.exit(1);
}
const { Agent, run } = await import('@openai/agents');
const schema = { type: 'object', required: ['ok', 'summary'], additionalProperties: false, properties: { ok: { type: 'boolean' }, summary: { type: 'string' } } };
const agent = new Agent({
  name: 'cms_agent_smoke',
  instructions: 'Return only JSON matching the schema. Do not use tools.',
  model: process.env.OPENAI_AGENT_MODEL || 'gpt-5.5-mini',
  outputType: { type: 'json_schema', name: 'smoke_output', strict: true, schema }
});
const result = await run(agent, 'Return {"ok":true,"summary":"smoke test passed"}.', { tracingDisabled: true, traceIncludeSensitiveData: false });
console.log(JSON.stringify({ output: result.finalOutput, usage: result.rawResponses?.map((r) => r.usage ?? null) ?? [] }, null, 2));
