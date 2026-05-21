const AUTO_MODE_HEADER = `你正在全自动模式下工作。请注意，你无需输出大段文本内容，因为全自动模式根本没有人阅读。
`;

const SIZE_TABLE = `- **S** — 简单任务，单文件修改，直截了当的操作
- **M** — 中等任务，需要代码评审，但不需要并行开发
- **L** — 大型任务，需要代码评审，并行开发加速`;

const PLAN_REVIEW_CRITERIA = `# 评估标准

1. 计划是否周全、清晰、可行、合理？
2. 评审要求是否合理？
3. 是否存在设计缺陷，数学缺陷，逻辑矛盾，架构问题或没有遵循最佳实践？
4. 用户体验方面，用户/调用方能正确自然地使用吗？接口是否晦涩？是否优雅？
5. 是否完整满足需求？是否偷工减料？是否以初步完成为借口逃避工作？`;

const EXEC_REVIEW_CRITERIA = `# 评估标准

1. 程序实现是否充分利用了语言特性？是否使用了正确的算法和数据结构？
2. 程序结构是否综合运用高阶函数等等大师级别的方法，去除冗余，体现优雅？
3. 是否杜绝了超大文件，超长函数，大泥球架构，面条代码？
4. 是否有必要的单元测试？是否需要合理的集成测试？
5. 是否存在设计缺陷，数学缺陷，逻辑矛盾，架构问题或没有遵循最佳实践？
6. 用户体验方面，用户/调用方能正确自然地使用吗？接口是否晦涩？是否优雅？
7. 是否完整满足需求？是否偷工减料？是否以初步完成为借口逃避工作？`;

const REVIEW_VERDICT = `# 提交裁定

squad_review({ "feedbackMarkdown": null })  // 表示评审通过
squad_review({ "feedbackMarkdown": "具体的修改意见" })  // 拒绝`;

const AFFECTED_FILES_SUBMISSION = `# 提交报告

squad_node_exec({
  "reportMarkdown": "[所做工作的详细记录]",
  "affectedFiles": [
    "/absolute/path/to/file1", 
    "/absolute/path/to/file2"  // ...
  ]
})`;

const PLAN_TEMPLATE_INSTRUCTION = `# 计划模板

**问题背景**

[要解决什么问题？上下文和动机。]

**最终目标**

[执行完成后的期望状态是什么？可衡量的产出。]

**工作方法**

[使用什么工具链？使用什么方法论？]

**参考材料**

[涉及的关键文件、API、文档或参考资料。]

**注意事项**

[经验教训、风险、约束条件。]

**评审要求**

[可量化的验收标准。]`;

export function renderGlobalPlanPrompt(intent: string): string {
  return `${AUTO_MODE_HEADER}请分析并制定完美的计划。

# 用户意图

${intent}

# 任务规模

${SIZE_TABLE}

${PLAN_TEMPLATE_INSTRUCTION}

# 提交计划

squad_global_plan({"size": "S"|"M"|"L", "planMarkdown": "..."})`;
}

export function renderGlobalReviewPrompt(
  intent: string,
  size: string,
  planMarkdown: string,
): string {
  return `${AUTO_MODE_HEADER}请对以下全局计划进行严苛的评审。

${PLAN_REVIEW_CRITERIA}
6. 选择的规模是否合适？

# 用户意图

${intent}

# 计划草稿

${planMarkdown}

# 任务规模 (已选择 ${size})

${SIZE_TABLE}

${REVIEW_VERDICT}`;
}

export function renderDagDesignPrompt(planMarkdown: string): string {
  return `${AUTO_MODE_HEADER}基于以下计划设计一个 DAG，描述高度并行的工作流。

# 计划内容

${planMarkdown}

# 设计准则

- 每个节点应足够独立以支持细粒度并行执行
- 节点之间的依赖关系不能形成环路
- 我们将在所有父节点完成后立即执行子节点

# 提交 DAG

squad_dag_design({
  "nodes": [
    { "name": "node-1" }, 
    { "name": "node-2" },
    { "name": "node-3" },
    { "name": "node-4" }  // ...
  ],
  "edges": [
    { "parent": "node-1", "child": "node-3" },
    { "parent": "node-1", "child": "node-4" },
    { "parent": "node-2", "child": "node-3" },
    { "parent": "node-2", "child": "node-4" }  // ...
  ]
})`;
}

