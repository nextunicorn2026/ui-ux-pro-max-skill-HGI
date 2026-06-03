"use client"

import { useEffect, useRef, useState } from "react"
import type { CSSProperties, HTMLAttributes } from "react"

import { cn } from "../lib/utils"

const ANIMATION_DURATION_SECONDS = 15
const GRID_HEIGHT_RATIO = 3
const GRID_LINE_ALIGNMENT_OFFSET_PX = 0.5
const GRID_LINE_ANTIALIAS_MULTIPLIER = 0.9
const GRID_LINE_WIDTH_PX = 0.92
const GRID_START_OFFSET_RATIO = -0.5
const GRID_WIDTH_RATIO = 6
const GRID_X_OFFSET_RATIO = -2
const MAX_ANGLE = 89
const MAX_DEVICE_PIXEL_RATIO = 2
const MIN_ANGLE = 1
const PERSPECTIVE_PX = 200
const FALLBACK_ANIMATION_NAME = "retro-grid-fallback-scroll"
const FALLBACK_STYLES = `
@keyframes ${FALLBACK_ANIMATION_NAME} {
  from { transform: translateY(-50%); }
  to { transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  [data-retro-grid-scroll="true"] {
    animation: none !important;
    transform: translateY(-50%) !important;
  }
}
`

const VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

