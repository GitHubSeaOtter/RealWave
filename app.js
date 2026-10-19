import {vertex, fragment, waveFragment} from './shaders.js';
import {OceanAudio} from './audio.js';

const $ = id => document.getElementById(id);
const canvas = $('ocean');
const audio = new OceanAudio();
const defaults = {swell:1,wind:.65,volume:.55,quality:'auto'};
const state = {...defaults,scene:'golden',yaw:0,pitch:0,height:0,motion:!matchMedia('(prefers-reduced-motion: reduce)').matches,paused:false,hidden:false};
const scenes = {
  golden:{title:'黄金の静けさ',description:'日が沈む、その少し前。',number:'01',swell:1,wind:.65,sky:[.12,.23,.32],horizon:[.86,.57,.31],sun:[1.8,1.13,.57],water:[.018,.10,.10],elevation:.135,cloud:.28},
  day:{title:'果てしない青',description:'風の行く先を、眺めている。',number:'02',swell:.8,wind:.55,sky:[.075,.28,.56],horizon:[.53,.72,.82],sun:[1.5,1.45,1.28],water:[.012,.15,.20],elevation:.65,cloud:.32},
  storm:{title:'海が目を覚ます',description:'大きなうねりと、風の声。',number:'03',swell:1.65,wind:1.35,sky:[.07,.10,.145],horizon:[.32,.39,.42],sun:[.30,.35,.38],water:[.018,.065,.07],elevation:.25,cloud:1}
};
let gl,program,locations,noiseTexture,waveProgram,waveTexture,waveFramebuffer,waveLocations,raf=0,contextLost=false;
let last=performance.now(),clock=25,frames=0,measureStart=last,smoothedMS=17,renderScale=.82,resizeNeeded=true;
let gpuExt,activeQuery=null,pendingQueries=[],gpuMS=0,gpuSamples=0,adaptAt=last;
const palette = structuredClone(scenes.golden);
let sceneTarget = scenes.golden;
let noticeTimeout;
function notify(message) {
  $('notice').textContent=message; $('notice').classList.add('visible');
  clearTimeout(noticeTimeout);noticeTimeout=setTimeout(()=>$('notice').classList.remove('visible'),3200);
}
function fail(message) {
  $('error-message').textContent=message;$('error').hidden=false;
  cancelAnimationFrame(raf);console.error(message);
}
function compile(type,source) {
  const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
  if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) {
    const info=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw new Error(info);
  }
  return shader;
}
function initializeGL() {
  gl=canvas.getContext('webgl2',{alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false,powerPreference:'high-performance'});
  if(!gl)throw new Error('WebGL2が使えません。Chromeの「設定 → システム → グラフィック アクセラレーション」を有効にしてください。');
  const vs=compile(gl.VERTEX_SHADER,vertex),fs=compile(gl.FRAGMENT_SHADER,fragment);
  program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
  gl.deleteShader(vs);gl.deleteShader(fs);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  gl.bindVertexArray(gl.createVertexArray());
  locations={};
  for(const name of ['Resolution','Time','Swell','Wind','Yaw','Pitch','Height','Motion','Cloud','SunElevation','SkyTop','Horizon','SunColor','Water','Noise','WaveMap','UseWaveMap'])locations[name]=gl.getUniformLocation(program,`u${name}`);
  // A seeded, seamless 256-square noise texture; filtering is done by the GPU.
  const bytes=new Uint8Array(256*256);let seed=71237;
  for(let i=0;i<bytes.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;bytes[i]=seed>>>24;}
  noiseTexture=gl.createTexture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,noiseTexture);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.R8,256,256,0,gl.RED,gl.UNSIGNED_BYTE,bytes);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.REPEAT);
  gl.uniform1i(locations.Noise,0);
  gl.uniform1i(locations.WaveMap,1);
  waveFramebuffer=null;
  if(gl.getExtension('EXT_color_buffer_float')){
    waveTexture=gl.createTexture();gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,waveTexture);
    gl.texStorage2D(gl.TEXTURE_2D,10,gl.RGBA16F,512,512);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.REPEAT);
    waveFramebuffer=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,waveFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,waveTexture,0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE){gl.deleteFramebuffer(waveFramebuffer);waveFramebuffer=null;}
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    if(waveFramebuffer){
      const wvs=compile(gl.VERTEX_SHADER,vertex),wfs=compile(gl.FRAGMENT_SHADER,waveFragment);
      waveProgram=gl.createProgram();gl.attachShader(waveProgram,wvs);gl.attachShader(waveProgram,wfs);gl.linkProgram(waveProgram);
      gl.deleteShader(wvs);gl.deleteShader(wfs);
      if(!gl.getProgramParameter(waveProgram,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(waveProgram));
      waveLocations={time:gl.getUniformLocation(waveProgram,'uTime'),wind:gl.getUniformLocation(waveProgram,'uWind')};
    }
  }
  gl.useProgram(program);gl.uniform1f(locations.UseWaveMap,waveFramebuffer?1:0);
  gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);
  gpuExt=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  activeQuery=null;pendingQueries=[];resizeNeeded=true;
}
function resize() {
  const width=innerWidth,height=innerHeight;
  const cap=state.quality==='ultra'?2560:state.quality==='low'?1280:1920;
  const pixelCap=state.quality==='ultra'?2560*1440:state.quality==='low'?1280*720:1920*1080;
  let ratio=Math.min(devicePixelRatio||1,cap/width,Math.sqrt(pixelCap/(width*height)));
  if(state.quality==='auto')ratio*=renderScale;
  canvas.width=Math.max(2,Math.round(width*ratio/2)*2);canvas.height=Math.max(2,Math.round(height*ratio/2)*2);
  gl.viewport(0,0,canvas.width,canvas.height);gl.uniform2f(locations.Resolution,canvas.width,canvas.height);
  $('resolution').textContent=`${canvas.width} × ${canvas.height}`;
  resizeNeeded=false;
}
function collectGPU() {
  if(!gpuExt)return;
  if(gl.getParameter(gpuExt.GPU_DISJOINT_EXT)){
    pendingQueries.forEach(q=>gl.deleteQuery(q));pendingQueries=[];return;
  }
  while(pendingQueries.length&&gl.getQueryParameter(pendingQueries[0],gl.QUERY_RESULT_AVAILABLE)){
    const query=pendingQueries.shift();const value=gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6;
    if(value>0){gpuMS=gpuSamples?gpuMS*.85+value*.15:value;gpuSamples++;}
    gl.deleteQuery(query);
  }
}
function render(now) {
  if(contextLost||document.hidden)return;
  const raw=(now-last)/1000;last=now;
  const dt=Math.min(1,Math.max(0,raw));
  if(!state.paused)clock+=dt;
  if(resizeNeeded)resize();
  collectGPU();
  if(gpuExt&&pendingQueries.length<4&&frames%8===0){activeQuery=gl.createQuery();gl.beginQuery(gpuExt.TIME_ELAPSED_EXT,activeQuery);}
  if(waveFramebuffer){
    gl.bindFramebuffer(gl.FRAMEBUFFER,waveFramebuffer);gl.viewport(0,0,512,512);gl.useProgram(waveProgram);
    gl.uniform1f(waveLocations.time,clock);gl.uniform1f(waveLocations.wind,state.wind);
    // Unbind the render target from the sampler while writing it.
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,null);
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.bindTexture(gl.TEXTURE_2D,waveTexture);gl.generateMipmap(gl.TEXTURE_2D);
    gl.viewport(0,0,canvas.width,canvas.height);gl.useProgram(program);
  }
  const blend=1-Math.exp(-dt*1.4);
  for(const key of ['sky','horizon','sun','water'])palette[key]=palette[key].map((v,i)=>v+(sceneTarget[key][i]-v)*blend);
  palette.elevation+=(sceneTarget.elevation-palette.elevation)*blend;palette.cloud+=(sceneTarget.cloud-palette.cloud)*blend;
  state.yaw+=(targetYaw-state.yaw)*(1-Math.exp(-dt*5));state.pitch+=(targetPitch-state.pitch)*(1-Math.exp(-dt*5));
  gl.uniform1f(locations.Time,clock);gl.uniform1f(locations.Swell,state.swell);gl.uniform1f(locations.Wind,state.wind);
  gl.uniform1f(locations.Yaw,state.yaw);gl.uniform1f(locations.Pitch,state.pitch);
  gl.uniform1f(locations.Height,state.height+Math.max(0,state.swell-1)*2.5);
  gl.uniform1f(locations.Motion,state.motion?1:0);gl.uniform1f(locations.Cloud,palette.cloud);gl.uniform1f(locations.SunElevation,palette.elevation);
  gl.uniform3fv(locations.SkyTop,palette.sky);gl.uniform3fv(locations.Horizon,palette.horizon);gl.uniform3fv(locations.SunColor,palette.sun);gl.uniform3fv(locations.Water,palette.water);
  gl.drawArrays(gl.TRIANGLES,0,3);
  if(activeQuery){gl.endQuery(gpuExt.TIME_ELAPSED_EXT);pendingQueries.push(activeQuery);activeQuery=null;}
  if(frames%4===0)audio.update(clock,state.swell,state.wind,state.yaw);
  frames++;
  if(raw>0&&raw<1)smoothedMS=smoothedMS*.95+raw*1000*.05;
  if(now-measureStart>1000){
    $('fps').textContent=`${Math.round(frames*1000/(now-measureStart))} FPS${state.paused?' · PAUSED':''}`;
    frames=0;measureStart=now;
  }
  if(state.quality==='auto'&&now-adaptAt>2200){
    const cost=gpuSamples>2?gpuMS:smoothedMS;
    const before=renderScale;
    if(cost>21)renderScale=Math.max(.38,renderScale*.87);
    else if(cost<13.5)renderScale=Math.min(1,renderScale*1.06);
    if(before!==renderScale)resizeNeeded=true;
    adaptAt=now;
  }
  raf=requestAnimationFrame(render);
}

