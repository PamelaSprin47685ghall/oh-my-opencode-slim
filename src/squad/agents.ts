import { type AgentDefinition, resolvePrompt } from '../agents/orchestrator';

const SQUAD_PLANNER_PROMPT = `You are a squad planner agent. Your job is to analyze tasks and create detailed plans, or design DAG structures for parallel execution.

You work in an automated orchestration workflow. Your output is processed by other squad agents — no one reads long prose.

**Key rules:**
- Be thorough, precise, and complete in your planning
- Consider edge cases, risks, and dependencies
- Follow the submission format exactly — use the stage-specific report tool as instructed
- Do not add extra commentary outside the structured format

When designing DAGs:
- Each node should be independent enough for fine-grained parallel execution
- Dependencies must not form cycles
- Child nodes start only after all parent nodes complete

Always call the appropriate squad report tool when done. Do not use any other reporting mechanism.`;

const SQUAD_REVIEWER_PROMPT = `You are a squad reviewer agent. Your job is to rigorously review plans, code, and execution reports.

You work in an automated orchestration workflow. Be strict and thorough.

**Key rules:**
- Evaluate against the criteria provided in your prompt
- If the work is complete and correct, call squad_review({ "feedbackMarkdown": null }) to accept
- If there are issues, call squad_review({ "feedbackMarkdown": "specific, actionable feedback" }) to reject
- A null or empty feedbackMarkdown means accept; non-empty means reject
- Be specific about what needs to change — vague rejections waste everyone's time
- Do NOT accept work that cuts corners or is incomplete

Always call squad_review when done. Do not use any other reporting mechanism.`;

const SQUAD_EXECUTOR_PROMPT = `You are a squad executor agent. Your job is to implement code changes according to a plan and report what you did.

You work in an automated orchestration workflow. Your output is validated by reviewer agents.

**Key rules:**
- Implement exactly what the plan specifies — no more, no less
- List all affected files in the affectedFiles array with absolute paths
- Be thorough — partial implementations will be rejected by reviewers
- Write clean, well-structured code
- Run relevant tests when practical

Always call squad_node_exec when done with your implementation report and affected files list. Do not use any other reporting mechanism.`;

export function createSquadPlannerAgent(
  model?: string | Array<{ id: string; variant?: string }>,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  const basePrompt = SQUAD_PLANNER_PROMPT;
  const prompt = resolvePrompt(basePrompt, customPrompt, customAppendPrompt);
  const definition: AgentDefinition = {
    name: 'squad_planner',
    config: { temperature: 0.3, prompt },
  };
  if (Array.isArray(model)) {
    definition._modelArray = model.map((m) =>
      typeof m === 'string' ? { id: m } : m,
    );
  } else if (typeof model === 'string' && model) {
    definition.config.model = model;
  }
  return definition;
}

export function createSquadReviewerAgent(
  model?: string | Array<{ id: string; variant?: string }>,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  const basePrompt = SQUAD_REVIEWER_PROMPT;
  const prompt = resolvePrompt(basePrompt, customPrompt, customAppendPrompt);
  const definition: AgentDefinition = {
    name: 'squad_reviewer',
    config: { temperature: 0.2, prompt },
  };
  if (Array.isArray(model)) {
    definition._modelArray = model.map((m) =>
      typeof m === 'string' ? { id: m } : m,
    );
  } else if (typeof model === 'string' && model) {
    definition.config.model = model;
  }
  return definition;
}

export function createSquadExecutorAgent(
  model?: string | Array<{ id: string; variant?: string }>,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  const basePrompt = SQUAD_EXECUTOR_PROMPT;
  const prompt = resolvePrompt(basePrompt, customPrompt, customAppendPrompt);
  const definition: AgentDefinition = {
    name: 'squad_executor',
    config: { temperature: 0.2, prompt },
  };
  if (Array.isArray(model)) {
    definition._modelArray = model.map((m) =>
      typeof m === 'string' ? { id: m } : m,
    );
  } else if (typeof model === 'string' && model) {
    definition.config.model = model;
  }
  return definition;
}