const FRAGMENT_SHADER_SOURCE = `
#extension GL_OES_standard_derivatives : enable
precision highp float;

uniform vec2 u_container_size;
uniform vec2 u_viewport_size;
uniform vec4 u_line_color;
uniform float u_angle;
uniform float u_cell_size;
uniform float u_device_pixel_ratio;
uniform float u_time;

const float animationDurationSeconds = ${ANIMATION_DURATION_SECONDS}.0;
const float gridHeightRatio = ${GRID_HEIGHT_RATIO}.0;
const float gridStartOffsetRatio = -0.5;
const float gridWidthRatio = ${GRID_WIDTH_RATIO}.0;
const float gridXOffsetRatio = -2.0;
const float gridLineAlignmentOffsetPx = 0.5;
const float gridLineAntialiasMultiplier = 0.9;
const float horizontalLodLevelOneEndPx = 5.6;
const float horizontalLodLevelOneStartPx = 2.8;
const float horizontalLodLevelTwoEndPx = 3.0;
const float horizontalLodLevelTwoStartPx = 1.4;
const float horizontalCompressionEndPx = 2.8;
const float horizontalCompressionStartPx = 1.2;
const float lineWidthPx = 0.92;
const float perspectivePx = 200.0;
const float gridTravelRatio = 0.5;
const float verticalCompressionEndPx = 2.6;
const float verticalCompressionStartPx = 1.0;
const float verticalEdgeCompressionEnd = 0.95;
const float verticalEdgeCompressionStart = 0.45;
const float verticalLodLevelEnd = 0.64;
const float verticalLodLevelStart = 0.22;
const float verticalTopCompressionEndCells = 6.0;
const float verticalTopCompressionStartCells = 2.0;

float renderGridLine(float wrappedCoord, float antiAliasWidth, float softnessBoost) {
  return 1.0 - smoothstep(lineWidthPx, lineWidthPx + (antiAliasWidth * (1.5 + softnessBoost)), wrappedCoord);
}

void main() {
  float angle = radians(clamp(u_angle, 1.0, 89.0));
  float sinAngle = sin(angle);
  float cosAngle = cos(angle);
  vec2 screen = vec2(
    (gl_FragCoord.x / u_device_pixel_ratio) - (u_container_size.x * 0.5),
    (u_container_size.y * 0.5) - (gl_FragCoord.y / u_device_pixel_ratio)
  );
  vec3 rayOrigin = vec3(0.0, 0.0, perspectivePx);
  vec3 rayDirection = normalize(vec3(screen, -perspectivePx));
  vec3 planeXAxis = vec3(1.0, 0.0, 0.0);
  vec3 planeYAxis = vec3(0.0, cosAngle, sinAngle);
  vec3 planeNormal = normalize(cross(planeXAxis, planeYAxis));
  float denominator = dot(rayDirection, planeNormal);
  if (abs(denominator) < 0.0001) { discard; }
  float distanceToPlane = dot(-rayOrigin, planeNormal) / denominator;
  if (distanceToPlane <= 0.0) { discard; }
  vec3 hitPoint = rayOrigin + (rayDirection * distanceToPlane);
  float localX = hitPoint.x;
  float localY = dot(hitPoint, planeYAxis);
  float gridWidth = u_viewport_size.x * gridWidthRatio;
  float gridHeight = u_viewport_size.y * gridHeightRatio;
  float gridScrollSpeed = (gridHeight * gridTravelRatio) / animationDurationSeconds;
  float patternOffsetY = u_time * gridScrollSpeed;
  float gridLeft = (-0.5 * u_container_size.x) + (gridXOffsetRatio * u_container_size.x);
  float gridTop = (-0.5 * u_container_size.y) + (gridStartOffsetRatio * gridHeight);
  vec2 planePosition = vec2(localX - gridLeft, localY - gridTop);
  if (planePosition.x < 0.0 || planePosition.y < 0.0 || planePosition.x > gridWidth || planePosition.y > gridHeight) { discard; }
  vec2 patternPosition = vec2(planePosition.x, planePosition.y - patternOffsetY);
  vec2 wrapped = mod(patternPosition + vec2(gridLineAlignmentOffsetPx), u_cell_size);
  vec2 patternDerivative = max(fwidth(patternPosition), vec2(0.0001));
  vec2 antiAliasWidth = patternDerivative * gridLineAntialiasMultiplier;
  float horizontalCellSpanPx = u_cell_size / patternDerivative.y;
  float horizontalCompression = 1.0 - smoothstep(horizontalCompressionStartPx, horizontalCompressionEndPx, horizontalCellSpanPx);
  float verticalCellSpanPx = u_cell_size / patternDerivative.x;
  float sideDistance = abs((planePosition.x / gridWidth) * 2.0 - 1.0);
  float verticalEdgeCompression = smoothstep(verticalEdgeCompressionStart, verticalEdgeCompressionEnd, sideDistance);
  float verticalTopCompression = 1.0 - smoothstep(u_cell_size * verticalTopCompressionStartCells, u_cell_size * verticalTopCompressionEndCells, planePosition.y);
  float verticalCompression = (1.0 - smoothstep(verticalCompressionStartPx, verticalCompressionEndPx, verticalCellSpanPx)) * verticalEdgeCompression * verticalTopCompression;
  float horizontalSoftnessBoost = 1.0 + (horizontalCompression * 3.0);
  float verticalSoftnessBoost = 1.0 + (verticalCompression * 3.5);
  float verticalLod = smoothstep(verticalLodLevelStart, verticalLodLevelEnd, verticalCompression);
  float verticalLineFine = renderGridLine(wrapped.x, antiAliasWidth.x, verticalSoftnessBoost);
  float verticalWrappedLod = mod(patternPosition.x + gridLineAlignmentOffsetPx, u_cell_size * 2.0);
  float verticalLineCoarse = renderGridLine(verticalWrappedLod, antiAliasWidth.x, verticalSoftnessBoost + verticalLod);
  float verticalLine = max(verticalLineFine * (1.0 - verticalLod), verticalLineCoarse * verticalLod);
  float horizontalLodLevelOne = 1.0 - smoothstep(horizontalLodLevelOneStartPx, horizontalLodLevelOneEndPx, horizontalCellSpanPx);
  float horizontalLodLevelTwo = 1.0 - smoothstep(horizontalLodLevelTwoStartPx, horizontalLodLevelTwoEndPx, horizontalCellSpanPx);
  float horizontalLineFine = renderGridLine(wrapped.y, antiAliasWidth.y, horizontalSoftnessBoost);
  float horizontalWrappedLodOne = mod(patternPosition.y + gridLineAlignmentOffsetPx, u_cell_size * 2.0);
  float horizontalWrappedLodTwo = mod(patternPosition.y + gridLineAlignmentOffsetPx, u_cell_size * 4.0);
  float horizontalLineCoarse = renderGridLine(horizontalWrappedLodOne, antiAliasWidth.y, horizontalSoftnessBoost + horizontalLodLevelOne);
  float horizontalLineExtraCoarse = renderGridLine(horizontalWrappedLodTwo, antiAliasWidth.y, horizontalSoftnessBoost + horizontalLodLevelOne + horizontalLodLevelTwo);
  float horizontalLineReduced = max(horizontalLineFine * (1.0 - horizontalLodLevelOne), horizontalLineCoarse * horizontalLodLevelOne);
  float horizontalLine = max(horizontalLineReduced * (1.0 - horizontalLodLevelTwo), horizontalLineExtraCoarse * horizontalLodLevelTwo);
  float line = max(verticalLine, horizontalLine);
  if (line <= 0.001) { discard; }
  float alpha = u_line_color.a * line;
  gl_FragColor = vec4(u_line_color.rgb * alpha, alpha);
}
`

interface RetroGridProps extends HTMLAttributes<HTMLDivElement> {
  className?: string
  /** Rotation angle in degrees @default 65 */
  angle?: number
  /** Grid cell size in pixels @default 60 */
  cellSize?: number
  /** Opacity 0–1 @default 0.5 */
  opacity?: number
  /** Line color in light mode @default "gray" */
  lightLineColor?: string
  /** Line color in dark mode @default "gray" */
  darkLineColor?: string
}

