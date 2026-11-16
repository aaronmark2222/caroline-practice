import { Mp3Encoder } from '../vendor/lamejs.js';
const sr=44100, n=sr*5; const l=new Int16Array(n), r=new Int16Array(n);
for(let i=0;i<n;i++){l[i]=r[i]=Math.round(8000*Math.sin(i*2*Math.PI*440/sr));}
const t=Date.now(); const e=new Mp3Encoder(2,sr,192); const out=[];
for(let i=0;i<n;i+=1152){const b=e.encodeBuffer(l.subarray(i,i+1152),r.subarray(i,i+1152)); if(b.length) out.push(b);}
out.push(e.flush()); console.log('bytes',out.reduce((a,b)=>a+b.length,0),'ms',Date.now()-t);
