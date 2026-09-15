import test from 'node:test';
import assert from 'node:assert/strict';
import {sdkApplication, messageResponse, waitFor} from './sdk-test-helpers.mjs';
import {resolveModelProvider, providerModelReasoningPolicy} from '../src/model-provider-registry.mjs';

const cases = [
  ['bailian','qwen3.8-max[1M]','xhigh'],
  ['deepseek','deepseek-v4-pro','high'],
  ['glm','glm-5.3','default'],
  ['kimi','kimi-k3[1M]','max'],
  ['custom','custom-native-model','default'],
];
for (const [provider, model, effort] of cases) test(`${provider}: native Messages preset runs the full SDK read loop with only its assigned credential (mock upstream)`, {timeout:30000}, async t => {
  const adapter=resolveModelProvider({providerId:provider,...(provider==='custom'?{apiBase:'https://custom.example.com/anthropic',protocol:'anthropic-messages'}:{})});
  assert.equal(adapter.protocol,'anthropic-messages');
  const secret=`synthetic-${provider}-matrix-credential`;
  const received=[];
  const context=await sdkApplication(t,{config:{llm:{provider:'anthropic',protocol:adapter.protocol,authMode:adapter.authMode,apiBase:adapter.apiBase,apiKey:secret,model}},fetch:async(url,init)=>{
    received.push({url,headers:init.headers,body:JSON.parse(init.body)});
    if(received.length===1)return messageResponse({type:'tool_use',id:'matrix_read',name:'Read',input:{file_path:'Evidence.md'}},'tool_use');
    return messageResponse({type:'text',text:'The plan remains unfinished.〔来源：Evidence.md#Evidence〕'},'end_turn');
  }});
  const status=await(await context.call('/api/knowledge/status')).json();
  assert.ok(status.models[0].efforts.includes(effort));
  const response=await context.call('/api/knowledge/tasks',{method:'POST',body:JSON.stringify({kind:'qa',model:status.models[0].id,effort,prompt:'Read Evidence.md and report the plan status.'})});
  assert.equal(response.status,201);
  const {taskId}=await response.json();
  const task=await waitFor(()=>{const value=context.manager.tasks.get(taskId);return value?.events.some(e=>e.type==='done')&&value});
  assert.equal(task.status,'completed');
  assert.equal(received.length,2);
  for(const r of received){
    assert.equal(new URL(r.url).hostname,new URL(adapter.apiBase).hostname);
    assert.equal(r.body.model,model.replace(/\[1m\]$/i,''));
    assert.equal(adapter.authMode==='bearer'?r.headers.authorization:r.headers['x-api-key'],adapter.authMode==='bearer'?`Bearer ${secret}`:secret);
    assert.equal(JSON.stringify(r.body).includes(secret),false);
    if(effort!=='default')assert.equal(r.body.output_config?.effort,effort);
  }
  if(provider==='glm')assert.deepEqual(providerModelReasoningPolicy(adapter,model).efforts,['default']);
});
