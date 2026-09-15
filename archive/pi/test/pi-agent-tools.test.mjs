import assert from 'node:assert/strict';
import test from 'node:test';

import { createPiKnowledgeTools } from '../src/pi-agent-tools.mjs';

function resultValue(result) {
  assert.deepEqual(result.content.map((item) => item.type), ['text']);
  return JSON.parse(result.content[0].text);
}

function named(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert(tool, `Expected ${name} tool`);
  return tool;
}

async function execute(tools, name, params, signal) {
  return resultValue(await named(tools, name).execute('test-call', params, signal, undefined, {}));
}

function fixture(overrides = {}) {
  const texts = new Map([
    ['Diary/2026-09-01.md', 'alpha\nbeta\ngamma\ndelta'],
    ['Learning/Topic.md', '# Topic\nverified detail'],
    ['Root.md', 'root note'],
    ['Learning/Long.md', 'x'.repeat(700)],
  ]);
  const hashes = new Map([...texts.keys()].map((relative, index) => [relative, `hash-${index + 1}`]));
  const calls = { list: 0, search: [], read: [], temporal: [], resolve: [], web: [] };
  const snapshot = {
    generation: 'fixture-generation',
    listDocuments() {
      calls.list += 1;
      return [...texts.entries()].map(([path, text]) => ({
        path, hash: hashes.get(path), size: Buffer.byteLength(text),
      }));
    },
    async search(query, options) {
      calls.search.push({ query, options });
      return {
        route: options.route,
        diagnostics: { effectiveRoute: options.route },
        results: [{
          path: 'Diary/2026-09-01.md',
          name: '2026-09-01.md',
          heading: 'Day',
          lineStart: 2,
          lineEnd: 3,
          content: 'beta gamma',
          score: 0.75,
          matchedTerms: [query],
          relatedPaths: ['Learning/Topic.md', '../outside.md'],
        }, {
          path: '../outside.md', content: 'must not escape the snapshot', score: 1,
        }],
      };
    },
    async readDocument(relative, options) {
      calls.read.push({ relative, options });
      if (!texts.has(relative)) throw Object.assign(new Error('missing'), { code: 'INDEX_DOCUMENT_NOT_FOUND' });
      return { path: relative, hash: hashes.get(relative), text: texts.get(relative) };
    },
    async temporalInventory(query, options) {
      calls.temporal.push({ query, options });
      return {
        route: 'mtime-inventory',
        results: [{
          path: 'Diary/2026-09-01.md', content: 'beta', lineStart: 2, lineEnd: 2,
          mtimeMs: Date.parse('2026-09-01T08:00:00.000Z'),
          logicalKey: 'diary/2026-09-01.md', relatedPaths: [],
        }, {
          path: 'Root.md', content: 'outside requested range',
          mtimeMs: Date.parse('2026-08-01T08:00:00.000Z'),
        }, {
          path: '../outside.md', content: 'outside snapshot',
          mtimeMs: Date.parse('2026-09-01T09:00:00.000Z'),
        }],
        inventory: {
          scopeApplied: true,
          totalIndexedFiles: 4,
          inRangePhysicalFiles: 2,
          logicalFilesInRange: 2,
          invalidMtimeFiles: 1,
          metadataComplete: false,
          truncated: true,
          generation: 'fixture-generation',
        },
      };
    },
  };
  const store = {
    async resolveSource(reference) {
      calls.resolve.push(reference);
      if (reference === 'Topic') return { path: 'Learning/Topic.md' };
      if (reference === 'Shared') return { candidates: ['Diary/2026-09-01.md', 'Learning/Topic.md'] };
      throw Object.assign(new Error('not found'), { status: 404, code: 'SOURCE_NOT_FOUND' });
    },
    async readText() {
      throw new Error('Tools must never use the store or filesystem to read note text.');
    },
  };
  return {
    texts,
    hashes,
    calls,
    snapshot: { ...snapshot, ...(overrides.snapshot || {}) },
    store: { ...store, ...(overrides.store || {}) },
  };
}

