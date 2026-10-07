import { describe, expect, it } from 'vitest';
import { computeWorkflowFit, workflowInitialFitScript } from './workflow-fit.js';

describe('workflow first-load camera fit', () => {
  it('fits the measured full diagram bounds into an asymmetric viewport', () => {
    const fit = computeWorkflowFit({
      viewBox: { x: 0, y: 0, width: 1000, height: 500 },
      svg: { width: 1000, height: 500 },
      // Union includes all rendered node, edge, label and structural-frame bounds.
      bounds: { x: 100, y: 100, width: 800, height: 300 },
      // Caller has already clipped this to the actually visible safe rectangle.
      viewport: { left: 0, top: 0, right: 1000, bottom: 428 },
      padding: 24,
    });

    expect(fit).toBeDefined();
    expect(fit!.scale).toBeCloseTo(1.19);
    expect(fit!.anchorX).toBeCloseTo(500);
    expect(fit!.anchorY).toBeCloseTo(280.2521);
    expect(fit!.limited).toBe(false);
  });

  it('uses measured process graph dimensions without subtracting an external dock twice', () => {
    const shared = {
      viewBox: { x: 0, y: 0, width: 1136, height: 436 },
      bounds: { x: 32, y: 16, width: 1080, height: 344 },
      padding: 0,
    };
    const shortGraphFrame = computeWorkflowFit({
      ...shared,
      svg: { width: 1096, height: 74 },
      // Root measured the camera dock below the SVG rectangle, so the SVG's
      // full 74px are available; runtime only clips when controls overlap it.
      viewport: { left: 0, top: 0, right: 1096, bottom: 74 },
    });
    const fullHeightGraphFrame = computeWorkflowFit({
      ...shared,
      svg: { width: 1096, height: 493 },
      viewport: { left: 0, top: 0, right: 1096, bottom: 493 },
    });

    expect(shortGraphFrame?.scale).toBeCloseTo(1.2674, 3);
    expect(shortGraphFrame?.limited).toBe(false);
    // Logical 164x94 node at the measured SVG scale remains roughly 35x20 CSS
    // pixels: camera fit cannot compensate for the run+plan layout shrinking
    // the graph slot to 74px high.
    expect(164 * (74 / 436) * shortGraphFrame!.scale).toBeCloseTo(35.3, 1);
    expect(fullHeightGraphFrame?.scale).toBeCloseTo(1.0517, 3);
    expect(fullHeightGraphFrame?.limited).toBe(false);
  });

  it('reports when the existing viewer camera limits prevent a complete fit', () => {
    const belowMinimum = computeWorkflowFit({
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      svg: { width: 100, height: 100 },
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      viewport: { left: 0, top: 0, right: 80, bottom: 80 },
      padding: 0,
    });
    const aboveMaximum = computeWorkflowFit({
      viewBox: { x: 0, y: 0, width: 1000, height: 1000 },
      svg: { width: 1000, height: 1000 },
      bounds: { x: 490, y: 490, width: 20, height: 20 },
      viewport: { left: 0, top: 0, right: 1000, bottom: 1000 },
      padding: 0,
      maxScale: 3,
    });

    expect(belowMinimum).toMatchObject({ scale: 1, limited: true });
    expect(aboveMaximum).toMatchObject({ scale: 3, limited: true });
  });

  it('frames once only while the user has not moved the camera', () => {
    const script = workflowInitialFitScript();
    expect(script).toContain("window.addEventListener('load'");
    expect(script).toContain("camera.mode!=='overview'");
    expect(script).toContain("querySelectorAll('path,line,rect,circle,ellipse,polygon,polyline,text')");
    expect(script).toContain("getAttribute('fill')==='url(#grid)'");
    expect(script).toContain('Archify.view.centerAt(');
    expect(script).not.toContain('Archify.focus.set(');
    expect(script).not.toContain('location.reload');
    expect(() => new Function(script)).not.toThrow();
  });
});
