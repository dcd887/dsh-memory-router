import { apply } from '../index.js';
const ctxs=[], hs=new Map();
const ctx={ get:(n)=> n==="systemPrompt"?{context:(d)=>{ctxs.push(d);return()=>{}}}:n==="agents"?{currentInitiator:()=>({id:"s1"})}:undefined,
  on:(n,f)=>{hs.set(n,f);return()=>{}} };
apply(ctx,{ handoffDir:"C:\\Users\\kjds\\Desktop\\DSH输出\\_workflows", handoffGlob:"交接_*.md", stateChars:1800, summary:{enabled:false}, trim:{enabled:false}, statsLine:true });
hs.get("agent/inbox/claimed")({agent:{id:"s1"},turn:1,message:{role:"user",content:[{type:"text",text:"当前状态如何，还有什么待办"}]}});
hs.get("agent/pre-step")({agent:{id:"s1"},turn:1,step:1},async()=>({kind:"enter",messages:[]}));
const t=ctxs[0].text();
console.log("注入长度 " + t.length);
console.log("末行: " + t.split("\n").filter(Boolean).pop());
