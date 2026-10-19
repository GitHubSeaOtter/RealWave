// Original analytic wind-wave heightfield. All lighting is evaluated in linear space.
export const vertex = `#version 300 es
precision highp float;
const vec2 p[3]=vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));
void main(){gl_Position=vec4(p[gl_VertexID],0.,1.);}`;

// One reusable periodic height/slope map replaces hundreds of transcendental
// operations per screen pixel. Half-float storage retains fine surface gradients.
export const waveFragment = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform float uTime,uWind;
const float TAU=6.28318530718;
void main(){
  vec2 p=gl_FragCoord.xy/512.*256.;
  float k=.105,a=1.,h=0.;vec2 slope=vec2(0.);
  for(int i=0;i<6;i++){
    float fi=float(i),angle=fi*2.39996323+.47;
    vec2 kv=floor(vec2(cos(angle),sin(angle))*k*256./TAU+.5)*TAU/256.;
    float phase=dot(p,kv)-uTime*sqrt(9.81*length(kv))*(.7+uWind*.45)+fi*1.618;
    float crest=exp(sin(phase)-1.);
    h+=(crest-.46576)*a;slope+=kv*cos(phase)*crest*a;
    k*=1.91;a*=.5;
  }
  fragColor=vec4(vec3(h,slope)*2.45,1.);
}`;

export const fragment = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform vec2 uResolution;
uniform float uTime,uSwell,uWind,uYaw,uPitch,uHeight,uMotion,uCloud,uSunElevation;
uniform vec3 uSkyTop,uHorizon,uSunColor,uWater;
uniform sampler2D uNoise,uWaveMap;
uniform float uUseWaveMap;
const float PI=3.14159265359;
float noise(vec2 p){return texture(uNoise,p/256.).r;}
float fbm(vec2 p){
  float n=0.;float a=.55;
  mat2 m=mat2(1.6,1.2,-1.2,1.6);
  for(int i=0;i<4;i++){n+=a*noise(p);p=m*p+17.3;a*=.48;}return n;
}
vec3 sunDirection(){return normalize(vec3(.48,uSunElevation,-.88));}

// The low-frequency geometry is shared by the ray intersection and normal field.
// exp(sin()) makes smooth troughs and compact crests. Dispersion follows sqrt(g*k).
vec3 waves(vec2 p,int count){
  if(uUseWaveMap>.5)return textureLod(uWaveMap,p/256.,0.).rgb*uSwell;
  float k=.105;float a=1.;float h=0.;vec2 slope=vec2(0.);
  for(int i=0;i<12;i++){
    if(i>=count)break;
    float fi=float(i);
    float angle=fi*2.39996323+.47;
    vec2 dir=vec2(cos(angle),sin(angle));
    vec2 kv=floor(dir*k*256./(2.*PI)+.5)*(2.*PI)/256.;
    float phase=dot(p,kv)-uTime*sqrt(9.81*length(kv))*(.7+uWind*.45)+fi*1.618;
    float crest=exp(sin(phase)-1.);
    h+=(crest-.46576)*a;
    slope+=kv*(cos(phase)*crest*a);
    k*=1.91;a*=.50;
  }
  return vec3(h,slope)*uSwell*2.45;
}

vec3 sky(vec3 rd,bool clouds){
  vec3 sun=sunDirection();
  float y=max(rd.y,0.);
  vec3 col=mix(uHorizon,uSkyTop,pow(clamp(y,0.,1.),.28));
  float alignment=max(dot(rd,sun),0.);
  // Forward scattering and a sub-degree sun disc.
  col+=uSunColor*pow(alignment,8.)*.28;
  col+=uSunColor*pow(alignment,180.)*.34;
  float sunDisc=1.-smoothstep(.003,.007,acos(clamp(alignment,0.,1.)));
  if(clouds&&rd.y>.008){
    vec2 cp=rd.xz/(rd.y+.09)*190.+vec2(uTime*1.1,0.);
    float n=fbm(cp*.035);
    float coverage=smoothstep(.49-uCloud*.19,.72-uCloud*.12,n);
    float light=fbm(cp*.035+vec2(1.,-2.));
    vec3 cloudColor=mix(mix(uSkyTop,uHorizon,.45)*.65,uHorizon*1.1+uSunColor*.08,light);
    col=mix(col,cloudColor,coverage*smoothstep(.005,.16,rd.y)*(.52+uCloud*.35));
    // A wispy upper layer breaks up large cloud banks.
    float wisps=smoothstep(.56,.78,fbm(cp*vec2(.018,.04)+240.));
    col=mix(col,uHorizon*.95,wisps*.18);
  }
  col+=uSunColor*sunDisc*4.*(1.-uCloud*.92);
  return col;
}

float intersectOcean(vec3 ro,vec3 rd){
  float bound=2.65*uSwell;
  float nearT=max(0.,(bound-ro.y)/rd.y);
  float farT=min(6000.,(-bound-ro.y)/rd.y);
  if(farT<=nearT)return -1.;
  float a=nearT;float b=farT;
  float fa=(ro+rd*a).y-waves((ro+rd*a).xz,6).x;
  float fb=(ro+rd*b).y-waves((ro+rd*b).xz,6).x;
  if(fb>0.)return -1.;
  // Bracketed secant tracing; midpoint steps prevent a stationary endpoint.
  float t=a;
  for(int i=0;i<18;i++){
    float f=clamp(fa/(fa-fb),.04,.96);
    if(i==5||i==11)f=.5;
    t=mix(a,b,f);
    vec3 p=ro+rd*t;
    float ft=p.y-waves(p.xz,6).x;
    if(abs(ft)<.0015)break;
    if(ft>0.){a=t;fa=ft;}else{b=t;fb=ft;}
  }
  return t;
}

vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
void main(){
  vec2 uv=(2.*gl_FragCoord.xy-uResolution)/uResolution.y;
  float bob=uMotion*(sin(uTime*.53)*.15+sin(uTime*.29)*.08);
  vec3 ro=vec3(uTime*.16,4.8+uHeight+bob,0.);
  vec3 forward=normalize(vec3(sin(uYaw),-.12+uPitch+uMotion*sin(uTime*.17)*.008,-cos(uYaw)));
  vec3 right=normalize(cross(forward,vec3(0.,1.,0.)));
  vec3 up=cross(right,forward);
  vec3 rd=normalize(forward*1.65+right*uv.x+up*uv.y);
  vec3 color=sky(rd,true);
  if(rd.y<-.001){
    float distance=intersectOcean(ro,rd);
    if(distance>0.){
      vec3 p=ro+rd*distance;
      vec3 wave=waves(p.xz,12);
      if(uUseWaveMap>.5){
        float lod=clamp(log2(max(1.,distance/uResolution.y*3.)),0.,8.);
        wave.yz=textureLod(uWaveMap,p.xz/256.,lod).gb*uSwell;
      }
      // Sub-pixel wind ripples fade with the footprint, avoiding horizon shimmer.
      float nearDetail=exp(-distance*.011);
      vec2 drift=p.xz*1.9+vec2(uTime*.34,-uTime*.26);
      vec2 ripples=vec2(noise(drift+vec2(.7,0.))-noise(drift-vec2(.7,0.)),noise(drift+vec2(0.,.7))-noise(drift-vec2(0.,.7)));
      vec2 slopes=wave.yz+ripples*nearDetail*.30*uWind;
      vec3 normal=normalize(vec3(-slopes.x,1.,-slopes.y));
      vec3 reflected=reflect(rd,normal);
      reflected.y=max(.003,reflected.y);
      float ndv=clamp(dot(normal,-rd),0.,1.);
      float fresnel=.0204+.9796*pow(1.-ndv,5.);
      vec3 reflection=sky(normalize(reflected),distance<300.);
      vec3 sun=sunDirection();
      vec3 halfVector=normalize(sun-rd);
      float nh=max(dot(normal,halfVector),0.);
      float roughness=.065+uWind*.035;
      float a2=pow(roughness,4.);
      float denom=nh*nh*(a2-1.)+1.;
      float distribution=a2/(PI*denom*denom+.0000001);
      float spec=distribution*.0204/(4.*max(ndv,.15));
      spec=min(spec,35.);
      float wrap=pow(max(dot(normal,sun)*.5+.5,0.),2.);
      vec3 water=uWater*(.65+wrap*.55);
      // Light transmitted through rising crests gives the water its depth.
      float transmission=pow(max(dot(sun,rd),0.),4.)*max(wave.x+.6,0.)*.22;
      water+=uWater*transmission*2.3;
      color=mix(water,reflection,fresnel);
      color+=uSunColor*spec*.65;
      // Sparse, advected foam accumulates around steep crests and disperses.
      vec2 foamUV=p.xz*.65+vec2(-uTime*.18,uTime*.08);
      float foamNoise=fbm(foamUV*4.);
      float crest=wave.x/max(uSwell,.1);
      float foam=smoothstep(1.05,1.65,crest+foamNoise*.28+length(slopes)*.18);
      foam*=smoothstep(.33,.7,foamNoise)*(.05+uWind*.5);
      float cells=noise(foamUV*45.);
      vec3 foamColor=(uHorizon*.65+vec3(.15))*(.75+cells*.25);
      color=mix(color,foamColor,foam*exp(-distance*.0015));
      float haze=1.-exp(-distance*(.00032+uCloud*.0005));
      color=mix(color,sky(normalize(vec3(rd.x,.008,rd.z)),false),haze);
    }
  }
  // Gentle photographic falloff and dithering instead of an expensive post stack.
  color*=1.-.10*pow(length(uv)/1.9,2.);
  color=pow(aces(max(color,vec3(0.))*.93),vec3(1./2.2));
  float grain=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)-.5;
  fragColor=vec4(color+grain/255.,1.);
}`;