test('factory exposes only bounded read-only knowledge tools and gates web access', () => {
  const value = fixture();
  const disabled = createPiKnowledgeTools({
    indexSnapshot: value.snapshot,
    store: value.store,
    webEnabled: false,
    webSearchClient: { searchMany: async () => assert.fail('web must stay disabled') },
  });
  assert.deepEqual(disabled.tools.map((tool) => tool.name), [
    'list_vault',
    'search_text',
    'search_knowledge',
    'read_note',
    'resolve_note_reference',
    'list_date_records',
    'get_reading_coverage',
  ]);
  assert.equal(disabled.tools.some((tool) => /bash|shell|write|edit/iu.test(tool.name)), false);
  assert.equal(typeof disabled.getLedger, 'function');

  const review = createPiKnowledgeTools({
    indexSnapshot: value.snapshot,
    store: value.store,
    webEnabled: true,
    learningReview: true,
    webSearchClient: { searchMany: async () => assert.fail('personal review must stay offline') },
  });
  assert.equal(review.tools.some((tool) => tool.name === 'web_search'), false);
  const structuredReview = createPiKnowledgeTools({
    indexSnapshot: value.snapshot,
    store: value.store,
    webEnabled: true,
    learningReview: {
      scope: 'all',
      range: {
        startInclusive: '2026-09-01T00:00:00Z',
        endExclusive: '2026-09-02T00:00:00Z',
        timeZone: 'Asia/Shanghai',
      },
    },
    webSearchClient: { searchMany: async () => assert.fail('structured review must stay offline') },
  });
  assert.equal(structuredReview.tools.some((tool) => tool.name === 'web_search'), false);
});

test('list and search use only the pinned index and record discovery separately from reading', async () => {
  const value = fixture();
  const events = [];
  const created = createPiKnowledgeTools({
    indexSnapshot: value.snapshot,
    store: value.store,
    emit: (type, data) => events.push({ type, data }),
  });

  const root = await execute(created.tools, 'list_vault', { limit: 2 });
  assert.deepEqual(root.entries, [
    { type: 'directory', path: 'Diary' },
    { type: 'directory', path: 'Learning' },
  ]);
  assert.equal(root.nextOffset, 2);
  const recursive = await execute(created.tools, 'list_vault', {
    path: 'Learning', recursive: true, limit: 10,
  });
  assert.deepEqual(recursive.entries.map((item) => item.path), [
    'Learning/Long.md', 'Learning/Topic.md',
  ]);

  const keyword = await execute(created.tools, 'search_text', { keyword: 'beta', limit: 4 });
  assert.equal(keyword.effectiveRoute, 'keyword');
  assert.deepEqual(keyword.results.map((item) => item.path), ['Diary/2026-09-01.md']);
  assert.deepEqual(value.calls.search[0].options.route, 'keyword');
  assert.equal(value.calls.search[0].options.limit, 4);
  assert.equal('text' in value.calls.search[0], false);

  const semantic = await execute(created.tools, 'search_knowledge', {
    query: 'meaning', route: 'semantic', limit: 3,
  });
  assert.equal(semantic.requestedRoute, 'semantic');
  assert.equal(value.calls.search[1].options.route, 'semantic');
  const ledger = created.getLedger();
  assert.deepEqual(ledger.discoveries.map((item) => item.path), [
    'Diary/2026-09-01.md', 'Learning/Long.md', 'Learning/Topic.md',
  ]);
  assert.deepEqual(ledger.reads, []);
  assert.equal(ledger.complete, false);
  assert(ledger.uncovered.some((item) => item.reason === 'list_vault_pagination_incomplete'));
  assert(ledger.uncovered.filter((item) => item.path).every((item) => item.reason === 'not_read'));
  assert(events.some((event) => (
    event.type === 'activity' && event.data.toolName === 'search_text' && event.data.stage === 'complete'
  )));
});

