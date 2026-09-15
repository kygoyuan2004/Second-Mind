import path from 'node:path';

export const KNOWLEDGE_SEARCH_TOOL = 'mcp__knowledge__KnowledgeSearch';

const CHILD_BASE_TOOLS = Object.freeze(['Read', 'Glob', 'Grep']);
const CHILD_DENIED_TOOLS = Object.freeze([
  'Agent', 'Task', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebSearch', 'WebFetch',
  'Skill', 'TodoWrite', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion',
  'mcp__tavily__tavily_search', 'mcp__tavily__tavily_extract',
]);

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function candidatePath(root, value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (value.includes('\0')) return value;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').includes('..')) return value;
  if (!path.isAbsolute(value)) return null;
  return isInside(root, path.resolve(value)) ? null : value;
}

function pathViolation(root, input = {}) {
  for (const key of ['path', 'file_path', 'directory', 'cwd']) {
    const invalid = candidatePath(root, input?.[key]);
    if (invalid) return invalid;
  }
  const pattern = String(input?.pattern || '');
  if (
    pattern.includes('\0') ||
    pattern.replaceAll('\\', '/').split('/').includes('..') ||
    candidatePath(root, pattern)
  ) return pattern;
  return null;
}

export function isSubagentEligible(promptInput) {
  const prompt = String(promptInput || '').trim();
  if (!prompt) return false;
  if (
    /(?:全面|完整|彻底)(?:审计|核查|检查|复盘)|(?:全库|所有文件|全部文件)(?:比较|对比|核查|检索|审计)|跨(?:多个|至少两个|不同)(?:目录|文档)/u.test(prompt)
  ) return true;
  const directories = new Set(
    [...prompt.matchAll(/(?:^|\s|[`'"“”])([^\s`'"“”/\\]+)[/\\][^\s`'"“”]+/gu)]
      .map((match) => match[1].toLocaleLowerCase('zh-CN')),
  );
  if (directories.size >= 2) return true;
  const enumeratedThemes = prompt.split(/\r?\n/).filter((line) => (
    /^\s*(?:[-*+]\s+|\d+[.)、]\s*|[一二三四五六七八九十]+[、.．)]\s*)\S/u.test(line)
  ));
  return enumeratedThemes.length >= 3;
}

function decision(permissionDecision, permissionDecisionReason, updatedInput) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason,
      ...(updatedInput ? { updatedInput } : {}),
    },
  };
}

export function subagentDefinitions(surface, root) {
  const knowledge = surface === 'knowledge';
  const tools = knowledge ? [...CHILD_BASE_TOOLS, KNOWLEDGE_SEARCH_TOOL] : [...CHILD_BASE_TOOLS];
  const common = {
    tools,
    disallowedTools: [...CHILD_DENIED_TOOLS],
    permissionMode: 'dontAsk',
    maxTurns: 12,
    background: false,
    skills: [],
  };
  if (knowledge) {
    return {
      'vault-researcher': {
        ...common,
        description: '仅当问题涉及至少三个独立主题、跨多文档或要求全库比较时，用只读检索查找跨文档依据。',
        prompt: [
          '你是知识库只读研究员。',
          `只能读取 ${root} 中的文件，以及调用只读 KnowledgeSearch。`,
          '不得执行命令、写入、联网、请求权限或创建子 Agent。',
          '返回可核验的相对路径、标题和行号，区分事实与推断。',
        ].join('\n'),
      },
      'source-verifier': {
        ...common,
        description: '仅当主任务选取了多文档事实、跨时间结论或要求全面审计时，独立核查文件、事实和引用。',
        prompt: [
          '你是知识库只读来源核查员。',
          `只能读取 ${root} 中的文件，以及调用只读 KnowledgeSearch。`,
          '逐项核查结论是否被原文支持，报告冲突、时间边界、整理版与原文差异。',
          '不得执行命令、写入、联网或创建子 Agent。',
        ].join('\n'),
      },
    };
  }
  return {
    'repo-explorer': {
      ...common,
      description: '仅当任务涉及至少三个独立主题、跨多目录或全库比较时，只读探索跨目录代码与配置。',
      prompt: [
        '你是代码库只读探索员。',
        `只能用 Read/Glob/Grep 读取 ${root} 内容。`,
        '不得执行 Bash、写入、编辑、联网或创建子 Agent。',
        '返回文件路径、关键符号、依赖关系和未确定点。',
      ].join('\n'),
    },
    reviewer: {
      ...common,
      description: '仅当任务要求全面审计或跨多目录结论时，独立检查结论、风险和遗漏。',
      prompt: [
        '你是代码库只读审查员。',
        `只能用 Read/Glob/Grep 读取 ${root} 内容。`,
        '独立验证主 Agent 的结论，优先找正确性、安全性、兼容性和测试缺口。',
        '不得执行 Bash、写入、编辑、联网或创建子 Agent。',
      ].join('\n'),
    },
  };
}

export function createSubagentPolicy(task, options) {
  const surface = options.surface;
  const root = path.resolve(options.root);
  const definitions = subagentDefinitions(surface, root);
  const names = new Set(Object.keys(definitions));
  const childTools = new Set(surface === 'knowledge'
    ? [...CHILD_BASE_TOOLS, KNOWLEDGE_SEARCH_TOOL]
    : [...CHILD_BASE_TOOLS]);
  if (!(task.subagentToolUseIds instanceof Set)) task.subagentToolUseIds = new Set();

  const preToolUse = async (input) => {
    const toolName = String(input?.tool_name || '');
    const toolInput = input?.tool_input && typeof input.tool_input === 'object'
      ? input.tool_input
      : {};
    if (input?.agent_id) {
      if (!childTools.has(toolName)) {
        return decision('deny', '子 Agent 只允许调用指定的只读工具，不能写入、执行命令、联网或继续创建 Agent。');
      }
      const invalidPath = pathViolation(root, toolInput);
      if (invalidPath) return decision('deny', '子 Agent 请求的路径超出只读工作区。');
      return decision('allow', '只读子 Agent 工具通过服务端校验。');
    }
    if (!['Agent', 'Task'].includes(toolName)) return {};
    if (task.taskMode?.id !== 'deep') return decision('deny', '普通任务模式禁止创建子 Agent。');
    if (!isSubagentEligible(task.prompt)) {
      return decision('deny', '当前任务不满足三项独立主题、跨目录、全库比较或全面审计条件。');
    }
    const type = String(toolInput.subagent_type || '');
    if (!names.has(type)) return decision('deny', '子 Agent 类型不在服务端白名单中。');
    const useId = String(input.tool_use_id || '');
    if (!task.subagentToolUseIds.has(useId)) {
      if (task.subagentToolUseIds.size >= task.taskMode.maxSubagents) {
        return decision('deny', '本任务已达到两个只读子 Agent 的上限。');
      }
      task.subagentToolUseIds.add(useId);
    }
    const updatedInput = {
      description: String(toolInput.description || type).slice(0, 100),
      prompt: String(toolInput.prompt || '').slice(0, 20_000),
      subagent_type: type,
      run_in_background: false,
    };
    return decision('allow', '已强制使用前台、只读、一层子 Agent。', updatedInput);
  };

  return {
    definitions,
    toolNames: [...names],
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
    preToolUse,
  };
}

export const subagentPolicyConstants = Object.freeze({
  CHILD_BASE_TOOLS,
  CHILD_DENIED_TOOLS,
});
