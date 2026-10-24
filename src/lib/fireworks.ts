interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  color: string
  size: number
  alpha: number
  decay: number
  gravity: number
}

let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
const particles: Particle[] = []
let animationId: number | null = null

function ensureCanvas() {
  if (canvas && document.body.contains(canvas)) return { canvas, ctx }
  canvas = document.createElement('canvas')
  canvas.id = 'celebration-fireworks-canvas'
  canvas.style.position = 'fixed'
  canvas.style.inset = '0'
  canvas.style.width = '100vw'
  canvas.style.height = '100vh'
  canvas.style.pointerEvents = 'none'
  canvas.style.zIndex = '99999'
  document.body.appendChild(canvas)

  const resize = () => {
    if (!canvas) return
    canvas.width = window.innerWidth * window.devicePixelRatio
    canvas.height = window.innerHeight * window.devicePixelRatio
    if (ctx) ctx.scale(window.devicePixelRatio, window.devicePixelRatio)
  }
  window.addEventListener('resize', resize)
  ctx = canvas.getContext('2d')
  resize()
  return { canvas, ctx }
}

export function triggerFireworksAt(x: number, y: number) {
  const res = ensureCanvas()
  if (!res.ctx) return

  const colors = ['#10b981', '#059669', '#34d399', '#f59e0b', '#fbbf24', '#06b6d4', '#6366f1']
  const count = 32

  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.6
    const speed = 2.5 + Math.random() * 4.5
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 1.2,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: 2.5 + Math.random() * 2.5,
      alpha: 1,
      decay: 0.022 + Math.random() * 0.018,
      gravity: 0.12,
    })
  }

  if (!animationId) {
    animate()
  }
}

function animate() {
  if (!canvas || !ctx) return
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]
    p.x += p.vx
    p.y += p.vy
    p.vy += p.gravity
    p.alpha -= p.decay

    if (p.alpha <= 0) {
      particles.splice(i, 1)
      continue
    }

    ctx.save()
    ctx.globalAlpha = Math.max(0, p.alpha)
    ctx.fillStyle = p.color
    ctx.beginPath()
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  if (particles.length > 0) {
    animationId = requestAnimationFrame(animate)
  } else {
    animationId = null
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
  }
}