test('list_vault ledger remains incomplete until every bounded page is exposed', async () => {
  const value = fixture();
  const created = createPiKnowledgeTools({ indexSnapshot: value.snapshot, store: value.store });
  const first = await execute(created.tools, 'list_vault', { limit: 1 });
  assert.equal(first.nextOffset, 1);
  let listing = created.getLedger().listings[0];
  assert.deepEqual(listing.coveredOffsets, [[0, 0]]);
  assert.deepEqual(listing.uncoveredOffsets, [[1, 2]]);
  assert.equal(listing.complete, false);

  const second = await execute(created.tools, 'list_vault', {
    offset: first.nextOffset, limit: 2,
  });
  assert.equal(second.nextOffset, null);
  listing = created.getLedger().listings[0];
  assert.deepEqual(listing.coveredOffsets, [[0, 2]]);
  assert.deepEqual(listing.uncoveredOffsets, []);
  assert.equal(listing.complete, true);
  assert.equal(created.getLedger().uncovered.some((item) => (
    item.reason === 'list_vault_pagination_incomplete'
  )), false);
});

test('read_note uses hash-checked snapshot reads, paginates, and merges actual line coverage', async () => {
  const value = fixture();
  const created = createPiKnowledgeTools({ indexSnapshot: value.snapshot, store: value.store });
  await execute(created.tools, 'search_text', { keyword: 'beta' });

  const middle = await execute(created.tools, 'read_note', {
    path: 'Diary/2026-09-01.md', startLine: 2, maxLines: 1,
  });
  assert.deepEqual(middle.lines.map((line) => [line.number, line.text]), [[2, 'beta']]);
  assert.deepEqual(middle.coverageIntervals, [[2, 2]]);
  assert.deepEqual(middle.uncoveredLines, [[1, 1], [3, 4]]);
  assert.equal(middle.coverageComplete, false);
  const coverage = await execute(created.tools, 'get_reading_coverage', {});
  assert.equal(coverage.summary.readFiles, 1);
  assert.equal(coverage.summary.completeFiles, 0);
  assert.deepEqual(coverage.reads[0].ranges, [[2, 2]]);
  assert(coverage.uncovered.some((item) => (
    item.path === 'Diary/2026-09-01.md' && item.reason === 'partial_read'
  )));

  await execute(created.tools, 'read_note', {
    path: 'Diary/2026-09-01.md', startLine: 1, maxLines: 1,
  });
  const end = await execute(created.tools, 'read_note', {
    path: 'Diary/2026-09-01.md', startLine: 3, maxLines: 2,
  });
  assert.deepEqual(end.coverageIntervals, [[1, 4]]);
  assert.equal(end.complete, true);
  assert.equal(end.coverageComplete, true);
  assert.equal(end.hash, value.hashes.get('Diary/2026-09-01.md'));
  assert.equal(value.calls.read.length, 3);
  assert(value.calls.read.every((call) => call.relative === 'Diary/2026-09-01.md'));

  let ledger = created.getLedger();
  assert.equal(ledger.reads.find((item) => item.path === 'Diary/2026-09-01.md').complete, true);
  assert.deepEqual(ledger.reads.find((item) => item.path === 'Diary/2026-09-01.md').ranges, [[1, 4]]);
  assert.equal(ledger.complete, false, 'related search discovery remains unread');
  await execute(created.tools, 'read_note', { path: 'Learning/Topic.md', maxLines: 20 });
  ledger = created.getLedger();
  assert.equal(ledger.complete, true);
  assert.deepEqual(ledger.uncovered, []);
});

test('read_note can continue a bounded oversized line without falsely claiming coverage', async () => {
  const value = fixture();
  const created = createPiKnowledgeTools({ indexSnapshot: value.snapshot, store: value.store });
  const first = await execute(created.tools, 'read_note', {
    path: 'Learning/Long.md', maxLines: 1, maxChars: 512,
  });
  assert.equal(first.lines[0].text.length, 512);
  assert.equal(first.lines[0].complete, false);
  assert.equal(first.nextStartLine, 1);
  assert.equal(first.nextStartColumn, 513);
  assert.equal(first.coverageComplete, false);
  assert.deepEqual(first.coverageIntervals, []);

  const second = await execute(created.tools, 'read_note', {
    path: 'Learning/Long.md', startLine: first.nextStartLine,
    startColumn: first.nextStartColumn, maxLines: 1, maxChars: 512,
  });
  assert.equal(second.lines[0].text.length, 188);
  assert.equal(second.endOfDocument, true);
  assert.equal(second.coverageComplete, true);
  assert.deepEqual(second.coverageIntervals, [[1, 1]]);
});

