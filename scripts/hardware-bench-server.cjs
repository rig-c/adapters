/* Loopback-only static server and result sink. No user files are served. */
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(process.argv[2]);
const results=path.resolve(process.argv[3]);
const port=Number(process.argv[4]||4362);
fs.mkdirSync(results,{recursive:true});
http.createServer((req,res)=>{
 res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');res.setHeader('Cache-Control','no-store');
 const url=new URL(req.url,'http://localhost');
 if(req.method==='POST' && /^\/result\/(precheck|(?:AA|AB)[1-6])$/.test(url.pathname)){
  let data='';req.on('data',c=>{data+=c;if(data.length>10000000)req.destroy();});req.on('end',()=>{
   try { const record=JSON.parse(data);fs.writeFileSync(path.join(results,url.pathname.split('/').at(-1)+'.json'),JSON.stringify(record,null,2));res.end('saved');console.log('HARDWARE_RESULT',record.phase,record.status); }
   catch(e){res.statusCode=400;res.end(String(e));}
  });return;
 }
 const file=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
 if(!file.startsWith(root+path.sep)){res.statusCode=403;res.end();return;}
 try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.json')?'application/json':file.endsWith('.html')?'text/html':file.endsWith('.png')?'image/png':'application/octet-stream');res.end(fs.readFileSync(file));}
 catch {res.statusCode=404;res.end('missing');}
}).listen(port,'127.0.0.1',()=>console.log('HARDWARE_SERVER_READY',port));
