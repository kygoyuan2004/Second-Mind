import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRemoteUrl, isPrivateAddress, isSharedNetworkAddress } from '../desktop/security.mjs';
test('Tailscale shared-space HTTP requires explicit trust', async()=>{
  assert.equal(isPrivateAddress('100.71.158.128'),false);
  assert.equal(isSharedNetworkAddress('100.71.158.128'),true);
  await assert.rejects(validateRemoteUrl('http://100.71.158.128:8788',false));
  assert.equal(await validateRemoteUrl('http://100.71.158.128:8788',true),'http://100.71.158.128:8788/');
});
test('Shared IPv4 boundaries do not admit public addresses',async()=>{
  for(const a of ['100.64.0.0','100.127.255.255'])assert.equal(isSharedNetworkAddress(a),true);
  for(const a of ['100.63.255.255','100.128.0.0','100.999.1.1','8.8.8.8','example.com'])assert.equal(isSharedNetworkAddress(a),false);
  for(const a of ['100.63.255.255','100.128.0.0','8.8.8.8'])await assert.rejects(validateRemoteUrl('http://'+a,true));
});
test('Mixed public DNS answers, embedded credentials, and missing trust remain denied',async()=>{
  await assert.rejects(validateRemoteUrl('http://example.com',true,async()=>[{address:'100.71.158.128'},{address:'8.8.8.8'}]));
  await assert.rejects(validateRemoteUrl('http://user:password@100.71.158.128',true));
  await assert.rejects(validateRemoteUrl('http://192.168.1.1',false));
  assert.equal(await validateRemoteUrl('https://example.com',false),'https://example.com/');
});