test('empty and out-of-range read pages never create citable ranges', async () => {
  const text = 'first\n\nthird';
  const snapshot = {
    generation: 'empty-page-generation',
    listDocuments: () => [{ path: 'Blank.md', hash: 'blank-hash', size: text.length }],
    search: async () => ({ results: [] }),
    readDocument: async () => ({ path: 'Blank.md', hash: 'blank-hash', text }),
  };
  const created = createPiKnowledgeTools({ indexSnapshot: snapshot, store: {} });
  const blank = await execute(created.tools, 'read_note', {
    path: 'Blank.md', startLine: 2, maxLines: 1,
  });
  assert.equal(blank.lines[0].text, '');
  let read = created.getLedger().reads[0];
  assert.deepEqual(read.intervals, [[2, 2]], 'blank lines still count toward document traversal');
  assert.deepEqual(read.ranges, [], 'blank traversal is not original-text evidence');

  const outOfRange = await execute(created.tools, 'read_note', {
    path: 'Blank.md', startLine: 999, maxLines: 1,
  });
  assert.deepEqual(outOfRange.lines, []);
  read = created.getLedger().reads[0];
  assert.deepEqual(read.ranges, []);
  assert.equal(read.complete, false);
});

test('read coverage commits only after the bounded JSON result is deliverable', async () => {
  const text = '\\'.repeat(32_000);
  const snapshot = {
    generation: 'escaped-generation',
    listDocuments: () => [{ path: 'Escaped.md', hash: 'escaped-hash', size: text.length }],
    search: async () => ({ results: [] }),
    readDocument: async () => ({ path: 'Escaped.md', hash: 'escaped-hash', text }),
  };
  const created = createPiKnowledgeTools({ indexSnapshot: snapshot, store: {} });
  await assert.rejects(
    named(created.tools, 'read_note').execute('call', {
      path: 'Escaped.md', maxLines: 1, maxChars: 32_000,
    }, undefined, undefined, {}),
    (error) => {
      assert.equal(error.code, 'TOOL_RESULT_LIMIT');
      assert.equal(error.message.includes('Escaped.md'), false);
      return true;
    },
  );
  const ledger = created.getLedger();
  assert.deepEqual(ledger.reads, []);
  assert.deepEqual(ledger.discoveries, []);
  assert(ledger.failures.some((item) => (
    item.tool === 'read_note' && item.reason === 'TOOL_RESULT_LIMIT'
  )));
  assert.equal(ledger.complete, false);
});

test('tool failures expose stable codes without upstream messages or absolute paths', async () => {
  const value = fixture({
    snapshot: {
      async search() {
        throw Object.assign(new Error('credential=top-secret at /mnt/private/vault'), {
          code: 'EACCES_/mnt/private/vault',
        });
      },
    },
  });
  const created = createPiKnowledgeTools({ indexSnapshot: value.snapshot, store: value.store });
  await assert.rejects(
    named(created.tools, 'search_text').execute(
      'call', { keyword: 'secret' }, undefined, undefined, {},
    ),
    (error) => {
      assert.equal(error.code, 'SEARCH_TEXT_FAILED');
      assert.equal(error.message.includes('top-secret'), false);
      assert.equal(error.message.includes('/mnt/'), false);
      return true;
    },
  );
  const ledger = created.getLedger();
  assert.deepEqual(ledger.failures, [{
    tool: 'search_text', path: null, reason: 'SEARCH_TEXT_FAILED',
  }]);
  assert.equal(JSON.stringify(ledger).includes('/mnt/private'), false);
  assert.equal(JSON.stringify(ledger).includes('top-secret'), false);
});

