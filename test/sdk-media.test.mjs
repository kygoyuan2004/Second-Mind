import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { sdkApplication, messageResponse, waitFor } from './sdk-test-helpers.mjs';

const fixtures = process.env.SECOND_MIND_MEDIA_FIXTURES;
test('installed media runtime transcribes speech and processes uploaded video through the SDK into a confirmable draft', {
  skip: !fixtures && 'Run the dedicated container media gate with the pinned public Whisper model and generated fixtures.',
  timeout: 120_000,
}, async (t) => {
  let sawVideoImage = false;
  const { call, manager, project } = await sdkApplication(t, { fetch: async (_url, init) => {
    const request = JSON.parse(init.body);
    sawVideoImage ||= request.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'image'));
    return messageResponse({ type: 'text', text: '# 公开视频验收\n\n画面为蓝色；音轨介绍公开知识库验收与论文阅读计划。' }, 'end_turn');
  } });
  const status = await (await call('/api/knowledge/status')).json();
  assert.equal(status.speechTranscription.available, true);
  assert.equal(status.videoProcessing.uploadAvailable, true);
  assert.ok(status.videoProcessing.visionModelIds.includes('configured'));
  const speech = await call('/api/knowledge/transcribe', { method: 'POST', body: JSON.stringify({
    type: 'audio/wav', durationMs: 20_000, data: (await fs.readFile(path.join(fixtures, 'demo.wav'))).toString('base64'),
  }) });
  assert.equal(speech.status, 200, JSON.stringify(await speech.clone().json()));
  assert.ok((await speech.json()).text.trim().length > 2);
  assert.deepEqual((await fs.readdir(manager.transcriber.tempRoot)).filter((name) => name !== 'home'), []);
  const uploaded = await call('/api/knowledge/video-uploads?name=public-demo.mp4&type=video%2Fmp4', {
    method: 'POST', headers: { 'content-type': 'video/mp4', 'x-file-name': 'public-demo.mp4' },
    body: await fs.readFile(path.join(fixtures, 'demo.mp4')),
  });
  assert.equal(uploaded.status, 201, JSON.stringify(await uploaded.clone().json()));
  const upload = await uploaded.json();
  const createdResponse = await call('/api/knowledge/tasks', { method: 'POST', body: JSON.stringify({
    kind: 'video', model: 'configured', effort: 'low', prompt: '整理为简洁的视频笔记。',
    video: { uploadId: upload.id }, videoOutput: 'quick',
  }) });
  assert.equal(createdResponse.status, 201, JSON.stringify(await createdResponse.clone().json()));
  const created = await createdResponse.json();
  const task = await waitFor(() => {
    const value = manager.tasks.get(created.taskId);
    return ['completed', 'failed'].includes(value?.status) && value;
  }, 90_000);
  assert.equal(task.status, 'completed', JSON.stringify(task.events.filter((event) => event.type === 'task_error')));
  assert.equal(sawVideoImage, true);
  assert.ok(task.draftId);
  const draft = await (await call(`/api/knowledge/drafts/${task.draftId}`)).json();
  assert.ok(draft.attachments.length > 0);
  assert.equal(await fs.access(path.join(project.vaultPath, 'daily_doc')).then(() => true, () => false), false);
  await Promise.allSettled([...manager.running]);
  assert.deepEqual(await fs.readdir(manager.videoProcessor.taskRoot), []);
});
