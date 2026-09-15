import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { KNOWLEDGE_SEARCH_TOOL } from './subagent-policy.mjs';

export function createKnowledgeSearchServer(store, task, options = {}) {
  return createSdkMcpServer({
    name: 'knowledge',
    version: '1.0.0',
    instructions: '只读检索当前 Obsidian 知识库；返回相对路径、标题层级和行号范围。',
    alwaysLoad: true,
    tools: [
      tool(
        'KnowledgeSearch',
        '用新的检索表达式重新查询知识库。适合复杂追问、同义改写、跨文档核验和“列出全部”。不接受根目录或任务模式参数。',
        {
          query: z.string().min(1).max(500).describe('完整、可独立理解的检索查询'),
          offset: z.number().int().min(0).max(10_000).optional().describe('穷举结果的分页起点'),
          limit: z.number().int().min(1).max(50).optional().describe('本页最多返回条数'),
        },
        async ({ query, offset = 0, limit = 20 }) => {
          try {
            task.abortController.signal.throwIfAborted?.();
            const searchOptions = {
              taskMode: task.taskMode.id,
              allowLongQuery: true,
              signal: task.abortController.signal,
            };
            const result = task.hybridSearchEnabled === false
              ? {
                  route: 'legacy',
                  query,
                  results: await store.search(query, searchOptions),
                  diagnostics: {
                    fallback: 'legacy-scan',
                    embeddingUsed: false,
                    rerankerUsed: false,
                  },
                }
              : await store.hybridSearch(query, searchOptions);
            try {
              await options.onRetrieval?.(result, { query, source: 'agent-search' });
            } catch {}
            const total = result.results.length;
            const items = result.results.slice(offset, offset + limit).map((item) => ({
              path: item.path,
              headings: item.headings || (item.heading ? [item.heading] : []),
              startLine: item.startLine,
              endLine: item.endLine,
              lineNumbers: item.lineNumbers,
              snippet: item.snippet,
              relatedPaths: item.relatedPaths || [],
            }));
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  route: result.route,
                  exhaustive: Boolean(result.exhaustive),
                  complete: Boolean(result.complete),
                  total,
                  offset,
                  nextOffset: offset + items.length < total ? offset + items.length : null,
                  items,
                }),
              }],
            };
          } catch (error) {
            return {
              isError: true,
              content: [{ type: 'text', text: String(error?.message || '知识库检索失败。') }],
            };
          }
        },
        { alwaysLoad: true },
      ),
    ],
  });
}

export { KNOWLEDGE_SEARCH_TOOL };