test('read_note rejects inconsistent hashes and reports the uncovered failure', async () => {
  const value = fixture({
    snapshot: {
      async readDocument(relative) {
        return { path: relative, hash: 'different-hash', text: value?.texts?.get(relative) || 'text' };
      },
    },
  });
  // The override closure above is intentionally not used for text before value exists;
  // only the hash mismatch is relevant to this test.
  const created = createPiKnowledgeTools({ indexSnapshot: value.snapshot, store: value.store });
  await assert.rejects(
    named(created.tools, 'read_note').execute('call', { path: 'Root.md' }, undefined, undefined, {}),
    { code: 'INDEX_DOCUMENT_HASH_MISMATCH' },
  );
  const ledger = created.getLedger();
  assert.equal(ledger.reads.length, 0);
  assert(ledger.uncovered.some((item) => (
    item.path === 'Root.md' && item.reason === 'INDEX_DOCUMENT_HASH_MISMATCH'
  )));
});

test('reference resolution parses note links, stays inside the snapshot, and remains discovery-only', async () => {
  const value = fixture();
  const created = createPiKnowledgeTools({ indexSnapshot: value.snapshot, store: value.store });
  const resolved = await execute(created.tools, 'resolve_note_reference', {
    reference: '[[Topic#Details|display text]]',
  });
  assert.equal(resolved.path, 'Learning/Topic.md');
  assert.deepEqual(value.calls.resolve, ['Topic']);
  assert.equal(created.getLedger().reads.length, 0);
  assert(created.getLedger().uncovered.some((item) => item.path === 'Learning/Topic.md'));

  const ambiguous = await execute(created.tools, 'resolve_note_reference', { reference: 'Shared' });
  assert.equal(ambiguous.ambiguous, true);
  assert.deepEqual(ambiguous.candidates, ['Diary/2026-09-01.md', 'Learning/Topic.md']);
  const relative = await execute(created.tools, 'resolve_note_reference', {
    reference: '[[../Learning/Topic]]', fromPath: 'Diary/2026-09-01.md',
  });
  assert.equal(relative.path, 'Learning/Topic.md');
  assert.equal(relative.fromPath, 'Diary/2026-09-01.md');
  await assert.rejects(
    named(created.tools, 'resolve_note_reference').execute(
      'call', { reference: '../../secret.md', fromPath: 'Diary/2026-09-01.md' }, undefined, undefined, {},
    ),
    { code: 'INVALID_KNOWLEDGE_PATH' },
  );
});

test('reference candidate bounds are explicit and keep the ledger incomplete', async () => {
  const documents = Array.from({ length: 25 }, (_, index) => ({
    path: `Folder-${String(index).padStart(2, '0')}/Shared.md`,
    hash: `hash-${index}`,
    size: 1,
  }));
  const snapshot = {
    generation: 'ambiguous-generation',
    listDocuments: () => documents,
    search: async () => ({ results: [] }),
    readDocument: async (relative) => ({
      path: relative,
      hash: documents.find((item) => item.path === relative)?.hash,
      text: 'x',
    }),
  };
  const created = createPiKnowledgeTools({
    indexSnapshot: snapshot,
    store: { resolveSource: async () => ({ candidates: documents.map((item) => item.path) }) },
  });
  const result = await execute(created.tools, 'resolve_note_reference', { reference: 'Shared' });
  assert.equal(result.totalCandidates, 25);
  assert.equal(result.returnedCandidates, 20);
  assert.equal(result.candidates.length, 20);
  assert.equal(result.truncated, true);
  assert.equal(result.path, null);
  const ledger = created.getLedger();
  assert.equal(ledger.referenceResolutions[0].truncated, true);
  assert(ledger.uncovered.some((item) => (
    item.reason === 'note_reference_candidates_truncated' && item.omitted === 5
  )));
  assert.equal(ledger.complete, false);
});