export function RetroGrid({
  className,
  angle = 65,
  cellSize = 60,
  opacity = 0.5,
  lightLineColor = "gray",
  darkLineColor = "gray",
  style,
  ...props
}: RetroGridProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isWebGlReady, setIsWebGlReady] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)")
    let animationFrameId: number | null = null

    const gl = canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: true })
    if (!gl || !gl.getExtension("OES_standard_derivatives")) {
      setIsWebGlReady(false)
      return
    }

    const compileShader = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null
    }

    const vs = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE)
    const fs = compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE)
    if (!vs || !fs) return

    const program = gl.createProgram()!
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return

    const buf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)

    const aPos = gl.getAttribLocation(program, "a_position")
    const uAngle = gl.getUniformLocation(program, "u_angle")!
    const uCell = gl.getUniformLocation(program, "u_cell_size")!
    const uContainer = gl.getUniformLocation(program, "u_container_size")!
    const uDpr = gl.getUniformLocation(program, "u_device_pixel_ratio")!
    const uColor = gl.getUniformLocation(program, "u_line_color")!
    const uTime = gl.getUniformLocation(program, "u_time")!
    const uViewport = gl.getUniformLocation(program, "u_viewport_size")!

    const resolveColor = (color: string): Float32Array => {
      const tmp = document.createElement("span")
      tmp.style.cssText = `color:${color};opacity:0;position:absolute;pointer-events:none`
      container.appendChild(tmp)
      const resolved = getComputedStyle(tmp).color
      tmp.remove()
      const c = document.createElement("canvas")
      c.width = c.height = 1
      const ctx = c.getContext("2d")!
      ctx.fillStyle = resolved
      ctx.fillRect(0, 0, 1, 1)
      const p = ctx.getImageData(0, 0, 1, 1).data
      return new Float32Array([p[0] / 255, p[1] / 255, p[2] / 255, p[3] / 255])
    }

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(container.clientWidth * dpr)
      canvas.height = Math.floor(container.clientHeight * dpr)
      canvas.style.width = `${container.clientWidth}px`
      canvas.style.height = `${container.clientHeight}px`
      gl.viewport(0, 0, canvas.width, canvas.height)
    }

    const draw = (ts: number) => {
      resize()
      const dark = document.documentElement.classList.contains("dark") || colorScheme.matches
      const color = resolveColor(dark ? darkLineColor : lightLineColor)
      gl.useProgram(program)
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.enableVertexAttribArray(aPos)
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform1f(uAngle, Math.min(Math.max(angle, 1), 89))
      gl.uniform1f(uCell, Math.max(cellSize, 1))
      gl.uniform2f(uContainer, container.clientWidth, container.clientHeight)
      gl.uniform1f(uDpr, Math.min(window.devicePixelRatio || 1, 2))
      gl.uniform4fv(uColor, color)
      gl.uniform1f(uTime, reducedMotion.matches ? 0 : ts / 1000)
      gl.uniform2f(uViewport, window.innerWidth, window.innerHeight)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      setIsWebGlReady(true)
      if (!reducedMotion.matches) animationFrameId = requestAnimationFrame(draw)
    }

    animationFrameId = requestAnimationFrame(draw)
    const ro = new ResizeObserver(() => animationFrameId === null && requestAnimationFrame(draw))
    ro.observe(container)

    return () => {
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId)
      ro.disconnect()
      gl.deleteProgram(program)
      gl.deleteBuffer(buf)
    }
  }, [angle, cellSize, lightLineColor, darkLineColor])

  const normalizedAngle = Math.min(Math.max(angle, MIN_ANGLE), MAX_ANGLE)
  const fallbackBg = {
    backgroundImage: `linear-gradient(to right, ${lightLineColor} 1px, transparent 0), linear-gradient(to bottom, ${lightLineColor} 1px, transparent 0)`,
    backgroundSize: `${cellSize}px ${cellSize}px`,
    animation: `${FALLBACK_ANIMATION_NAME} ${ANIMATION_DURATION_SECONDS}s linear infinite`,
    transform: "translateY(-50%)",
  } as CSSProperties

  return (
    <div
      ref={containerRef}
      className={cn("pointer-events-none absolute size-full overflow-hidden", className)}
      style={{ opacity, ...style }}
      {...props}
    >
      <style>{FALLBACK_STYLES}</style>
      {!isWebGlReady && (
        <div className="absolute inset-0" style={{ perspective: `${PERSPECTIVE_PX}px` }}>
          <div className="absolute inset-0" style={{ transform: `rotateX(${normalizedAngle}deg)` }}>
            <div
              data-retro-grid-scroll="true"
              className="absolute inset-[0%_0px] ml-[-200%] h-[300vh] w-[600vw]"
              style={fallbackBg}
            />
          </div>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className={cn("absolute inset-0 size-full", isWebGlReady ? "opacity-100" : "opacity-0")}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-white to-transparent to-90% dark:from-black" />
    </div>
  )
}