let targetYaw=0,targetPitch=0,drag=null,hasLooked=false,soundBusy=false;
canvas.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,yaw:targetYaw,pitch:targetPitch};canvas.setPointerCapture(e.pointerId);});
canvas.addEventListener('pointermove',e=>{
  if(!drag)return;
  targetYaw=Math.max(-1.8,Math.min(1.8,drag.yaw-(e.clientX-drag.x)*.003));
  targetPitch=Math.max(-.48,Math.min(.4,drag.pitch+(e.clientY-drag.y)*.002));
  if(!hasLooked){hasLooked=true;document.querySelector('.look-hint').style.opacity='0';}
});
canvas.addEventListener('pointerup',()=>drag=null);canvas.addEventListener('pointercancel',()=>drag=null);
canvas.addEventListener('wheel',e=>{e.preventDefault();state.height=Math.max(-.7,Math.min(7,state.height+e.deltaY*.004));},{passive:false});
function syncControls(){
  for(const key of ['swell','wind','volume'])$(key).value=state[key];
  $('swell-value').textContent=`${state.swell.toFixed(1)} m`;
  $('wind-value').textContent=`${(state.wind*7.7).toFixed(1)} m/s`;
  $('volume-value').textContent=`${Math.round(state.volume*100)}%`;
  $('quality').value=state.quality;$('motion').checked=state.motion;
}
for(const key of ['swell','wind','volume'])$(key).addEventListener('input',e=>{state[key]=Number(e.target.value);if(key==='volume')audio.setVolume(state.volume);syncControls();});
$('quality').addEventListener('change',e=>{state.quality=e.target.value;renderScale=.82;resizeNeeded=true;adaptAt=performance.now();});
$('motion').addEventListener('change',e=>state.motion=e.target.checked);
document.querySelectorAll('[data-scene]').forEach(button=>button.addEventListener('click',()=>{
  state.scene=button.dataset.scene;sceneTarget=scenes[state.scene];state.swell=sceneTarget.swell;state.wind=sceneTarget.wind;
  $('scene-title').textContent=sceneTarget.title;$('scene-description').textContent=sceneTarget.description;$('scene-number').textContent=sceneTarget.number;
  document.querySelectorAll('[data-scene]').forEach(b=>{const selected=b===button;b.classList.toggle('active',selected);b.setAttribute('aria-pressed',selected);});
  syncControls();
}));
function setSettings(open){$('settings').hidden=!open;$('settings-toggle').setAttribute('aria-expanded',open);if(open)$('settings-close').focus();else $('settings-toggle').focus();}
$('settings-toggle').addEventListener('click',()=>setSettings($('settings').hidden));$('settings-close').addEventListener('click',()=>setSettings(false));
async function toggleSound(forceOn=false) {
  if(soundBusy)return;soundBusy=true;
  try{
    if(audio.enabled&&!forceOn)audio.stop();else await audio.start();
    document.body.classList.toggle('sound-on',audio.enabled);$('sound').setAttribute('aria-pressed',audio.enabled);$('sound-label').textContent=`サウンド ${audio.enabled?'ON':'OFF'}`;
    if(audio.enabled&&state.paused)await audio.suspend();
  }catch(error){console.error(error);notify('音声を開始できませんでした。サウンドボタンでもう一度お試しください。');}
  finally{soundBusy=false;}
}
$('sound').addEventListener('click',()=>toggleSound());
$('enter').addEventListener('click',()=>{document.body.classList.add('entered');toggleSound(true);$('sound').focus({preventScroll:true});});
async function fullscreen(){
  try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}
  catch{notify('この環境では全画面表示を利用できません。');}
}
$('fullscreen').addEventListener('click',fullscreen);
document.addEventListener('fullscreenchange',()=>{const full=!!document.fullscreenElement;$('fullscreen').setAttribute('aria-label',full?'全画面を終了':'全画面表示');resizeNeeded=true;});
function hideUI(){
  state.hidden=!state.hidden;$('interface').style.opacity=state.hidden?'0':'1';$('interface').inert=state.hidden;
  $('restore-ui').hidden=!state.hidden;if(state.hidden){$('settings').hidden=true;$('settings-toggle').setAttribute('aria-expanded',false);$('restore-ui').focus({preventScroll:true});}
}
$('hide-ui').addEventListener('click',hideUI);$('restore-ui').addEventListener('click',hideUI);
function togglePause(){state.paused=!state.paused;if(state.paused)audio.suspend();else audio.resume().catch(()=>notify('サウンドボタンで音声を再開してください。'));notify(state.paused?'波の動きを一時停止しました':'波の動きを再開しました');}
document.addEventListener('keydown',e=>{
  if(/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)&&e.key!=='Escape')return;
  if(e.code==='Space'&&e.target.tagName==='BUTTON')return;
  if(e.ctrlKey||e.altKey||e.metaKey)return;
  if(e.key.toLowerCase()==='f')fullscreen();
  if(e.key.toLowerCase()==='m')toggleSound();
  if(e.key.toLowerCase()==='h')hideUI();
  if(e.code==='Space'){e.preventDefault();togglePause();}
  if(e.key==='Escape'&&!$('settings').hidden)setSettings(false);
});
$('reset').addEventListener('click',()=>{
  Object.assign(state,defaults,{height:0,paused:false,motion:!matchMedia('(prefers-reduced-motion: reduce)').matches});targetYaw=targetPitch=0;
  document.querySelector('[data-scene="golden"]').click();audio.setVolume(state.volume);audio.resume().catch(()=>{});renderScale=.82;resizeNeeded=true;syncControls();notify('初期設定に戻しました');
});
addEventListener('resize',()=>resizeNeeded=true);
document.addEventListener('visibilitychange',()=>{
  cancelAnimationFrame(raf);
  if(document.hidden)audio.suspend();
  else if(!contextLost){last=measureStart=performance.now();frames=0;if(!state.paused)audio.resume().catch(()=>{});raf=requestAnimationFrame(render);}
});
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();contextLost=true;cancelAnimationFrame(raf);audio.suspend();notify('描画を復旧しています…');});
canvas.addEventListener('webglcontextrestored',()=>{
  try{initializeGL();contextLost=false;last=measureStart=performance.now();if(!state.paused)audio.resume().catch(()=>{});raf=requestAnimationFrame(render);notify('描画を復旧しました');}
  catch(error){fail(`描画の復旧に失敗しました。ページを再読み込みしてください。 ${error.message}`);}
});
syncControls();
try{initializeGL();raf=requestAnimationFrame(render);}
catch(error){fail(`海を描画できませんでした。${error.message}`);}

// Read-only diagnostics for validation and performance inspection.
window.realwave={get status(){return{webgl:!!gl&&!contextLost,heightmap:!!waveFramebuffer,audio:audio.context?.state||'inactive',sound:audio.enabled,scene:state.scene,paused:state.paused,time:clock,resolution:[canvas.width,canvas.height],quality:state.quality,gpuMS:Math.round(gpuMS*10)/10,scale:renderScale};}};