test('date inventory requires explicit instants, filters to snapshot and range, and never calls web', async () => {
  const value = fixture();
  let webCalls = 0;
  const created = createPiKnowledgeTools({
    indexSnapshot: value.snapshot,
    store: value.store,
    webEnabled: true,
    learningReview: true,
    webSearchClient: { searchMany: async () => { webCalls += 1; return { results: [] }; } },
  });
  const inventory = await execute(created.tools, 'list_date_records', {
    startInclusive: '2026-09-01T00:00:00+00:00',
    endExclusive: '2026-09-02T00:00:00Z',
    timeZone: 'Asia/Shanghai',
    scope: 'learning',
  });
  assert.deepEqual(inventory.records.map((item) => item.path), ['Diary/2026-09-01.md']);
  assert.equal(inventory.inventory.basis, 'file_mtime');
  assert.equal(inventory.inventory.startInclusive, undefined);
  assert.equal(inventory.inventory.range.startInclusive, '2026-09-01T00:00:00.000Z');
  assert.equal(value.calls.temporal[0].options.range.startMs, Date.parse('2026-09-01T00:00:00Z'));
  assert.equal(value.calls.temporal[0].options.range.endMs, Date.parse('2026-09-02T00:00:00Z'));
  assert.equal(value.calls.temporal[0].options.scope, 'learning');
  assert.equal(webCalls, 0);
  const ledger = created.getLedger();
  assert(ledger.uncovered.some((item) => item.reason === 'date_inventory_truncated'));
  assert(ledger.uncovered.some((item) => item.reason === 'date_metadata_incomplete'));

  await assert.rejects(
    named(created.tools, 'list_date_records').execute('call', {
      startInclusive: '2026-09-01', endExclusive: '2026-09-02',
    }, undefined, undefined, {}),
    { code: 'INVALID_TEMPORAL_RANGE' },
  );
});

test('learning-review inventory uses the server-fixed boundary and tracks multi-page coverage', async () => {
  const start = Date.parse('2026-09-01T00:00:00Z');
  const end = Date.parse('2026-09-03T00:00:00Z');
  const documents = Array.from({ length: 125 }, (_, index) => ({
    path: `Review/${String(index).padStart(3, '0')}.md`,
    hash: `review-hash-${index}`,
    size: 20,
  }));
  const calls = [];
  const snapshot = {
    generation: 'review-generation',
    listDocuments: () => documents,
    search: async () => ({ results: [] }),
    readDocument: async (relative) => ({
      path: relative,
      hash: documents.find((item) => item.path === relative)?.hash,
      text: 'review evidence',
    }),
    async temporalInventory(query, options) {
      calls.push({ query, options });
      const results = documents.map((item, index) => ({
        path: item.path,
        name: item.path.split('/').at(-1),
        content: `record ${index}`,
        lineStart: 1,
        lineEnd: 1,
        mtimeMs: start + index * 1_000,
        logicalKey: item.path,
        relatedPaths: [],
      })).slice(0, options.limit);
      return {
        results,
        inventory: {
          scopeApplied: true,
          totalIndexedFiles: documents.length,
          inRangePhysicalFiles: documents.length,
          logicalFilesInRange: documents.length,
          invalidMtimeFiles: 0,
          metadataComplete: true,
          truncated: false,
          generation: 'review-generation',
        },
      };
    },
  };
  const created = createPiKnowledgeTools({
    indexSnapshot: snapshot,
    store: {},
    webEnabled: true,
    learningReview: {
      scope: 'all',
      range: {
        startInclusive: new Date(start).toISOString(),
        endExclusive: new Date(end).toISOString(),
        timeZone: 'Asia/Shanghai',
      },
    },
    webSearchClient: { searchMany: async () => assert.fail('reviews remain offline') },
  });
  const wrongModelBoundary = {
    startInclusive: '2000-01-01T00:00:00Z',
    endExclusive: '2000-01-02T00:00:00Z',
    timeZone: 'UTC',
    scope: 'learning',
    query: 'stable review query',
    limit: 100,
  };
  const first = await execute(created.tools, 'list_date_records', wrongModelBoundary);
  assert.equal(first.records.length, 100);
  assert.equal(first.nextOffset, 100);
  assert.equal(first.inventory.paginationComplete, false);
  assert.deepEqual(first.inventory.uncoveredOffsets, [[100, 124]]);
  assert.equal(created.getLedger().uncovered.some((item) => (
    item.reason === 'date_inventory_pagination_incomplete'
  )), true);

  const second = await execute(created.tools, 'list_date_records', {
    ...wrongModelBoundary,
    offset: first.nextOffset,
  });
  assert.equal(second.records.length, 25);
  assert.equal(second.nextOffset, null);
  assert.equal(second.inventory.paginationComplete, true);
  assert(calls.every((call) => call.options.range.startMs === start));
  assert(calls.every((call) => call.options.range.endMs === end));
  assert(calls.every((call) => call.options.range.timeZone === 'Asia/Shanghai'));
  assert(calls.every((call) => call.options.scope === 'all'));
  assert(calls.every((call) => call.options.limit === 500));
  const ledger = created.getLedger();
  assert.equal(ledger.inventories[0].paginationComplete, true);
  assert.equal(ledger.inventories[0].backendTruncated, false);
  assert.equal(ledger.uncovered.some((item) => (
    item.reason === 'date_inventory_pagination_incomplete'
  )), false);

  await execute(created.tools, 'get_reading_coverage', { limit: 10 });
  assert.equal(created.getLedger().coverageChecks, 1);
});

