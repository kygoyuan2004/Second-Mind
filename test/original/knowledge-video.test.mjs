import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { KnowledgeVideoProcessor, knowledgeVideoConstants } from '../../src/original/knowledge-video.mjs';

test('视频上传采用流式临时文件、绑定用户并可显式删除', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'yuan-video-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const processor = new KnowledgeVideoProcessor({
    tempRoot: root,
    python: '/bin/true',
    inspectScript: '/bin/true',
    transcribeScript: '/bin/true',
    ffmpeg: '/bin/true',
    ytdlp: '/bin/true',
    maxUploadBytes: 1024,
  });
  await processor.ready;
  const request = Readable.from([Buffer.from('video-'), Buffer.from('payload')]);
  request.headers = { 'content-type': 'video/mp4', 'content-length': '13' };
  const uploaded = await processor.storeUpload('user-video-1234', request, {
    name: '课程.mp4', type: 'video/mp4',
  });
  assert.equal(uploaded.name, '课程.mp4');
  assert.equal(uploaded.bytes, 13);
  await assert.rejects(
    () => processor.deleteUpload('another-user-1234', uploaded.id),
    (error) => error.code === 'VIDEO_UPLOAD_NOT_FOUND',
  );
  assert.deepEqual(await processor.deleteUpload('user-video-1234', uploaded.id), { ok: true, id: uploaded.id });
});

test('视频链接拒绝本机和内网地址', async () => {
  await assert.rejects(
    () => knowledgeVideoConstants.validatePublicUrl('http://127.0.0.1/private.mp4'),
    (error) => error.code === 'PRIVATE_VIDEO_URL',
  );
  await assert.rejects(
    () => knowledgeVideoConstants.validatePublicUrl('file:///etc/passwd'),
    (error) => error.code === 'INVALID_VIDEO_URL',
  );
});
