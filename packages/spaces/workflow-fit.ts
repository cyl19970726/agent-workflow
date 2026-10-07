/** A camera target derived from the measured SVG content and visible viewport. */
export interface WorkflowFitRect { x: number; y: number; width: number; height: number }
export interface WorkflowFitViewport { left: number; top: number; right: number; bottom: number }
export interface WorkflowFitInput {
  viewBox: WorkflowFitRect;
  svg: { width: number; height: number };
  /** SVG user-space union of visible diagram geometry (nodes, edges, labels, frames). */
  bounds: WorkflowFitRect;
  /** Visible viewport edges relative to the untransformed SVG, in CSS pixels. */
  viewport: WorkflowFitViewport;
  padding?: number;
  maxScale?: number;
}
export interface WorkflowFitTarget {
  /** Archify camera transform scale; its public API has a minimum of 1. */
  scale: number;
  /** Anchor passed to Archify.view.centerAt, adjusted for an asymmetric safe viewport. */
  anchorX: number;
  anchorY: number;
  /** True when the public camera scale bounds prevent a complete fit. */
  limited: boolean;
}

/**
 * Compute an actual full-content camera fit. This mirrors SVG preserveAspectRatio
 * `meet` and uses the measured safe viewport; callers clip it only for controls
 * that actually overlap the SVG. It does not infer size from node count, assume
 * a fixed dock reserve, or use a fixed zoom multiplier.
 */
export function computeWorkflowFit(input: WorkflowFitInput): WorkflowFitTarget | undefined {
  const { viewBox, svg, bounds, viewport } = input;
  const padding = input.padding ?? 0;
  const maxScale = input.maxScale ?? 3;
  if (![viewBox.x, viewBox.y, viewBox.width, viewBox.height, svg.width, svg.height,
    bounds.x, bounds.y, bounds.width, bounds.height, viewport.left, viewport.top,
    viewport.right, viewport.bottom, padding, maxScale].every(Number.isFinite)) return undefined;
  if (viewBox.width <= 0 || viewBox.height <= 0 || svg.width <= 0 || svg.height <= 0 ||
    bounds.width <= 0 || bounds.height <= 0 || padding < 0 || maxScale < 1) return undefined;

  const safeLeft = viewport.left + padding;
  const safeRight = viewport.right - padding;
  const safeTop = viewport.top + padding;
  const safeBottom = viewport.bottom - padding;
  if (safeRight <= safeLeft || safeBottom <= safeTop) return undefined;

  const contentScale = Math.min(svg.width / viewBox.width, svg.height / viewBox.height);
  const offsetX = (svg.width - viewBox.width * contentScale) / 2;
  const offsetY = (svg.height - viewBox.height * contentScale) / 2;
  const contentWidth = bounds.width * contentScale;
  const contentHeight = bounds.height * contentScale;
  if (contentWidth <= 0 || contentHeight <= 0) return undefined;

  const requiredScale = Math.min(
    (safeRight - safeLeft) / contentWidth,
    (safeBottom - safeTop) / contentHeight,
  );
  const scale = Math.max(1, Math.min(maxScale, requiredScale));
  const centerX = offsetX + (bounds.x + bounds.width / 2 - viewBox.x) * contentScale;
  const centerY = offsetY + (bounds.y + bounds.height / 2 - viewBox.y) * contentScale;
  const safeCenterX = (safeLeft + safeRight) / 2;
  const safeCenterY = (safeTop + safeBottom) / 2;

  // centerAt places its anchor at the SVG viewport center. Shift the anchor so
  // the graph center lands in the safe area's center (for example, above an
  // overlapping floating control dock).
  return {
    scale,
    anchorX: viewBox.x + (centerX + (svg.width / 2 - safeCenterX) / scale - offsetX) / contentScale,
    anchorY: viewBox.y + (centerY + (svg.height / 2 - safeCenterY) / scale - offsetY) / contentScale,
    limited: requiredScale < 1 || requiredScale > maxScale,
  };
}

/** One-shot first-load framing. Does not select nodes or run again on data updates. */
export function workflowInitialFitScript(): string {
  return `(function(){
  var svg=document.querySelector('.diagram-container svg');
  var container=document.querySelector('.diagram-container');
  if(!svg||!container)return;
  var attempted=false;
  function fit(){
    if(attempted)return;attempted=true;
    if(window.innerWidth<=720||!window.Archify||!Archify.view||
       typeof Archify.view.centerAt!=='function'||typeof Archify.view.state!=='function')return;
    var camera=Archify.view.state();
    if(!camera||camera.mode!=='overview'||camera.scale!==1||camera.x!==0||camera.y!==0)return;
    var vb=svg.viewBox&&svg.viewBox.baseVal;
    if(!vb||vb.width<=0||vb.height<=0)return;
    var minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,count=0;
    var shapes=svg.querySelectorAll('path,line,rect,circle,ellipse,polygon,polyline,text');
    shapes.forEach(function(shape){
      if(shape.closest('defs')||shape.getAttribute('fill')==='url(#grid)')return;
      var style=window.getComputedStyle(shape);
      if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)return;
      try{var box=shape.getBBox();if(!Number.isFinite(box.x)||!Number.isFinite(box.y)||
        !Number.isFinite(box.width)||!Number.isFinite(box.height))return;
        minX=Math.min(minX,box.x);minY=Math.min(minY,box.y);
        maxX=Math.max(maxX,box.x+box.width);maxY=Math.max(maxY,box.y+box.height);count++;
      }catch(_){ }
    });
    if(!count||maxX<=minX||maxY<=minY)return;
    var sr=svg.getBoundingClientRect(),cr=container.getBoundingClientRect();
    var viewport={
      left:Math.max(0,cr.left-sr.left),top:Math.max(0,cr.top-sr.top),
      right:Math.min(svg.clientWidth,cr.right-sr.left,window.innerWidth-sr.left),
      bottom:Math.min(svg.clientHeight,cr.bottom-sr.top,window.innerHeight-sr.top)
    };
    var nav=container.querySelector('.diagram-nav');
    if(nav){var nr=nav.getBoundingClientRect();
      var overlapsSvg=nr.left<sr.right&&nr.right>sr.left&&nr.top<sr.bottom&&nr.bottom>sr.top;
      if(overlapsSvg&&nr.top>sr.top)viewport.bottom=Math.min(viewport.bottom,nr.top-sr.top);
    }
    var viewBox={x:vb.x,y:vb.y,width:vb.width,height:vb.height};
    var source={viewBox:viewBox,svg:{width:svg.clientWidth,height:svg.clientHeight},
      bounds:{x:minX,y:minY,width:maxX-minX,height:maxY-minY},viewport:viewport,padding:0,maxScale:3};
    var fit=(${computeWorkflowFit.toString()})(source);
    if(!fit)return;
    if(fit.limited)svg.setAttribute('data-space-fit-limited','true');
    svg.setAttribute('data-space-initial-fit','true');
    Archify.view.centerAt(fit.anchorX,fit.anchorY,{scale:fit.scale,minimumScale:1,instant:true});
  }
  window.addEventListener('load',function(){requestAnimationFrame(function(){requestAnimationFrame(fit);});},{once:true});
})();`;
}