test('web_search is a bounded wrapper only when networking is explicit', async () => {
  const value = fixture();
  const readCalls = [];
  const webSearchClient = {
    async searchMany(queries, options) {
      value.calls.web.push({ queries, options });
      return {
        evidenceCandidates: [{
          id: 'source-1', title: 'Result', url: 'https://example.test/article',
          content: 'public summary', source: 'Example', publishedAt: '2026-09-01',
        }, {
          title: 'Unsafe transport', url: 'http://example.test/plain', content: 'drop this',
        }],
        errors: [{ code: 'ONE_SOURCE_FAILED', message: 'private provider detail' }],
      };
    },
  };
  const created = createPiKnowledgeTools({
    indexSnapshot: value.snapshot,
    store: value.store,
    webEnabled: true,
    learningReview: false,
    webSearchClient,
    webReader: {
      publicStatus: () => ({ enabled: true, configured: true }),
      async readMany(input) {
        readCalls.push(input);
        return {
          documents: [{
            sourceId: input.sourceIds[0], sourceIds: [input.sourceIds[0]],
            url: input.sources[0].url, title: 'Read result', publishedAt: '2026-09-01',
            mediaType: 'text/html', text: 'verified public page',
          }],
          errors: [],
        };
      },
    },
  });
  assert(created.tools.some((tool) => tool.name === 'web_read'));
  const result = await execute(created.tools, 'web_search', { query: 'public query', limit: 2 });
  assert.deepEqual(value.calls.web[0].queries, ['public query']);
  assert.equal(value.calls.web[0].options.resultCount, 2);
  assert.deepEqual(result.results.map((item) => item.url), ['https://example.test/article']);
  assert.equal(result.errors[0].message, undefined);
  assert.equal(result.safeReaderAvailable, true);
  const read = await execute(created.tools, 'web_read', { url: result.results[0].url });
  assert.equal(read.document.text, 'verified public page');
  assert.equal(read.sourceId, result.results[0].sourceId);
  assert.deepEqual(readCalls[0].sourceIds, [result.results[0].sourceId]);
  assert.deepEqual(readCalls[0].sources.map((item) => item.url), ['https://example.test/article']);
  await assert.rejects(
    named(created.tools, 'web_read').execute(
      'call', { url: 'https://unsearched.example.test/' }, undefined, undefined, {},
    ),
    { code: 'WEB_READ_SOURCE_NOT_ALLOWED' },
  );
  const ledger = created.getLedger();
  assert.equal(ledger.webSearches.length, 1);
  assert.deepEqual(ledger.webSources.map((item) => item.url), ['https://example.test/article']);
  assert.deepEqual(ledger.webReads.map((item) => item.characters), [20]);
  assert.equal(ledger.uncovered.some((item) => item.reason === 'web_source_not_read'), false);
  assert.equal(ledger.uncovered.some((item) => item.reason === 'web_search_partial_failure'), true);
  assert.equal(created.getLedger().discoveries.length, 0, 'web results are not Vault read coverage');
});