export function renderNodePlanPrompt(
  nodeName: string,
  planMarkdown: string,
  nodes: Array<{ name: string }>,
  edges: Array<{ child: string; parent: string }>,
): string {
  const nodeList = nodes.map((n) => `- ${n.name}`).join('\n');
  const edgeList = edges.map((e) => `- ${e.parent} → ${e.child}`).join('\n');

  return `${AUTO_MODE_HEADER}你所在的节点是 ${nodeName}，请根据以下全局计划，制定完美的本节点计划。

# 全局计划

${planMarkdown}

# 节点列表

${nodeList}

# 依赖关系

${edgeList}

${PLAN_TEMPLATE_INSTRUCTION}

# 如何提交

squad_node_plan({ "planMarkdown": "..." })`;
}

export function renderNodePlanReviewPrompt(
  nodeName: string,
  nodePlan: string,
  planMarkdown: string,
  nodes: Array<{ name: string }>,
  edges: Array<{ child: string; parent: string }>,
): string {
  const nodeList = nodes.map((n) => `- ${n.name}`).join('\n');
  const edgeList = edges.map((e) => `- ${e.parent} → ${e.child}`).join('\n');

  return `${AUTO_MODE_HEADER}请根据全局计划，对节点 ${nodeName} 的计划进行严苛的评审。

${PLAN_REVIEW_CRITERIA}

# 全局计划

${planMarkdown}

# 节点列表

${nodeList}

# 依赖关系

${edgeList}

# 节点计划

${nodePlan}

${REVIEW_VERDICT}`;
}

export function renderNodeExecPrompt(
  nodeName: string,
  nodePlan: string,
): string {
  return `${AUTO_MODE_HEADER}你需要作为并发的一员，执行全局工作流中的 ${nodeName} 节点。

# 节点计划

${nodePlan}

${AFFECTED_FILES_SUBMISSION}`;
}

export function renderNodeExecReviewPrompt(
  nodeName: string,
  nodePlan: string,
  reportMarkdown: string,
  fileContentsContext: string,
): string {
  return `${AUTO_MODE_HEADER}你需要严苛地评审全局工作流中的 ${nodeName} 节点的执行过程。

${EXEC_REVIEW_CRITERIA}

# 节点计划

${nodePlan}

# 执行报告

${reportMarkdown}

# 待评审文件

${fileContentsContext}

请根据执行报告和上述被修改的文件路径，按需读取并检查对应文件的内容以进行评审。

${REVIEW_VERDICT}`;
}

export function renderExecReviewPrompt(
  planMarkdown: string,
  reportMarkdown: string,
  fileContentsContext: string,
): string {
  return `${AUTO_MODE_HEADER}你需要严苛地评审计划的执行过程。

${EXEC_REVIEW_CRITERIA}

# 计划内容

${planMarkdown}

# 执行报告

${reportMarkdown}

# 待评审文件

${fileContentsContext}

请根据执行报告和上述被修改的文件路径，按需读取并检查对应文件的内容以进行评审。

${REVIEW_VERDICT}`;
}

export function renderExecPrompt(planMarkdown: string): string {
  return `${AUTO_MODE_HEADER}你需要执行计划并接受评审。

# 计划内容

${planMarkdown}

${AFFECTED_FILES_SUBMISSION}`;
}

export function renderPlanRejectionFeedback(feedbackMarkdown: string): string {
  return `你制定的计划在执行前被评审拒绝。请重新制定更完善的计划。\n\n# 评审反馈\n\n${feedbackMarkdown}`;
}

export function renderExecRejectionFeedback(feedbackMarkdown: string): string {
  return `你制定的计划执行后，评审拒绝结束整个任务。请以现在的状态为基准，重新制定走向最终目标的计划。\n\n# 执行评审反馈\n\n${feedbackMarkdown}`;
}

export function renderEndReviewPrompt(
  planMarkdown: string,
  nodeReports: Array<{
    name: string;
    reportMarkdown: string;
    affectedFiles: string[];
  }>,
  fileContentsContext: string,
): string {
  const nodesSummary = nodeReports
    .map(
      (n) => `## 节点 ${n.name}

${n.reportMarkdown}`,
    )
    .join('\n\n');

  return `${AUTO_MODE_HEADER}你需要对整个计划的最终执行结果做严苛的评审。

${EXEC_REVIEW_CRITERIA}

# 原始计划

${planMarkdown}

# 节点执行

${nodesSummary}

# 待评审文件

${fileContentsContext}

请根据执行报告和上述被修改的文件路径，按需读取并检查对应文件的内容以进行评审。

${REVIEW_VERDICT}`;
}
