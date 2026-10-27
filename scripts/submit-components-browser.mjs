/** Browser-only wrappers; installed dependencies are never modified. */
export function installComponents({ PixiRenderer, LiveDrawViews, RetainedRuntimeFrame }, plant = null, allocation = false) {
  let current=null;
  const rows=[], ring=[];
  function event(component) {
    if(!current || current.frame<0 || current.events.length || component!==plant) return;
    const e={component,bytes:0,checksum:0};
    if(allocation) {
      const b=new Uint8Array(256*1024); b.fill((current.frame%251)+1);
      let checksum=0; for(let i=0;i<b.length;i++) checksum+=b[i];
      ring[current.frame%2]=b; e.bytes=b.length; e.checksum=checksum;
    } else {
      const until=performance.now()+4; while(performance.now()<until) { /* attribution control */ }
    }
    current.events.push(e);
  }
  function wrap(proto,name,key,component) {
    const fn=proto[name]; if(typeof fn!=='function') throw Error(`COMPONENT_METHOD: ${name}`);
    proto[name]=function(...args) {
      if(!current) return fn.apply(this,args);
      const start=performance.now();
      try { event(component); return fn.apply(this,args); }
      finally { current[key]+=performance.now()-start; current.counts[name]++; }
    };
  }
  wrap(PixiRenderer.prototype,'render','rendererInclusiveMs','rendererOwnMs');
  wrap(LiveDrawViews.prototype,'read','metadataMs','metadataMs');
  wrap(LiveDrawViews.prototype,'release','metadataMs','metadataMs');
  wrap(RetainedRuntimeFrame.prototype,'capture','captureMs','captureMs');
  window.__submitComponents={
    begin(frame,arm) {
      if(arm!=='rig-c-pixi') return;
      if(current) throw Error('COMPONENT_NESTED');
      current={frame,arm,rendererInclusiveMs:0,metadataMs:0,captureMs:0,hostMs:0,batchMs:0,
        counts:{render:0,read:0,release:0,capture:0},events:[],start:performance.now()};
    },
    batchEnd() { if(current) current.batchMs=performance.now()-current.start; },
    hostEnd(start) { if(current) current.hostMs+=performance.now()-start; },
    end() {
      if(!current) return;
      current.rendererOwnMs=current.rendererInclusiveMs-current.metadataMs;
      current.names=['rendererOwnMs','captureMs','metadataMs'];
      if(current.frame>=0) rows.push(current);
      current=null;
    },
    rows,
  };
}