test('web_search closes permanently after a Vault result and sanitizes provider failures', async () => {
  const value = fixture();
  let calls = 0;
  let readCalls = 0;
  const created = createPiKnowledgeTools({
    indexSnapshot: value.snapshot,
    store: value.store,
    webEnabled: true,
    webSearchClient: {
      async searchMany() {
        calls += 1;
        return {
          results: [{
            title: 'Allowed before Vault access',
            url: 'https://example.test/before-vault',
            content: 'public result',
          }],
        };
      },
    },
    webReader: {
      publicStatus: () => ({ enabled: true, configured: true }),
      async readMany() {
        readCalls += 1;
        return { documents: [], errors: [] };
      },
    },
  });
  const searched = await execute(created.tools, 'web_search', { query: 'public information' });
  await execute(created.tools, 'list_vault', { limit: 1 });
  await assert.rejects(
    named(created.tools, 'web_search').execute(
      'call', { query: 'private note content copied here' }, undefined, undefined, {},
    ),
    { code: 'WEB_SEARCH_AFTER_VAULT_ACCESS_DENIED' },
  );
  await assert.rejects(
    named(created.tools, 'web_read').execute(
      'call', { url: searched.results[0].url }, undefined, undefined, {},
    ),
    { code: 'WEB_READ_AFTER_VAULT_ACCESS_DENIED' },
  );
  assert.equal(calls, 1, 'the guarded query must never reach the network client');
  assert.equal(readCalls, 0, 'the guarded read must never reach the network client');
  assert(created.getLedger().failures.some((item) => (
    item.tool === 'web_search' && item.reason === 'WEB_SEARCH_AFTER_VAULT_ACCESS_DENIED'
  )));
  assert(created.getLedger().failures.some((item) => (
    item.tool === 'web_read' && item.reason === 'WEB_READ_AFTER_VAULT_ACCESS_DENIED'
  )));

  const failed = createPiKnowledgeTools({
    indexSnapshot: value.snapshot,
    store: value.store,
    webEnabled: true,
    webSearchClient: {
      async searchMany() {
        throw Object.assign(new Error('token=secret; upstream /etc/provider.conf'), {
          code: 'PROVIDER_/etc/provider.conf',
        });
      },
    },
  });
  await assert.rejects(
    named(failed.tools, 'web_search').execute(
      'call', { query: 'public query' }, undefined, undefined, {},
    ),
    (error) => {
      assert.equal(error.code, 'WEB_SEARCH_FAILED');
      assert.equal(error.message.includes('secret'), false);
      assert.equal(error.message.includes('/etc/'), false);
      return true;
    },
  );
  assert(failed.getLedger().uncovered.some((item) => (
    item.tool === 'web_search' && item.reason === 'WEB_SEARCH_FAILED'
  )));
});

test('web_read reports bounded partial bodies in the coverage ledger', async () => {
  const value = fixture();
  const created = createPiKnowledgeTools({
    indexSnapshot: value.snapshot,
    store: value.store,
    webEnabled: true,
    webSearchClient: {
      searchMany: async () => ({
        results: [{ title: 'Long page', url: 'https://example.test/long', content: 'summary' }],
      }),
    },
    webReader: {
      publicStatus: () => ({ enabled: true, configured: true }),
      readMany: async (input) => ({
        documents: [{
          sourceId: input.sourceIds[0], sourceIds: input.sourceIds,
          title: 'Long page', text: 'x'.repeat(24_001), mediaType: 'text/html',
        }],
        errors: [],
      }),
    },
  });
  const search = await execute(created.tools, 'web_search', { query: 'long public page' });
  const read = await execute(created.tools, 'web_read', { url: search.results[0].url });
  assert.equal(read.document.characters, 24_000);
  assert.equal(read.document.truncatedByTool, true);
  const ledger = created.getLedger();
  assert.equal(ledger.webReads[0].truncatedByTool, true);
  assert(ledger.uncovered.some((item) => item.reason === 'web_source_partial_read'));
  assert.equal(ledger.complete, false);
});
